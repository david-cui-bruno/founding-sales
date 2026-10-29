import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import { readAppliedSchemaVersion } from '../../db/migrationRunner.ts';
import { createAudioTestSession } from '../../calls/audioTest.ts';
import { readAudioTestExecutionReceipt } from '../../calls/audioTestReceipt.ts';
import { consumeCallSession, listFirmCallSessions, recordingPathOfSession, sweepCallSessionReservations } from '../../calls/sessions.ts';
import { enqueueCallTranscription } from '../../calls/transcription.ts';
import { lockCallAnalysisForSession } from '../../calls/analysis.ts';
import { sendGateLockName } from '../../policy/sendGate.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import {
  AUDIO_TEST_PG_CALLER, AUDIO_TEST_PG_DESTINATION, audioTestPgBusinessSnapshot, audioTestPgInsertHistory,
  audioTestPgPlace, audioTestPgSid, audioTestPgWaitForBlock, audioTestPgWorld, type AudioTestPgWorld,
} from './audioTestPgFixture.ts';

describe('audio test actual PostgreSQL upgrade, lifecycle and retained history', () => {
  let world: AudioTestPgWorld;
  let placed: Awaited<ReturnType<typeof audioTestPgPlace>>;
  let businessCounts: unknown;
  const effects = async () => (await world.runtime.query<{ counts: unknown }>(`SELECT jsonb_build_object(
    'firms',(SELECT count(*) FROM firms WHERE workspace_id=$1),
    'contacts',(SELECT count(*) FROM contacts WHERE workspace_id=$1),
    'people',(SELECT count(*) FROM crm_people WHERE workspace_id=$1),
    'logs',(SELECT count(*) FROM call_logs WHERE workspace_id=$1),
    'funnel',(SELECT count(*) FROM funnel_facts WHERE workspace_id=$1),
    'jobs',(SELECT count(*) FROM jobs WHERE workspace_id=$1),
    'audit',(SELECT count(*) FROM audit_events WHERE workspace_id=$1),
    'holds',(SELECT count(*) FROM active_holds WHERE workspace_id=$1),
    'transcripts',(SELECT count(*) FROM call_transcripts WHERE workspace_id=$1),
    'analyses',(SELECT count(*) FROM call_analyses WHERE workspace_id=$1),
    'summaries',(SELECT count(*) FROM call_summaries WHERE workspace_id=$1)) AS counts`,
  [world.seed.alpha.workspaceId])).rows[0]!.counts;

  beforeAll(async () => {
    world = await audioTestPgWorld();
    businessCounts = await effects();
    placed = await audioTestPgPlace(world);
  });
  afterAll(async () => {
    if (world) { await world.database.drop(); console.info('AUDIO_TEST_PG_DATABASE_DROPPED', world.database.name); }
  });

  it('upgrades populated144 through145 without changing old business calls, logs, recordings, transcripts or money', async () => {
    expect(await readAppliedSchemaVersion(world.database.session)).toBe(145);
    expect(await audioTestPgBusinessSnapshot(world.runtime, world.seed.alpha.workspaceId, world.legacyIds)).toEqual(world.before);
    expect((await world.runtime.query('SELECT purpose,audio_test_request_id FROM call_sessions WHERE id=ANY($1::uuid[]) ORDER BY id',
      [world.legacyIds])).rows).toEqual([{ purpose: 'business', audio_test_request_id: null }, { purpose: 'business', audio_test_request_id: null }]);
    const history = await listFirmCallSessions(world.admin('alpha'), world.crm.alpha.firmId);
    expect(history).toHaveLength(1); expect(history?.[0]).toMatchObject({ status: 'completed', hasRecording: true, hasTranscript: true });
    expect(history?.some(call => call.sessionId === placed.sessionId)).toBe(false);
  });

  it('runs create, signed-domain consume and callbacks as app_runtime with a one-minute reservation and a 60-second connected limit', async () => {
    for (const db of [world.runtime, world.blocker]) expect((await db.query<{ current_user: string }>('SELECT current_user')).rows[0]?.current_user).toBe('app_runtime');
    expect(placed.created).not.toHaveProperty('e164');
    expect(placed.consumed).toMatchObject({ sessionId: placed.sessionId, e164: AUDIO_TEST_PG_DESTINATION, callerIdE164: AUDIO_TEST_PG_CALLER, maxSeconds: 60 });
    expect(placed.recording).toEqual({ known: true, recorded: { workspaceId: world.seed.alpha.workspaceId, sessionId: placed.sessionId } });
    expect(placed.terminal).toMatchObject({ known: true, status: 'completed', settlement: 'settled' });
    expect((await world.runtime.query(`SELECT s.purpose,s.firm_id,s.ticket_id,s.contact_id,s.call_log_id,s.status,
       s.consumed_at IS NOT NULL AS consumed,s.recording_duration_seconds,r.max_units,r.cents,r.state,r.settled_cents
      FROM call_sessions s JOIN provider_reservations r ON r.workspace_id=s.workspace_id AND r.id=s.reservation_id WHERE s.id=$1`,
    [placed.sessionId])).rows[0]).toMatchObject({ purpose: 'audio_test', firm_id: null, ticket_id: null, contact_id: null, call_log_id: null,
      status: 'completed', consumed: true, recording_duration_seconds: 45, max_units: 1, cents: 2, state: 'settled', settled_cents: 2 });
  });

  it('erases only the destination and returns an exact opaque consumed receipt without playback or redial authority', async () => {
    const row = (await world.runtime.query<{ e164: string | null; erased_at: Date | null; recording_path: string | null }>(`SELECT r.e164,r.erased_at,s.recording_path
      FROM call_sessions s JOIN browser_audio_test_requests r ON r.workspace_id=s.workspace_id AND r.id=s.audio_test_request_id WHERE s.id=$1`, [placed.sessionId])).rows[0]!;
    expect(row.e164).toBeNull(); expect(row.erased_at).not.toBeNull(); expect(row.recording_path).toContain('/Recordings/REaudio');
    const read = (input = placed.receipt, device = world.seed.alpha.admin.deviceId, workspace: 'alpha' | 'beta' = 'alpha') =>
      withTransaction(world.runtime, () => readAudioTestExecutionReceipt(world.admin(workspace), input, device, async () => true));
    const answer = await read();
    expect(answer).toEqual({ state: 'accepted', sessionId: placed.sessionId, expiresAt: placed.created.expiresAt, status: 'completed', canReconnect: false });
    expect(JSON.stringify(answer)).not.toContain(AUDIO_TEST_PG_DESTINATION);
    expect(await read({ ...placed.receipt, payloadSHA256: 'b'.repeat(64) })).toEqual({ state: 'unknown' });
    expect(await read(placed.receipt, world.seed.alpha.salesperson.deviceId)).toEqual({ state: 'unknown' });
    expect(await read(placed.receipt, world.seed.beta.admin.deviceId, 'beta')).toEqual({ state: 'unknown' });
    expect(await recordingPathOfSession(world.admin('alpha'), placed.sessionId)).toBeNull();
    expect(await withTransaction(world.runtime, () => consumeCallSession(world.runtime, {
      workspaceId: world.seed.alpha.workspaceId, sessionId: placed.sessionId, callSid: audioTestPgSid(),
      identity: `client:${world.seed.alpha.admin.userId}`, configuredCallerIdE164: AUDIO_TEST_PG_CALLER,
    }))).toEqual({ ok: false, reason: 'already_consumed' });
  });

  it('has no CRM, funnel, commercial cadence, AI work or business-recording effects even with transcription configured', async () => {
    expect(await enqueueCallTranscription(world.runtime, { workspaceId: world.seed.alpha.workspaceId, sessionId: placed.sessionId, keyConfigured: true }))
      .toEqual({ enqueued: false, reason: 'transcription_not_eligible' });
    expect(await lockCallAnalysisForSession(world.admin('alpha'), placed.sessionId)).toBeNull();
    expect(await effects()).toEqual(businessCounts);
    expect((await world.runtime.query(`SELECT count(*)::int AS n FROM jobs WHERE workspace_id=$1 AND payload->>'callSessionId'=$2`,
      [world.seed.alpha.workspaceId, placed.sessionId])).rows).toEqual([{ n: 0 }]);
  });

  it('keeps the consumed daily allowance after terminal destination erasure', async () => {
    expect(await withTransaction(world.runtime, () => createAudioTestSession(world.admin('alpha'), world.input('alpha'))))
      .toEqual({ ok: false, reason: 'audio_test_today' });
    expect((await world.runtime.query(`SELECT count(*)::int AS n FROM call_sessions
      WHERE workspace_id=$1 AND actor_user_id=$2 AND purpose='audio_test' AND consumed_at IS NOT NULL`,
    [world.seed.alpha.workspaceId, world.seed.alpha.admin.userId])).rows).toEqual([{ n: 1 }]);
  });

  it('shares the workspace allowance across admins at both creation and final consumption after erasure', async () => {
    await world.runtime.query('BEGIN');
    try {
      const member = world.seed.alpha.salesperson;
      await world.runtime.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [world.seed.alpha.workspaceId, member.userId]);
      const secondAdmin = repositoryContext(workspaceScope(world.seed.alpha.workspaceId, { kind: 'user', userId: member.userId, role: 'admin' }), world.runtime);
      expect(await createAudioTestSession(secondAdmin, { e164: AUDIO_TEST_PG_DESTINATION, commandId: randomUUID(), deviceId: member.deviceId,
        callingIdentityId: world.policy.alpha.callingIdentityId, configuredCallerIdE164: '+14015550100' })).toEqual({ ok: false, reason: 'audio_test_today' });
      // A valid pre-issued row must still fail at consumption after another admin spent the allowance.
      const fixture = await audioTestPgInsertHistory(world, { workspace: 'alpha', actor: 'salesperson' });
      expect(await consumeCallSession(world.runtime, { workspaceId: world.seed.alpha.workspaceId, sessionId: fixture.sessionId,
        callSid: audioTestPgSid(), identity: `client:${member.userId}`, configuredCallerIdE164: '+14015550100' }))
        .toEqual({ ok: false, reason: 'audio_test_today' });
      expect((await world.runtime.query('SELECT consumed_at FROM call_sessions WHERE id=$1', [fixture.sessionId])).rows).toEqual([{ consumed_at: null }]);
    } finally { await world.runtime.query('ROLLBACK'); }
  });

  it('accepts the existing usable retained unverified own identity rule without inventing attestation', async () => {
    await world.runtime.query('BEGIN');
    try {
      const identity = (await world.runtime.query<{ id: string }>(`INSERT INTO calling_identities
        (workspace_id,owner_user_id,e164,verification_status,enabled) VALUES($1,$2,'+14015550103','unverified',false) RETURNING id`,
      [world.seed.beta.workspaceId, world.seed.beta.admin.userId])).rows[0]!.id;
      const created = await createAudioTestSession(world.admin('beta'), { ...world.input('beta'), callingIdentityId: identity,
        configuredCallerIdE164: '+14015550103' });
      expect(created).toMatchObject({ ok: true });
      if (!created.ok) throw new Error(created.reason);
      expect(await consumeCallSession(world.runtime, { workspaceId: world.seed.beta.workspaceId, sessionId: created.value.sessionId,
        callSid: audioTestPgSid(), identity: `client:${world.seed.beta.admin.userId}`, configuredCallerIdE164: '+14015550103' }))
        .toMatchObject({ ok: true, value: { callerIdE164: '+14015550103', maxSeconds: 60 } });
      expect((await world.runtime.query('SELECT verification_status,enabled,verified_at FROM calling_identities WHERE id=$1', [identity])).rows)
        .toEqual([{ verification_status: 'unverified', enabled: false, verified_at: null }]);
    } finally { await world.runtime.query('ROLLBACK'); }
  });

  it('enforces four actual consumed tests in14days after all four destinations are erased', async () => {
    await world.runtime.query('BEGIN');
    try {
      for (const daysAgo of [2, 4, 6, 8]) await audioTestPgInsertHistory(world, { daysAgo, consumed: true });
      await world.runtime.query('UPDATE browser_audio_test_requests SET e164=NULL,erased_at=clock_timestamp() WHERE workspace_id=$1', [world.seed.beta.workspaceId]);
      expect(await createAudioTestSession(world.admin('beta'), world.input('beta'))).toEqual({ ok: false, reason: 'audio_test_limit' });
      expect((await world.runtime.query(`SELECT count(*)::int AS n FROM call_sessions s JOIN browser_audio_test_requests r
        ON r.workspace_id=s.workspace_id AND r.id=s.audio_test_request_id WHERE s.workspace_id=$1 AND s.consumed_at IS NOT NULL AND r.e164 IS NULL`,
      [world.seed.beta.workspaceId])).rows).toEqual([{ n: 4 }]);
    } finally { await world.runtime.query('ROLLBACK'); }
  });

  it('does not treat15-day-old terminal history as a current allowance, and never refunds an erased UNKNOWN attempt', async () => {
    await world.runtime.query('BEGIN');
    try {
      await audioTestPgInsertHistory(world, { daysAgo: 15, consumed: true });
      const created = await createAudioTestSession(world.admin('beta'), world.input('beta'));
      expect(created).toMatchObject({ ok: true });
    } finally { await world.runtime.query('ROLLBACK'); }
    await world.runtime.query('BEGIN');
    try {
      const unknown = await audioTestPgInsertHistory(world, { daysAgo: 15, consumed: true, unknown: true });
      await world.runtime.query('UPDATE browser_audio_test_requests SET e164=NULL,erased_at=clock_timestamp() WHERE id=$1', [unknown.requestId]);
      expect(await createAudioTestSession(world.admin('beta'), world.input('beta'))).toEqual({ ok: false, reason: 'audio_test_active' });
    } finally { await world.runtime.query('ROLLBACK'); }
  });

  it.each([
    ['purpose', "purpose='business',audio_test_request_id=NULL"],
    ['request identity', 'audio_test_request_id=gen_random_uuid()'],
    ['actor', 'actor_user_id=$2'],
    ['reservation', 'reservation_id=gen_random_uuid()'],
    ['original deadline', "expires_at=expires_at+INTERVAL '1 second'"],
    ['consumption reset', 'consumed_at=NULL,twilio_call_sid=NULL'],
    ['consumption time', "consumed_at=consumed_at-INTERVAL '1 microsecond'"],
    ['provider identity', "twilio_call_sid='CA11111111111111111111111111111111'"],
    ['progress reset', "status='authorized',ended_at=NULL"],
    ['terminal replacement', "status='failed'"],
    ['end reset', 'ended_at=NULL'],
    ['business association', 'firm_id=$3'],
  ])('SQL rejects test session %s changes without losing consumed history', async (_label, assignments) => {
    await expect(world.runtime.query(`UPDATE call_sessions SET ${assignments} WHERE id=$1 AND $2::uuid IS NOT NULL AND $3::uuid IS NOT NULL`,
      [placed.sessionId, world.seed.alpha.salesperson.userId, world.crm.alpha.firmId])).rejects.toMatchObject({ code: '23514' });
  });

  it.each([
    ['destination resurrection', 'e164=$2,erased_at=NULL'],
    ['request rebind', 'command_id=$3'],
    ['request actor', 'actor_user_id=$4'],
    ['deadline extension', "expires_at=expires_at+INTERVAL '1 second'"],
    ['erasure reset', 'erased_at=NULL'],
  ])('SQL rejects %s on an erased request', async (_label, assignments) => {
    await expect(world.runtime.query(`UPDATE browser_audio_test_requests SET ${assignments}
      WHERE id=(SELECT audio_test_request_id FROM call_sessions WHERE id=$1)
        AND $2::text IS NOT NULL AND $3::text IS NOT NULL AND $4::uuid IS NOT NULL`,
    [placed.sessionId, AUDIO_TEST_PG_DESTINATION, randomUUID(), world.seed.alpha.salesperson.userId])).rejects.toMatchObject({ code: '23514' });
  });

  it('retains request and session history against runtime DELETE and privileged DELETE', async () => {
    const requestId = (await world.runtime.query<{ audio_test_request_id: string }>('SELECT audio_test_request_id FROM call_sessions WHERE id=$1', [placed.sessionId])).rows[0]!.audio_test_request_id;
    await expect(world.runtime.query('DELETE FROM browser_audio_test_requests WHERE id=$1', [requestId])).rejects.toMatchObject({ code: '42501' });
    for (const db of [world.runtime, world.database.session]) await expect(db.query('DELETE FROM call_sessions WHERE id=$1', [placed.sessionId])).rejects.toMatchObject({ code: '23514' });
    await expect(world.database.session.query('DELETE FROM browser_audio_test_requests WHERE id=$1', [requestId])).rejects.toMatchObject({ code: '23514' });
    expect((await world.runtime.query('SELECT consumed_at IS NOT NULL AS consumed FROM call_sessions WHERE id=$1', [placed.sessionId])).rows).toEqual([{ consumed: true }]);
  });

  it.each([
    ['missing destination', null, '60 seconds'], ['non-NANP destination', '+442079460000', '60 seconds'],
    ['extended lifetime', AUDIO_TEST_PG_DESTINATION, '61 seconds'], ['empty lifetime', AUDIO_TEST_PG_DESTINATION, '0 seconds'],
  ])('SQL rejects malformed request %s', async (_label, e164, lifetime) => {
    await expect(world.runtime.query(`INSERT INTO browser_audio_test_requests
      (workspace_id,actor_user_id,device_id,calling_identity_id,command_id,e164,created_at,expires_at)
      SELECT $1,$2,$3,$4,$5,$6,at,at+$7::interval FROM (SELECT clock_timestamp() AS at) clock`,
    [world.seed.alpha.workspaceId, world.seed.alpha.admin.userId, world.seed.alpha.admin.deviceId,
      world.policy.alpha.otherCallingIdentityId, randomUUID(), e164, lifetime])).rejects.toMatchObject({ code: '23514' });
  });

  it('SQL rejects a cross-workspace request principal and duplicate command identity', async () => {
    await expect(world.runtime.query(`INSERT INTO browser_audio_test_requests
      (workspace_id,actor_user_id,device_id,calling_identity_id,command_id,e164,created_at,expires_at)
      SELECT $1,$2,$3,$4,$5,$6,at,at+INTERVAL '60 seconds' FROM (SELECT clock_timestamp() AS at) clock`,
    [world.seed.alpha.workspaceId, world.seed.beta.admin.userId, world.seed.alpha.admin.deviceId,
      world.policy.alpha.otherCallingIdentityId, randomUUID(), AUDIO_TEST_PG_DESTINATION])).rejects.toMatchObject({ code: '23503' });
    await expect(world.runtime.query(`INSERT INTO browser_audio_test_requests
      (workspace_id,actor_user_id,device_id,calling_identity_id,command_id,e164,created_at,expires_at)
      SELECT workspace_id,actor_user_id,device_id,calling_identity_id,command_id,$2,clock_timestamp(),clock_timestamp()+INTERVAL '59 seconds'
       FROM browser_audio_test_requests WHERE id=(SELECT audio_test_request_id FROM call_sessions WHERE id=$1)`,
    [placed.sessionId, AUDIO_TEST_PG_DESTINATION])).rejects.toMatchObject({ code: '23505' });
  });

  it.each([
    ['business with no Firm or ticket', 'business', false, false],
    ['test without request', 'audio_test', false, false],
    ['test with a Firm', 'audio_test', true, true],
    ['unknown purpose', 'other', false, false],
  ])('SQL rejects session shape %s', async (_label, purpose, request, firm) => {
    await expect(world.runtime.query(`INSERT INTO call_sessions
      (workspace_id,id,actor_user_id,reservation_id,expires_at,purpose,audio_test_request_id,firm_id)
      SELECT s.workspace_id,gen_random_uuid(),s.actor_user_id,s.reservation_id,s.expires_at,$2,
       CASE WHEN $3 THEN s.audio_test_request_id ELSE NULL END,CASE WHEN $4 THEN $5::uuid ELSE NULL END
       FROM call_sessions s WHERE s.id=$1`,
    [placed.sessionId, purpose, request, firm, world.crm.alpha.firmId])).rejects.toMatchObject({ code: '23514' });
  });

  it('observes the actual shared-gate wait and refuses a short original request after its deadline', async () => {
    const fixture = await audioTestPgInsertHistory(world, { lifetimeMilliseconds: 1000 });
    const waiterPid = (await world.runtime.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const blockerPid = (await world.blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await world.blocker.query('BEGIN');
    await world.blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [sendGateLockName(world.seed.beta.workspaceId)]);
    const pending = withTransaction(world.runtime, () => consumeCallSession(world.runtime, {
      workspaceId: world.seed.beta.workspaceId, sessionId: fixture.sessionId, callSid: audioTestPgSid(),
      identity: `client:${world.seed.beta.admin.userId}`, configuredCallerIdE164: AUDIO_TEST_PG_CALLER,
    }));
    const observed = pending.then(value => ({ value }), error => ({ error }));
    try {
      await audioTestPgWaitForBlock(world.database.session, waiterPid, blockerPid);
      for (let n = 0; n < 200; n += 1) {
        if ((await world.database.session.query<{ expired: boolean }>('SELECT expires_at<=clock_timestamp() AS expired FROM call_sessions WHERE id=$1', [fixture.sessionId])).rows[0]?.expired) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } finally { await world.blocker.query('COMMIT'); }
    expect(await observed).toEqual({ value: { ok: false, reason: 'session_expired' } });
    expect((await world.runtime.query('SELECT consumed_at,twilio_call_sid FROM call_sessions WHERE id=$1', [fixture.sessionId])).rows).toEqual([{ consumed_at: null, twilio_call_sid: null }]);
    await withTransaction(world.runtime, () => sweepCallSessionReservations(world.admin('beta')));
    expect((await world.runtime.query('SELECT e164 FROM browser_audio_test_requests WHERE id=$1', [fixture.requestId])).rows).toEqual([{ e164: null }]);
  });

  it('observes owner OFF committing ahead of a blocked consume and retains the unconsumed reservation', async () => {
    const created = await withTransaction(world.runtime, () => createAudioTestSession(world.admin('beta'), world.input('beta')));
    if (!created.ok) throw new Error(created.reason);
    const waiterPid = (await world.runtime.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const blockerPid = (await world.blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await world.blocker.query('BEGIN');
    await world.blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [sendGateLockName(world.seed.beta.workspaceId)]);
    const pending = withTransaction(world.runtime, () => consumeCallSession(world.runtime, {
      workspaceId: world.seed.beta.workspaceId, sessionId: created.value.sessionId, callSid: audioTestPgSid(),
      identity: `client:${world.seed.beta.admin.userId}`, configuredCallerIdE164: AUDIO_TEST_PG_CALLER,
    }));
    const observed = pending.then(value => ({ value }), error => ({ error }));
    try {
      await audioTestPgWaitForBlock(world.database.session, waiterPid, blockerPid);
      await world.setting('beta', 'calling_provider', { provider: 'tel' }, world.blocker);
    } finally { await world.blocker.query('COMMIT'); }
    expect(await observed).toEqual({ value: { ok: false, reason: 'scoped_pause' } });
    expect((await world.runtime.query(`SELECT s.consumed_at,r.state FROM call_sessions s JOIN provider_reservations r
      ON r.workspace_id=s.workspace_id AND r.id=s.reservation_id WHERE s.id=$1`, [created.value.sessionId])).rows)
      .toEqual([{ consumed_at: null, state: 'reserved' }]);
    expect(await audioTestPgBusinessSnapshot(world.runtime, world.seed.alpha.workspaceId, world.legacyIds)).toEqual(world.before);
  });
});
