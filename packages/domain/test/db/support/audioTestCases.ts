import { randomUUID } from 'node:crypto';
import type { SessionQueryable } from '../../../db/queryable.ts';
import type { TwoWorkspaces } from './fixtures.ts';
import type { SeededCrm } from './crmFixtures.ts';
import { seedPolicy } from './policyFixtures.ts';

type Fixture = { readonly session: SessionQueryable; readonly seeded: TwoWorkspaces; readonly crm: SeededCrm; readonly holdId: string };
type Row = Record<string, unknown>;
type Case = { readonly constraint: string; readonly error?: { readonly code: string; readonly message: string }; readonly run: (fixture: Fixture) => Promise<unknown> };
const absent = '00000000-0000-4000-8000-000000000145';
const runtime = (f: Fixture) => f.session.query('SET LOCAL ROLE app_runtime');
const insert = (f: Fixture, table: string, row: Row) => f.session.query(
  `INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row));

async function requestRow(f: Fixture): Promise<Row> {
  const identity = (await f.session.query<{ id: string }>(`INSERT INTO calling_identities(workspace_id,owner_user_id,e164)
    VALUES($1,$2,'+14015550103') RETURNING id`, [f.seeded.alpha.workspaceId, f.seeded.alpha.admin.userId])).rows[0]!.id;
  const now = new Date();
  return { workspace_id: f.seeded.alpha.workspaceId, id: randomUUID(), actor_user_id: f.seeded.alpha.admin.userId,
    device_id: f.seeded.alpha.admin.deviceId, calling_identity_id: identity, command_id: randomUUID(),
    e164: '+14015550199', created_at: now, expires_at: new Date(now.getTime() + 60000) };
}

const badRequest = (constraint: string, patch: Row | ((f: Fixture, row: Row) => Row)): Case => ({ constraint, run: async f => {
  const row = await requestRow(f);
  await runtime(f);
  return insert(f, 'browser_audio_test_requests', { ...row, ...(typeof patch === 'function' ? patch(f, row) : patch) });
} });

async function sessionRow(f: Fixture): Promise<Row> {
  const request = await requestRow(f), id = randomUUID();
  await insert(f, 'browser_audio_test_requests', request);
  const reservation = (await f.session.query<{ id: string }>(`INSERT INTO provider_reservations
    (workspace_id,provider_key,subject_kind,subject_id,attempt,business_date,business_time_zone,cents,priced_unit,max_units,unit_price_micros)
    VALUES($1,'twilio.voice','call_session',$2,1,CURRENT_DATE,'America/New_York',2,'minute',1,14000) RETURNING id`,
  [f.seeded.alpha.workspaceId, id])).rows[0]!.id;
  return { workspace_id: request['workspace_id'], id, actor_user_id: request['actor_user_id'], reservation_id: reservation,
    expires_at: request['expires_at'], purpose: 'audio_test', audio_test_request_id: request['id'] };
}

/** Only this privileged, rolled-back catalog setup isolates the new BEFORE guard
 * when it would preempt the named declarative FK. The target FK, all other
 * constraints and all deferred guards stay enabled. Every failing DML is app_runtime.
 * Real lifecycle/DELETE/reset cases keep the guard enabled in audioTestPg.test.ts. */
async function isolateSessionGuard(f: Fixture): Promise<void> {
  await f.session.query('ALTER TABLE call_sessions DISABLE TRIGGER call_session_purpose_guard');
}

export const AUDIO_TEST_CONSTRAINT_CASES: readonly Case[] = [
  { constraint: 'browser_audio_test_requests_pkey', run: async f => {
    const row = await requestRow(f); await runtime(f);
    await insert(f, 'browser_audio_test_requests', row);
    return insert(f, 'browser_audio_test_requests', { ...row, command_id: randomUUID() });
  } },
  { constraint: 'browser_audio_test_requests_workspace_id_device_id_command__key', run: async f => {
    const row = await requestRow(f); await runtime(f);
    await insert(f, 'browser_audio_test_requests', row);
    return insert(f, 'browser_audio_test_requests', { ...row, id: randomUUID() });
  } },
  badRequest('browser_audio_test_requests_workspace_id_fkey', { workspace_id: absent }),
  badRequest('browser_audio_test_requests_workspace_id_actor_user_id_fkey', f => ({ actor_user_id: f.seeded.beta.admin.userId })),
  badRequest('browser_audio_test_requests_workspace_id_device_id_fkey', f => ({ device_id: f.seeded.beta.admin.deviceId })),
  badRequest('browser_audio_test_requests_workspace_id_calling_identity__fkey', { calling_identity_id: absent }),
  badRequest('browser_audio_test_requests_command_id_check', { command_id: 'invalid command' }),
  badRequest('browser_audio_test_requests_check', (_f, row) => ({ expires_at: new Date((row['created_at'] as Date).getTime() + 61000) })),
  badRequest('browser_audio_test_requests_check1', { e164: null }),
  { constraint: 'call_sessions_audio_test_request_fkey', run: async f => {
    const row = await sessionRow(f);
    await isolateSessionGuard(f); await runtime(f);
    return insert(f, 'call_sessions', { ...row, audio_test_request_id: absent });
  } },
  { constraint: 'call_sessions_one_per_audio_test', run: async f => {
    const row = await sessionRow(f); await runtime(f);
    await insert(f, 'call_sessions', row);
    return insert(f, 'call_sessions', { ...row, id: randomUUID() });
  } },
  { constraint: 'call_sessions_purpose_shape', run: async f => {
    const row = await sessionRow(f); await runtime(f);
    // INSERT business with no Firm/ticket: the new BEFORE guard does not preempt this CHECK.
    return insert(f, 'call_sessions', { ...row, purpose: 'business', audio_test_request_id: null });
  } },
  { constraint: 'dial_tickets_posture_pair', run: async f => {
    const policy = await seedPolicy(f.session, f.seeded, f.crm, { registry: false });
    await runtime(f);
    return f.session.query(`INSERT INTO dial_tickets
      (workspace_id,command_id,firm_id,phone_route_id,route_version,posture_id,posture_revision,calling_identity_id,
       actor_user_id,device_id,assigned_user_id,e164,firm_time_zone,issued_at,expires_at)
      VALUES($1,$2,$3,$4,1,NULL,1,$5,$6,$7,$6,$8,'America/New_York',now(),now()+INTERVAL '60 seconds')`,
    [f.seeded.alpha.workspaceId, randomUUID(), f.crm.alpha.firmId, policy.alpha.phoneRouteId,
      policy.alpha.callingIdentityId, f.seeded.alpha.salesperson.userId, f.seeded.alpha.salesperson.deviceId, policy.alpha.e164]);
  } },
];
