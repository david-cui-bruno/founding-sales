import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {saveCandidate,reviewCandidate} from '../../sourcing/candidates.ts';
import {requestQualification,readQualification,finishQualification} from '../../sourcing/qualificationStore.ts';
import {runQualification} from '../../sourcing/qualificationRun.ts';
import type {PageFetchProvider} from '../../research/providers.ts';
import type {QualificationExtractionProvider} from '../../sourcing/qualificationPrompt.ts';
let db:TestDatabase,workspaceId:string,betaWorkspaceId:string;
const ctx=()=>repositoryContext(workspaceScope(workspaceId,{kind:'system',component:'worker'}),db.session);
const tx=<T>(fn:()=>Promise<T>)=>withTransaction(db.session,fn);
beforeAll(async()=>{db=await createTestDatabase();const seeded=await seedTwoWorkspaces(db.session);workspaceId=seeded.alpha.workspaceId;betaWorkspaceId=seeded.beta.workspaceId;});
afterAll(async()=>db.drop());
beforeEach(async()=>{for(const table of ['sourcing_candidates','provider_reservations','provider_ledger','research_settings','daily_counters'])await db.session.query(`DELETE FROM ${table}`);});
async function pending(){
 const candidate=await tx(()=>saveCandidate(ctx(),{firmName:'Example PM',website:'https://example.test/',locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Property manager',sourceUrl:'https://example.test/',observedOn:'2026-10-01',preparedBy:'Fixture'}));
 if(!candidate.ok)throw Error(candidate.reason);
 const run=await tx(()=>requestQualification(ctx(),{candidateId:candidate.value.id,expectedRevision:1}));if(!run.ok)throw Error(run.reason);
 return {candidateId:candidate.value.id,runId:run.value.runId};
}
const page=(body='<p>Example PM manages Dallas homes.</p>',firstParty=true)=>({url:'https://example.test/',contentHash:'a'.repeat(64),contentType:'text/html',body:new TextEncoder().encode(body),retrievedAt:new Date().toISOString(),firstParty});
const fetcher=(pages:ReturnType<typeof page>[],skipped:Record<string,number>={}):PageFetchProvider=>({providerKey:'company_page',fetchPages:async()=>({ok:true,costCents:0,value:{pages,skipped}})});
const audit=async(runId:string)=>(await db.session.query<{detail:Record<string,unknown>}>("SELECT detail FROM audit_events WHERE action='sourcing.qualification_recorded' AND detail->>'runId'=$1",[runId])).rows.map(r=>r.detail);
const diagnostic={version:'qualification-diagnostic-v1',phase:'no_observations',fetchedPages:0,observations:0,completeFirstParty:0,truncatedObservations:0,skipped:{}};
const failures=[
 ['fetch_failed','source_unavailable'],['fetch_exception','source_unavailable'],['no_observations','source_unavailable'],
 ['no_complete_first_party','source_incomplete_or_unverified'],['unoffered_observation','invalid_evidence'],['evidence_rejected','invalid_evidence'],
] as const;
it.each(failures)('records %s without changing terminal reason, admission or dispatch count',async(phase,reason)=>{
 const ids=await pending();let counted=0,paid=0;
 let pageFetch=fetcher([page()]);
 if(phase==='fetch_failed')pageFetch={providerKey:'company_page',fetchPages:async()=>({ok:false,costCents:0,failureCode:'private provider message https://private.test'})};
 if(phase==='fetch_exception')pageFetch={providerKey:'company_page',fetchPages:async()=>{throw Error('private exception https://private.test');}};
 if(phase==='no_observations')pageFetch=fetcher([page('')],{status_403:1,status_418:2,'https://private.test':9});
 if(phase==='no_complete_first_party')pageFetch=fetcher([page('<p>Third party detail</p>',false),page(Array.from({length:101},(_,i)=>`<p>Detail ${i}</p>`).join(''))],{page_budget_reached:1});
 const extraction:QualificationExtractionProvider={providerKey:'aws_bedrock.sourcing_qualification',countInputTokens:async()=>{counted++;return 300;},extract:async input=>{
  paid++;return {ok:true,costCents:1,value:{openingQuestion:null,facts:[{kind:'firm_identity',value:'not published',observationId:phase==='unoffered_observation'?randomUUID():input.observations[0]!.id,blockId:'missing'}]}};
 }};
 await runQualification(ctx(),ids,{pageFetch,extraction});await runQualification(ctx(),ids,{pageFetch,extraction});
 const modelPhase=phase==='unoffered_observation'||phase==='evidence_rejected';
 expect(counted).toBe(modelPhase?1:0);expect(paid).toBe(modelPhase?1:0);
 const view=await readQualification(ctx(),ids);expect(view).toMatchObject({status:'unavailable',reason,admission:null});expect(view).not.toHaveProperty('diagnostic');
 const events=await audit(ids.runId);expect(events).toHaveLength(1);expect(events[0]).toMatchObject({state:'unavailable',diagnostic:{version:'qualification-diagnostic-v1',phase}});
 expect(JSON.stringify(events)).not.toContain('private');expect(JSON.stringify(events)).not.toContain('published');
 expect((await db.session.query('SELECT state,settled_cents FROM provider_reservations')).rows).toEqual(modelPhase?[{state:'settled',settled_cents:1}]:[]);
 expect((await db.session.query('SELECT * FROM sourcing_admissions')).rows).toHaveLength(0);
 if(phase==='no_observations')expect(events[0]?.['diagnostic']).toEqual({...diagnostic,fetchedPages:1,skipped:{status_403:1,status_other:2}});
 if(phase==='no_complete_first_party')expect(events[0]?.['diagnostic']).toMatchObject({fetchedPages:2,observations:2,completeFirstParty:0,truncatedObservations:1});
 if(phase==='evidence_rejected')expect(events[0]?.['diagnostic']).toMatchObject({observations:1,completeFirstParty:1});
});
// One parsed page is bounded far below the 100000-byte observation bound (12000 characters), so
// only several pages together exceed it. They are trimmed, lowest priority last, not refused.
it('trims pages that together exceed the observation bound and offers the rest to the model once',async()=>{
 const ids=await pending();let counted=0,offered=0;
 const pageFetch=fetcher(Array.from({length:4},()=>page(Array.from({length:7},()=>`<p>${'界'.repeat(1500)}</p>`).join(''))));
 await runQualification(ctx(),ids,{pageFetch,extraction:{providerKey:'aws_bedrock.sourcing_qualification',countInputTokens:async input=>{counted++;offered=input.observations.length;return 300;},
  extract:async input=>({ok:true,costCents:1,value:{openingQuestion:null,facts:[{kind:'firm_identity',value:'not published',observationId:input.observations[0]!.id,blockId:'missing'}]}})}});
 expect(counted).toBe(1);expect(offered).toBe(3);
 const events=await audit(ids.runId);expect(events).toHaveLength(1);
 expect(events[0]?.['diagnostic']).toMatchObject({phase:'evidence_rejected',fetchedPages:4,observations:3});
});
it('honestly records eight configured pages and omits over-ceiling capture, without extra model work',async()=>{
 for(const count of [8,9]){
  await db.session.query('DELETE FROM sourcing_candidates');await db.session.query('DELETE FROM research_settings');
  await db.session.query('INSERT INTO research_settings(workspace_id,max_pages_per_firm) VALUES($1,8)',[workspaceId]);
  const ids=await pending();let calls=0;
  const pageFetch=fetcher(Array.from({length:count},()=>page('<p>Third party</p>',false)));
  const base=pageFetch.fetchPages;pageFetch.fetchPages=async request=>{expect(request.maxPagesPerFirm).toBe(8);return base(request);};
  await runQualification(ctx(),ids,{pageFetch,extraction:{providerKey:'aws_bedrock.sourcing_qualification',countInputTokens:async()=>{calls++;return 1;},extract:async()=>{throw Error('must not extract');}}});
  expect(calls).toBe(0);expect(await readQualification(ctx(),ids)).toMatchObject({status:'unavailable',reason:'source_incomplete_or_unverified'});
  const event=(await audit(ids.runId))[0]!;
  if(count===8)expect(event['diagnostic']).toMatchObject({fetchedPages:8,observations:8});else expect(event).not.toHaveProperty('diagnostic');
 }
});
it('sanitizes at the actual persistence boundary and omits malformed diagnostics without altering success or reason',async()=>{
 for(const mode of ['hostile','invalid','success'] as const){
  await db.session.query('DELETE FROM sourcing_candidates');const ids=await pending();
  const raw={...diagnostic,fetchedPages:mode==='invalid'?9:0,sourceText:'private',skipped:{status_418:2,request_failed:10001,'private url':5}};
  expect(await tx(()=>finishQualification(ctx(),{runId:ids.runId,observations:[],facts:[],reason:mode==='success'?null:'source_unavailable',diagnostic:raw}))).toMatchObject({ok:true});
  const event=(await audit(ids.runId))[0]!;
  if(mode==='hostile')expect(event['diagnostic']).toEqual({...diagnostic,skipped:{status_other:2}});else expect(event).not.toHaveProperty('diagnostic');
  expect(JSON.stringify(event)).not.toContain('private');
  expect(await readQualification(ctx(),ids)).toMatchObject({status:mode==='success'?'review':'unavailable',reason:mode==='success'?null:'source_unavailable',admission:null});
 }
});
it.each(['finished','corrected','deleted'] as const)('preserves %s caller refusal and creates no diagnostic event',async mode=>{
 const ids=await pending();
 const finish=()=>tx(()=>finishQualification(ctx(),{runId:ids.runId,observations:[],facts:[],reason:'source_unavailable',diagnostic}));
 if(mode==='finished')await finish();
 if(mode==='corrected')await tx(()=>reviewCandidate(ctx(),{id:ids.candidateId,expectedRevision:1,status:'kept'}));
 if(mode==='deleted')await db.session.query('DELETE FROM sourcing_candidates WHERE id=$1',[ids.candidateId]);
 expect(await finish()).toEqual({ok:false,reason:mode==='finished'?'run_finished':mode==='deleted'?'not_found':'candidate_changed'});
 expect(await audit(ids.runId)).toHaveLength(mode==='finished'?1:0);
 expect((await db.session.query('SELECT * FROM provider_reservations')).rows).toHaveLength(0);
});
it.each(['invalid_evidence','malformed_answer'] as const)('audits internal extraction rejection while preserving %s settlement, refusal and once-only dispatch',async reason=>{
 const ids=await pending();let calls=0;
 const extraction:QualificationExtractionProvider={providerKey:'aws_bedrock.sourcing_qualification',countInputTokens:async()=>100,extract:async input=>{
  calls++;
  const diagnostic={stage:'selection' as const,code:'block_missing' as const,selectionIndex:0,selectionCount:1,observationId:input.observations[0]!.id,blockId:'private missing block',stopReason:'max_tokens' as const,payload:'private provider text',schemaPath:['private'],message:'private'};
  return {ok:false,costCents:1,failureCode:reason,diagnostic};
 }};
 await runQualification(ctx(),ids,{pageFetch:fetcher([page()]),extraction});await runQualification(ctx(),ids,{pageFetch:fetcher([page()]),extraction});
 expect(calls).toBe(1);
 const view=await readQualification(ctx(),ids);expect(view).toMatchObject({status:'unavailable',reason,facts:[],admission:null});expect(view).not.toHaveProperty('diagnostic');
 const events=await audit(ids.runId);expect(events).toHaveLength(1);
 expect(events[0]).toMatchObject({diagnostic:{phase:'extraction_rejected',extraction:{stage:'selection',code:'block_missing',selectionIndex:0,selectionCount:1,observationId:view!.observations[0]!.id,stopReason:'max_tokens'}}});
 expect(JSON.stringify(events)).not.toContain('private');expect(JSON.stringify(events)).not.toContain('Example PM manages');
 expect((await db.session.query('SELECT state,settled_cents FROM provider_reservations')).rows).toEqual([{state:'settled',settled_cents:1}]);
 expect((await db.session.query('SELECT * FROM sourcing_admissions')).rows).toHaveLength(0);
});
it('drops hostile extraction metadata after settlement, never changing finish or replay safety',async()=>{
 const ids=await pending();let calls=0;
 const extraction:QualificationExtractionProvider={providerKey:'aws_bedrock.sourcing_qualification',countInputTokens:async()=>100,extract:async()=>{
  calls++;return Object.defineProperty({ok:false as const,failureCode:'invalid_evidence',costCents:1},'diagnostic',{get(){throw Error('private hostile getter');}});
 }};
 await runQualification(ctx(),ids,{pageFetch:fetcher([page()]),extraction});await runQualification(ctx(),ids,{pageFetch:fetcher([page()]),extraction});
 expect(calls).toBe(1);expect(await readQualification(ctx(),ids)).toMatchObject({status:'unavailable',reason:'invalid_evidence',facts:[]});
 expect((await audit(ids.runId))[0]).toMatchObject({diagnostic:{phase:'extraction_rejected'}});
 expect((await db.session.query('SELECT state,settled_cents FROM provider_reservations')).rows).toEqual([{state:'settled',settled_cents:1}]);
});
it('reconstructs extraction audit only from this run offered observations and refuses another workspace',async()=>{
 const ids=await pending(),observation={id:randomUUID(),url:'https://example.test/',contentHash:'b'.repeat(64),relevantTextHash:'c'.repeat(64),retrievedAt:new Date().toISOString(),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[{id:'b1',text:'private original source'}]};
 const raw={...diagnostic,phase:'extraction_rejected',fetchedPages:1,observations:1,completeFirstParty:1,extraction:{stage:'citation_roles',code:'identity_not_literal',observationId:observation.id,blockId:'b1',selectionIndex:0,selectionCount:1,schemaField:'private path',stopReason:'private provider reason',quote:'private'}};
 const beta=repositoryContext(workspaceScope(betaWorkspaceId,{kind:'system',component:'worker'}),db.session);
 const finish=(context=ctx())=>tx(()=>finishQualification(context,{runId:ids.runId,observations:[observation],facts:[],reason:'invalid_evidence',diagnostic:raw}));
 expect(await finish(beta)).toEqual({ok:false,reason:'not_found'});expect(await readQualification(beta,ids)).toBeNull();expect(await audit(ids.runId)).toHaveLength(0);
 expect(await finish()).toMatchObject({ok:true});
 expect((await audit(ids.runId))[0]).toMatchObject({diagnostic:{extraction:{stage:'citation_roles',code:'identity_not_literal',observationId:observation.id,blockId:'b1',selectionIndex:0,selectionCount:1}}});
 expect(JSON.stringify(await audit(ids.runId))).not.toContain('private');
 expect((await db.session.query("SELECT workspace_id FROM audit_events WHERE action='sourcing.qualification_recorded' AND detail->>'runId'=$1",[ids.runId])).rows).toEqual([{workspace_id:workspaceId}]);
 // An existing UUID/block pair from another capture is not offered to the next run.
 await db.session.query('DELETE FROM sourcing_candidates');const next=await pending();
 expect(await tx(()=>finishQualification(ctx(),{runId:next.runId,observations:[],facts:[],reason:'invalid_evidence',diagnostic:raw}))).toMatchObject({ok:true});
 const event=(await audit(next.runId))[0]!,text=JSON.stringify(event);
 expect(text).not.toContain(observation.id);expect(text).not.toContain('private');
 expect(event).toMatchObject({diagnostic:{extraction:{stage:'citation_roles',code:'identity_not_literal'}}});
});
