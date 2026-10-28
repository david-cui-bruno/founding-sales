import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {createCallSession} from '../../calls/sessions.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {seedCrm,type SeededCrm} from '../db/support/crmFixtures.ts';
import {seedPolicy,type SeededPolicy} from '../db/support/policyFixtures.ts';

let db:TestDatabase,runtime:SessionQueryable,seed:TwoWorkspaces,crm:SeededCrm,policy:SeededPolicy;
beforeEach(async()=>{
 db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);crm=await seedCrm(db.session,seed);
 policy=await seedPolicy(db.session,seed,crm,{registry:false});
 await db.session.query(`INSERT INTO workspace_settings(workspace_id,setting_key,version,value,changed_by_user_id)
  VALUES($1,'telephony_budget',1,$2::jsonb,$3)`,[seed.alpha.workspaceId,JSON.stringify({dailyCeilingCents:500,maxMinutesPerCall:30,unitPriceMicros:14000}),seed.alpha.admin.userId]);
 runtime=await db.appRuntimeSession();
});
afterEach(async()=>{await db?.drop();});

it('refuses browser session creation without exact current registry clearance before reserving anything',async()=>{
 const context=repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.salesperson.userId,role:'salesperson'}),runtime);
 const answer=await withTransaction(runtime,()=>createCallSession(context,{
  firmId:crm.alpha.firmId,routeId:policy.alpha.phoneRouteId,routeVersion:policy.alpha.phoneRouteVersion,
  callingIdentityId:policy.alpha.callingIdentityId,deviceId:seed.alpha.salesperson.deviceId,commandId:randomUUID(),
  configuredCallerIdE164:'+14015550100',at:policy.insideWindow,
 }));
 expect(answer).toEqual({ok:false,reason:'dnc_coverage_unknown'});
 for(const table of ['dial_tickets','call_sessions','provider_reservations']){
  expect((await db.session.query<{count:string}>(`SELECT count(*) FROM ${table} WHERE workspace_id=$1`,[seed.alpha.workspaceId])).rows[0]?.count).toBe('0');
 }
});

async function publish(result: 'clear' | 'match' = 'clear', downloadedAt?: string) {
 const now=(await db.session.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at.toISOString();
 const {publishTestRegistrySnapshot}=await import('../support/nationalRegistry.ts');
 return await publishTestRegistrySnapshot(db.session,seed.alpha.workspaceId,{
  downloadedAt:downloadedAt??now,publishedAt:now,e164s:[{e164:policy.alpha.e164,result}],
 });
}
function context(){return repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.salesperson.userId,role:'salesperson'}),runtime);}
async function create(){return await withTransaction(runtime,()=>createCallSession(context(),{
 firmId:crm.alpha.firmId,routeId:policy.alpha.phoneRouteId,routeVersion:policy.alpha.phoneRouteVersion,
 callingIdentityId:policy.alpha.callingIdentityId,deviceId:seed.alpha.salesperson.deviceId,commandId:randomUUID(),
 configuredCallerIdE164:'+14015550100',at:policy.insideWindow,
}));}
async function consume(sessionId:string){
 const {consumeCallSession}=await import('../../calls/sessions.ts');
 return await withTransaction(runtime,()=>consumeCallSession(runtime,{workspaceId:seed.alpha.workspaceId,sessionId,
  callSid:`CA${randomUUID().replaceAll('-','')}`,identity:`client:${seed.alpha.salesperson.userId}`,at:policy.insideWindow}));
}
async function issued(){const answer=await create();expect(answer.ok).toBe(true);if(!answer.ok)throw new Error('fixture did not issue');return answer.value;}
async function unconsumed(sessionId:string){
 const rows=await db.session.query(`SELECT s.consumed_at,t.consumed_at AS ticket_consumed,r.state FROM call_sessions s
 JOIN dial_tickets t ON t.workspace_id=s.workspace_id AND t.id=s.ticket_id
 JOIN provider_reservations r ON r.workspace_id=s.workspace_id AND r.id=s.reservation_id
 WHERE s.workspace_id=$1 AND s.id=$2`,[seed.alpha.workspaceId,sessionId]);
 expect(rows.rows).toEqual([{consumed_at:null,ticket_consumed:null,state:'reserved'}]);
}

it('allows current clearance despite the historical policy clock, then consumes only once',async()=>{
 await publish();const session=await issued();
 expect((await consume(session.sessionId)).ok).toBe(true);
 expect(await consume(session.sessionId)).toEqual({ok:false,reason:'already_consumed'});
});
it.each(['match','revoked','expired','newer_revoked'] as const)('refuses %s registry evidence at creation',async(kind)=>{
 const download=kind==='expired'?new Date(Date.now()-32*86_400_000).toISOString():undefined;
 const snapshot=await publish(kind==='match'?'match':'clear',download);
 if(kind==='revoked')await db.session.query('UPDATE national_registry_snapshots SET revoked_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',[seed.alpha.workspaceId,snapshot]);
 if(kind==='newer_revoked'){
  const latest=await publish();await db.session.query('UPDATE national_registry_snapshots SET revoked_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',[seed.alpha.workspaceId,latest]);
 }
 expect(await create()).toEqual({ok:false,reason:kind==='match'?'dnc_registry_match':'dnc_coverage_unknown'});
 expect((await db.session.query('SELECT id FROM call_sessions WHERE workspace_id=$1',[seed.alpha.workspaceId])).rows).toHaveLength(0);
});
it.each(['match','revoked','expired','missing'] as const)('rechecks %s evidence before provider handoff and preserves the reservation',async(kind)=>{
 const snapshot=await publish();const session=await issued();
 if(kind==='match')await publish('match');
 if(kind==='revoked')await db.session.query('UPDATE national_registry_snapshots SET revoked_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',[seed.alpha.workspaceId,snapshot]);
 if(kind==='expired')await publish('clear',new Date(Date.now()-32*86_400_000).toISOString());
 if(kind==='missing')await db.session.query('DELETE FROM national_registry_endpoint_scrubs WHERE workspace_id=$1 AND snapshot_id=$2',[seed.alpha.workspaceId,snapshot]);
 expect(await consume(session.sessionId)).toEqual({ok:false,reason:kind==='match'?'dnc_registry_match':'dnc_coverage_unknown'});
 await unconsumed(session.sessionId);
});
it('caps the original ticket/session to registry expiry and never extends it with newer evidence',async()=>{
 const download=new Date(Date.now()-31*86_400_000+10_000).toISOString();await publish('clear',download);
 const session=await issued();expect(Date.parse(session.expiresAt)).toBe(Date.parse(download)+31*86_400_000);
 await db.session.query("UPDATE dial_tickets SET issued_at=clock_timestamp()-interval '2 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1",[seed.alpha.workspaceId]);
 await publish();expect(await consume(session.sessionId)).toEqual({ok:false,reason:'ticket_expired'});await unconsumed(session.sessionId);
});
it('preserves personal-cell restriction from an alternate route at another firm with the same endpoint',async()=>{
 await publish();const session=await issued();
 const other=(await db.session.query<{id:string}>("INSERT INTO firms(workspace_id,name) VALUES($1,'Other fictional firm') RETURNING id",[seed.alpha.workspaceId])).rows[0]!.id;
 await db.session.query(`INSERT INTO phone_routes(workspace_id,firm_id,e164,source,technical_validation,eligibility,version,retrieved_at,known_personal_cell_at)
 VALUES($1,$2,$3,'salesperson','passed','usable',1,clock_timestamp(),clock_timestamp())`,[seed.alpha.workspaceId,other,policy.alpha.e164]);
 expect(await create()).toEqual({ok:false,reason:'route_invalid'});
 expect(await consume(session.sessionId)).toEqual({ok:false,reason:'route_invalid'});await unconsumed(session.sessionId);
});

it.each(['creation','consumption','session_expiry'] as const)('undoes all %s effects when a real audit-lock wait crosses the applicable expiry',async(stage)=>{
 let sessionId:string|undefined;
 if(stage!=='creation'){await publish();sessionId=(await issued()).sessionId;}
 const download=new Date(Date.now()-(stage==='session_expiry'?0:31*86_400_000-2000)).toISOString();
 await publish('clear',download);
 let deadline=new Date(Date.parse(download)+31*86_400_000).toISOString();
 if(stage==='session_expiry')deadline=(await db.session.query<{expires_at:Date}>("UPDATE call_sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1 RETURNING expires_at",[sessionId])).rows[0]!.expires_at.toISOString();
 const action=stage==='creation'?'call.session_authorized':'call.session_placed';
 await db.session.query(`CREATE FUNCTION fixture_execution_audit_wait() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN IF NEW.action='${action}' THEN PERFORM pg_advisory_xact_lock(820821); END IF; RETURN NEW; END $$`);
 await db.session.query('CREATE TRIGGER fixture_execution_audit_wait AFTER INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fixture_execution_audit_wait()');
 await db.session.query('BEGIN');
 await db.session.query('SELECT pg_advisory_xact_lock(820821)');
 const pending=stage==='creation'?create():consume(sessionId!);
 let waited=false;
 try{
  for(let attempt=0;attempt<100;attempt++){
   waited=(await db.session.query<{waiting:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
    WHERE pg_backend_pid()=ANY(pg_blocking_pids(pid))) AS waiting`)).rows[0]!.waiting;
   if(waited)break;
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  if(waited)await db.session.query("SELECT pg_sleep(GREATEST(0,extract(epoch FROM $1::timestamptz-clock_timestamp()))+0.02)",[deadline]);
 }finally{await db.session.query('COMMIT');}
 const answer=await pending;
 expect(waited,'the command really reached the final audit write and waited').toBe(true);
 expect(answer).toEqual({ok:false,reason:stage==='session_expiry'?'ticket_expired':'dnc_coverage_unknown'});
 if(stage!=='creation')await unconsumed(sessionId!);
 else for(const table of ['dial_tickets','call_sessions','provider_reservations']){
  expect((await db.session.query(`SELECT id FROM ${table} WHERE workspace_id=$1`,[seed.alpha.workspaceId])).rows).toHaveLength(0);
 }
 expect((await db.session.query("SELECT id FROM audit_events WHERE workspace_id=$1 AND action=$2",[seed.alpha.workspaceId,action])).rows).toHaveLength(0);
});
