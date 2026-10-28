import type { RepositoryContext } from '../db/workspaceScope.ts';
import { clearExistingTelephonyReservation } from './sessionBudget.ts';
import { audioTestClock, readAudioTestAccess, readAudioTestAllowance, type AudioTestClearance } from './audioTestPolicy.ts';

/** The caller holds the send gate and actor allowance lock. Purpose always comes from storage. */
export async function readAudioTestSessionClearance(context: RepositoryContext, sessionId: string): Promise<AudioTestClearance> {
  const session = (await context.db.query<{
    actor_user_id: string; reservation_id: string; expires_at: Date; request_expires_at: Date;
    device_id: string; calling_identity_id: string; e164: string | null; erased_at: Date | null;
  }>(`SELECT s.actor_user_id,s.reservation_id,s.expires_at,r.expires_at AS request_expires_at,
        r.device_id,r.calling_identity_id,r.e164,r.erased_at
      FROM call_sessions s JOIN browser_audio_test_requests r ON r.workspace_id=s.workspace_id AND r.id=s.audio_test_request_id
     WHERE s.workspace_id=$1 AND s.id=$2 AND s.purpose='audio_test' AND s.actor_user_id=r.actor_user_id FOR SHARE OF s,r`,
  [context.scope.workspaceId, sessionId])).rows[0];
  if (!session) return { ok: false, reason: 'ticket_unknown' };
  if (context.scope.actor.kind !== 'user' || context.scope.actor.userId !== session.actor_user_id) return { ok: false, reason: 'ticket_wrong_device' };
  if (!session.e164 || session.erased_at) return { ok: false, reason: 'ticket_expired' };
  const access = await readAudioTestAccess(context, { deviceId: session.device_id, callingIdentityId: session.calling_identity_id, e164: session.e164 });
  if (!access.ok) return access;
  const beforeBudget = await audioTestClock(context);
  const budget = await clearExistingTelephonyReservation(context, session.reservation_id, beforeBudget);
  if (!budget.ok) return { ok: false, reason: budget.reason === 'invalid_input' ? 'ticket_expired' : budget.reason };
  // Budget locks may wait. The final live clock decides both lifetime and allowance.
  const at = await audioTestClock(context);
  if (Date.parse(at) >= Math.min(session.expires_at.getTime(), session.request_expires_at.getTime())) return { ok: false, reason: 'ticket_expired' };
  const allowance = await readAudioTestAllowance(context, at, sessionId);
  return allowance.ok ? { ok: true, at } : allowance;
}
