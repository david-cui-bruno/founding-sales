import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import {createTestDatabase,type TestDatabase} from '@fss/domain/db/testing/testDatabase.ts';
import {repositoryContext,workspaceScope,type RepositoryContext} from '@fss/domain/db/workspaceScope.ts';
import type {SessionQueryable,QueryResultRowLike,QueryOutcome} from '@fss/domain/db/queryable.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {previewDeletion,commitDeletion} from '@fss/domain/retention/deletion.ts';
import {recordingSuppressionJournal} from '@fss/domain/suppression/journal.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '@fss/domain/test/db/support/fixtures.ts';
import {seedCrm,type SeededCrm} from '@fss/domain/test/db/support/crmFixtures.ts';
import {officeProviders} from '@fss/domain/test/support/officeProviders.ts';
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
