import {createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import type {SourceObservation} from '@fss/contracts';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {requestQualification,QUALIFICATION_PROMPT_VERSION,QUALIFICATION_POLICY_VERSION} from '../../sourcing/qualificationStore.ts';
import {runQualification} from '../../sourcing/qualificationRun.ts';
import {readPreparedProspect,listPreparedProspects} from '../../sourcing/preparedProspects.ts';
import {manualPhoneSnapshots,projectManualPhone} from '../../sourcing/manualProspectPhone.ts';
import {readManualProspectSubject} from '../../sourcing/manualProspectRows.ts';
import {readResearchSettings} from '../../research/settings.ts';
import {lockDiscoveryReviewSources} from '../../sourcing/discoveryReviewVisibility.ts';
import {PREPARED_CAPTURE_V1} from '../../sourcing/preparedCapture.ts';
import {databaseNow} from '../../policy/clock.ts';
import {preparedProspectsBusinessSnapshot} from './preparedProspectsPgFixture.ts';
import {researchPageFetch,type RawResponse} from '../../../../apps/worker/src/research/companyPageFetch.ts';
import {residentialFacts} from './support/modelSelections.ts';

let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable;
const ctx=(system=false)=>repositoryContext(workspaceScope(seed.alpha.workspaceId,system?{kind:'system',component:'worker'}:{kind:'user',role:'admin',userId:seed.alpha.admin.userId}),runtime);
const tx=<T>(fn:()=>Promise<T>)=>withTransaction(runtime,fn);
type Target={candidateId:string;candidateRevision:number;runId:string|null};
const target=(value:Target):Target=>({candidateId:value.candidateId,candidateRevision:value.candidateRevision,runId:value.runId});
const read=(value:Target)=>tx(()=>readPreparedProspect(ctx(),target(value)));
const ok=(text:string,type='text/html'):RawResponse=>({statusCode:200,headers:{'content-type':type},body:new TextEncoder().encode(text),abortedOverCap:false});
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
beforeEach(async()=>{await tx(async()=>{await lockDiscoveryReviewSources(ctx());await runtime.query('DELETE FROM sourcing_candidates');});await runtime.query('DELETE FROM evidence_items');await runtime.query('DELETE FROM provider_reservations');await runtime.query('DELETE FROM provider_ledger');await runtime.query('DELETE FROM research_settings');await runtime.query('DELETE FROM daily_counters');});
afterAll(async()=>db?.drop());

async function pending(legacy=false){
 const website=`https://cedar-${randomUUID()}.example.test/`,sourceUrl=website+'residential-management',url=sourceUrl+'/';
 const payload={firmName:'Home | Cedar',website,sourceUrl,locality:'Boston',region:'MA' as const,signal:'fit_only' as const,evidence:'Fictional retained discovery label',observedOn:new Date().toISOString().slice(0,10),preparedBy:'Controlled source association'};
 const saved=await tx(()=>saveCandidate(ctx(),payload));if(!saved.ok)throw Error(saved.reason);
 const candidateId=saved.value.id;
 await runtime.query('INSERT INTO research_settings(workspace_id,enabled,max_pages_per_firm) VALUES($1,true,1)',[seed.alpha.workspaceId]);
 let runId:string;
 {
  const now=await databaseNow(ctx()),settings=await readResearchSettings(ctx());
  const fingerprint=createHash('sha256').update(JSON.stringify([1,QUALIFICATION_PROMPT_VERSION,QUALIFICATION_POLICY_VERSION,settings.modelName,now.slice(0,10)])).digest('hex');
  runId=(await runtime.query<{id:string}>(`INSERT INTO sourcing_qualification_runs(workspace_id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name,capture_policy_version)
   VALUES($1,$2,1,$3,$4,$5,$6,$7) RETURNING id`,[seed.alpha.workspaceId,candidateId,fingerprint,QUALIFICATION_PROMPT_VERSION,QUALIFICATION_POLICY_VERSION,settings.modelName,legacy?'legacy':PREPARED_CAPTURE_V1])).rows[0]!.id;
 }
 return {candidateId,candidateRevision:1,runId,website,sourceUrl,url};
}

async function capture(f:Awaited<ReturnType<typeof pending>>,options:{denyAfterFirstPage?:boolean}={}){
 const sent:string[]=[],modelInputs:string[]=[];
 const provider=researchPageFetch({lookup:async()=>['93.184.216.34'],request:async input=>{
  sent.push(input.url);
  if(input.url.endsWith('/robots.txt'))return ok('User-agent: *\nDisallow:\n','text/plain');
  if(input.url===f.sourceUrl)return {statusCode:301,headers:{location:f.url},body:null,abortedOverCap:false};
  if(input.url===f.url){
   if(options.denyAfterFirstPage)await tx(async()=>{await lockDiscoveryReviewSources(ctx());return runtime.query(`INSERT INTO audit_events(workspace_id,actor_kind,action,subject_kind,subject_id,detail)
    VALUES($1,'system','sourcing.manual_source_retention_expired','sourcing_source_hash',encode(sha256(convert_to(rtrim($2::text,'/'),'UTF8')),'hex'),'{}')`,[seed.alpha.workspaceId,f.sourceUrl]);});
   return ok('<main><p>Our property management team manages residential homes for owners and coordinates tenant maintenance requests.</p><p>General office: (617) 555-0123.</p></main>');
  }
  return {statusCode:404,headers:{},body:null,abortedOverCap:false};
 }});
 await runQualification(ctx(true),f,{pageFetch:provider,extraction:{providerKey:'aws_bedrock.sourcing_qualification',countInputTokens:async input=>{modelInputs.push(JSON.stringify(input));return 100;},extract:async input=>{modelInputs.push(JSON.stringify(input));return {ok:true,costCents:1,value:{facts:residentialFacts(input.observations),openingQuestion:null}};}}});
 return {sent,modelInputs};
}

it('carries an actual adapter slash redirect through an existing queued v1 capture, immutable storage and prepared list/detail only',async()=>{
 const f=await pending(),calls=await capture(f);
 expect(calls.sent).toEqual([f.website+'robots.txt',f.sourceUrl,f.url]);expect(calls.modelInputs).toHaveLength(2);
 for(const input of calls.modelInputs)expect(input).not.toMatch(/redirectTrace|redirectUrls|prepared_capture|capture_policy_version/u);
 const stored=(await runtime.query('SELECT capture_policy_version,prepared_capture,state,reason FROM sourcing_qualification_runs WHERE id=$1',[f.runId])).rows[0]!;
 expect(stored).toMatchObject({capture_policy_version:PREPARED_CAPTURE_V1,state:'review',reason:null,prepared_capture:{sourceUrl:f.sourceUrl,pages:[{url:f.url,redirectUrls:[f.sourceUrl,f.url]}]}});
 const before=await preparedProspectsBusinessSnapshot(ctx()),answer=await read(f);if(!answer.ok)throw Error(answer.reason);
 expect(answer.value).toMatchObject({state:'prepared',contactAuthority:'not_granted',coverage:'complete_retained_pages'});
 expect(answer.value.passages).toContainEqual(expect.objectContaining({kind:'business',url:f.url,quote:'Our property management team manages residential homes for owners and coordinates tenant maintenance requests.'}));
 expect(await tx(()=>listPreparedProspects(ctx(),{offset:0}))).toMatchObject({ok:true,value:{prospects:[{target:{candidateId:f.candidateId,candidateRevision:1,runId:f.runId},state:'prepared'}]}});
 await tx(async()=>{const row=await readManualProspectSubject(ctx(),{candidateId:f.candidateId,expectedRevision:1});if(!row)throw Error('missing controlled source');const snapshots=await manualPhoneSnapshots(ctx(),[{...row,duplicate_count:0}]);expect(projectManualPhone(snapshots[0]!)).toMatchObject({state:'not_extracted'});});
 expect(await preparedProspectsBusinessSnapshot(ctx())).toEqual(before);
 expect((await runtime.query('SELECT state,settled_cents FROM provider_reservations')).rows).toEqual([{state:'settled',settled_cents:1}]);
});

it('keeps an existing same-day queued legacy attempt legacy without another request, paid attempt or new provenance',async()=>{
 const f=await pending(true),before=await preparedProspectsBusinessSnapshot(ctx());
 expect(await tx(()=>requestQualification(ctx(true),{candidateId:f.candidateId,expectedRevision:1}))).toEqual({ok:true,value:{runId:f.runId}});
 expect(await preparedProspectsBusinessSnapshot(ctx())).toEqual(before);
 await capture(f);
 expect((await runtime.query('SELECT capture_policy_version,prepared_capture FROM sourcing_qualification_runs WHERE id=$1',[f.runId])).rows).toEqual([{capture_policy_version:'legacy',prepared_capture:null}]);
 expect(await read(f)).toMatchObject({ok:true,value:{state:'needs_research',passages:[]}});
});

it.each(['anchor','final'] as const)('refuses captured detail after known %s source loss without using the stored manifest as a license',async variant=>{
 const f=await pending();await capture(f);
 const url=variant==='anchor'?f.sourceUrl:f.url;
 await tx(async()=>{await lockDiscoveryReviewSources(ctx());return runtime.query(`INSERT INTO audit_events(workspace_id,actor_kind,action,subject_kind,subject_id,detail)
  VALUES($1,'system','sourcing.manual_source_retention_expired','sourcing_source_hash',encode(sha256(convert_to(rtrim($2::text,'/'),'UTF8')),'hex'),'{}')`,[seed.alpha.workspaceId,url]);});
 expect(await read(f)).toMatchObject({ok:false});
});

it.each(['anchor','final'] as const)('expires the captured brief at its %s dependency deadline after an authority wait',async variant=>{
 const f=await pending();await capture(f);
 const source=(await runtime.query<{observations:SourceObservation[]}>('SELECT observations FROM sourcing_qualification_runs WHERE id=$1',[f.runId])).rows[0]!.observations[0]!;
 const firm=(await runtime.query<{id:string}>('INSERT INTO firms(workspace_id,name) VALUES($1,$2) RETURNING id',[seed.alpha.workspaceId,'Fictional capture expiry'])).rows[0]!.id,expiry=Date.now()+1500;
 await runtime.query(`INSERT INTO evidence_items(workspace_id,firm_id,provider,source_reference,retrieved_at,terms_allow_retention,retention_expires_at,content_hash)
  VALUES($1,$2,'fixture',$3,$4,false,$5,$6)`,[seed.alpha.workspaceId,firm,variant==='anchor'?f.sourceUrl:f.url,source.retrievedAt,new Date(expiry),source.contentHash]);
 expect(await read(f)).toMatchObject({ok:true,value:{state:'prepared',validUntil:new Date(expiry).toISOString()}});
 let waits=0;
 const answer=await tx(()=>readPreparedProspect(ctx(),target(f),async()=>{if(++waits===2)await new Promise(resolve=>setTimeout(resolve,Math.max(0,expiry-Date.now()+40)));return true;}));
 expect(answer).toMatchObject({ok:false,reason:'source_expired'});expect(JSON.stringify(answer)).not.toContain('tenant maintenance');
});

it('refuses disclosure if originals and their manifest are erased during the final source-authority wait',async()=>{
 const f=await pending();await capture(f);let waits=0;
 const answer=await tx(()=>readPreparedProspect(ctx(),target(f),async()=>{if(++waits===2)await runtime.query("UPDATE sourcing_qualification_runs SET observations='[]',facts='[]' WHERE id=$1",[f.runId]);return true;}));
 expect(answer).toMatchObject({ok:false,reason:'source_changed'});
 expect((await runtime.query('SELECT prepared_capture FROM sourcing_qualification_runs WHERE id=$1',[f.runId])).rows).toEqual([{prepared_capture:null}]);
});

it('does not retain a new association when the source becomes denied after fetch but before terminal storage',async()=>{
 const f=await pending(),calls=await capture(f,{denyAfterFirstPage:true});expect(calls.modelInputs).toEqual([]);
 expect((await runtime.query('SELECT prepared_capture FROM sourcing_qualification_runs WHERE id=$1',[f.runId])).rows).toEqual([{prepared_capture:null}]);
 expect(await read(f)).toMatchObject({ok:false});
});

it('withholds a captured company brief when its administrator is revoked during the final authority wait',async()=>{
 const f=await pending();await capture(f);let waits=0;
 await db.session.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.salesperson.userId]);
 try{
  const answer=await tx(()=>readPreparedProspect(ctx(),target(f),async()=>{
   if(++waits===2)await runtime.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.admin.userId]);return true;
  }));
  expect(answer).toMatchObject({ok:false,reason:'authority_changed'});expect(JSON.stringify(answer)).not.toContain('tenant maintenance');
 }finally{
  await db.session.query("UPDATE workspace_memberships SET status='active',deactivated_at=NULL WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.admin.userId]);
  await db.session.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.salesperson.userId]);
 }
});
