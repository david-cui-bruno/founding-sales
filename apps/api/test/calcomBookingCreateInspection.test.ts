import {expect,it} from 'vitest';
import {calcomBookingCreateClient} from '../src/integrations/calcomBookingCreateClient.ts';
const call={submissionId:'durable-submission',eventTypeId:7,accountId:9,organizerEmail:'owner@example.test',startsAt:'2026-10-14T14:00:00Z',attendee:{name:'Prospect',email:'prospect@example.test',timeZone:'America/New_York'}};
const booking={id:31,uid:'booking-31',status:'accepted',eventTypeId:7,start:'2026-10-14T14:00:00Z',end:'2026-10-14T14:20:00Z',updatedAt:'2026-10-13T21:00:00Z',hosts:[{id:9,email:'owner@example.test'}],attendees:[{email:'prospect@example.test'}],metadata:{callieSubmissionId:'durable-submission'}};
it('inspects an unknown dispatch by exact durable correlation across bounded pages without replaying creation',async()=>{
 const requests:{url:URL;method:string|undefined;version:string|null}[]=[];
 const client=calcomBookingCreateClient({apiKey:'controlled',http:async(url,init)=>{const parsed=new URL(url);requests.push({url:parsed,method:init.method,version:new Headers(init.headers).get('cal-api-version')});return Response.json({status:'success',data:parsed.searchParams.has('cursor')?[booking]:[],pagination:parsed.searchParams.has('cursor')?{hasMore:false,nextCursor:null}:{hasMore:true,nextCursor:'page-two'}});}});
 expect(await client.inspect(call)).toMatchObject({state:'accepted',booking:{uid:'booking-31',submissionId:'durable-submission'}});
 expect(requests.map(request=>request.method)).toEqual(['GET','GET']);
 expect(requests[0]?.version).toBe('2026-05-01');
 expect(requests[0]?.url.searchParams.get('attendeeEmail')).toBe('prospect@example.test');
});
