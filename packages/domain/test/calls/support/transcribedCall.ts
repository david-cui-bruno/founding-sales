import { randomBytes } from 'node:crypto';
import type { CallTranscriptUtterance } from '@fss/contracts';
import { consumeCallSession, createCallSession, recordCallRecording, recordCallStatus } from '../../../calls/sessions.ts';
import { withTransaction, type SessionQueryable } from '../../../db/queryable.ts';
import { repositoryContext, workspaceScope } from '../../../db/workspaceScope.ts';
import type { SeededCrm } from '../../db/support/crmFixtures.ts';
import type { TwoWorkspaces } from '../../db/support/fixtures.ts';
import type { SeededPolicy } from '../../db/support/policyFixtures.ts';

/**
 * A placed, answered, recorded call in workspace alpha with a stored channel-labelled
 * transcript, made through the real session commands (slice 3a; shared with Lane B's
 * apply tests, which build on the analysis writers). The workspace needs a
 * `telephony_budget` setting first.
 */
let counter = 0;

export async function transcribedCall(
  session: SessionQueryable,
  fixtures: { readonly seeded: TwoWorkspaces; readonly crm: SeededCrm; readonly policy: SeededPolicy },
  utterances: readonly CallTranscriptUtterance[],
): Promise<string> {
  const { seeded, crm, policy } = fixtures;
  counter += 1;
  const salesperson = repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.salesperson.userId, role: 'salesperson' }),
    session,
  );
  const created = await withTransaction(session, async () =>
    await createCallSession(salesperson, {
      firmId: crm.alpha.firmId,
      routeId: policy.alpha.phoneRouteId,
      routeVersion: policy.alpha.phoneRouteVersion,
      callingIdentityId: policy.alpha.callingIdentityId,
      deviceId: seeded.alpha.salesperson.deviceId,
      commandId: `analysis-call-${String(counter)}-${randomBytes(4).toString('hex')}`,
      configuredCallerIdE164: '+14015550100',
      at: policy.insideWindow,
    }),
  );
  if (!created.ok) throw new Error(created.reason);
  const sessionId = created.value.sessionId;
  const sid = `CA${randomBytes(16).toString('hex')}`;
  const consumed = await withTransaction(session, async () =>
    await consumeCallSession(session, {
      workspaceId: seeded.alpha.workspaceId,
      sessionId,
      callSid: sid,
      identity: `client:${seeded.alpha.salesperson.userId}`,
      at: policy.insideWindow,
    }),
  );
  if (!consumed.ok) throw new Error(consumed.reason);
  // Placed on an earlier day, so the firm's calling cadence never refuses the next call.
  await session.query(
    "UPDATE call_sessions SET consumed_at = '2026-08-03T14:00:00Z', expires_at = GREATEST(expires_at, '2026-08-03T14:00:00Z') WHERE id = $1",
    [sessionId],
  );
  await withTransaction(session, async () => {
    await recordCallStatus(session, { callSid: sid, providerStatus: 'in-progress' });
    await recordCallStatus(session, { callSid: sid, providerStatus: 'completed', durationSeconds: 125 });
    await recordCallRecording(session, {
      callSid: sid,
      recordingSid: `RE${randomBytes(16).toString('hex')}`,
      recordingUrl: `https://api.twilio.com/2010-04-01/Accounts/AC${'a'.repeat(32)}/Recordings/RE${randomBytes(16).toString('hex')}`,
      durationSeconds: 125,
    });
  });
  await session.query(
    `INSERT INTO call_transcripts (workspace_id, call_session_id, provider, model, language, duration_seconds, utterances)
     VALUES ($1, $2, 'aws_transcribe', 'standard', 'en-US', 125, $3::jsonb)`,
    [seeded.alpha.workspaceId, sessionId, JSON.stringify(utterances)],
  );
  return sessionId;
}
