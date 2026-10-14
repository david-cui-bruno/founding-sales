import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {setupBookingChange} from './support/bookingChangeFixture.ts';
async function reschedule(f:Awaited<ReturnType<typeof setupBookingChange>>,startsAt='2026-10-15T15:00:00Z'){
 const agreement=await f.capture('Please move our existing appointment to Thursday October 15, 2026 at 11 AM America/New_York.');
 return {...f.payload,action:'reschedule' as const,confirmation:'owner_confirmed_attendee_unconditional_exact_slot' as const,agreement,agreedSlot:{startsAt,timeZone:'America/New_York'}};
}
const receiptId=(body:unknown)=>(body as {result:{submissionId:string}}).result.submissionId;
describe('ordinary booking change source and wait barriers',()=>{
 it.each(['wrong_uid','foreign_meeting','unsupported_route','outgoing_request','ambiguous_decision'] as const)('requires clarification/refusal for %s without a provider write',async invalid=>{
  const f=await setupBookingChange();try{
   const payload={...f.payload};
   const body:Record<string,unknown>=payload;
   if(invalid==='wrong_uid')body['expectedBookingUid']='unrelated';
   if(invalid==='foreign_meeting')body['meetingId']=randomUUID();
   if(invalid==='unsupported_route')body['attendeeRouteId']=randomUUID();
   if(invalid==='outgoing_request')body['agreement']=await f.capture('Please cancel.','outgoing');
   if(invalid==='ambiguous_decision')body['confirmation']='maybe_cancel';
   expect((await f.request('POST','/meetings/booking-change',f.command(body))).status).not.toBe(200);expect(f.writes).toHaveLength(0);
  }finally{await f.stop();}
 });
 it('default runtime stays unavailable, independent of saved policy or controlled readiness',async()=>{
  const f=await setupBookingChange();try{Object.assign(f.runtimeOptions,{bookingChange:undefined});expect((await f.request('POST','/meetings/booking-change',f.command(f.payload))).body).toMatchObject({reason:'booking_runtime_unavailable'});expect(f.writes).toHaveLength(0);}finally{await f.stop();}
 });
 it.each([null,1] as const)('unknown/nonzero cost %s fails closed before any provider dispatch',async maximum=>{
  const f=await setupBookingChange();try{f.runtime.readCostContract=async()=>maximum===null?null:{accountId:'9',eventTypeId:7,operationScope:'availability_reschedule_cancel_inspection',maximumCents:maximum,verifiedAt:'2026-10-13T16:00:00Z',validUntil:'2026-10-14T20:00:00Z',reference:'controlled-not-Cal-price'};expect((await f.request('POST','/meetings/booking-change',f.command(f.payload))).body).toMatchObject({reason:maximum===null?'unknown_cost':'unsupported_provider_cost'});expect(f.writes).toHaveLength(0);}finally{await f.stop();}
 });
 it.each([['2026-10-13T18:59:00Z','notice_too_short'],['2026-10-28T14:00:00Z','outside_booking_horizon'],['2026-10-17T14:00:00Z','outside_business_hours'],['2026-10-14T12:59:00Z','outside_business_hours'],['2026-10-14T21:41:00Z','outside_business_hours']] as const)('reschedule refuses business-slot boundary %s',async(startsAt,reason)=>{
  const f=await setupBookingChange();try{expect((await f.request('POST','/meetings/booking-change',f.command(await reschedule(f,startsAt)))).body).toMatchObject({reason});expect(f.writes).toHaveLength(0);}finally{await f.stop();}
 });
 it.each(['source_delete','source_revision','source_context','mail_disconnect','policy_revoke','account_generation','event_revision','calendar_binding','owner_role','cost_unknown','time_expiry','slot_loss','changed_meeting','optout'] as const)('rechecks %s after actual availability wait',async change=>{
  const f=await setupBookingChange();try{
   const payload=await reschedule(f),response=await f.request('POST','/meetings/booking-change',f.command(payload));expect(response.status).toBe(200);const id=receiptId(response.body);
   f.controls.wait=async()=>{
    if(change==='source_delete')expect((await f.request('POST','/crm/business/mail/delete',f.command({sourceId:payload.agreement.sourceId,expectedRevision:1}))).status).toBe(200);
    if(change==='source_revision')await f.fixture.db.query('UPDATE crm_mail_sources SET source_revision=source_revision+1 WHERE workspace_id=$1 AND source_id=$2',[f.fixture.alpha.workspaceId,payload.agreement.sourceId]);
    if(change==='source_context')expect((await f.request('POST','/crm/business/mail/associate',f.command({sourceId:payload.agreement.sourceId,expectedRevision:1,firmId:f.firmId}))).status).toBe(200);
    if(change==='mail_disconnect')await f.fixture.db.query("UPDATE mailboxes SET status='disconnected' WHERE workspace_id=$1 AND id=$2",[f.fixture.alpha.workspaceId,f.mailbox.id]);
    if(change==='policy_revoke')expect((await f.request('POST','/meetings/booking-policy',f.command({action:'revoke',expectedRevision:1}))).status).toBe(200);
    if(change==='account_generation')f.bindings.account.generation++;
    if(change==='event_revision')f.bindings.event.configurationRevision='external-changed';
    if(change==='calendar_binding')f.bindings.calendars[0]!.externalId='external-changed';
    if(change==='owner_role')await f.fixture.db.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2",[f.fixture.alpha.workspaceId,f.fixture.alpha.admin.userId]);
    if(change==='cost_unknown')f.runtime.readCostContract=async()=>null;
    if(change==='time_expiry')f.setClock('2026-10-14T20:00:00Z');
    if(change==='slot_loss')f.controls.busy=true;
    if(change==='changed_meeting')await f.callback('externally-moved','BOOKING_RESCHEDULED','2026-10-16T14:00:00Z','2026-10-13T17:00:30Z','external-supported');
    if(change==='optout'){Object.assign(f.runtimeOptions,{suppressionJournal:{append:async()=>undefined}});expect((await f.request('POST','/suppressions/record',f.command({scope:'handle',value:'prospect@booking.example',source:'prospect_opt_out',channel:'email'}))).status).toBe(200);}
   };
   await f.run();expect(f.writes).toHaveLength(0);
   if(change!=='owner_role')expect((await f.request('GET',`/meetings/booking-change?submissionId=${id}`)).body).toMatchObject({state:'failed',dispatchStartedAt:null});
  }finally{await f.stop();}
 });
 it.each(['source_delete','source_context','policy_revoke','optout'] as const)('accepted cancellation during %s redacts private provenance without pretend undo',async invalidation=>{
  const f=await setupBookingChange();try{
   const response=await f.request('POST','/meetings/booking-change',f.command(f.payload));expect(response.status).toBe(200);const id=receiptId(response.body);
   f.controls.changeWait=async()=>{
    if(invalidation==='source_delete')expect((await f.request('POST','/crm/business/mail/delete',f.command({sourceId:f.payload.agreement.sourceId,expectedRevision:1}))).status).toBe(200);
    if(invalidation==='source_context')expect((await f.request('POST','/crm/business/mail/associate',f.command({sourceId:f.payload.agreement.sourceId,expectedRevision:1,firmId:f.firmId}))).status).toBe(200);
    if(invalidation==='policy_revoke')expect((await f.request('POST','/meetings/booking-policy',f.command({action:'revoke',expectedRevision:1}))).status).toBe(200);
    if(invalidation==='optout'){Object.assign(f.runtimeOptions,{suppressionJournal:{append:async()=>undefined}});expect((await f.request('POST','/suppressions/record',f.command({scope:'handle',value:'prospect@booking.example',source:'prospect_opt_out',channel:'email'}))).status).toBe(200);}
   };
   await f.run();expect((await f.request('GET',`/meetings/booking-change?submissionId=${id}`)).body).toMatchObject({state:'accepted',providerBookingUid:'external-supported',sourceState:'redacted',dispatchStartedAt:expect.any(String)});
   // Privacy is a database storage requirement, not a side-channel business assertion.
   const retained=(await f.fixture.db.query('SELECT payload,source_fingerprint,target_fingerprint FROM booking_change_submissions WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,id])).rows[0];expect(retained).toEqual({payload:{},source_fingerprint:'0'.repeat(64),target_fingerprint:'0'.repeat(64)});
   await f.request('POST','/meetings/booking-change/inspect',f.command({submissionId:id}));await f.run();expect(f.writes).toHaveLength(1);
  }finally{await f.stop();}
 });
 it('an unknown cancellation loses source authority without replaying or pretending it failed externally',async()=>{
  const f=await setupBookingChange();try{f.controls.dropResponse=true;const response=await f.request('POST','/meetings/booking-change',f.command(f.payload));const id=receiptId(response.body);await f.run();expect((await f.request('POST','/crm/business/mail/delete',f.command({sourceId:f.payload.agreement.sourceId,expectedRevision:1}))).status).toBe(200);await f.request('POST','/meetings/booking-change/inspect',f.command({submissionId:id}));await f.run();expect((await f.request('GET',`/meetings/booking-change?submissionId=${id}`)).body).toMatchObject({state:'unknown',sourceState:'redacted',dispatchStartedAt:expect.any(String)});expect(f.writes).toHaveLength(1);expect(f.inspections).toHaveLength(0);}finally{await f.stop();}
 });
});
