import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';

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
