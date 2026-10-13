import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {createAuthFixture,type AuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {routeBookingPolicy} from '../src/routes/bookingPolicy.ts';
import type {BookingPolicyBindings,BookingPolicyView} from '../../../packages/contracts/src/bookingPolicy.ts';
import {readCurrentBookingPolicy,revalidateBookingPolicy} from '@fss/domain/meetings/bookingPolicy.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import type {BookingPolicyRuntime,BookingPolicyRuntimeEvidence} from '@fss/domain/meetings/bookingPolicyTypes.ts';

export function controlledBookingBindings(ownerUserId:string):BookingPolicyBindings {
  return {ownerUserId,account:{provider:'calcom',accountId:'controlled-cal-account',email:'david@owner.example',generation:1},event:{eventTypeId:73,bookingUrl:'https://cal.com/controlled-owner/demo',configurationRevision:'event-observation-1'},calendars:[{credentialId:4,externalId:'owner-business'}],source:{scopeRevision:'booking-scope-1',dataScope:'necessary_booking_context_attendee_selected_freebusy',dataHandlingVersion:'minimized-booking-v1'},sender:{channel:'email',accountId:'controlled-sender',authorityRevision:'sender-1'},model:{providerKey:'aws_bedrock',route:'us.anthropic.claude-haiku-4-5-20251001-v1:0',modelVersion:'anthropic.claude-haiku-4-5-20251001-v1:0',accountBinding:'controlled-aws-us-east-1',consentRevision:'booking-model-consent-1',purpose:'booking_interpretation',qualityReviewRevision:null,selection:'initial_haiku'},budget:{lane:'booking',timeZone:'America/New_York',dailyCeilingCents:200,monthlyCeilingCents:2500}};
}
describe('normal authenticated booking policy controls',()=>{
  let f:AuthFixture,token:string;
  beforeEach(async()=>{f=await createAuthFixture();token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;});
  afterEach(async()=>{await f.stop();});
  const request=async(method:string,body?:unknown,bearer=token,runtime?:BookingPolicyRuntime,query='')=>routeBookingPolicy({method,path:'/meetings/booking-policy',query:new URLSearchParams(query),headers:{authorization:`Bearer ${bearer}`},body},{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,suppressionJournal:{append:async()=>{}},sendingEnabled:false,upgradeUrl:'https://example.test/update',...(runtime===undefined?{}:{bookingPolicyRuntime:runtime})});
  const command=(expectedRevision:number,bindings:BookingPolicyBindings)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,action:'save',expectedRevision,bindings});
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
  it('normal settings reads offer exact configured choices without turning saved or proposed scope into readiness',async()=>{
    const bindings=controlledBookingBindings(f.alpha.admin.userId);
    const runtime:BookingPolicyRuntime={now:()=> '2026-10-13T21:00:00Z',readEvidence:async()=>null,readConfiguration:async()=>[bindings]};
    const response=await request('GET',undefined,token,runtime,'view=settings');
    expect(response?.body).toMatchObject({policy:{revision:0,businessPolicyValid:false,enabled:false,readiness:{ready:false}},configuration:{choices:[{bindings}],reasons:[]}});
  });
});
