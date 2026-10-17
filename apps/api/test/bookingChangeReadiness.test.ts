import {describe,it,expect} from 'vitest';
import {setupBookingChange} from './support/bookingChangeFixture.ts';
import type {BookingPolicyRuntimeEvidence} from '@fss/domain/meetings/bookingPolicyTypes.ts';

async function withoutInterpretation(f:Awaited<ReturnType<typeof setupBookingChange>>){
 f.bindings.model.qualityReviewRevision=null;
 const evidence=f.runtime.policy.readEvidence;
 f.runtime.policy.readEvidence=async(context,binding)=>{const result=await evidence(context,binding);return result===null?null:{...result,modelConsent:false,modelAcceptance:false};};
 expect((await f.request('POST','/meetings/booking-policy',f.command({action:'save',expectedRevision:1,bindings:f.bindings}))).status).toBe(200);
 expect((await f.request('GET','/meetings/booking-policy')).body).toMatchObject({readiness:{ready:false,reasons:expect.arrayContaining(['model_consent_unverified','model_acceptance_unverified','model_quality_review_missing'])},enabled:false});
}
describe('owner-confirmed change uses canonical provider-action applicability',()=>{
 it.each(['cancel','reschedule'] as const)('%s does not require or grant interpretation-model readiness',async action=>{
  const f=await setupBookingChange();try{
   await withoutInterpretation(f);
   const agreement=action==='cancel'?f.payload.agreement:await f.capture('Please reschedule to October 15 at 11 AM America/New_York.');
   const payload=action==='cancel'?{...f.payload,expectedPolicyRevision:2}:{...f.payload,expectedPolicyRevision:2,action,agreement,confirmation:'owner_confirmed_attendee_unconditional_exact_slot',agreedSlot:{startsAt:'2026-10-15T15:00:00Z',timeZone:'America/New_York'}};
   const response=await f.request('POST','/meetings/booking-change',f.command(payload));expect(response.status,JSON.stringify(response.body)).toBe(200);
   const id=(response.body as {result:{submissionId:string}}).result.submissionId;
   const capabilities:string[]=[],cost=f.runtime.readCostContract;
   f.runtime.readCostContract=async snapshot=>{capabilities.push(snapshot.capability);return cost(snapshot);};
   await f.run();expect(f.writes).toHaveLength(1);
   expect((await f.request('GET',`/meetings/booking-change?submissionId=${id}`)).body).toMatchObject({state:'accepted',reminderState:action==='cancel'?'stopped':'replaced'});
   expect(capabilities.length).toBeGreaterThanOrEqual(4);expect(new Set(capabilities)).toEqual(new Set(['provider_action']));
   // The fixture composes no interpretation/model runtime. Aggregate readiness is
   // still visibly false after the provider-only action, not a model Enable grant.
   expect((await f.request('GET','/meetings/booking-policy')).body).toMatchObject({readiness:{ready:false},enabled:false});
  }finally{await f.stop();}
 });
 it.each(['accountAccess','calendarFreeBusy','eventSettings','senderAuthority','sourceAuthority','providerAdapter','releaseReady','funding_unknown','funding_held','runtime_binding','runtime_expiry'] as const)('model-only exclusion still refuses changed %s after provider availability waits',async failure=>{
  const f=await setupBookingChange();try{
   await withoutInterpretation(f);
   const agreement=await f.capture('Please reschedule to October 15 at 11 AM America/New_York.');
   const payload={...f.payload,expectedPolicyRevision:2,action:'reschedule',agreement,confirmation:'owner_confirmed_attendee_unconditional_exact_slot',agreedSlot:{startsAt:'2026-10-15T15:00:00Z',timeZone:'America/New_York'}};
   const response=await f.request('POST','/meetings/booking-change',f.command(payload));expect(response.status).toBe(200);const id=(response.body as {result:{submissionId:string}}).result.submissionId;
   f.controls.wait=async()=>{
    const previous=f.runtime.policy.readEvidence;
    f.runtime.policy.readEvidence=async(context,binding):Promise<BookingPolicyRuntimeEvidence|null>=>{
     const evidence=await previous(context,binding);if(evidence===null)return null;
     if(failure==='funding_unknown'||failure==='funding_held')return {...evidence,funding:{...evidence.funding,status:failure==='funding_held'?'held':'unknown'}};
     if(failure==='runtime_binding')return {...evidence,binding:{...evidence.binding,account:{...evidence.binding.account,generation:2}}};
     if(failure==='runtime_expiry')return {...evidence,validUntil:'2026-10-13T17:00:00Z'};
     return {...evidence,[failure]:false};
    };
   };
   await f.run();expect(f.writes).toHaveLength(0);expect(f.inspections).toHaveLength(0);
   expect((await f.request('GET',`/meetings/booking-change?submissionId=${id}`)).body).toMatchObject({state:'failed',dispatchStartedAt:null,reason:'booking_readiness_unavailable'});
  }finally{await f.stop();}
 });
});
