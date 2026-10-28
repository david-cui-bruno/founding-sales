import type { RepositoryContext } from '../db/workspaceScope.ts';
import { DialExecutionRefused, readTicketExecutionClearance } from '../dial/executionClearance.ts';
import {lockPreparedCallingCapability} from '../calling/preparationLifecycle.ts';
import { readAudioTestSessionClearance } from './audioTestClearance.ts';
import type { AudioTestClearance } from './audioTestPolicy.ts';

export async function readCallSessionClearance(context: RepositoryContext, sessionId: string): Promise<AudioTestClearance> {
  const purpose = (await context.db.query<{ purpose: string }>('SELECT purpose FROM call_sessions WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, sessionId])).rows[0]?.purpose;
  if (purpose === 'audio_test') return await readAudioTestSessionClearance(context, sessionId);
  if (purpose !== 'business') return { ok: false, reason: 'ticket_unknown' };
  await lockPreparedCallingCapability(context.db,context.scope.workspaceId,'session',sessionId);
  const session = (await context.db.query<{ ticket_id: string; expires_at: Date }>(
    "SELECT ticket_id,expires_at FROM call_sessions WHERE workspace_id=$1 AND id=$2 AND purpose='business' FOR SHARE",
    [context.scope.workspaceId, sessionId],
  )).rows[0];
  return session ? await readTicketExecutionClearance(context, session.ticket_id, session.expires_at) : { ok: false, reason: 'ticket_unknown' };
}

export async function requireCurrentCallSessionClearance(context: RepositoryContext, sessionId: string): Promise<string> {
  const clearance = await readCallSessionClearance(context, sessionId);
  if (!clearance.ok) throw new DialExecutionRefused(clearance.reason);
  return clearance.at;
}
