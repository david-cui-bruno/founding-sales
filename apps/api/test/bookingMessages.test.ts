import {describe,it,expect} from 'vitest';
import {bookingCreateSourceFixture} from './support/bookingCreateFixture.ts';

describe('standing booking messages through the ordinary product boundary',()=>{
 it('does not mistake canonical capture for standing sender permission',async()=>{
  const f=await bookingCreateSourceFixture();
  try{
   const source=await f.capture('Can we arrange a call?');
   expect((await f.request('POST','/crm/business/mail/read',source)).status).toBe(200);
   const response=await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.firmId,kind:'approved_link'}));
   expect(response.status).toBe(409);
   expect(response.body).toMatchObject({reason:'booking_sender_unavailable'});
  }finally{await f.fixture.stop();}
 });
});
