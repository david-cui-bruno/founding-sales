import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {createTestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces} from '../db/support/fixtures.ts';
import {requestSocialDrafts} from '../../social/drafts.ts';
import {runSocialDraft} from '../../social/draftRun.ts';
import {saveSocialPrivateDraft} from '../../social/privateDrafts.ts';
import {saveAnswerBlock,approveAnswerBlock} from '../../outreach/facts.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {updateResearchSettings} from '../../research/settings.ts';
import {lockResearchBudget} from '../../research/ceilings.ts';
import {queueVoiceGeneration,voiceGenerationSelection,voiceOrigin,voiceText,fakeVoicePort} from './voiceGenerationFixtures.ts';
import {registerVoiceDatabase} from './voiceGenerationPgRuntime.ts';
const authority=async()=>true;
async function pid(db:SessionQueryable){return (await db.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;}
async function waiting(observer:SessionQueryable,backend:number){await expect.poll(async()=>Boolean((await observer.query('SELECT cardinality(pg_blocking_pids($1))>0 waiting',[backend])).rows[0]?.['waiting'])).toBe(true);}

it.each(['revision','delete'] as const)('SG-S2 direct guide %s versus owner demotion has guide-before-private order, no deadlock or manual loss',async change=>{
 const db=await createTestDatabase(),stop=await registerVoiceDatabase(db);try{
  const seed=await seedTwoWorkspaces(db.session),runtime=await db.appRuntimeSession(),guideWriter=await db.appRuntimeSession(),membershipWriter=await db.appRuntimeSession();
  const ctx=(s=runtime)=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),s),worker=repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'system',component:'worker'}),runtime);
  await runtime.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')",[seed.alpha.workspaceId,seed.beta.admin.userId]);
  await withTransaction(runtime,()=>updateResearchSettings(ctx(),{enabled:true,dailyCostCeilingCents:100,monthlyCostCeilingCents:1000}));
  const q=await withTransaction(runtime,()=>queueVoiceGeneration(ctx()));await runSocialDraft(worker,q.requestId,fakeVoicePort());
  const origin=await withTransaction(runtime,()=>voiceOrigin(ctx(),q.requestId));
  const derived=await withTransaction(runtime,()=>saveSocialPrivateDraft(ctx(),{operation:'create',kind:'post',text:voiceText,origin},authority));if(!derived.ok)throw Error(derived.reason);
  const manual=await withTransaction(runtime,()=>saveSocialPrivateDraft(ctx(),{operation:'create',kind:'post',text:'Unrelated manual owner draft.',origin:{kind:'manual'}},authority));if(!manual.ok)throw Error(manual.reason);
  await guideWriter.query('BEGIN');await guideWriter.query('SET LOCAL lock_timeout=\'5s\'');await guideWriter.query('SELECT id FROM social_voice_preferences WHERE id=$1 FOR UPDATE',[q.selection.voiceGuideRef!.guideId]);
  const membershipPid=await pid(membershipWriter),demoting=withTransaction(membershipWriter,async()=>{await membershipWriter.query("SET LOCAL lock_timeout='5s'");await membershipWriter.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.admin.userId]);});
  // Attach rejection handler before waiting, preserving original rejection below.
  void demoting.catch(()=>undefined);
  try{
   await waiting(runtime,membershipPid);
   expect((await runtime.query('SELECT text FROM social_private_drafts WHERE id=$1',[derived.value.draftId])).rows[0]?.['text']).toBe(voiceText);
   if(change==='revision')await guideWriter.query('UPDATE social_voice_preferences SET revision=revision+1 WHERE id=$1',[q.selection.voiceGuideRef!.guideId]);
   else await guideWriter.query('DELETE FROM social_voice_preferences WHERE id=$1',[q.selection.voiceGuideRef!.guideId]);
  }finally{await guideWriter.query('COMMIT');}
  await demoting;
  expect((await runtime.query('SELECT text,reason FROM social_private_drafts WHERE id=$1',[derived.value.draftId])).rows[0]).toEqual({text:null,reason:'source_changed_or_unavailable'});
  expect((await runtime.query('SELECT text,reason FROM social_private_drafts WHERE id=$1',[manual.value.draftId])).rows[0]).toEqual({text:'Unrelated manual owner draft.',reason:null});
  expect((await runtime.query('SELECT state,concepts FROM social_draft_requests WHERE id=$1',[q.requestId])).rows[0]).toEqual({state:'review',concepts:null});
 }finally{await stop();}
});

it('SG-S1 actual handoff budget wait crosses controlled New York midnight and releases known-not-called without generation',async()=>{
 const db=await createTestDatabase(),stop=await registerVoiceDatabase(db);try{
  const seed=await seedTwoWorkspaces(db.session),runtime=await db.appRuntimeSession(),rowHolder=await db.appRuntimeSession(),budgetHolder=await db.appRuntimeSession(),observer=await db.appRuntimeSession();
  const ctx=(s=runtime)=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),s),worker=repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'system',component:'worker'}),runtime);
  // A test-only PostgreSQL clock shadows only unqualified clock_timestamp. All
  // repository calls/locks/transactions remain real. No production clock seam.
  await db.session.query("CREATE SCHEMA voice_fixture_clock; CREATE TABLE voice_fixture_clock.time(at timestamptz); INSERT INTO voice_fixture_clock.time VALUES('2026-10-27T03:50:00Z'); CREATE FUNCTION voice_fixture_clock.clock_timestamp() RETURNS timestamptz LANGUAGE sql VOLATILE AS 'SELECT at FROM voice_fixture_clock.time'; GRANT USAGE ON SCHEMA voice_fixture_clock TO app_runtime; GRANT SELECT ON voice_fixture_clock.time TO app_runtime");
  await runtime.query('SET search_path=voice_fixture_clock,public,pg_catalog');
  expect((await runtime.query('SELECT clock_timestamp() now')).rows[0]?.['now']).toEqual(new Date('2026-10-27T03:50:00Z'));
  await withTransaction(runtime,()=>updateResearchSettings(ctx(),{enabled:true,dailyCostCeilingCents:100,monthlyCostCeilingCents:1000}));
  const selection=await withTransaction(runtime,()=>voiceGenerationSelection(ctx()));
  const checkedAt='2026-10-27T03:45:00.000Z',url='https://voice-fixture.example.test/news',text='The example maintenance team describes a local workflow.';
  const candidate=await withTransaction(runtime,()=>saveCandidate(ctx(),{firmName:'Voice fixture PM',website:'https://voice-fixture.example.test',locality:'Dallas',region:'TX',signal:'responsibility_overlap',evidence:text,sourceUrl:url,observedOn:'2026-10-26',preparedBy:'Controlled local fixture'}));if(!candidate.ok)throw Error(candidate.reason);
  await runtime.query('UPDATE sourcing_candidates SET source_check=$2::jsonb WHERE id=$1',[candidate.value.id,JSON.stringify({checkId:randomUUID(),jobId:randomUUID(),requestedAt:checkedAt,state:'checked',reason:null,checkedAt,lastSuccess:{url,contentHash:'a'.repeat(64),retrievedAt:checkedAt,excerpt:text,quoteMatched:true,firstParty:true,truncated:false}})]);
  const sourceRef={kind:'public' as const,id:candidate.value.id,revision:1,url,checkedAt};
  const fact=await withTransaction(runtime,()=>saveAnswerBlock(ctx(),{kind:'product',text,socialInput:{topic:'news',status:'observation',sanitized:true,sourceRef}}));if(!fact.ok)throw Error(fact.reason);await withTransaction(runtime,()=>approveAnswerBlock(ctx(),fact.value));
  const requested=await withTransaction(runtime,()=>requestSocialDrafts(ctx(),{...selection,sourceRefs:[{kind:'public',id:candidate.value.id,revision:1}],factBlocks:[{id:fact.value.id,version:1}]},authority));if(!requested.ok)throw Error(requested.reason);
  await runtime.query("UPDATE social_draft_requests SET created_at='2026-10-27T03:50:00Z',deadline_at='2026-10-27T04:20:00Z' WHERE id=$1",[requested.value.requestId]);
  await rowHolder.query('BEGIN');await rowHolder.query('SELECT id FROM social_draft_requests WHERE id=$1 FOR UPDATE',[requested.value.requestId]);
  const runtimePid=await pid(runtime),budgetPid=await pid(budgetHolder);let generations=0;
  const running=runSocialDraft(worker,requested.value.requestId,fakeVoicePort({generate:async()=>{generations++;}}));void running.catch(()=>undefined);
  await waiting(observer,runtimePid);
  // Queue budget holder behind claim's budget lock. PostgreSQL grants the queued
  // waiter before the worker's next transaction, forcing the exact handoff wait.
  await budgetHolder.query('BEGIN');const acquiring=lockResearchBudget(ctx(budgetHolder));void acquiring.catch(()=>undefined);
  await waiting(observer,budgetPid);await rowHolder.query('COMMIT');await acquiring;
  try{await waiting(observer,runtimePid);await db.session.query("UPDATE voice_fixture_clock.time SET at='2026-10-27T04:01:00Z'");}finally{await budgetHolder.query('COMMIT');}
  await running;expect(generations).toBe(0);
  expect((await runtime.query('SELECT state,concepts,paid_attempts,reason FROM social_draft_requests WHERE id=$1',[requested.value.requestId])).rows[0]).toEqual({state:'review',concepts:null,paid_attempts:1,reason:'source_changed_or_unavailable'});
  expect((await runtime.query('SELECT state FROM provider_reservations WHERE subject_id=$1',[requested.value.requestId])).rows).toEqual([{state:'released'}]);
 }finally{await stop();}
});

it('guided request domain admission requires an explicit internal current-principal callback',async()=>{
 const db=await createTestDatabase(),stop=await registerVoiceDatabase(db);try{
  const seed=await seedTwoWorkspaces(db.session),runtime=await db.appRuntimeSession(),ctx=repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),runtime);
  const selection=await withTransaction(runtime,()=>voiceGenerationSelection(ctx));
  expect(await withTransaction(runtime,()=>requestSocialDrafts(ctx,selection))).toEqual({ok:false,reason:'current_principal_required'});
  expect((await runtime.query('SELECT * FROM social_draft_requests')).rows).toHaveLength(0);
 }finally{await stop();}
});
