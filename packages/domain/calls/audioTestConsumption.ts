import type { RepositoryContext } from '../db/workspaceScope.ts';
import { readAudioTestSessionClearance } from './audioTestClearance.ts';
import { readAudioTestAccess, type AudioTestRefusal } from './audioTestPolicy.ts';

/** Only the shared stored-purpose consumer calls this, under gate -> session -> reservation. */
export async function resolveAudioTestDestination(
  context: RepositoryContext,
  sessionId: string,
  configuredCallerIdE164: string | undefined,
): Promise<{ readonly ok: true; readonly value: { readonly e164: string; readonly callerIdE164: string } } | { readonly ok: false; readonly reason: AudioTestRefusal }> {
  if (!configuredCallerIdE164) return { ok: false, reason: 'caller_id_mismatch' };
  const request = (await context.db.query<{ device_id: string; calling_identity_id: string; e164: string | null; erased_at: Date | null }>(
    `SELECT r.device_id,r.calling_identity_id,r.e164,r.erased_at FROM browser_audio_test_requests r
       JOIN call_sessions s ON s.workspace_id=r.workspace_id AND s.audio_test_request_id=r.id
      WHERE s.workspace_id=$1 AND s.id=$2 AND s.purpose='audio_test' FOR SHARE OF r`,
    [context.scope.workspaceId, sessionId],
  )).rows[0];
  if (!request?.e164 || request.erased_at) return { ok: false, reason: 'ticket_expired' };
  const access = await readAudioTestAccess(context, { deviceId: request.device_id, callingIdentityId: request.calling_identity_id,
    e164: request.e164, configuredCallerIdE164 });
  if (!access.ok) return access;
  const final = await readAudioTestSessionClearance(context, sessionId);
  if (!final.ok) return final;
  return { ok: true, value: { e164: request.e164, callerIdE164: access.callerIdE164 } };
}
