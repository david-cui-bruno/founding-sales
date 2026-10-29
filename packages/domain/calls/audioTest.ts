import { randomUUID } from 'node:crypto';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { lockSendGateForDispatch } from '../policy/sendGate.ts';
import { clearTelephonyReservation, reserveTelephonyCall } from './sessionBudget.ts';
import type { CallSessionResult } from './sessionTypes.ts';
import { audioTestClock, lockAudioTestAllowance, readAudioTestAccess, readAudioTestAllowance } from './audioTestPolicy.ts';
import { readAudioTestSessionClearance } from './audioTestClearance.ts';

export interface CreateAudioTestSessionInput {
  readonly e164: string;
  readonly callingIdentityId: string;
  readonly deviceId: string;
  readonly commandId: string;
  readonly configuredCallerIdE164: string;
}

/** A manual test uses the normal telephony reservation and never creates a Firm or dial ticket. */
export async function createAudioTestSession(
  context: RepositoryContext,
  input: CreateAudioTestSessionInput,
): Promise<CallSessionResult<{ readonly sessionId: string; readonly expiresAt: string }>> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user' || actor.role !== 'admin') return { ok: false, reason: 'audio_test_admin_only' };
  if (!/^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u.test(input.e164)) return { ok: false, reason: 'invalid_input' };
  await lockSendGateForDispatch(context);
  await lockAudioTestAllowance(context);
  const access = await readAudioTestAccess(context, input);
  if (!access.ok) return access;
  const now = await audioTestClock(context);
  const clearance = await clearTelephonyReservation(context, now, 1);
  if (!clearance.ok) return clearance;
  const createdAt = await audioTestClock(context);
  const allowance = await readAudioTestAllowance(context, createdAt);
  if (!allowance.ok) return allowance;
  await context.db.query('SAVEPOINT create_audio_test_session');
  const requestId = randomUUID();
  const request = (await context.db.query<{ expires_at: Date }>(
    `INSERT INTO browser_audio_test_requests
       (workspace_id,id,actor_user_id,device_id,calling_identity_id,command_id,e164,created_at,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$8::timestamptz+INTERVAL '60 seconds') RETURNING expires_at`,
    [context.scope.workspaceId, requestId, actor.userId, input.deviceId, input.callingIdentityId, input.commandId, input.e164, createdAt],
  )).rows[0];
  if (!request) throw new Error('the audio test request insert returned no row');
  const sessionId = randomUUID();
  const reservationId = await reserveTelephonyCall(context, sessionId, clearance.value);
  await context.db.query(
    `INSERT INTO call_sessions (id,workspace_id,actor_user_id,reservation_id,expires_at,purpose,audio_test_request_id)
     SELECT $1,workspace_id,actor_user_id,$4,expires_at,'audio_test',id
       FROM browser_audio_test_requests WHERE workspace_id=$2 AND id=$3`,
    [sessionId, context.scope.workspaceId, requestId, reservationId],
  );
  const final = await readAudioTestSessionClearance(context, sessionId);
  if (!final.ok) {
    await context.db.query('ROLLBACK TO SAVEPOINT create_audio_test_session');
    return final;
  }
  return { ok: true, value: { sessionId, expiresAt: request.expires_at.toISOString() } };
}
