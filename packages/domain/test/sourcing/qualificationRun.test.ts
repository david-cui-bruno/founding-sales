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
beforeEach(async()=>{await db.session.query('DELETE FROM active_holds');await db.session.query('DELETE FROM sourcing_candidates');await db.session.query('DELETE FROM provider_reservations');await db.session.query('DELETE FROM provider_ledger');await db.session.query('DELETE FROM research_settings');await db.session.query('DELETE FROM daily_counters');});
async function pending(){const candidate=await tx(()=>saveCandidate(ctx(),{firmName:'Example PM',website:'https://example.test/',locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Property manager',sourceUrl:'https://example.test/',observedOn:'2026-10-01',preparedBy:'Fixture'}));if(!candidate.ok)throw new Error(candidate.reason);const run=await tx(()=>requestQualification(ctx(),{candidateId:candidate.value.id,expectedRevision:1}));if(!run.ok)throw new Error(run.reason);return {candidateId:candidate.value.id,runId:run.value.runId};}
const pages:PageFetchProvider={providerKey:'company_page',fetchPages:async request=>{
 expect(request.urls).toEqual(['https://example.test/']);expect(request.maxPagesPerFirm).toBe(4);expect(await request.shouldContinue?.()).toBe(true);
 return {ok:true,costCents:0,value:{pages:[{url:'https://example.test/',contentHash:'a'.repeat(64),contentType:'text/html',body:new TextEncoder().encode('<p>Example PM manages residential homes in Dallas.</p><p>We need help with maintenance coordination.</p>'),retrievedAt:new Date().toISOString(),firstParty:true}],skipped:{}}};}};
const extractor=(runId:string):QualificationExtractionProvider=>({providerKey:'aws_bedrock.sourcing_qualification',countInputTokens:async input=>{expect(input.candidate).toEqual({firmName:'Example PM',locality:'Dallas',region:'TX',website:'https://example.test/'});return 300;},extract:async input=>{
 expect(input.candidate).toEqual({firmName:'Example PM',locality:'Dallas',region:'TX',website:'https://example.test/'});
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
it('refuses old prompt runs before fetch, token counting or paid dispatch',async()=>{
 const ids=await pending();await db.session.query("UPDATE sourcing_qualification_runs SET prompt_version='qualification-growth-v6' WHERE id=$1",[ids.runId]);
 let calls=0;await runQualification(ctx(),ids,{pageFetch:{...pages,fetchPages:async()=>{calls++;throw new Error('must not fetch');}},extraction:{...extractor(ids.runId),countInputTokens:async()=>{calls++;return 1;}}});
 expect(calls).toBe(0);expect(await readQualification(ctx(),ids)).toMatchObject({status:'unavailable',reason:'qualification_version_changed'});
 expect((await db.session.query('SELECT id FROM provider_reservations')).rows).toHaveLength(0);
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

it('counts credit-funded interpretation and routine replies against the same research ceiling',async()=>{
 const ids=await pending();let calls=0;
 const {recordProviderCall}=await import('../../research/ledger.ts');
 await tx(()=>recordProviderCall(ctx(),{providerKey:'aws_bedrock.outreach_reply',at:new Date().toISOString(),businessTimeZone:'America/New_York',costCents:1000}));
 await runQualification(ctx(),ids,{pageFetch:pages,extraction:{...extractor(ids.runId),extract:async()=>{calls++;throw new Error('must not spend beyond credit ceiling');}}});
 expect(calls).toBe(0);
 expect(await readQualification(ctx(),ids)).toMatchObject({status:'unavailable',reason:'research_budget_or_hold'});
});

it.each(['before_request','queued','during_count'] as const)('honors a research channel pause %s without paid dispatch',async phase=>{
 const ids=await pending();const {openHold}=await import('../../policy/holds.ts');let calls=0;
 const pause=()=>tx(()=>openHold(ctx(),{scopeKind:'channel',scopeKey:'research',reasonCode:'scoped_pause',blockedActionKinds:['research'],sourceEventKind:'research_channel_test'}));
 if(phase!=='during_count')await pause();
 if(phase==='before_request'){
  const next=await tx(()=>saveCandidate(ctx(),{firmName:'Second PM',website:'https://second.test/',locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Property manager',sourceUrl:'https://second.test/',observedOn:'2026-10-01',preparedBy:'Fixture'}));
  if(!next.ok)throw Error(next.reason);
  expect(await tx(()=>requestQualification(ctx(),{candidateId:next.value.id,expectedRevision:1}))).toEqual({ok:false,reason:'research_held'});
 }
 await runQualification(ctx(),ids,{pageFetch:{...pages,fetchPages:async input=>{calls++;return pages.fetchPages(input);}},extraction:{...extractor(ids.runId),countInputTokens:async()=>{if(phase==='during_count')await pause();return 100;},extract:async()=>{calls++;throw Error('held extraction must not run');}}});
 expect(calls).toBe(phase==='during_count'?1:0);
 expect((await db.session.query('SELECT id FROM provider_reservations')).rows).toHaveLength(0);
 expect((await db.session.query<{enabled:boolean}>('SELECT enabled FROM research_settings WHERE workspace_id=$1',[workspaceId])).rows[0]?.enabled??true).toBe(true);
});

it.each(['email','call','unrelated_owner'] as const)('does not infer candidate ownership or widen %s pauses',async lane=>{
 const ids=await pending();const {openHold}=await import('../../policy/holds.ts');
 const admin=(await db.session.query<{user_id:string}>("SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND role='admin'",[workspaceId])).rows[0]!.user_id;
 await tx(()=>openHold(ctx(),{scopeKind:lane==='unrelated_owner'?'owner':'channel',scopeKey:lane==='unrelated_owner'?admin:lane,reasonCode:'scoped_pause',blockedActionKinds:lane==='email'?['email_send']:lane==='call'?['dial_authorization']:['research'],sourceEventKind:'research_channel_test'}));
 let paid=0;await runQualification(ctx(),ids,{pageFetch:pages,extraction:{...extractor(ids.runId),extract:async()=>{paid++;return {ok:true,costCents:1,value:{facts:[],openingQuestion:null}};}}});
 expect(paid).toBe(1);
});

it('research channel pauses discovery and kept-candidate checks, then release restores monitoring',async()=>{
 const ids=await pending();
 await tx(()=>reviewCandidate(ctx(),{id:ids.candidateId,expectedRevision:1,status:'kept'}));
 await db.session.query("UPDATE sourcing_candidates SET next_source_check_at=now()-interval '1 hour' WHERE id=$1",[ids.candidateId]);
 const {openHold,releaseHold}=await import('../../policy/holds.ts');
 const {monitorCandidateSources}=await import('../../sourcing/monitoring.ts');
 const {requestSourceCheck}=await import('../../sourcing/sourceCheck.ts');
 const {runDiscovery}=await import('../../sourcing/discovery.ts');
 await db.session.query('INSERT INTO sourcing_search_account(id) VALUES(true) ON CONFLICT DO NOTHING');
 await db.session.query("INSERT INTO sourcing_discovery_settings(workspace_id,enabled,next_run_at) VALUES($1,true,now()-interval '1 hour')",[workspaceId]);
 const hold=await tx(()=>openHold(ctx(),{scopeKind:'channel',scopeKey:'research',reasonCode:'scoped_pause',blockedActionKinds:['research'],sourceEventKind:'research_channel_test'}));
 expect(await tx(()=>requestSourceCheck(ctx(),{id:ids.candidateId,expectedRevision:2}))).toEqual({ok:false,reason:'research_held'});
 expect(await tx(()=>monitorCandidateSources(ctx()))).toEqual({queued:0});
 let searches=0;
 await runDiscovery(ctx(),{providerKey:'tavily_basic',discover:async()=>{searches++;throw Error('held search must not run');}});
 expect(searches).toBe(0);
 await tx(()=>releaseHold(ctx(),hold));
 expect(await tx(()=>monitorCandidateSources(ctx()))).toEqual({queued:1});
 await runDiscovery(ctx(),{providerKey:'tavily_basic',discover:async()=>{searches++;return {ok:true,credits:1,requestId:'released-fixture',hits:[]};}});
 expect(searches).toBe(1);
});
