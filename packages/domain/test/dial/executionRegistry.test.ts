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

it('issues and consumes once without a registry snapshot or scrub, using the original sixty-second deadline',async()=>{
 const native=runtime;runtime={query:(sql,values)=>{expect(sql).not.toMatch(/national_registry_snapshots/u);return native.query(sql,values);}};
 const {adviseBrowserDial}=await import('../../dial/advise.ts');const advice=await adviseBrowserDial(context(),{firmId:crm.alpha.firmId,routeId:policy.alpha.phoneRouteId,at:policy.insideWindow});expect(advice).toMatchObject({callable:true,reasons:[]});expect(advice).not.toHaveProperty('nationalDnc');
 const session=await issued();
 expect((await db.session.query('SELECT extract(epoch FROM (expires_at-issued_at))*1000 AS lifetime FROM dial_tickets WHERE id=(SELECT ticket_id FROM call_sessions WHERE id=$1)',[session.sessionId])).rows).toEqual([{lifetime:'60000.000000'}]);
 expect((await consume(session.sessionId)).ok).toBe(true);
 expect(await consume(session.sessionId)).toEqual({ok:false,reason:'already_consumed'});
 for(const table of ['national_registry_snapshots','national_registry_endpoint_scrubs'])expect((await db.session.query(`SELECT 1 FROM ${table}`)).rows).toHaveLength(0);
});
it.each(['revoked','expired','newer_revoked','missing'] as const)('does not turn %s registry coverage into a browser prerequisite',async kind=>{
 const snapshot=await publish('clear',kind==='expired'?new Date(Date.now()-32*86_400_000).toISOString():undefined);
 if(kind==='revoked')await db.session.query('UPDATE national_registry_snapshots SET revoked_at=clock_timestamp() WHERE id=$1',[snapshot]);
 if(kind==='newer_revoked'){const latest=await publish();await db.session.query('UPDATE national_registry_snapshots SET revoked_at=clock_timestamp() WHERE id=$1',[latest]);}
 if(kind==='missing')await db.session.query('DELETE FROM national_registry_endpoint_scrubs WHERE snapshot_id=$1',[snapshot]);
 expect((await consume((await issued()).sessionId)).ok).toBe(true);
});
it('keeps every retained known match restrictive even when revoked or superseded by a clear snapshot',async()=>{
 const session=await issued();const match=await publish('match',new Date(Date.now()-32*86_400_000).toISOString());
 await db.session.query('UPDATE national_registry_snapshots SET revoked_at=clock_timestamp() WHERE id=$1',[match]);await publish();
 const {adviseBrowserDial}=await import('../../dial/advise.ts');expect(await adviseBrowserDial(context(),{firmId:crm.alpha.firmId,routeId:policy.alpha.phoneRouteId,at:policy.insideWindow})).toMatchObject({callable:false,reasons:['dnc_registry_match']});
 expect(await create()).toEqual({ok:false,reason:'dnc_registry_match'});
 expect(await consume(session.sessionId)).toEqual({ok:false,reason:'dnc_registry_match'});await unconsumed(session.sessionId);
});
it('does not clip to registry freshness or extend the original ticket with newer registry evidence',async()=>{
 const download=new Date(Date.now()-31*86_400_000+10_000).toISOString();await publish('clear',download);
 const session=await issued();expect((await db.session.query('SELECT extract(epoch FROM (expires_at-issued_at))*1000 AS lifetime FROM dial_tickets WHERE id=(SELECT ticket_id FROM call_sessions WHERE id=$1)',[session.sessionId])).rows).toEqual([{lifetime:'60000.000000'}]);
 expect(Date.parse(session.expiresAt)).toBeGreaterThan(Date.parse(download)+31*86_400_000);
 await db.session.query("UPDATE dial_tickets SET issued_at=clock_timestamp()-interval '2 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1",[seed.alpha.workspaceId]);
 await publish();expect(await consume(session.sessionId)).toEqual({ok:false,reason:'ticket_expired'});await unconsumed(session.sessionId);
});
it('preserves personal-cell restriction from an alternate route at another firm with the same endpoint',async()=>{
 const session=await issued();
 const other=(await db.session.query<{id:string}>("INSERT INTO firms(workspace_id,name) VALUES($1,'Other fictional firm') RETURNING id",[seed.alpha.workspaceId])).rows[0]!.id;
 await db.session.query(`INSERT INTO phone_routes(workspace_id,firm_id,e164,source,technical_validation,eligibility,version,retrieved_at,known_personal_cell_at)
 VALUES($1,$2,$3,'salesperson','passed','usable',1,clock_timestamp(),clock_timestamp())`,[seed.alpha.workspaceId,other,policy.alpha.e164]);
 expect(await create()).toEqual({ok:false,reason:'route_invalid'});
 expect(await consume(session.sessionId)).toEqual({ok:false,reason:'route_invalid'});await unconsumed(session.sessionId);
});
it.each(['firm','handle'] as const)('preserves internal %s DNC without acquiring registry data',async scope=>{
 const session=await issued();
 const {recordSuppression}=await import('../../suppression/events.ts');const {recordingSuppressionJournal}=await import('../../suppression/journal.ts');
 expect(await withTransaction(runtime,()=>recordSuppression(context(),{scope,...(scope==='firm'?{firmId:crm.alpha.firmId}:{value:policy.alpha.e164}),channel:'phone',source:'prospect_do_not_call',journal:recordingSuppressionJournal()}))).toMatchObject({ok:true});
 expect(await create()).toEqual({ok:false,reason:scope==='firm'?'firm_suppressed':'handle_suppressed'});
 expect(await consume(session.sessionId)).toEqual({ok:false,reason:scope==='firm'?'firm_suppressed':'handle_suppressed'});await unconsumed(session.sessionId);
});
it('keeps legacy phone handoff held without registry coverage and creates no attempt',async()=>{
 const {reservePhoneHandoff}=await import('../../dial/phoneHandoff.ts');
 expect(await withTransaction(runtime,()=>reservePhoneHandoff(context(),{firmId:crm.alpha.firmId,routeId:policy.alpha.phoneRouteId,routeVersion:1,deviceId:seed.alpha.salesperson.deviceId,commandId:randomUUID(),clientVersion:'1.0.0',at:policy.insideWindow}))).toEqual({ok:false,reason:'dnc_coverage_unknown'});
 expect((await db.session.query('SELECT id FROM phone_handoff_attempts')).rows).toHaveLength(0);
});
it('undoes consumption and accounting when a final audit write waits past the original session deadline',async()=>{
 const sessionId=(await issued()).sessionId;
 const deadline=(await db.session.query<{expires_at:Date}>("UPDATE call_sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1 RETURNING expires_at",[sessionId])).rows[0]!.expires_at.toISOString();
 await db.session.query(`CREATE FUNCTION fixture_execution_audit_wait() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN IF NEW.action='call.session_placed' THEN PERFORM pg_advisory_xact_lock(820821); END IF; RETURN NEW; END $$`);
 await db.session.query('CREATE TRIGGER fixture_execution_audit_wait AFTER INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fixture_execution_audit_wait()');
 await db.session.query('BEGIN');await db.session.query('SELECT pg_advisory_xact_lock(820821)');const pending=consume(sessionId);let waited=false;
 try{
  for(let n=0;n<100;n++){waited=(await db.session.query<{waiting:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pg_backend_pid()=ANY(pg_blocking_pids(pid))) AS waiting`)).rows[0]!.waiting;if(waited)break;await new Promise(resolve=>setTimeout(resolve,10));}
  if(waited)await db.session.query("SELECT pg_sleep(GREATEST(0,extract(epoch FROM $1::timestamptz-clock_timestamp()))+0.02)",[deadline]);
 }finally{await db.session.query('COMMIT');}
 expect(await pending).toEqual({ok:false,reason:'ticket_expired'});expect(waited).toBe(true);await unconsumed(sessionId);
 expect((await db.session.query("SELECT id FROM audit_events WHERE action='call.session_placed'")).rows).toHaveLength(0);
});
it.each(['unknown-state','unknown-zone','revoked-posture','outside-hours'] as const)('browser issuance/advice/consume do not require %s while the strict phone policy remains unchanged',async kind=>{
 if(kind==='unknown-state')await db.session.query('UPDATE firms SET region_code=NULL WHERE id=$1',[crm.alpha.firmId]);
 if(kind==='unknown-zone')await db.session.query('UPDATE firms SET time_zone=NULL,time_zone_confidence=NULL,time_zone_source=NULL,time_zone_rule_version=NULL WHERE id=$1',[crm.alpha.firmId]);
 if(kind==='revoked-posture')await db.session.query('UPDATE state_postures SET revoked_at=clock_timestamp(),revoked_by_user_id=$2 WHERE workspace_id=$1',[seed.alpha.workspaceId,seed.alpha.admin.userId]);
 const at=kind==='outside-hours'?policy.outsideWindow:policy.insideWindow;
 const input={firmId:crm.alpha.firmId,routeId:policy.alpha.phoneRouteId,routeVersion:1,callingIdentityId:policy.alpha.callingIdentityId,at};
 const {authorizeDial}=await import('../../dial/authorize.ts');
 const strict=await withTransaction(runtime,()=>authorizeDial(context(),input));expect(strict.allowed).toBe(false);
 const {adviseBrowserDial}=await import('../../dial/advise.ts');expect(await adviseBrowserDial(context(),input)).toMatchObject({callable:true,reasons:[]});
 const made=await withTransaction(runtime,()=>createCallSession(context(),{...input,deviceId:seed.alpha.salesperson.deviceId,commandId:randomUUID(),configuredCallerIdE164:'+14015550100'}));
 expect(made).toMatchObject({ok:true});if(!made.ok)throw Error(made.reason);
 const {consumeCallSession}=await import('../../calls/sessions.ts');
 expect(await withTransaction(runtime,()=>consumeCallSession(runtime,{workspaceId:seed.alpha.workspaceId,sessionId:made.value.sessionId,callSid:`CA${randomUUID().replaceAll('-','')}`,identity:`client:${seed.alpha.salesperson.userId}`,at}))).toMatchObject({ok:true});
});
