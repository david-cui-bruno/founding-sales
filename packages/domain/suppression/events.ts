import type { SuppressionRefusalCode, SuppressionScope, SuppressionSource } from '@fss/contracts';
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
import { deterministicEventId, type SuppressionJournal } from './journal.ts';

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
 * the command transaction and before the `INSERT`. A throw rolls the transaction
 * back and nothing is suppressed; a success followed by a rollback leaves the
 * journal holding an event the database does not, which 10.2 calls out as the safe
 * direction because replay only ever re-adds a suppression.
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
  readonly [column: string]: unknown;
}

const EVENT_COLUMNS = `event_id, scope, canonical_key, canonicalizer_version, source, actor_user_id,
  command_id, recorded_at, supersedes_event_id, supersession_reason`;

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

/** The action kinds a suppression's review hold blocks. Everything outbound. */
const REVIEW_HOLD_BLOCKS = ['email_send', 'call_task', 'dial_authorization', 'enrollment_advance'] as const;

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
  readonly commandId?: string | undefined;
  readonly journal: SuppressionJournal;
}

export interface RecordedSuppression {
  readonly eventId: string;
  readonly scope: SuppressionScope;
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

export async function recordSuppression(
  context: RepositoryContext,
  input: RecordSuppressionInput,
): Promise<SuppressionResult<RecordedSuppression>> {
  const actor = context.scope.actor;
  const actorUserId = actor.kind === 'user' ? actor.userId : null;

  // A suppression is the strongest stop fact there is, so it takes the send gate
  // before anything else (lane g77, `policy/sendGate.ts`): a dispatch claim that is
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

  const now = await databaseNow(context);
  const eventId = deterministicEventId({
    workspaceId: context.scope.workspaceId,
    scope: input.scope,
    canonicalKey,
    source: input.source,
    commandId: input.commandId,
  });

  const existing = await readSuppressionEvent(context, eventId);
  if (existing !== null) {
    // The same command recorded the same fact. Idempotent by the deterministic id,
    // which is what makes Appendix E's journal replay safe.
    return accept({
      eventId: existing.eventId,
      scope: existing.scope,
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
  });

  await context.db.query(
    `INSERT INTO suppression_events
       (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source,
        actor_user_id, command_id, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)`,
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
          blockedActionKinds: REVIEW_HOLD_BLOCKS,
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
    detail: { scope: input.scope, source: input.source, terminal, holds: reviewHoldIds.length },
  });

  return accept({
    eventId,
    scope: input.scope,
    canonicalKey,
    canonicalizerVersion: CANONICALIZER_VERSION,
    recordedAt: now,
    terminal,
    reviewHoldIds,
    correctionDeadline,
    replayed: false,
  });
}

export interface CorrectionOutcome {
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
  input: { readonly eventId: string; readonly commandId?: string | undefined; readonly journal: SuppressionJournal },
): Promise<SuppressionResult<CorrectionOutcome>> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refuse('not_your_event');

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
  });

  // The claim, before anything is written. The finalizer races for the same row.
  const claim = await claimFinalization(context, {
    eventId: original.eventId,
    outcome: 'corrected',
    correctionEventId,
    decidedByUserId: actor.userId,
  });
  if (!claim.won) return refuse(claim.outcome === 'finalized' ? 'already_finalized' : 'already_superseded');

  await input.journal.append({
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
  });

  try {
    await context.db.query(
      `INSERT INTO suppression_events
         (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source,
          actor_user_id, command_id, recorded_at, supersedes_event_id, supersession_reason)
       VALUES ($1, $2, $3, $4, $5, 'mistaken_entry_correction', $6, $7, $8::timestamptz, $9, 'mistaken_entry')`,
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
      ],
    );
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505') {
      return refuse('already_superseded');
    }
    throw error;
  }

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
 */
export async function recordAdminSupersession(
  context: RepositoryContext,
  input: {
    readonly eventId: string;
    readonly reason: 'correction' | 'documented_reconsent';
    readonly commandId?: string | undefined;
    readonly journal: SuppressionJournal;
  },
): Promise<SuppressionResult<{ readonly supersessionEventId: string; readonly originalEventId: string }>> {
  if (!isAdminScope(context.scope)) return refuse('admin_only');
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refuse('admin_only');

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
  });

  await input.journal.append({
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
  });

  try {
    await context.db.query(
      `INSERT INTO suppression_events
         (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source,
          actor_user_id, command_id, recorded_at, supersedes_event_id, supersession_reason)
       VALUES ($1, $2, $3, $4, $5, 'admin_supersession', $6, $7, $8::timestamptz, $9, $10)`,
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
      ],
    );
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505') {
      return refuse('already_superseded');
    }
    throw error;
  }

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

  return accept({ supersessionEventId, originalEventId: original.eventId });
}
