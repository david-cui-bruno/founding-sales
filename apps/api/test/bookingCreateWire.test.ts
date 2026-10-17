import {bookingCreateReceiptSchema,bookingCreatePayloadSchema,wireDrift} from '@fss/contracts';
import {z} from 'zod';
import {expect,it} from 'vitest';
import {setupBooking} from './bookingCreate.test.ts';

it('keeps real booking receipt wire exact and tolerates additive success fields without accepting caller authority',async()=>{
 const f=await setupBooking();try{
  const response=await f.request('POST','/meetings/booking-create',f.command(f.payload));
  expect(response.status).toBe(200);
  const receipt=z.object({result:bookingCreateReceiptSchema}).parse(response.body).result;
  expect(wireDrift(bookingCreateReceiptSchema,receipt)).toEqual([]);
  expect(bookingCreateReceiptSchema.safeParse({...receipt,futureReceiptMetadata:{version:2}})).toMatchObject({success:true,data:receipt});
  expect(bookingCreateReceiptSchema.safeParse({...receipt,state:'invented_acceptance'}).success).toBe(false);
  expect(bookingCreatePayloadSchema.safeParse({...f.payload,permission:true}).success).toBe(false);
  const refused=await f.request('POST','/meetings/booking-create',f.command({...f.payload,permission:true}));
  expect(refused.status).toBe(400);
 }finally{await f.fixture.stop();}
});
