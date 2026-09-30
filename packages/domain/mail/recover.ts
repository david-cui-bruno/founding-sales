import type { Queryable } from '../db/queryable.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { enqueueJob } from '../jobs/jobStore.ts';
import { jobIdempotencyKey } from '../jobs/jobKinds.ts';
import { accessForMailbox, holdForRevokedGrant } from './sync.ts';
import type { EnvelopeCipher } from './envelope.ts';
import { GmailClientError, type GmailAccessGrant, type GmailClient, type GmailOAuthConfig } from './gmailClient.ts';
import {
  advanceGeneration,
  openMailboxHold,
  readMailbox,
  recordSyncError,
  releaseMailboxHold,
  setSyncState,
  fenceOf,
  lockForFencedStopFact,
  lockMailboxAtFence,
  StaleMailboxGeneration,
} from './mailboxes.ts';
import { stdoutMailLog } from './log.ts';
import { recordedProviderMessageIds } from './messages.ts';
import {
  combinePipelineReports,
  EMPTY_PIPELINE_REPORT,
  processMessageIds,
  type MessagePipelineDeps,
  type MessagePipelineReport,
} from './pipeline.ts';
import {
  DEFAULT_BASELINE_DAYS,
  RECOVERY_OVERLAP_SECONDS,
  RECOVERY_PAGE_SIZE,
  type MailboxRow,
} from './types.ts';

/**
 * The bounded full synchronization (specification 12.3, Appendix C "Mail recovery",
 * Appendix D, Appendix G 13).
 *
 * "On expired history cursor, the worker performs a full bounded synchronization from
 * the earlier of watermark minus one hour and the oldest unresolved outbound message
 * or active enrollment, using epoch-second `after:` and `before:` bounds, 500 IDs per
 * page, and every page. The health hold clears only when the full interval is
 * processed."
 *
 * Every clause of that sentence is a line here, and three of them are the ones that
 * matter when it goes wrong.
 *
 * **Epoch seconds, never a date string** (Appendix D). Gmail's `after:` accepts both,
 * and a date string is interpreted in a zone nobody chose; the same query run from
 * two containers in two regions would then cover two intervals.
 *
 * **Every page.** The run is resumable rather than unbounded: every run walks the
 * interval in single-page time slices (never a page token; fold 2), skips the ids this
 * mailbox already has a row for, and processes at most `maxMessages` of the rest. The rows are
 * the position; `pages_completed` only says how many pages the last walk read. The
 * next one-minute scheduler pass re-arms the same job row — Appendix C's key
 * `mail-recover:{mailbox}:{generation}` has no instant in it, so there is exactly one
 * row per generation — and the hold stays on until one walk reaches the end of the
 * listing with every listed id covered. Only newly recorded messages spend
 * `maxMessages`; a read cap of three times it bounds a run's Gmail reads. A proven
 * duplicate or a vanished id leaves no row, so more of them than the read cap stalls
 * the recovery (`docs/greenfield/mail.md`, rule 3).
 *
 * **The hold clears on proof, not on success.** `ready`, the watermark and
 * `completed_at` are written together, predicated on the generation, the address and
 * the handoff cursor this run read, and `releaseMailboxHold` re-reads the mailbox and
 * refuses unless it is `ready`. 4.2: "It clears only after complete coverage is
 * proven, never after one successful API call."
 *
 * **The handoff is continuous.** The recovery's cursor is the profile's history id
 * read before `toAt` was fixed (`startRecovery`), and completion adopts that id rather
 * than asking Gmail again, so a message that arrives during the recovery is in the
 * listing, in the history after the cursor, or in both — never in neither.
 */

/**
 * 12.3's "the oldest unresolved outbound message or active enrollment".
 *
 * Neither table exists in G7-1: `outbound_messages` is G7-2's and `enrollments` are
 * G8's. So the floor is a port with a default of "nothing older is outstanding",
 * which is the truth today — FSS has sent nothing and enrolled nobody — and becomes
 * a two-line query in each of those lanes without changing this file.
 */
/**
 * A recovery lists its interval in slices of this width (fold 2): one day. A slice
 * holding more than a page is bisected, so the width only sets how many listing calls
 * a quiet mailbox costs — thirty for a thirty-day baseline.
 */
export const RECOVERY_SLICE_SECONDS = 24 * 60 * 60;

/**
 * One second of a mailbox held more messages than one listing page (500 by default).
 * Gmail does not deliver mail that fast into one mailbox; this is the named refusal
 * rather than a silent truncation.
 */
export class RecoverySliceOverflow extends Error {
  override readonly name = 'RecoverySliceOverflow';
  constructor(readonly mailboxId: string, readonly atEpochSeconds: number, readonly pageSize: number) {
    super(`one second of the recovery interval holds more than ${String(pageSize)} messages`);
  }
}

/** A recovery run reads at most this many times `maxMessages` ids (fold 1). */
export const RECOVERY_READ_CAP_FACTOR = 3;

export interface RecoveryFloorSource {
  oldestUnresolvedAt(context: RepositoryContext, mailboxId: string): Promise<string | null>;
}

export const NO_RECOVERY_FLOOR: RecoveryFloorSource = {
  oldestUnresolvedAt: async () => await Promise.resolve(null),
};

export interface RecoveryRow {
  readonly id: string;
  readonly generation: number;
  readonly reason: 'baseline' | 'history_expired' | 'restore';
  readonly fromAt: string;
  readonly toAt: string;
  readonly pagesCompleted: number;
  readonly messagesSeen: number;
  readonly completedAt: string | null;
}

interface RecoveryDbRow {
  readonly id: string;
  readonly generation: number;
  readonly reason: 'baseline' | 'history_expired' | 'restore';
  readonly from_at: Date;
  readonly to_at: Date;
  readonly pages_completed: number;
  readonly messages_seen: number;
  readonly completed_at: Date | null;
  readonly [column: string]: unknown;
}

const toRecovery = (row: RecoveryDbRow): RecoveryRow => ({
  id: row.id,
  generation: row.generation,
  reason: row.reason,
  fromAt: row.from_at.toISOString(),
  toAt: row.to_at.toISOString(),
  pagesCompleted: row.pages_completed,
  messagesSeen: row.messages_seen,
  completedAt: row.completed_at?.toISOString() ?? null,
});

export async function readRecovery(
  context: RepositoryContext,
  input: { readonly mailboxId: string; readonly generation: number },
): Promise<RecoveryRow | null> {
  const { rows } = await context.db.query<RecoveryDbRow>(
    `SELECT id, generation, reason, from_at, to_at, pages_completed, messages_seen, completed_at
       FROM mailbox_recoveries
      WHERE workspace_id = $1 AND mailbox_id = $2 AND generation = $3`,
    [context.scope.workspaceId, input.mailboxId, input.generation],
  );
  const row = rows[0];
  return row === undefined ? null : toRecovery(row);
}

export interface StartRecoveryInput {
  readonly mailbox: MailboxRow;
  readonly reason: 'baseline' | 'history_expired' | 'restore';
  /** The caller's own floor; the recovery takes the earlier of this and the port's. */
  readonly fromAt?: string | undefined;
  readonly floor?: RecoveryFloorSource | undefined;
  /**
   * The continuous handoff (`docs/greenfield/mail.md`): the profile's `historyId`, read
   * *before* the interval's end is fixed. The recovery covers the listing up to `toAt`
   * and history sync covers everything after this id, so a message that arrives while
   * the recovery runs is in one or both and never in neither. It is stored as the
   * mailbox's cursor when the recovery is created, and completion adopts it.
   */
  readonly startHistoryId: string;
  /**
   * The interval's end. Now, unless a test pins it; either way it must not be earlier
   * than the instant `startHistoryId` was read.
   */
  readonly toAt?: string | undefined;
  readonly baselineDays?: number | undefined;
}

/**
 * Create the recovery row for this generation and enqueue its job.
 *
 * Idempotent on `(mailbox, generation)` at both ends: the row's unique constraint and
 * `mail-recover:{mailbox}:{generation}`. A second call for a generation that is
 * already recovering returns the row it found and enqueues nothing new.
 */
export async function startRecovery(
  context: RepositoryContext,
  input: StartRecoveryInput,
): Promise<RecoveryRow> {
  if (!/^[0-9]{1,20}$/.test(input.startHistoryId)) {
    throw new Error('a recovery starts from a Gmail history id');
  }
  const existing = await readRecovery(context, {
    mailboxId: input.mailbox.id,
    generation: input.mailbox.generation,
  });
  if (existing !== null) return existing;

  const toAt = input.toAt ?? new Date().toISOString();
  const baselineDays = input.baselineDays ?? DEFAULT_BASELINE_DAYS;
  const defaultFloor = new Date(Date.parse(toAt) - baselineDays * 24 * 3600 * 1000).toISOString();
  const outstanding = await (input.floor ?? NO_RECOVERY_FLOOR).oldestUnresolvedAt(context, input.mailbox.id);

  // "The earlier of" — and every candidate is a real bound, so the earliest of the
  // three is the one that covers all of them.
  const candidates = [input.fromAt ?? defaultFloor, ...(outstanding === null ? [] : [outstanding])];
  const fromAt = candidates.reduce((earliest, candidate) => (candidate < earliest ? candidate : earliest));
  // An interval must be an interval; a clock that has gone backwards is not a reason
  // to write a row the CHECK will refuse.
  const safeFromAt = fromAt < toAt ? fromAt : new Date(Date.parse(toAt) - RECOVERY_OVERLAP_SECONDS * 1000).toISOString();

  const { rows } = await context.db.query<RecoveryDbRow>(
    `INSERT INTO mailbox_recoveries (workspace_id, mailbox_id, generation, reason, from_at, to_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT ON CONSTRAINT mailbox_recoveries_one_per_generation DO NOTHING
     RETURNING id, generation, reason, from_at, to_at, pages_completed, messages_seen, completed_at`,
    [context.scope.workspaceId, input.mailbox.id, input.mailbox.generation, input.reason, safeFromAt, toAt],
  );
  const created = rows[0];
  if (created === undefined) {
    const found = await readRecovery(context, {
      mailboxId: input.mailbox.id,
      generation: input.mailbox.generation,
    });
    if (found === null) throw new Error('a recovery insert conflicted with a row that is not there');
    return found;
  }

  // The handoff's cursor, written with the recovery that owns it and fenced on the
  // generation the recovery is for: a mailbox that moved on since the caller read it is
  // not this recovery's to point anywhere.
  const cursor = await context.db.query(
    `UPDATE mailboxes
        SET history_id = $4, history_id_updated_at = now(), updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND generation = $3 AND email_address = $5`,
    [context.scope.workspaceId, input.mailbox.id, input.mailbox.generation, input.startHistoryId, input.mailbox.emailAddress],
  );
  if ((cursor.rowCount ?? 0) === 0) {
    throw new StaleMailboxGeneration(input.mailbox.id, 'recovery start', fenceOf(input.mailbox));
  }

  await enqueueJob(context.db, {
    workspaceId: context.scope.workspaceId,
    kind: 'mail.recover',
    payload: { mailboxId: input.mailbox.id, generation: input.mailbox.generation },
    idempotencyKey: jobIdempotencyKey.mailRecover(input.mailbox.id, input.mailbox.generation),
  });

  return toRecovery(created);
}

/**
 * Appendix E step 4 for one mailbox: a recovery from the restore point minus ten
 * minutes, begun the way every recovery after a baseline is begun (lane g59).
 *
 * `mailbox_recoveries` holds one recovery per mailbox generation, and `startRecovery`
 * returns the one it finds. A connected mailbox has already completed its baseline at
 * its current generation, so a restore recovery started without advancing it was the
 * *baseline* row, already complete: `runMailRecovery` answered `already_complete` and
 * reprocessed nothing, and `fss admin mailbox recover` reported a pass over an inbox it
 * never read. That was true in production as much as in the drill, and the drill's own
 * assertion ("no reply reapplied its effect") is what would have said so.
 *
 * So this is the expired-cursor recovery's shape, with the restore's reason and floor:
 * advance the generation first, so anything in flight for the old one can no longer
 * write; mark the mailbox `recovering` and hold its automation on `coverage_incomplete`,
 * which the completed recovery releases; then start the recovery for the new
 * generation. The caller runs it with the generation this returns.
 */
export async function beginRestoreRecovery(
  context: RepositoryContext,
  input: {
    readonly mailbox: MailboxRow;
    /** Appendix E.4's "restore point minus ten minutes". */
    readonly fromAt: string;
    /** The profile's `historyId`, read before this is called (`StartRecoveryInput`). */
    readonly startHistoryId: string;
    readonly floor?: RecoveryFloorSource | undefined;
  },
): Promise<RecoveryRow> {
  const generation = await advanceGeneration(context, input.mailbox.id);
  await setSyncState(context, { mailboxId: input.mailbox.id, syncState: 'recovering' });
  await openMailboxHold(context, {
    mailboxId: input.mailbox.id,
    ownerUserId: input.mailbox.ownerUserId,
    reasonCode: 'coverage_incomplete',
  });
  return await startRecovery(context, {
    mailbox: { ...input.mailbox, generation },
    reason: 'restore',
    fromAt: input.fromAt,
    startHistoryId: input.startHistoryId,
    ...(input.floor === undefined ? {} : { floor: input.floor }),
  });
}

export interface MailRecoveryDeps extends MessagePipelineDeps {
  readonly gmail: GmailClient;
  readonly oauth: GmailOAuthConfig;
  readonly cipher: EnvelopeCipher;
  readonly maxMessages?: number | undefined;
  readonly pageSize?: number | undefined;
}

export type MailRecoveryOutcome =
  | 'completed'
  | 'continued'
  | 'already_complete'
  | 'recovery_unknown'
  | 'mailbox_unknown'
  | 'mailbox_inactive'
  | 'generation_superseded'
  | 'grant_revoked'
  | 'rate_limited';

export interface MailRecoveryReport extends MessagePipelineReport {
  readonly outcome: MailRecoveryOutcome;
  readonly mailboxId: string;
  readonly generation: number;
  readonly fromAt: string | null;
  readonly toAt: string | null;
  readonly pagesCompleted: number;
  readonly coverageProved: boolean;
}

function recoveryReport(
  mailboxId: string,
  generation: number,
  outcome: MailRecoveryOutcome,
  pipeline: MessagePipelineReport = EMPTY_PIPELINE_REPORT,
  extra: Partial<MailRecoveryReport> = {},
): MailRecoveryReport {
  return {
    ...pipeline,
    outcome,
    mailboxId,
    generation,
    fromAt: null,
    toAt: null,
    pagesCompleted: 0,
    coverageProved: false,
    ...extra,
  };
}

export async function runMailRecovery(
  context: RepositoryContext,
  deps: MailRecoveryDeps,
  input: { readonly mailboxId: string; readonly generation: number },
): Promise<MailRecoveryReport> {
  const mailbox = await readMailbox(context, input.mailboxId);
  if (mailbox === null) return recoveryReport(input.mailboxId, input.generation, 'mailbox_unknown');

  // A recovery for a superseded generation must not write. The generation is the
  // fence: something newer has already decided what this mailbox's coverage means.
  // This is the entry check; every write below is predicated on the same generation
  // and address again, because the mailbox can move on while this run talks to Gmail.
  if (mailbox.generation !== input.generation) {
    return recoveryReport(input.mailboxId, input.generation, 'generation_superseded');
  }
  if (mailbox.status !== 'connected') {
    await lockForFencedStopFact(context, { mailboxId: mailbox.id, fence: fenceOf(mailbox), write: 'disconnected hold' });
    await openMailboxHold(context, {
      mailboxId: mailbox.id,
      ownerUserId: mailbox.ownerUserId,
      reasonCode: 'mailbox_disconnected',
    });
    return recoveryReport(mailbox.id, input.generation, 'mailbox_inactive');
  }
  const fence = fenceOf(mailbox);

  const found = await readRecovery(context, { mailboxId: mailbox.id, generation: input.generation });
  if (found === null) return recoveryReport(mailbox.id, input.generation, 'recovery_unknown');
  if (found.completedAt !== null) {
    return recoveryReport(mailbox.id, input.generation, 'already_complete', EMPTY_PIPELINE_REPORT, {
      fromAt: found.fromAt,
      toAt: found.toAt,
      pagesCompleted: found.pagesCompleted,
      coverageProved: true,
    });
  }

  const access = await accessForMailbox(context, deps, mailbox.id);
  if (!access.ok) {
    await holdForRevokedGrant(context, mailbox);
    return recoveryReport(mailbox.id, input.generation, 'grant_revoked');
  }

  // The continuous handoff's cursor: `startRecovery` stored the profile's history id,
  // read before `toAt` was fixed, as the mailbox's cursor, and completion adopts
  // exactly that id. A recovery started before the handoff existed has no cursor; it
  // takes one now, before the listing, and moves its interval's end to after the read
  // so the two still meet.
  //
  // Fold 2: a cursor is this recovery's captured handoff only if it was written no
  // earlier than the recovery row (`startRecovery` writes both in one transaction). An
  // older cursor — none at all, or the expired one a pre-handoff expired-cursor
  // recovery left behind — is adopted afresh here, before the listing.
  let recovery = found;
  let capturedHistoryId = mailbox.historyId;
  if (!(await cursorIsCapturedHandoff(context, recovery.id))) {
    const adopted = await adoptHandoffCursor(context, deps, { access: access.access, mailbox, recovery });
    recovery = adopted.recovery;
    capturedHistoryId = adopted.historyId;
  }

  // Appendix D: epoch seconds, never an ambiguous date string.
  const afterEpochSeconds = Math.floor(Date.parse(recovery.fromAt) / 1000);
  const beforeEpochSeconds = Math.ceil(Date.parse(recovery.toAt) / 1000);
  const pageSize = deps.pageSize ?? RECOVERY_PAGE_SIZE;
  const maxMessages = deps.maxMessages ?? pageSize;

  // Two budgets. `maxMessages` counts only messages this run newly records: a proven
  // duplicate or a vanished id writes no row and costs nothing against it. The read cap
  // bounds the run's duration whatever the ids turn out to be: at most
  // `RECOVERY_READ_CAP_FACTOR × maxMessages` ids are read (one metadata read each; a
  // collision adds one more read of the other message).
  const readCap = RECOVERY_READ_CAP_FACTOR * maxMessages;

  // The walk (fold 2): the interval in time slices, each listed by ONE
  // `users.messages.list` call with no page token. Gmail documents nothing about how a
  // page token behaves when the mailbox changes between pages — a message deleted
  // before the second page can shift a surviving one off both — so a recovery never
  // follows one. A single response is one answer. A slice whose answer says there is
  // more (`nextPageToken`) holds more than a page: the answer is discarded and the
  // slice bisected, down to one second. Every run re-walks every slice in order and
  // skips the ids already recorded; the walk comes before the pipeline, so no listing
  // call waits behind the send gate, and it stops early once it holds more unrecorded
  // ids than the read cap lets this run read, because this run then cannot complete.
  const unrecorded: string[] = [];
  const seen = new Set<string>();
  let slicesListed = 0;
  let listingEnded = false;
  // Pending slices, earliest last so `pop` takes the earliest.
  const pending: { readonly from: number; readonly to: number }[] = [];
  for (let from = afterEpochSeconds; from < beforeEpochSeconds; from += RECOVERY_SLICE_SECONDS) {
    pending.push({ from, to: Math.min(beforeEpochSeconds, from + RECOVERY_SLICE_SECONDS) });
  }
  pending.reverse();

  for (;;) {
    const slice = pending.pop();
    if (slice === undefined) {
      listingEnded = true;
      break;
    }
    const outcome = await deps.gmail.listMessageIds(access.access, {
      // One second of overlap below every slice but the first, so a message at a
      // boundary second is in a slice whichever way Gmail treats `after:` and `before:`.
      afterEpochSeconds: slice.from === afterEpochSeconds ? slice.from : slice.from - 1,
      beforeEpochSeconds: slice.to,
      maxResults: pageSize,
    });
    if (!outcome.ok) {
      if (outcome.reason === 'grant_revoked') {
        await holdForRevokedGrant(context, mailbox);
        return recoveryReport(mailbox.id, input.generation, 'grant_revoked');
      }
      await recordSyncError(context, { mailboxId: mailbox.id, error: 'the Gmail recovery listing was rate limited', fence });
      return recoveryReport(mailbox.id, input.generation, 'rate_limited');
    }
    slicesListed += 1;
    if (outcome.nextPageToken !== null) {
      if (slice.to - slice.from <= 1) {
        throw new RecoverySliceOverflow(mailbox.id, slice.from, pageSize);
      }
      const middle = slice.from + Math.floor((slice.to - slice.from) / 2);
      pending.push({ from: middle, to: slice.to }, { from: slice.from, to: middle });
      continue;
    }
    const recorded = await recordedProviderMessageIds(context, {
      mailboxId: mailbox.id,
      providerMessageIds: outcome.messageIds,
    });
    for (const id of outcome.messageIds) {
      if (recorded.has(id) || seen.has(id)) continue;
      seen.add(id);
      unrecorded.push(id);
    }
    if (unrecorded.length > readCap) break;
  }
  const pagesWalked = slicesListed;

  // The pipeline, in slices no larger than either budget has left. Each id costs at
  // least one read and at most one new row, so a slice can overrun neither.
  let pipeline: MessagePipelineReport = EMPTY_PIPELINE_REPORT;
  let processed = 0;
  while (processed < unrecorded.length) {
    const size = Math.min(maxMessages - pipeline.messagesRecorded, readCap - processed, unrecorded.length - processed);
    if (size <= 0) break;
    const slice = await processMessageIds(context, deps, {
      mailbox,
      access: access.access,
      messageIds: unrecorded.slice(processed, processed + size),
    });
    pipeline = combinePipelineReports(pipeline, slice);
    processed += slice.processedMessages;
    if (slice.readFailure !== null) break;
  }
  // The pipeline stops at a failed Gmail read instead of throwing, which `mail.sync` uses
  // to commit the prefix it processed. A recovery throws instead and the whole job rolls
  // back and is retried; the recorded rows are its position, so nothing is lost by
  // that, and the coverage hold blocks the owner's automated sends meanwhile.
  if (pipeline.readFailure !== null) {
    throw new GmailClientError(
      'unexpected_status',
      `the Gmail ${pipeline.readFailure.read} read failed during recovery (${pipeline.readFailure.detail})`,
    );
  }

  // Coverage is proved only by one walk, in this run, that reached the end of the
  // listing with every listed id covered: it has a row (from an earlier run, or recorded
  // now), or this run found it a proven duplicate, or this run found it gone. Every id
  // this run processed is one of those, so the walk must have ended and every unrecorded
  // id it collected must have been processed.
  const complete = listingEnded && processed === unrecorded.length;

  if (!complete) {
    // The mailbox row at this run's fence, locked to commit (fold 2): the UPDATE below
    // joins the mailbox but locks only the recovery row, so without this a generation
    // bump could commit between its predicate and this job's commit. The pipeline may
    // already hold the send gate, so the order is gate, then row.
    await lockMailboxAtFence(context, { mailboxId: mailbox.id, fence, write: 'recovery progress' });
    const progress = await context.db.query(
      `UPDATE mailbox_recoveries AS r
          SET pages_completed = $3,
              messages_seen = r.messages_seen + $4
         FROM mailboxes AS m
        WHERE r.workspace_id = $1 AND r.id = $2 AND r.completed_at IS NULL
          AND m.workspace_id = r.workspace_id AND m.id = r.mailbox_id
          AND m.generation = $5 AND m.email_address = $6`,
      [context.scope.workspaceId, recovery.id, pagesWalked, pipeline.messagesSeen, fence.generation, fence.emailAddress],
    );
    if ((progress.rowCount ?? 0) === 0) throw new StaleMailboxGeneration(mailbox.id, 'recovery progress', fence);
    if (pipeline.messagesRecorded === 0) {
      // A run that recorded nothing and did not complete is not progress, however healthy
      // its heartbeat: every id it could read was a proven duplicate or gone, or the read
      // cap stopped it first. Identifiers and counts only.
      (deps.log ?? stdoutMailLog)('warn', 'mail.recovery_no_progress', {
        mailboxId: mailbox.id,
        generation: input.generation,
        reason: recovery.reason,
        unrecordedListed: unrecorded.length,
        idsRead: processed,
        duplicateRfcId: pipeline.duplicateRfcId,
        vanishedMessages: pipeline.vanishedMessages,
        listingEnded,
      });
    }
    // Another pass is needed, and this run does not schedule it: the handler is
    // inside the runner's transaction and its own job row is still `running`, so it
    // cannot re-arm itself. `mailRecoverySource` finds every incomplete recovery on
    // the next one-minute pass and re-arms it there, which is also the only place an
    // operator can stop it.
    return recoveryReport(mailbox.id, input.generation, 'continued', pipeline, {
      fromAt: recovery.fromAt,
      toAt: recovery.toAt,
      pagesCompleted: pagesWalked,
    });
  }

  // Conditional completion: `ready`, the watermark at the interval's end, and the
  // recovery's `completed_at` commit together or not at all, and only while the mailbox
  // is still the generation and address this run read and still stands on the handoff
  // cursor. The mailbox statement goes first and is the predicate: the row lock it takes
  // holds to commit, so nothing moves the mailbox between it and the two writes after
  // it. The cursor is not written here: it is already the id read before `toAt`.
  const completed = await context.db.query(
    `UPDATE mailboxes
        SET sync_state = 'ready',
            baseline_completed_at = CASE WHEN $6 THEN now() ELSE baseline_completed_at END,
            coverage_watermark_at = $7::timestamptz,
            last_synced_at = now(),
            last_sync_error = NULL,
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND status = 'connected'
        AND generation = $3 AND email_address = $4 AND history_id = $5`,
    [
      context.scope.workspaceId,
      mailbox.id,
      fence.generation,
      fence.emailAddress,
      capturedHistoryId,
      recovery.reason === 'baseline',
      recovery.toAt,
    ],
  );
  if ((completed.rowCount ?? 0) === 0) throw new StaleMailboxGeneration(mailbox.id, 'recovery completion', fence);
  await context.db.query(
    `UPDATE mailbox_recoveries
        SET pages_completed = $3, messages_seen = messages_seen + $4, completed_at = now()
      WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, recovery.id, pagesWalked, pipeline.messagesSeen],
  );
  // Only now may the hold go; `releaseMailboxHold` re-reads the row and refuses unless
  // it is `ready`, which the statement above made it in this transaction.
  await releaseMailboxHold(context, { mailboxId: mailbox.id, reasonCode: 'coverage_incomplete' });

  return recoveryReport(mailbox.id, input.generation, 'completed', pipeline, {
    fromAt: recovery.fromAt,
    toAt: recovery.toAt,
    pagesCompleted: pagesWalked,
    coverageProved: true,
  });
}

/** Whether the mailbox's cursor was written with (or after) this recovery row. */
async function cursorIsCapturedHandoff(context: RepositoryContext, recoveryId: string): Promise<boolean> {
  const { rows } = await context.db.query<{ captured: boolean }>(
    `SELECT (m.history_id IS NOT NULL AND m.history_id_updated_at >= r.started_at) AS captured
       FROM mailbox_recoveries AS r
       JOIN mailboxes AS m ON m.workspace_id = r.workspace_id AND m.id = r.mailbox_id
      WHERE r.workspace_id = $1 AND r.id = $2`,
    [context.scope.workspaceId, recoveryId],
  );
  return rows[0]?.captured === true;
}

/**
 * A recovery created before the continuous handoff has no cursor of its own to adopt:
 * none, or an older one (an expired cursor). Take one
 * now — the profile first, then the interval's end moved to no earlier than the read —
 * so that from here on it behaves exactly like one `startRecovery` created.
 */
async function adoptHandoffCursor(
  context: RepositoryContext,
  deps: MailRecoveryDeps,
  input: { readonly access: GmailAccessGrant; readonly mailbox: MailboxRow; readonly recovery: RecoveryRow },
): Promise<{ readonly historyId: string; readonly recovery: RecoveryRow }> {
  const profile = await deps.gmail.getProfile(input.access);
  const capturedAt = new Date().toISOString();
  const fence = fenceOf(input.mailbox);
  const cursor = await context.db.query(
    `UPDATE mailboxes
        SET history_id = $5, history_id_updated_at = now(), updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND generation = $3 AND email_address = $4
        AND history_id IS NOT DISTINCT FROM $6`,
    [context.scope.workspaceId, input.mailbox.id, fence.generation, fence.emailAddress, profile.historyId, input.mailbox.historyId],
  );
  if ((cursor.rowCount ?? 0) === 0) throw new StaleMailboxGeneration(input.mailbox.id, 'recovery handoff', fence);
  const { rows } = await context.db.query<RecoveryDbRow>(
    `UPDATE mailbox_recoveries SET to_at = greatest(to_at, $3::timestamptz)
      WHERE workspace_id = $1 AND id = $2
      RETURNING id, generation, reason, from_at, to_at, pages_completed, messages_seen, completed_at`,
    [context.scope.workspaceId, input.recovery.id, capturedAt],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('a recovery vanished while it adopted its handoff cursor');
  return { historyId: profile.historyId, recovery: toRecovery(row) };
}

/**
 * Every recovery that has not finished, so the scheduler can re-arm its job.
 *
 * Only the mailbox's current generation counts: an older one has been superseded and
 * its handler would refuse to write anyway, so re-arming it would burn attempts to
 * reach a `generation_superseded` every minute.
 */
export async function listIncompleteRecoveries(
  db: Queryable,
): Promise<readonly { readonly workspaceId: string; readonly mailboxId: string; readonly generation: number }[]> {
  const { rows } = await db.query<{ workspace_id: string; mailbox_id: string; generation: number }>(
    `SELECT r.workspace_id, r.mailbox_id, r.generation
       FROM mailbox_recoveries AS r
       JOIN mailboxes AS m ON m.workspace_id = r.workspace_id AND m.id = r.mailbox_id
      WHERE r.completed_at IS NULL
        AND m.status = 'connected'
        AND m.generation = r.generation
      ORDER BY r.started_at`,
  );
  return rows.map(row => ({
    workspaceId: row.workspace_id,
    mailboxId: row.mailbox_id,
    generation: row.generation,
  }));
}

/**
 * Put a finished recovery job back on the queue for another pass.
 *
 * The key has no instant in it — Appendix C's `mail-recover:{mailbox}:{generation}` —
 * so the completed row has to be reusable. A dead recovery stays dead, because
 * reviving it is an admin's audited decision (13.2); the dead-job alarm is what makes
 * that visible.
 */
export async function rearmRecoveryJob(
  db: Queryable,
  input: { readonly workspaceId: string; readonly mailboxId: string; readonly generation: number },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE jobs
        SET state = 'queued',
            attempt_count = 0,
            run_at = now(),
            not_before = now(),
            completed_at = NULL,
            error_code = NULL,
            error_detail = NULL,
            updated_at = now()
      WHERE workspace_id = $1 AND kind = 'mail.recover' AND idempotency_key = $2 AND state = 'done'`,
    [input.workspaceId, jobIdempotencyKey.mailRecover(input.mailboxId, input.generation)],
  );
  return (rowCount ?? 0) > 0;
}
