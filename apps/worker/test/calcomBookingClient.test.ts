import { describe, expect, it } from 'vitest';
import { calcomDemoClient } from '../src/calcom/bookingClient.ts';
const key=['cal','FAKE','sentinel12345'].join('_');
const data={uid:'demo_1',status:'accepted',eventTypeId:42,eventType:{id:42},hosts:[{email:'HOST@example.com'}],attendees:[{email:'pm@example.com'}],start:'2026-10-05T15:00:00Z',end:'2026-10-05T15:30:00Z',duration:30,location:'https://us05web.zoom.us/j/12345678901?pwd=private',meetingUrl:'https://zoom.us/j/12345678901'};
const read=async(value:unknown)=>await calcomDemoClient({apiKey:key,http:async()=>new Response(JSON.stringify({status:'success',data:value}))}).readBooking('demo_1',new AbortController().signal);
describe('individual Cal.com booking',()=>{
  it('uses_endpoint_specific_cal_version',async()=>{
    let request:RequestInit|undefined;let url='';
    const client=calcomDemoClient({apiKey:key,http:async(u,i)=>{url=u;request=i;return new Response(JSON.stringify({status:'success',data}));}});
    expect(await client.readBooking('demo_1',new AbortController().signal)).toMatchObject({kind:'ok',value:{hostEmail:'host@example.com',eventTypeId:42,zoomMeetingId:'12345678901'}});
    expect(url).toBe('https://api.cal.com/v2/bookings/demo_1');expect(new Headers(request?.headers).get('cal-api-version')).toBe('2026-02-25');expect(request?.redirect).toBe('error');
  });
  it('rejects_ambiguous_booking_shapes',async()=>{
    for(const change of [{eventType:{id:99}},{meetingUrl:'https://zoom.us/j/99999999999'},{hosts:[{email:'host@example.com'},{email:'other@example.com'}]},{attendees:[]},{recurringBookingUid:'r'},{seats:2},{rescheduledToUid:'next'},{duration:31}]) expect((await read({...data,...change})).kind).toBe('refused');
    expect((await read([data])).kind).toBe('refused');
    const result=await read(data);expect(JSON.stringify(result)).not.toContain('pwd=');
  });
  it('rejects path manipulation without a request and sanitizes errors',async()=>{
    let calls=0;const client=calcomDemoClient({apiKey:key,http:async()=>{calls++;throw new Error(key);}});
    expect((await client.readBooking('../me',new AbortController().signal)).kind).toBe('refused');expect(calls).toBe(0);
    const result=await client.readBooking('demo_1',new AbortController().signal);expect(result.kind).toBe('retry');expect(JSON.stringify(result)).not.toContain(key);
  });
});
