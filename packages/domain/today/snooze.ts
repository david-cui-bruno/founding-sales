import type { BlockedActionKind } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { databaseNow } from '../policy/clock.ts';
import { openHold } from '../policy/holds.ts';
import { readTodayItem } from './snapshots.ts';
import {
  acceptToday,
  refuseToday,
  type TodayItemKind,
  type TodayResult,
  type TodaySnoozeRow,
} from './types.ts';

/**
 * Snooze (specification 8.2, 4.3, 10.1).
 *
 * "Salespeople may snooze manual tasks with a required reason and explicit return
 * instant. Automated sends are not snoozed ad hoc; delaying them creates a recorded
 * hold."
 *
 * Two sentences, two different things, and this file is where they stay apart.
 *
 * A **manual** task is the salesperson's own work, and pushing it to Thursday changes
 * nothing about what FSS will do by itself. It becomes a `today_snoozes` row, which
 * outlives the snapshot: the 05:00 rebuild reads it and puts the task back asleep, so
 * a task snoozed on Tuesday for Thursday is not on Wednesday's list.
 *
 * An **automated** send is a thing FSS is about to do to a prospect, and delaying it
 * is a policy decision with a schedule consequence — section 4.3 shifts unexecuted
 * work by the union of the blocking intervals when the hold clears. A snooze row
 * cannot do that, and a snooze row that silently did not delay the send would be the
 * worst of the two. So the command opens an `active_holds` row against the firm for
 * the action kind the task belongs to, and the day's entry is closed: the send is not
 * happening today, and what brings it back is releasing the hold, not a clock.
 *
 * The hold is written directly rather than through `openPause`. An administrative
 * pause is an admin's configuration change scoped to a workspace, owner, mailbox,
 * opportunity or channel (10.1); this is one salesperson delaying one firm's automated
 * work, which is not any of those scopes and is not admin-only. See
 * `docs/decisions/g6-delaying-an-automated-send.md`.
 */

const BLOCKED_KIND_OF_ITEM: Readonly<Record<TodayItemKind, BlockedActionKind | null>> = Object.freeze({
  reply: null,
  callback: null,
  email_due: 'email_send',
  call_due: 'call_task',
  linkedin_due: 'linkedin_task',
  new_firm: null,
});

export const SNOOZE_REASON_MAX = 300;

interface SnoozeDbRow {
  readonly id: string;
  readonly firm_id: string;
  readonly contact_id: string | null;
  readonly item_key: string;
  readonly reason: string;
  readonly return_at: Date;
  readonly created_by_user_id: string;
  readonly created_at: Date;
  readonly cancelled_at: Date | null;
  readonly [column: string]: unknown;
}

const SNOOZE_COLUMNS =
  'id, firm_id, contact_id, item_key, reason, return_at, created_by_user_id, created_at, cancelled_at';

function toSnooze(row: SnoozeDbRow): TodaySnoozeRow {
  return {
    id: row.id,
    firmId: row.firm_id,
    contactId: row.contact_id,
    itemKey: row.item_key,
    reason: row.reason,
    returnAt: row.return_at.toISOString(),
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at.toISOString(),
    cancelledAt: row.cancelled_at === null ? null : row.cancelled_at.toISOString(),
  };
}

export type SnoozeOutcome =
  | { readonly outcome: 'snoozed'; readonly snooze: TodaySnoozeRow }
  /** An automated send. Not snoozed: held, with the hold that blocks it (4.3). */
  | { readonly outcome: 'held'; readonly holdId: string; readonly blockedActionKind: BlockedActionKind };

export interface SnoozeTodayItemInput {
  readonly itemId: string;
  readonly reason: string;
  /** The explicit instant the task comes back. 8.2 requires one; there is no default. */
  readonly returnAt: string;
}

export async function snoozeTodayItem(
  context: RepositoryContext,
  input: SnoozeTodayItemInput,
): Promise<TodayResult<SnoozeOutcome>> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refuseToday('invalid_input');

  const reason = input.reason.trim();
  if (reason.length === 0) return refuseToday('snooze_reason_required');
  if (reason.length > SNOOZE_REASON_MAX) return refuseToday('invalid_input');
  if (!Number.isFinite(Date.parse(input.returnAt))) return refuseToday('invalid_input');

  const item = await readTodayItem(context, input.itemId);
  if (item === null) return refuseToday('item_unknown');
  if (item.status !== 'open') return refuseToday('item_not_open');

  // Database time, never the caller's clock: the return instant is compared with the
  // same clock every other deadline in the system is (docs/decisions/g4-database-time-is-a-parameter.md).
  const now = await databaseNow(context);
  if (Date.parse(input.returnAt) <= Date.parse(now)) return refuseToday('snooze_return_not_future');

  if (item.automated) {
    const blocked = BLOCKED_KIND_OF_ITEM[item.kind];
    // An automated task that blocks no action kind is not a shape the database allows
    // (`today_items_automated_is_due_work`); refusing rather than guessing one.
    if (blocked === null) return refuseToday('invalid_input');

    const holdId = await openHold(context, {
      scopeKind: 'firm',
      scopeKey: item.firmId,
      reasonCode: 'scoped_pause',
      blockedActionKinds: [blocked],
      sourceEventKind: 'today.delay_requested',
      sourceEventId: item.id,
      recoveryAction: 'release_pause',
    });

    // The day's entry is over: the send is not happening today, and what brings the
    // work back is the hold being released, not the instant that was asked for.
    await context.db.query(
      `UPDATE today_items
          SET status = 'cancelled', snooze_until = NULL, updated_at = greatest(now(), created_at)
        WHERE workspace_id = $1 AND id = $2 AND status = 'open'`,
      [context.scope.workspaceId, item.id],
    );

    await recordCrmAuditEvent(context, {
      action: 'today.automated_delayed',
      subjectKind: 'today_item',
      subjectId: item.id,
      detail: { firmId: item.firmId, holdId, reason, requestedReturnAt: input.returnAt, blockedActionKind: blocked },
    });
    return acceptToday({ outcome: 'held', holdId, blockedActionKind: blocked });
  }

  const { rows } = await context.db.query<SnoozeDbRow>(
    `INSERT INTO today_snoozes
       (workspace_id, firm_id, contact_id, item_key, reason, return_at, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7)
     RETURNING ${SNOOZE_COLUMNS}`,
    [
      context.scope.workspaceId,
      item.firmId,
      item.contactId,
      item.itemKey,
      reason,
      input.returnAt,
      actor.userId,
    ],
  );
  const row = rows[0];
  if (row === undefined) return refuseToday('invalid_input');

  await context.db.query(
    `UPDATE today_items
        SET status = 'snoozed', snooze_until = $3::timestamptz, updated_at = greatest(now(), created_at)
      WHERE workspace_id = $1 AND id = $2 AND status = 'open'`,
    [context.scope.workspaceId, item.id, input.returnAt],
  );

  await recordCrmAuditEvent(context, {
    action: 'today.snoozed',
    subjectKind: 'today_item',
    subjectId: item.id,
    detail: { firmId: item.firmId, itemKey: item.itemKey, returnAt: input.returnAt, reason },
  });
  return acceptToday({ outcome: 'snoozed', snooze: toSnooze(row) });
}

/** Cancel a snooze and put its task back on today's list. */
export async function cancelTodaySnooze(
  context: RepositoryContext,
  input: { readonly snoozeId: string },
): Promise<TodayResult<TodaySnoozeRow>> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refuseToday('invalid_input');

  const { rows } = await context.db.query<SnoozeDbRow>(
    `UPDATE today_snoozes
        SET cancelled_at = now(), cancelled_by_user_id = $3
      WHERE workspace_id = $1 AND id = $2 AND cancelled_at IS NULL
      RETURNING ${SNOOZE_COLUMNS}`,
    [context.scope.workspaceId, input.snoozeId, actor.userId],
  );
  const row = rows[0];
  if (row === undefined) {
    const existing = await context.db.query('SELECT 1 FROM today_snoozes WHERE workspace_id = $1 AND id = $2', [
      context.scope.workspaceId,
      input.snoozeId,
    ]);
    return refuseToday(existing.rows.length === 0 ? 'snooze_unknown' : 'snooze_already_cancelled');
  }

  await context.db.query(
    `UPDATE today_items
        SET status = 'open', snooze_until = NULL, updated_at = greatest(now(), created_at)
      WHERE workspace_id = $1 AND firm_id = $2 AND item_key = $3 AND status = 'snoozed'`,
    [context.scope.workspaceId, row.firm_id, row.item_key],
  );

  await recordCrmAuditEvent(context, {
    action: 'today.snooze_cancelled',
    subjectKind: 'today_snooze',
    subjectId: row.id,
    detail: { firmId: row.firm_id, itemKey: row.item_key },
  });
  return acceptToday(toSnooze(row));
}

/** The active snoozes, for the firm page and for the list's expanded card. */
export async function listActiveSnoozes(
  context: RepositoryContext,
  options: { readonly firmId?: string | undefined } = {},
): Promise<readonly TodaySnoozeRow[]> {
  const { rows } = await context.db.query<SnoozeDbRow>(
    `SELECT ${SNOOZE_COLUMNS} FROM today_snoozes
      WHERE workspace_id = $1 AND cancelled_at IS NULL AND ($2::uuid IS NULL OR firm_id = $2::uuid)
      ORDER BY return_at, id`,
    [context.scope.workspaceId, options.firmId ?? null],
  );
  return rows.map(toSnooze);
}
