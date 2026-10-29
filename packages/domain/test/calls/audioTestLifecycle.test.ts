import { describe, expect, it } from 'vitest';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { readBrowserExecutionClearance } from '../../dial/executionClearance.ts';
import { createAudioTestSession } from '../../calls/audioTest.ts';
import { readAudioTestSessionClearance } from '../../calls/audioTestClearance.ts';
import { readAudioTestAccess, readAudioTestAllowance } from '../../calls/audioTestPolicy.ts';
import { consumeCallSession, recordCallRecording, recordCallStatus, recordingPathOfSession, sweepCallSessionReservations, workspacesOwingCallSessionSweep } from '../../calls/sessions.ts';
import { readCallCadence } from '../../calls/cadence.ts';
import type { Queryable, QueryResultRowLike } from '../../db/queryable.ts';
import { enqueueCallTranscription } from '../../calls/transcription.ts';
import { admitToAnalysisPath } from '../../calls/pendingHold.ts';
import { lockCallAnalysisForSession } from '../../calls/analysis.ts';
import { audioTestWorld, caller, consumeInput, createInput, destination, ids } from './audioTestWorld.ts';

function emptyWorld() {
  const world = audioTestWorld();
  world.state.session = false; world.state.reservation = false; world.state.request = false;
  return world;
}
function expectNoBusinessWrites(world: ReturnType<typeof audioTestWorld>) {
  expect(world.trace.filter(t => /^(INSERT|UPDATE|DELETE)/u.test(t.sql)).some(t => /\b(firms|contacts|dial_tickets|funnel_facts|audit_events|call_logs|jobs|call_transcripts|call_analyses|active_holds)\b/u.test(t.sql))).toBe(false);
}

describe('manual audio-test purpose and money', () => {
  it('creates only the request/session and reserves one started minute at the existing price', async () => {
    const world = emptyWorld();
    const result = await createAudioTestSession(world.context, createInput);
    expect(result).toMatchObject({ ok: true, value: { expiresAt: world.state.expires } });
    expect(world.state.reservationMaxMinutes).toBe(1); expect(world.state.cents).toBe(3);
    expect(world.state.dailyCeiling).toBe(100); expect(world.state.maxMinutes).toBe(10);
    expectNoBusinessWrites(world);
    expect(world.trace.find(t => t.sql.startsWith('INSERT INTO call_sessions'))?.sql).toContain("expires_at,'audio_test',id");
    expect(world.trace.some(t => /state_postures|calling_window|time_zone_confidence|INSERT INTO workspace_settings/u.test(t.sql))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(destination);
  });
  it('takes the gate and per-actor allowance lock before authorization rows', async () => {
    const world = emptyWorld(); await createAudioTestSession(world.context, createInput);
    expect(world.trace[0]?.values).toEqual([`fss.send-gate:${ids.workspace}`]);
    expect(world.trace[1]?.values).toEqual([`${ids.workspace}:audio_test`]);
    expect(world.trace[2]?.sql).toContain('workspace_memberships');
  });
  it('refuses non-admin and malformed non-NANP input before making a request', async () => {
    const world = emptyWorld();
    const salesperson = repositoryContext(workspaceScope(ids.workspace, { kind: 'user', userId: ids.user, role: 'salesperson' }), world.db);
    expect(await createAudioTestSession(salesperson, createInput)).toEqual({ ok: false, reason: 'audio_test_admin_only' });
    expect(await createAudioTestSession(world.context, { ...createInput, e164: '+442079460000' })).toEqual({ ok: false, reason: 'invalid_input' });
    expect(world.trace).toHaveLength(0);
  });
  it.each([
    ['disabled budget', 'dailyCeiling', 0, 'telephony_budget_disabled'],
    ['daily spend', 'spent', 100, 'telephony_budget_exhausted'],
    ['monthly spend', 'monthlySpent', 2500, 'monthly_cash_ceiling'],
    ['today allowance', 'today', 1, 'audio_test_today'],
    ['14-day allowance', 'recent', 4, 'audio_test_limit'],
    ['active/unknown attempt', 'active', true, 'audio_test_active'],
  ] as const)('refuses %s without creating a request or raising a ceiling', async (_name, field, value, reason) => {
    const world = emptyWorld(); Object.assign(world.state, { [field]: value });
    expect(await createAudioTestSession(world.context, createInput)).toEqual({ ok: false, reason });
    expect(world.trace.some(t => t.sql.startsWith('INSERT'))).toBe(false);
  });
  it('rolls back the bounded request and money when the final current budget is lowered', async () => {
    const world = emptyWorld();
    world.hooks.beforeQuery = sql => { if (sql.startsWith('SELECT s.actor_user_id')) world.state.dailyCeiling = 0; };
    expect(await createAudioTestSession(world.context, createInput)).toEqual({ ok: false, reason: 'telephony_budget_disabled' });
    expect(world.state.session).toBe(false); expect(world.state.request).toBe(false); expect(world.state.reservation).toBe(false);
  });
});

describe('current authorization and stored-purpose consumption', () => {
  it.each([
    ['member role', 'role', 'salesperson', 'audio_test_admin_only'],
    ['inactive member', 'memberStatus', 'inactive', 'audio_test_admin_only'],
    ['retired device', 'deviceActive', false, 'ticket_wrong_device'],
    ['another owner', 'identityOwner', ids.device, 'identity_not_owned'],
    ['disabled identity', 'identityEnabled', false, 'identity_disabled'],
    ['configured caller', 'identityE164', destination, 'caller_id_mismatch'],
    ['provider off', 'provider', 'tel', 'scoped_pause'],
    ['internal DNC', 'suppressed', true, 'handle_suppressed'],
    ['known registry match', 'registryMatch', true, 'dnc_registry_match'],
    ['restore hold', 'hold', true, 'restore_in_progress'],
  ] as const)('refuses %s at the shared test authorizer', async (_name, field, value, reason) => {
    const world = audioTestWorld(); Object.assign(world.state, { [field]: value });
    expect(await readAudioTestAccess(world.context, createInput)).toEqual({ ok: false, reason });
  });
  it('allows this explicit personal test while ordinary calling retains its personal-cell stop', async () => {
    const world = audioTestWorld(); world.state.knownPersonal = true;
    expect(await readAudioTestAccess(world.context, createInput)).toEqual({ ok: true, callerIdE164: caller });
    expect(await readBrowserExecutionClearance(world.context, destination)).toEqual({ ok: false, reason: 'route_invalid' });
    expectNoBusinessWrites(world);
  });
  it('consumes the stored audio purpose once, with at most 60 seconds and no Firm/ticket/cadence effects', async () => {
    const world = audioTestWorld(); world.state.reservationMaxMinutes = 20;
    expect(await consumeCallSession(world.db, consumeInput)).toEqual({ ok: true, value: {
      sessionId: ids.session, workspaceId: ids.workspace, e164: destination, callerIdE164: caller, maxSeconds: 60,
    } });
    expect(world.state.consumed).toBe(true); expect(world.state.reservationState).toBe('calling');
    expect(await consumeCallSession(world.db, consumeInput)).toEqual({ ok: false, reason: 'already_consumed' });
    expect(world.trace.some(t => /FROM firms|dial_tickets|phone_handoff_attempts|calling_preparations/u.test(t.sql))).toBe(false);
    expectNoBusinessWrites(world);
  });
  it('requires the configured caller at signed voice consumption', async () => {
    const world = audioTestWorld(); const { configuredCallerIdE164: _caller, ...input } = consumeInput;
    expect(await consumeCallSession(world.db, input)).toEqual({ ok: false, reason: 'caller_id_mismatch' });
    expect(world.state.consumed).toBe(false); expect(world.state.reservationState).toBe('reserved');
  });
  it('rejects a different SDK actor and an already closed reservation', async () => {
    const world = audioTestWorld();
    expect(await consumeCallSession(world.db, { ...consumeInput, identity: `client:${ids.device}` })).toEqual({ ok: false, reason: 'identity_mismatch' });
    world.state.reservationState = 'released';
    expect(await consumeCallSession(world.db, consumeInput)).toEqual({ ok: false, reason: 'reservation_closed' });
  });
  it('uses a live clock after budget-lock waits and never extends the original minute', async () => {
    const world = audioTestWorld();
    world.hooks.beforeQuery = sql => { if (sql.startsWith('WITH spend AS')) world.state.now = world.state.expires; };
    expect(await readAudioTestSessionClearance(world.context, ids.session)).toEqual({ ok: false, reason: 'ticket_expired' });
    expect(world.state.consumed).toBe(false); expect(world.state.expires).toBe('2026-10-28T16:01:00.000Z');
  });
  it('does not double-charge its own reservation when checking current daily and monthly headroom', async () => {
    const world = audioTestWorld(); world.state.dailyCeiling = 3; world.state.monthlyCeiling = 3;
    expect(await readAudioTestSessionClearance(world.context, ids.session)).toMatchObject({ ok: true });
    world.state.spent = 1;
    expect(await readAudioTestSessionClearance(world.context, ids.session)).toEqual({ ok: false, reason: 'telephony_budget_exhausted' });
  });
  it('rolls back consumption and possibly-spent money if the last clearance crosses the original deadline', async () => {
    const world = audioTestWorld();
    world.hooks.beforeQuery = sql => { if (sql.startsWith('SELECT max_units')) world.state.now = world.state.expires; };
    expect(await consumeCallSession(world.db, consumeInput)).toEqual({ ok: false, reason: 'ticket_expired' });
    expect(world.state.consumed).toBe(false); expect(world.state.reservationState).toBe('reserved');
    expectNoBusinessWrites(world);
  });
  it('counts consumed attempts by workspace calendar without refunding uncertainty', async () => {
    const world = audioTestWorld(); world.state.active = true;
    expect(await readAudioTestAllowance(world.context, world.state.now, ids.session)).toEqual({ ok: false, reason: 'audio_test_active' });
    const sql = world.trace.find(t => t.sql.startsWith('SELECT count(*) FILTER'))!;
    expect(sql.values).toEqual([ids.workspace, world.state.now, 'America/New_York', ids.session]);
    expect(sql.sql).toContain("INTERVAL '14 days'"); expect(sql.sql).toContain("s.purpose='audio_test'");
    expect(sql.sql).toContain("s.status IN ('authorized','ringing','in_progress')");
  });
});

describe('callbacks, erasure and uncertain billing', () => {
  function placed() { const world = audioTestWorld(); world.state.consumed = true; world.state.consumedAt = new Date(world.state.now); world.state.reservationState = 'calling'; return world; }
  it('keeps automatic recording metadata but never enters analysis, CRM or commercial cadence', async () => {
    const world = placed();
    await recordCallStatus(world.db, { callSid: consumeInput.callSid, providerStatus: 'in-progress' });
    expect(await recordCallRecording(world.db, { callSid: consumeInput.callSid, recordingSid: `RE${'2'.repeat(32)}`,
      recordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Recordings/REtest', durationSeconds: 45 })).toMatchObject({ known: true, recorded: { sessionId: ids.session } });
    expect(world.state.recordingSeconds).toBe(45); expect(world.state.recordingPath).toContain('/Recordings/');
    expect(world.trace.some(t => /worker_heartbeats|call_transcription|INSERT INTO jobs|FROM firms/u.test(t.sql))).toBe(false);
    expectNoBusinessWrites(world);
  });
  it('settles a terminal test once, accepts the later exact price, and erases only the destination', async () => {
    const world = placed(); world.state.recordingPath = '/recording/test';
    const first = await recordCallStatus(world.db, { callSid: consumeInput.callSid, providerStatus: 'completed', durationSeconds: 45 });
    expect(first).toMatchObject({ known: true, settlement: 'estimated' }); expect(world.state.ledgerCents).toBe(3);
    await recordCallStatus(world.db, { callSid: consumeInput.callSid, providerStatus: 'completed', durationSeconds: 45, priceDollars: -0.01 });
    await recordCallStatus(world.db, { callSid: consumeInput.callSid, providerStatus: 'completed', priceDollars: -0.01 });
    expect(world.state.ledgerCents).toBe(1); expect(world.state.reservationState).toBe('settled');
    expect(world.state.e164).toBeNull(); expect(world.state.erasedAt).not.toBeNull(); expect(world.state.recordingPath).toBe('/recording/test');
    expect(world.state.session).toBe(true); expect(world.state.request).toBe(true); expectNoBusinessWrites(world);
  });
  it('expires an unconsumed destination and releases its money without deleting history', async () => {
    const world = audioTestWorld(); world.state.now = '2026-10-28T16:02:00.000Z';
    expect(await sweepCallSessionReservations(world.context)).toEqual({ released: 1, estimated: 0 });
    expect(world.state.e164).toBeNull(); expect(world.state.reservationState).toBe('released'); expect(world.state.ledgerCents).toBe(0);
    expect(world.state.session).toBe(true); expect(world.trace.some(t => t.sql.startsWith('DELETE'))).toBe(false);
  });
  it('estimates a lost consumed callback and retains its nonterminal UNKNOWN status and allowance block', async () => {
    const world = placed(); world.state.now = '2026-10-28T16:17:00.000Z';
    expect(await sweepCallSessionReservations(world.context)).toEqual({ released: 0, estimated: 1 });
    expect(world.state.e164).toBeNull(); expect(world.state.status).toBe('authorized'); expect(world.state.ledgerCents).toBe(3);
    expect(await readAudioTestAllowance(world.context, world.state.now)).toEqual({ ok: false, reason: 'audio_test_active' });
  });
  it('schedules due destination erasure even when the reservation has already settled', async () => {
    const world = audioTestWorld(); world.state.reservationState = 'settled';
    expect(await workspacesOwingCallSessionSweep(world.db)).toEqual([ids.workspace]);
    expect(world.trace[0]?.sql).toContain('FROM browser_audio_test_requests');
  });
  it('refuses direct AI admission as well as unexpected callback admission', async () => {
    const world = placed(); world.state.answeredAt = new Date(world.state.now); world.state.recordingPath = '/recording/test'; world.state.recordingSeconds = 60;
    expect(await enqueueCallTranscription(world.db, { workspaceId: ids.workspace, sessionId: ids.session, keyConfigured: true })).toEqual({ enqueued: false, reason: 'transcription_not_eligible' });
    expect(await admitToAnalysisPath(world.db, { workspaceId: ids.workspace, sessionId: ids.session })).toEqual({ transcription: { enqueued: false, reason: 'transcription_not_eligible' }, holdId: null });
    expect(await lockCallAnalysisForSession(world.context, ids.session)).toBeNull();
    expectNoBusinessWrites(world);
  });
  it('retains the recording privately and denies the Firm-based playback route', async () => {
    const world = placed(); world.state.recordingPath = '/recording/test';
    expect(await recordingPathOfSession(world.context, ids.session)).toBeNull();
    expect(world.state.recordingPath).toBe('/recording/test');
    expect(world.trace.some(t => t.sql.includes('FROM firms'))).toBe(false);
  });
});

it.each([
  ['2026-10-28T18:30:00.000Z', 'call_attempt_today'],
  ['2026-10-29T17:00:00.000Z', 'call_attempt_too_soon'],
  ['2026-10-29T18:01:00.000Z', null],
])('preserves business cadence with no Firm geography at %s', async (at, refusal) => {
  const db: Queryable = { async query<Row extends QueryResultRowLike>(sql: string) {
    const rows: unknown[] = sql.includes('AS reset_at') ? [{ reset_at: null }]
      : sql.includes('LEFT JOIN call_logs') ? [{ id: ids.session, consumed_at: new Date('2026-10-28T16:00:00.000Z'), outcome: null }]
        : sql.includes('FROM firms') ? [{ time_zone: null }]
          : sql.includes('FROM workspaces') ? [{ business_time_zone: 'America/New_York' }]
            : sql.includes('FROM active_holds') ? [] : [];
    return { rows: rows as Row[], rowCount: rows.length };
  } };
  const context = repositoryContext(workspaceScope(ids.workspace, { kind: 'user', userId: ids.user, role: 'admin' }), db);
  expect(await readCallCadence(context, ids.request, at!)).toMatchObject({ refusal, unansweredAttempts: 1 });
});
