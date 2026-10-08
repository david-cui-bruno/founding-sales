import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {runDiscovery} from '../../sourcing/discovery.ts';
import {runQualification} from '../../sourcing/qualificationRun.ts';
import {listCandidates,saveCandidate,reviewCandidate} from '../../sourcing/candidates.ts';
import {withTransaction} from '../../db/queryable.ts';
import {updateResearchSettings} from '../../research/settings.ts';
import {readQualification,requestQualification} from '../../sourcing/qualificationStore.ts';
import type {PageFetchProvider} from '../../research/providers.ts';
import type {QualificationExtractionProvider} from '../../sourcing/qualificationPrompt.ts';
let db:TestDatabase,workspaceId:string;
const ctx=()=>repositoryContext(workspaceScope(workspaceId,{kind:'system',component:'worker'}),db.session);
beforeAll(async()=>{db=await createTestDatabase();workspaceId=(await seedTwoWorkspaces(db.session)).alpha.workspaceId;});
afterAll(async()=>db.drop());
beforeEach(async()=>{
 await db.session.query('DELETE FROM active_holds');await db.session.query('DELETE FROM sourcing_discovery_hits');await db.session.query('DELETE FROM sourcing_discovery_attempts');await db.session.query('DELETE FROM sourcing_candidates');
 await db.session.query('DELETE FROM provider_reservations');await db.session.query('DELETE FROM provider_ledger');
 await db.session.query('DELETE FROM sourcing_search_account');await db.session.query('DELETE FROM sourcing_discovery_settings');await db.session.query('DELETE FROM research_settings');await db.session.query('DELETE FROM daily_counters');
 await db.session.query('INSERT INTO sourcing_search_account(id) VALUES(true)');
 await db.session.query('INSERT INTO sourcing_discovery_settings(workspace_id,enabled,query_cursor) VALUES($1,true,2)',[workspaceId]);
});
const name='Example Residential Group, LLC';
const description=`${name} manages apartments in Boston, MA.`;
const card=[name,'221 Main Avenue','Suite 402','Boston, MA 02115','Contact Information','(617) 424-0775','(617) 424-0771','info@example.test',description];
const pages:PageFetchProvider={providerKey:'company_page',fetchPages:async()=>({ok:true,costCents:0,value:{pages:[{url:'https://example.test/contact',contentHash:'a'.repeat(64),contentType:'text/html',body:new TextEncoder().encode(card.map(t=>`<p>${t}</p>`).join('')),retrievedAt:new Date().toISOString(),firstParty:true}],skipped:{}}})};
const extraction:QualificationExtractionProvider={providerKey:'aws_bedrock.sourcing_qualification',countInputTokens:async()=>300,extract:async input=>{
 const source=input.observations.find(s=>s.url==='https://example.test/contact')!;
 const block=source.blocks.find(b=>b.text===description)!;
 const email=source.blocks.find(b=>b.text==='info@example.test')!;
 return {ok:true,costCents:1,value:{facts:[...(['firm_identity','residential_management','service_area'] as const).map(kind=>({kind,observationId:source.id,blockId:block.id,value:block.text})),{kind:'business_email',observationId:source.id,blockId:email.id,value:email.text}],openingQuestion:null}};
}};
async function discovered(){
 await runDiscovery(ctx(),{providerKey:'tavily_basic',discover:async()=>({ok:true,credits:1,requestId:'fixture',hits:[{url:'https://example.test/',title:'Boston Real Estate Development - Property Management - ERG',snippet:'Recorded search excerpt; not verified.'}]})});
 const listed=await listCandidates(ctx(),{status:'needs_review',offset:0});if(!listed.ok)throw Error(listed.reason);
 const candidate=listed.value.candidates[0]!;const view=await readQualification(ctx(),{candidateId:candidate.id});if(!view)throw Error('missing qualification');
 return {candidate,runId:view.runId};
}
it('recovers a supported legal office name in place and requires a new revision-bound qualification',async()=>{
 const original=await discovered();
 await runQualification(ctx(),{runId:original.runId},{pageFetch:pages,extraction});
 const listed=await listCandidates(ctx(),{status:'needs_review',offset:0});
 expect(listed).toMatchObject({ok:true,value:{candidates:[{id:original.candidate.id,firmName:name,revision:2,evidence:'Recorded search excerpt; not verified.',sourceUrl:'https://example.test/',discoveryQuery:'Boston residential property management'}]}});
 const view=await readQualification(ctx(),{candidateId:original.candidate.id});
 expect(view).toMatchObject({status:'pending',candidateRevision:2,history:[{runId:original.runId,facts:expect.arrayContaining([{kind:'business_email',value:'info@example.test',blockId:'b8',observationId:expect.any(String)}])}]});
 expect(view?.runId).not.toBe(original.runId);
 await runQualification(ctx(),{runId:view!.runId},{pageFetch:pages,extraction});
 expect(await readQualification(ctx(),{candidateId:original.candidate.id})).toMatchObject({status:'review',candidateRevision:2});
 expect(await listCandidates(ctx(),{status:'needs_review',offset:0})).toMatchObject({value:{candidates:[{id:original.candidate.id,revision:2,firmName:name}]}});
});

it('offers only complete first-party pages to extraction while retaining the original fetched evidence',async()=>{
 const original=await discovered();const offered:string[][]=[];
 const incomplete:PageFetchProvider={...pages,fetchPages:async request=>{
  const result=await pages.fetchPages(request);if(!result.ok)return result;
  return {...result,value:{...result.value,pages:[{...result.value.pages[0]!,url:'https://example.test/',body:new TextEncoder().encode(Array.from({length:150},(_,i)=>`<p>Incomplete published detail ${i}</p>`).join(''))},...result.value.pages]}};
 }};
 await runQualification(ctx(),{runId:original.runId},{pageFetch:incomplete,extraction:{...extraction,countInputTokens:async input=>{offered.push(input.observations.map(s=>s.url));return 300;}}});
 expect(offered).toEqual([['https://example.test/contact']]);
 expect(await readQualification(ctx(),{candidateId:original.candidate.id})).toMatchObject({status:'pending',history:[{observations:[{url:'https://example.test/',truncated:true},{url:'https://example.test/contact',truncated:false}]}]});
});

it('does not resolve a company from one selected address when another supported company card is present',async()=>{
 const original=await discovered();const other=['Other Residential Group, LLC','222 Main Avenue','Suite 403','Boston, MA 02115','Contact Information','(617) 424-0885','(617) 424-0881','another@example.test'];
 const ambiguous:PageFetchProvider={...pages,fetchPages:async request=>{
  const result=await pages.fetchPages(request);if(!result.ok)return result;
  return {...result,value:{...result.value,pages:[{...result.value.pages[0]!,body:new TextEncoder().encode([...card,...other].map(t=>`<p>${t}</p>`).join(''))}]}};
 }};
 await runQualification(ctx(),{runId:original.runId},{pageFetch:ambiguous,extraction});
 expect(await listCandidates(ctx(),{status:'needs_review',offset:0})).toMatchObject({value:{candidates:[{firmName:original.candidate.firmName,revision:1}]}});
 expect(await readQualification(ctx(),{candidateId:original.candidate.id})).toMatchObject({status:'review',candidateRevision:1});
});

it('leaves corrected evidence ineligible while the ordinary research ceiling defers a fresh run',async()=>{
 await withTransaction(db.session,()=>updateResearchSettings(ctx(),{dailyFirmCeiling:1}));
 const original=await discovered();await runQualification(ctx(),{runId:original.runId},{pageFetch:pages,extraction});
 expect(await listCandidates(ctx(),{status:'needs_review',offset:0})).toMatchObject({value:{qualificationWaitReason:'daily_firm_ceiling',candidates:[{id:original.candidate.id,firmName:name,revision:2}]}});
 expect(await readQualification(ctx(),{candidateId:original.candidate.id})).toMatchObject({status:'unavailable',reason:'candidate_changed',candidateRevision:1});
});
it('never rewrites a manual import even if discovery later associates a hit',async()=>{
 const manual=await withTransaction(db.session,()=>saveCandidate(ctx(),{firmName:'Manual approved name',website:'https://example.test/',locality:'Boston',region:'MA',signal:'fit_only',sourceUrl:'https://example.test/',evidence:'Operator evidence',observedOn:'2026-10-01',preparedBy:'Tavily Basic search · not verified',discoveryQuery:'Boston residential property management'}));if(!manual.ok)throw Error(manual.reason);
 const pending=await withTransaction(db.session,()=>requestQualification(ctx(),{candidateId:manual.value.id,expectedRevision:1}));if(!pending.ok)throw Error(pending.reason);
 await discovered(); // Discovery retains/associates a hit for the existing manually staged candidate.
 expect((await db.session.query('SELECT candidate_id FROM sourcing_discovery_hits')).rows).toMatchObject([{candidate_id:manual.value.id}]);
 await runQualification(ctx(),{runId:pending.value.runId},{pageFetch:pages,extraction});
 expect(await listCandidates(ctx(),{status:'needs_review',offset:0})).toMatchObject({value:{candidates:[{firmName:'Manual approved name',revision:1}]}});
});
it('never rewrites already edited discovery candidates',async()=>{
 const edited=await discovered();await withTransaction(db.session,()=>reviewCandidate(ctx(),{id:edited.candidate.id,expectedRevision:1,status:'kept'}));
 const next=await withTransaction(db.session,()=>requestQualification(ctx(),{candidateId:edited.candidate.id,expectedRevision:2}));if(!next.ok)throw Error(next.reason);
 await runQualification(ctx(),{runId:next.value.runId},{pageFetch:pages,extraction});
 expect(await listCandidates(ctx(),{status:'kept',offset:0})).toMatchObject({value:{candidates:[{firmName:edited.candidate.firmName,revision:2}]}});
});
it('refuses old queued qualification versions without fetching pages or charging extraction',async()=>{
 const original=await discovered();await db.session.query("UPDATE sourcing_qualification_runs SET policy_version='qualification-v2' WHERE id=$1",[original.runId]);
 let calls=0;
 await runQualification(ctx(),{runId:original.runId},{pageFetch:{...pages,fetchPages:async request=>{calls++;return pages.fetchPages(request);}},extraction:{...extraction,extract:async input=>{calls++;return extraction.extract(input);}}});
 expect(calls).toBe(0);expect(await readQualification(ctx(),{candidateId:original.candidate.id})).toMatchObject({status:'unavailable',reason:'qualification_version_changed'});
});
it('does not pay for extraction when all fetched pages are incomplete',async()=>{
 const original=await discovered();let calls=0;
 const incomplete:PageFetchProvider={...pages,fetchPages:async request=>{
  const result=await pages.fetchPages(request);if(!result.ok)return result;
  return {...result,value:{...result.value,pages:[{...result.value.pages[0]!,body:new TextEncoder().encode(Array.from({length:150},(_,i)=>`<p>Incomplete published detail ${i}</p>`).join(''))}]}};
 }};
 await runQualification(ctx(),{runId:original.runId},{pageFetch:incomplete,extraction:{...extraction,countInputTokens:async()=>{calls++;return 300;},extract:async input=>{calls++;return extraction.extract(input);}}});
 expect(calls).toBe(0);expect(await readQualification(ctx(),{candidateId:original.candidate.id})).toMatchObject({status:'unavailable',reason:'source_incomplete_or_unverified',observations:[{truncated:true}]});
});
it('preserves the candidate if research is paused during extraction',async()=>{
 const original=await discovered();await runQualification(ctx(),{runId:original.runId},{pageFetch:pages,extraction:{...extraction,extract:async input=>{
  const answer=await extraction.extract(input);await withTransaction(db.session,()=>updateResearchSettings(ctx(),{enabled:false}));return answer;
 }}});
 expect(await listCandidates(ctx(),{status:'needs_review',offset:0})).toMatchObject({value:{candidates:[{firmName:original.candidate.firmName,revision:1}]}});
});

it('rejects an extraction answer that cites a retained page excluded from its request',async()=>{
 const original=await discovered();
 const incomplete:PageFetchProvider={...pages,fetchPages:async request=>{
  const result=await pages.fetchPages(request);if(!result.ok)return result;
  return {...result,value:{...result.value,pages:[{...result.value.pages[0]!,url:'https://example.test/',body:new TextEncoder().encode(Array.from({length:150},(_,i)=>`<p>Incomplete detail ${i}</p>`).join(''))},...result.value.pages]}};
 }};
 await runQualification(ctx(),{runId:original.runId},{pageFetch:incomplete,extraction:{...extraction,extract:async()=>{
  const view=await readQualification(ctx(),{candidateId:original.candidate.id}),source=view!.observations[0]!,block=source.blocks[0]!;
  return {ok:true,costCents:1,value:{facts:[{kind:'firm_identity',value:block.text,observationId:source.id,blockId:block.id}],openingQuestion:null}};
 }}});
 expect(await readQualification(ctx(),{candidateId:original.candidate.id})).toMatchObject({status:'unavailable',reason:'invalid_evidence',observations:[{truncated:true},{truncated:false}],facts:[]});
 const {readCreditSpend}=await import('../../research/ledger.ts');
 expect(await readCreditSpend(ctx(),{at:new Date().toISOString(),businessTimeZone:'America/New_York'})).toMatchObject({todayCents:1});
});
it('refuses a corrected-name collision without duplicating or changing either candidate',async()=>{
 const original=await discovered();const collision=await withTransaction(db.session,()=>saveCandidate(ctx(),{firmName:name,website:original.candidate.website,locality:'Boston',region:'MA',signal:'fit_only',sourceUrl:original.candidate.sourceUrl,evidence:'Preserved manual candidate',preparedBy:'Manual',observedOn:'2026-10-01'}));expect(collision.ok).toBe(true);
 await runQualification(ctx(),{runId:original.runId},{pageFetch:pages,extraction});
 const listed=await listCandidates(ctx(),{status:'needs_review',offset:0});if(!listed.ok)throw Error(listed.reason);
 expect(listed.value.candidates).toHaveLength(2);
 expect(listed.value.candidates).toEqual(expect.arrayContaining([expect.objectContaining({id:original.candidate.id,firmName:original.candidate.firmName,revision:1}),expect.objectContaining({firmName:name,revision:1})]));
});
it.each(['info@other.test','example@gmail.com','[email protected]'])('does not recover identity through the unusable address %s',async email=>{
 const original=await discovered();const changed=card.map(text=>text==='info@example.test'?email:text);
 const unusable:PageFetchProvider={...pages,fetchPages:async request=>{
  const result=await pages.fetchPages(request);if(!result.ok)return result;
  return {...result,value:{...result.value,pages:[{...result.value.pages[0]!,body:new TextEncoder().encode(changed.map(t=>`<p>${t}</p>`).join(''))}]}};
 }};
 await runQualification(ctx(),{runId:original.runId},{pageFetch:unusable,extraction:{...extraction,extract:async input=>{
  const source=input.observations[0]!,block=source.blocks.find(b=>b.text===description)!,address=source.blocks.find(b=>b.text===email)!;
  return {ok:true,costCents:1,value:{facts:[...(['firm_identity','residential_management','service_area'] as const).map(kind=>({kind,observationId:source.id,blockId:block.id,value:block.text})),{kind:'business_email',observationId:source.id,blockId:address.id,value:address.text}],openingQuestion:null}};
 }}});
 expect(await listCandidates(ctx(),{status:'needs_review',offset:0})).toMatchObject({value:{candidates:[{id:original.candidate.id,revision:1,firmName:original.candidate.firmName}]}});
});

it('sees a research hold committed while identity recovery waits for the send gate',async()=>{
 const original=await discovered(),session=await db.appRuntimeSession();
 const other=repositoryContext(ctx().scope,session),pid=(await session.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
 const {openHold}=await import('../../policy/holds.ts');
 let opened!:()=>void;const holdOpened=new Promise<void>(resolve=>{opened=resolve;});
 const attempt=runQualification(other,{runId:original.runId},{pageFetch:pages,extraction:{...extraction,extract:async input=>{
  const answer=await extraction.extract(input);
  await db.session.query('BEGIN');
  await openHold(ctx(),{scopeKind:'workspace',reasonCode:'scoped_pause',blockedActionKinds:['research'],sourceEventKind:'regression_pause'});
  opened();return answer;
 }}});
 try{
  await holdOpened;
  await expect.poll(async()=>(await db.session.query<{wait_event_type:string}>('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.wait_event_type,{timeout:2000}).toBe('Lock');
  await db.session.query('COMMIT');await attempt;
 }finally{await db.session.query('ROLLBACK');}
 expect(await listCandidates(ctx(),{status:'needs_review',offset:0})).toMatchObject({value:{candidates:[{id:original.candidate.id,firmName:original.candidate.firmName,revision:1}]}});
});
