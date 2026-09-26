import type { BlockedActionKind } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { decideFirmMutation } from '../crm/authorization.ts';
import { loadFirmForUpdate } from '../crm/firms.ts';
import { databaseNow } from '../policy/clock.ts';
import { openHold, releaseHold } from '../policy/holds.ts';
import { resumeEnrollment } from '../sequences/resume.ts';
import { readTodayItem } from './snapshots.ts';
import {
  TODAY_PAUSE_SOURCE_EVENT_KIND,
  acceptToday,
  refuseToday,
  type TodayItemRow,
  type TodayResult,
  type TodaySnoozeRow,
} from './types.ts';
import type { TodayItemKind } from '@fss/contracts';

/**
 * Snooze (specification 8.2, 4.3, 10.1).
 *
 * "Salespeople may snooze manual tasks with a required reason and explicit return
 * instant. Automated sends are not snoozed ad hoc; delaying them creates a recorded
 * hold." The reason is optional since wave 2 (S4.7): none is stored as "snoozed".
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
 * worst of the two. So the command opens an `active_holds` row for the action kind the
 * task belongs to.
 *
 * ## A pause, not a timed snooze (audit item C22)
 *
 * G6 opened that hold against the whole firm, closed the day's task, and kept the
 * return instant the person typed only as audit metadata: a "snooze until Thursday"
 * became an indefinite firm-wide pause with nothing on screen to lift it. The hold
 * model has no scheduled release — `active_holds.released_at` is when a hold *was*
 * released — and releasing on a timer would shift the schedule by an interval nobody
 * reviewed (the reason G6 gave, and still true). So the action is named what it is, a
 * **pause**, and it is made visible and reversible instead of timed:
 *
 *  * the hold is scoped to the task's own **enrollment** when the task is a sequence
 *    step (the firm only for a task with no enrollment behind it), so pausing one
 *    contact's email does not silence the firm;
 *  * the task stays **open** on Today, and the expanded card carries the hold's id on
 *    it (`pauseHoldId`) so the Mac shows "Paused" and a Resume control where the
 *    Pause control was, tomorrow as well as today;
 *  * `releaseTodayPause` is that control: it releases exactly this hold and asks the
 *    enrollment to resume, which shifts unexecuted work by the union of its blocking
 *    intervals or sends a long hold to review (4.3);
 *  * a return instant is no longer required for it. One sent by an older Mac is
 *    recorded in the audit event, as before, and acts on nothing.
 *
 * The hold is written directly rather than through `openPause`. An administrative
 * pause is an admin's configuration change scoped to a workspace, owner, mailbox,
 * opportunity or channel (10.1); this is one salesperson pausing one contact's
 * automated work, which is not admin-only. See
 * `docs/decisions/g6-delaying-an-automated-send.md` and
 * `docs/decisions/g79-calls-carry-their-authorization.md`.
 */

const BLOCKED_KIND_OF_ITEM: Readonly<Record<TodayItemKind, BlockedActionKind | null>> = Object.freeze({
  reply: null,
  callback: null,
  email_due: 'email_send',
  call_due: 'call_task',
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
  /**
   * An automated send. Not snoozed: paused, with the hold that blocks it (4.3). The
   * wire word stays `held`, which every Mac already parses; the Mac says "Paused".
   */
  | {
      readonly outcome: 'held';
      readonly holdId: string;
      readonly blockedActionKind: BlockedActionKind;
      readonly scope: 'enrollment' | 'firm';
    };

/**
 * The reason a snooze stores when the person gave none (wave 2, S4.7): the non-empty
 * placeholder `today_snoozes_reason_present` (0008) requires until migration 0019.
 */
export const DEFAULT_SNOOZE_REASON = 'snoozed';

export interface SnoozeTodayItemInput {
  readonly itemId: string;
  /** Optional since wave 2 (S4.7): blank or absent is `DEFAULT_SNOOZE_REASON`. */
  readonly reason?: string | undefined;
  /**
   * The explicit instant a manual task comes back; 8.2 requires one and there is no
   * default. Not required for an automated task, which is paused until released.
   */
  readonly returnAt?: string | undefined;
}

/** Where a pause of this task applies: its own enrollment, or the firm when it has none. */
async function pauseScopeOf(
  context: RepositoryContext,
  item: TodayItemRow,
): Promise<{ readonly scopeKind: 'enrollment' | 'firm'; readonly scopeKey: string }> {
  if (item.sourceKind === 'step_execution' && item.sourceId !== null) {
    const { rows } = await context.db.query<{ enrollment_id: string }>(
      'SELECT enrollment_id FROM step_executions WHERE workspace_id = $1 AND id = $2 AND firm_id = $3',
      [context.scope.workspaceId, item.sourceId, item.firmId],
    );
    const enrollmentId = rows[0]?.enrollment_id;
    if (enrollmentId !== undefined) return { scopeKind: 'enrollment', scopeKey: enrollmentId };
  }
  return { scopeKind: 'firm', scopeKey: item.firmId };
}

export async function snoozeTodayItem(
  context: RepositoryContext,
  input: SnoozeTodayItemInput,
): Promise<TodayResult<SnoozeOutcome>> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refuseToday('invalid_input');

  const reason = input.reason?.trim() || DEFAULT_SNOOZE_REASON;
  if (reason.length > SNOOZE_REASON_MAX) return refuseToday('invalid_input');
  if (input.returnAt !== undefined && !Number.isFinite(Date.parse(input.returnAt))) {
    return refuseToday('invalid_input');
  }

  const item = await readTodayItem(context, input.itemId);
  if (item === null) return refuseToday('item_unknown');
  // A colleague's task is a mutation of a colleague's firm (Appendix G 7); the same
  // answer as an unknown one, for the reason the card read gives.
  const firm = await loadFirmForUpdate(context, item.firmId);
  if (firm === null) return refuseToday('item_unknown');
  const permitted = decideFirmMutation(context, firm);
  if (!permitted.permitted) return refuseToday(permitted.reason === 'not_assigned' ? 'not_assigned' : 'item_unknown');
  if (item.status !== 'open') return refuseToday('item_not_open');

  if (item.automated) {
    const blocked = BLOCKED_KIND_OF_ITEM[item.kind];
    // An automated task that blocks no action kind is not a shape the database allows
    // (`today_items_automated_is_due_work`); refusing rather than guessing one.
    if (blocked === null) return refuseToday('invalid_input');

    const scope = await pauseScopeOf(context, item);
    // One pause per task: pressing Pause on a task that is already paused answers with
    // the hold that is already there rather than stacking a second one to release.
    const { rows: existing } = await context.db.query<{ id: string }>(
      `SELECT id FROM active_holds
        WHERE workspace_id = $1 AND released_at IS NULL AND source_event_kind = $2
          AND scope_kind = $3 AND scope_key = $4 AND $5 = ANY (blocked_action_kinds)
        ORDER BY started_at, id
        LIMIT 1`,
      [context.scope.workspaceId, TODAY_PAUSE_SOURCE_EVENT_KIND, scope.scopeKind, scope.scopeKey, blocked],
    );
    const already = existing[0]?.id;
    if (already !== undefined) {
      return acceptToday({ outcome: 'held', holdId: already, blockedActionKind: blocked, scope: scope.scopeKind });
    }

    const holdId = await openHold(context, {
      scopeKind: scope.scopeKind,
      scopeKey: scope.scopeKey,
      reasonCode: 'scoped_pause',
      blockedActionKinds: [blocked],
      sourceEventKind: TODAY_PAUSE_SOURCE_EVENT_KIND,
      sourceEventId: item.id,
      recoveryAction: 'release_pause',
    });

    // The task stays open. It is the one place the pause is visible, and the card
    // puts the Resume control on it (`pauseHoldId` in the expanded card).
    await recordCrmAuditEvent(context, {
      action: 'today.automated_paused',
      subjectKind: 'today_item',
      subjectId: item.id,
      detail: {
        firmId: item.firmId,
        holdId,
        reason,
        scope: scope.scopeKind,
        blockedActionKind: blocked,
        ...(input.returnAt === undefined ? {} : { requestedReturnAt: input.returnAt }),
      },
    });
    return acceptToday({ outcome: 'held', holdId, blockedActionKind: blocked, scope: scope.scopeKind });
  }

  if (input.returnAt === undefined) return refuseToday('snooze_return_required');
  // Database time, never the caller's clock: the return instant is compared with the
  // same clock every other deadline in the system is (docs/decisions/g4-database-time-is-a-parameter.md).
  const now = await databaseNow(context);
  if (Date.parse(input.returnAt) <= Date.parse(now)) return refuseToday('snooze_return_not_future');

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

export interface ReleasedTodayPause {
  readonly holdId: string;
  readonly releasedAt: string;
  /** What the enrollment did next (4.3): resumed and shifted, or still held. */
  readonly resume: 'resume' | 'still_held' | 'not_applicable';
}

/**
 * Release a paused automated task (audit item C22).
 *
 * Exactly the hold a Today pause opened, and only such a hold: "clearing one hold
 * never clears another" (4.3), so a mailbox hold, a suppression review or an admin's
 * pause on the same work is out of reach of this control by construction — the
 * `source_event_kind` is the filter. The enrollment is then asked to resume in the
 * same transaction, which shifts its unexecuted steps by the union of the intervals
 * that blocked it, or leaves it held if something else still does. A pause longer
 * than seven days resumes like a short one (wave 2, S4.1).
 */
export async function releaseTodayPause(
  context: RepositoryContext,
  input: { readonly holdId: string },
): Promise<TodayResult<ReleasedTodayPause>> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refuseToday('invalid_input');

  const { rows } = await context.db.query<{
    scope_kind: string;
    scope_key: string | null;
    released_at: Date | null;
  }>(
    `SELECT scope_kind, scope_key, released_at FROM active_holds
      WHERE workspace_id = $1 AND id = $2 AND source_event_kind = $3
      FOR UPDATE`,
    [context.scope.workspaceId, input.holdId, TODAY_PAUSE_SOURCE_EVENT_KIND],
  );
  const hold = rows[0];
  if (hold === undefined || hold.scope_key === null) return refuseToday('pause_unknown');

  let firmId: string | null = hold.scope_kind === 'firm' ? hold.scope_key : null;
  const enrollmentId = hold.scope_kind === 'enrollment' ? hold.scope_key : null;
  if (enrollmentId !== null) {
    const { rows: enrollments } = await context.db.query<{ firm_id: string }>(
      'SELECT firm_id FROM sequence_enrollments WHERE workspace_id = $1 AND id = $2',
      [context.scope.workspaceId, enrollmentId],
    );
    firmId = enrollments[0]?.firm_id ?? null;
  }
  if (firmId === null) return refuseToday('pause_unknown');
  const firm = await loadFirmForUpdate(context, firmId);
  if (firm === null) return refuseToday('pause_unknown');
  const permitted = decideFirmMutation(context, firm);
  if (!permitted.permitted) return refuseToday(permitted.reason === 'not_assigned' ? 'not_assigned' : 'pause_unknown');
  if (hold.released_at !== null) return refuseToday('pause_already_released');

  const released = await releaseHold(context, input.holdId);
  if (released === null) return refuseToday('pause_already_released');

  let resume: ReleasedTodayPause['resume'] = 'not_applicable';
  if (enrollmentId !== null) {
    const resumed = await resumeEnrollment(context, { enrollmentId });
    if (resumed.ok) resume = resumed.value.kind;
  }

  await recordCrmAuditEvent(context, {
    action: 'today.pause_released',
    subjectKind: 'active_hold',
    subjectId: input.holdId,
    detail: { firmId, scope: hold.scope_kind, resume },
  });
  return acceptToday({ holdId: input.holdId, releasedAt: released.releasedAt, resume });
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
