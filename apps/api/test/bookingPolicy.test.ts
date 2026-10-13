import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {createAuthFixture,type AuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {authenticate,revokeDevice} from '../src/auth/sessions.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {routeBookingPolicy} from '../src/routes/bookingPolicy.ts';
import type {BookingPolicyBindings,BookingPolicyView} from '../../../packages/contracts/src/bookingPolicy.ts';
import {readCurrentBookingPolicy,revalidateBookingPolicy,readBookingBudget,lockBookingBudget} from '@fss/domain/meetings/bookingPolicy.ts';
import {recordProviderCall,readCreditSpend} from '@fss/domain/research/ledger.ts';
import {reserveAttempt} from '@fss/domain/research/reservations.ts';
import {readSettingHistory} from '@fss/domain/settings/store.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import type {BookingPolicyRuntime,BookingPolicyRuntimeEvidence} from '@fss/domain/meetings/bookingPolicyTypes.ts';

export function controlledBookingBindings(ownerUserId:string):BookingPolicyBindings {
  return {ownerUserId,account:{provider:'calcom',accountId:'controlled-cal-account',email:'david@owner.example',generation:1},event:{eventTypeId:73,bookingUrl:'https://cal.com/controlled-owner/demo',configurationRevision:'event-observation-1'},calendars:[{credentialId:4,externalId:'owner-business'}],source:{scopeRevision:'booking-scope-1',dataScope:'necessary_booking_context_attendee_selected_freebusy',dataHandlingVersion:'minimized-booking-v1'},sender:{channel:'email',accountId:'controlled-sender',authorityRevision:'sender-1'},model:{providerKey:'aws_bedrock',route:'us.anthropic.claude-haiku-4-5-20251001-v1:0',modelVersion:'anthropic.claude-haiku-4-5-20251001-v1:0',accountBinding:'controlled-aws-us-east-1',consentRevision:'booking-model-consent-1',purpose:'booking_interpretation',qualityReviewRevision:null,selection:'initial_haiku'},budget:{lane:'booking',timeZone:'America/New_York',dailyCeilingCents:200,monthlyCeilingCents:2500}};
}
describe('normal authenticated booking policy controls',()=>{
  let f:AuthFixture,token:string;
  beforeEach(async()=>{f=await createAuthFixture();token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;});
  afterEach(async()=>{await f.stop();});
  const request=async(method:string,body?:unknown,bearer=token,runtime?:BookingPolicyRuntime,query='',session:AuthFixture['db']=f.db)=>routeBookingPolicy({method,path:'/meetings/booking-policy',query:new URLSearchParams(query),headers:{authorization:`Bearer ${bearer}`},body},{session,auth:{...f.deps,db:session},supportedClientVersions:f.deps.config.supportedClientVersions,suppressionJournal:{append:async()=>{}},sendingEnabled:false,upgradeUrl:'https://example.test/update',...(runtime===undefined?{}:{bookingPolicyRuntime:runtime})});
  const command=(expectedRevision:number,bindings:BookingPolicyBindings)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,action:'save',expectedRevision,bindings});
  const waitForBlockedBudgetRead=async()=>{
    const deadline=Date.now()+5000;
    while(Date.now()<deadline){
      await f.db.query('SELECT pg_stat_clear_snapshot()');
      const blocked=await f.db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='relation' AND query LIKE '%WITH spend AS (%'");
      if(blocked.rows.length>0)return;
      await new Promise<void>(resolve=>setImmediate(resolve));
    }
    throw new Error('Real PostgreSQL budget read did not reach the controlled table lock');
  };
  const evidenceFor=(binding:BookingPolicyBindings,validUntil:string):BookingPolicyRuntimeEvidence=>({evidenceKind:'controlled',binding,verifiedAt:'2026-10-01T00:00:00Z',validUntil,accountAccess:true,calendarFreeBusy:true,eventSettings:true,modelConsent:true,modelAcceptance:true,senderAuthority:true,sourceAuthority:true,providerAdapter:true,releaseReady:true,funding:{status:'verified',sharedRemainingDailyCents:200,sharedRemainingMonthlyCents:2500}});
  it.each(['authenticated GET','current reader'] as const)('%s expires trusted evidence and funding after an observed real PostgreSQL budget wait',async(caller)=>{
    const bindings=controlledBookingBindings(f.alpha.admin.userId);bindings.model.qualityReviewRevision='controlled-quality-1';
    expect((await request('POST',command(0,bindings)))?.status).toBe(200);
    let now='2026-10-13T21:00:00Z';
    const runtime:BookingPolicyRuntime={now:()=>now,readEvidence:async()=>evidenceFor(bindings,'2026-10-13T21:00:30Z')};
    const session=await f.database.appRuntimeSession();
    const ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'system',component:'worker'}),session);
    await f.db.query('BEGIN');await f.db.query('LOCK TABLE provider_ledger IN ACCESS EXCLUSIVE MODE');
    const pending=caller==='authenticated GET'?request('GET',undefined,token,runtime,'',session):readCurrentBookingPolicy(ctx,{ownerUserId:f.alpha.admin.userId},runtime);
    try{await waitForBlockedBudgetRead();now='2026-10-13T21:01:00Z';}finally{await f.db.query('COMMIT');await pending;}
    const answer=await pending;
    if(caller==='authenticated GET')expect(answer).toMatchObject({status:200,body:{businessPolicyValid:true,enabled:false,readiness:{ready:false,reasons:['runtime_evidence_expired'],evidenceKind:'unavailable'},budget:{allowance:'unknown',remainingDailyCents:null,remainingMonthlyCents:null}}});
    else expect(answer).toMatchObject({kind:'available',snapshot:{businessPolicyValid:true,operationalReady:false,enabled:false,evidenceKind:'unavailable'}});
  });
  it('authenticated GET recomputes New York day and month allowance after an observed budget wait crosses midnight',async()=>{
    const bindings=controlledBookingBindings(f.alpha.admin.userId);bindings.model.qualityReviewRevision='controlled-quality-1';
    expect((await request('POST',command(0,bindings)))?.status).toBe(200);
    const ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'system',component:'worker'}),f.db);
    await recordProviderCall(ctx,{providerKey:'aws_bedrock.booking',at:'2026-11-01T04:00:01Z',businessTimeZone:'America/New_York',costCents:200});
    let now='2026-11-01T03:59:59Z';
    const runtime:BookingPolicyRuntime={now:()=>now,readEvidence:async()=>evidenceFor(bindings,'2026-11-02T00:00:00Z')};
    const session=await f.database.appRuntimeSession();
    await f.db.query('BEGIN');await f.db.query('LOCK TABLE provider_ledger IN ACCESS EXCLUSIVE MODE');
    const pending=request('GET',undefined,token,runtime,'',session);
    try{await waitForBlockedBudgetRead();now='2026-11-01T04:00:01Z';}finally{await f.db.query('COMMIT');await pending;}
    expect(await pending).toMatchObject({status:200,body:{businessPolicyValid:true,enabled:false,readiness:{ready:false,reasons:['booking_budget_blocked']},budget:{businessDate:'2026-11-01',calendarMonth:'2026-11',observedDailyCents:200,observedMonthlyCents:200,allowance:'blocked'}}});
  });
  it('owner saves and reads a versioned business policy without claiming readiness or Enable',async()=>{
    const bindings=controlledBookingBindings(f.alpha.admin.userId);
    expect((await request('POST',command(0,bindings)))?.status).toBe(200);
    const read=await request('GET');
    expect(read?.status).toBe(200);
    const view=read?.body as BookingPolicyView;
    expect(view).toMatchObject({revision:1,setting:{status:'saved',enabled:false,bindings},businessPolicyValid:true,enabled:false,readiness:{ready:false,evidenceKind:'unavailable'},rules:{durationMinutes:20,afterBufferMinutes:10,weekdays:[1,2,3,4,5],startHour:9,endHour:18,timeZone:'America/New_York',minimumNoticeMinutes:120,horizonDays:14,callCountCap:null},budget:{dailyCeilingCents:200,monthlyCeilingCents:2500,observedDailyCents:0,observedMonthlyCents:0,allowance:'unknown',remainingDailyCents:null,remainingMonthlyCents:null}});
    expect(view.readiness.reasons).toContain('account_access_unverified');
  });
  it('a saved current business-policy candidate is genuinely positive, then revoke invalidates the waiting revision',async()=>{
    expect((await request('POST',command(0,controlledBookingBindings(f.alpha.admin.userId))))?.status).toBe(200);
    const ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'system',component:'worker'}),f.db);
    const current=await readCurrentBookingPolicy(ctx,{ownerUserId:f.alpha.admin.userId});
    expect(current.kind).toBe('available');
    if(current.kind!=='available')throw new Error('positive business policy missing');
    expect(current.snapshot).toMatchObject({policyRevision:1,businessPolicyValid:true,operationalReady:false,enabled:false});
    expect((await request('POST',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,action:'revoke',expectedRevision:1}))?.status).toBe(200);
    expect(await revalidateBookingPolicy(ctx,current.snapshot)).toEqual({kind:'unavailable',reason:'policy_revoked'});
    expect((await request('GET'))?.body).toMatchObject({revision:2,businessPolicyValid:false,setting:{status:'revoked'},enabled:false});
  });
  it('trusted exact controlled observations can establish technical readiness, never automatic Enable or actual provider acceptance',async()=>{
    const bindings=controlledBookingBindings(f.alpha.admin.userId);bindings.model.qualityReviewRevision='controlled-quality-1';
    expect((await request('POST',command(0,bindings)))?.status).toBe(200);
    let evidence:BookingPolicyRuntimeEvidence={evidenceKind:'controlled',binding:bindings,verifiedAt:'2026-10-13T19:00:00Z',validUntil:'2026-10-14T19:00:00Z',accountAccess:true,calendarFreeBusy:true,eventSettings:true,modelConsent:true,modelAcceptance:true,senderAuthority:true,sourceAuthority:true,providerAdapter:true,releaseReady:true,funding:{status:'verified',sharedRemainingDailyCents:90,sharedRemainingMonthlyCents:800}};
    const runtime:BookingPolicyRuntime={now:()=> '2026-10-13T21:00:00Z',readEvidence:async()=>evidence};
    expect((await request('GET',undefined,token,runtime))?.body).toMatchObject({businessPolicyValid:true,enabled:false,readiness:{ready:true,evidenceKind:'controlled',reasons:[]},budget:{allowance:'available',remainingDailyCents:90,remainingMonthlyCents:800}});
    evidence={...evidence,binding:{...bindings,account:{...bindings.account,generation:2}}};
    expect((await request('GET',undefined,token,runtime))?.body).toMatchObject({businessPolicyValid:true,enabled:false,readiness:{ready:false,reasons:['runtime_binding_changed']},budget:{allowance:'unknown'}});
  });
  it('interpretation-only readiness does not inherit unknown calendars, sender, create or release readiness',async()=>{
    const bindings=controlledBookingBindings(f.alpha.admin.userId);bindings.model.qualityReviewRevision='controlled-quality-1';
    expect((await request('POST',command(0,bindings)))?.status).toBe(200);
    const runtime:BookingPolicyRuntime={now:()=> '2026-10-13T21:00:00Z',readEvidence:async()=>({evidenceKind:'controlled',binding:bindings,verifiedAt:'2026-10-13T19:00:00Z',validUntil:'2026-10-14T19:00:00Z',accountAccess:false,calendarFreeBusy:false,eventSettings:false,modelConsent:true,modelAcceptance:true,senderAuthority:false,sourceAuthority:true,providerAdapter:false,releaseReady:false,funding:{status:'verified',sharedRemainingDailyCents:200,sharedRemainingMonthlyCents:2500}})};
    const ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'system',component:'worker'}),f.db);
    expect(await readCurrentBookingPolicy(ctx,{ownerUserId:f.alpha.admin.userId,capability:'interpretation'},runtime)).toMatchObject({kind:'available',snapshot:{capability:'interpretation',businessPolicyValid:true,operationalReady:true,enabled:false,evidenceKind:'controlled'}});
    expect(await readCurrentBookingPolicy(ctx,{ownerUserId:f.alpha.admin.userId},runtime)).toMatchObject({kind:'available',snapshot:{capability:'booking',operationalReady:false,enabled:false}});
  });
  it('a family name and alleged quality revision cannot select an arbitrary model or provider route',async()=>{
    const bindings=controlledBookingBindings(f.alpha.admin.userId);
    bindings.model={...bindings.model,selection:'reviewed_candidate',qualityReviewRevision:'claimed-review',route:'arbitrary-provider-route',modelVersion:'sonnet-arbitrary-version'};
    expect((await request('POST',command(0,bindings)))?.status).toBe(400);
    expect((await request('GET'))?.body).toMatchObject({revision:0,businessPolicyValid:false,enabled:false});
  });
  it('evidence expiry during an awaited current read is checked at completion, not the earlier request time',async()=>{
    const bindings=controlledBookingBindings(f.alpha.admin.userId);bindings.model.qualityReviewRevision='controlled-quality-1';
    expect((await request('POST',command(0,bindings)))?.status).toBe(200);
    let now='2026-10-13T21:00:00Z';
    const runtime:BookingPolicyRuntime={now:()=>now,readEvidence:async()=>{await Promise.resolve();now='2026-10-13T21:01:00Z';return {evidenceKind:'controlled',binding:bindings,verifiedAt:'2026-10-13T19:00:00Z',validUntil:'2026-10-13T21:00:30Z',accountAccess:true,calendarFreeBusy:true,eventSettings:true,modelConsent:true,modelAcceptance:true,senderAuthority:true,sourceAuthority:true,providerAdapter:true,releaseReady:true,funding:{status:'verified',sharedRemainingDailyCents:200,sharedRemainingMonthlyCents:2500}};}};
    expect((await request('GET',undefined,token,runtime))?.body).toMatchObject({businessPolicyValid:true,readiness:{ready:false,reasons:['runtime_evidence_expired']},budget:{allowance:'unknown'}});
  });
  it('revocation accepted while runtime observation waits prevents returning the former current snapshot',async()=>{
    const bindings=controlledBookingBindings(f.alpha.admin.userId);
    expect((await request('POST',command(0,bindings)))?.status).toBe(200);
    const runtime:BookingPolicyRuntime={now:()=> '2026-10-13T21:00:00Z',readEvidence:async()=>{expect((await request('POST',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,action:'revoke',expectedRevision:1}))?.status).toBe(200);return null;}};
    const ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'system',component:'worker'}),f.db);
    expect(await readCurrentBookingPolicy(ctx,{ownerUserId:f.alpha.admin.userId},runtime)).toEqual({kind:'unavailable',reason:'policy_revoked'});
  });
  it('booking observer uses New York month/day and DST fold, counts open reservations, and preserves shared credit accounting',async()=>{
    const bindings=controlledBookingBindings(f.alpha.admin.userId);
    expect((await request('POST',command(0,bindings)))?.status).toBe(200);
    const ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'system',component:'worker'}),f.db);
    await recordProviderCall(ctx,{providerKey:'aws_bedrock.booking',at:'2026-11-01T03:59:59Z',businessTimeZone:'America/New_York',costCents:170});
    await recordProviderCall(ctx,{providerKey:'aws_bedrock.booking',at:'2026-11-01T05:30:00Z',businessTimeZone:'America/New_York',costCents:30});
    await recordProviderCall(ctx,{providerKey:'aws_bedrock.social_draft',at:'2026-11-01T05:30:00Z',businessTimeZone:'America/New_York',costCents:19});
    await f.db.query('BEGIN');
    try{await lockBookingBudget(ctx);await reserveAttempt(ctx,{providerKey:'aws_bedrock.booking',subjectKind:'booking_interpretation',subjectId:randomUUID(),attempt:1,at:'2026-11-01T06:30:00Z',businessTimeZone:'America/New_York',cents:20,modelName:bindings.model.modelVersion,maxInputTokens:100,maxOutputTokens:100});await f.db.query('COMMIT');}catch(error){await f.db.query('ROLLBACK');throw error;}
    const funding={status:'verified' as const,sharedRemainingDailyCents:40,sharedRemainingMonthlyCents:100};
    expect(await readBookingBudget(ctx,{at:'2026-11-01T03:59:59Z',bindings,funding})).toMatchObject({businessDate:'2026-10-31',calendarMonth:'2026-10',observedDailyCents:170,observedMonthlyCents:170,remainingDailyCents:30});
    expect(await readBookingBudget(ctx,{at:'2026-11-01T06:30:00Z',bindings,funding})).toMatchObject({businessDate:'2026-11-01',calendarMonth:'2026-11',observedDailyCents:50,observedMonthlyCents:50,remainingDailyCents:40,remainingMonthlyCents:100,allowance:'available'});
    expect(await readBookingBudget(ctx,{at:'2026-11-01T06:30:00Z',bindings})).toMatchObject({allowance:'unknown',remainingDailyCents:null,remainingMonthlyCents:null});
    expect(await readCreditSpend(ctx,{at:'2026-11-01T06:30:00Z',businessTimeZone:'America/New_York'})).toMatchObject({todayCents:69,monthToDateCents:69});
  });
  it('independent authenticated sessions serialize competing revisions and retain immutable prior policy history',async()=>{
    const bindings=controlledBookingBindings(f.alpha.admin.userId);
    expect((await request('POST',command(0,bindings)))?.status).toBe(200);
    const ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'system',component:'worker'}),f.db);
    const before=await readCurrentBookingPolicy(ctx,{ownerUserId:f.alpha.admin.userId});
    if(before.kind!=='available')throw new Error('saved current candidate missing');
    const second=await f.database.appRuntimeSession();
    const secondPost=(body:unknown)=>routeBookingPolicy({method:'POST',path:'/meetings/booking-policy',query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body},{session:second,auth:{...f.deps,db:second},supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://example.test/update',suppressionJournal:{append:async()=>{}}});
    const revised={...bindings,budget:{...bindings.budget,dailyCeilingCents:125}};
    const results=await Promise.all([request('POST',command(1,revised)),secondPost({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,action:'disable',expectedRevision:1})]);
    expect(results.map(result=>result?.status).sort()).toEqual([200,409]);
    expect((await request('GET'))?.body).toMatchObject({revision:2,enabled:false});
    expect((await revalidateBookingPolicy(ctx,before.snapshot)).kind).toBe('unavailable');
    const history=await readSettingHistory(ctx,'booking_policy');
    expect(history.map(row=>row.version)).toEqual([2,1]);
    expect(history[1]?.value).toMatchObject({status:'saved',bindings});
    expect(history[1]?.supersededAt).not.toBeNull();
  });
  it('a non-owner public caller cannot obtain the owner current authority snapshot',async()=>{
    expect((await request('POST',command(0,controlledBookingBindings(f.alpha.admin.userId))))?.status).toBe(200);
    const ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'user',userId:f.alpha.salesperson.userId,role:'salesperson'}),f.db);
    expect(await readCurrentBookingPolicy(ctx,{ownerUserId:f.alpha.admin.userId})).toEqual({kind:'unavailable',reason:'owner_authority_changed'});
  });
  it.each(['','view=settings'])('GET %s withholds all policy fields if owner membership changes during the evidence wait',async(query)=>{
    const bindings=controlledBookingBindings(f.alpha.admin.userId);
    expect((await request('POST',command(0,bindings)))?.status).toBe(200);
    await f.db.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[f.alpha.workspaceId,f.alpha.salesperson.userId]);
    const runtime:BookingPolicyRuntime={now:()=> '2026-10-13T21:00:00Z',readConfiguration:async()=>[bindings],readEvidence:async()=>{await f.db.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2",[f.alpha.workspaceId,f.alpha.admin.userId]);return null;}};
    expect(await request('GET',undefined,token,runtime,query)).toEqual({status:403,body:{error:'owner_authority_changed'}});
  });
  it.each(['','view=settings'])('GET %s withholds all policy fields if its exact authenticated session is revoked during the wait',async(query)=>{
    const bindings=controlledBookingBindings(f.alpha.admin.userId);
    expect((await request('POST',command(0,bindings)))?.status).toBe(200);
    const signedIn=await authenticate(f.deps,`Bearer ${token}`);
    if(!signedIn.authenticated)throw new Error('normal owner session missing');
    const runtime:BookingPolicyRuntime={now:()=> '2026-10-13T21:00:00Z',readConfiguration:async()=>[bindings],readEvidence:async()=>{await revokeDevice(f.deps,{workspaceId:f.alpha.workspaceId,deviceId:signedIn.principal.deviceId,reason:'signed_out'});return null;}};
    const response=await request('GET',undefined,token,runtime,query);
    expect(response?.status).toBe(401);
    expect(response?.body).not.toHaveProperty('setting');
    expect(response?.body).not.toHaveProperty('policy');
  });
  it('normal settings reads offer exact configured choices without turning saved or proposed scope into readiness',async()=>{
    const bindings=controlledBookingBindings(f.alpha.admin.userId);
    const runtime:BookingPolicyRuntime={now:()=> '2026-10-13T21:00:00Z',readEvidence:async()=>null,readConfiguration:async()=>[bindings]};
    const response=await request('GET',undefined,token,runtime,'view=settings');
    expect(response?.body).toMatchObject({policy:{revision:0,businessPolicyValid:false,enabled:false,readiness:{ready:false}},configuration:{choices:[{bindings}],reasons:[]}});
  });
});
