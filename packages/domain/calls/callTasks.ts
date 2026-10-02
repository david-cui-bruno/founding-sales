import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { decideFirmMutation } from '../crm/authorization.ts';
import { loadFirmForUpdate } from '../crm/firms.ts';
import { callTaskItemKey, lockTodayForFirmChange, refreshTodayForFirm } from '../today/build.ts';
import { completeTodayItemsByKey } from '../today/snapshots.ts';

/**
 * Call tasks (slice 3a, migration 0036): a promise made on a call, or the "Send overview to
 * <contact>" an overview request leaves, kept as a row of its own because it must outlive
 * the daily Today snapshot. Today reads the open ones (kind `task`) for a request that
 * negotiated `include=tasks`.
 *
 * One spoken promise is one task: the key is the proposal's quote key
 * (`task:<16 hex of sha256(fold(quote))>`), unique per call, so a repeated click — the same
 * command id or a different one — finds the task it already made (`already_created`).
 */

export interface CreateCallTaskInput {
  readonly firmId: string;
  readonly contactId: string | null;
  readonly callSessionId: string;
  readonly quoteKey: string;
  readonly text: string;
  readonly dueAt: string;
}

/**
 * Insert the task, or find the one this call already has under the key. The caller holds
 * the firm's lock (the apply does), so the find after a conflict sees the committed row.
 */
export async function createCallTask(
  context: RepositoryContext,
  input: CreateCallTaskInput,
): Promise<{ readonly id: string; readonly created: boolean }> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') throw new Error('a call task is created by a person');
  const { rows } = await context.db.query<{ id: string }>(
    `INSERT INTO call_tasks (workspace_id, firm_id, contact_id, call_session_id, quote_key, text, due_at, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8)
     ON CONFLICT ON CONSTRAINT call_tasks_one_per_quote DO NOTHING
     RETURNING id`,
    [
      context.scope.workspaceId,
      input.firmId,
      input.contactId,
      input.callSessionId,
      input.quoteKey,
      input.text.trim().slice(0, 300),
      input.dueAt,
      actor.userId,
    ],
  );
  const inserted = rows[0]?.id;
  if (inserted !== undefined) {
    await recordCrmAuditEvent(context, {
      action: 'call_task.created',
      subjectKind: 'call_task',
      subjectId: inserted,
      detail: { firmId: input.firmId, callSessionId: input.callSessionId, quoteKey: input.quoteKey },
    });
    return { id: inserted, created: true };
  }
  const { rows: existing } = await context.db.query<{ id: string }>(
    'SELECT id FROM call_tasks WHERE workspace_id = $1 AND call_session_id = $2 AND quote_key = $3',
    [context.scope.workspaceId, input.callSessionId, input.quoteKey],
  );
  const found = existing[0]?.id;
  if (found === undefined) throw new Error('a conflicting call task was not found');
  return { id: found, created: false };
}

export type CompleteCallTaskOutcome =
  | { readonly ok: true; readonly value: { readonly taskId: string; readonly completedAt: string } }
  | { readonly ok: false; readonly reason: 'not_found' | 'not_assigned' | 'invalid_input' };

/**
 * `POST /today/tasks/complete {taskId}`: the task is done. Today's lock (shared) and then the
 * firm's, the order of every change that ends in `refreshTodayForFirm`; the firm's assignment
 * rule; the row to `done` with its instant; every open Today item for it completed, on any
 * date; the firm's card recomputed. Completing a task already done answers its instant; a
 * cancelled task is `invalid_input`.
 */
export async function completeCallTask(
  context: RepositoryContext,
  input: { readonly taskId: string },
): Promise<CompleteCallTaskOutcome> {
  if (context.scope.actor.kind !== 'user') return { ok: false, reason: 'invalid_input' };
  const { rows: located } = await context.db.query<{ firm_id: string }>(
    'SELECT firm_id FROM call_tasks WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, input.taskId],
  );
  const firmId = located[0]?.firm_id;
  if (firmId === undefined) return { ok: false, reason: 'not_found' };
  await lockTodayForFirmChange(context);
  const firm = await loadFirmForUpdate(context, firmId);
  if (firm === null) return { ok: false, reason: 'not_found' };
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return { ok: false, reason: decision.reason === 'not_assigned' ? 'not_assigned' : 'not_found' };
  const { rows: current } = await context.db.query<{ status: string; completed_at: Date | null }>(
    'SELECT status, completed_at FROM call_tasks WHERE workspace_id = $1 AND id = $2 AND firm_id = $3 FOR UPDATE',
    [context.scope.workspaceId, input.taskId, firmId],
  );
  const task = current[0];
  if (task === undefined) return { ok: false, reason: 'not_found' };
  if (task.status === 'done' && task.completed_at !== null) {
    return { ok: true, value: { taskId: input.taskId, completedAt: task.completed_at.toISOString() } };
  }
  if (task.status !== 'open') return { ok: false, reason: 'invalid_input' };
  const { rows } = await context.db.query<{ completed_at: Date }>(
    `UPDATE call_tasks SET status = 'done', completed_at = now(), updated_at = greatest(now(), created_at)
      WHERE workspace_id = $1 AND id = $2 RETURNING completed_at`,
    [context.scope.workspaceId, input.taskId],
  );
  const completedAt = rows[0]?.completed_at;
  if (completedAt === undefined) return { ok: false, reason: 'not_found' };
  await recordCrmAuditEvent(context, {
    action: 'call_task.completed',
    subjectKind: 'call_task',
    subjectId: input.taskId,
    detail: { firmId },
  });
  await completeTodayItemsByKey(context, { firmId, itemKey: callTaskItemKey(input.taskId) });
  await refreshTodayForFirm(context, { firmId });
  return { ok: true, value: { taskId: input.taskId, completedAt: completedAt.toISOString() } };
}

export type CancelCallTaskOutcome =
  | { readonly ok: true; readonly value: { readonly taskId: string } }
  | { readonly ok: false; readonly reason: 'not_found' | 'not_assigned' | 'invalid_input' | 'task_not_open' };

/**
 * Cancel an open call task (S3X: "Undo" of a task a corrected outcome no longer supports —
 * a promise or a "Send overview" on a call that, corrected, reached nobody). The first writer
 * of migration 0036's `cancelled` status.
 *
 * The order of `completeCallTask`: Today's lock (shared), then the firm's, the assignment
 * rule, the row `FOR UPDATE`; then the row to `cancelled`, its open Today tasks cancelled on
 * any date, audited `call_task.cancelled`. A task that is no longer open is `task_not_open`
 * and nothing is written. The caller refreshes the firm's card (the correction does, after
 * everything it changed).
 */
export async function cancelCallTask(
  context: RepositoryContext,
  input: { readonly taskId: string },
): Promise<CancelCallTaskOutcome> {
  if (context.scope.actor.kind !== 'user') return { ok: false, reason: 'invalid_input' };
  const { rows: located } = await context.db.query<{ firm_id: string }>(
    'SELECT firm_id FROM call_tasks WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, input.taskId],
  );
  const firmId = located[0]?.firm_id;
  if (firmId === undefined) return { ok: false, reason: 'not_found' };
  await lockTodayForFirmChange(context);
  const firm = await loadFirmForUpdate(context, firmId);
  if (firm === null) return { ok: false, reason: 'not_found' };
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return { ok: false, reason: decision.reason === 'not_assigned' ? 'not_assigned' : 'not_found' };
  const { rows } = await context.db.query<{ id: string }>(
    `UPDATE call_tasks SET status = 'cancelled', updated_at = greatest(now(), created_at)
      WHERE workspace_id = $1 AND id = $2 AND firm_id = $3 AND status = 'open'
      RETURNING id`,
    [context.scope.workspaceId, input.taskId, firmId],
  );
  if (rows[0] === undefined) return { ok: false, reason: 'task_not_open' };
  await context.db.query(
    `UPDATE today_items
        SET status = 'cancelled', snooze_until = NULL, updated_at = greatest(now(), created_at)
      WHERE workspace_id = $1 AND firm_id = $2 AND item_key = $3 AND status IN ('open', 'snoozed')`,
    [context.scope.workspaceId, firmId, callTaskItemKey(input.taskId)],
  );
  await recordCrmAuditEvent(context, {
    action: 'call_task.cancelled',
    subjectKind: 'call_task',
    subjectId: input.taskId,
    detail: { firmId },
  });
  return { ok: true, value: { taskId: input.taskId } };
}
