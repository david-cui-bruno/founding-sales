import {describe,it,expect} from 'vitest';
import {setupBookingChange} from './support/bookingChangeFixture.ts';
describe('owner-confirmed attendee booking changes',()=>{
 it('accepts a source-backed targeted cancellation without changing an unrelated booking',async()=>{
  const f=await setupBookingChange();try{
   await f.callback('external-unrelated');
   const response=await f.request('POST','/meetings/booking-change',f.command(f.payload));
   expect(response.status,JSON.stringify(response.body)).toBe(200);
   expect(response.body).toMatchObject({result:{state:'pending',dispatchStartedAt:null}});
   const id=(response.body as {result:{submissionId:string}}).result.submissionId;
   await f.run();
   expect((await f.request('GET',`/meetings/booking-change?submissionId=${id}`)).body).toMatchObject({state:'accepted',meetingId:f.meetingId,reminderState:'stopped'});
   const meetings=(await f.request('GET',`/meetings/firm?firmId=${f.firmId}`)).body as {meetings:{meetingId:string;state:string}[]};
   expect(meetings.meetings.find(m=>m.meetingId===f.meetingId)).toMatchObject({state:'cancelled'});
   expect(meetings.meetings.filter(m=>m.state==='booked')).toHaveLength(1);
   expect(f.writes).toHaveLength(1);
  }finally{await f.stop();}
 });
 it('a lost reschedule response followed by its callback can be inspected after restart without another change',async()=>{
  const f=await setupBookingChange();try{
   const offeredContext=await f.capture('Can we move to October 15, 2026 at 11 AM America/New_York?','outgoing');
   const agreement=await f.capture('Yes, that offered Thursday time works. Please move our existing appointment.');
   const payload={...f.payload,action:'reschedule',confirmation:'owner_confirmed_attendee_unconditional_exact_slot',agreement,offeredContext,agreedSlot:{startsAt:'2026-10-15T15:00:00Z',timeZone:'America/New_York'}};
   f.controls.dropResponse=true;
   const response=await f.request('POST','/meetings/booking-change',f.command(payload));expect(response.status).toBe(200);
   const id=(response.body as {result:{submissionId:string}}).result.submissionId;
   await f.run();expect((await f.request('GET',`/meetings/booking-change?submissionId=${id}`)).body).toMatchObject({state:'unknown',dispatchStartedAt:expect.any(String)});
   await f.callback(`replacement-${id}`,'BOOKING_RESCHEDULED','2026-10-15T15:00:00Z','2026-10-13T17:01:00Z','external-supported');
   expect((await f.request('POST','/meetings/booking-change/inspect',f.command({submissionId:id}))).status).toBe(200);
   await f.run();
   expect((await f.request('GET',`/meetings/booking-change?submissionId=${id}`)).body).toMatchObject({state:'accepted',meetingId:f.meetingId,reminderState:'replaced'});
   expect(f.writes).toHaveLength(1);expect(f.inspections).toHaveLength(1);
  }finally{await f.stop();}
 });
});
