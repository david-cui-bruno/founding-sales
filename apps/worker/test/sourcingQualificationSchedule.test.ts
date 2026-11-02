import {beforeAll,afterAll,it,expect} from 'vitest';
import {createTestDatabase,type TestDatabase} from '@fss/domain/db/testing/testDatabase.ts';
import {seedTwoWorkspaces} from '@fss/domain/test/db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {saveCandidate,reviewCandidate} from '@fss/domain/sourcing/candidates.ts';
import {enqueueJob} from '@fss/domain/jobs/jobStore.ts';
import {sourcingQualificationSource} from '../src/handlers/sourcingQualification.ts';
import {runSchedulerPass} from '../src/scheduler/schedulerPass.ts';
import {requestQualification,QUALIFICATION_PROMPT_VERSION,QUALIFICATION_POLICY_VERSION} from '@fss/domain/sourcing/qualificationStore.ts';
import {VERIFIED_FIRM_POLICY_VERSION,IDENTITY_REVIEW_REASONS} from '@fss/domain/sourcing/verifiedFirmPolicy.ts';
import {openHold} from '@fss/domain/policy/holds.ts';
import {runApolloDiscovery} from '@fss/domain/sourcing/apolloDiscovery.ts';
import {APOLLO_PREPARED_BY} from '@fss/domain/sourcing/apolloIntake.ts';
import {qualificationConfigureCommand} from '../src/tools/fss/qualificationConfigure.ts';
import {sourcingQualificationHandler} from '../src/handlers/sourcingQualification.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {runOnce} from '../src/runner/jobRunner.ts';
import {sourcingMonitorSource} from '../src/handlers/sourcingMonitor.ts';
let db:TestDatabase;let workspaceId:string;
it('never schedules a tagged raw payload that is not a researchable Overture row, even if historical state says kept or ready',async()=>{
 const f=await versionFixture();try{
  const candidate=await f.candidate('discovery-fence',{prompt:'qualification-context-v6'});
  await f.session.query(`UPDATE sourcing_candidates SET payload='{"kind":"discovery-v1"}'::jsonb,next_source_check_at=now()-interval '1 day' WHERE id=$1`,[candidate.id]);
  const before=(await f.session.query('SELECT * FROM sourcing_qualification_runs')).rows;
  expect(await f.pass()).toMatchObject({inserted:0,externalActions:0});
  expect(await runSchedulerPass(f.session,{sources:[sourcingMonitorSource(true)],now:new Date().toISOString()})).toMatchObject({inserted:0,externalActions:0});
  expect((await f.session.query('SELECT * FROM sourcing_qualification_runs')).rows).toEqual(before);
  expect((await f.session.query('SELECT id FROM jobs')).rows).toHaveLength(0);
 }finally{await f.database.drop();}
});

/** Real migrated PostgreSQL and normal scheduler enqueue, isolated from the legacy scenarios below. */
async function versionFixture(){
 const database=await createTestDatabase();
 const {alpha}=await seedTwoWorkspaces(database.session),session=database.session;
 const ctx=repositoryContext(workspaceScope(alpha.workspaceId,{kind:'system',component:'scheduler'}),session);
 await session.query('INSERT INTO research_settings(workspace_id,enabled,daily_firm_ceiling) VALUES($1,true,100)',[alpha.workspaceId]);
 await session.query('INSERT INTO sourcing_discovery_settings(workspace_id,auto_admission_enabled,owner_user_id,qualification_evaluation) VALUES($1,true,$2,$3::jsonb)',[alpha.workspaceId,alpha.admin.userId,JSON.stringify({verifiedFirmPolicyVersion:VERIFIED_FIRM_POLICY_VERSION,promptVersion:QUALIFICATION_PROMPT_VERSION,policyVersion:QUALIFICATION_POLICY_VERSION,reportSha256:'a'.repeat(64),reviewedEligible:3,falseEligible:0})]);
 const candidate=async(name:string,versions:{prompt?:string;policy?:string}={})=>withTransaction(session,async()=>{
  const saved=await saveCandidate(ctx,{firmName:name,website:`https://${name}.example.test/`,locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Unknown',sourceUrl:`https://${name}.example.test/`,observedOn:'2026-10-18',preparedBy:'Tavily Basic search · not verified'});
  if(!saved.ok)throw new Error(saved.reason);
  const kept=await reviewCandidate(ctx,{id:saved.value.id,expectedRevision:1,status:'kept'});if(!kept.ok)throw new Error(kept.reason);
  const requested=await requestQualification(ctx,{candidateId:saved.value.id,expectedRevision:2},{enqueue:false});if(!requested.ok)throw new Error(requested.reason);
  // Model a completed historical request without invoking a provider. Its original fingerprint
  // must differ from today's current-version request, as an actual old-version fingerprint does.
  await session.query("UPDATE sourcing_qualification_runs SET state='review',reason='fixture_evidence_unavailable',requested_at=now()-interval '1 hour',prompt_version=$2,policy_version=$3,fingerprint=CASE WHEN $4 THEN repeat('b',64) ELSE fingerprint END WHERE id=$1",[requested.value.runId,versions.prompt??QUALIFICATION_PROMPT_VERSION,versions.policy??QUALIFICATION_POLICY_VERSION,Boolean(versions.prompt||versions.policy)]);
  return {id:saved.value.id,runId:requested.value.runId};
 });
 const pass=(enabled=true)=>runSchedulerPass(session,{sources:[sourcingQualificationSource(enabled)],now:new Date().toISOString()});
 return {database,session,ctx,candidate,pass,workspaceId:alpha.workspaceId};
}

it('qualifies an Apollo draft only with internal origin and current owner attestation, never vendor metadata or a spoofed label',async()=>{
 const f=await versionFixture();try{
  const w=f.workspaceId;
  await f.session.query(`INSERT INTO sourcing_apollo_allowances(workspace_id,account_ref,key_ref,cycle_start,cycle_end,verified_at,exclusive_attested_at,starting_used,enabled) VALUES($1,'qualification-account','qualification-key',clock_timestamp()-interval '1 day',clock_timestamp()+interval '20 days',clock_timestamp(),clock_timestamp(),0,true)`,[w]);
  await runApolloDiscovery(f.ctx,{accountRef:'qualification-account',keyRef:'qualification-key',provider:{providerKey:'apollo_free',discoverOrganizations:async()=>({ok:true,requestId:'local',returnedCount:1,organizations:[{name:'Apollo Suggested PM',domain:'apollo-suggested.test',hqCity:'Dallas',hqState:'TX',employeeCount:3}]})}});
  const candidate=(await f.session.query<{id:string}>('SELECT id FROM sourcing_candidates')).rows[0]!;
  await saveCandidate(f.ctx,{firmName:'Spoofed PM',website:'https://spoofed-apollo.test/',locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Unknown',sourceUrl:'https://spoofed-apollo.test/',observedOn:new Date().toISOString().slice(0,10),preparedBy:APOLLO_PREPARED_BY});
  await f.session.query("UPDATE sourcing_discovery_settings SET qualification_evaluation='{}'::jsonb WHERE workspace_id=$1",[w]);
  expect(await f.pass()).toMatchObject({inserted:0}); // Historical flag/report is not current consent.
  const owner=(await f.session.query<{owner_user_id:string}>('SELECT owner_user_id FROM sourcing_discovery_settings')).rows[0]!.owner_user_id;
  expect(await qualificationConfigureCommand({session:f.session,launch:{launchedBy:'arn:aws:iam::123456789012:user/operator',taskArn:'arn:aws:ecs:us-east-1:123456789012:task/cluster/abc'},options:{'--workspace-id':w,'--enabled':'true','--owner-user-id':owner,'--evaluation-sha256':'a'.repeat(64),'--reviewed-eligible':'3','--false-eligible':'0'}})).toMatchObject({ok:true});
  expect(await f.pass()).toMatchObject({inserted:1});
  expect((await f.session.query('SELECT status,revision FROM sourcing_candidates WHERE id=$1',[candidate.id])).rows[0]).toEqual({status:'needs_review',revision:1});
  expect((await f.session.query('SELECT candidate_id,observations,facts FROM sourcing_qualification_runs')).rows).toEqual([{candidate_id:candidate.id,observations:[],facts:[]}]);
  let fetches=0,extractions=0;
  const registry=new HandlerRegistry().register(sourcingQualificationHandler({pageFetch:{providerKey:'fixture',fetchPages:async input=>{
   fetches++;expect(input.firmWebsite).toBe('https://apollo-suggested.test/');
   return {ok:true,costCents:0,value:{pages:[{url:'https://apollo-suggested.test/',contentHash:'a'.repeat(64),contentType:'text/html',body:new TextEncoder().encode('<p>Apollo Suggested PM provides residential property management in Dallas, Texas.</p>'),retrievedAt:new Date().toISOString(),firstParty:false}],skipped:{}}};
  }},extraction:{providerKey:'aws_bedrock.sourcing_qualification',countInputTokens:async()=>{extractions++;return 100;},extract:async()=>{throw new Error('Non-first-party observations cannot invoke extraction');}}}));
  expect(await runOnce(f.session,{registry,owner:'apollo-first-party-test',limit:5})).toMatchObject({failed:0});
  expect(fetches).toBe(1);expect(extractions).toBe(0);
  expect((await f.session.query('SELECT reason FROM sourcing_qualification_runs')).rows).toEqual([{reason:'source_incomplete_or_unverified'}]);
  expect((await f.session.query('SELECT status,revision FROM sourcing_candidates WHERE id=$1',[candidate.id])).rows[0]).toEqual({status:'needs_review',revision:1});
  for(const table of ['firms','contacts','sourcing_admissions','provider_reservations'])expect((await f.session.query(`SELECT * FROM ${table}`)).rows).toHaveLength(0);
 }finally{await f.database.drop();}
});

it.each([{prompt:'qualification-context-v6'},{policy:'qualification-v3'}])('refreshes same-revision stale versions %j exactly once through the registered scheduler',async versions=>{
 const f=await versionFixture();try{
  const old=await f.candidate('historical',versions),matching=await f.candidate('matching');
  const before=(await f.session.query('SELECT * FROM sourcing_qualification_runs WHERE id=$1',[matching.runId])).rows;
  expect(await f.pass()).toMatchObject({outcome:'ran',inserted:1,externalActions:0,sources:[{name:'sourcing-qualification',inserted:1}]});
  const rows=(await f.session.query<{id:string;candidate_revision:number;prompt_version:string;policy_version:string;state:string}>('SELECT id,candidate_revision,prompt_version,policy_version,state FROM sourcing_qualification_runs WHERE candidate_id=$1 ORDER BY requested_at,id',[old.id])).rows;
  expect(rows).toHaveLength(2);expect(rows[1]).toMatchObject({candidate_revision:2,prompt_version:QUALIFICATION_PROMPT_VERSION,policy_version:QUALIFICATION_POLICY_VERSION,state:'pending'});
  expect(await f.pass()).toMatchObject({outcome:'ran',inserted:0,alreadyPresent:0,externalActions:0});
  expect((await f.session.query('SELECT * FROM sourcing_qualification_runs WHERE id=$1',[matching.runId])).rows).toEqual(before);
  const jobs=(await f.session.query('SELECT payload,max_attempts FROM jobs')).rows;
  expect(jobs).toHaveLength(1);expect(jobs[0]).toMatchObject({max_attempts:1,payload:{runId:rows[1]!.id,candidateId:old.id,candidateRevision:2,promptVersion:QUALIFICATION_PROMPT_VERSION,policyVersion:QUALIFICATION_POLICY_VERSION}});
  expect((await f.session.query('SELECT count(*)::integer AS count FROM sourcing_qualification_runs')).rows[0]).toEqual({count:3});
  expect((await f.session.query('SELECT count FROM daily_counters')).rows).toEqual([{count:3}]);
  for(const table of ['contacts','opportunities','sequence_enrollments','outbound_messages','outreach_plans','call_sessions','call_logs','sourcing_admissions','provider_reservations'])expect((await f.session.query(`SELECT * FROM ${table}`)).rows).toHaveLength(0);
 }finally{await f.database.drop();}
});

it('retains same-identity review stops across prompt/policy changes and preserves blocked/dismissed drafts',async()=>{
 const f=await versionFixture();try{
  for(const [n,reason]of IDENTITY_REVIEW_REASONS.entries()){
   for(const stale of [false,true]){
    const c=await f.candidate(`stopped-${n}-${stale}`,stale?{prompt:'qualification-context-v6',policy:'qualification-v3'}:{});
    // A version bump is not a human correction. Keep the existing identity exclusion
    // independent of versions, even after the ordinary seven-day refresh interval.
    await f.session.query("UPDATE sourcing_qualification_runs SET admission_reason=$2,requested_at=now()-interval '8 days' WHERE id=$1",[c.runId,reason]);
   }
  }
  const blocked=await f.candidate('manually-blocked',{prompt:'qualification-context-v6'});
  await f.session.query('UPDATE sourcing_candidates SET qualification_blocked=true WHERE id=$1',[blocked.id]);
  const dismissed=await f.candidate('dismissed',{prompt:'qualification-context-v6'});
  expect(await withTransaction(f.session,()=>reviewCandidate(f.ctx,{id:dismissed.id,expectedRevision:2,status:'dismissed'}))).toMatchObject({ok:true});
  const before=(await f.session.query('SELECT * FROM sourcing_qualification_runs ORDER BY id')).rows;
  expect(await f.pass()).toMatchObject({outcome:'ran',inserted:0,externalActions:0});
  expect((await f.session.query('SELECT * FROM sourcing_qualification_runs ORDER BY id')).rows).toEqual(before);
  expect((await f.session.query('SELECT * FROM jobs')).rows).toHaveLength(0);
 }finally{await f.database.drop();}
});

// ADR0034 intentionally changed this: unreviewed Tavily intake no longer waits for the
// verified-firm attestation, so only disabled scheduling and other unreviewed drafts stay off.
it('keeps disabled scheduling and automatic-OFF non-discovery unreviewed intake off despite stale versions',async()=>{
 const f=await versionFixture();try{
  const c=await f.candidate('automatic-off',{prompt:'qualification-context-v6'});
  expect(await f.pass(false)).toMatchObject({outcome:'ran',inserted:0});
  await f.session.query("UPDATE sourcing_candidates SET status='needs_review',next_source_check_at=NULL,payload=jsonb_set(payload,'{preparedBy}','\"Fixture\"') WHERE id=$1",[c.id]);
  await f.session.query('UPDATE sourcing_discovery_settings SET auto_admission_enabled=false');
  expect(await f.pass()).toMatchObject({outcome:'ran',inserted:0});
  expect((await f.session.query('SELECT id FROM sourcing_qualification_runs')).rows).toHaveLength(1);
  expect((await f.session.query('SELECT id FROM jobs')).rows).toHaveLength(0);
 }finally{await f.database.drop();}
});

it.each(['open','disabled','held'] as const)('captures unreviewed Tavily discovery without verified-firm attestation only while research is %s',async gate=>{
 const f=await versionFixture();try{
  await f.session.query("UPDATE sourcing_discovery_settings SET auto_admission_enabled=false,qualification_evaluation='{}'::jsonb");
  const draft=(name:string,preparedBy:string)=>withTransaction(f.session,async()=>{
   const saved=await saveCandidate(f.ctx,{firmName:name,website:`https://${name}.example.test/`,locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Unknown',sourceUrl:`https://${name}.example.test/`,observedOn:'2026-10-18',preparedBy});
   if(!saved.ok)throw new Error(saved.reason);return saved.value.id;
  });
  const tavily=await draft('unattested','Tavily Basic search · not verified'),other=await draft('unattested-manual','Fixture');
  if(gate==='disabled')await f.session.query('UPDATE research_settings SET enabled=false');
  if(gate==='held')await withTransaction(f.session,()=>openHold(f.ctx,{scopeKind:'workspace',reasonCode:'scoped_pause',blockedActionKinds:['research'],sourceEventKind:'fixture'}));
  const runs=async(id:string)=>(await f.session.query('SELECT producer_version FROM sourcing_qualification_runs WHERE candidate_id=$1',[id])).rows;
  if(gate==='open'){
   expect(await f.pass()).toMatchObject({outcome:'ran',inserted:1});
   expect(await runs(tavily)).toEqual([{producer_version:'qualification-context-v7'}]);
   expect((await f.session.query("SELECT payload->>'candidateId' AS id FROM jobs WHERE kind='sourcing.qualify'")).rows).toEqual([{id:tavily}]);
  }else{
   expect(await f.pass()).toMatchObject({outcome:'ran',inserted:0});
   expect(await runs(tavily)).toEqual([]);
   expect((await f.session.query('SELECT qualification_wait_reason FROM sourcing_discovery_settings')).rows).toEqual([{qualification_wait_reason:gate==='disabled'?'research_disabled':'research_held'}]);
  }
  expect(await runs(other)).toEqual([]);
  expect((await f.session.query('SELECT status,revision FROM sourcing_candidates WHERE id=$1',[tavily])).rows[0]).toEqual({status:'needs_review',revision:1});
  for(const table of ['firms','sourcing_admissions'])expect((await f.session.query(`SELECT * FROM ${table}`)).rows).toHaveLength(0);
 }finally{await f.database.drop();}
});

it('keeps the same-revision identity-review stop for unattested Tavily intake even when its run is stale',async()=>{
 const f=await versionFixture();try{
  await f.session.query("UPDATE sourcing_discovery_settings SET auto_admission_enabled=false,qualification_evaluation='{}'::jsonb");
  const stale=async(name:string,reason:string|null)=>withTransaction(f.session,async()=>{
   const saved=await saveCandidate(f.ctx,{firmName:name,website:`https://${name}.example.test/`,locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Unknown',sourceUrl:`https://${name}.example.test/`,observedOn:'2026-10-18',preparedBy:'Tavily Basic search · not verified'});
   if(!saved.ok)throw new Error(saved.reason);
   const requested=await requestQualification(f.ctx,{candidateId:saved.value.id,expectedRevision:1},{enqueue:false});if(!requested.ok)throw new Error(requested.reason);
   await f.session.query("UPDATE sourcing_qualification_runs SET state='review',admission_reason=$2,requested_at=now()-interval '8 days',prompt_version='qualification-context-v6',fingerprint=repeat('b',64) WHERE id=$1",[requested.value.runId,reason]);
   return saved.value.id;
  });
  const stopped:string[]=[];for(const [n,reason] of IDENTITY_REVIEW_REASONS.entries())stopped.push(await stale(`unattested-stopped-${n}`,reason));
  const ordinary=await stale('unattested-ordinary',null);
  expect(await f.pass()).toMatchObject({outcome:'ran',inserted:1});
  expect((await f.session.query("SELECT payload->>'candidateId' AS id FROM jobs WHERE kind='sourcing.qualify'")).rows).toEqual([{id:ordinary}]);
  for(const id of stopped)expect((await f.session.query('SELECT id FROM sourcing_qualification_runs WHERE candidate_id=$1',[id])).rows).toHaveLength(1);
 }finally{await f.database.drop();}
});

it.each(['disabled','held','ceiling'] as const)('keeps stale-version refresh behind existing research %s gate',async gate=>{
 const f=await versionFixture();try{
  await f.candidate('gated',{prompt:'qualification-context-v6'});
  if(gate==='disabled')await f.session.query('UPDATE research_settings SET enabled=false');
  if(gate==='held')await withTransaction(f.session,()=>openHold(f.ctx,{scopeKind:'workspace',reasonCode:'scoped_pause',blockedActionKinds:['research'],sourceEventKind:'fixture'}));
  // This is the SAME shared research_firm_runs counter already consumed by requestQualification.
  if(gate==='ceiling')await f.session.query('UPDATE daily_counters SET count=100');
  const before=(await f.session.query('SELECT * FROM daily_counters')).rows;
  expect(await f.pass()).toMatchObject({outcome:'ran',inserted:0,externalActions:0});
  expect((await f.session.query('SELECT qualification_wait_reason FROM sourcing_discovery_settings')).rows).toEqual([{qualification_wait_reason:{disabled:'research_disabled',held:'research_held',ceiling:'daily_firm_ceiling'}[gate]}]);
  expect((await f.session.query('SELECT * FROM daily_counters')).rows).toEqual(before);
  expect((await f.session.query('SELECT id FROM sourcing_qualification_runs')).rows).toHaveLength(1);
  expect((await f.session.query('SELECT id FROM jobs')).rows).toHaveLength(0);
 }finally{await f.database.drop();}
});
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
 await db.session.query("UPDATE sourcing_candidates SET status='kept',revision=revision+1,next_source_check_at=now() WHERE payload->>'firmName'='Budget PM'");
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
   await db.session.query("UPDATE sourcing_candidates SET status='kept',revision=revision+1,next_source_check_at=now() WHERE workspace_id=$1",[workspace.workspaceId]);
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
 await db.session.query("UPDATE sourcing_qualification_runs SET state='review',fingerprint=repeat('d',64),requested_at=now()-interval '8 days' WHERE candidate_id=$1",[old]);
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
it('reschedules a human-corrected unclear identity through automatic research-only admission and sourced call-list readiness',async()=>{
 const {correctCandidateName}=await import('@fss/domain/sourcing/candidateCorrection.ts');
 const {randomUUID,createHash}=await import('node:crypto');
 const {finishQualification}=await import('@fss/domain/sourcing/qualificationStore.ts');
 const {qualificationConfigureCommand}=await import('../src/tools/fss/qualificationConfigure.ts');
 const {sourcingQualificationHandler}=await import('../src/handlers/sourcingQualification.ts');
 const {researchFirmJobHandler}=await import('../src/handlers/research.ts');
 const {HandlerRegistry}=await import('@fss/domain/jobs/handlerRegistry.ts');
 const {runOnce}=await import('../src/runner/jobRunner.ts');
 const {newFirmSource}=await import('@fss/domain/today/build.ts');
 const {recordStatePosture}=await import('@fss/domain/policy/postures.ts');
 const {POSTURE_STATEMENTS}=await import('@fss/domain/src/rules/statePosture.ts');
 await db.session.query('DELETE FROM sourcing_candidates');await db.session.query('DELETE FROM daily_counters');await db.session.query('DELETE FROM jobs');
 await db.session.query('UPDATE research_settings SET daily_firm_ceiling=50,enabled=true WHERE workspace_id=$1',[workspaceId]);
 const owner=(await db.session.query<{user_id:string}>("SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND role='admin' LIMIT 1",[workspaceId])).rows[0]!.user_id;
 const ctx=repositoryContext(workspaceScope(workspaceId,{kind:'user',role:'admin',userId:owner}),db.session);
 const tx=<T>(fn:()=>Promise<T>)=>withTransaction(db.session,fn);
 await tx(()=>recordStatePosture(ctx,{state:'MA',effectiveFrom:new Date(Date.now()-60000).toISOString(),confirmedStatements:Object.keys(POSTURE_STATEMENTS)}));
 expect(await qualificationConfigureCommand({session:db.session,launch:{launchedBy:'arn:aws:iam::123456789012:user/operator',taskArn:'arn:aws:ecs:us-east-1:123456789012:task/cluster/abc'},options:{'--workspace-id':workspaceId,'--enabled':'true','--owner-user-id':owner,'--evaluation-sha256':'a'.repeat(64),'--reviewed-eligible':'3','--false-eligible':'0'}})).toMatchObject({ok:true});
 const url='https://automatic-worcester.example.test/';
 const saved=await tx(()=>saveCandidate(ctx,{firmName:'Unverified Suggested Name',website:url,locality:'Worcester',region:'MA',signal:'fit_only',evidence:'Search is unverified',sourceUrl:url,observedOn:'2026-10-18',preparedBy:'Tavily Basic search · not verified'}));if(!saved.ok)throw new Error(saved.reason);
 const jobs=await tx(()=>sourcingQualificationSource(true).find(db.session,new Date().toISOString()));expect(jobs).toHaveLength(1);
 for(const job of jobs)await enqueueJob(db.session,job);
 const runId=jobs[0]!.payload['runId'];if(typeof runId!=='string')throw new Error('run_id_missing');
 const observationId=randomUUID(),text='Automatic Worcester LLC office: Worcester, Massachusetts. We provide residential property management. Contact Automatic Worcester LLC at (508) 555-0199.';
 expect(await tx(()=>finishQualification(ctx,{runId,reason:null,observations:[{id:observationId,url,contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:new Date().toISOString(),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[{id:'office',text}]}],facts:['firm_identity','residential_management','service_area','business_phone'].map(kind=>({kind,observationId,blockId:'office',value:text}))}))).toMatchObject({ok:true});
 const qualification=new HandlerRegistry().register(sourcingQualificationHandler({pageFetch:{providerKey:'fixture',fetchPages:async()=>{throw new Error('never refetch finished identity');}},extraction:null}));
 expect(await runOnce(db.session,{registry:qualification,owner:'auto-identity',limit:5})).toMatchObject({failed:0});
 expect((await db.session.query('SELECT admission_reason FROM sourcing_qualification_runs WHERE id=$1',[runId])).rows[0]).toEqual({admission_reason:'firm_identity_ambiguous'});
 expect(await tx(()=>sourcingQualificationSource(true).find(db.session,new Date().toISOString()))).toHaveLength(0);
 expect(await tx(()=>correctCandidateName(ctx,{id:saved.value.id,expectedRevision:1,qualificationRunId:runId,firmName:'Automatic Worcester LLC',observationId,blockId:'office',reason:'Use literal first-party legal identity'}))).toMatchObject({ok:true,value:{revision:2}});
 const corrected=await tx(()=>sourcingQualificationSource(true).find(db.session,new Date().toISOString()));expect(corrected).toHaveLength(1);
 for(const job of corrected)await enqueueJob(db.session,job);
 const correctedRunId=corrected[0]!.payload['runId'];if(typeof correctedRunId!=='string')throw new Error('corrected_run_missing');
 expect(await tx(()=>finishQualification(ctx,{runId:correctedRunId,reason:null,observations:[{id:observationId,url,contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:new Date().toISOString(),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[{id:'office',text}]}],facts:['firm_identity','residential_management','service_area','business_phone'].map(kind=>({kind,observationId,blockId:'office',value:text}))}))).toMatchObject({ok:true});
 expect(await runOnce(db.session,{registry:qualification,owner:'corrected-auto-identity',limit:5})).toMatchObject({failed:0});
 const a=(await db.session.query<{firm_id:string}>('SELECT firm_id FROM sourcing_admissions WHERE candidate_id=$1',[saved.value.id])).rows[0];expect(a).toBeDefined();if(!a)throw new Error('automatic_admission_missing');
 expect((await db.session.query('SELECT status,revision FROM sourcing_candidates WHERE id=$1',[saved.value.id])).rows[0]).toEqual({status:'kept',revision:3});
 const find=()=>newFirmSource().find(ctx,{businessDate:new Date().toISOString().slice(0,10),businessTimeZone:'America/New_York',now:new Date().toISOString(),firmId:a.firm_id});
 expect(await find()).toHaveLength(0);
 const html='<p>We manage residential property for owners.</p>';let calls=0;
 const registry=new HandlerRegistry().register(researchFirmJobHandler({pageFetch:{providerKey:'company_page',fetchPages:async()=>({ok:true,costCents:0,value:{pages:[{url,contentHash:createHash('sha256').update(html).digest('hex'),contentType:'text/html',body:new TextEncoder().encode(html),retrievedAt:new Date().toISOString(),firstParty:true}],skipped:{}}})},extraction:{providerKey:'anthropic_extraction',countInputTokens:async()=>100,extract:async()=>{calls++;return {ok:true,costCents:1,value:{selections:[{key:'target_fit',sourceReference:url,blockId:'b1'}],questions:null,opening:null,modelName:'claude-haiku-4-5',inputTokens:100,outputTokens:50}};}}}));
 expect(await runOnce(db.session,{registry,owner:'auto-research',limit:5})).toMatchObject({failed:0});expect(calls).toBe(1);expect(await find()).toHaveLength(1);
 expect(await runOnce(db.session,{registry,owner:'auto-research-replay',limit:5})).toMatchObject({failed:0});expect(calls).toBe(1);
 for(const table of ['contacts','opportunities','sequence_enrollments','outbound_messages','outreach_plans','call_sessions','call_logs'])expect((await db.session.query(`SELECT id FROM ${table} WHERE workspace_id=$1`,[workspaceId])).rows).toHaveLength(0);
});
