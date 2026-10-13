import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createAuthFixture,type AuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {routeBookingPolicy} from '../src/routes/bookingPolicy.ts';
import type {BookingPolicyBindings,BookingPolicyView} from '../../../packages/contracts/src/bookingPolicy.ts';
import {readCurrentBookingPolicy,revalidateBookingPolicy} from '@fss/domain/meetings/bookingPolicy.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';

export function controlledBookingBindings(ownerUserId:string):BookingPolicyBindings {
  return {ownerUserId,account:{provider:'calcom',accountId:'controlled-cal-account',email:'david@owner.example',generation:1},event:{eventTypeId:73,bookingUrl:'https://cal.com/controlled-owner/demo',configurationRevision:'event-observation-1'},calendars:[{credentialId:4,externalId:'owner-business'}],source:{scopeRevision:'booking-scope-1',dataScope:'necessary_booking_context_attendee_selected_freebusy',dataHandlingVersion:'minimized-booking-v1'},sender:{channel:'email',accountId:'controlled-sender',authorityRevision:'sender-1'},model:{providerKey:'aws_bedrock',route:'us.anthropic.claude-haiku-4-5-20251001-v1:0',modelVersion:'anthropic.claude-haiku-4-5-20251001-v1:0',accountBinding:'controlled-aws-us-east-1',consentRevision:'booking-model-consent-1',purpose:'booking_interpretation',qualityReviewRevision:null,selection:'initial_haiku'},budget:{lane:'booking',timeZone:'America/New_York',dailyCeilingCents:200,monthlyCeilingCents:2500}};
}
describe('normal authenticated booking policy controls',()=>{
  let f:AuthFixture,token:string;
  beforeAll(async()=>{f=await createAuthFixture();token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;});
  afterAll(async()=>{await f.stop();});
  const request=async(method:string,body?:unknown,bearer=token)=>routeBookingPolicy({method,path:'/meetings/booking-policy',query:new URLSearchParams(),headers:{authorization:`Bearer ${bearer}`},body},{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,suppressionJournal:{append:async()=>{}},sendingEnabled:false,upgradeUrl:'https://example.test/update'});
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
    const ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'system',component:'worker'}),f.db);
    const current=await readCurrentBookingPolicy(ctx,{ownerUserId:f.alpha.admin.userId});
    expect(current.kind).toBe('available');
    if(current.kind!=='available')throw new Error('positive business policy missing');
    expect(current.snapshot).toMatchObject({policyRevision:1,businessPolicyValid:true,operationalReady:false,enabled:false});
    expect((await request('POST',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,action:'revoke',expectedRevision:1}))?.status).toBe(200);
    expect(await revalidateBookingPolicy(ctx,current.snapshot)).toEqual({kind:'unavailable',reason:'policy_revoked'});
    expect((await request('GET'))?.body).toMatchObject({revision:2,businessPolicyValid:false,setting:{status:'revoked'},enabled:false});
  });
});
