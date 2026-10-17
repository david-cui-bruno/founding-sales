import {randomUUID} from 'node:crypto';
import {it,expect} from 'vitest';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {dispatch} from '../src/server.ts';
import type {SessionQueryable} from '@fss/domain/db/queryable.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {checkLinkedinPolicyForWork} from '@fss/domain/social/linkedinPolicy.ts';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer} from 'node:http';

const approvedRulesVersion='634-2026-10-13';
const command=()=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
const generation={provider:'bedrock',providerKey:'configured-founder-haiku',region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',model:'us.anthropic.claude-haiku-4-5-20251001-v1:0',accessGrantVersion:'existing-grant-v1',dataHandlingVersion:'business-excerpts-v1',routeVersion:'haiku-route-v1',dailyUsd:2,calendarMonthUsd:25,budgetZone:'America/New_York'};
function caller(f:AuthFixture,token:string,db:SessionQueryable=f.db){
 return (path:string,body:unknown)=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:token?{authorization:`Bearer ${token}`}:{},body},{session:db,auth:{...f.deps,db},supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://fixture.invalid/update'});
}
async function setup(){
 const f=await createAuthFixture();
 const token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
 const call=caller(f,token);
 const accountId=randomUUID();
 expect((await call('/social/accounts/connect',{accountId,platform:'linkedin',externalId:'controlled-founder',displayName:'Founder',accountKind:'profile',...command()})).status).toBe(200);
 const input={...command(),expectedRevision:0,accountId,accountRevision:1,approved:true,approvedRulesVersion,dataScope:'founder_sales_business',acquisitionBinding:null,generation:null};
 return {f,token,call,accountId,input};
}
it('saves and reads the complete settled policy without enabling or borrowing posting authority',async()=>{
 const {f,call,accountId,input}=await setup();try{
 expect((await call('/social/linkedin-policy/save',input)).status).toBe(200);
 expect((await call('/social/linkedin-policy/read',{})).body).toMatchObject({revision:1,state:'saved',approved:true,enabled:false,technicallyReady:false,policy:{accountId,accountExternalId:'controlled-founder',accountRevision:1,dataScope:'founder_sales_business',generation:null,rules:{
  version:approvedRulesVersion,
  invitations:{rolling24Hours:20,rolling7Days:140,includeManual:true,clock:'elapsed_rolling',window:{zone:'prospect_local',startHour:9,endHourExclusive:17,weekends:true,unknownTimezone:'postpone'},notes:'never',unknownRemainingAllowance:'hold'},
  directMessages:{rolling24Hours:20,includeManual:true,window:{zone:'prospect_local',weekends:false},unknownRemainingAllowance:'hold'},
  cadence:{scope:'person_email_and_linkedin',maximumMessages:4,days:[0,3,7,14],includeManualProspecting:true,weekdayShift:'next_permitted_weekday',catchUpBurst:false,stricterEmailLimits:'independent'},
  firms:{activePeople:1,unansweredCooldownDays:30,cooldownStarts:'final_sequence_message',referral:'supported_only_without_contradicting_refusal'},
  stops:{anyReply:'stop_and_owner_handoff',personRefusal:'suppress_person',firmRefusal:'suppress_firm',ambiguousRefusal:'hold_firm',routineSubstantiveReplies:false,suppressionBypass:false,missingRelevantReplyHistory:'hold_person'},
  acquisition:{account:'existing_personal_linkedin_exact_identity_required',unrelatedPersonalChats:false,wholeInbox:false,manualCounting:'minimal_activity_without_unrelated_bodies'},
  retention:{until:'owner_deletes',stopCapture:'retain_permitted_copies_no_new_acquisition',processingAuthority:'separate',deletion:'erase_copied_and_derived_private_content_invalidate_source_work',retainedFacts:'minimal_content_free_stop_deletion_audit',providerOriginalDeletion:false,ordinaryReimport:false},
  generation:{purpose:'linkedin_prospecting_dm_openers_followups',data:'supported_person_firm_facts_and_message_relevant_permitted_excerpts',wholeInboxes:false,unrelatedChats:false,inventedFamiliarity:false,inferredPromises:false,substantiveSalesReplies:false,silentRouteSwitch:false},
  spend:{purpose:'linkedin_prospecting_dm_generation',dailyUsd:2,calendarMonthUsd:25,zone:'America/New_York',stricterSharedLimits:true,postingBookingDiagnosticPooling:false,reserveBeforeDispatch:true,failedUnknownSettlement:'conservative',insufficientAllowance:'pause',automaticTopUp:false},
  calibration:{requiredBeforeOperation:true,scope:'one_representative_original_opener_and_day3_day7_day14_set',perRecipientReview:false,openerPrefix:'Great connecting with you',question:'genuine_relevant',inventedFamiliarity:false,privateStoryReuse:false,newSubstantiveSalesCommitments:false},
 }},holds:expect.arrayContaining(['exact_identity_unverified','acquisition_binding_unknown','acquisition_evidence_unavailable','generation_not_configured','manual_count_coverage_unavailable','reply_history_coverage_unavailable','voice_calibration_unverified','outreach_adapter_unavailable'])});
 expect((await call('/social/linkedin-policy/check-current',{expectedRevision:1,accountId,accountRevision:1})).body).toMatchObject({current:true,allowed:false,reason:'current_approval_not_dispatch_authority'});
 expect((await call('/social/linkedin-policy/enable',{...command(),expectedRevision:1})).status).toBe(404);
 }finally{await f.stop();}
});
it('discloses approved rules before first save and requires exact explicit policy-version approval',async()=>{
 const {f,call,input}=await setup();try{
 expect((await call('/social/linkedin-policy/read',{})).body).toMatchObject({revision:0,policy:null,rules:{version:approvedRulesVersion,spend:{dailyUsd:2,calendarMonthUsd:25}}});
 const {approvedRulesVersion:_v,...missingVersion}=input;
 expect((await call('/social/linkedin-policy/save',missingVersion)).status).toBe(400);
 expect((await call('/social/linkedin-policy/save',{...input,approvedRulesVersion:'old-627'})).status).toBe(400);
 expect((await call('/social/linkedin-policy/save',{...input,approved:false})).status).toBe(400);
 expect((await call('/social/linkedin-policy/save',{...input,enabled:true})).status).toBe(400);
 expect((await call('/social/linkedin-policy/read',{ownerUserId:f.beta.admin.userId})).status).toBe(400);
 expect((await call('/social/linkedin-policy/read',{})).body).toMatchObject({revision:0});
 }finally{await f.stop();}
});
it('exposes selectable current owner account revisions without presenting posting verification as outreach identity',async()=>{
 const {f,call,input,accountId}=await setup();try{
 expect((await call('/social/linkedin-policy/read',{})).body).toMatchObject({accounts:[{id:accountId,externalId:'controlled-founder',displayName:'Founder',revision:1,state:'connected',identityVerified:false}]});
 expect((await call('/social/accounts/connect',{accountId,platform:'linkedin',externalId:'controlled-founder',displayName:'Updated Founder',accountKind:'profile',...command()})).status).toBe(200);
 expect((await call('/social/linkedin-policy/read',{})).body).toMatchObject({accounts:[{id:accountId,revision:2,identityVerified:false}]});
 expect((await call('/social/linkedin-policy/save',{...input,accountRevision:2})).status).toBe(200);
 expect((await call('/social/linkedin-policy/read',{})).body).toMatchObject({policy:{accountRevision:2},accounts:[{id:accountId,revision:2}]});
 }finally{await f.stop();}
});
it('holds unknown data, optional configured generation and real evidence independently',async()=>{
 const {f,call,input}=await setup();try{
 expect((await call('/social/linkedin-policy/save',{...input,dataScope:null})).status).toBe(200);
 expect((await call('/social/linkedin-policy/read',{})).body).toMatchObject({policy:{dataScope:null,generation:null},holds:expect.arrayContaining(['data_scope_unknown','generation_not_configured'])});
 const acquisitionBinding={configurationId:randomUUID(),revision:4};
 expect((await call('/social/linkedin-policy/save',{...input,...command(),expectedRevision:1,generation,acquisitionBinding})).status).toBe(200);
 expect((await call('/social/linkedin-policy/read',{})).body).toMatchObject({revision:2,approved:true,enabled:false,technicallyReady:false,policy:{generation,acquisitionBinding},holds:expect.arrayContaining(['provider_binding_unverified','spend_evidence_unavailable','acquisition_evidence_unavailable','voice_calibration_unverified'])});
 for(const change of [{model:'gemini'},{dailyUsd:3},{calendarMonthUsd:26},{budgetZone:'UTC'},{providerKey:''}])expect((await call('/social/linkedin-policy/save',{...input,...command(),expectedRevision:2,generation:{...generation,...change}})).status).toBe(400);
 expect((await call('/social/linkedin-policy/read',{})).body).toMatchObject({revision:2,policy:{generation}});
 }finally{await f.stop();}
});
it('enforces owner and workspace isolation with real sign-in and colliding external account IDs',async()=>{
 const {f,call,input,accountId}=await setup();try{
 const beta=caller(f,(await issueSessionFor(f,f.beta,f.beta.admin)).accessToken);
 const salesperson=caller(f,(await issueSessionFor(f,f.alpha,f.alpha.salesperson)).accessToken);
 const anonymous=caller(f,'');
 for(const path of ['read','save','disable','revoke','check-current'])expect((await anonymous(`/social/linkedin-policy/${path}`,{})).status).toBe(401);
 expect((await call('/social/linkedin-policy/save',input)).status).toBe(200);
 for(const other of [beta,salesperson]){
  expect((await other('/social/linkedin-policy/read',{})).body).toMatchObject({revision:0,policy:null});
  expect((await other('/social/linkedin-policy/save',{...input,...command()})).body).toMatchObject({reason:'account_not_found'});
  expect((await other('/social/linkedin-policy/revoke',{...command(),expectedRevision:1})).body).toMatchObject({reason:'policy_not_saved'});
  expect((await other('/social/linkedin-policy/check-current',{expectedRevision:1,accountId,accountRevision:1})).body).toMatchObject({current:false,allowed:false});
 }
 expect((await beta('/social/accounts/connect',{accountId,platform:'linkedin',externalId:'controlled-founder',displayName:'Beta Founder',accountKind:'profile',...command()})).status).toBe(200);
 expect((await beta('/social/linkedin-policy/save',{...input,generation})).status).toBe(200);
 expect((await beta('/social/linkedin-policy/read',{})).body).toMatchObject({revision:1,policy:{generation}});
 expect((await call('/social/linkedin-policy/read',{})).body).toMatchObject({revision:1,policy:{generation:null}});
 }finally{await f.stop();}
});
it('makes disable/revoke idempotent, retains historical command readback and refuses stale authority after restart',async()=>{
 const {f,call,token,input,accountId}=await setup();try{
 expect((await call('/social/linkedin-policy/save',input)).status).toBe(200);
 const disable={...command(),expectedRevision:1};
 expect((await call('/social/linkedin-policy/disable',disable)).body).toMatchObject({result:{revision:2,state:'disabled',approved:false,approvedAt:null,enabled:false}});
 expect((await call('/social/linkedin-policy/disable',disable)).body).toMatchObject({replayed:true,result:{revision:2}});
 expect((await call('/social/linkedin-policy/save',input)).body).toMatchObject({replayed:true,result:{revision:1,state:'saved'}});
 expect((await call('/social/linkedin-policy/read',{})).body).toMatchObject({revision:2,state:'disabled',approved:false});
 expect((await call('/social/linkedin-policy/save',{...input,...command()})).body).toMatchObject({reason:'stale_revision'});
 expect((await call('/social/linkedin-policy/check-current',{expectedRevision:1,accountId,accountRevision:1})).body).toMatchObject({current:false,reason:'stale_revision'});
 const save={...input,...command(),expectedRevision:2,generation};
 expect((await call('/social/linkedin-policy/save',save)).body).toMatchObject({result:{revision:3,state:'saved',approved:true}});
 const revoke={...command(),expectedRevision:3};
 expect((await call('/social/linkedin-policy/revoke',revoke)).body).toMatchObject({result:{revision:4,state:'revoked',approved:false}});
 expect((await call('/social/linkedin-policy/revoke',revoke)).body).toMatchObject({replayed:true,result:{revision:4}});
 const restarted=caller(f,token,await f.database.appRuntimeSession());
 expect((await restarted('/social/linkedin-policy/read',{})).body).toMatchObject({revision:4,state:'revoked',policy:{generation}});
 expect((await restarted('/social/linkedin-policy/check-current',{expectedRevision:3,accountId,accountRevision:1})).body).toMatchObject({current:false,allowed:false,reason:'stale_revision'});
 expect((await restarted('/social/linkedin-policy/check-current',{expectedRevision:4,accountId,accountRevision:1})).body).toMatchObject({current:false,reason:'policy_revoked'});
 expect((await call('/social/linkedin-policy/revoke',{...revoke,expectedRevision:4})).body).toMatchObject({reason:'command_payload_mismatch'});
 }finally{await f.stop();}
});
it('invalidates account revisions and scope/provider changes without carrying old approval forward',async()=>{
 const {f,call,input,accountId}=await setup();try{
 expect((await call('/social/linkedin-policy/save',input)).status).toBe(200);
 expect((await call('/social/accounts/connect',{accountId,platform:'linkedin',externalId:'controlled-founder',displayName:'Updated Founder',accountKind:'profile',...command()})).status).toBe(200);
 expect((await call('/social/linkedin-policy/read',{})).body).toMatchObject({revision:1,policy:{accountRevision:1},holds:expect.arrayContaining(['account_changed'])});
 expect((await call('/social/linkedin-policy/check-current',{expectedRevision:1,accountId,accountRevision:1})).body).toMatchObject({current:false,reason:'account_changed'});
 expect((await call('/social/linkedin-policy/save',{...input,...command(),expectedRevision:1})).body).toMatchObject({reason:'account_changed'});
 expect((await call('/social/linkedin-policy/save',{...input,...command(),expectedRevision:1,accountRevision:2,generation})).status).toBe(200);
 const source={configurationId:randomUUID(),revision:1};
 expect((await call('/social/linkedin-policy/save',{...input,...command(),expectedRevision:2,accountRevision:2,generation,acquisitionBinding:source})).status).toBe(200);
 expect((await call('/social/linkedin-policy/check-current',{expectedRevision:2,accountId,accountRevision:2})).body).toMatchObject({current:false,reason:'stale_revision'});
 expect((await call('/social/linkedin-policy/read',{})).body).toMatchObject({revision:3,policy:{accountRevision:2,generation,acquisitionBinding:source}});
 expect((await call('/social/accounts/disconnect',{accountId,...command()})).status).toBe(200);
 expect((await call('/social/linkedin-policy/check-current',{expectedRevision:3,accountId,accountRevision:2})).body).toMatchObject({current:false,reason:'account_unavailable'});
 }finally{await f.stop();}
});
it('keeps elapsed rolling ceilings and prospect-local windows distinct from New York spend calendar across DST',async()=>{
 const {f,call,input}=await setup();try{
 // Controlled auth clock around the spring and autumn New York DST transitions.
 for(const instant of ['2026-03-08T06:59:00Z','2026-03-08T07:01:00Z','2026-11-01T05:59:00Z','2026-11-01T06:01:00Z']){
  f.setNow(new Date(instant));
  const seconds=Math.floor(new Date(instant).getTime()/1000);
  const timedFixture={...f,google:{...f.google,signIdToken:(claims:Parameters<typeof f.google.signIdToken>[0])=>f.google.signIdToken({...claims,iat:seconds,exp:seconds+3600})}};
  const fresh=caller(f,(await issueSessionFor(timedFixture,f.alpha,f.alpha.admin)).accessToken);
  if(instant==='2026-03-08T06:59:00Z')expect((await fresh('/social/linkedin-policy/save',input)).status).toBe(200);
  expect((await fresh('/social/linkedin-policy/read',{})).body).toMatchObject({revision:1,enabled:false,policy:{rules:{invitations:{clock:'elapsed_rolling',rolling24Hours:20,rolling7Days:140,window:{zone:'prospect_local',unknownTimezone:'postpone',weekends:true}},directMessages:{clock:'elapsed_rolling',window:{zone:'prospect_local',weekends:false}},spend:{zone:'America/New_York',calendarMonthUsd:25}}}});
 }
 // The original expired session cannot read retained settings at the later clock.
 expect((await call('/social/linkedin-policy/read',{})).status).toBe(401);
 }finally{await f.stop();}
});

/** Synchronization only. Product assertions use public commands/read or the
 * exported trusted worker barrier, never a private state projection. */
async function waitForBlockedPolicy(observer:SessionQueryable,blockerPid:number){
 for(let attempt=0;attempt<200;attempt++){
  const q=await observer.query<{blocked:boolean}>('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked',[blockerPid]);
  if(q.rows[0]?.blocked)return;
  await delay(5);
 }
 throw new Error('Policy caller did not reach controlled PostgreSQL barrier');
}
it('serializes concurrent same-command replay and conflicting owner revisions in real application-role sessions',async()=>{
 const {f,token,call,input}=await setup();try{
 const a=caller(f,token,await f.database.appRuntimeSession());
 const b=caller(f,token,await f.database.appRuntimeSession());
 const results=await Promise.all([a('/social/linkedin-policy/save',input),b('/social/linkedin-policy/save',input)]);
 expect(results.map(r=>r.status)).toEqual([200,200]);
 expect(results.map(r=>r.body)).toEqual(expect.arrayContaining([expect.objectContaining({replayed:false,result:expect.objectContaining({revision:1})}),expect.objectContaining({replayed:true,result:expect.objectContaining({revision:1})})]));
 const changes=await Promise.all([
  a('/social/linkedin-policy/save',{...input,...command(),expectedRevision:1,generation}),
  b('/social/linkedin-policy/revoke',{...command(),expectedRevision:1}),
 ]);
 expect(changes.map(r=>r.status).sort()).toEqual([200,409]);
 expect(changes.map(r=>r.body)).toEqual(expect.arrayContaining([expect.objectContaining({reason:'stale_revision'})]));
 expect((await call('/social/linkedin-policy/read',{})).body).toMatchObject({revision:2,enabled:false});
 // Revoke the resulting revision even if the concurrent save won first.
 expect((await call('/social/linkedin-policy/revoke',{...command(),expectedRevision:2})).body).toMatchObject({result:{revision:3,state:'revoked',approved:false}});
 }finally{await f.stop();}
});
it('rechecks policy after controlled external account observation waits and preserves accepted unrelated social work',async()=>{
 const {f,token,call,input,accountId}=await setup();
 let release!:()=>void,entered!:()=>void;
 const wait=new Promise<void>(resolve=>{release=resolve;});
 const observed=new Promise<void>(resolve=>{entered=resolve;});
 const evidence={accountExternalId:'controlled-founder',observedAt:'2026-10-13T18:00:00Z',receiptId:'controlled-account-observation'};
 const server=createServer((_request,response)=>{
  entered();
  void wait.then(()=>{response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(evidence));});
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();
 if(!address||typeof address==='string')throw new Error('Controlled account server unavailable');
 try{
 expect((await call('/social/linkedin-policy/save',input)).status).toBe(200);
 const savedPost=await call('/social/posts/save',{accountId,text:'Unrelated owner post remains unchanged',images:[],publishAt:null,zone:'America/New_York',...command()});
 expect(savedPost.status).toBe(200);
 expect((await call('/social/weekly/save',{expectedRevision:0,enabled:true,...command()})).status).toBe(200);
 const before=await call('/social',{});
 const db=await f.database.appRuntimeSession();
 const ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'system',component:'worker'}),db);
 const binding={ownerUserId:f.alpha.admin.userId,expectedRevision:1,accountId,accountRevision:1};
 expect(await withTransaction(db,()=>checkLinkedinPolicyForWork(ctx,binding))).toMatchObject({current:true,allowed:false});
 // No production native/provider request and no lock is held across this wait.
 const observation=fetch(`http://127.0.0.1:${address.port}/account`).then(r=>r.json());
 await observed;
 expect((await call('/social/linkedin-policy/revoke',{...command(),expectedRevision:1})).status).toBe(200);
 release();
 expect(await observation).toEqual(evidence);
 expect(await withTransaction(db,()=>checkLinkedinPolicyForWork(ctx,binding))).toMatchObject({current:false,allowed:false,reason:'stale_revision',policy:null});
 const restarted=caller(f,token,await f.database.appRuntimeSession());
 expect((await restarted('/social/linkedin-policy/check-current',{expectedRevision:1,accountId,accountRevision:1})).body).toMatchObject({current:false,allowed:false,reason:'stale_revision'});
 expect((await call('/social',{})).body).toEqual(before.body);
 expect((await call('/social/weekly',{})).body).toMatchObject({revision:1,enabled:true});
 }finally{
 release();
 await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
 await f.stop();
 }
});
it('checks durable owner binding as a trusted system worker without impersonating the owner',async()=>{
 const {f,call,input,accountId}=await setup();try{
 expect((await call('/social/linkedin-policy/save',input)).status).toBe(200);
 const db=await f.database.appRuntimeSession();
 const ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'system',component:'worker'}),db);
 const binding={ownerUserId:f.alpha.admin.userId,expectedRevision:1,accountId,accountRevision:1};
 expect(await withTransaction(db,()=>checkLinkedinPolicyForWork(ctx,binding))).toMatchObject({current:true,allowed:false});
 const wrongWorkspace=repositoryContext(workspaceScope(f.beta.workspaceId,{kind:'system',component:'worker'}),db);
 expect(await withTransaction(db,()=>checkLinkedinPolicyForWork(wrongWorkspace,binding))).toMatchObject({current:false,allowed:false});
 const wrongOwner={...binding,ownerUserId:f.alpha.salesperson.userId};
 expect(await withTransaction(db,()=>checkLinkedinPolicyForWork(ctx,wrongOwner))).toMatchObject({current:false,allowed:false});
 const human=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'user',userId:f.alpha.salesperson.userId,role:'salesperson'}),db);
 await expect(withTransaction(db,()=>checkLinkedinPolicyForWork(human,binding))).rejects.toThrow('worker_required');
 const scheduler=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'system',component:'scheduler'}),db);
 await expect(withTransaction(db,()=>checkLinkedinPolicyForWork(scheduler,binding))).rejects.toThrow('worker_required');
 expect((await call('/social/linkedin-policy/revoke',{...command(),expectedRevision:1})).status).toBe(200);
 expect(await withTransaction(db,()=>checkLinkedinPolicyForWork(ctx,binding))).toMatchObject({current:false,allowed:false,reason:'stale_revision'});
 }finally{await f.stop();}
});
it('rechecks membership after a PostgreSQL wait and does not disclose the departed owner policy',async()=>{
 const {f,call,token,input}=await setup();let pending:Promise<unknown>|undefined;
 const key=`social-accounts:${f.alpha.workspaceId}:${f.alpha.admin.userId}`;
 try{
 expect((await call('/social/linkedin-policy/save',input)).status).toBe(200);
 const db=await f.database.appRuntimeSession();
 const blockingPid=(await f.db.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
 await f.db.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[key]);
 pending=caller(f,token,db)('/social/linkedin-policy/read',{});
 await waitForBlockedPolicy(f.db,blockingPid);
 await f.db.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[f.alpha.workspaceId,f.alpha.salesperson.userId]);
 await f.db.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2",[f.alpha.workspaceId,f.alpha.admin.userId]);
 await f.db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);
 expect(await pending).toMatchObject({status:200,body:{policy:null,approved:false,holds:['owner_unavailable']}});
 }finally{
 await f.db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);
 await pending?.catch(()=>undefined);
 await f.stop();
 }
});
