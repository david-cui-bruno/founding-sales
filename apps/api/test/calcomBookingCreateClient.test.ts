import {expect,it} from 'vitest';
import {calcomBookingCreateClient} from '../src/integrations/calcomBookingCreateClient.ts';

it('creates the exact agreed introduction with a stable submission correlation and returns only necessary receipt evidence',async()=>{
 const requests:{url:string;init:RequestInit}[]=[];
 const client=calcomBookingCreateClient({apiKey:'controlled-not-real',http:async(url,init)=>{requests.push({url,init});return Response.json({status:'success',data:{id:31,uid:'booking-31',status:'accepted',eventTypeId:7,start:'2026-10-14T14:00:00Z',end:'2026-10-14T14:20:00Z',updatedAt:'2026-10-13T21:00:00Z',hosts:[{id:9,email:'owner@example.test'}],attendees:[{email:'prospect@example.test'}],metadata:{callieSubmissionId:'submission-1'},description:'PRIVATE NEVER RETAIN'}} ,{status:201});}});
 const result=await client.create({submissionId:'submission-1',eventTypeId:7,accountId:9,organizerEmail:'owner@example.test',startsAt:'2026-10-14T14:00:00Z',attendee:{name:'Prospect',email:'prospect@example.test',timeZone:'America/New_York'}});
 expect(result).toEqual({state:'accepted',booking:{uid:'booking-31',id:31,eventTypeId:7,accountId:9,organizerEmail:'owner@example.test',attendeeEmail:'prospect@example.test',startsAt:'2026-10-14T14:00:00.000Z',endsAt:'2026-10-14T14:20:00.000Z',updatedAt:'2026-10-13T21:00:00.000Z',submissionId:'submission-1'}});
 expect(requests).toHaveLength(1);
 expect(requests[0]?.url).toBe('https://api.cal.com/v2/bookings');
 const headers=new Headers(requests[0]?.init.headers);
 expect(headers.get('cal-api-version')).toBe('2026-02-25');
 expect(JSON.parse(String(requests[0]?.init.body))).toEqual({start:'2026-10-14T14:00:00Z',eventTypeId:7,attendee:{name:'Prospect',email:'prospect@example.test',timeZone:'America/New_York'},metadata:{callieSubmissionId:'submission-1'},leadEnrichmentOptOut:true});
 expect(JSON.stringify(result)).not.toContain('PRIVATE');
});

it('checks exact event availability and selected-calendar freebusy including the separate ten-minute buffer',async()=>{
 const requests:URL[]=[];let busy=false;
 const client=calcomBookingCreateClient({apiKey:'controlled',http:async(url)=>{const parsed=new URL(url);requests.push(parsed);return Response.json({status:'success',data:parsed.pathname==='/v2/slots'?{'2026-10-14':[{start:'2026-10-14T14:00:00Z',end:'2026-10-14T14:20:00Z'}]}:busy?[{start:'2026-10-14T14:25:00Z',end:'2026-10-14T14:26:00Z',description:'PRIVATE'}]:[]});}});
 const input={eventTypeId:7,startsAt:'2026-10-14T14:00:00Z',calendars:[{credentialId:13,externalId:'owner@example.test'}]};
 expect(await client.availability(input)).toEqual({available:true,reason:null});
 expect(requests[1]?.searchParams.getAll('calendar')).toEqual(['13,owner@example.test']);
 busy=true;
 expect(await client.availability(input)).toEqual({available:false,reason:'slot_unavailable'});
});
