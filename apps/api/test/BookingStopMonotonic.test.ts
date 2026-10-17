import {expect,it} from 'vitest';
import {bookingStopsFixture} from './support/bookingStopsFixture.ts';
import {startIntegrationServer} from './support/integrationServer.ts';

it.each(['before_first_read','after_observed_stop','after_queue','preagreement','unrelated_organizer','unrelated_attendee'] as const)('BookingStopMonotonic retains signed booking history without resetting the agreed-call episode: %s',async mode=>{
 const f=await bookingStopsFixture(),server=await startIntegrationServer(f.fixture);try{
  f.setClock('2026-10-16T17:00:00Z');
  const stopped=!['preagreement','unrelated_organizer','unrelated_attendee'].includes(mode);
  let queuedId:string|null=null;
  if(mode==='after_queue'){
   const queued=await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.conversationId,kind:'nudge_3'}));
   expect(queued.status,JSON.stringify(queued.body)).toBe(200);
   queuedId=(queued.body as {result:{messageId:string}}).result.messageId;
  }
  const webhook=async(triggerEvent:string,createdAt:string)=>{
   const raw=JSON.stringify({triggerEvent,createdAt,payload:{uid:'monotonic-booking',startTime:'2026-10-19T15:00:00Z',endTime:'2026-10-19T15:20:00Z',organizer:{email:mode==='unrelated_organizer'?'other@booking.example':'owner@booking.example'},attendees:[{email:mode==='unrelated_attendee'?'other@prospect.example':'prospect@booking.example'}]}});
   expect((await fetch(`${server.origin}/integrations/calcom/webhook`,{method:'POST',headers:{'content-type':'application/json','x-cal-signature-256':server.calcomSign(Buffer.from(raw))},body:raw})).status).toBe(200);
  };
  await webhook('BOOKING_CREATED',mode==='preagreement'?'2026-10-12T17:00:00Z':'2026-10-14T17:00:00Z');
  if(mode==='after_observed_stop')expect((await f.request('GET',`/meetings/booking-conversation?conversationId=${f.conversationId}`)).body).toMatchObject({nudgeCount:0,nudgesStoppedAt:expect.any(String)});
  await webhook('BOOKING_CANCELLED','2026-10-15T17:00:00Z');
  if(stopped){
   expect((await f.request('GET',`/meetings/booking-conversation?conversationId=${f.conversationId}`)).body).toMatchObject({nudgeCount:0,nudgesStoppedAt:expect.any(String)});
   const rerun=await f.interpret();expect(rerun).not.toBe(f.firstInterpretation);expect(await f.admit(rerun)).toBe(f.conversationId);
   expect((await f.request('POST','/meetings/booking-conversation/event',f.command({conversationId:f.conversationId,expectedPolicyRevision:1,event:'manual_nudge'}))).status).toBe(409);
   for(const kind of ['nudge_3','nudge_7']){
    const result=await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.conversationId,kind}));
    if(queuedId!==null&&kind==='nudge_3')expect(result).toMatchObject({status:200,body:{result:{messageId:queuedId,state:'held',reason:'booking_nudges_stopped'}}});
    else expect(result).toMatchObject({status:409,body:{reason:'booking_nudges_stopped'}});
   }
   await f.run();expect(f.gmail.sends).toHaveLength(0);
   if(queuedId!==null)expect((await f.request('GET',`/meetings/booking-messages?messageId=${queuedId}`)).body).toMatchObject({state:'held'});
   expect((await f.request('GET',`/meetings/booking-conversation?conversationId=${f.conversationId}`)).body).toMatchObject({nudgeCount:0,nudgesStoppedAt:expect.any(String)});
  }else{
   expect((await f.request('GET',`/meetings/booking-conversation?conversationId=${f.conversationId}`)).body).toMatchObject({state:'awaiting_time',nudgeCount:0,nudgesStoppedAt:null});
   expect((await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.conversationId,kind:'nudge_3'}))).status).toBe(200);
   await f.run();expect(f.gmail.sends).toHaveLength(1);
  }
 }finally{await server.close();await f.stop();}
});
