import type { Queryable } from '../db/queryable.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { enqueueJob } from '../jobs/jobStore.ts';
import { jobIdempotencyKey } from '../jobs/jobKinds.ts';
import { accessForMailbox, holdForRevokedGrant } from './sync.ts';
import type { EnvelopeCipher } from './envelope.ts';
import type { GmailClient, GmailOAuthConfig } from './gmailClient.ts';
import {
  openMailboxHold,
  readMailbox,
  recordSyncError,
  releaseMailboxHold,
  setSyncState,
  advanceCursor,
} from './mailboxes.ts';
import {
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
 * **Every page.** The run is resumable rather than unbounded: it processes at most
 * `maxMessages` per job and records how far it got in `pages_completed`. The next
 * one-minute scheduler pass re-arms the same job row — Appendix C's key
 * `mail-recover:{mailbox}:{generation}` has no instant in it, so there is exactly one
 * row per generation — and the hold stays on until the last page.
 *
 * **The hold clears on proof, not on success.** `completed_at` is written in the same
 * statement as the final watermark, and `releaseMailboxHold` re-reads the mailbox and
 * refuses unless it is `ready`. 4.2: "It clears only after complete coverage is
 * proven, never after one successful API call."
 */

/**
 * 12.3's "the oldest unresolved outbound message or active enrollment".
 *
 * Neither table exists in G7-1: `outbound_messages` is G7-2's and `enrollments` are
 * G8's. So the floor is a port with a default of "nothing older is outstanding",
 * which is the truth today — FSS has sent nothing and enrolled nobody — and becomes
 * a two-line query in each of those lanes without changing this file.
 */
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
  /** The interval's end. Now, unless a test pins it. */
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

  await enqueueJob(context.db, {
    workspaceId: context.scope.workspaceId,
    kind: 'mail.recover',
    payload: { mailboxId: input.mailbox.id, generation: input.mailbox.generation },
    idempotencyKey: jobIdempotencyKey.mailRecover(input.mailbox.id, input.mailbox.generation),
  });

  return toRecovery(created);
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
  if (mailbox.generation !== input.generation) {
    return recoveryReport(input.mailboxId, input.generation, 'generation_superseded');
  }
  if (mailbox.status !== 'connected') {
    await openMailboxHold(context, {
      mailboxId: mailbox.id,
      ownerUserId: mailbox.ownerUserId,
      reasonCode: 'mailbox_disconnected',
    });
    return recoveryReport(mailbox.id, input.generation, 'mailbox_inactive');
  }

  const recovery = await readRecovery(context, { mailboxId: mailbox.id, generation: input.generation });
  if (recovery === null) return recoveryReport(mailbox.id, input.generation, 'recovery_unknown');
  if (recovery.completedAt !== null) {
    return recoveryReport(mailbox.id, input.generation, 'already_complete', EMPTY_PIPELINE_REPORT, {
      fromAt: recovery.fromAt,
      toAt: recovery.toAt,
      pagesCompleted: recovery.pagesCompleted,
      coverageProved: true,
    });
  }

  const access = await accessForMailbox(context, deps, mailbox.id);
  if (!access.ok) {
    await holdForRevokedGrant(context, mailbox);
    return recoveryReport(mailbox.id, input.generation, 'grant_revoked');
  }

  // Appendix D: epoch seconds, never an ambiguous date string.
  const afterEpochSeconds = Math.floor(Date.parse(recovery.fromAt) / 1000);
  const beforeEpochSeconds = Math.ceil(Date.parse(recovery.toAt) / 1000);
  const pageSize = deps.pageSize ?? RECOVERY_PAGE_SIZE;
  const maxMessages = deps.maxMessages ?? pageSize;

  // Resume where the last run stopped. The page token is the page count, because the
  // interval is fixed: the same query over the same bounds returns the same order,
  // and Gmail's own page tokens do not survive a process.
  let pageToken: string | undefined = recovery.pagesCompleted === 0 ? undefined : String(recovery.pagesCompleted * pageSize);
  const ids: string[] = [];
  let pagesThisRun = 0;
  let exhausted = false;

  while (ids.length < maxMessages) {
    const outcome = await deps.gmail.listMessageIds(access.access, {
      afterEpochSeconds,
      beforeEpochSeconds,
      maxResults: pageSize,
      ...(pageToken === undefined ? {} : { pageToken }),
    });
    if (!outcome.ok) {
      if (outcome.reason === 'grant_revoked') {
        await holdForRevokedGrant(context, mailbox);
        return recoveryReport(mailbox.id, input.generation, 'grant_revoked');
      }
      await recordSyncError(context, { mailboxId: mailbox.id, error: 'the Gmail recovery listing was rate limited' });
      return recoveryReport(mailbox.id, input.generation, 'rate_limited');
    }
    ids.push(...outcome.messageIds);
    pagesThisRun += 1;
    if (outcome.nextPageToken === null) {
      exhausted = true;
      break;
    }
    pageToken = outcome.nextPageToken;
  }

  const pipeline = await processMessageIds(context, deps, {
    mailbox,
    access: access.access,
    messageIds: ids,
  });

  const pagesCompleted = recovery.pagesCompleted + pagesThisRun;
  await context.db.query(
    `UPDATE mailbox_recoveries
        SET pages_completed = $3,
            messages_seen = messages_seen + $4,
            completed_at = CASE WHEN $5 THEN now() ELSE completed_at END
      WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, recovery.id, pagesCompleted, pipeline.messagesSeen, exhausted],
  );

  if (!exhausted) {
    // Another pass is needed, and this run does not schedule it: the handler is
    // inside the runner's transaction and its own job row is still `running`, so it
    // cannot re-arm itself. `mailRecoverySource` finds every incomplete recovery on
    // the next one-minute pass and re-arms it there, which is also the only place an
    // operator can stop it.
    return recoveryReport(mailbox.id, input.generation, 'continued', pipeline, {
      fromAt: recovery.fromAt,
      toAt: recovery.toAt,
      pagesCompleted,
    });
  }

  // The whole interval is processed. Only now is coverage proved: the watermark moves
  // to the end of the interval, the mailbox becomes `ready`, and the hold may go.
  await setSyncState(context, {
    mailboxId: mailbox.id,
    syncState: 'ready',
    ...(recovery.reason === 'baseline' ? { baselineCompletedAt: new Date().toISOString() } : {}),
  });
  // A recovery re-establishes the cursor too: the mailbox's current history id is the
  // one every later `mail.sync` reads from, and it is unconditional here because the
  // recovery is the authority on this generation's coverage.
  const profile = await deps.gmail.getProfile(access.access);
  await advanceCursor(context, {
    mailboxId: mailbox.id,
    expectedHistoryId: mailbox.historyId,
    historyId: profile.historyId,
    coverageWatermarkAt: recovery.toAt,
    syncError: null,
  });
  await releaseMailboxHold(context, { mailboxId: mailbox.id, reasonCode: 'coverage_incomplete' });

  return recoveryReport(mailbox.id, input.generation, 'completed', pipeline, {
    fromAt: recovery.fromAt,
    toAt: recovery.toAt,
    pagesCompleted,
    coverageProved: true,
  });
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
