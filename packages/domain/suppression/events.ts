import type { BlockedActionKind, SuppressionChannel, SuppressionRefusalCode, SuppressionScope, SuppressionSource } from '@fss/contracts';
import { MANUAL_SUPPRESSION_CORRECTION_SECONDS } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { isAdminScope } from '../db/workspaceScope.ts';
import { enqueueJob } from '../jobs/jobStore.ts';
import { jobIdempotencyKey } from '../jobs/jobKinds.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { decideFirmMutation } from '../crm/authorization.ts';
import { loadFirmForUpdate } from '../crm/firms.ts';
import { databaseNow } from '../policy/clock.ts';
import { openHold, releaseHoldsOfEvent } from '../policy/holds.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import { unionDuration } from '../src/rules/holds.ts';
import {
  CANONICALIZER_VERSION,
  canonicalizeHandle,
  isSupportedCanonicalizerVersion,
  mayCorrectSuppression,
} from '../src/rules/suppressionCanonicalization.ts';
import { claimFinalization } from './finalize.ts';
import { deterministicEventId, type SuppressionJournal, type SuppressionJournalRecord } from './journal.ts';

/**
 * The insert-only suppression protocol (specification 10.2, Appendix A, Appendix G
 * 21, 29 and 30).
 *
 * The whole of it in one sentence: a suppression is a row nobody may change, written
 * to the journal before it is written to the database, effective the moment it
 * commits, and undone only by another row that says so.
 *
 * Four rules are enforced here rather than anywhere else.
 *
 * **Immediately effective, always.** There is no "pending" state and no flag a
 * reader has to remember. `effective_suppressions` contains the event as soon as the
 * transaction commits, including during the ten-minute correction window — which is
 * what Appendix G 29's "never contact during the window" means.
 *
 * **The window is the salesperson's own mistake, and nothing else.**
 * `mayCorrectSuppression` in `@fss/domain` gives three refusals and no fourth:
 * someone else's event, a prospect-originated request, or a window that has closed.
 * Appendix G 30 is the second of those.
 *
 * **The claim comes before the write.** The correction claims the decision in
 * `suppression_finalizations` before it writes anything, because the claim is the
 * only serialization point between it and the finalizer. A correction that wrote its
 * supersession first and then lost would have lifted a suppression the finalizer had
 * already made terminal.
 *
 * **The journal is durable before the row is.** `journal.append` is awaited inside
 * the command transaction and before the commit. A throw rolls the transaction
 * back and nothing is suppressed; a success followed by a rollback leaves the
 * journal holding an event the database does not, which 10.2 calls out as the safe
 * direction because replay only ever re-adds a suppression. That is a stop's rule. A
 * supersession is the opposite direction, so its rule is the opposite (brief RF): it is
 * journalled only AFTER its command transaction commits, by whoever ends that transaction
 * (the API's suppression route). These functions return the record for that and never
 * append it themselves. A lift whose journal write fails after the commit stays lifted and
 * is logged; a later restore brings the stop back, which errs toward the stop. A lift in the
 * journal that never committed would be the one thing a replay must not apply.
 */

export type SuppressionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: SuppressionRefusalCode };

const accept = <T>(value: T): SuppressionResult<T> => ({ ok: true, value });
const refuse = <T>(reason: SuppressionRefusalCode): SuppressionResult<T> => ({ ok: false, reason });

export interface SuppressionEventRow {
  readonly eventId: string;
  readonly scope: SuppressionScope;
  readonly canonicalKey: string;
  readonly canonicalizerVersion: string;
  readonly source: SuppressionSource;
  readonly actorUserId: string | null;
  readonly commandId: string | null;
  readonly recordedAt: string;
  readonly supersedesEventId: string | null;
  readonly supersessionReason: string | null;
  /** Which channel the event stops (migration 0037). */
  readonly channel: SuppressionChannel;
}

interface EventDbRow {
  readonly event_id: string;
  readonly scope: SuppressionScope;
  readonly canonical_key: string;
  readonly canonicalizer_version: string;
  readonly source: SuppressionSource;
  readonly actor_user_id: string | null;
  readonly command_id: string | null;
  readonly recorded_at: Date;
  readonly supersedes_event_id: string | null;
  readonly supersession_reason: string | null;
  readonly channel: SuppressionChannel;
  readonly [column: string]: unknown;
}

const EVENT_COLUMNS = `event_id, scope, canonical_key, canonicalizer_version, source, actor_user_id,
  command_id, recorded_at, supersedes_event_id, supersession_reason, channel`;

function toEvent(row: EventDbRow): SuppressionEventRow {
  return {
    eventId: row.event_id,
    scope: row.scope,
    canonicalKey: row.canonical_key,
    canonicalizerVersion: row.canonicalizer_version,
    source: row.source,
    actorUserId: row.actor_user_id,
    commandId: row.command_id,
    recordedAt: row.recorded_at.toISOString(),
    supersedesEventId: row.supersedes_event_id,
    supersessionReason: row.supersession_reason,
    channel: row.channel,
  };
}

export async function readSuppressionEvent(
  context: RepositoryContext,
  eventId: string,
): Promise<SuppressionEventRow | null> {
  const { rows } = await context.db.query<EventDbRow>(
    `SELECT ${EVENT_COLUMNS} FROM suppression_events WHERE workspace_id = $1 AND event_id = $2`,
    [context.scope.workspaceId, eventId],
  );
  const row = rows[0];
  return row === undefined ? null : toEvent(row);
}

/**
 * The action kinds a manual suppression's review hold blocks, by the stop's channel
 * (DESIGN-S3X §2.3a). The hold must not cross channels during the correction window when
 * the stop itself does not:
 *
 *  * `email` → `email_send` **only**. `enrollment_advance` is checked by every sequence
 *    channel (`holdSource`, `sequences/eligibility.ts`), so an e-mail-only hold carrying it
 *    would hold a call-task step the stop leaves open.
 *  * `phone` → `call_task` and `dial_authorization`.
 *  * `all` → all four, `enrollment_advance` included: everything outbound, as before 0037.
 *
 * `recordSuppression` and the journal replay both ask this with the event's channel, so a
 * replay opens exactly the hold the original write opened.
 */
export function reviewHoldBlocks(channel: SuppressionChannel): readonly BlockedActionKind[] {
  switch (channel) {
    case 'email':
      return ['email_send'];
    case 'phone':
      return ['call_task', 'dial_authorization'];
    case 'all':
      return ['email_send', 'call_task', 'dial_authorization', 'enrollment_advance'];
  }
}

/**
 * Whether a channel can sit on a key (`suppression_events_channel_fits_key`, 0037): a
 * firm stop takes any channel; a handle stop on a number cannot be `email`, and one on an
 * address cannot be `phone`, because no reader would ever read it.
 */
export function channelFitsKey(scope: SuppressionScope, canonicalKey: string, channel: SuppressionChannel): boolean {
  if (scope === 'firm' || channel === 'all') return true;
  return (channel === 'email') === canonicalKey.includes('@');
}

/**
 * The sources that are terminal the instant they commit (10.2).
 *
 * The first three are prospect-originated or imported. `deletion_tombstone` is
 * neither, and it is here for the same reason they are: 10.3's deletion workflow has
 * already removed the correspondence by the time the tombstone is written, so there
 * is nothing for a ten-minute review hold to protect and nobody to change their mind.
 * A deletion tombstone with a correction window would be a window in which contact
 * could resume with a contact whose handles no longer exist.
 */
const TERMINAL_SOURCES: ReadonlySet<string> = new Set([
  'prospect_opt_out',
  'prospect_do_not_call',
  'import',
  'deletion_tombstone',
]);

export interface RecordSuppressionInput {
  readonly scope: SuppressionScope;
  /** Required for a firm suppression; optional context for a handle one. */
  readonly firmId?: string | undefined;
  /** Required for a handle suppression: the raw number or address. */
  readonly value?: string | undefined;
  readonly source: Exclude<SuppressionSource, 'mistaken_entry_correction' | 'admin_supersession'>;
  /**
   * Which channel the stop stops (migration 0037, David's P1 and P2). Required, so every
   * writer states it: an e-mail opt-out is `email`, a "Do not call" is `phone` unless the
   * person said "don't contact me again", a deletion tombstone is `all`.
   */
  readonly channel: SuppressionChannel;
  readonly commandId?: string | undefined;
  readonly journal: SuppressionJournal;
  /**
   * A deletion tombstone's key for a meeting attendee the canonicalizer refuses (Cal.com
   * slice M1, `meetings/attendee.ts`): the address in the canonicalizer's own
   * normalization, without its validation. Accepted for a `deletion_tombstone` handle
   * suppression only, so no send-path suppression is ever written under a key the
   * canonicalizer did not produce.
   */
  readonly fallbackKey?: string | undefined;
}

export interface RecordedSuppression {
  readonly eventId: string;
  readonly scope: SuppressionScope;
  readonly channel: SuppressionChannel;
  readonly canonicalKey: string;
  readonly canonicalizerVersion: string;
  readonly recordedAt: string;
  /** True when the suppression is terminal at once: a prospect's request or an import. */
  readonly terminal: boolean;
  /** The `manual_suppression_review` holds this event opened. Empty when terminal. */
  readonly reviewHoldIds: readonly string[];
  /** Ten minutes after database time, or null when there is no window. */
  readonly correctionDeadline: string | null;
  /** True when this call found the event already there: a replay, not a second suppression. */
  readonly replayed: boolean;
}

/**
 * A stop this command already recorded on this key, under any channel that covers `channel`
 * (brief RF, X6). Never a supersession, and never without a command id: an event with no
 * command is identified by nothing but its id.
 */
async function sameCommandEvent(
  context: RepositoryContext,
  input: {
    readonly scope: SuppressionScope;
    readonly canonicalKey: string;
    readonly source: string;
    readonly commandId: string | undefined;
    readonly channel: SuppressionChannel;
  },
): Promise<SuppressionEventRow | null> {
  if (input.commandId === undefined) return null;
  const { rows } = await context.db.query<EventDbRow>(
    `SELECT ${EVENT_COLUMNS} FROM suppression_events
      WHERE workspace_id = $1 AND scope = $2 AND canonical_key = $3 AND source = $4 AND command_id = $5
        AND supersedes_event_id IS NULL AND channel IN ($6, 'all')
      ORDER BY recorded_at, event_id
      LIMIT 1`,
    [context.scope.workspaceId, input.scope, input.canonicalKey, input.source, input.commandId, input.channel],
  );
  const row = rows[0];
  return row === undefined ? null : toEvent(row);
}

export async function recordSuppression(
  context: RepositoryContext,
  input: RecordSuppressionInput,
): Promise<SuppressionResult<RecordedSuppression>> {
  const actor = context.scope.actor;
  const actorUserId = actor.kind === 'user' ? actor.userId : null;

  // A suppression is the strongest stop fact there is, so it takes the send gate
  // before anything else (`policy/sendGate.ts`): a dispatch claim that is
  // re-checking right now finishes first, and one that starts after this commits sees
  // the suppression. Before the firm lock, because the gate comes before rows.
  await lockSendGateForStopFact(context);

  // A manual suppression is a person's, by definition: it is the only source with a
  // correction window, and the window belongs to the person who opened it.
  if (input.source === 'salesperson_manual' && actorUserId === null) return refuse('invalid_input');

  let canonicalKey: string;
  if (input.scope === 'firm') {
    if (input.firmId === undefined) return refuse('invalid_input');
    const firm = await loadFirmForUpdate(context, input.firmId);
    if (firm === null) return refuse('firm_unknown');
    const decision = decideFirmMutation(context, firm);
    if (!decision.permitted) return refuse(decision.reason === 'not_assigned' ? 'not_assigned' : 'firm_unknown');
    canonicalKey = firm.id.toLowerCase();
  } else if (input.fallbackKey !== undefined) {
    if (input.source !== 'deletion_tombstone') return refuse('invalid_input');
    const key = input.fallbackKey;
    if (key.trim().length === 0 || key !== key.toLowerCase() || key.length > 320) return refuse('handle_uncanonical');
    canonicalKey = key;
  } else {
    if (input.value === undefined) return refuse('invalid_input');
    const canonical = canonicalizeHandle(input.value);
    if (!canonical.ok) return refuse('handle_uncanonical');
    canonicalKey = canonical.handle.value;
    // A handle suppression is workspace-wide (10.2), so it needs no firm; when one is
    // named it is checked anyway, because a salesperson naming a firm they do not own
    // is asking for a firm-scoped effect through a workspace-scoped door.
    if (input.firmId !== undefined) {
      const firm = await loadFirmForUpdate(context, input.firmId);
      if (firm === null) return refuse('firm_unknown');
      const decision = decideFirmMutation(context, firm);
      if (!decision.permitted) return refuse(decision.reason === 'not_assigned' ? 'not_assigned' : 'firm_unknown');
    }
  }

  // Refused here rather than by the CHECK, before anything is journalled.
  if (!channelFitsKey(input.scope, canonicalKey, input.channel)) return refuse('invalid_input');

  const now = await databaseNow(context);
  const eventId = deterministicEventId({
    workspaceId: context.scope.workspaceId,
    scope: input.scope,
    canonicalKey,
    source: input.source,
    commandId: input.commandId,
    channel: input.channel,
  });

  // The same command recorded the same fact: by the deterministic id or, across the 0037
  // boundary (brief RF, X6), by the command itself. A command's id is not hashed with its
  // channel when that channel is `all`, so an opt-out journalled before 0037 as `all` and
  // reprocessed after a restore as `email` would otherwise get a second event. The earlier
  // event answers when it covers the channel asked for (`all` covers every channel); one
  // that covers less is not this fact, and the new stop is recorded beside it.
  const existing = (await readSuppressionEvent(context, eventId)) ?? (await sameCommandEvent(context, {
    scope: input.scope,
    canonicalKey,
    source: input.source,
    commandId: input.commandId,
    channel: input.channel,
  }));
  if (existing !== null) {
    // The same command recorded the same fact. Idempotent by the deterministic id,
    // which is what makes Appendix E's journal replay safe.
    return accept({
      eventId: existing.eventId,
      scope: existing.scope,
      channel: existing.channel,
      canonicalKey: existing.canonicalKey,
      canonicalizerVersion: existing.canonicalizerVersion,
      recordedAt: existing.recordedAt,
      terminal: TERMINAL_SOURCES.has(existing.source),
      reviewHoldIds: [],
      correctionDeadline: null,
      replayed: true,
    });
  }

  // Before the row, and inside the transaction that is about to write it.
  await input.journal.append({
    eventId,
    workspaceId: context.scope.workspaceId,
    scope: input.scope,
    canonicalKey,
    canonicalizerVersion: CANONICALIZER_VERSION,
    source: input.source,
    actorUserId,
    commandId: input.commandId ?? null,
    supersedesEventId: null,
    supersessionReason: null,
    recordedAt: now,
    channel: input.channel,
    // The firm the review hold below goes on, so a replay opens the same one (brief RF, X5);
    // null, written as such, when there is none, so a replay can tell it from an object
    // written before RF, which says nothing.
    firmId: input.firmId ?? null,
  });

  await context.db.query(
    `INSERT INTO suppression_events
       (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source,
        actor_user_id, command_id, recorded_at, channel)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10)`,
    [
      context.scope.workspaceId,
      eventId,
      input.scope,
      canonicalKey,
      CANONICALIZER_VERSION,
      input.source,
      actorUserId,
      input.commandId ?? null,
      now,
      input.channel,
    ],
  );

  const terminal = TERMINAL_SOURCES.has(input.source);
  const reviewHoldIds: string[] = [];
  let correctionDeadline: string | null = null;

  if (terminal) {
    // "Prospect-originated opt-outs, do-not-call requests, and imported suppressions
    // are effective and terminal immediately." The marker is the durable signal the
    // sequences lane reads; there is no window and therefore no race to claim.
    await claimFinalization(context, { eventId, outcome: 'finalized' });
  } else {
    correctionDeadline = new Date(
      Date.parse(now) + MANUAL_SUPPRESSION_CORRECTION_SECONDS * 1000,
    ).toISOString();
    if (input.firmId !== undefined) {
      reviewHoldIds.push(
        await openHold(context, {
          scopeKind: 'firm',
          scopeKey: input.firmId,
          reasonCode: 'manual_suppression_review',
          blockedActionKinds: reviewHoldBlocks(input.channel),
          sourceEventKind: 'suppression.manual',
          sourceEventId: eventId,
          ...(actorUserId === null ? {} : { ownerUserId: actorUserId }),
        }),
      );
    }
    // Appendix C: `suppression-finalize:{event}`, protected by business uniqueness.
    // The job row and the suppression commit together (13.2), so a finalizer exists
    // for every event that has a window, or neither does.
    await enqueueJob(context.db, {
      workspaceId: context.scope.workspaceId,
      kind: 'suppression.finalize',
      idempotencyKey: jobIdempotencyKey.suppressionFinalize(eventId),
      payload: { eventId },
      runAt: correctionDeadline,
      notBefore: correctionDeadline,
    });
  }

  await recordCrmAuditEvent(context, {
    action: 'suppression.recorded',
    subjectKind: 'suppression_event',
    subjectId: eventId,
    detail: { scope: input.scope, channel: input.channel, source: input.source, terminal, holds: reviewHoldIds.length },
  });

  return accept({
    eventId,
    scope: input.scope,
    channel: input.channel,
    canonicalKey,
    canonicalizerVersion: CANONICALIZER_VERSION,
    recordedAt: now,
    terminal,
    reviewHoldIds,
    correctionDeadline,
    replayed: false,
  });
}

const SUPERSESSION_SAVEPOINT = 'suppression_supersession';

/** Whether some event already supersedes `eventId` (committed, or this transaction's own). */
async function alreadySuperseded(context: RepositoryContext, eventId: string): Promise<boolean> {
  const { rows } = await context.db.query(
    'SELECT 1 FROM suppression_events WHERE workspace_id = $1 AND supersedes_event_id = $2 LIMIT 1',
    [context.scope.workspaceId, eventId],
  );
  return rows.length > 0;
}

/**
 * Run `work` under a savepoint, and answer `false` when it lost the one-supersession race
 * (brief RF, R1).
 *
 * `suppression_events_one_direct_supersession` (0001) is what serializes two supersessions
 * of one event: the second INSERT waits on the first's index entry and, once the first
 * commits, fails with 23505. Caught without a savepoint, that error leaves the command's
 * transaction aborted, so the refusal could not even write its receipt. Rolled back to the
 * savepoint, the transaction is whole again: the caller refuses `already_superseded`, the
 * receipt commits, and nothing of the losing supersession (its finalization claim
 * included) survives.
 */
async function underSupersessionSavepoint(context: RepositoryContext, work: () => Promise<boolean>): Promise<boolean> {
  await context.db.query(`SAVEPOINT ${SUPERSESSION_SAVEPOINT}`);
  try {
    const done = await work();
    await context.db.query(`RELEASE SAVEPOINT ${SUPERSESSION_SAVEPOINT}`);
    return done;
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505') {
      await context.db.query(`ROLLBACK TO SAVEPOINT ${SUPERSESSION_SAVEPOINT}`);
      await context.db.query(`RELEASE SAVEPOINT ${SUPERSESSION_SAVEPOINT}`);
      return false;
    }
    throw error;
  }
}

/** The lock's name: one per workspace, like the send gate. */
export function suppressionHistoryLockName(workspaceId: string): string {
  return `fss.suppression-history:${workspaceId}`;
}

/**
 * Serialise every write that reads a stop's history and writes from it (brief RF, review P2):
 * a supersession (admin lift or correction), the merge's copy of a firm's stops, and the
 * replay. Without it a lift that commits while a merge is between reading the source's
 * stops and copying them is lost on the survivor. A supersession takes it first thing;
 * the merge and the replay take it right after the send gate, before any row. Nothing
 * takes the send gate after it, so the two locks never form a cycle. Transaction-scoped.
 */
export async function lockSuppressionHistory(context: RepositoryContext): Promise<void> {
  await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    suppressionHistoryLockName(context.scope.workspaceId),
  ]);
}

/** The prefix of a merge copy's id (RF, review RFV). No pre-repair id starts with it. */
const MERGE_COPY_PREFIX = 'mergecopy:';
/** The prefix of a merge copy written before RF's last repair: `merge:<event>`, any survivor. */
const LEGACY_MERGE_COPY_PREFIX = 'merge:';

/**
 * Carry a supersession onto every merge copy of the event it lifted (brief RF, review P2).
 *
 * A firm merge copies each source stop to the survivor as `mergeCopyId(event, survivor)`,
 * `mergecopy:<event>@<survivor>`; before RF's last repair it wrote `merge:<event>`. A lift of
 * the source's event after the merge is a lift of the stop the survivor inherited, so each
 * copy is lifted with it, in the copy's own form: `mergeCopyId(supersession, survivor)` for a
 * copy, `merge:<supersession>` for a pre-repair copy — exactly the row the merge would have
 * copied had the lift come first. Copies of copies follow. Each copied lift is a release, so
 * its journal record is returned for the caller to append after the commit (RF reset, J2),
 * with the supersession's own.
 *
 * The two forms are told apart by prefix, and each is matched by equality only (review RFV):
 * a pre-repair copy of `e` is exactly `merge:e`, a copy of `e` on the firm it sits on is
 * exactly `mergecopy:e@<that firm's key>`. No id of one form starts with the other's prefix,
 * so a copy of one lineage is never read as a child of another.
 */
async function liftMergeCopies(
  context: RepositoryContext,
  originalEventId: string,
  supersessionEventId: string,
): Promise<readonly SuppressionJournalRecord[]> {
  const { rows } = await context.db.query<{ event_id: string; canonical_key: string }>(
    `SELECT copy.event_id, copy.canonical_key FROM suppression_events copy
      WHERE copy.workspace_id = $1 AND copy.scope = 'firm'
        AND (copy.event_id = '${LEGACY_MERGE_COPY_PREFIX}' || $2
             OR copy.event_id = '${MERGE_COPY_PREFIX}' || $2 || '@' || copy.canonical_key)
        AND NOT EXISTS (
          SELECT 1 FROM suppression_events lift
           WHERE lift.workspace_id = copy.workspace_id AND lift.supersedes_event_id = copy.event_id
        )`,
    [context.scope.workspaceId, originalEventId],
  );
  const records: SuppressionJournalRecord[] = [];
  for (const copy of rows) {
    const copiedLift =
      copy.event_id === `${LEGACY_MERGE_COPY_PREFIX}${originalEventId}`
        ? `${LEGACY_MERGE_COPY_PREFIX}${supersessionEventId}`
        : mergeCopyId(supersessionEventId, copy.canonical_key);
    const inserted = await context.db.query<EventDbRow>(
      `INSERT INTO suppression_events
         (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source, actor_user_id, command_id,
          recorded_at, supersedes_event_id, supersession_reason, channel)
       SELECT $1, $2, copy.scope, copy.canonical_key, copy.canonicalizer_version, lift.source, lift.actor_user_id,
              lift.command_id, lift.recorded_at, copy.event_id, lift.supersession_reason, copy.channel
         FROM suppression_events copy
         JOIN suppression_events lift ON lift.workspace_id = copy.workspace_id AND lift.event_id = $3
        WHERE copy.workspace_id = $1 AND copy.event_id = $4
       RETURNING ${EVENT_COLUMNS}`,
      [context.scope.workspaceId, copiedLift, supersessionEventId, copy.event_id],
    );
    const row = inserted.rows[0];
    if (row !== undefined) records.push(journalRecordOf(context, toEvent(row)));
    records.push(...(await liftMergeCopies(context, copy.event_id, copiedLift)));
  }
  return records;
}

/**
 * The id of a merge's copy of `eventId` on the survivor `survivorFirmId` (RF, reviews RFR, RFV).
 *
 * The survivor is part of it: a copy is a different stop on each firm it is copied to, and a
 * merge that rolled back after journalling its copy for one survivor must not own the id (and
 * so the conditional journal object) a later merge to another survivor needs. Deterministic,
 * so a retry of the same merge reaches the same id and the same object. Its prefix is not the
 * pre-repair `merge:`, so no copy can share an id with a pre-repair copy or its descendants;
 * the survivor is the firm key after the last `@` (a firm key is a UUID, with no `@`).
 */
export function mergeCopyId(eventId: string, survivorFirmId: string): string {
  return `${MERGE_COPY_PREFIX}${eventId}@${survivorFirmId.toLowerCase()}`;
}

/** Whether an event id is a merge's copy, in either form (`mergecopy:` or pre-repair `merge:`). */
export function isMergeCopyId(eventId: string): boolean {
  return eventId.startsWith(MERGE_COPY_PREFIX) || eventId.startsWith(LEGACY_MERGE_COPY_PREFIX);
}

/** An event as the journal holds it. */
export function journalRecordOf(context: RepositoryContext, event: SuppressionEventRow): SuppressionJournalRecord {
  return {
    eventId: event.eventId,
    workspaceId: context.scope.workspaceId,
    scope: event.scope,
    canonicalKey: event.canonicalKey,
    canonicalizerVersion: event.canonicalizerVersion,
    source: event.source,
    actorUserId: event.actorUserId,
    commandId: event.commandId,
    supersedesEventId: event.supersedesEventId,
    supersessionReason: event.supersessionReason,
    recordedAt: event.recordedAt,
    channel: event.channel,
  };
}

export interface CorrectionOutcome {
  /**
   * The releases this correction wrote, itself first and then any merge copy it lifted, for
   * the caller to append once the command transaction has committed, marked (RF reset, J2):
   * a release is never journalled before then.
   */
  readonly journalRecords: readonly SuppressionJournalRecord[];
  readonly correctionEventId: string;
  readonly originalEventId: string;
  readonly releasedHoldIds: readonly string[];
  /** The union of the intervals the released holds blocked, for the schedule shift (4.3). */
  readonly blockedMilliseconds: number;
}

/**
 * The ten-minute `mistaken_entry` correction (10.2).
 *
 * "The same salesperson may insert a `mistaken_entry` correction referencing the
 * original event within ten minutes of database time. The correction never deletes
 * history. It clears only this hold; remaining holds still apply; due times shift by
 * the actual blocked interval."
 *
 * Every clause is a line below, in that order, and the claim is first.
 */
export async function recordCorrection(
  context: RepositoryContext,
  input: { readonly eventId: string; readonly commandId?: string | undefined },
): Promise<SuppressionResult<CorrectionOutcome>> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refuse('not_your_event');
  await lockSuppressionHistory(context);

  const original = await readSuppressionEvent(context, input.eventId);
  if (original === null) return refuse('suppression_unknown');
  // Appendix G 21: an event written by a canonicalizer this build does not
  // understand is not reinterpreted. It stays suppressed and this path refuses.
  if (!isSupportedCanonicalizerVersion(original.canonicalizerVersion)) return refuse('canonicalizer_unsupported');

  const now = await databaseNow(context);
  const permitted = mayCorrectSuppression({
    event: { source: original.source, actorUserId: original.actorUserId, recordedAt: original.recordedAt },
    actorUserId: actor.userId,
    now,
  });
  if (!permitted.allowed) return refuse(permitted.refusal);

  const correctionEventId = deterministicEventId({
    workspaceId: context.scope.workspaceId,
    scope: original.scope,
    canonicalKey: original.canonicalKey,
    source: 'mistaken_entry_correction',
    commandId: input.commandId,
    supersedesEventId: original.eventId,
    channel: original.channel,
  });

  // A supersession already lifted this event: refused before anything is claimed or
  // journalled (brief RF, R1).
  if (await alreadySuperseded(context, original.eventId)) return refuse('already_superseded');

  // The claim, before the row. The finalizer races for the same claim; another supersession
  // races for the row, under the savepoint, which also takes the claim back if the row loses.
  let claimLost: 'already_finalized' | 'already_superseded' | null = null;
  const written = await underSupersessionSavepoint(context, async () => {
    const claim = await claimFinalization(context, {
      eventId: original.eventId,
      outcome: 'corrected',
      correctionEventId,
      decidedByUserId: actor.userId,
    });
    if (!claim.won) {
      claimLost = claim.outcome === 'finalized' ? 'already_finalized' : 'already_superseded';
      return false;
    }
    await context.db.query(
      `INSERT INTO suppression_events
         (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source,
          actor_user_id, command_id, recorded_at, supersedes_event_id, supersession_reason, channel)
       VALUES ($1, $2, $3, $4, $5, 'mistaken_entry_correction', $6, $7, $8::timestamptz, $9, 'mistaken_entry', $10)`,
      [
        context.scope.workspaceId,
        correctionEventId,
        original.scope,
        original.canonicalKey,
        original.canonicalizerVersion,
        actor.userId,
        input.commandId ?? null,
        now,
        original.eventId,
        original.channel,
      ],
    );
    return true;
  });
  if (!written) return refuse(claimLost ?? 'already_superseded');

  const copiedLifts = await liftMergeCopies(context, original.eventId, correctionEventId);

  // The record the caller journals after the commit (brief RF): never appended here.
  const journalRecord: SuppressionJournalRecord = {
    eventId: correctionEventId,
    workspaceId: context.scope.workspaceId,
    scope: original.scope,
    canonicalKey: original.canonicalKey,
    canonicalizerVersion: original.canonicalizerVersion,
    source: 'mistaken_entry_correction',
    actorUserId: actor.userId,
    commandId: input.commandId ?? null,
    supersedesEventId: original.eventId,
    supersessionReason: 'mistaken_entry',
    recordedAt: now,
    channel: original.channel,
  };

  // "It clears only this hold; remaining holds still apply."
  const released = await releaseHoldsOfEvent(context, {
    sourceEventId: original.eventId,
    reasonCode: 'manual_suppression_review',
  });
  const blockedMilliseconds = unionDuration(
    released.map(hold => ({ start: Date.parse(hold.startedAt), end: Date.parse(hold.releasedAt) })),
  );

  await recordCrmAuditEvent(context, {
    action: 'suppression.corrected',
    subjectKind: 'suppression_event',
    subjectId: original.eventId,
    detail: { correctionEventId, releasedHolds: released.length, blockedMilliseconds },
  });

  return accept({
    journalRecords: [journalRecord, ...copiedLifts],
    correctionEventId,
    originalEventId: original.eventId,
    releasedHoldIds: released.map(hold => hold.id),
    blockedMilliseconds,
  });
}

/**
 * The admin supersession (10.2).
 *
 * "After ten minutes, only an admin may supersede an event for `correction` or
 * `documented_reconsent`. A salesperson can never supersede a prospect-originated
 * request."
 *
 * There is deliberately no claim here. The ten-minute race belongs to the
 * salesperson's window; an admin superseding an event the finalizer already
 * finalized is not a race but a sequence — the terminal stops happened, and the
 * supersession lifts the suppression from here on. `already_superseded` comes from
 * migration 0001's partial unique index, so two admins racing produce one.
 *
 * The supersession is journalled by the caller after the command commits (brief RF): the
 * result carries its record. A lift in the journal that never committed is the one journal
 * object a replay must never apply.
 */
export async function recordAdminSupersession(
  context: RepositoryContext,
  input: {
    readonly eventId: string;
    readonly reason: 'correction' | 'documented_reconsent';
    readonly commandId?: string | undefined;
  },
): Promise<
  SuppressionResult<{
    readonly supersessionEventId: string;
    readonly originalEventId: string;
    /** The releases written, the lift first, for the caller to append after the commit (J2). */
    readonly journalRecords: readonly SuppressionJournalRecord[];
  }>
> {
  if (!isAdminScope(context.scope)) return refuse('admin_only');
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refuse('admin_only');
  await lockSuppressionHistory(context);

  const original = await readSuppressionEvent(context, input.eventId);
  if (original === null) return refuse('suppression_unknown');
  if (!isSupportedCanonicalizerVersion(original.canonicalizerVersion)) return refuse('canonicalizer_unsupported');

  const now = await databaseNow(context);
  const supersessionEventId = deterministicEventId({
    workspaceId: context.scope.workspaceId,
    scope: original.scope,
    canonicalKey: original.canonicalKey,
    source: 'admin_supersession',
    commandId: input.commandId,
    supersedesEventId: original.eventId,
    channel: original.channel,
  });

  // Brief RF, R1: a supersession that already exists is a clean refusal, found before
  // anything is journalled; one racing this command is decided by the unique index, under a
  // savepoint, so the refusal leaves the transaction whole for its receipt.
  if (await alreadySuperseded(context, original.eventId)) return refuse('already_superseded');
  const written = await underSupersessionSavepoint(context, async () => {
    await context.db.query(
      `INSERT INTO suppression_events
         (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source,
          actor_user_id, command_id, recorded_at, supersedes_event_id, supersession_reason, channel)
       VALUES ($1, $2, $3, $4, $5, 'admin_supersession', $6, $7, $8::timestamptz, $9, $10, $11)`,
      [
        context.scope.workspaceId,
        supersessionEventId,
        original.scope,
        original.canonicalKey,
        original.canonicalizerVersion,
        actor.userId,
        input.commandId ?? null,
        now,
        original.eventId,
        input.reason,
        original.channel,
      ],
    );
    return true;
  });
  if (!written) return refuse('already_superseded');

  const copiedLifts = await liftMergeCopies(context, original.eventId, supersessionEventId);

  // The record the caller journals after the commit (brief RF): never appended here.
  const journalRecord: SuppressionJournalRecord = {
    eventId: supersessionEventId,
    workspaceId: context.scope.workspaceId,
    scope: original.scope,
    canonicalKey: original.canonicalKey,
    canonicalizerVersion: original.canonicalizerVersion,
    source: 'admin_supersession',
    actorUserId: actor.userId,
    commandId: input.commandId ?? null,
    supersedesEventId: original.eventId,
    supersessionReason: input.reason,
    recordedAt: now,
    channel: original.channel,
  };

  await releaseHoldsOfEvent(context, {
    sourceEventId: original.eventId,
    reasonCode: 'manual_suppression_review',
  });
  await recordCrmAuditEvent(context, {
    action: 'suppression.superseded',
    subjectKind: 'suppression_event',
    subjectId: original.eventId,
    detail: { supersessionEventId, reason: input.reason },
  });

  return accept({ supersessionEventId, originalEventId: original.eventId, journalRecords: [journalRecord, ...copiedLifts] });
}
