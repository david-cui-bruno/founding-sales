import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {seedCrm,type SeededCrm} from '../db/support/crmFixtures.ts';
import {saveCandidate,reviewCandidate,deleteCandidate} from '../../sourcing/candidates.ts';
import {seedDiscoveryCandidate} from './support/discoverySeed.ts';
import {manualOrdinaryFixture,manualDiscoveryFixture} from './support/manualProspectFixture.ts';
import {saveManualProspectActivity,readManualProspectActivity} from '../../sourcing/manualProspectActivity.ts';
import {manualPhoneFixture,seedManualPhoneRun} from './support/manualPhoneFixture.ts';
import {runRetentionBatch} from '../../retention/runs.ts';
import {requestSourceCheck,runSourceCheck} from '../../sourcing/sourceCheck.ts';
let db:TestDatabase,seed:TwoWorkspaces,crm:SeededCrm,runtime:SessionQueryable,index=1000;
const context=(session=runtime)=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),session);
const content={performedByUser:true as const,channel:'manual_phone' as const,occurrence:{kind:'unknown' as const},result:'unknown' as const,note:'Lifecycle synthetic private note',callback:null};
async function setup(discovery=false){
 const input=manualOrdinaryFixture(++index),raw=manualDiscoveryFixture(randomUUID());
 const saved=discovery?{ok:true as const,value:await withTransaction(runtime,()=>seedDiscoveryCandidate(context(),raw))}:await withTransaction(runtime,()=>saveCandidate(context(),input));if(!saved.ok)throw Error(saved.reason);
 const candidateId=saved.value.id,attemptId=randomUUID();expect(await withTransaction(runtime,()=>saveManualProspectActivity(context(),{...content,operation:'create',candidateId,expectedCandidateRevision:1,attemptId},async()=>true))).toMatchObject({ok:true});
 return {candidateId,attemptId,source:discovery?raw.row.source.sourceUrl:input.sourceUrl,base:{candidateId,expectedCandidateRevision:1,attemptId}};
}
async function cleared(id:string){expect((await runtime.query('SELECT content FROM sourcing_manual_prospect_attempts WHERE id=$1',[id])).rows).toEqual([{content:null}]);}
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);crm=await seedCrm(db.session,seed);runtime=await db.appRuntimeSession();});
afterAll(async()=>db?.drop());
it('normal canonical revision review immediately erases content and candidate deletion cascades terminal identity',async()=>{
 const f=await setup();expect(await withTransaction(runtime,()=>reviewCandidate(context(),{id:f.candidateId,expectedRevision:1,status:'kept'}))).toMatchObject({ok:true});await cleared(f.attemptId);
 await expect(withTransaction(runtime,()=>readManualProspectActivity(context(),f.base,async()=>true))).rejects.toMatchObject({reason:'candidate_changed'});
 expect(await withTransaction(runtime,()=>deleteCandidate(context(),{id:f.candidateId,expectedRevision:2}))).toMatchObject({ok:true});expect((await runtime.query('SELECT id FROM sourcing_manual_prospect_attempts WHERE id=$1',[f.attemptId])).rows).toEqual([]);
});
it.each([false,true])('normal evidence retention clears private activity before source evidence disappears, discovery=%s',async discovery=>{
 const f=await setup(discovery);await runtime.query(`INSERT INTO evidence_items(workspace_id,firm_id,provider,source_reference,content_hash,terms_allow_retention,retention_expires_at) VALUES($1,$2,'website',$3,$4,true,clock_timestamp()-interval '1 second')`,[seed.alpha.workspaceId,crm.alpha.firmId,f.source,discovery?'c'.repeat(64):'a'.repeat(64)]);
 const worker=repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'system',component:'worker'}),runtime);
 await withTransaction(runtime,()=>runRetentionBatch(worker,{dataKind:'research_evidence',period:discovery?'2026-10-25':'2026-10-24',limit:50}));await cleared(f.attemptId);
 expect((await runtime.query('SELECT id FROM evidence_items WHERE source_reference=$1',[f.source])).rows).toEqual([]);
 await expect(withTransaction(runtime,()=>readManualProspectActivity(context(),f.base,async()=>true))).rejects.toMatchObject({reason:'candidate_unavailable'});
 // Normal evidence deletion cannot make a terminal activity ID available again.
 expect((await runtime.query('SELECT reason FROM sourcing_manual_prospect_attempts WHERE id=$1',[f.attemptId])).rows[0]?.['reason']).toBe('source_changed_or_unavailable');
});
it('normal source-check loss clears shared-source ordinary activity even when its own candidate remains permitted otherwise',async()=>{
 const a=await setup(),b=await setup();await runtime.query('UPDATE sourcing_candidates SET payload=jsonb_set(payload,\'{sourceUrl}\',to_jsonb($2::text)) WHERE id=$1',[b.candidateId,a.source]);
 expect(await withTransaction(runtime,()=>requestSourceCheck(context(),{id:a.candidateId,expectedRevision:1}))).toMatchObject({ok:true});
 const check=(await runtime.query<{source_check:{checkId:string}}>('SELECT source_check FROM sourcing_candidates WHERE id=$1',[a.candidateId])).rows[0]!.source_check;
 await withTransaction(runtime,()=>runSourceCheck(context(),{candidateId:a.candidateId,checkId:check.checkId},{providerKey:'controlled-local-failure',fetchPages:async()=>({ok:false,costCents:0,failureCode:'unavailable'})}));
 await cleared(a.attemptId);await cleared(b.attemptId);
});
it('normal discovery-origin deletion erases content without preserving a private old copy',async()=>{const f=await setup(true);await runtime.query('DELETE FROM sourcing_candidate_discovery_origins WHERE candidate_id=$1',[f.candidateId]);await cleared(f.attemptId);});
it('optional phone evidence/run deletion alone does not erase an independently permitted raw report',async()=>{const f=await setup();await seedManualPhoneRun(runtime,seed.alpha.workspaceId,f.candidateId,manualPhoneFixture(f.source));await runtime.query('DELETE FROM sourcing_qualification_runs WHERE candidate_id=$1',[f.candidateId]);expect(await withTransaction(runtime,()=>readManualProspectActivity(context(),f.base,async()=>true))).toMatchObject({availability:'available',note:content.note});});
it.each(['revision','source','membership','expiry'] as const)('real candidate lock wait rechecks %s before recording, without content commit',async mode=>{
 const f=await setup(),blocker=await db.appRuntimeSession(),reader=await db.appRuntimeSession();
 await blocker.query('BEGIN');await blocker.query('SELECT id FROM sourcing_candidates WHERE id=$1 FOR UPDATE',[f.candidateId]);
 const attemptId=randomUUID(),pid=(await reader.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
 if(mode==='expiry')await runtime.query(`INSERT INTO evidence_items(workspace_id,firm_id,provider,source_reference,content_hash,terms_allow_retention,retention_expires_at) VALUES($1,$2,'website',$3,$4,true,clock_timestamp()+interval '400 milliseconds')`,[seed.alpha.workspaceId,crm.alpha.firmId,f.source,'b'.repeat(64)]);
 const pending=withTransaction(reader,()=>saveManualProspectActivity(context(reader),{...content,operation:'create',candidateId:f.candidateId,expectedCandidateRevision:1,attemptId},async()=>true)).then(()=>({accepted:true}),()=>({accepted:false}));
 try{
  await expect.poll(async()=>String((await db.session.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.['wait_event_type'])).toBe('Lock');
  if(mode==='revision')await blocker.query('UPDATE sourcing_candidates SET revision=revision+1 WHERE id=$1',[f.candidateId]);
  if(mode==='source')await blocker.query(`UPDATE sourcing_candidates SET source_check='{"state":"unavailable","reason":"source_not_permitted"}'::jsonb WHERE id=$1`,[f.candidateId]);
  if(mode==='membership'){await runtime.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.salesperson.userId]);await runtime.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.admin.userId]);}
  if(mode==='expiry')await blocker.query('SELECT pg_sleep(0.5)');
 }finally{await blocker.query('COMMIT');}
 try{expect(await pending).toEqual({accepted:false});expect((await runtime.query('SELECT id FROM sourcing_manual_prospect_attempts WHERE id=$1',[attemptId])).rows).toEqual([]);}finally{if(mode==='membership')await runtime.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.admin.userId]);}
});
