import type {SourceObservation} from '@fss/contracts';
import {afterAll,beforeAll,beforeEach,it,expect} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {saveCandidate,reviewCandidate} from '../../sourcing/candidates.ts';
import {requestQualification,readQualification} from '../../sourcing/qualificationStore.ts';
import {runQualification,expireQualifications} from '../../sourcing/qualificationRun.ts';
import type {PageFetchProvider} from '../../research/providers.ts';
import type {QualificationExtractionProvider} from '../../sourcing/qualificationPrompt.ts';
let db:TestDatabase;let workspaceId:string;
const ctx=()=>repositoryContext(workspaceScope(workspaceId,{kind:'system',component:'worker'}),db.session);
const tx=<T>(fn:()=>Promise<T>)=>withTransaction(db.session,fn);
beforeAll(async()=>{db=await createTestDatabase();workspaceId=(await seedTwoWorkspaces(db.session)).alpha.workspaceId;});
afterAll(async()=>db.drop());
beforeEach(async()=>{await db.session.query('DELETE FROM sourcing_candidates');await db.session.query('DELETE FROM provider_reservations');await db.session.query('DELETE FROM provider_ledger');await db.session.query('DELETE FROM research_settings');await db.session.query('DELETE FROM daily_counters');});
async function pending(){const candidate=await tx(()=>saveCandidate(ctx(),{firmName:'Example PM',website:'https://example.test/',locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Property manager',sourceUrl:'https://example.test/',observedOn:'2026-10-01',preparedBy:'Fixture'}));if(!candidate.ok)throw new Error(candidate.reason);const run=await tx(()=>requestQualification(ctx(),{candidateId:candidate.value.id,expectedRevision:1}));if(!run.ok)throw new Error(run.reason);return {candidateId:candidate.value.id,runId:run.value.runId};}
const pages:PageFetchProvider={providerKey:'company_page',fetchPages:async request=>{
 expect(request.urls).toEqual(['https://example.test/']);expect(request.maxPagesPerFirm).toBe(4);expect(await request.shouldContinue?.()).toBe(true);
 return {ok:true,costCents:0,value:{pages:[{url:'https://example.test/',contentHash:'a'.repeat(64),contentType:'text/html',body:new TextEncoder().encode('<p>Example PM manages residential homes in Dallas.</p><p>We need help with maintenance coordination.</p>'),retrievedAt:new Date().toISOString(),firstParty:true}],skipped:{}}};}};
const extractor=(runId:string):QualificationExtractionProvider=>({providerKey:'aws_bedrock.sourcing_qualification',countInputTokens:async()=>300,extract:async _input=>{
 const second=await db.appRuntimeSession();expect((await second.query('SELECT state FROM provider_reservations WHERE subject_id=$1',[runId])).rows).toEqual([{state:'calling'}]);
 return {ok:true,costCents:1,value:{facts:[],openingQuestion:null}};
}});
it('commits one paid dispatch, preserves evidence, and never repeats a replayed run',async()=>{
 const ids=await pending();let calls=0;const base=extractor(ids.runId);
 const extraction={...base,extract:async(input:Parameters<typeof base.extract>[0])=>{calls++;return base.extract(input);}};
 await runQualification(ctx(),ids,{pageFetch:pages,extraction});await runQualification(ctx(),ids,{pageFetch:pages,extraction});
 expect(calls).toBe(1);expect(await readQualification(ctx(),ids)).toMatchObject({status:'review',observations:[{publishedAt:null}]});
 expect((await db.session.query('SELECT state,settled_cents FROM provider_reservations')).rows).toEqual([{state:'settled',settled_cents:1}]);
});
it('keeps dispatched timeout spend estimated and expires crashed runs independently',async()=>{
 const ids=await pending();await runQualification(ctx(),ids,{pageFetch:pages,extraction:{...extractor(ids.runId),extract:async()=>{throw new Error('timeout');}}});
 expect((await db.session.query('SELECT state FROM provider_reservations')).rows).toEqual([{state:'estimated'}]);
 expect(await readQualification(ctx(),ids)).toMatchObject({status:'unavailable',reason:'provider_error'});
 const other=await pending();await db.session.query("UPDATE sourcing_qualification_runs SET state='running',requested_at=now()-interval '1 hour',deadline_at=now()-interval '1 minute' WHERE id=$1",[other.runId]);
 await expireQualifications(ctx());expect(await readQualification(ctx(),other)).toMatchObject({status:'unavailable',reason:'qualification_expired'});
});
it('does not dispatch on a noncredit port or after candidate dismissal',async()=>{
 const ids=await pending();let calls=0;const base=extractor(ids.runId);
 await runQualification(ctx(),ids,{pageFetch:pages,extraction:{...base,providerKey:'anthropic_extraction',extract:async i=>{calls++;return base.extract(i);}}});
 expect(calls).toBe(0);expect(await readQualification(ctx(),ids)).toMatchObject({reason:'credit_route_unavailable'});
});
it('discards effects but settles cost when the candidate changes during extraction',async()=>{
 const ids=await pending();await runQualification(ctx(),ids,{pageFetch:pages,extraction:{...extractor(ids.runId),extract:async()=>{
  await tx(()=>reviewCandidate(ctx(),{id:ids.candidateId,expectedRevision:1,status:'dismissed'}));
  return {ok:true,costCents:1,value:{facts:[],openingQuestion:null}};
 }}});
 expect(await readQualification(ctx(),ids)).toMatchObject({status:'unavailable',reason:'candidate_dismissed'});
 expect((await db.session.query('SELECT state FROM provider_reservations')).rows).toEqual([{state:'settled'}]);
});
it('reuses unchanged interpretation on a later run while refreshing observed time only',async()=>{
 const ids=await pending();let calls=0;const base=extractor(ids.runId);
 const extraction={...base,extract:async()=>{calls++;return {ok:true as const,costCents:1,value:{facts:[],openingQuestion:null}};}};
 await runQualification(ctx(),ids,{pageFetch:pages,extraction});
 await db.session.query("UPDATE sourcing_qualification_runs SET fingerprint=repeat('d',64) WHERE id=$1",[ids.runId]);
 const next=await tx(()=>requestQualification(ctx(),{candidateId:ids.candidateId,expectedRevision:1}));if(!next.ok)throw new Error(next.reason);
 await runQualification(ctx(),{runId:next.value.runId},{pageFetch:pages,extraction});expect(calls).toBe(1);
 expect(await readQualification(ctx(),ids)).toMatchObject({runId:next.value.runId,status:'review',observations:[{publishedAt:null}]});
});
it('honors pause after token counting and does not renew evidence after an unavailable refresh',async()=>{
 const ids=await pending();let calls=0;
 await runQualification(ctx(),ids,{pageFetch:pages,extraction:{...extractor(ids.runId),countInputTokens:async()=>{await db.session.query('INSERT INTO research_settings(workspace_id,enabled) VALUES($1,false)',[workspaceId]);return 100;},extract:async()=>{calls++;throw new Error('must not call');}}});
 expect(calls).toBe(0);expect((await db.session.query('SELECT id FROM provider_reservations')).rows).toHaveLength(0);
 expect(await readQualification(ctx(),ids)).toMatchObject({status:'unavailable'});
});
it('preserves an explicit publication date and refuses future publication claims',async()=>{
 for(const date of ['2026-10-01','2099-01-01']){
  await db.session.query('DELETE FROM sourcing_candidates');const ids=await pending();
  const dated:PageFetchProvider={providerKey:'company_page',fetchPages:async()=>({ok:true,costCents:0,value:{pages:[{url:'https://example.test/',contentHash:'c'.repeat(64),contentType:'text/html',body:new TextEncoder().encode(`<p>Published ${date}</p><p>We need coordination help.</p>`),retrievedAt:new Date().toISOString(),firstParty:true}],skipped:{}}})};
  await runQualification(ctx(),ids,{pageFetch:dated,extraction:extractor(ids.runId)});
  expect((await readQualification(ctx(),ids))?.observations[0]?.publishedAt).toBe(date==='2026-10-01'?'2026-10-01T00:00:00.000Z':null);
 }
});
it('preserves historical evidence when a later read fails',async()=>{
 const ids=await pending();await runQualification(ctx(),ids,{pageFetch:pages,extraction:extractor(ids.runId)});
 await db.session.query("UPDATE sourcing_qualification_runs SET fingerprint=repeat('d',64) WHERE id=$1",[ids.runId]);
 const next=await tx(()=>requestQualification(ctx(),{candidateId:ids.candidateId,expectedRevision:1}));if(!next.ok)throw new Error(next.reason);
 await runQualification(ctx(),{runId:next.value.runId},{pageFetch:{providerKey:'company_page',fetchPages:async()=>({ok:false,costCents:0,failureCode:'timeout'})},extraction:extractor(next.value.runId)});
 const view=await readQualification(ctx(),ids);expect(view).toMatchObject({status:'unavailable',observations:[],reason:'source_unavailable'});expect(view?.history[0]?.observations).toHaveLength(1);
});

it('settles expired spend even after a wrong-firm correction or candidate deletion',async()=>{
 const {reserveAttempt,markCalling}=await import('../../research/reservations.ts');
 const {recordSourcingFeedback}=await import('../../sourcing/feedback.ts');
 for(const removed of [false,true]){
  const ids=await pending();
  const reservation=await tx(async()=>{const r=await reserveAttempt(ctx(),{subjectKind:'sourcing_qualification',subjectId:ids.runId,attempt:1,providerKey:'aws_bedrock.sourcing_qualification',at:new Date().toISOString(),businessTimeZone:'America/New_York',cents:2,modelName:'claude-haiku-4-5',maxInputTokens:100,maxOutputTokens:2048});await markCalling(ctx(),r.id);return r;});
  const user=(await db.session.query<{user_id:string}>("SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND role='admin'",[workspaceId])).rows[0]!.user_id;
  const admin=repositoryContext(workspaceScope(workspaceId,{kind:'user',role:'admin',userId:user}),db.session);
  await tx(()=>recordSourcingFeedback(admin,{candidateId:ids.candidateId,qualificationRunId:ids.runId,code:'wrong_firm'}));
  await db.session.query("UPDATE provider_reservations SET created_at=now()-interval '31 minutes' WHERE id=$1",[reservation.id]);
  if(removed)await db.session.query('DELETE FROM sourcing_candidates WHERE id=$1',[ids.candidateId]);
  await expireQualifications(ctx());
  expect((await db.session.query('SELECT state,settled_cents FROM provider_reservations WHERE id=$1',[reservation.id])).rows[0]).toEqual({state:'estimated',settled_cents:2});
  if(!removed)await db.session.query('DELETE FROM sourcing_candidates WHERE id=$1',[ids.candidateId]);
 }
});
it('retains useful complete text after the first 32 blocks within existing parser bounds',async()=>{
 const ids=await pending();const seen:SourceObservation[]=[];
 const page:PageFetchProvider={providerKey:'company_page',fetchPages:async()=>({ok:true,costCents:0,value:{pages:[{url:'https://example.test/',contentHash:'e'.repeat(64),contentType:'text/html',body:new TextEncoder().encode('<nav>'+Array.from({length:40},(_,i)=>`<p>Navigation ${i}</p>`).join('')+'</nav><main>'+Array.from({length:40},(_,i)=>`<p>Published business detail ${i}</p>`).join('')+'<p>Example PM manages homes in Dallas, Texas.</p></main>'),retrievedAt:new Date().toISOString(),firstParty:true}],skipped:{}}})};
 await runQualification(ctx(),ids,{pageFetch:page,extraction:{...extractor(ids.runId),extract:async input=>{seen.push(...input.observations);return {ok:true,costCents:1,value:{facts:[],openingQuestion:null}};}}});
 expect(seen[0]?.blocks.some(b=>b.text.includes('Example PM'))).toBe(true);expect(seen[0]?.blocks.some(b=>b.text.includes('Navigation'))).toBe(false);expect(seen[0]?.truncated).toBe(false);
});
