import {expect,it} from 'vitest';
import {bookingStopsFixture} from './support/bookingStopsFixture.ts';
import {startIntegrationServer} from './support/integrationServer.ts';

it.each(['two_manual','manual_auto','refusal','opt_out','reply'] as const)('reprocessing the same canonical agreed-call source preserves episode counters and stops: %s',async mode=>{
 const f=await bookingStopsFixture();try{
  const event=async(value:string)=>{const result=await f.request('POST','/meetings/booking-conversation/event',f.command({conversationId:f.conversationId,expectedPolicyRevision:1,event:value}));expect(result.status,JSON.stringify(result.body)).toBe(200);};
  if(mode==='two_manual'){await event('manual_nudge');await event('manual_nudge');}
  else if(mode==='manual_auto'){
   await event('manual_nudge');f.setClock('2026-10-20T17:00:00Z');
   const requested=await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.conversationId,kind:'nudge_7'}));expect(requested.status,JSON.stringify(requested.body)).toBe(200);await f.run();expect(f.gmail.sends).toHaveLength(1);
  }else await event(mode);
  const before=(await f.request('GET',`/meetings/booking-conversation?conversationId=${f.conversationId}`)).body;
  const secondInterpretation=await f.interpret();expect(secondInterpretation).not.toBe(f.firstInterpretation);
  const replayed=await f.admit(secondInterpretation);
  expect(replayed).toBe(f.conversationId);
  expect((await f.request('GET',`/meetings/booking-conversation?conversationId=${replayed}`)).body).toMatchObject(before as object);
  f.setClock('2026-10-20T17:00:00Z');
  expect((await f.request('POST','/meetings/booking-messages',f.command({conversationId:replayed,kind:'nudge_3'}))).status).toBe(409);
  expect((await f.fixture.db.query('SELECT id FROM booking_conversations WHERE workspace_id=$1',[f.fixture.alpha.workspaceId])).rows).toHaveLength(1);
 }finally{await f.stop();}
});

it.each(['before_eligibility','after_queue','wrong_attendee','wrong_organizer','cancelled','invalid_signature'] as const)('signed current canonical booking governs link-interest nudges without later mail: %s',async mode=>{
 const f=await bookingStopsFixture(),server=await startIntegrationServer(f.fixture);try{
  f.setClock('2026-10-16T17:00:00Z');
  let queuedId:string|null=null;
  if(mode==='after_queue'){
   const queued=await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.conversationId,kind:'nudge_3'}));expect(queued.status,JSON.stringify(queued.body)).toBe(200);queuedId=(queued.body as {result:{messageId:string}}).result.messageId;
  }
  const webhook=async(kind:string,createdAt:string)=>{
   const raw=JSON.stringify({triggerEvent:kind,createdAt,payload:{uid:'link-booking',startTime:'2026-10-19T15:00:00Z',endTime:'2026-10-19T15:20:00Z',organizer:{email:mode==='wrong_organizer'?'other@booking.example':'owner@booking.example'},attendees:[{email:mode==='wrong_attendee'?'other@prospect.example':'prospect@booking.example'}]}});
   return fetch(`${server.origin}/integrations/calcom/webhook`,{method:'POST',headers:{'content-type':'application/json','x-cal-signature-256':mode==='invalid_signature'?'invalid':server.calcomSign(Buffer.from(raw))},body:raw});
  };
  expect((await webhook('BOOKING_CREATED','2026-10-14T17:00:00Z')).status).toBe(mode==='invalid_signature'?401:200);
  if(mode==='before_eligibility'){
   expect((await webhook('BOOKING_CREATED','2026-10-14T17:00:00Z')).status).toBe(200);
   expect((await f.request('GET',`/meetings/booking-conversation?conversationId=${f.conversationId}`)).body).toMatchObject({state:'booked',nudgeCount:0,nudgesStoppedAt:expect.any(String)});
   expect((await f.request('POST','/meetings/booking-conversation/event',f.command({conversationId:f.conversationId,expectedPolicyRevision:1,event:'manual_nudge'}))).status).toBe(409);
  }
  if(mode==='cancelled')expect((await webhook('BOOKING_CANCELLED','2026-10-15T17:00:00Z')).status).toBe(200);
  if(mode==='after_queue'){
   await f.run();expect(f.gmail.sends).toHaveLength(0);
   expect((await f.request('GET',`/meetings/booking-messages?messageId=${queuedId}`)).body).toMatchObject({state:'held'});
  }else{
   const request=await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.conversationId,kind:'nudge_3'}));
   if(mode==='before_eligibility'||mode==='cancelled')expect(request).toMatchObject({status:409,body:{reason:'booking_nudges_stopped'}});
   else{expect(request.status,JSON.stringify(request.body)).toBe(200);await f.run();expect(f.gmail.sends).toHaveLength(1);}
  }
  expect((await f.request('GET',`/meetings/booking-conversation?conversationId=${f.conversationId}`)).body).toMatchObject({nudgeCount:mode==='before_eligibility'||mode==='after_queue'||mode==='cancelled'?0:1});
 }finally{await server.close();await f.stop();}
});
