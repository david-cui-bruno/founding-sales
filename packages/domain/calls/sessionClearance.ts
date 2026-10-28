import type { RepositoryContext } from '../db/workspaceScope.ts';
import { DialExecutionRefused, readTicketExecutionClearance, type ExecutionClearance } from '../dial/executionClearance.ts';

export async function readCallSessionClearance(context: RepositoryContext, sessionId: string): Promise<ExecutionClearance> {
  const session = (await context.db.query<{ ticket_id: string; expires_at: Date }>(
    'SELECT ticket_id,expires_at FROM call_sessions WHERE workspace_id=$1 AND id=$2 FOR SHARE',
    [context.scope.workspaceId, sessionId],
  )).rows[0];
  return session ? await readTicketExecutionClearance(context, session.ticket_id, session.expires_at) : { ok: false, reason: 'ticket_unknown' };
}

export async function requireCurrentCallSessionRegistry(context: RepositoryContext, sessionId: string): Promise<string> {
  const clearance = await readCallSessionClearance(context, sessionId);
  if (!clearance.ok) throw new DialExecutionRefused(clearance.reason);
  return clearance.at;
}
