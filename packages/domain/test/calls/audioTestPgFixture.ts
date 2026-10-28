import { randomBytes, randomUUID } from 'node:crypto';
import type { StoredSettingKey } from '@fss/contracts';
import { createTestDatabase } from '../../db/testing/testDatabase.ts';
import { applyMigrations, readAppliedSchemaVersion } from '../../db/migrationRunner.ts';
import { withTransaction, type SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { updateSetting } from '../../settings/store.ts';
import { createAudioTestSession } from '../../calls/audioTest.ts';
import { consumeCallSession, recordCallRecording, recordCallStatus } from '../../calls/sessions.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedPolicy, type SeededPolicy } from '../db/support/policyFixtures.ts';

export const AUDIO_TEST_PG_DESTINATION = '+14015550199';
export const AUDIO_TEST_PG_CALLER = '+14015550101';
export const audioTestPgSid = () => `CA${randomBytes(16).toString('hex')}`;

async function legacyBusinessRows(db: SessionQueryable, seed: TwoWorkspaces, crm: SeededCrm, policy: SeededPolicy) {
  const w = seed.alpha.workspaceId, actor = seed.alpha.salesperson.userId;
  const ids: string[] = [];
  for (const completed of [false, true]) {
    const sessionId = randomUUID(), ticketId = randomUUID(), reservationId = randomUUID();
    const callLogId = completed ? randomUUID() : null;
    // Deliberately use schema144 SQL, because current browser source requires145.
    await db.query(`INSERT INTO dial_tickets
      (workspace_id,id,command_id,firm_id,contact_id,phone_route_id,route_version,posture_id,posture_revision,
       calling_identity_id,actor_user_id,device_id,assigned_user_id,e164,firm_time_zone,issued_at,expires_at,consumed_at)
      VALUES($1,$2,$3,$4,$5,$6,1,$7,1,$8,$9,$10,$9,$11,'America/New_York',
       clock_timestamp()-INTERVAL '2 days',clock_timestamp()-INTERVAL '2 days'+INTERVAL '50 seconds',
       CASE WHEN $12 THEN clock_timestamp()-INTERVAL '2 days'+INTERVAL '1 second' ELSE NULL END)`,
    [w, ticketId, randomUUID(), crm.alpha.firmId, crm.alpha.contactId, policy.alpha.phoneRouteId,
      policy.alpha.postureId, policy.alpha.callingIdentityId, actor, seed.alpha.salesperson.deviceId, policy.alpha.e164, completed]);
    await db.query(`INSERT INTO provider_reservations
      (workspace_id,id,provider_key,subject_kind,subject_id,attempt,business_date,business_time_zone,cents,
       priced_unit,max_units,unit_price_micros,state,settled_cents,settled_at)
      VALUES($1,$2,'twilio.voice','call_session',$3,1,(clock_timestamp()-INTERVAL '2 days')::date,
       'America/New_York',2,'minute',1,14000,$4,$5,CASE WHEN $6 THEN clock_timestamp() ELSE NULL END)`,
    [w, reservationId, sessionId, completed ? 'settled' : 'reserved', completed ? 2 : 0, completed]);
    if (callLogId) await db.query(`INSERT INTO call_logs(workspace_id,id,firm_id,contact_id,outcome,step_effect,occurred_at,actor_user_id,note)
      VALUES($1,$2,$3,$4,'not_interested','none',clock_timestamp()-INTERVAL '2 days',$5,'Synthetic retained business history')`,
    [w, callLogId, crm.alpha.firmId, crm.alpha.contactId, actor]);
    await db.query(`INSERT INTO call_sessions
      (workspace_id,id,ticket_id,firm_id,contact_id,actor_user_id,reservation_id,status,twilio_call_sid,expires_at,
       consumed_at,started_at,answered_at,ended_at,duration_seconds,recording_sid,recording_path,recording_duration_seconds,call_log_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()-INTERVAL '2 days'+INTERVAL '50 seconds',
       CASE WHEN $10 THEN clock_timestamp()-INTERVAL '2 days'+INTERVAL '1 second' ELSE NULL END,
       CASE WHEN $10 THEN clock_timestamp()-INTERVAL '2 days'+INTERVAL '1 second' ELSE NULL END,
       CASE WHEN $10 THEN clock_timestamp()-INTERVAL '2 days'+INTERVAL '2 seconds' ELSE NULL END,
       CASE WHEN $10 THEN clock_timestamp()-INTERVAL '2 days'+INTERVAL '45 seconds' ELSE NULL END,
       CASE WHEN $10 THEN 43 ELSE NULL END,$11,$12,CASE WHEN $10 THEN 43 ELSE NULL END,$13)`,
    [w, sessionId, ticketId, crm.alpha.firmId, crm.alpha.contactId, actor, reservationId, completed ? 'completed' : 'authorized',
      completed ? audioTestPgSid() : null, completed, completed ? `RE${randomBytes(16).toString('hex')}` : null,
      completed ? '/2010-04-01/Accounts/ACfixture/Recordings/REfixture' : null, callLogId]);
    if (completed) await db.query(`INSERT INTO call_transcripts(workspace_id,call_session_id,provider,model,language,duration_seconds,utterances)
      VALUES($1,$2,'deepgram','nova-3','en',43,'[{"speaker":0,"start":0,"end":1,"text":"Synthetic retained transcript"}]'::jsonb)`, [w, sessionId]);
    ids.push(sessionId);
  }
  return ids;
}

export async function audioTestPgBusinessSnapshot(db: SessionQueryable, workspaceId: string, sessionIds: readonly string[]) {
  return (await db.query<{ snapshot: unknown }>(`SELECT jsonb_build_object(
    'sessions',(SELECT jsonb_agg(to_jsonb(s)-ARRAY['purpose','audio_test_request_id'] ORDER BY s.id)
      FROM call_sessions s WHERE s.workspace_id=$1 AND s.id=ANY($2::uuid[])),
    'tickets',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM dial_tickets t WHERE t.workspace_id=$1),
    'logs',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM call_logs l WHERE l.workspace_id=$1),
    'transcripts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.call_session_id) FROM call_transcripts t WHERE t.workspace_id=$1),
    'reservations',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM provider_reservations r
      WHERE r.workspace_id=$1 AND r.subject_id=ANY($2::uuid[]))) AS snapshot`, [workspaceId, sessionIds])).rows[0]!.snapshot;
}

export async function audioTestPgWorld() {
  const database = await createTestDatabase({ throughVersion: 144 });
  console.info('AUDIO_TEST_PG_DATABASE_REGISTERED', database.name);
  try {
    if (await readAppliedSchemaVersion(database.session) !== 144) throw new Error('audio test fixture must start at144');
    const seed = await seedTwoWorkspaces(database.session), crm = await seedCrm(database.session, seed);
    const policy = await seedPolicy(database.session, seed, crm, { registry: false });
    const legacyIds = await legacyBusinessRows(database.session, seed, crm, policy);
    const before = await audioTestPgBusinessSnapshot(database.session, seed.alpha.workspaceId, legacyIds);
    await applyMigrations(database.session, { throughVersion: 145 });
    const runtime = await database.appRuntimeSession(), blocker = await database.appRuntimeSession();
    const admin = (workspace: 'alpha' | 'beta', db: SessionQueryable = runtime) => repositoryContext(
      workspaceScope(seed[workspace].workspaceId, { kind: 'user', userId: seed[workspace].admin.userId, role: 'admin' }), db);
    const setting = async (workspace: 'alpha' | 'beta', settingKey: StoredSettingKey, value: unknown, db: SessionQueryable = runtime) => {
      const saved = await updateSetting(admin(workspace, db), { settingKey, value });
      if (!saved.ok) throw new Error(saved.reason);
    };
    for (const workspace of ['alpha', 'beta'] as const) await withTransaction(runtime, async () => {
      await setting(workspace, 'calling_provider', { provider: 'twilio' });
      await setting(workspace, 'telephony_budget', { dailyCeilingCents: 500, maxMinutesPerCall: 30, unitPriceMicros: 14000 });
      await setting(workspace, 'call_transcription', { enabled: true, dailyCeilingCents: 100, unitPriceMicros: 1000 });
    });
    await database.session.query(`INSERT INTO heartbeats(component,instance_key,observed_at,detail)
      VALUES('worker','audio-test-pg-fixture',clock_timestamp(),'{"call_transcribe":true}'::jsonb)`);
    const input = (workspace: 'alpha' | 'beta', commandId = randomUUID()) => ({ e164: AUDIO_TEST_PG_DESTINATION,
      callingIdentityId: policy[workspace].otherCallingIdentityId, deviceId: seed[workspace].admin.deviceId,
      commandId, configuredCallerIdE164: AUDIO_TEST_PG_CALLER });
    return { database, seed, crm, policy, legacyIds, before, runtime, blocker, admin, setting, input };
  } catch (error) { await database.drop(); throw error; }
}
export type AudioTestPgWorld = Awaited<ReturnType<typeof audioTestPgWorld>>;

export async function audioTestPgPlace(world: AudioTestPgWorld) {
  const input = world.input('alpha'), payloadSHA256 = 'a'.repeat(64);
  const created = await withTransaction(world.runtime, () => createAudioTestSession(world.admin('alpha'), input));
  if (!created.ok) throw new Error(created.reason);
  const sessionId = created.value.sessionId, callSid = audioTestPgSid();
  await world.runtime.query(`INSERT INTO command_receipts(workspace_id,device_id,command_id,command_kind,payload_hash,result_status,result)
    VALUES($1,$2,$3,'create_audio_test_session',$4,'accepted',$5::jsonb)`,
  [world.seed.alpha.workspaceId, input.deviceId, input.commandId, payloadSHA256, JSON.stringify(created.value)]);
  const consumed = await withTransaction(world.runtime, () => consumeCallSession(world.runtime, {
    workspaceId: world.seed.alpha.workspaceId, sessionId, callSid, identity: `client:${world.seed.alpha.admin.userId}`,
    configuredCallerIdE164: AUDIO_TEST_PG_CALLER,
  }));
  if (!consumed.ok) throw new Error(consumed.reason);
  await withTransaction(world.runtime, () => recordCallStatus(world.runtime, { callSid, providerStatus: 'in-progress' }));
  const recording = await withTransaction(world.runtime, () => recordCallRecording(world.runtime, {
    callSid, recordingSid: `RE${randomBytes(16).toString('hex')}`,
    recordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/ACfixture/Recordings/REaudio', durationSeconds: 45,
  }));
  const terminal = await withTransaction(world.runtime, () => recordCallStatus(world.runtime,
    { callSid, providerStatus: 'completed', durationSeconds: 45, priceDollars: -0.02 }));
  return { sessionId, callSid, created: created.value, consumed: consumed.value, recording, terminal,
    receipt: { commandId: input.commandId, payloadSHA256 } };
}

/** Historical/short-lived rows are SQL fixtures, never a production time override or a reset of an existing call. */
export async function audioTestPgInsertHistory(world: AudioTestPgWorld, options: {
  readonly daysAgo?: number; readonly lifetimeMilliseconds?: number; readonly consumed?: boolean; readonly unknown?: boolean;
  readonly workspace?: 'alpha' | 'beta'; readonly actor?: 'admin' | 'salesperson';
}) {
  const workspace = options.workspace ?? 'beta', member = options.actor ?? 'admin';
  const db = world.runtime, w = world.seed[workspace].workspaceId, actor = world.seed[workspace][member].userId;
  const requestId = randomUUID(), sessionId = randomUUID(), reservationId = randomUUID(), callSid = audioTestPgSid();
  const at = (await db.query<{ at: string }>("SELECT (clock_timestamp()-make_interval(days=>$1))::text AS at", [options.daysAgo ?? 0])).rows[0]!.at;
  const request = (await db.query<{ expires_at: Date }>(`INSERT INTO browser_audio_test_requests
    (workspace_id,id,actor_user_id,device_id,calling_identity_id,command_id,e164,created_at,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$8::timestamptz+($9::int*INTERVAL '1 millisecond')) RETURNING expires_at`,
  [w, requestId, actor, world.seed[workspace][member].deviceId,
    member === 'admin' ? world.policy[workspace].otherCallingIdentityId : world.policy[workspace].callingIdentityId, randomUUID(),
    AUDIO_TEST_PG_DESTINATION, at, options.lifetimeMilliseconds ?? 60000])).rows[0]!;
  await db.query(`INSERT INTO provider_reservations
    (workspace_id,id,provider_key,subject_kind,subject_id,attempt,business_date,business_time_zone,cents,
     priced_unit,max_units,unit_price_micros,state,settled_cents,settled_at)
    VALUES($1,$2,'twilio.voice','call_session',$3,1,($4::timestamptz AT TIME ZONE 'America/New_York')::date,
     'America/New_York',2,'minute',1,14000,$5,$6,CASE WHEN $7 THEN clock_timestamp() ELSE NULL END)`,
  [w, reservationId, sessionId, at, options.consumed ? options.unknown ? 'estimated' : 'settled' : 'reserved', options.consumed ? 2 : 0, options.consumed === true]);
  await db.query(`INSERT INTO call_sessions
    (workspace_id,id,actor_user_id,reservation_id,expires_at,purpose,audio_test_request_id,consumed_at,twilio_call_sid,status,ended_at)
    VALUES($1,$2,$3,$4,$5,'audio_test',$6,CASE WHEN $7 THEN $8::timestamptz ELSE NULL END,
     CASE WHEN $7 THEN $9 ELSE NULL END,$10,CASE WHEN $7 AND NOT $11 THEN $8::timestamptz ELSE NULL END)`,
  [w, sessionId, actor, reservationId, request.expires_at, requestId, options.consumed === true, at, callSid,
    options.consumed && !options.unknown ? 'completed' : 'authorized', options.unknown === true]);
  return { sessionId, requestId, reservationId, expiresAt: request.expires_at };
}

/** Observe an actual row/advisory wait; a timer alone is not lock evidence. */
export async function audioTestPgWaitForBlock(observer: SessionQueryable, waiterPid: number, blockerPid: number): Promise<void> {
  for (let n = 0; n < 200; n += 1) {
    const blocked = (await observer.query<{ blocked: boolean }>(
      'SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked', [waiterPid, blockerPid])).rows[0]?.blocked;
    if (blocked) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('expected actual audio test PostgreSQL lock wait was not observed');
}
