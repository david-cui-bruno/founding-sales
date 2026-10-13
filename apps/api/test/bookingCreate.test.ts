import {describe,it,expect} from 'vitest';
import {calcomBookingCreateClient} from '../src/integrations/calcomBookingCreateClient.ts';
import {claimJobs} from '@fss/domain/jobs/jobStore.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {bookingCreateSourceFixture} from './support/bookingCreateFixture.ts';
import type {BookingPolicyBindings} from '@fss/contracts';
import type {BookingCreateRuntime} from '@fss/domain/meetings/bookingCreateRuntime.ts';

export async function setupBooking(){
 const f=await bookingCreateSourceFixture();
 const bindings:BookingPolicyBindings={ownerUserId:f.fixture.alpha.admin.userId,account:{provider:'calcom',accountId:'9',email:'owner@booking.example',generation:1},event:{eventTypeId:7,bookingUrl:'https://cal.com/controlled/booking',configurationRevision:'controlled-event-1'},calendars:[{credentialId:3,externalId:'controlled-calendar'}],source:{scopeRevision:'controlled-source-1',dataScope:'necessary_booking_context_attendee_selected_freebusy',dataHandlingVersion:'minimized-1'},sender:{channel:'email',accountId:f.binding,authorityRevision:'controlled-sender-1'},model:{providerKey:'aws_bedrock',route:'us.anthropic.claude-haiku-4-5-20251001-v1:0',modelVersion:'anthropic.claude-haiku-4-5-20251001-v1:0',accountBinding:'controlled-bedrock',consentRevision:'controlled-consent',purpose:'booking_interpretation',qualityReviewRevision:'controlled-quality',selection:'initial_haiku'},budget:{lane:'booking',timeZone:'America/New_York',dailyCeilingCents:200,monthlyCeilingCents:2500}};
 const runtime:BookingCreateRuntime={policy:{now:()=> '2026-10-13T17:00:00Z',readEvidence:async()=>({evidenceKind:'controlled',binding:bindings,verifiedAt:'2026-10-13T16:00:00Z',validUntil:'2026-10-14T20:00:00Z',accountAccess:true,calendarFreeBusy:true,eventSettings:true,modelConsent:true,modelAcceptance:true,senderAuthority:true,sourceAuthority:true,providerAdapter:true,releaseReady:true,funding:{status:'verified',sharedRemainingDailyCents:200,sharedRemainingMonthlyCents:2500}})},readCostContract:async()=>({accountId:'9',eventTypeId:7,operationScope:'availability_create_inspection',maximumCents:0,verifiedAt:'2026-10-13T16:00:00Z',validUntil:'2026-10-14T20:00:00Z',reference:'controlled-contractual-zero-fixture-not-Cal-pricing'}),provider:{availability:async()=>({available:true,reason:null}),create:async()=>({state:'unknown',reason:'fixture_not_created'}),inspect:async()=>({state:'unknown',reason:'not_found'})}};
 f.runtimeOptions.bookingCreate=runtime;f.runtimeOptions.bookingPolicyRuntime=runtime.policy;
 expect((await f.request('POST','/meetings/booking-policy',f.command({action:'save',expectedRevision:0,bindings}))).status).toBe(200);
 expect((await f.request('GET','/meetings/booking-policy')).body).toMatchObject({businessPolicyValid:true,readiness:{ready:true},enabled:false});
 const offeredContext=await f.capture('Can you join Wednesday October 14, 2026 at 10:00 AM America/New_York for our 20 minute call?','outgoing');
 const agreement=await f.capture('Yes, that Wednesday time works. Please book the call.');
 const payload={expectedPolicyRevision:1,attendeeRouteId:f.attendeeRouteId,agreement,offeredContext,agreedSlot:{startsAt:'2026-10-14T14:00:00Z',timeZone:'America/New_York'},confirmation:'owner_confirmed_unconditional_exact_slot'};
 const requests:{url:string;init:RequestInit}[]=[];
 const controls:{status:'accepted'|'pending';dropResponse:boolean;busy:boolean;onHttp?: (url:URL,init:RequestInit)=>Promise<void>}={status:'accepted',dropResponse:false,busy:false};
 let metadata:{callieSubmissionId:string}|null=null;
 Object.assign(runtime,{provider:calcomBookingCreateClient({apiKey:'controlled-not-a-live-credential',http:async(url,init)=>{requests.push({url,init});await controls.onHttp?.(new URL(url),init);const path=new URL(url).pathname;if(path==='/v2/slots')return Response.json({status:'success',data:{'2026-10-14':[{start:'2026-10-14T14:00:00Z',end:'2026-10-14T14:20:00Z'}]}});if(path==='/v2/calendars/busy-times')return Response.json({status:'success',data:controls.busy?[{start:'2026-10-14T14:25:00Z',end:'2026-10-14T14:26:00Z',description:'PRIVATE'}]:[]});if(init.method==='POST'){metadata=(JSON.parse(String(init.body)) as {metadata:{callieSubmissionId:string}}).metadata;if(controls.dropResponse)throw new Error('controlled_connection_lost_after_acceptance');}const booking={id:31,uid:'booking-31',status:controls.status,eventTypeId:7,start:'2026-10-14T14:00:00Z',end:'2026-10-14T14:20:00Z',updatedAt:'2026-10-13T17:00:00Z',hosts:[{id:9,email:'owner@booking.example'}],attendees:[{email:'prospect@booking.example'}],metadata,description:'PRIVATE NEVER RETAIN'};return init.method==='POST'?Response.json({status:'success',data:booking},{status:201}):Response.json({status:'success',data:[booking],pagination:{hasMore:false,nextCursor:null}});}})});
 async function replayBooking(job:Awaited<ReturnType<typeof claimJobs>>[number]){const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,bookingCreate:runtime});await registry.get('meeting.booking_create')!.handle({session:f.fixture.db,scope:workspaceScope(f.fixture.alpha.workspaceId,{kind:'system',component:'worker'}),job});}
 async function runBooking(){const job=(await claimJobs(f.fixture.db,{owner:'booking-controlled-worker',kinds:['meeting.booking_create'],limit:1,leaseSeconds:120}))[0]!;expect(job).toBeDefined();await replayBooking(job);return job;}
 return {...f,runtime,bindings,payload,requests,controls,runBooking,replayBooking};
}
describe('ordinary owner-confirmed agreed booking admission',()=>{
 it('two normal concurrent last-slot callers produce one receipt reservation and at most one POST',async()=>{
  const f=await setupBooking();try{const other=await f.capture('Yes, the offered October 14 10:00 AM New York slot works.');const secondSession=await f.fixture.database.appRuntimeSession();
  const results=await Promise.all([f.request('POST','/meetings/booking-create',f.command(f.payload)),f.request('POST','/meetings/booking-create',f.command({...f.payload,agreement:other}),secondSession)]);
  expect(results.map(r=>r.status).sort()).toEqual([200,409]);expect(results.find(r=>r.status===409)?.body).toMatchObject({reason:'slot_unavailable'});await f.runBooking();expect(f.requests.filter(r=>r.init.method==='POST')).toHaveLength(1);
  }finally{await f.fixture.stop();}
 });
 it('uncertain acceptance survives registry restart and an explicit normal inspection without another creation',async()=>{
  const f=await setupBooking();try{f.controls.dropResponse=true;const response=await f.request('POST','/meetings/booking-create',f.command(f.payload));const id=(response.body as {result:{submissionId:string}}).result.submissionId;const job=await f.runBooking();
  expect((await f.request('GET',`/meetings/booking-create?submissionId=${id}`)).body).toMatchObject({state:'unknown',providerBookingUid:null,meetingId:null,dispatchStartedAt:expect.any(String)});
  f.controls.dropResponse=false;await f.replayBooking(job);const receipt=await f.request('GET',`/meetings/booking-create?submissionId=${id}`);expect(receipt.body).toMatchObject({state:'accepted',providerBookingUid:'booking-31',meetingId:expect.any(String)});
  expect((await f.request('POST','/meetings/booking-create/inspect',f.command({submissionId:id}))).status).toBe(200);await f.replayBooking(job);expect(f.requests.filter(r=>r.init.method==='POST')).toHaveLength(1);expect(f.requests.filter(r=>r.init.method==='GET'&&new URL(r.url).pathname==='/v2/bookings')).toHaveLength(1);
  }finally{await f.fixture.stop();}
 });
 it('provider pending is distinct from acceptance and inspection can resolve it, never a new create',async()=>{
  const f=await setupBooking();try{f.controls.status='pending';const response=await f.request('POST','/meetings/booking-create',f.command(f.payload));const id=(response.body as {result:{submissionId:string}}).result.submissionId;await f.runBooking();expect((await f.request('GET',`/meetings/booking-create?submissionId=${id}`)).body).toMatchObject({state:'pending',providerBookingUid:'booking-31',meetingId:null,dispatchStartedAt:expect.any(String)});
  f.controls.status='accepted';expect((await f.request('POST','/meetings/booking-create/inspect',f.command({submissionId:id}))).status).toBe(200);await f.runBooking();expect((await f.request('GET',`/meetings/booking-create?submissionId=${id}`)).body).toMatchObject({state:'accepted',meetingId:expect.any(String)});expect(f.requests.filter(r=>r.init.method==='POST')).toHaveLength(1);
  }finally{await f.fixture.stop();}
 });
 it('a ten-minute-buffer collision fails safely without a provider write',async()=>{
  const f=await setupBooking();try{f.controls.busy=true;const response=await f.request('POST','/meetings/booking-create',f.command(f.payload));const id=(response.body as {result:{submissionId:string}}).result.submissionId;await f.runBooking();expect((await f.request('GET',`/meetings/booking-create?submissionId=${id}`)).body).toMatchObject({state:'failed',reason:'slot_unavailable',dispatchStartedAt:null});expect(f.requests.filter(r=>r.init.method==='POST')).toHaveLength(0);
  }finally{await f.fixture.stop();}
 });

 it('registered worker creates once through current scoped HTTP and reuses ordinary meeting readback',async()=>{
  const f=await setupBooking();try{const response=await f.request('POST','/meetings/booking-create',f.command(f.payload));expect(response.status,JSON.stringify(response.body)).toBe(200);const id=(response.body as {result:{submissionId:string}}).result.submissionId;
  await f.runBooking();const receipt=await f.request('GET',`/meetings/booking-create?submissionId=${id}`);expect(receipt.body,JSON.stringify(receipt.body)).toMatchObject({state:'accepted',providerBookingUid:'booking-31',meetingId:expect.any(String)});
  expect(f.requests.filter(r=>r.init.method==='POST')).toHaveLength(1);const meetings=await f.request('GET',`/meetings/firm?firmId=${f.firmId}`);expect(meetings.status).toBe(200);expect(meetings.body).toMatchObject({meetings:[{meetingId:(receipt.body as {meetingId:string}).meetingId,state:'booked',startsAt:'2026-10-14T14:00:00.000Z',endsAt:'2026-10-14T14:20:00.000Z'}]});expect(JSON.stringify(receipt.body)+JSON.stringify(meetings.body)).not.toContain('PRIVATE');
  }finally{await f.fixture.stop();}
 });
 it('prior offered exact slot acceptance yields a durable pending receipt without a provider write',async()=>{
  const f=await setupBooking();try{
   const response=await f.request('POST','/meetings/booking-create',f.command(f.payload));
   expect(response.status,JSON.stringify(response.body)).toBe(200);
   expect(response.body).toMatchObject({result:{state:'pending',providerBookingUid:null,meetingId:null,dispatchStartedAt:null}});
   const id=(response.body as {result:{submissionId:string}}).result.submissionId;
   expect((await f.request('GET',`/meetings/booking-create?submissionId=${id}`)).body).toMatchObject({state:'pending',submissionId:id});
  }finally{await f.fixture.stop();}
 });
});
