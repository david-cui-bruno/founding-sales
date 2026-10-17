import {describe,it,expect} from 'vitest';
import {setupBookingChange} from './support/bookingChangeFixture.ts';
import {calcomBookingChangeClient} from '../src/integrations/calcomBookingChangeClient.ts';
describe('scoped Cal change through ordinary caller and registered runner',()=>{
 it.each([true,false])('cancels only the exact verified external UID with one bounded POST and provider reminder evidence %s',async reminderReady=>{
  const f=await setupBookingChange();try{
   const requests:{url:string;init:RequestInit}[]=[];let reason:string|null=null;
   const booking={id:31,uid:'external-supported',eventTypeId:7,start:'2026-10-14T14:00:00Z',end:'2026-10-14T14:20:00Z',updatedAt:'2026-10-13T17:01:00Z',hosts:[{id:9,email:'owner@booking.example'}],attendees:[{email:'prospect@booking.example'}],guests:[],description:'PRIVATE NEVER RETAIN'};
   Object.assign(f.runtime,{provider:calcomBookingChangeClient({apiKey:'controlled-not-live',http:async(url,init)=>{
    requests.push({url,init});expect(new URL(url).pathname).toMatch(/^\/v2\/bookings\/external-supported(?:\/cancel)?$/);
    if(init.method==='POST'){const body=JSON.parse(String(init.body)) as Record<string,unknown>;expect(Object.keys(body)).toEqual(['cancellationReason']);reason=String(body['cancellationReason']);}
    return Response.json({status:'success',data:{...booking,status:reason===null?'accepted':'cancelled',cancellationReason:reason}});
   },readReminderTransition:async(call,bookingUid)=>reminderReady?({accountId:9,eventTypeId:7,submissionId:call.submissionId,previousUid:'external-supported',bookingUid,transition:'stopped',observedAt:'2026-10-13T17:01:00Z',reference:'controlled-provider-queue-stopped'}):null})});
   const response=await f.request('POST','/meetings/booking-change',f.command(f.payload));expect(response.status).toBe(200);const id=(response.body as {result:{submissionId:string}}).result.submissionId;
   await f.run();
   expect((await f.request('GET',`/meetings/booking-change?submissionId=${id}`)).body).toMatchObject({state:reminderReady?'accepted':'unknown',providerBookingUid:'external-supported',reminderState:reminderReady?'stopped':'unverified'});
   expect((await f.request('GET',`/meetings/firm?firmId=${f.firmId}`)).body).toMatchObject({meetings:[{meetingId:f.meetingId,state:'cancelled'}]});
   expect(requests.filter(r=>r.init.method==='POST')).toHaveLength(1);
   expect(JSON.stringify((await f.request('GET',`/meetings/booking-change?submissionId=${id}`)).body)).not.toContain('PRIVATE');
  }finally{await f.stop();}
 });
 it('reschedules a prior-offer acceptance, then reconciles a lost response using only the exact old and replacement UID reads',async()=>{
  const f=await setupBookingChange();try{
   let reason:string|null=null;let lost=true;const requests:{url:string;init:RequestInit}[]=[];
   const base={id:31,eventTypeId:7,updatedAt:'2026-10-13T17:01:00Z',hosts:[{id:9,email:'owner@booking.example'}],attendees:[{email:'prospect@booking.example'}],guests:[],description:'PRIVATE NEVER RETAIN'};
   Object.assign(f.runtime,{provider:calcomBookingChangeClient({apiKey:'controlled-not-live',http:async(url,init)=>{
    requests.push({url,init});const path=new URL(url).pathname;
    if(path==='/v2/slots')return Response.json({status:'success',data:{'2026-10-15':[{start:'2026-10-15T15:00:00Z',end:'2026-10-15T15:20:00Z'}]}});
    if(path==='/v2/calendars/busy-times')return Response.json({status:'success',data:[]});
    if(init.method==='POST'){expect(path).toBe('/v2/bookings/external-supported/reschedule');const body=JSON.parse(String(init.body)) as Record<string,unknown>;expect(body).toMatchObject({start:'2026-10-15T15:00:00.000Z',lengthInMinutes:20,rescheduleWithSameHost:true});for(const key of ['allowConflicts','allowBookingOutOfBounds','skipBookingLimits','metadata'])expect(body).not.toHaveProperty(key);reason=String(body['reschedulingReason']);if(lost){lost=false;throw new Error('lost_after_acceptance');}}
    const replacement=path==='/v2/bookings/verified-replacement'||init.method==='POST';
    return Response.json({status:'success',data:{...base,uid:replacement?'verified-replacement':'external-supported',status:replacement?'accepted':reason===null?'accepted':'cancelled',start:replacement?'2026-10-15T15:00:00Z':'2026-10-14T14:00:00Z',end:replacement?'2026-10-15T15:20:00Z':'2026-10-14T14:20:00Z',rescheduledFromUid:replacement?'external-supported':null,rescheduledToUid:replacement?null:reason===null?null:'verified-replacement',reschedulingReason:reason}},{status:init.method==='POST'?201:200});
   },readReminderTransition:async(call,bookingUid)=>({accountId:9,eventTypeId:7,submissionId:call.submissionId,previousUid:'external-supported',bookingUid,transition:'replaced',observedAt:'2026-10-13T17:01:00Z',reference:'controlled-old-reminder-removed-new-single-reminder'})})});
   const offeredContext=await f.capture('Move to Thursday October 15, 2026 at 11 AM America/New_York?','outgoing');const agreement=await f.capture('Yes, that time works. Please move our call.');
   const response=await f.request('POST','/meetings/booking-change',f.command({...f.payload,action:'reschedule',confirmation:'owner_confirmed_attendee_unconditional_exact_slot',agreement,offeredContext,agreedSlot:{startsAt:'2026-10-15T15:00:00Z',timeZone:'America/New_York'}}));expect(response.status).toBe(200);const id=(response.body as {result:{submissionId:string}}).result.submissionId;
   await f.run();expect((await f.request('GET',`/meetings/booking-change?submissionId=${id}`)).body).toMatchObject({state:'unknown'});
   await f.request('POST','/meetings/booking-change/inspect',f.command({submissionId:id}));await f.run();
   expect((await f.request('GET',`/meetings/booking-change?submissionId=${id}`)).body).toMatchObject({state:'accepted',providerBookingUid:'verified-replacement',reminderState:'replaced'});
   expect((await f.request('GET',`/meetings/firm?firmId=${f.firmId}`)).body).toMatchObject({meetings:[{meetingId:f.meetingId,state:'rescheduled',startsAt:'2026-10-15T15:00:00.000Z',endsAt:'2026-10-15T15:20:00.000Z'}]});
   expect(requests.filter(r=>r.init.method==='POST')).toHaveLength(1);
  }finally{await f.stop();}
 });
});
