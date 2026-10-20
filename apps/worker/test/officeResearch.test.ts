import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import {createTestDatabase,type TestDatabase} from '@fss/domain/db/testing/testDatabase.ts';
import {repositoryContext,workspaceScope,type RepositoryContext} from '@fss/domain/db/workspaceScope.ts';
import type {SessionQueryable,QueryResultRowLike,QueryOutcome} from '@fss/domain/db/queryable.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {previewDeletion,commitDeletion} from '@fss/domain/retention/deletion.ts';
import {recordingSuppressionJournal} from '@fss/domain/suppression/journal.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '@fss/domain/test/db/support/fixtures.ts';
import {seedCrm,type SeededCrm} from '@fss/domain/test/db/support/crmFixtures.ts';
import {officeProviders,officeHtml} from '@fss/domain/test/support/officeProviders.ts';
import type {PageFetchProvider} from '@fss/domain/research/providers.ts';
import {researchPageFetch,type RawResponse} from '../src/research/companyPageFetch.ts';
import {enqueueFirmResearch} from '@fss/domain/research/enqueue.ts';
import {readFirmOfficeAssessment} from '@fss/domain/research/officeAssessmentStore.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {runTwiceUnderStolenLease} from '@fss/domain/jobs/atLeastOnce.ts';
import {jobIdempotencyKey} from '@fss/domain/jobs/jobKinds.ts';
import {researchFirmJobHandler,parseResearchFirmPayload} from '../src/handlers/research.ts';
import {runOnce,runClaimedJob} from '../src/runner/jobRunner.ts';
let db:TestDatabase,members:TwoWorkspaces,crm:SeededCrm,ctx:RepositoryContext;
beforeEach(async()=>{db=await createTestDatabase();members=await seedTwoWorkspaces(db.session);crm=await seedCrm(db.session,members);ctx=repositoryContext(workspaceScope(members.alpha.workspaceId,{kind:'user',role:'admin',userId:members.alpha.admin.userId}),db.session);await db.session.query('INSERT INTO research_settings(workspace_id,enabled) VALUES($1,true)',[members.alpha.workspaceId]);});
afterEach(async()=>{await db.drop();});
const payload=()=>({firmId:crm.alpha.firmId,revision:1,trigger:'user_request',requestedByUserId:members.alpha.admin.userId,purpose:'office_evidence'});
const backoff={baseSeconds:0,factor:1,maximumSeconds:0,jitterFraction:0};
function failingOnce(pattern:RegExp):SessionQueryable{let armed=true;return {query:async <R extends QueryResultRowLike>(sql:string,values?:readonly unknown[]):Promise<QueryOutcome<R>>=>{if(armed&&pattern.test(sql)){armed=false;throw Object.assign(new Error('local fixture rollback'),{code:'40001'});}return await db.session.query<R>(sql,values);}};}
async function queue(){const result=await enqueueFirmResearch(ctx,{firmId:crm.alpha.firmId,trigger:'user_request',requestedByUserId:members.alpha.admin.userId,purpose:'office_evidence'});if(!result.ok)throw new Error(result.reason);return result.value;}
describe('strict office research through registered worker chunks',()=>{
 it.each(['capped','mixed failure','over cap'] as const)('handles real adapter %s output without weakening source or page bounds',async mode=>{
  await db.session.query('UPDATE research_settings SET max_pages_per_firm=2 WHERE workspace_id=$1',[members.alpha.workspaceId]);
  const p=officeProviders(),requested:string[]=[];
  const html=officeHtml+'<nav><a href="/contact-us">Contact</a><a href="/about-us">About</a></nav>';
  const response=(body:string,statusCode=200):RawResponse=>({statusCode,headers:{'content-type':'text/html'},body:new TextEncoder().encode(body),abortedOverCap:false});
  const adapter=researchPageFetch({lookup:async()=>['93.184.216.34'],now:()=>Date.now()-1000,request:async request=>{
   requested.push(request.url);
   if(request.url.endsWith('/robots.txt'))return response('User-agent: *\nDisallow:\n');
   return response(html+`<p>Source page ${request.url}</p>`,mode==='mixed failure'&&request.url.endsWith('/contact-us')?503:200);
  }});
  let actualPages=0,actualSkips:Readonly<Record<string,number>>={};
  const pageFetch:PageFetchProvider={providerKey:adapter.providerKey,fetchPages:async request=>{
   expect(request.maxPagesPerFirm).toBe(2);expect(request.prioritizeContactPages).toBe(true);
   const fetched=await adapter.fetchPages(request);if(!fetched.ok)throw new Error('fake adapter failed');
   actualPages=fetched.value.pages.length;actualSkips=fetched.value.skipped;
   if(mode!=='over cap')return fetched;
   return {...fetched,value:{...fetched.value,pages:[...fetched.value.pages,{...fetched.value.pages[0]!,url:'https://northwind.example.test/overflow'}]}};
  }};
  const registry=new HandlerRegistry().register(researchFirmJobHandler({pageFetch,extraction:p.extraction}));await queue();
  expect((await runOnce(db.session,{registry,owner:'strict-page-cap',limit:1})).completed).toBe(1);
  expect(actualPages).toBe(2);expect(actualSkips['page_budget_reached']).toBeGreaterThan(0);
  expect(requested.filter(url=>!url.endsWith('/robots.txt'))).toHaveLength(mode==='mixed failure'?3:2);
  const view=await readFirmOfficeAssessment(ctx,{firmId:crm.alpha.firmId});
  if(mode==='capped'){
   expect(actualSkips).toEqual({page_budget_reached:2});expect(p.stats()).toEqual({fetches:0,counts:1,calls:1});
   expect(view).toMatchObject({status:'supported',sourceCount:2});expect(p.requests[0]?.observations).toHaveLength(2);
   expect((await db.session.query('SELECT extraction,pages_fetched FROM research_runs')).rows).toEqual([{extraction:'used',pages_fetched:2}]);
  }else{
   if(mode==='mixed failure')expect(actualSkips['status_503']).toBe(1);
   expect(p.stats()).toEqual({fetches:0,counts:0,calls:0});expect(view).toMatchObject({status:'stale',reason:'source_incomplete',sourceCount:0});
   expect((await db.session.query('SELECT count(*)::int n FROM firm_office_assessment_sources')).rows).toEqual([{n:0}]);
   expect((await db.session.query('SELECT state FROM provider_reservations')).rows).toEqual([{state:'released'}]);
  }
 });
 it.each(['brief','office_evidence'] as const)('serializes simultaneous office and %s enqueue commands using one global revision space',async purpose=>{
  const left=await db.appRuntimeSession(),right=await db.appRuntimeSession();
  const leftContext=repositoryContext(ctx.scope,left),rightContext=repositoryContext(ctx.scope,right);
  const request={firmId:crm.alpha.firmId,trigger:'user_request' as const,requestedByUserId:members.alpha.admin.userId};
  const results=await Promise.all([
   withTransaction(left,()=>enqueueFirmResearch(leftContext,{...request,purpose:'office_evidence'})),
   withTransaction(right,()=>enqueueFirmResearch(rightContext,{...request,purpose})),
  ]);
  for(const result of results)expect(result.ok).toBe(true);
  if(!results[0]!.ok||!results[1]!.ok)throw new Error('enqueue refused');
  if(purpose==='brief'){
   expect(results.map(r=>r.ok?r.value.revision:0).sort()).toEqual([1,2]);
   expect(results[0]!.value.jobId).not.toBe(results[1]!.value.jobId);
  }else{
   expect(results[0]!.value.jobId).toBe(results[1]!.value.jobId);
   expect(results.filter(r=>r.ok&&r.value.inserted)).toHaveLength(1);
  }
 });
 it.each(['missing','malformed'] as const)('recovers %s strict progress from immutable durable purpose without opening another attempt',async mode=>{
  const p=officeProviders(),registry=new HandlerRegistry().register(researchFirmJobHandler(p));await queue();
  await runOnce(failingOnce(/UPDATE provider_reservations\s+SET state = 'calling'/u),{registry,owner:'strict-cursor-first',limit:1,backoff,random:()=>0});
  await db.session.query(mode==='missing'?"UPDATE jobs SET payload=payload-'progress' WHERE kind='research.firm'":"UPDATE jobs SET payload=jsonb_set(payload,'{progress}','{}') WHERE kind='research.firm'");
  expect((await runOnce(db.session,{registry,owner:'strict-cursor-recovered',limit:1,backoff,random:()=>0})).completed).toBe(1);
  expect(p.stats()).toEqual({fetches:1,counts:1,calls:1});
  expect((await db.session.query('SELECT purpose FROM research_runs')).rows).toEqual([{purpose:'office_evidence'}]);
  expect((await db.session.query('SELECT attempt FROM provider_reservations')).rows).toEqual([{attempt:1}]);
 });
 it('runs an existing manual firm once under stolen lease and rebuilds a source-owned result',async()=>{
  const p=officeProviders(),registry=new HandlerRegistry().register(researchFirmJobHandler(p));
  const report=await runTwiceUnderStolenLease({session:db.session,registry,run:runClaimedJob,workspaceId:members.alpha.workspaceId,kind:'research.firm',idempotencyKey:jobIdempotencyKey.researchFirm(crm.alpha.firmId,1),payload:payload(),countEffects:async()=>Number((await db.session.query<{n:number}>('SELECT count(*)::int n FROM firm_office_assessment_sources')).rows[0]?.n)});
  expect(report.freshOutcome).toBe('completed');expect(report.staleOutcome).toBe('lease_lost');expect(report.effectsAfter-report.effectsBefore).toBe(1);expect(p.stats()).toEqual({fetches:1,counts:1,calls:1});expect((await readFirmOfficeAssessment(ctx,{firmId:crm.alpha.firmId})).status).toBe('supported');
  expect((await db.session.query('SELECT purpose,brief,facts_recorded FROM research_runs')).rows).toEqual([{purpose:'office_evidence',brief:null,facts_recorded:0}]);
 });
 it('conserves an ambiguous billed strict attempt after publication rollback without a second call',async()=>{
  const p=officeProviders(),registry=new HandlerRegistry().register(researchFirmJobHandler(p));await queue();
  expect((await runOnce(failingOnce(/INSERT INTO firm_office_assessment_sources/u),{registry,owner:'strict-first',limit:1,backoff,random:()=>0})).failed).toBe(1);
  expect(p.stats().calls).toBe(1);
  expect((await runOnce(db.session,{registry,owner:'strict-second',limit:1,backoff,random:()=>0})).completed).toBe(1);
  expect(p.stats()).toEqual({fetches:1,counts:1,calls:1});expect((await db.session.query('SELECT state,attempt FROM provider_reservations')).rows).toEqual([{state:'estimated',attempt:1}]);expect((await readFirmOfficeAssessment(ctx,{firmId:crm.alpha.firmId})).status).not.toBe('supported');
 });
 it('rejects a changed payload purpose after the first committed chunk without dispatch',async()=>{
  const p=officeProviders(),registry=new HandlerRegistry().register(researchFirmJobHandler(p));await queue();
  await runOnce(failingOnce(/UPDATE provider_reservations\s+SET state = 'calling'/u),{registry,owner:'strict-reserved',limit:1,backoff,random:()=>0});
  expect((await db.session.query('SELECT purpose FROM research_runs')).rows).toEqual([{purpose:'office_evidence'}]);
  await db.session.query("UPDATE jobs SET payload=jsonb_set(payload,'{purpose}','\"brief\"') WHERE kind='research.firm'");
  expect((await runOnce(db.session,{registry,owner:'strict-tampered',limit:1,backoff,random:()=>0})).failed).toBe(1);expect(p.stats().calls).toBe(0);
 });
 it('requires an explicit existing user request and rejects unknown purposes',()=>{
  expect(parseResearchFirmPayload({...payload(),purpose:'other'})).toBeNull();expect(parseResearchFirmPayload({...payload(),trigger:'sweep'})).toBeNull();expect(parseResearchFirmPayload({...payload(),requestedByUserId:null})).toBeNull();expect(parseResearchFirmPayload({firmId:crm.alpha.firmId,revision:1,trigger:'sweep'})?.purpose).toBe('brief');
  expect(parseResearchFirmPayload({...payload(),requestedByUserId:''})).toBeNull();
  expect(parseResearchFirmPayload({...payload(),revision:2147483648})).toBeNull();
 });
 it('serializes a body-bearing response before erasure, then erases every copied source after a fresh preview',async()=>{
  const other=await db.appRuntimeSession(),erasingContext=repositoryContext(ctx.scope,other);
  const otherPid=(await other.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
  const preview=await previewDeletion(ctx,{targetKind:'contact',firmId:crm.alpha.firmId,contactId:crm.alpha.contactId});if(!preview.ok)throw new Error(preview.reason);
  let erasing:ReturnType<typeof commitDeletion>|undefined;
  const p=officeProviders({beforeExtract:async()=>{
   erasing=withTransaction(other,()=>commitDeletion(erasingContext,{requestId:preview.value.requestId,previewHash:preview.value.previewHash,commandId:'strict-erasure-race',journal:recordingSuppressionJournal()}));
   void erasing.catch(()=>undefined);
   let blocked=false;for(let n=0;n<100&&!blocked;n++){blocked=(await db.session.query<{blocked:boolean}>('SELECT pg_backend_pid()=ANY(pg_blocking_pids($1)) blocked',[otherPid])).rows[0]?.blocked===true;if(!blocked)await db.session.query('SELECT pg_sleep(0.01)');}expect(blocked).toBe(true);
  }}),registry=new HandlerRegistry().register(researchFirmJobHandler(p));await queue();
  expect((await runOnce(db.session,{registry,owner:'strict-erasure-worker',limit:1})).completed).toBe(1);
  expect(await erasing).toMatchObject({ok:false,reason:'preview_stale'});
  expect((await readFirmOfficeAssessment(ctx,{firmId:crm.alpha.firmId})).status).toBe('supported');
  const fresh=await previewDeletion(ctx,{targetKind:'contact',firmId:crm.alpha.firmId,contactId:crm.alpha.contactId});if(!fresh.ok)throw new Error(fresh.reason);
  expect((await withTransaction(db.session,()=>commitDeletion(ctx,{requestId:fresh.value.requestId,previewHash:fresh.value.previewHash,commandId:'strict-erasure-fresh',journal:recordingSuppressionJournal()}))).ok).toBe(true);
  expect((await db.session.query('SELECT count(*)::int n FROM firm_office_assessment_sources')).rows).toEqual([{n:0}]);expect((await readFirmOfficeAssessment(ctx,{firmId:crm.alpha.firmId})).status).not.toBe('supported');expect(p.stats().calls).toBe(1);
 });
});
