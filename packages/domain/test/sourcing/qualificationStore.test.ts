import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { saveCandidate, reviewCandidate, deleteCandidate } from '../../sourcing/candidates.ts';
import { requestQualification, readQualification, finishQualification } from '../../sourcing/qualificationStore.ts';
import { reserveAttempt, markCalling, settleAttempt } from '../../research/reservations.ts';

let database: TestDatabase;
let seeded: TwoWorkspaces;
const candidate = { firmName:'Example PM', website:'https://example.test/', locality:'Dallas', region:'TX' as const,
  signal:'explicit_help' as const, evidence:'We need maintenance coordination help.',
  sourceUrl:'https://example.test/about', observedOn:'2026-10-01', preparedBy:'Research' };
const context = (workspace:'alpha'|'beta'='alpha', role:'admin'|'salesperson'='admin') => {
  const who=seeded[workspace];
  return repositoryContext(workspaceScope(who.workspaceId,{kind:'user',userId:who[role].userId,role}),database.session);
};
const tx = <T>(fn:()=>Promise<T>) => withTransaction(database.session,fn);
const create = async () => {
  const saved=await tx(()=>saveCandidate(context(),candidate));
  if(!saved.ok)throw new Error(saved.reason);
  return saved.value.id;
};
const request = async (candidateId:string,expectedRevision=1) => {
  const result=await tx(()=>requestQualification(context(),{candidateId,expectedRevision}));
  if(!result.ok)throw new Error(result.reason);
  return result.value.runId;
};
const observation = () => ({ id:randomUUID(),url:candidate.sourceUrl,contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),
  retrievedAt:new Date().toISOString(),publishedAt:'2026-10-01T00:00:00Z',publishedAtBlockId:'date',firstParty:true,truncated:false,
  blocks:[{id:'date',text:'Published 2026-10-01'},{id:'help',text:candidate.evidence}] });
beforeAll(async()=>{database=await createTestDatabase();seeded=await seedTwoWorkspaces(database.session);});
beforeEach(async()=>{
  await database.session.query('DELETE FROM sourcing_candidates');
  await database.session.query("DELETE FROM jobs WHERE kind='sourcing.qualify'");
  await database.session.query('DELETE FROM research_settings');
  await database.session.query('DELETE FROM daily_counters');
});
afterAll(async()=>{await database.drop();});

it('deduplicates a candidate revision and refuses other workspaces and non-admin callers',async()=>{
  const candidateId=await create();
  expect(await requestQualification(context('beta'),{candidateId,expectedRevision:1})).toEqual({ok:false,reason:'not_found'});
  expect(await requestQualification(context('alpha','salesperson'),{candidateId,expectedRevision:1})).toEqual({ok:false,reason:'admin_only'});
  const runId=await request(candidateId);
  expect(await request(candidateId)).toBe(runId);
  expect(await readQualification(context('beta'),{candidateId})).toBeNull();
  expect(await readQualification(context('alpha','salesperson'),{candidateId})).toBeNull();
  expect(await readQualification(context(),{candidateId})).toMatchObject({runId,status:'pending',candidateId,observations:[],facts:[]});
  const jobs=await database.session.query<{payload:unknown;max_attempts:number}>("SELECT payload,max_attempts FROM jobs WHERE kind='sourcing.qualify'");
  expect(jobs.rows).toHaveLength(1);
  expect(jobs.rows[0]).toMatchObject({payload:{runId,candidateId,candidateRevision:1,promptVersion:'qualification-email-v2',policyVersion:'qualification-v1'},max_attempts:1});
  expect(JSON.stringify(jobs.rows)).not.toContain(candidate.evidence);
  expect((await database.session.query('SELECT id FROM firms')).rows).toHaveLength(0);
});

it('rejects an in-flight result after a candidate changes or is dismissed',async()=>{
  const candidateId=await create(),runId=await request(candidateId);
  await tx(()=>reviewCandidate(context(),{id:candidateId,expectedRevision:1,status:'kept'}));
  expect(await tx(()=>finishQualification(context(),{runId,observations:[observation()],facts:[],reason:null}))).toEqual({ok:false,reason:'candidate_changed'});
  expect(await readQualification(context(),{candidateId})).toMatchObject({status:'unavailable',reason:'candidate_changed',observations:[]});
  const next=await request(candidateId,2);
  await tx(()=>reviewCandidate(context(),{id:candidateId,expectedRevision:2,status:'dismissed'}));
  expect(await tx(()=>finishQualification(context(),{runId:next,observations:[observation()],facts:[],reason:null}))).toEqual({ok:false,reason:'candidate_dismissed'});
  expect(await requestQualification(context(),{candidateId,expectedRevision:3})).toEqual({ok:false,reason:'candidate_dismissed'});
});

it('retains successful evidence as historical when a refresh fails and never applies twice',async()=>{
  const candidateId=await create(),runId=await request(candidateId),source=observation();
  const facts=[{kind:'help_request' as const,value:candidate.evidence,observationId:source.id,blockId:'help'}];
  expect(await tx(()=>finishQualification(context(),{runId,observations:[source],facts,reason:null}))).toMatchObject({ok:true});
  expect(await tx(()=>finishQualification(context(),{runId,observations:[],facts:[],reason:'source_unavailable'}))).toEqual({ok:false,reason:'run_finished'});
  await tx(()=>reviewCandidate(context(),{id:candidateId,expectedRevision:1,status:'kept'}));
  const next=await request(candidateId,2);
  await tx(()=>finishQualification(context(),{runId:next,observations:[],facts:[],reason:'source_unavailable'}));
  const view=await readQualification(context(),{candidateId});
  expect(view).toMatchObject({runId:next,status:'unavailable',reason:'source_unavailable',observations:[],facts:[],history:[{runId,observations:[source],facts}]});
});

it('refuses unsupported publication dates, duplicate block IDs and ungrounded fact references',async()=>{
  const candidateId=await create(),runId=await request(candidateId),source=observation();
  for(const bad of [{...source,publishedAtBlockId:null},{...source,publishedAtBlockId:'missing'},
    {...source,blocks:[{id:'same',text:'One'},{id:'same',text:'Two'}],publishedAt:null,publishedAtBlockId:null}]){
    expect(await tx(()=>finishQualification(context(),{runId,observations:[bad],facts:[],reason:null}))).toEqual({ok:false,reason:'invalid_evidence'});
  }
  for(const fact of [{kind:'help_request',value:'invented',observationId:source.id,blockId:'help'},
    {kind:'help_request',value:candidate.evidence,observationId:randomUUID(),blockId:'help'}]){
    expect(await tx(()=>finishQualification(context(),{runId,observations:[source],facts:[fact],reason:null}))).toEqual({ok:false,reason:'invalid_evidence'});
  }
  expect(await readQualification(context(),{candidateId})).toMatchObject({status:'pending',observations:[]});
});

it('removes evidence on candidate deletion while preserving incurred provider accounting',async()=>{
  const candidateId=await create(),runId=await request(candidateId);
  const paid=await tx(()=>reserveAttempt(context(),{subjectKind:'sourcing_qualification',subjectId:runId,attempt:1,providerKey:'bedrock',
    at:new Date().toISOString(),businessTimeZone:'America/New_York',cents:2,modelName:'test-model',maxInputTokens:1000,maxOutputTokens:100}));
  await tx(()=>markCalling(context(),paid.id));
  await tx(()=>settleAttempt(context(),{reservationId:paid.id,at:new Date().toISOString(),outcome:{kind:'estimated'}}));
  await tx(()=>finishQualification(context(),{runId,observations:[observation()],facts:[],reason:null}));
  await tx(()=>deleteCandidate(context(),{id:candidateId,expectedRevision:1}));
  expect(await readQualification(context(),{candidateId})).toBeNull();
  expect((await database.session.query('SELECT id FROM sourcing_qualification_runs WHERE id=$1',[runId])).rows).toHaveLength(0);
  expect((await database.session.query('SELECT state,settled_cents FROM provider_reservations WHERE id=$1',[paid.id])).rows).toEqual([{state:'estimated',settled_cents:2}]);
  expect(await tx(()=>finishQualification(context(),{runId,observations:[observation()],facts:[],reason:null}))).toEqual({ok:false,reason:'not_found'});
});

it('enforces research pause and shared daily ceiling before queueing new work',async()=>{
  const candidateId=await create();
  await database.session.query('INSERT INTO research_settings(workspace_id,enabled,daily_firm_ceiling) VALUES($1,false,1)',[seeded.alpha.workspaceId]);
  expect(await requestQualification(context(),{candidateId,expectedRevision:1})).toEqual({ok:false,reason:'research_disabled'});
  await database.session.query('UPDATE research_settings SET enabled=true');
  await request(candidateId);
  await tx(()=>reviewCandidate(context(),{id:candidateId,expectedRevision:1,status:'kept'}));
  expect(await tx(()=>requestQualification(context(),{candidateId,expectedRevision:2}))).toEqual({ok:false,reason:'daily_firm_ceiling'});
});
it('serializes concurrent requests at the shared daily research limit',async()=>{
 const first=await create();
 const saved=await tx(()=>saveCandidate(context(),{...candidate,firmName:'Other PM',website:'https://other.example.test/',sourceUrl:'https://other.example.test/'}));if(!saved.ok)throw new Error(saved.reason);
 await database.session.query('INSERT INTO research_settings(workspace_id,daily_firm_ceiling) VALUES($1,1)',[seeded.alpha.workspaceId]);
 const secondSession=await database.appRuntimeSession();
 const other=repositoryContext(workspaceScope(seeded.alpha.workspaceId,{kind:'user',userId:seeded.alpha.admin.userId,role:'admin'}),secondSession);
 const answers=await Promise.all([
  tx(()=>requestQualification(context(),{candidateId:first,expectedRevision:1})),
  withTransaction(secondSession,()=>requestQualification(other,{candidateId:saved.value.id,expectedRevision:1})),
 ]);
 expect(answers.filter(result=>result.ok)).toHaveLength(1);
 expect(answers.filter(result=>!result.ok)).toEqual([{ok:false,reason:'daily_firm_ceiling'}]);
});
it('records the deterministic verdict and replaces ungrounded generated questions',async()=>{
 const {evaluateQualification}=await import('../../sourcing/qualificationDecision.ts');
 const candidateId=await create(),runId=await request(candidateId);
 await tx(()=>finishQualification(context(),{runId,observations:[observation()],facts:[],reason:null,openingQuestion:'Why is your team understaffed?'}));
 expect(await tx(()=>evaluateQualification(context(),{runId}))).toMatchObject({ok:true});
 const view=await readQualification(context(),{candidateId});
 expect(view).toMatchObject({status:'review',openingQuestion:'How does your team handle maintenance calls and vendor follow-up today?',verdict:{decision:'review'}});
 await tx(()=>reviewCandidate(context(),{id:candidateId,expectedRevision:1,status:'dismissed'}));
 expect(await tx(()=>evaluateQualification(context(),{runId}))).toEqual({ok:false,reason:'candidate_changed'});
});
