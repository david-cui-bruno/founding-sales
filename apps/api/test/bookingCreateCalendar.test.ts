import {expect,it} from 'vitest';
import {setupBooking} from './bookingCreate.test.ts';

const cases=[
 {label:'inclusive two-hour notice',now:'2026-10-13T17:00:00Z',start:'2026-10-13T19:00:00Z'},
 {label:'inclusive fourteen-day horizon',now:'2026-10-13T17:00:00Z',start:'2026-10-27T17:00:00Z'},
 {label:'one minute beyond horizon',now:'2026-10-13T17:00:00Z',start:'2026-10-27T17:01:00Z',reason:'outside_booking_horizon'},
 {label:'inclusive New York opening',now:'2026-10-13T17:00:00Z',start:'2026-10-14T13:00:00Z'},
 {label:'inclusive final twenty-minute call ending at closing',now:'2026-10-13T17:00:00Z',start:'2026-10-14T21:40:00Z'},
 {label:'equivalent offset instant with Tokyo attendee zone',now:'2026-10-13T17:00:00Z',start:'2026-10-14T10:00:00-04:00',zone:'Asia/Tokyo'},
 {label:'UTC instant with New York attendee zone control',now:'2026-10-13T17:00:00Z',start:'2026-10-14T14:00:00Z'},
 {label:'opening before spring DST change',now:'2027-03-11T12:00:00Z',start:'2027-03-12T14:00:00Z'},
 {label:'before opening before spring DST change',now:'2027-03-11T12:00:00Z',start:'2027-03-12T13:59:00Z',reason:'outside_business_hours'},
 {label:'opening after spring DST change',now:'2027-03-11T12:00:00Z',start:'2027-03-15T13:00:00Z'},
 {label:'before opening after spring DST change',now:'2027-03-11T12:00:00Z',start:'2027-03-15T12:59:00Z',reason:'outside_business_hours'},
 {label:'opening before fall DST change',now:'2026-10-29T12:00:00Z',start:'2026-10-30T13:00:00Z'},
 {label:'before opening before fall DST change',now:'2026-10-29T12:00:00Z',start:'2026-10-30T12:59:00Z',reason:'outside_business_hours'},
 {label:'opening after fall DST change',now:'2026-10-29T12:00:00Z',start:'2026-11-02T14:00:00Z'},
 {label:'before opening after fall DST change',now:'2026-10-29T12:00:00Z',start:'2026-11-02T13:59:00Z',reason:'outside_business_hours'},
];
it.each(cases)('normal owner admission enforces $label',async test=>{
 const f=await setupBooking();try{
  // Only the explicit trusted policy/cost observation clock is controlled.
  // Date.now, PostgreSQL, admission jobs and original-source readers are real.
  f.runtime.policy.now=()=>test.now;
  const evidence=f.runtime.policy.readEvidence,cost=f.runtime.readCostContract;
  const verifiedAt=new Date(Date.parse(test.now)-60*60_000).toISOString(),validUntil=new Date(Date.parse(test.now)+30*86400_000).toISOString();
  f.runtime.policy.readEvidence=async(context,binding)=>{const current=await evidence(context,binding);return current===null?null:{...current,verifiedAt,validUntil};};
  f.runtime.readCostContract=async snapshot=>{const current=await cost(snapshot);return current===null?null:{...current,verifiedAt,validUntil};};
  const agreement=await f.capture(`Please book our twenty-minute call at ${test.start}, with my attendee timezone ${test.zone??'America/New_York'}.`);
  const command=f.command({expectedPolicyRevision:1,attendeeRouteId:f.attendeeRouteId,agreement,agreedSlot:{startsAt:test.start,timeZone:test.zone??'America/New_York'},confirmation:'owner_confirmed_unconditional_exact_slot'});
  const response=await f.request('POST','/meetings/booking-create',command);
  expect(response.status,JSON.stringify(response.body)).toBe(test.reason===undefined?200:409);
  if(test.reason===undefined){
   expect(response.body).toMatchObject({result:{state:'pending',dispatchStartedAt:null}});
   const submissionId=(response.body as {result:{submissionId:string}}).result.submissionId;
   const row=(await f.db.query<{starts_at:Date;payload:{agreedSlot:{startsAt:string;timeZone:string}}}>('SELECT starts_at,payload FROM booking_create_submissions WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,submissionId])).rows[0]!;
   expect(row.starts_at.toISOString()).toBe(new Date(test.start).toISOString());
   expect(row.payload.agreedSlot.timeZone).toBe(test.zone??'America/New_York');
  }else expect(response.body).toMatchObject({reason:test.reason});
  expect(f.requests).toHaveLength(0);
 }finally{await f.fixture.stop();}
});
