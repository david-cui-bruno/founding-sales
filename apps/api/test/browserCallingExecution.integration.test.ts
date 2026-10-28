import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { publishTestRegistrySnapshot } from '@fss/domain/test/support/nationalRegistry.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { settingLockName, updateSetting } from '@fss/domain/settings/store.ts';
import {sendGateLockName} from '@fss/domain/policy/sendGate.ts';
import type {SessionQueryable} from '@fss/domain/db/queryable.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedContact, seedFirm } from './support/crmSeed.ts';
import { PUBLIC_ORIGIN, startIntegrationServer, type IntegrationServer } from './support/integrationServer.ts';

let fixture: AuthFixture, server: IntegrationServer;
let salesperson: Awaited<ReturnType<typeof issueSessionFor>>, admin: string, firmId: string, routeId: string, identityId: string;
let providerReadBarrier:((db:SessionQueryable)=>Promise<void>)|undefined;
const phone = '+14015550187';
const command = (input: Record<string, unknown>) => ({ commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, ...input });
async function post(path: string, token: string, body: unknown) {
  const response = await fetch(`${server.origin}${path}`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
const result = (answer: { body: Record<string, unknown> }) => answer.body['result'] as Record<string, unknown>;
const sessionBody = () => command({ firmId, routeId, routeVersion: 1, callingIdentityId: identityId });
async function issue() {
  const answer = await post('/calls/session', salesperson.accessToken, sessionBody());
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return String(result(answer)['sessionId']);
}
async function voice(sessionId: string) {
  const path = '/integrations/twilio/voice';
  const params = { AccountSid: server.accountSid, CallSid: `CA${randomUUID().replaceAll('-', '')}`,
    From: `client:${fixture.alpha.salesperson.userId}`, sessionId };
  const response = await fetch(`${server.origin}${path}`, { method: 'POST', headers: {
    'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': server.twilioSign(`${PUBLIC_ORIGIN}${path}`, params),
  }, body: new URLSearchParams(params).toString() });
  return await response.text();
}
async function publish(freshMilliseconds = 31 * 86_400_000) {
  const at = (await fixture.db.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]!.at;
  const download = new Date(at.getTime() - 31 * 86_400_000 + freshMilliseconds);
  await publishTestRegistrySnapshot(fixture.db, fixture.alpha.workspaceId, {
    downloadedAt: download.toISOString(), publishedAt: at.toISOString(), e164s: [{ e164: phone, result: 'clear' }],
  });
  return new Date(download.getTime() + 31 * 86_400_000).toISOString();
}
beforeEach(async () => {
  fixture = await createAuthFixture(); providerReadBarrier=undefined;server = await startIntegrationServer(fixture,{callingProviderReadBarrier:async db=>{await providerReadBarrier?.(db);}});
  admin = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
  salesperson = await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson);
  for (const [settingKey, value] of [
    ['calling_provider', { provider: 'twilio' }],
    ['telephony_budget', { dailyCeilingCents: 500, maxMinutesPerCall: 30, unitPriceMicros: 14_000 }],
  ] as const) expect((await post('/settings/update', admin, command({ settingKey, value }))).status).toBe(200);
  firmId = await seedFirm(fixture, { name: 'Fictional Calling Firm', regionCode: 'RI', postalCode: '02903', assignedUserId: fixture.alpha.salesperson.userId });
  expect((await post('/firms/resolve-zone', admin, command({ firmId }))).status).toBe(200);
  const contactId = await seedContact(fixture, { firmId, fullName: 'Fictional Person' });
  const route = await post('/contacts/routes/add', salesperson.accessToken, command({ firmId, contactId,
    routeKind: 'phone', value: phone, source: 'salesperson', technicalValidation: 'passed', associationConfidence: 0.95 }));
  routeId = String(result(route)['id']);
  const identity = await post('/calling-identities/register', salesperson.accessToken, command({ e164: server.callerIdE164 }));
  identityId = String((result(identity)['identity'] as { id: string }).id);
  expect((await post('/postures/allow', admin, command({ states: ['RI'], confirmed: true }))).status).toBe(200);
});
afterEach(async () => { await server?.close(); await fixture?.stop(); });

async function counts() {
  return (await fixture.db.query(`SELECT (SELECT count(*) FROM call_sessions) AS sessions,
    (SELECT count(*) FROM dial_tickets) AS tickets,(SELECT count(*) FROM provider_reservations) AS reservations,
    (SELECT count(*) FROM command_receipts WHERE command_kind='create_call_session') AS receipts`)).rows[0];
}
async function blocked<T>(start: () => Promise<T>, lock: number | string, change: () => Promise<unknown>) {
  await fixture.db.query('BEGIN');
  const sql = typeof lock === 'number' ? 'SELECT pg_advisory_xact_lock($1)' : 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))';
  await fixture.db.query(sql, [lock]);
  const pending = start();
  let waited = false;
  try {
    for (let n = 0; n < 100; n++) {
      waited = (await fixture.db.query<{ waiting: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE pg_backend_pid()=ANY(pg_blocking_pids(pid))) AS waiting`)).rows[0]!.waiting;
      if (waited) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (waited) await change();
  } finally { await fixture.db.query('COMMIT'); }
  const answer = await pending;
  expect(waited, 'execution actually waited on the held lock').toBe(true);
  return answer;
}
async function receiptBarrier() {
  await fixture.db.query(`CREATE FUNCTION fixture_call_receipt_wait() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.command_kind='create_call_session' THEN PERFORM pg_advisory_xact_lock(820822); END IF; RETURN NEW; END $$`);
  await fixture.db.query('CREATE TRIGGER fixture_call_receipt_wait AFTER INSERT ON command_receipts FOR EACH ROW EXECUTE FUNCTION fixture_call_receipt_wait()');
}
it('refuses absent registry clearance through the actual HTTP route before any reservation', async () => {
  const before = await counts();
  const answer = await post('/calls/session', salesperson.accessToken, sessionBody());
  expect(answer.status).toBe(409); expect(answer.body).toMatchObject({ reason: 'dnc_coverage_unknown' });
  expect(await counts()).toEqual({ ...before, receipts: '1' });
});
it('rolls back the new capability and receipt when receipt insertion waits past clearance expiry', async () => {
  const deadline = await publish(2000); await receiptBarrier(); const before = await counts();
  const answer = await blocked(() => post('/calls/session', salesperson.accessToken, sessionBody()), 820822,
    () => fixture.db.query("SELECT pg_sleep(GREATEST(0,extract(epoch FROM $1::timestamptz-clock_timestamp()))+0.02)", [deadline]));
  expect(answer.status).toBe(409); expect(answer.body).toMatchObject({ reason: 'dnc_coverage_unknown' });
  expect(await counts()).toEqual(before);
});
it('rolls back when the original device is revoked during the receipt wait', async () => {
  await publish(); await receiptBarrier(); const before = await counts();
  const answer = await blocked(() => post('/calls/session', salesperson.accessToken, sessionBody()), 820822,
    () => fixture.db.query("UPDATE devices SET status='revoked',revoked_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2", [fixture.alpha.workspaceId, salesperson.deviceId]));
  expect(answer).toEqual({ status: 401, body: { error: 'session_changed' } }); expect(await counts()).toEqual(before);
});
it('accepted replay returns historical custody and creates no second reservation', async () => {
  await publish(); const body = sessionBody(); const first = await post('/calls/session', salesperson.accessToken, body);
  expect(first.status).toBe(200); const before = await counts();
  const replay = await post('/calls/session', salesperson.accessToken, body);
  expect(replay.body).toMatchObject({ replayed: true, result: result(first) }); expect(await counts()).toEqual(before);
});
it('refuses a revoked originating device at signed provider handoff', async () => {
  await publish(); const sessionId = await issue();
  await fixture.db.query("UPDATE devices SET status='revoked',revoked_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2", [fixture.alpha.workspaceId, salesperson.deviceId]);
  expect(await voice(sessionId)).not.toContain('<Dial');
  expect((await fixture.db.query('SELECT consumed_at FROM call_sessions WHERE id=$1', [sessionId])).rows[0]).toEqual({ consumed_at: null });
});
it.each(['creation', 'handoff'] as const)('honors an owner OFF committed during the %s setting-lock wait', async stage => {
  await publish(); const sessionId = stage === 'handoff' ? await issue() : null; const before = await counts();
  const answer = await blocked<string | Awaited<ReturnType<typeof post>>>(() => sessionId ? voice(sessionId) : post('/calls/session', salesperson.accessToken, sessionBody()),
    settingLockName(fixture.alpha.workspaceId, 'calling_provider'), async () => {
      const context = repositoryContext(workspaceScope(fixture.alpha.workspaceId,
        { kind: 'user', userId: fixture.alpha.admin.userId, role: 'admin' }), fixture.db);
      expect((await updateSetting(context, { settingKey: 'calling_provider', value: { provider: 'tel' } })).ok).toBe(true);
    });
  if (typeof answer === 'string') expect(answer).not.toContain('<Dial');
  else expect(answer.status).toBe(404);
  expect(await counts()).toEqual(before);
});
it.each(['creation','handoff'] as const)('owner OFF overlaps %s without a gate/provider deadlock or UNKNOWN',async stage=>{
  await publish();const sessionId=stage==='handoff'?await issue():null;
  let release!:()=>void;const paused=new Promise<void>(resolve=>{release=resolve;});let callPid:number|null=null;
  providerReadBarrier=async db=>{providerReadBarrier=undefined;callPid=(await db.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;await paused;};
  const call=stage==='handoff'?voice(sessionId!):post('/calls/session',salesperson.accessToken,sessionBody());
  let off:ReturnType<typeof post>|undefined,observationError:unknown;
  try{
    await expect.poll(()=>callPid,{timeout:3000}).not.toBeNull();
    off=post('/calling/setup/provider',admin,command({expectedVersion:1,provider:'tel'}));
    // The owner command must queue on the gate held by execution, never acquire
    // that gate while execution holds the provider and later queues behind it.
    await expect.poll(async()=>(await fixture.db.query<{gate:boolean}>(`SELECT
      classid::bigint=((hashtextextended($2,0)>>32)&4294967295) AND objid::bigint=(hashtextextended($2,0)&4294967295) AS gate
      FROM pg_locks WHERE locktype='advisory' AND NOT granted AND $1=ANY(pg_blocking_pids(pid))`,
      [callPid,sendGateLockName(fixture.alpha.workspaceId)])).rows,{timeout:3000}).toEqual([{gate:true}]);
  }catch(error){observationError=error;}finally{release();}
  const answers=await Promise.all([call,off]);if(observationError)throw observationError;
  if(stage==='handoff')expect(answers[0]).toContain('<Dial');else expect(answers[0]).toMatchObject({status:200,body:{status:'accepted',replayed:false}});
  expect(answers[1]).toMatchObject({status:200,body:{status:'accepted',result:{provider:'tel',version:2}}});
  expect((await fixture.db.query("SELECT value FROM workspace_settings WHERE workspace_id=$1 AND setting_key='calling_provider' AND superseded_at IS NULL",[fixture.alpha.workspaceId])).rows).toEqual([{value:{provider:'tel'}}]);
  const before=await counts();expect((await post('/calls/session',salesperson.accessToken,sessionBody())).status).toBe(404);if(sessionId)expect(await voice(sessionId)).not.toContain('<Dial');expect(await counts()).toEqual(before);
});
