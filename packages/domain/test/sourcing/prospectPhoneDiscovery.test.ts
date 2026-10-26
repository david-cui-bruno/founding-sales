import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {saveDiscoveryCandidate} from '../../sourcing/discoveryIntake.ts';
import {requestProspectPhoneDiscovery,readProspectPhoneDiscovery,runProspectPhoneDiscovery,currentProspectPhoneDiscoveryAuthority,ProspectPhoneDiscoveryAuthorityChanged,expireProspectPhoneDiscoveryInTransaction} from '../../sourcing/prospectPhoneDiscovery.ts';
import {listManualProspects} from '../../sourcing/manualProspects.ts';
import {rememberExpiredManualSources} from '../../sourcing/manualProspectSourceLoss.ts';
import {candidateAcquisitionOutstanding} from '../../sourcing/retainedAcquisition.ts';
import {manualOrdinaryFixture,manualDiscoveryFixture} from './support/manualProspectFixture.ts';
import {manualPhoneFixture,seedManualPhoneRun} from './support/manualPhoneFixture.ts';
import type {PageFetchProvider,PageFetchRequest} from '../../research/providers.ts';
let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable;
let serial=0;
const ctx=(session=runtime,workspace:'alpha'|'beta'='alpha')=>repositoryContext(workspaceScope(seed[workspace].workspaceId,{kind:'user',userId:seed[workspace].admin.userId,role:'admin'}),session);
const worker=(session=runtime)=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'system',component:'worker'}),session);
async function candidate(raw=false){
 const n=++serial,input=manualOrdinaryFixture(n);input.sourceUrl=`${input.website}about`;
 if(raw){const value=manualDiscoveryFixture(`phone-${n}`);value.row.website=input.website;const saved=await withTransaction(runtime,()=>saveDiscoveryCandidate(ctx(),value));if(!saved.ok)throw Error(saved.reason);return {id:saved.value.id,input,sourceUrl:value.row.source.sourceUrl};}
 const saved=await withTransaction(runtime,()=>saveCandidate(ctx(),input));if(!saved.ok)throw Error(saved.reason);return {id:saved.value.id,input,sourceUrl:input.sourceUrl};
}
async function request(id:string,authority?:()=>Promise<boolean>){const result=await withTransaction(runtime,()=>requestProspectPhoneDiscovery(ctx(),{candidateId:id,expectedRevision:1},authority));if(!result.ok)throw Error(result.reason);return result.value.runId;}
const read=(id:string,authority?:()=>Promise<boolean>)=>withTransaction(runtime,()=>readProspectPhoneDiscovery(ctx(),{candidateId:id,expectedRevision:1},authority));
function provider(website:string,before?:((request:PageFetchRequest)=>Promise<void>),text='Office phone: (214) 555-0123'):PageFetchProvider{
 return {providerKey:'controlled-safe-page',fetchPages:async input=>{
  expect(input.prioritizeContactPages).toBe(true);expect(input.maxPagesPerFirm).toBeLessThanOrEqual(4);expect(input.maxBytes).toBeLessThanOrEqual(1000000);
  expect(input.urls.every(url=>new URL(url).hostname===new URL(website).hostname)).toBe(true);
  await before?.(input);
  const body=new TextEncoder().encode(text);
  return {ok:true,value:{pages:[{url:`${website}contact`,contentHash:createHash('sha256').update(body).digest('hex'),retrievedAt:new Date().toISOString(),body,contentType:'text/plain',firstParty:true}],skipped:{}},costCents:0};
 }};
}
async function rawRun(id:string){return (await runtime.query('SELECT * FROM sourcing_prospect_phone_discoveries WHERE workspace_id=$1 AND id=$2',[seed.alpha.workspaceId,id])).rows[0]!;}
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();
 const directory=(await db.session.query<{directory:string}>("SELECT current_setting('data_directory') directory")).rows[0]!.directory;
 console.error('PHONE_DISCOVERY_OWNED_PG',JSON.stringify({directory,pid:Number(readFileSync(`${directory}/postmaster.pid`,'utf8').split('\n')[0]),port:new URL(process.env['FSS_TEST_CLUSTER_URL']!).port,database:db.name}));
});
beforeEach(async()=>{
 await db.session.query('DELETE FROM sourcing_candidates');await db.session.query('DELETE FROM jobs');
 await db.session.query("UPDATE workspace_memberships SET role='admin',status='active',deactivated_at=NULL WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.admin.userId]);
 await db.session.query('DELETE FROM research_settings');
});
afterAll(async()=>{await db.drop();});
it.each([false,true])('persists exact company pages and normalized evidence on ordinary/raw retained candidate, raw=%s',async raw=>{
 const c=await candidate(raw),runId=await request(c.id);let calls=0;
 const p=provider(c.input.website!,async()=>{calls++;});await runProspectPhoneDiscovery(worker(),{runId},{pageFetch:p});
 expect(await read(c.id)).toMatchObject({ok:true,value:{state:'complete',candidateId:c.id,phoneEvidence:{state:'observed',value:'+12145550123',sources:[{authority:{kind:'phone_discovery',runId}}]},channelAuthority:'not_granted'}});
 expect(await withTransaction(runtime,()=>listManualProspects(ctx(),{state:'all',offset:0}))).toMatchObject({ok:true,value:{prospects:[{candidateId:c.id,observedPhone:'+12145550123',qualification:'unverified',contactAuthority:'not_granted'}]}});
 expect(await request(c.id)).toBe(runId);await runProspectPhoneDiscovery(worker(),{runId},{pageFetch:p});expect(calls).toBe(1);
 const stored=await rawRun(runId);expect(JSON.stringify(stored['content'])).not.toContain('<html');
 expect(new Date(String(stored['expires_at'])).getTime()-new Date(String(stored['requested_at'])).getTime()).toBeLessThanOrEqual(7*86400000);
 for(const table of ['sourcing_qualification_runs','sourcing_admissions','firms','phone_routes','provider_reservations','outbound_messages','sequence_enrollments'])expect((await runtime.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.['n']).toBe(0);
});
it('different commands and repeated worker delivery never reclaim a running or unknown capture',async()=>{
 const c=await candidate(),runId=await request(c.id);
 await runtime.query("UPDATE sourcing_prospect_phone_discoveries SET state='running',dispatched_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[seed.alpha.workspaceId,runId]);
 let calls=0;const p=provider(c.input.website!,async()=>{calls++;});
 await runProspectPhoneDiscovery(worker(),{runId},{pageFetch:p});expect(await request(c.id)).toBe(runId);expect(calls).toBe(0);
 expect(await candidateAcquisitionOutstanding(ctx(),c.id)).toBe(true);
 await withTransaction(runtime,()=>rememberExpiredManualSources(ctx(),[c.sourceUrl]));
 expect((await rawRun(runId))['content']).toBeNull();expect(await candidateAcquisitionOutstanding(ctx(),c.id)).toBe(true);
});
it.each(['research_off','hold','revision','principal','source_loss','cap'] as const)('refuses final evidence after %s during fetch without redispatch',async mode=>{
 const c=await candidate(),runId=await request(c.id),other=await db.appRuntimeSession();
 const p=provider(c.input.website!,async input=>{
  if(mode==='research_off')await other.query('INSERT INTO research_settings(workspace_id,enabled) VALUES($1,false)',[seed.alpha.workspaceId]);
  if(mode==='cap')await other.query('INSERT INTO research_settings(workspace_id,max_page_bytes) VALUES($1,10000)',[seed.alpha.workspaceId]);
  if(mode==='hold')await other.query("INSERT INTO active_holds(workspace_id,scope_kind,reason_code,blocked_action_kinds,source_event_kind) VALUES($1,'workspace','scoped_pause',ARRAY['research'],'phone-test')",[seed.alpha.workspaceId]);
  if(mode==='revision')await other.query('UPDATE sourcing_candidates SET revision=revision+1 WHERE workspace_id=$1 AND id=$2',[seed.alpha.workspaceId,c.id]);
  if(mode==='principal'){
   await other.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.salesperson.userId]);
   await other.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.admin.userId]);
  }
  if(mode==='source_loss')await withTransaction(other,()=>rememberExpiredManualSources(ctx(other),[c.sourceUrl]));
  expect(await input.shouldContinue?.()).toBe(false);
 });
 await runProspectPhoneDiscovery(worker(),{runId},{pageFetch:p});
 const stored=await rawRun(runId);expect(stored['state']).toBe('unavailable');expect(stored['content']).toBeNull();expect(stored['dispatch_finished_at']).not.toBeNull();
 expect(stored['reason']).toBe({research_off:'research_disabled',hold:'research_held',revision:'candidate_changed',principal:'authority_changed',source_loss:'source_unavailable',cap:'bounded_capture_incomplete'}[mode]);
 await db.session.query("UPDATE active_holds SET released_at=clock_timestamp() WHERE workspace_id=$1 AND released_at IS NULL",[seed.alpha.workspaceId]);
});
it('scope/principal and stale revision refusals never enqueue a capture',async()=>{
 const c=await candidate();
 expect(await withTransaction(runtime,()=>requestProspectPhoneDiscovery(ctx(runtime,'beta'),{candidateId:c.id,expectedRevision:1}))).toMatchObject({ok:false,reason:'candidate_unavailable'});
 expect(await withTransaction(runtime,()=>requestProspectPhoneDiscovery(ctx(),{candidateId:c.id,expectedRevision:2}))).toMatchObject({ok:false,reason:'candidate_changed'});
 expect(await withTransaction(runtime,()=>requestProspectPhoneDiscovery(ctx(),{candidateId:c.id,expectedRevision:1},async()=>false))).toMatchObject({ok:false,reason:'authority_changed'});
 expect((await runtime.query('SELECT count(*)::int n FROM sourcing_prospect_phone_discoveries')).rows[0]?.['n']).toBe(0);
});
it('preserves a conflicting legacy endpoint rather than overwriting it with fresh discovery',async()=>{
 const c=await candidate(),e=manualPhoneFixture(c.sourceUrl,['2145550124']);await seedManualPhoneRun(db.session,seed.alpha.workspaceId,c.id,e);
 const runId=await request(c.id);await runProspectPhoneDiscovery(worker(),{runId},{pageFetch:provider(c.input.website!)});
 expect(await withTransaction(runtime,()=>listManualProspects(ctx(),{state:'all',offset:0}))).toMatchObject({ok:true,value:{prospects:[{observedPhone:null,phoneEvidence:{state:'conflicting',sources:[{},{}]}}]}});
});
it.each(['revision','member','source','candidate_delete'] as const)('physically erases original text on %s and cannot mint a second same-revision run',async mode=>{
 const c=await candidate(),runId=await request(c.id);await runProspectPhoneDiscovery(worker(),{runId},{pageFetch:provider(c.input.website!)});
 if(mode==='revision')await runtime.query('UPDATE sourcing_candidates SET revision=revision+1 WHERE workspace_id=$1 AND id=$2',[seed.alpha.workspaceId,c.id]);
 if(mode==='member'){
  await runtime.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.salesperson.userId]);
  await runtime.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.admin.userId]);
 }
 if(mode==='source')await withTransaction(runtime,()=>rememberExpiredManualSources(ctx(),[`${c.input.website}contact`]));
 if(mode==='candidate_delete')await runtime.query('DELETE FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2',[seed.alpha.workspaceId,c.id]);
 const stored=await rawRun(runId);if(mode==='candidate_delete')expect(stored).toBeUndefined();else{expect(stored['content']).toBeNull();expect(stored['state']).toBe('unavailable');}
});
it('read authority loss after a wait refuses instead of returning earlier content',async()=>{
 const c=await candidate(),runId=await request(c.id);await runProspectPhoneDiscovery(worker(),{runId},{pageFetch:provider(c.input.website!)});
 let calls=0;expect(await read(c.id,async()=>++calls<2)).toMatchObject({ok:false,reason:'authority_changed'});
});
it('requests waiting on the actual shared visibility lock recheck authority and do not duplicate the job',async()=>{
 const c=await candidate(),other=await db.appRuntimeSession();
 await other.query('BEGIN');await other.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sourcing-discovery-review:${seed.alpha.workspaceId}`]);
 let permitted=true,started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
 const waiting=withTransaction(runtime,async()=>{started();return requestProspectPhoneDiscovery(ctx(),{candidateId:c.id,expectedRevision:1},async()=>permitted);});
 await ready;permitted=false;await other.query('COMMIT');
 expect(await waiting).toMatchObject({ok:false,reason:'authority_changed'});
 const a=await db.appRuntimeSession(),b=await db.appRuntimeSession();
 const requests=await Promise.all([a,b].map(session=>withTransaction(session,()=>requestProspectPhoneDiscovery(ctx(session),{candidateId:c.id,expectedRevision:1}))));
 expect(requests[0]).toEqual(requests[1]);expect(requests[0]).toMatchObject({ok:true});
 expect((await runtime.query("SELECT count(*)::int n FROM jobs WHERE kind='sourcing.phone_discover'")).rows[0]?.['n']).toBe(1);
});
async function waitForBackendLock(pid:number):Promise<void>{
 for(let attempt=0;attempt<100;attempt++){
  const row=(await db.session.query<{waiting:boolean}>("SELECT wait_event_type='Lock' AND wait_event='advisory' waiting FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0];
  if(row?.waiting)return;
  await new Promise(resolve=>setTimeout(resolve,5));
 }
 throw Error('expected real phone-discovery advisory lock wait');
}
it.each(['source_loss','revision','principal'] as const)('request revalidates %s after an observed PostgreSQL visibility-lock wait',async mode=>{
 const c=await candidate(),other=await db.appRuntimeSession();
 const pid=(await runtime.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
 await other.query('BEGIN');
 await other.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sourcing-discovery-review:${seed.alpha.workspaceId}`]);
 const waiting=withTransaction(runtime,()=>requestProspectPhoneDiscovery(ctx(),{candidateId:c.id,expectedRevision:1}));
 try{
  await waitForBackendLock(pid);
  if(mode==='source_loss')await rememberExpiredManualSources(ctx(other),[c.sourceUrl]);
  if(mode==='revision')await other.query('UPDATE sourcing_candidates SET revision=revision+1 WHERE workspace_id=$1 AND id=$2',[seed.alpha.workspaceId,c.id]);
  if(mode==='principal'){
   await other.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.salesperson.userId]);
   await other.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.admin.userId]);
  }
 }finally{await other.query('COMMIT');}
 expect(await waiting).toMatchObject({ok:false,reason:{source_loss:'official_site_unknown',revision:'candidate_changed',principal:'authority_changed'}[mode]});
 expect((await runtime.query('SELECT id FROM sourcing_prospect_phone_discoveries WHERE candidate_id=$1',[c.id])).rows).toHaveLength(0);
 expect((await runtime.query("SELECT id FROM jobs WHERE kind='sourcing.phone_discover'")).rows).toHaveLength(0);
});
it('expired pending jobs are terminally erased by the existing bounded retention owner',async()=>{
 const c=await candidate(),runId=randomUUID();
 await runtime.query(`INSERT INTO sourcing_prospect_phone_discoveries(workspace_id,id,candidate_id,candidate_revision,creator_user_id,creator_ref,method,requested_at,deadline_at,expires_at,content)
 VALUES($1,$2,$3,1,$4,$4,'company-public-phone-v1',clock_timestamp()-interval '31 minutes',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 day',$5::jsonb)`,
 [seed.alpha.workspaceId,runId,c.id,seed.alpha.admin.userId,JSON.stringify({website:c.input.website,sourceUrls:[c.sourceUrl.replace(/\/+$/u,'')],observations:[]})]);
 expect(await withTransaction(runtime,()=>expireProspectPhoneDiscoveryInTransaction(ctx()))).toBe(1);
 expect(await rawRun(runId)).toMatchObject({state:'unavailable',reason:'discovery_expired',content:null});
 let calls=0;await runProspectPhoneDiscovery(worker(),{runId},{pageFetch:provider(c.input.website!,async()=>{calls++;})});expect(calls).toBe(0);
});
it('typed beforeCommit authority loss rolls back pending run, job and consumed count',async()=>{
 const c=await candidate();
 const count=()=>runtime.query("SELECT COALESCE(sum(count),0)::int n FROM daily_counters WHERE workspace_id=$1 AND counter_kind='research_firm_runs'",[seed.alpha.workspaceId]);
 const before=(await count()).rows;
 await expect(withTransaction(runtime,async()=>{
  const result=await requestProspectPhoneDiscovery(ctx(),{candidateId:c.id,expectedRevision:1});if(!result.ok)throw Error(result.reason);
  await currentProspectPhoneDiscoveryAuthority(ctx(),{candidateId:c.id,expectedRevision:1},result.value.runId,async()=>false);
 })).rejects.toBeInstanceOf(ProspectPhoneDiscoveryAuthorityChanged);
 expect((await count()).rows).toEqual(before);
 expect((await runtime.query('SELECT id FROM sourcing_prospect_phone_discoveries WHERE candidate_id=$1',[c.id])).rows).toHaveLength(0);
 expect((await runtime.query("SELECT id FROM jobs WHERE kind='sourcing.phone_discover'")).rows).toHaveLength(0);
});
