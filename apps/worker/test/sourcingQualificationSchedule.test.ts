import {beforeAll,afterAll,it,expect} from 'vitest';
import {createTestDatabase,type TestDatabase} from '@fss/domain/db/testing/testDatabase.ts';
import {seedTwoWorkspaces} from '@fss/domain/test/db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {saveCandidate,reviewCandidate} from '@fss/domain/sourcing/candidates.ts';
import {enqueueJob} from '@fss/domain/jobs/jobStore.ts';
import {sourcingQualificationSource} from '../src/handlers/sourcingQualification.ts';
let db:TestDatabase;let workspaceId:string;
beforeAll(async()=>{db=await createTestDatabase();workspaceId=(await seedTwoWorkspaces(db.session)).alpha.workspaceId;});afterAll(async()=>db.drop());
it('drains more than one page of owner-kept candidates, skips unreviewed/dismissed drafts, and deduplicates repeated passes',async()=>{
 const ctx=repositoryContext(workspaceScope(workspaceId,{kind:'system',component:'worker'}),db.session);
 for(let n=0;n<32;n++){
  const saved=await saveCandidate(ctx,{firmName:`PM ${n}`,website:`https://p${n}.example.test/`,locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Need unknown',sourceUrl:`https://p${n}.example.test/`,observedOn:'2026-10-01',preparedBy:'Fixture'});
  if(!saved.ok)throw new Error(saved.reason);
  if(n<31)await reviewCandidate(ctx,{id:saved.value.id,expectedRevision:1,status:n===30?'dismissed':'kept'});
 }
 const source=sourcingQualificationSource(true);
 const pass=async()=>withTransaction(db.session,async()=>{const jobs=await source.find(db.session,new Date().toISOString());for(const job of jobs)await enqueueJob(db.session,job);return jobs.length;});
 expect(await pass()).toBe(25);expect(await pass()).toBe(5);expect(await pass()).toBe(0);
 expect((await db.session.query("SELECT id FROM jobs WHERE kind='sourcing.qualify'")).rows).toHaveLength(30);
 await db.session.query("UPDATE sourcing_qualification_runs SET requested_at=now()-interval '1 hour',deadline_at=now()-interval '1 minute'");
 await withTransaction(db.session,()=>sourcingQualificationSource(false).find(db.session,new Date().toISOString()));
 expect((await db.session.query("SELECT id FROM sourcing_qualification_runs WHERE state='unavailable'")).rows).toHaveLength(30);
});
it('leaves paused and quota-limited candidates pending with a visible reason, sharing the research ceiling',async()=>{
 const ctx=repositoryContext(workspaceScope(workspaceId,{kind:'system',component:'worker'}),db.session);
 await db.session.query('DELETE FROM sourcing_candidates');
 await saveCandidate(ctx,{firmName:'Budget PM',website:'https://budget.example.test/',locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Unknown',sourceUrl:'https://budget.example.test/',observedOn:'2026-10-01',preparedBy:'Fixture'});
 await db.session.query("UPDATE sourcing_candidates SET status='kept',revision=revision+1 WHERE payload->>'firmName'='Budget PM'");
 await db.session.query('INSERT INTO research_settings(workspace_id,enabled,daily_firm_ceiling) VALUES($1,false,0)',[workspaceId]);
 const pass=()=>withTransaction(db.session,()=>sourcingQualificationSource(true).find(db.session,new Date().toISOString()));
 expect(await pass()).toEqual([]);
 expect((await db.session.query('SELECT qualification_wait_reason FROM sourcing_discovery_settings WHERE workspace_id=$1',[workspaceId])).rows[0]).toEqual({qualification_wait_reason:'research_disabled'});
 await db.session.query('UPDATE research_settings SET enabled=true WHERE workspace_id=$1',[workspaceId]);
 expect(await pass()).toEqual([]);
 expect((await db.session.query('SELECT qualification_wait_reason FROM sourcing_discovery_settings WHERE workspace_id=$1',[workspaceId])).rows[0]).toEqual({qualification_wait_reason:'daily_firm_ceiling'});
 expect((await db.session.query('SELECT id FROM sourcing_qualification_runs')).rows).toHaveLength(0);
});

it('never schedules automatic admission even when the historical flag is true',async()=>{
 await db.session.query('UPDATE research_settings SET enabled=true,daily_firm_ceiling=50 WHERE workspace_id=$1',[workspaceId]);
 await db.session.query('DELETE FROM daily_counters');
 const first=await withTransaction(db.session,()=>sourcingQualificationSource(true).find(db.session,new Date().toISOString()));
 expect(first).toHaveLength(1);
 const runId=first[0]!.payload['runId'];
 await db.session.query("UPDATE sourcing_qualification_runs SET state='eligible' WHERE id=$1",[runId]);
 const before=(await db.session.query('SELECT * FROM daily_counters')).rows;
 expect(await withTransaction(db.session,()=>sourcingQualificationSource(true).find(db.session,new Date().toISOString()))).toHaveLength(0);
 await db.session.query('UPDATE sourcing_discovery_settings SET auto_admission_enabled=true WHERE workspace_id=$1',[workspaceId]);
 const retry=await withTransaction(db.session,()=>sourcingQualificationSource(true).find(db.session,new Date().toISOString()));
 expect(retry).toHaveLength(0);
 expect((await db.session.query('SELECT * FROM sourcing_admissions')).rows).toHaveLength(0);
 expect((await db.session.query('SELECT * FROM firms')).rows).toHaveLength(0);
 expect((await db.session.query('SELECT * FROM daily_counters')).rows).toEqual(before);
 expect(await withTransaction(db.session,()=>sourcingQualificationSource(true).find(db.session,new Date().toISOString()))).toHaveLength(0);
});
it('gives later workspaces a turn even when more than 25 earlier workspaces are paused',async()=>{
 const wanted=new Set<string>();
 for(let n=0;n<14;n++){
  await db.session.query("UPDATE workspaces SET slug=slug||'-'||$1 WHERE slug IN ('alpha','beta')",[String(n)]);
  const pair=await seedTwoWorkspaces(db.session);
  for(const workspace of [pair.alpha,pair.beta]){
   wanted.add(workspace.workspaceId);
   const ctx=repositoryContext(workspaceScope(workspace.workspaceId,{kind:'system',component:'worker'}),db.session);
   await saveCandidate(ctx,{firmName:'Waiting PM',website:'https://waiting.example.test/',locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Unknown',sourceUrl:'https://waiting.example.test/',observedOn:'2026-10-01',preparedBy:'Fixture'});
   await db.session.query("UPDATE sourcing_candidates SET status='kept',revision=revision+1 WHERE workspace_id=$1",[workspace.workspaceId]);
   await db.session.query('INSERT INTO research_settings(workspace_id,enabled) VALUES($1,false)',[workspace.workspaceId]);
  }
 }
 for(let n=0;n<2;n++)await withTransaction(db.session,()=>sourcingQualificationSource(true).find(db.session,new Date(Date.now()+n*1000).toISOString()));
 const visited=(await db.session.query<{workspace_id:string}>('SELECT workspace_id FROM sourcing_discovery_settings WHERE qualification_last_pass_at IS NOT NULL')).rows;
 for(const row of visited)wanted.delete(row.workspace_id);
 expect(wanted.size).toBe(0);
});
it('settles an orphaned paid qualification even with all new research scheduling disabled',async()=>{
 const {reserveAttempt,markCalling}=await import('@fss/domain/research/reservations.ts');
 const {randomUUID}=await import('node:crypto');
 const ctx=repositoryContext(workspaceScope(workspaceId,{kind:'system',component:'worker'}),db.session);
 const reservation=await withTransaction(db.session,async()=>{const held=await reserveAttempt(ctx,{subjectKind:'sourcing_qualification',subjectId:randomUUID(),attempt:1,providerKey:'aws_bedrock.sourcing_qualification',at:new Date().toISOString(),businessTimeZone:'America/New_York',cents:2,modelName:'claude-haiku-4-5',maxInputTokens:100,maxOutputTokens:2048});await markCalling(ctx,held.id);return held;});
 await db.session.query("UPDATE provider_reservations SET created_at=now()-interval '31 minutes' WHERE id=$1",[reservation.id]);
 expect(await withTransaction(db.session,()=>sourcingQualificationSource(false).find(db.session,new Date().toISOString()))).toEqual([]);
 expect((await db.session.query('SELECT state,settled_cents FROM provider_reservations WHERE id=$1',[reservation.id])).rows[0]).toEqual({state:'estimated',settled_cents:2});
});
it('leaves an all-needs-review backlog untouched but permits explicit per-candidate research without Keep',async()=>{
 const {requestQualification}=await import('@fss/domain/sourcing/qualificationStore.ts');
 await db.session.query('DELETE FROM sourcing_candidates');await db.session.query('DELETE FROM daily_counters');
 await db.session.query('UPDATE research_settings SET enabled=true,daily_firm_ceiling=50 WHERE workspace_id=$1',[workspaceId]);
 const ctx=repositoryContext(workspaceScope(workspaceId,{kind:'system',component:'worker'}),db.session);
 const saved=await saveCandidate(ctx,{firmName:'Unreviewed PM',website:'https://unreviewed.example.test/',locality:'Boston',region:'MA',signal:'fit_only',evidence:'Unknown',sourceUrl:'https://unreviewed.example.test/',observedOn:'2026-10-01',preparedBy:'Fixture'});
 if(!saved.ok)throw new Error(saved.reason);
 expect(await withTransaction(db.session,()=>sourcingQualificationSource(true).find(db.session,new Date().toISOString()))).toEqual([]);
 expect((await db.session.query('SELECT * FROM daily_counters')).rows).toHaveLength(0);
 expect(await withTransaction(db.session,()=>requestQualification(ctx,{candidateId:saved.value.id,expectedRevision:1}))).toMatchObject({ok:true});
 expect((await db.session.query('SELECT status,revision FROM sourcing_candidates WHERE id=$1',[saved.value.id])).rows[0]).toEqual({status:'needs_review',revision:1});
 expect((await db.session.query('SELECT * FROM sourcing_admissions')).rows).toHaveLength(0);
});

it('queues a kept draft before a refresh and stops at the shared daily allowance',async()=>{
 const {requestQualification}=await import('@fss/domain/sourcing/qualificationStore.ts');
 await db.session.query('DELETE FROM sourcing_candidates');await db.session.query('DELETE FROM daily_counters');
 const ctx=repositoryContext(workspaceScope(workspaceId,{kind:'system',component:'worker'}),db.session);
 const make=async(name:string)=>{
  const saved=await saveCandidate(ctx,{firmName:name,website:`https://${name}.example.test/`,locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Unknown',sourceUrl:`https://${name}.example.test/`,observedOn:'2026-10-01',preparedBy:'Fixture'});
  if(!saved.ok)throw new Error(saved.reason);
  await reviewCandidate(ctx,{id:saved.value.id,expectedRevision:1,status:'kept'});return saved.value.id;
 };
 const old=await make('refresh');
 await withTransaction(db.session,()=>requestQualification(ctx,{candidateId:old,expectedRevision:2}));
 await db.session.query("UPDATE sourcing_qualification_runs SET state='review',requested_at=now()-interval '8 days' WHERE candidate_id=$1",[old]);
 const fresh=await make('fresh-kept');
 await db.session.query('DELETE FROM daily_counters');
 await db.session.query('UPDATE research_settings SET daily_firm_ceiling=1 WHERE workspace_id=$1',[workspaceId]);
 const jobs=await withTransaction(db.session,()=>sourcingQualificationSource(true).find(db.session,new Date().toISOString()));
 expect(jobs).toHaveLength(1);expect(jobs[0]!.payload['candidateId']).toBe(fresh);
 expect((await db.session.query('SELECT qualification_wait_reason FROM sourcing_discovery_settings WHERE workspace_id=$1',[workspaceId])).rows[0]).toEqual({qualification_wait_reason:'daily_firm_ceiling'});
 expect((await db.session.query('SELECT count(*)::integer AS count FROM sourcing_qualification_runs WHERE candidate_id=$1',[old])).rows[0]).toEqual({count:1});
});

it('records eligible evidence without auto-admission under the legacy flag, then honors manual admission',async()=>{
 const {randomUUID}=await import('node:crypto');
 const {requestQualification,finishQualification,QUALIFICATION_POLICY_VERSION,QUALIFICATION_PROMPT_VERSION}=await import('@fss/domain/sourcing/qualificationStore.ts');
 const {admitCandidate}=await import('@fss/domain/sourcing/admission.ts');
 const {recordStatePosture}=await import('@fss/domain/policy/postures.ts');
 const {POSTURE_STATEMENTS}=await import('@fss/domain/src/rules/statePosture.ts');
 const {HandlerRegistry}=await import('@fss/domain/jobs/handlerRegistry.ts');
 const {runOnce}=await import('../src/runner/jobRunner.ts');
 const {sourcingQualificationHandler}=await import('../src/handlers/sourcingQualification.ts');
 await db.session.query('DELETE FROM sourcing_candidates');await db.session.query('DELETE FROM daily_counters');
 await db.session.query("DELETE FROM jobs WHERE kind='sourcing.qualify'");
 await db.session.query('UPDATE research_settings SET daily_firm_ceiling=50 WHERE workspace_id=$1',[workspaceId]);
 const owner=(await db.session.query<{user_id:string}>("SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND role='admin' LIMIT 1",[workspaceId])).rows[0]!.user_id;
 const ctx=repositoryContext(workspaceScope(workspaceId,{kind:'user',userId:owner,role:'admin'}),db.session);
 const tx=<T>(fn:()=>Promise<T>)=>withTransaction(db.session,fn);
 await tx(()=>recordStatePosture(ctx,{state:'TX',effectiveFrom:new Date(Date.now()-60000).toISOString(),confirmedStatements:Object.keys(POSTURE_STATEMENTS)}));
 await db.session.query('UPDATE sourcing_discovery_settings SET auto_admission_enabled=true,owner_user_id=$2,qualification_evaluation=$3::jsonb WHERE workspace_id=$1',[workspaceId,owner,JSON.stringify({policyVersion:QUALIFICATION_POLICY_VERSION,promptVersion:QUALIFICATION_PROMPT_VERSION,reportSha256:'a'.repeat(64),reviewedEligible:1,falseEligible:0})]);
 const saved=await tx(()=>saveCandidate(ctx,{firmName:'Manual Pipeline PM',website:'https://manual-pipeline.example.test/',locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Unknown',sourceUrl:'https://manual-pipeline.example.test/',observedOn:'2026-10-01',preparedBy:'Fixture'}));if(!saved.ok)throw new Error(saved.reason);
 await tx(()=>reviewCandidate(ctx,{id:saved.value.id,expectedRevision:1,status:'kept'}));
 const request=await tx(()=>requestQualification(ctx,{candidateId:saved.value.id,expectedRevision:2}));if(!request.ok)throw new Error(request.reason);
 const observationId=randomUUID(),date=new Date().toISOString().slice(0,10);
 const blocks=[{id:'firm',text:'Manual Pipeline PM is a residential property management company in Dallas, Texas.'},{id:'phone',text:'Contact Manual Pipeline PM at (214) 555-0197.'},{id:'need',text:'Our team is overwhelmed by maintenance calls.'},{id:'date',text:`Published ${date}`}];
 const facts=[['firm_identity','firm'],['residential_management','firm'],['service_area','firm'],['business_phone','phone'],['operational_burden','need']].map(([kind,blockId])=>({kind,blockId,observationId,value:blocks.find(b=>b.id===blockId)!.text}));
 expect(await tx(()=>finishQualification(ctx,{runId:request.value.runId,reason:null,observations:[{id:observationId,url:'https://manual-pipeline.example.test/',contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:new Date().toISOString(),publishedAt:`${date}T00:00:00Z`,publishedAtBlockId:'date',firstParty:true,truncated:false,blocks}],facts}))).toMatchObject({ok:true});
 const registry=new HandlerRegistry().register(sourcingQualificationHandler({pageFetch:{providerKey:'fixture',fetchPages:async()=>{throw new Error('finished evidence must not refetch');}},extraction:null}));
 expect(await runOnce(db.session,{registry,owner:'manual-pipeline-test',limit:5})).toMatchObject({failed:0});
 expect((await db.session.query('SELECT state FROM sourcing_qualification_runs WHERE id=$1',[request.value.runId])).rows[0]).toEqual({state:'eligible'});
 expect((await db.session.query('SELECT * FROM sourcing_admissions')).rows).toHaveLength(0);
 expect((await db.session.query('SELECT * FROM firms')).rows).toHaveLength(0);
 expect(await tx(()=>admitCandidate(ctx,{candidateId:saved.value.id,expectedRevision:2,qualificationRunId:request.value.runId,mode:'reviewed'}))).toMatchObject({ok:true});
 expect((await db.session.query("SELECT id FROM jobs WHERE kind='research.firm'")).rows).toHaveLength(1);
});
