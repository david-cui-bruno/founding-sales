import type { BlockedActionKind } from '@fss/contracts';
import type { Queryable } from '../db/queryable.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordHeartbeat } from '../jobs/heartbeats.ts';
import { listApplicableHolds, openHold, releaseHoldsOfEvent } from '../policy/holds.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import type { MailboxRow, MailboxStatus, MailboxSyncState } from './types.ts';

/**
 * `mailboxes`: the row, its cursor, its coverage, and the holds that follow from both
 * (specification 12.1, 12.3, 12.6, 4.2).
 *
 * Three ideas do all the work here.
 *
 * **The cursor moves by compare-and-set, never by assignment.** `advanceCursor`
 * updates only when the stored history id is still the one the caller read, so two
 * `mail.sync` runs that overlap cannot write each other's progress. The loser is told
 * `cursor_moved` and stops, which is correct: the winner has already processed at
 * least as much.
 *
 * **The watermark is a claim about coverage and moves with the cursor or not at all.**
 * 12.3: "the instant through which every relevant message is known processed". It is
 * written in the same statement as the cursor, so there is no instant at which the
 * database says a mailbox is covered further than it has read.
 *
 * **Every automated step kind is held while coverage is unproved.** 12.6: "While a
 * mailbox grant is revoked or coverage unhealthy, every automated step kind for that
 * owner is held." The hold is owner-scoped rather than mailbox-scoped, because the
 * sentence says "for that owner" and because a step's eligibility check knows which
 * salesperson owns the firm long before it knows which mailbox would send.
 */

/** 12.6: "every automated step kind for that owner". Research is not a step kind. */
export const MAILBOX_HOLD_BLOCKS: readonly BlockedActionKind[] = Object.freeze([
  'email_send',
  'call_task',
  'enrollment_advance',
]);

const MAILBOX_COLUMNS = `id, owner_user_id, email_address, provider_account_id, status, generation,
  sync_state, history_id, coverage_watermark_at, baseline_from_at, baseline_completed_at,
  last_synced_at, last_sync_error`;

interface MailboxDbRow {
  readonly id: string;
  readonly owner_user_id: string;
  readonly email_address: string;
  readonly provider_account_id: string | null;
  readonly status: MailboxStatus;
  readonly generation: number;
  readonly sync_state: MailboxSyncState;
  readonly history_id: string | null;
  readonly coverage_watermark_at: Date | null;
  readonly baseline_from_at: Date | null;
  readonly baseline_completed_at: Date | null;
  readonly last_synced_at: Date | null;
  readonly last_sync_error: string | null;
  readonly [column: string]: unknown;
}

function toMailbox(row: MailboxDbRow): MailboxRow {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    emailAddress: row.email_address,
    providerAccountId: row.provider_account_id,
    status: row.status,
    generation: row.generation,
    syncState: row.sync_state,
    historyId: row.history_id,
    coverageWatermarkAt: row.coverage_watermark_at?.toISOString() ?? null,
    baselineFromAt: row.baseline_from_at?.toISOString() ?? null,
    baselineCompletedAt: row.baseline_completed_at?.toISOString() ?? null,
    lastSyncedAt: row.last_synced_at?.toISOString() ?? null,
    lastSyncError: row.last_sync_error,
  };
}

export async function readMailbox(context: RepositoryContext, mailboxId: string): Promise<MailboxRow | null> {
  const { rows } = await context.db.query<MailboxDbRow>(
    `SELECT ${MAILBOX_COLUMNS} FROM mailboxes WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, mailboxId],
  );
  const row = rows[0];
  return row === undefined ? null : toMailbox(row);
}

/** The mailbox to lock before changing it. One per owner, so the owner is the key. */
export async function readMailboxForUpdate(
  context: RepositoryContext,
  mailboxId: string,
): Promise<MailboxRow | null> {
  const { rows } = await context.db.query<MailboxDbRow>(
    `SELECT ${MAILBOX_COLUMNS} FROM mailboxes WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [context.scope.workspaceId, mailboxId],
  );
  const row = rows[0];
  return row === undefined ? null : toMailbox(row);
}

export async function readMailboxForOwner(
  context: RepositoryContext,
  ownerUserId: string,
): Promise<MailboxRow | null> {
  const { rows } = await context.db.query<MailboxDbRow>(
    `SELECT ${MAILBOX_COLUMNS} FROM mailboxes WHERE workspace_id = $1 AND owner_user_id = $2`,
    [context.scope.workspaceId, ownerUserId],
  );
  const row = rows[0];
  return row === undefined ? null : toMailbox(row);
}

export async function listConnectedMailboxes(context: RepositoryContext): Promise<readonly MailboxRow[]> {
  const { rows } = await context.db.query<MailboxDbRow>(
    `SELECT ${MAILBOX_COLUMNS} FROM mailboxes
      WHERE workspace_id = $1 AND status = 'connected' ORDER BY email_address`,
    [context.scope.workspaceId],
  );
  return rows.map(toMailbox);
}

/**
 * 13.3's mailbox check: one per connected mailbox per minute, and the interval its
 * heartbeat promises.
 *
 * 12.3 is "one-minute reconciliation repairs delayed or dropped notifications", and
 * 13.3 alarms on "three missed one-minute mailbox checks". So the check is the
 * scheduler pass itself: every pass asks for one `mail.sync` of
 * every connected, `ready` mailbox, whether or not a push synced it a moment ago, and
 * the coalescing upsert makes the ask a no-op while a check is already queued or
 * running. A check with nothing new is one token refresh and one `history.list` from
 * the stored cursor (two Gmail quota units): 1,440 a day per mailbox, two units a minute
 * against Gmail's per-user limit of 15,000 a minute. `docs/greenfield/mail.md` has the
 * numbers.
 *
 * The scheduler's pass interval (`SCHEDULER_PASS_INTERVAL_MILLISECONDS`, 13.1's "once
 * per minute") and this constant are one number, and
 * `test/release/mailboxHeartbeatCadence.check.ts` fails if they, the heartbeat this
 * writes and the alarm's period ever disagree.
 */
export const MAILBOX_CHECK_INTERVAL_SECONDS = 60;

export interface MailboxDueRow {
  readonly workspaceId: string;
  readonly mailboxId: string;
  readonly generation: number;
  readonly historyId: string | null;
}

/**
 * Every connected mailbox the reconciliation sweep checks on this pass, across every
 * workspace: all of the `ready` ones, every pass.
 *
 * There is deliberately no "synced recently" filter. A filter on `last_synced_at` is
 * what made the check a five-minute one, and any threshold at all couples the check to
 * the push traffic: a push-driven sync ten seconds before a pass would make the pass
 * skip the mailbox and stretch the gap to seventy seconds. Coalescing already makes a
 * second ask for a queued or running sync free.
 *
 * Unscoped, and deliberately: the scheduler pass runs once for the deployment, not
 * once per workspace, and it holds an advisory lock while it does. The workspace id
 * comes back on each row so the job it inserts is scoped correctly.
 *
 * A mailbox that is `baseline_pending` or `recovering` is skipped. Both are already
 * covered by `mail.recover` and its own re-arm source, which re-arms every pass and
 * records the same heartbeat, and a `mail.sync` against a mailbox with no proven
 * baseline would only re-open the recovery it is already in.
 */
export async function listMailboxesDueForSync(db: Queryable): Promise<readonly MailboxDueRow[]> {
  const { rows } = await db.query<{ workspace_id: string; id: string; generation: number; history_id: string | null }>(
    `SELECT workspace_id, id, generation, history_id
       FROM mailboxes
      WHERE status = 'connected'
        AND sync_state = 'ready'
      ORDER BY id`,
  );
  return rows.map(row => ({
    workspaceId: row.workspace_id,
    mailboxId: row.id,
    generation: row.generation,
    historyId: row.history_id,
  }));
}

export interface InsertMailboxInput {
  readonly ownerUserId: string;
  readonly emailAddress: string;
  readonly providerAccountId: string;
  /** 12.3: the bounded baseline's earliest instant. */
  readonly baselineFromAt: string;
}

/**
 * Create the mailbox, or take the existing one for this owner.
 *
 * A re-consent is the common case and it is not a second mailbox: the row is taken
 * out of whatever disconnected state it was in, its generation advances — so a watch
 * or a recovery that was in flight for the old generation can no longer write — and
 * its sync state goes back to `baseline_pending`, because a mailbox that has been
 * away has no coverage it can prove.
 */
export async function insertOrReviveMailbox(
  context: RepositoryContext,
  input: InsertMailboxInput,
): Promise<MailboxRow> {
  const { rows } = await context.db.query<MailboxDbRow>(
    `INSERT INTO mailboxes (workspace_id, owner_user_id, email_address, provider_account_id,
                            status, sync_state, baseline_from_at)
     VALUES ($1, $2, $3, $4, 'connected', 'baseline_pending', $5)
     ON CONFLICT (workspace_id, owner_user_id)
     DO UPDATE SET email_address = EXCLUDED.email_address,
                   provider_account_id = EXCLUDED.provider_account_id,
                   status = 'connected',
                   disconnected_at = NULL,
                   disconnect_reason = NULL,
                   generation = mailboxes.generation + 1,
                   sync_state = 'baseline_pending',
                   baseline_from_at = EXCLUDED.baseline_from_at,
                   baseline_completed_at = NULL,
                   connected_at = now(),
                   updated_at = now()
     RETURNING ${MAILBOX_COLUMNS}`,
    [
      context.scope.workspaceId,
      input.ownerUserId,
      input.emailAddress.trim().toLowerCase(),
      input.providerAccountId,
      input.baselineFromAt,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('a mailbox insert returned no row');
  return toMailbox(row);
}

export async function markMailboxDisconnected(
  context: RepositoryContext,
  input: { readonly mailboxId: string; readonly status: 'disconnected' | 'revoked'; readonly reason: string },
): Promise<void> {
  await context.db.query(
    `UPDATE mailboxes
        SET status = $3,
            disconnected_at = now(),
            disconnect_reason = $4,
            sync_state = 'baseline_pending',
            baseline_completed_at = NULL,
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND status = 'connected'`,
    [context.scope.workspaceId, input.mailboxId, input.status, input.reason.slice(0, 200)],
  );
}

/**
 * A job read the mailbox at one generation and address, and the row no longer says so
 * when the job came to write (generation fencing, `docs/greenfield/mail.md`).
 *
 * Thrown, never returned: the runner rolls the whole job transaction back — message
 * effects included — and records the failure as `stale_mailbox_generation` (the
 * runner's code is the error's name). The retry re-reads the mailbox and acts for the
 * generation it finds, which is harmless by construction: a sync of a mailbox that is
 * not `ready` is a no-op, a recovery for a superseded generation answers
 * `generation_superseded`, and a watch renewal registers the current account's watch.
 */
export class StaleMailboxGeneration extends Error {
  override readonly name = 'StaleMailboxGeneration';
  constructor(
    readonly mailboxId: string,
    readonly write: string,
    readonly expected: MailboxFence,
  ) {
    super(`the mailbox changed generation or address before the job's ${write} could commit`);
  }
}

/** What a job read at its start and every write it makes is predicated on. */
export interface MailboxFence {
  readonly generation: number;
  readonly emailAddress: string;
}

export const fenceOf = (mailbox: MailboxRow): MailboxFence => ({
  generation: mailbox.generation,
  emailAddress: mailbox.emailAddress,
});

/**
 * Lock the mailbox row and refuse unless it still has the generation and address the
 * job read at its start. The lock holds until the job commits, so nothing can move the
 * generation between this check and the writes after it.
 */
export async function lockMailboxAtFence(
  context: RepositoryContext,
  input: { readonly mailboxId: string; readonly fence: MailboxFence; readonly write: string },
): Promise<MailboxRow> {
  // `FOR NO KEY UPDATE`, not `FOR UPDATE` (fold 2, from the A2 review): every
  // `mail_messages` insert takes an implicit KEY SHARE on its mailbox row, and a job
  // that has inserted messages and then waits for the send gate would deadlock with a
  // job that holds the gate and asks for `FOR UPDATE` here. NO KEY UPDATE does not
  // conflict with KEY SHARE, and it still conflicts with itself and with every UPDATE of
  // the row — a generation bump included — so the fence is held just as firmly. The
  // writes after it change only non-key columns.
  const { rows } = await context.db.query<MailboxDbRow>(
    `SELECT ${MAILBOX_COLUMNS} FROM mailboxes WHERE workspace_id = $1 AND id = $2 FOR NO KEY UPDATE`,
    [context.scope.workspaceId, input.mailboxId],
  );
  const found = rows[0];
  const mailbox = found === undefined ? null : toMailbox(found);
  if (
    mailbox === null ||
    mailbox.generation !== input.fence.generation ||
    mailbox.emailAddress !== input.fence.emailAddress
  ) {
    throw new StaleMailboxGeneration(input.mailboxId, input.write, input.fence);
  }
  return mailbox;
}

/**
 * The lock order for a job's refusal path that writes a stop fact — a revoked grant, a
 * disconnected hold, a coverage hold (fold 2): the send gate EXCLUSIVE first, because
 * `openHold` takes it and a claim takes it before any row, then the mailbox row at the
 * job's fence, held to commit. Never the row and then the gate.
 */
export async function lockForFencedStopFact(
  context: RepositoryContext,
  input: { readonly mailboxId: string; readonly fence: MailboxFence; readonly write: string },
): Promise<MailboxRow> {
  await lockSendGateForStopFact(context);
  return await lockMailboxAtFence(context, input);
}

/**
 * Forget everything the mailbox knows about the account it was reading: the history
 * cursor, its instant, the coverage watermark and the last sync's outcome, in one
 * statement, so `mailboxes_history_cursor_consistent` and
 * `mailboxes_coverage_needs_cursor` hold on either side of it.
 *
 * The caller must hold the mailbox row lock in the same transaction (`FOR NO KEY
 * UPDATE` is enough, and is what the fenced paths take: the columns are non-key), and is the one that advances the generation and starts the new
 * baseline: this is the account-switch half that only clears.
 */
export async function resetAccountState(
  context: RepositoryContext,
  input: { readonly mailboxId: string },
): Promise<void> {
  const { rowCount } = await context.db.query(
    `UPDATE mailboxes
        SET history_id = NULL,
            history_id_updated_at = NULL,
            coverage_watermark_at = NULL,
            last_sync_error = NULL,
            last_synced_at = NULL,
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, input.mailboxId],
  );
  if ((rowCount ?? 0) === 0) throw new Error('an account-state reset found no mailbox');
}

export type CursorOutcome =
  | { readonly advanced: true; readonly historyId: string; readonly coverageWatermarkAt: string | null }
  | { readonly advanced: false; readonly reason: 'cursor_moved' };

/**
 * Move the cursor, and the watermark with it, if and only if the cursor is still
 * where the caller left it (12.3, Appendix A "Mail-sync page": "cursor CAS").
 *
 * `IS NOT DISTINCT FROM` rather than `=`, because the first advance of a newly
 * connected mailbox compares against NULL, and `NULL = NULL` is not true.
 */
export async function advanceCursor(
  context: RepositoryContext,
  input: {
    readonly mailboxId: string;
    /**
     * The generation and address the job read at its start. A cursor that is still
     * where the caller left it on a mailbox that has since moved on — an account switch,
     * a new baseline — is not the caller's to move: that throws
     * `StaleMailboxGeneration` rather than answering `cursor_moved`, so the job's
     * message effects roll back with it.
     */
    readonly fence: MailboxFence;
    readonly expectedHistoryId: string | null;
    readonly historyId: string;
    readonly coverageWatermarkAt?: string | undefined;
    readonly syncError?: string | null | undefined;
  },
): Promise<CursorOutcome> {
  const { rows } = await context.db.query<{ history_id: string; coverage_watermark_at: Date | null }>(
    `UPDATE mailboxes
        SET history_id = $4,
            history_id_updated_at = now(),
            coverage_watermark_at = COALESCE($5::timestamptz, coverage_watermark_at),
            last_synced_at = now(),
            last_sync_error = $6,
            updated_at = now()
      WHERE workspace_id = $1
        AND id = $2
        AND history_id IS NOT DISTINCT FROM $3
        AND generation = $7
        AND email_address = $8
      RETURNING history_id, coverage_watermark_at`,
    [
      context.scope.workspaceId,
      input.mailboxId,
      input.expectedHistoryId,
      input.historyId,
      input.coverageWatermarkAt ?? null,
      input.syncError ?? null,
      input.fence.generation,
      input.fence.emailAddress,
    ],
  );
  const row = rows[0];
  if (row === undefined) {
    // Which predicate failed decides the answer, and the answer must hold to commit
    // (fold 3): an UPDATE that matched nothing locked nothing, so a plain read here could
    // see generation g and a switch commit g+1 before this job commits its messages. The
    // fenced lock throws on a mismatch and otherwise holds the row at g to commit.
    await lockMailboxAtFence(context, { mailboxId: input.mailboxId, fence: input.fence, write: 'cursor compare-and-set' });
    return { advanced: false, reason: 'cursor_moved' };
  }
  return {
    advanced: true,
    historyId: row.history_id,
    coverageWatermarkAt: row.coverage_watermark_at?.toISOString() ?? null,
  };
}

/** Record a sync failure without pretending the cursor moved. */
export async function recordSyncError(
  context: RepositoryContext,
  input: {
    readonly mailboxId: string;
    readonly error: string;
    /**
     * The generation and address the job read at its start (fold 2). With it, the row is
     * locked at that fence first, and a mailbox that has moved on throws
     * `StaleMailboxGeneration` instead of taking an older account's error.
     */
    readonly fence?: MailboxFence | undefined;
  },
): Promise<void> {
  if (input.fence !== undefined) {
    await lockMailboxAtFence(context, { mailboxId: input.mailboxId, fence: input.fence, write: 'sync error' });
  }
  await context.db.query(
    `UPDATE mailboxes SET last_sync_error = $3, last_synced_at = now(), updated_at = now()
      WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, input.mailboxId, input.error.slice(0, 500)],
  );
}

export async function setSyncState(
  context: RepositoryContext,
  input: {
    readonly mailboxId: string;
    readonly syncState: MailboxSyncState;
    readonly baselineCompletedAt?: string | undefined;
  },
): Promise<void> {
  await context.db.query(
    `UPDATE mailboxes
        SET sync_state = $3,
            baseline_completed_at = COALESCE($4::timestamptz, baseline_completed_at),
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, input.mailboxId, input.syncState, input.baselineCompletedAt ?? null],
  );
}

/**
 * Advance the generation. A watch or recovery for an older one can no longer write.
 *
 * With a fence, only from the generation and address the caller read: a job that
 * decided to start a recovery for generation g must not start one for whatever the
 * mailbox became while it was deciding.
 */
export async function advanceGeneration(
  context: RepositoryContext,
  mailboxId: string,
  fence?: MailboxFence,
): Promise<number> {
  const { rows } = await context.db.query<{ generation: number }>(
    `UPDATE mailboxes SET generation = generation + 1, updated_at = now()
      WHERE workspace_id = $1 AND id = $2
        AND ($3::integer IS NULL OR generation = $3)
        AND ($4::text IS NULL OR email_address = $4)
      RETURNING generation`,
    [context.scope.workspaceId, mailboxId, fence?.generation ?? null, fence?.emailAddress ?? null],
  );
  const generation = rows[0]?.generation;
  if (generation === undefined) {
    if (fence !== undefined) throw new StaleMailboxGeneration(mailboxId, 'generation advance', fence);
    throw new Error('a generation advance found no mailbox');
  }
  return generation;
}

/**
 * The hold that blocks every automated step kind for a mailbox's owner.
 *
 * `sourceEventId` is the mailbox id, so `releaseMailboxHold` releases exactly the
 * holds this mailbox opened for this reason and nothing else — which is section
 * 4.3's "clearing one hold never clears another" and the reason the policy lane's
 * release takes an event rather than a scope.
 */
export async function openMailboxHold(
  context: RepositoryContext,
  input: {
    readonly mailboxId: string;
    readonly ownerUserId: string;
    readonly reasonCode: 'mailbox_disconnected' | 'coverage_incomplete';
  },
): Promise<string | null> {
  const existing = await readMailboxHold(context, input.mailboxId, input.reasonCode);
  if (existing !== null) return existing;
  return await openHold(context, {
    scopeKind: 'owner',
    scopeKey: input.ownerUserId,
    reasonCode: input.reasonCode,
    blockedActionKinds: MAILBOX_HOLD_BLOCKS,
    sourceEventKind: 'mailbox',
    sourceEventId: input.mailboxId,
    ownerUserId: input.ownerUserId,
    recoveryAction: 'reconnect_mailbox',
  });
}

export async function readMailboxHold(
  context: RepositoryContext,
  mailboxId: string,
  reasonCode: 'mailbox_disconnected' | 'coverage_incomplete',
): Promise<string | null> {
  const { rows } = await context.db.query<{ id: string }>(
    `SELECT id FROM active_holds
      WHERE workspace_id = $1 AND source_event_kind = 'mailbox' AND source_event_id = $2
        AND reason_code = $3 AND released_at IS NULL
      LIMIT 1`,
    [context.scope.workspaceId, mailboxId, reasonCode],
  );
  return rows[0]?.id ?? null;
}

/**
 * Release a mailbox hold — but only on proof.
 *
 * 4.2: the coverage hold "clears only after complete coverage is proven, never after
 * one successful API call". So the caller passes what it proved, and this refuses to
 * release a `coverage_incomplete` hold for a mailbox whose sync state is not `ready`.
 * The check is a read of the row inside the same transaction rather than a parameter,
 * because a caller that could pass `proven: true` would eventually pass it wrongly.
 */
export async function releaseMailboxHold(
  context: RepositoryContext,
  input: {
    readonly mailboxId: string;
    readonly reasonCode: 'mailbox_disconnected' | 'coverage_incomplete';
  },
): Promise<readonly string[]> {
  const mailbox = await readMailbox(context, input.mailboxId);
  if (mailbox === null) return [];
  if (mailbox.status !== 'connected') return [];
  if (input.reasonCode === 'coverage_incomplete' && mailbox.syncState !== 'ready') return [];
  const released = await releaseHoldsOfEvent(context, {
    sourceEventId: input.mailboxId,
    reasonCode: input.reasonCode,
  });
  return released.map(hold => hold.id);
}

/** Whether anything at all blocks this owner's automated work right now. */
export async function mailboxAutomationBlocked(
  context: RepositoryContext,
  input: { readonly ownerUserId: string; readonly actionKind: BlockedActionKind },
): Promise<boolean> {
  const holds = await listApplicableHolds(context, {
    actionKind: input.actionKind,
    ownerUserId: input.ownerUserId,
  });
  return holds.length > 0;
}

/**
 * The per-mailbox heartbeat of 13.3.
 *
 * The instance key is the mailbox id, so the alarm's "three missed one-minute
 * mailbox checks" is per mailbox and an operator can see which one went quiet.
 *
 * The interval is written explicitly rather than left to the heartbeat default: it is
 * a promise about the check cadence above, and the release check reads it from here.
 */
export async function recordMailboxHeartbeat(
  db: Queryable,
  input: { readonly workspaceId: string; readonly mailboxId: string; readonly detail?: Readonly<Record<string, unknown>> | undefined },
): Promise<void> {
  await recordHeartbeat(db, {
    component: 'mailbox',
    workspaceId: input.workspaceId,
    instanceKey: input.mailboxId,
    expectedIntervalSeconds: MAILBOX_CHECK_INTERVAL_SECONDS,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
  });
}
