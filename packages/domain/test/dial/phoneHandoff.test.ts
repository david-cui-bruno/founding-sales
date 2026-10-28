import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { readPhoneHandoffResult } from '../../dial/phoneHandoff.ts';
import { reservePhoneHandoff } from '../../dial/phoneHandoff.ts';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext } from '../../db/workspaceScope.ts';
import { previewOutcomeCorrection, correctCallOutcome } from '../../calls/correctOutcome.ts';
import { createCallSession, consumeCallSession } from '../../calls/sessions.ts';
import { readCallCadence } from '../../calls/cadence.ts';
import { logCallOutcome } from '../../dial/calls.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { recordSuppression } from '../../suppression/events.ts';
import { phoneFixture, type PhoneFixture } from './phoneHandoffFixtures.ts';
let db: TestDatabase;
let f: PhoneFixture;
beforeAll(async () => { db = await createTestDatabase(); f = await phoneFixture(db); });
afterAll(async () => { await db.drop(); });
beforeEach(async () => { await db.session.query('BEGIN'); await f.publish(); return async () => { await db.session.query('ROLLBACK'); }; });
async function attempt(at = f.policy.insideWindow) {
  const answer = await f.reserve({ at });
  expect(answer.ok).toBe(true);
  if (!answer.ok) throw new Error(answer.reason);
  return answer.value.attemptId;
}
describe('durable phone reservation, not merely logged outcomes', () => {
  it('writes frozen context before returning only an opaque receipt and consumes an unanswered attempt', async () => {
    const id = await attempt();
    const row = (await db.session.query('SELECT * FROM phone_handoff_attempts WHERE id=$1', [id])).rows[0];
    expect(row).toMatchObject({ device_id: f.seeded.alpha.salesperson.deviceId, actor_user_id: f.seeded.alpha.salesperson.userId,
      phone_route_id: f.policy.alpha.phoneRouteId, e164: f.policy.alpha.e164, call_log_id: null });
    expect(await readCallCadence(f.context, f.crm.alpha.firmId, f.policy.insideWindow)).toMatchObject({ unansweredAttempts: 1, refusal: 'call_attempt_today' });
    expect(await f.reserve()).toEqual({ ok: false, reason: 'call_attempt_today' });
    expect(await readPhoneHandoffResult(f.context, id, false)).toMatchObject({ actionable: true, telUri: `tel:${f.policy.alpha.e164}`, validForMilliseconds: 15000 });
    expect(await readPhoneHandoffResult(f.context, id, true)).toMatchObject({ actionable: false, e164: null, telUri: null, validForMilliseconds: 0 });
  });
  it('caps the grant at the actual local window close', async () => {
    const id = await attempt('2026-09-16T23:59:59.900Z');
    expect(await readPhoneHandoffResult(f.context, id, false)).toMatchObject({ validForMilliseconds: 100, expiresAt: '2026-09-17T00:00:00.000Z' });
  });
  it('caps the grant at registry expiry rather than granting fifteen seconds of stale clearance', async () => {
    await f.publish({ downloadedAt: '2026-08-16T14:00:00.100Z', publishedAt: '2026-09-16T13:00:00Z' });
    const id = await attempt();
    expect(await readPhoneHandoffResult(f.context, id, false)).toMatchObject({ validForMilliseconds: 100, expiresAt: '2026-09-16T14:00:00.100Z' });
  });
  it.each([
    ['route version', { routeVersion: 999 }, 'route_version_stale'],
    ['cross-workspace device', () => ({ deviceId: f.seeded.beta.salesperson.deviceId }), 'phone_handoff_unavailable'],
    ['hours', { at: '2026-09-16T07:00:00.000Z' }, 'outside_calling_window'],
  ] as const)('rechecks %s before creating any attempt', async (_name, overrides, reason) => {
    expect(await f.reserve(typeof overrides === 'function' ? overrides() : overrides)).toEqual({ ok: false, reason });
    expect((await db.session.query('SELECT id FROM phone_handoff_attempts')).rows).toHaveLength(0);
  });
  it('preserves internal DNC even with fresh registry clearance', async () => {
    await recordSuppression(f.context, { scope: 'firm', firmId: f.crm.alpha.firmId, channel: 'phone', source: 'prospect_do_not_call', journal: recordingSuppressionJournal() });
    expect((await f.reserve()).ok).toBe(false);
    expect((await db.session.query('SELECT id FROM phone_handoff_attempts')).rows).toHaveLength(0);
  });
  it('cannot use expiry, no outcome, or a new command ID to refund a handoff', async () => {
    await attempt('2026-09-16T14:00:00Z');
    await attempt('2026-09-17T16:00:00Z');
    await attempt('2026-09-18T14:00:00Z');
    await attempt('2026-09-21T16:00:00Z');
    expect(await f.reserve({ at: '2026-09-22T14:00:00Z' })).toEqual({ ok: false, reason: 'call_attempts_exhausted' });
    expect(await readCallCadence(f.context, f.crm.alpha.firmId, '2026-09-30T14:00:00Z')).toMatchObject({ unansweredAttempts: 3 });
  });
  it('shares the unchanged four-in-fourteen allowance with real consumed Twilio history', async () => {
    const day = await f.publishMixedProviderWeek();
    await db.session.query(`INSERT INTO workspace_settings(workspace_id,setting_key,version,value,changed_by_user_id)
      VALUES($1,'telephony_budget',1,'{"dailyCeilingCents":500,"maxMinutesPerCall":30,"unitPriceMicros":14000}',$2)`, [f.w, f.seeded.alpha.admin.userId]);
    const created = await createCallSession(f.context, { ...f.request(), at: day(0), callingIdentityId: f.policy.alpha.callingIdentityId, configuredCallerIdE164: '+14015550100' });
    if (!created.ok) throw new Error(created.reason);
    expect((await consumeCallSession(db.session, { workspaceId: f.w, sessionId: created.value.sessionId, callSid: `CA${'a'.repeat(32)}`,
      identity: `client:${f.seeded.alpha.salesperson.userId}`, at: day(0) })).ok).toBe(true);
    // Consumption records database now(), independent of its injected policy-decision clock.
    await db.session.query('UPDATE call_sessions SET consumed_at=$2 WHERE id=$1', [created.value.sessionId, day(0)]);
    expect(await f.reserve({ at: day(0) })).toEqual({ ok: false, reason: 'call_attempt_today' });
    await attempt(day(1, 17));
    await attempt(day(2));
    await attempt(day(5, 17));
    expect(await f.reserve({ at: day(6) })).toEqual({ ok: false, reason: 'call_attempts_exhausted' });
  });
  it('links a single outcome and refuses a duplicate under a different command, preserving phone-only history', async () => {
    const id = await attempt();
    const input = { firmId: f.crm.alpha.firmId, phoneHandoffAttemptId: id, outcome: 'no_answer' as const };
    const logged = await logCallOutcome(f.context, input);
    expect(logged.ok).toBe(true);
    expect(await logCallOutcome(f.context, input)).toMatchObject({ ok: false, reason: 'call_already_logged' });
    expect((await db.session.query('SELECT call_log_id FROM phone_handoff_attempts WHERE id=$1', [id])).rows[0]?.['call_log_id']).toBeTruthy();
    expect((await db.session.query('SELECT id FROM call_sessions')).rows).toHaveLength(0);
    expect(await readCallCadence(f.context, f.crm.alpha.firmId, f.policy.insideWindow)).toMatchObject({ unansweredAttempts: 1 });
  });
  it('refuses mismatched route and Twilio/session bindings without writing history', async () => {
    const id = await attempt();
    expect(await logCallOutcome(f.context, { firmId: f.crm.alpha.firmId, routeId: f.policy.beta.phoneRouteId, phoneHandoffAttemptId: id, outcome: 'no_answer' })).toMatchObject({ ok: false, reason: 'ticket_mismatch' });
    expect(await logCallOutcome(f.context, { firmId: f.crm.alpha.firmId, callSessionId: id, phoneHandoffAttemptId: id, outcome: 'no_answer' })).toMatchObject({ ok: false, reason: 'invalid_input' });
    expect((await db.session.query('SELECT id FROM call_logs')).rows).toHaveLength(0);
  });
  it('reached outcome resets the stream, but correcting it back to unanswered restores the count', async () => {
    const id = await attempt();
    const logged = await logCallOutcome(f.context, { firmId: f.crm.alpha.firmId, phoneHandoffAttemptId: id, outcome: 'interested' });
    if (!logged.ok) throw new Error(logged.reason);
    expect(await readCallCadence(f.context, f.crm.alpha.firmId, f.policy.insideWindow)).toMatchObject({ unansweredAttempts: 0 });
    const shown = await previewOutcomeCorrection(f.context, { callLogId: logged.value.callLogId, outcome: 'no_answer' });
    if (!shown.ok) throw new Error(shown.reason);
    const corrected = await correctCallOutcome(f.context, { callLogId: logged.value.callLogId, expectedOutcome: shown.value.currentOutcome,
      outcome: 'no_answer', commandId: 'correct-phone-fixture', journal: recordingSuppressionJournal(),
      effects: shown.value.effects.filter(effect => effect.conflicts).map(effect => ({ kind: effect.kind, id: effect.id, state: effect.state,
        decision: effect.decisions.includes('undo') ? 'undo' : 'keep' })) });
    expect(corrected.ok).toBe(true);
    expect(await readCallCadence(f.context, f.crm.alpha.firmId, f.policy.insideWindow)).toMatchObject({ unansweredAttempts: 1 });
  });
  it('serializes two real app-runtime reservations before either could hand off', async () => {
    const concurrentDb = await createTestDatabase();
    try {
      const other = await phoneFixture(concurrentDb);
      await other.publish();
      const a = await concurrentDb.appRuntimeSession();
      const b = await concurrentDb.appRuntimeSession();
      const reserve = async (session: typeof a) => await withTransaction(session, async () =>
        await reservePhoneHandoff(repositoryContext(other.context.scope, session), other.request()));
      const results = await Promise.all([reserve(a), reserve(b)]);
      expect(results.filter(result => result.ok)).toHaveLength(1);
      expect(results.filter(result => !result.ok)).toEqual([{ ok: false, reason: 'call_attempt_today' }]);
      expect((await concurrentDb.session.query('SELECT id FROM phone_handoff_attempts')).rows).toHaveLength(1);
    } finally { await concurrentDb.drop(); }
  });
});
