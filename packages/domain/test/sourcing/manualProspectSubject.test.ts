import {createHash} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createTestDatabase,TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {seedDiscoveryCandidate} from './support/discoverySeed.ts';
import {manualOrdinaryFixture,manualDiscoveryFixture} from './support/manualProspectFixture.ts';
import {MANUAL_ACTIVITY_RAW_SQL} from '../../sourcing/manualProspectActivityAccess.ts';
import {readManualProspectSubject,manualProspectRows} from '../../sourcing/manualProspectRows.ts';
import {projectManualProspect,type ManualProspectRow} from '../../sourcing/manualProspectProjection.ts';
import {phoneDiscoveryContext} from '../../sourcing/prospectPhoneDiscoveryAuthority.ts';
import {MANUAL_SOURCE_LOSS_ACTION} from '../../sourcing/manualProspectSourceLoss.ts';
import {requestProspectPhoneDiscovery,runProspectPhoneDiscovery} from '../../sourcing/prospectPhoneDiscovery.ts';
import {lockDiscoveryReviewSources} from '../../sourcing/discoveryReviewVisibility.ts';
let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable,serial=8000;
const ctx=(workspace:'alpha'|'beta'='alpha',session=runtime)=>repositoryContext(workspaceScope(seed[workspace].workspaceId,{kind:'user',userId:seed[workspace].admin.userId,role:'admin'}),session);
async function ordinary(workspace:'alpha'|'beta'='alpha') {
 const input=manualOrdinaryFixture(++serial),result=await withTransaction(runtime,()=>saveCandidate(ctx(workspace),input));
 if(!result.ok)throw Error(result.reason);
 return {id:result.value.id,input};
}
async function discovery(workspace:'alpha'|'beta'='alpha') {
 const input=manualDiscoveryFixture(`exact-${++serial}`);input.row.website=`https://discovery-${serial}.example.test/`;
 const result=await withTransaction(runtime,()=>seedDiscoveryCandidate(ctx(workspace),input));
 return {id:result.id,input};
}
async function parity(id:string,permitted:boolean,revision=1,workspace:'alpha'|'beta'='alpha') {
 const context=ctx(workspace);
 const old=(await runtime.query<ManualProspectRow & {source_urls:string[]}>(`SELECT * FROM (${MANUAL_ACTIVITY_RAW_SQL}) permitted WHERE id=$3 AND revision=$4`,[context.scope.workspaceId,'all',id,revision])).rows[0];
 const expected=old&&projectManualProspect(old)?old:null;
 const actual=await readManualProspectSubject(context,{candidateId:id,expectedRevision:revision});
 expect(actual!==null).toBe(permitted);expect(actual!==null).toBe(expected!==null);
 if(actual&&expected) {
  for(const key of ['id','revision','payload','origins','created_at','manual_state','source_urls'])expect(actual[key]).toEqual(expected[key]);
  expect(actual).not.toHaveProperty('duplicate_count');expect(actual).not.toHaveProperty('duplicate_rank');
 }
 return actual;
}
async function loss(id:string,reason='source_unavailable') {
 await runtime.query("UPDATE sourcing_candidates SET source_check=jsonb_build_object('state','unavailable','reason',$2::text) WHERE id=$1",[id,reason]);
}
async function evidence(url:string,expiresAt:Date|null,terms=true,workspace:'alpha'|'beta'='alpha') {
 const firm=(await runtime.query<{id:string}>('INSERT INTO firms(workspace_id,name,assigned_user_id) VALUES($1,$2,$3) RETURNING id',[seed[workspace].workspaceId,'Synthetic subject source',seed[workspace].admin.userId])).rows[0]!.id;
 await runtime.query("INSERT INTO evidence_items(workspace_id,firm_id,provider,source_reference,content_hash,terms_allow_retention,retention_expires_at) VALUES($1,$2,'website',$3,$4,$5,$6)",[seed[workspace].workspaceId,firm,url,'a'.repeat(64),terms,expiresAt]);
}
beforeAll(async()=>{
 db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();
 expect((await runtime.query('SELECT current_user')).rows).toEqual([{current_user:'app_runtime'}]);
 console.log('SUBJECT_TEST_RESOURCE',JSON.stringify({database:db.name,template:process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE]}));
});
beforeEach(async()=>{
 await db.session.query('DELETE FROM sourcing_candidates');await db.session.query('DELETE FROM evidence_items');
 await db.session.query('DELETE FROM audit_events WHERE action=$1',[MANUAL_SOURCE_LOSS_ACTION]);
});
afterAll(async()=>{await db?.drop();console.log('SUBJECT_TEST_DATABASE_DROPPED');});
it.each(['new','kept','skipped','wrong_number'] as const)('ordinary and discovery authority preserve manual state %s',async state=>{
 for(const f of [await ordinary(),await discovery()]) {
  if(state!=='new')await runtime.query('INSERT INTO sourcing_manual_prospect_states(workspace_id,candidate_id,candidate_revision,state) VALUES($1,$2,1,$3)',[seed.alpha.workspaceId,f.id,state]);
  expect(await parity(f.id,true)).toMatchObject({manual_state:state});
  expect(await phoneDiscoveryContext(ctx(),f.id,1)).toMatchObject({website:'website' in f.input?f.input.website:f.input.row.website});
 }
});
it('stale, foreign, deleted, dismissed and source-denied subjects remain unavailable',async()=>{
 const f=await ordinary();await parity(f.id,false,2);await parity(f.id,false,1,'beta');
 await runtime.query("UPDATE sourcing_candidates SET status='dismissed' WHERE id=$1",[f.id]);await parity(f.id,false);
 await runtime.query("UPDATE sourcing_candidates SET status='needs_review' WHERE id=$1",[f.id]);
 await loss(f.id);await parity(f.id,false);await runtime.query('DELETE FROM sourcing_candidates WHERE id=$1',[f.id]);await parity(f.id,false);
});
it.each(['missing','identity','notices','metadata'] as const)('preserves exact discovery-origin projectability: %s',async mode=>{
 const f=await discovery();await parity(f.id,true);
 if(mode==='missing')await runtime.query('DELETE FROM sourcing_candidate_discovery_origins WHERE candidate_id=$1',[f.id]);
 if(mode==='identity')await db.session.query("UPDATE sourcing_candidate_discovery_origins SET source=jsonb_set(source,'{retrievedAt}',to_jsonb('2026-10-01T00:00:00Z'::text)) WHERE candidate_id=$1",[f.id]);
 if(mode==='notices')await db.session.query("UPDATE sourcing_candidate_discovery_origins SET notices=jsonb_set(notices,'{0,label}',to_jsonb($2::text)) WHERE candidate_id=$1",[f.id,'x'.repeat(301)]);
 if(mode==='metadata')await db.session.query("UPDATE sourcing_candidate_discovery_origins SET source_metadata=jsonb_build_object('sourcesJson','not-json') WHERE candidate_id=$1",[f.id]);
 await parity(f.id,false);expect(await phoneDiscoveryContext(ctx(),f.id,1)).toBeNull();
});
it('missing/ambiguous official website cannot become capture authority',async()=>{
 const f=await discovery();await runtime.query("UPDATE sourcing_candidates SET payload=jsonb_set(payload,'{row,website}','null'::jsonb) WHERE id=$1",[f.id]);
 await parity(f.id,true);expect(await phoneDiscoveryContext(ctx(),f.id,1)).toBeNull();
 await runtime.query("UPDATE sourcing_candidates SET payload=jsonb_set(jsonb_set(payload,'{row,website}',to_jsonb($2::text)),'{row,websiteAssociation}','\"ambiguous\"'::jsonb) WHERE id=$1",[f.id,f.input.row.website]);
 await parity(f.id,true);expect(await phoneDiscoveryContext(ctx(),f.id,1)).toBeNull();
});
it.each(['direct','lastSuccess','origin'] as const)('another dismissed candidate vetoes exact same URL through %s',async mode=>{
 const target=await ordinary(),other=mode==='origin'?await discovery():await ordinary(),url=target.input.sourceUrl.replace(/\/+$/u,'');
 if(mode==='direct')await runtime.query("UPDATE sourcing_candidates SET payload=jsonb_set(payload,'{sourceUrl}',to_jsonb($2::text)) WHERE id=$1",[other.id,`${url}/`]);
 if(mode==='origin')await db.session.query("UPDATE sourcing_candidate_discovery_origins SET source=jsonb_set(source,'{sourceUrl}',to_jsonb($2::text)) WHERE candidate_id=$1",[other.id,`${url}/`]);
 await loss(other.id);
 if(mode==='lastSuccess')await runtime.query("UPDATE sourcing_candidates SET source_check=jsonb_set(source_check,'{lastSuccess}',jsonb_build_object('url',$2::text)) WHERE id=$1",[other.id,`${url}/`]);
 await runtime.query("UPDATE sourcing_candidates SET status='dismissed' WHERE id=$1",[other.id]);
 await parity(target.id,false);
});
it('unrelated path or different workspace same-URL denial cannot hide the subject',async()=>{
 const target=await ordinary(),foreign=await ordinary('beta'),unrelated=await ordinary();
 await runtime.query("UPDATE sourcing_candidates SET payload=jsonb_set(payload,'{sourceUrl}',to_jsonb($2::text)) WHERE id=$1",[foreign.id,target.input.sourceUrl]);await loss(foreign.id);
 await runtime.query("UPDATE sourcing_candidates SET payload=jsonb_set(payload,'{sourceUrl}',to_jsonb($2::text)) WHERE id=$1",[unrelated.id,`${target.input.sourceUrl}/different`]);await loss(unrelated.id);
 await evidence(target.input.sourceUrl,new Date(Date.now()-1000),true,'beta');await parity(target.id,true);
});
it.each(['expired','not_retainable','audit'] as const)('same normalized source remains denied by %s',async mode=>{
 const f=await discovery(),url=f.input.row.source.sourceUrl;
 if(mode==='audit')await runtime.query("INSERT INTO audit_events(workspace_id,actor_kind,actor_user_id,action,subject_kind,subject_id,detail) VALUES($1,'user',$2,$3,'sourcing_source_hash',$4,'{}')",[seed.alpha.workspaceId,seed.alpha.admin.userId,MANUAL_SOURCE_LOSS_ACTION,createHash('sha256').update(url.replace(/\/+$/u,'')).digest('hex')]);
 else await evidence(`${url}/`,new Date(Date.now()-1000),mode==='expired');
 await parity(f.id,false);
});
it('nonretention terms require a finite source lifetime, preserved until actual expiry',async()=>{
 const f=await discovery(),url=f.input.row.source.sourceUrl;
 await expect(evidence(url,null,false)).rejects.toMatchObject({constraint:'evidence_items_retention_consistent'});
 await evidence(url,new Date(Date.now()+3600000),false);await parity(f.id,true);
});
it('uses current wall clock for source expiry within the same transaction',async()=>{
 const f=await ordinary();await evidence(f.input.sourceUrl,new Date(Date.now()+1000));
 await withTransaction(runtime,async()=>{
  await parity(f.id,true);await runtime.query('SELECT pg_sleep(1.1)');await parity(f.id,false);
 });
});
it('an older nonwinning duplicate retains authority without changing list winner/count',async()=>{
 const a=await discovery(),b=await discovery();
 await runtime.query("UPDATE sourcing_candidates SET payload=jsonb_set(jsonb_set(payload,'{row,firmName}',to_jsonb('Same synthetic company'::text)),'{row,website}',to_jsonb('https://duplicate.example.test/'::text)),created_at=clock_timestamp()-interval '1 minute' WHERE id=ANY($1::uuid[])",[[a.id,b.id]]);
 await runtime.query("UPDATE sourcing_candidates SET created_at=clock_timestamp() WHERE id=$1",[b.id]);
 const rows=await manualProspectRows(ctx(),'all',0);expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({id:b.id,duplicate_count:1});
 expect(projectManualProspect(rows[0]!)).toMatchObject({possibleDuplicateCount:1});await parity(a.id,true);await parity(b.id,true);
});
it('worker rechecks exact source after an actual lifecycle lock wait',async()=>{
 const f=await ordinary(),requested=await withTransaction(runtime,()=>requestProspectPhoneDiscovery(ctx(),{candidateId:f.id,expectedRevision:1}));if(!requested.ok)throw Error(requested.reason);
 const blocker=await db.appRuntimeSession(),pid=(await runtime.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
 await blocker.query('BEGIN');await lockDiscoveryReviewSources(ctx('alpha',blocker));let fetches=0;
 const running=runProspectPhoneDiscovery(repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'system',component:'worker'}),runtime),{runId:requested.value.runId},{pageFetch:{providerKey:'controlled-no-io',fetchPages:async()=>{fetches++;throw Error('must not fetch');}}});
 try {
  await expect.poll(async()=>String((await db.session.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.['wait_event_type'])).toBe('Lock');
  await blocker.query("UPDATE sourcing_candidates SET source_check='{\"state\":\"unavailable\",\"reason\":\"source_not_permitted\"}' WHERE id=$1",[f.id]);
 }finally{await blocker.query('COMMIT');}
 await running;expect(fetches).toBe(0);
 expect((await runtime.query('SELECT state,reason,content FROM sourcing_prospect_phone_discoveries WHERE id=$1',[requested.value.runId])).rows[0]).toEqual({state:'unavailable',reason:'source_unavailable',content:null});
});
