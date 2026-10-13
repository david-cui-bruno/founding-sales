import {seedFirm,seedContact} from './support/crmSeed.ts';
import type {SessionQueryable,QueryResultRowLike} from '@fss/domain/db/queryable.ts';
import {describe,it,expect} from 'vitest';
import {calcomBookingCreateClient} from '../src/integrations/calcomBookingCreateClient.ts';
import {claimJobs} from '@fss/domain/jobs/jobStore.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {startIntegrationServer} from './support/integrationServer.ts';
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
 it.each(['unchanged','firm','contact','address','version'] as const)('exact durable Route hint %s is rechecked without appending a changed firm lock',async change=>{
  const f=await setupBooking();try{const otherFirm=await seedFirm(f.fixture,{name:'Controlled moved Route',assignedUserId:f.fixture.alpha.admin.userId});const otherContact=await seedContact(f.fixture,{firmId:otherFirm,fullName:'Changed prospect'});const sameFirmContact=await seedContact(f.fixture,{firmId:f.firmId,fullName:'Same firm changed prospect'});
   let hinted=false;const firmLocks:string[]=[];
   const observed:SessionQueryable={query:async<Row extends QueryResultRowLike>(text:string,values?:readonly unknown[])=>{const result=await f.db.query<Row>(text,values);
    if(text.includes('FROM firms')&&(text.includes('FOR UPDATE')||text.includes('FOR SHARE')))firmLocks.push(String(values?.[1]));
    if(!hinted&&text==='SELECT firm_id,contact_id,address,version FROM email_addresses WHERE workspace_id=$1 AND id=$2'){hinted=true;
     if(change==='firm')await f.fixture.db.query('UPDATE email_addresses SET firm_id=$2,contact_id=$3,version=version+1 WHERE id=$1',[f.attendeeRouteId,otherFirm,otherContact]);
     if(change==='contact')await f.fixture.db.query('UPDATE email_addresses SET contact_id=$2 WHERE id=$1',[f.attendeeRouteId,sameFirmContact]);
     if(change==='address')await f.fixture.db.query("UPDATE email_addresses SET address='changed@booking.example' WHERE id=$1",[f.attendeeRouteId]);
     if(change==='version')await f.fixture.db.query('UPDATE email_addresses SET version=version+1 WHERE id=$1',[f.attendeeRouteId]);
    }return result;}};
   const response=await f.request('POST','/meetings/booking-create',f.command(f.payload),observed);expect(hinted).toBe(true);expect(response.status).toBe(change==='unchanged'?200:409);
   if(change!=='unchanged')expect(response.body).toMatchObject({reason:'attendee_authority_changed'});expect(firmLocks).toContain(f.firmId);expect(firmLocks).not.toContain(otherFirm);expect(f.requests).toHaveLength(0);
  }finally{await f.fixture.stop();}
 });
 it('normal contact update and booking admission serialize firm-before-contact with an observed real lock wait',async()=>{
  const f=await setupBooking();const updates=await f.fixture.database.appRuntimeSession();
  const gate=()=>{let resolve=()=>{};const wait=new Promise<void>(r=>{resolve=r;});return {wait,resolve};};
  const firstLock=gate(),resumeBooking=gate(),resumeUpdate=gate();let bookingPaused=false,updateFirmLocked=false;
  const booking:SessionQueryable={query:async<Row extends QueryResultRowLike>(text:string,values?:readonly unknown[])=>{const result=await f.db.query<Row>(text,values);if(!bookingPaused&&(text.includes('FOR SHARE OF e,c')||(text.includes('FROM firms')&&text.includes('FOR UPDATE')))){bookingPaused=true;firstLock.resolve();await resumeBooking.wait;}return result;}};
  const update:SessionQueryable={query:async<Row extends QueryResultRowLike>(text:string,values?:readonly unknown[])=>{const result=await updates.query<Row>(text,values);if(text.includes('FROM firms')&&text.includes('FOR UPDATE')){updateFirmLocked=true;await resumeUpdate.wait;}return result;}};
  try{await f.fixture.db.query('DELETE FROM crm_mail_source_contexts WHERE workspace_id=$1 AND source_id=ANY($2::uuid[])',[f.fixture.alpha.workspaceId,[f.payload.agreement.sourceId,f.payload.offeredContext.sourceId]]);
   const bookingPid=(await f.db.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
   const updatePid=(await updates.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
   const creating=f.request('POST','/meetings/booking-create',f.command(f.payload),booking);await firstLock.wait;
   const changing=f.request('POST','/contacts/update',f.command({contactId:f.contactId,patch:{title:'Normal concurrent correction'}}),update);
   let observed=false;
   for(let attempt=0;attempt<400;attempt++){if(updateFirmLocked){resumeUpdate.resolve();}const waits=await f.fixture.db.query<{pid:number}>('SELECT pid FROM pg_stat_activity WHERE pid=$1 AND $2::int=ANY(pg_blocking_pids(pid))',[updatePid,bookingPid]);if(waits.rows.length){observed=true;break;}await new Promise(resolve=>setTimeout(resolve,5));}
   expect(observed,'normal contact command must actually wait on booking-held firm or contact').toBe(true);resumeUpdate.resolve();resumeBooking.resolve();
   const results=await Promise.all([creating,changing]);expect(results.map(r=>r.status)).toEqual([200,200]);expect(f.requests).toHaveLength(0);
  }finally{resumeBooking.resolve();resumeUpdate.resolve();await f.fixture.stop();}
 });
 it.each(['source_notice','receipt_notice','receipt_cost','receipt_runtime','receipt_lease','receipt_cost_after_read','receipt_runtime_after_cost','receipt_scope_after_cost','initial_notice','initial_cost','initial_runtime','initial_lease'] as const)('final dispatch refuses %s expiry across an observed PostgreSQL lock wait',async change=>{
  const f=await setupBooking();const blocker=await f.fixture.database.appRuntimeSession();let locked=false;
  try{const response=await f.request('POST','/meetings/booking-create',f.command(f.payload));expect(response.status).toBe(200);const id=(response.body as {result:{submissionId:string}}).result.submissionId;
   const blockerPid=(await blocker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
   let now='2026-10-13T17:00:00Z';f.runtime.policy.now=()=>now;
   if(change.startsWith('receipt_cost')||change==='initial_cost'){const read=f.runtime.readCostContract;f.runtime.readCostContract=async snapshot=>{const contract=await read(snapshot);return contract===null?null:{...contract,validUntil:'2026-10-14T10:00:00Z'};};}
   if(change.startsWith('receipt_runtime')||change==='initial_runtime'){const read=f.runtime.policy.readEvidence;f.runtime.policy.readEvidence=async(context,binding)=>{const evidence=await read(context,binding);return evidence===null?null:{...evidence,validUntil:'2026-10-14T11:00:00Z'};};}
   const job=(await claimJobs(f.fixture.db,{owner:'final-wait-worker',kinds:['meeting.booking_create'],limit:1,leaseSeconds:120}))[0]!;
   if(change.endsWith('_lease'))await f.fixture.db.query("UPDATE jobs SET lease_expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1",[job.id]);
   let accountAccess=true;const evidenceRead=f.runtime.policy.readEvidence;f.runtime.policy.readEvidence=async(context,binding)=>{const evidence=await evidenceRead(context,binding);return evidence===null?null:{...evidence,accountAccess};};
   let availabilityRead=false,postAvailabilityCostReads=0;
   if(change.endsWith('_after_read')||change.endsWith('_after_cost')){const read=f.runtime.readCostContract;f.runtime.readCostContract=async snapshot=>{const contract=await read(snapshot);if(availabilityRead&&++postAvailabilityCostReads===2){await Promise.resolve();if(change==='receipt_scope_after_cost')accountAccess=false;else now=change==='receipt_cost_after_read'?'2026-10-14T10:01:00Z':'2026-10-14T11:01:00Z';}return contract;};}
   if(change.startsWith('initial_')){await blocker.query('BEGIN');locked=true;await blocker.query('SELECT source_id FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=$2 FOR UPDATE',[f.fixture.alpha.workspaceId,f.payload.agreement.sourceId]);}
   f.controls.onHttp=async url=>{if(url.pathname!=='/v2/calendars/busy-times'||change.startsWith('initial_'))return;availabilityRead=true;await blocker.query('BEGIN');locked=true;
    if(change==='source_notice')await blocker.query('SELECT source_id FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=$2 FOR UPDATE',[f.fixture.alpha.workspaceId,f.payload.agreement.sourceId]);
    else await blocker.query('SELECT id FROM booking_create_submissions WHERE id=$1 FOR UPDATE',[id]);
   };
   const running=f.replayBooking(job);let observed=false;
   for(let attempt=0;attempt<400;attempt++){const waits=await blocker.query('SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))',[blockerPid]);if(waits.rows.length){observed=true;break;}await new Promise(resolve=>setTimeout(resolve,5));}
   expect(observed,'registered worker must actually wait on the real held source/receipt row').toBe(true);
   if(change.endsWith('_lease')){while((await blocker.query('SELECT id FROM jobs WHERE id=$1 AND lease_expires_at<=clock_timestamp()',[job.id])).rows.length===0)await new Promise(resolve=>setTimeout(resolve,10));}
   else if(!change.endsWith('_after_read')&&!change.endsWith('_after_cost'))now=change.endsWith('notice')?'2026-10-14T12:01:00Z':change.endsWith('_cost')?'2026-10-14T10:01:00Z':'2026-10-14T11:01:00Z';
   await blocker.query('COMMIT');locked=false;await running;
   expect(f.requests.filter(r=>r.init.method==='POST')).toHaveLength(0);if(change.startsWith('initial_'))expect(f.requests).toHaveLength(0);
   expect((await f.fixture.db.query('SELECT state,reason,dispatch_started_at FROM booking_create_submissions WHERE id=$1',[id])).rows[0]).toEqual({state:change.endsWith('_lease')?'pending':'failed',reason:change.endsWith('_lease')?null:change.endsWith('notice')?'notice_too_short':change.startsWith('receipt_cost')||change==='initial_cost'?'unknown_cost':'booking_readiness_unavailable',dispatch_started_at:null});
  }finally{if(locked)await blocker.query('ROLLBACK');await f.fixture.stop();}
 });
 it.each(['physical_source_delete','source_context_association'] as const)('the actual %s trigger closure removes private provenance and stops creation',async change=>{
  const f=await setupBooking();try{const response=await f.request('POST','/meetings/booking-create',f.command(f.payload));const id=(response.body as {result:{submissionId:string}}).result.submissionId;
   if(change==='physical_source_delete')await f.fixture.db.query('DELETE FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=$2',[f.fixture.alpha.workspaceId,f.payload.agreement.sourceId]);else expect((await f.request('POST','/crm/business/mail/associate',f.command({sourceId:f.payload.agreement.sourceId,expectedRevision:1,firmId:f.firmId}))).status).toBe(200);
   expect((await f.fixture.db.query('SELECT payload,provenance_state,source_fingerprint,state FROM booking_create_submissions WHERE id=$1',[id])).rows[0]).toEqual({payload:{},provenance_state:'redacted',source_fingerprint:'0'.repeat(64),state:'failed'});await f.runBooking();expect(f.requests).toHaveLength(0);
  }finally{await f.fixture.stop();}
 });

 it.each([['2026-10-13T18:59:00Z','notice_too_short'],['2026-10-28T14:00:00Z','outside_booking_horizon'],['2026-10-17T14:00:00Z','outside_business_hours'],['2026-10-14T12:59:00Z','outside_business_hours'],['2026-10-14T21:41:00Z','outside_business_hours']] as const)('ordinary owner command refuses invalid business slot %s',async(startsAt,reason)=>{
  const f=await setupBooking();try{expect((await f.request('POST','/meetings/booking-create',f.command({...f.payload,agreedSlot:{startsAt,timeZone:'America/New_York'}}))).body).toMatchObject({reason});expect(f.requests).toHaveLength(0);}finally{await f.fixture.stop();}
 });
 it('the default live composition is unavailable and cannot authorize creation',async()=>{
  const f=await setupBooking();try{delete f.runtimeOptions.bookingCreate;expect((await f.request('POST','/meetings/booking-create',f.command(f.payload))).body).toMatchObject({reason:'booking_runtime_unavailable'});expect(f.requests).toHaveLength(0);}finally{await f.fixture.stop();}
 });
 it('normal directly named agreements can reserve more than four calls without an invented call-count cap',async()=>{
  const f=await setupBooking();try{for(let index=0;index<5;index++){const startsAt=new Date(Date.parse('2026-10-14T14:00:00Z')+index*30*60_000).toISOString();const local=index%2===0?`${10+Math.floor(index/2)}:00`:`${10+Math.floor(index/2)}:30`;const agreement=await f.capture(`Yes, please book Wednesday October 14, 2026 at ${local} ${index<4?'AM':'PM'} America/New_York for our 20 minute call.`);
  expect((await f.request('POST','/meetings/booking-create',f.command({expectedPolicyRevision:1,attendeeRouteId:f.attendeeRouteId,agreement,agreedSlot:{startsAt,timeZone:'America/New_York'},confirmation:'owner_confirmed_unconditional_exact_slot'}))).status).toBe(200);}
  expect((await f.fixture.db.query('SELECT id FROM booking_create_submissions WHERE workspace_id=$1',[f.fixture.alpha.workspaceId])).rows).toHaveLength(5);expect(f.requests).toHaveLength(0);
  }finally{await f.fixture.stop();}
 });

 it.each(['availability','accepted_write','unknown_write'] as const)('normal source deletion during %s erases provenance without replay or pretend cancellation',async phase=>{
  const f=await setupBooking();try{const response=await f.request('POST','/meetings/booking-create',f.command(f.payload));const id=(response.body as {result:{submissionId:string}}).result.submissionId;
   f.controls.dropResponse=phase==='unknown_write';let deleted=false;
   f.controls.onHttp=async(url,init)=>{if(deleted||!(phase==='availability'?url.pathname==='/v2/calendars/busy-times':init.method==='POST'))return;deleted=true;expect((await f.request('POST','/crm/business/mail/delete',f.command({sourceId:f.payload.agreement.sourceId,expectedRevision:1}))).status).toBe(200);};
   const job=await f.runBooking();const state=phase==='availability'?'failed':phase==='accepted_write'?'accepted':'unknown';const receipt=await f.request('GET',`/meetings/booking-create?submissionId=${id}`);expect(receipt.body).toMatchObject({state,sourceState:'redacted',reason:'source_deleted',dispatchStartedAt:phase==='availability'?null:expect.any(String)});
   const retained=(await f.fixture.db.query<{payload:unknown;source_fingerprint:string}>('SELECT payload,source_fingerprint FROM booking_create_submissions WHERE id=$1',[id])).rows[0];expect(retained).toEqual({payload:{},source_fingerprint:'0'.repeat(64)});const serialized=JSON.stringify(retained);for(const secret of [f.payload.agreement.sourceId,f.payload.agreement.contentHash,f.payload.offeredContext.sourceId,f.payload.offeredContext.contentHash,f.attendeeRouteId])expect(serialized).not.toContain(secret);
   await f.replayBooking(job);expect(f.requests.filter(r=>r.init.method==='POST')).toHaveLength(phase==='availability'?0:1);if(phase==='accepted_write')expect(receipt.body).toMatchObject({providerBookingUid:'booking-31',meetingId:expect.any(String)});
  }finally{await f.fixture.stop();}
 });

 it('the normal runner and signed duplicate callbacks preserve Today, human attendance and corrections',async()=>{
  const f=await setupBooking();const server=await startIntegrationServer(f.fixture);try{
   expect((await f.request('POST','/settings/update',f.command({settingKey:'calendar_integration',value:{integration:'calcom'}}))).status).toBe(200);
   const response=await f.request('POST','/meetings/booking-create',f.command(f.payload));expect(response.status).toBe(200);const id=(response.body as {result:{submissionId:string}}).result.submissionId;
   const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,bookingCreate:f.runtime});const run=await runOnce(f.fixture.db,{registry,owner:'normal-controlled-runner',limit:20,classes:['urgent']});expect(run.failed).toBe(0);
   const receipt=await f.request('GET',`/meetings/booking-create?submissionId=${id}`);expect(receipt.body).toMatchObject({state:'accepted',meetingId:expect.any(String)});const meetingId=(receipt.body as {meetingId:string}).meetingId;
   const today=await f.request('GET','/today/actions/v2');expect(today.status).toBe(200);expect(JSON.stringify(today.body)).toContain(meetingId);
   const callback=async(triggerEvent:string,startTime:string,endTime:string,createdAt:string)=>{const raw=JSON.stringify({triggerEvent,createdAt,payload:{uid:'booking-31',startTime,endTime,organizer:{email:'owner@booking.example'},attendees:[{email:'prospect@booking.example'}]}});const response=await fetch(`${server.origin}/integrations/calcom/webhook`,{method:'POST',headers:{'content-type':'application/json','x-cal-signature-256':server.calcomSign(Buffer.from(raw))},body:raw});expect(response.status).toBe(200);return raw;};
   const now=Date.now(),start=new Date(now-3600_000).toISOString(),end=new Date(now-2400_000).toISOString();await callback('BOOKING_RESCHEDULED',start,end,new Date(now+1000).toISOString());
   expect((await f.request('POST','/meetings/attendance',f.command({meetingId,attendance:'attended'}))).status).toBe(200);
   expect((await f.request('POST','/meetings/notes',f.command({meetingId,expectedRevision:0,debrief:'Human correction retained',speakerMappings:[],itemOverrides:[],sufficient:true}))).status).toBe(200);
   await callback('BOOKING_CREATED',f.payload.agreedSlot.startsAt,'2026-10-14T14:20:00Z','2026-10-13T17:00:00Z');await callback('BOOKING_CREATED',f.payload.agreedSlot.startsAt,'2026-10-14T14:20:00Z','2026-10-13T17:00:00Z');
   expect((await f.request('GET',`/meetings/outcomes?meetingId=${meetingId}`)).body).toMatchObject({attendance:'attended',notes:{revision:1,debrief:'Human correction retained'}});
   expect((await f.fixture.db.query('SELECT id FROM meetings WHERE workspace_id=$1',[f.fixture.alpha.workspaceId])).rows).toHaveLength(1);expect(f.requests.filter(r=>r.init.method==='POST')).toHaveLength(1);
   const agreement=await f.capture('Yes, please book Wednesday October 14, 2026 at 10:00 AM America/New_York for a 20 minute call.');
   expect((await f.request('POST','/meetings/booking-create',f.command({...f.payload,agreement}))).status).toBe(200);
  }finally{await server.close();await f.fixture.stop();}
 });

 it('ordinary source deletion redacts private provenance while retaining a safe durable no-write receipt',async()=>{
  const f=await setupBooking();try{const response=await f.request('POST','/meetings/booking-create',f.command(f.payload));expect(response.status).toBe(200);const id=(response.body as {result:{submissionId:string}}).result.submissionId;
  expect((await f.request('POST','/crm/business/mail/delete',f.command({sourceId:f.payload.agreement.sourceId,expectedRevision:1}))).status).toBe(200);
  const row=(await f.fixture.db.query<{payload:unknown;state:string}>('SELECT payload,state FROM booking_create_submissions WHERE id=$1',[id])).rows[0];expect(row).toEqual({payload:{},state:'failed'});await f.runBooking();expect(f.requests).toHaveLength(0);expect((await f.request('GET',`/meetings/booking-create?submissionId=${id}`)).body).toMatchObject({state:'failed',reason:'source_deleted'});
  }finally{await f.fixture.stop();}
 });

 it.each(['source_revision','mailbox_disconnect','owner_role','policy_revoke','account_generation','event_configuration','calendar_binding','cost_unknown'] as const)('refuses changed %s after availability wait before any provider write',async change=>{
  const f=await setupBooking();try{const response=await f.request('POST','/meetings/booking-create',f.command(f.payload));expect(response.status).toBe(200);const id=(response.body as {result:{submissionId:string}}).result.submissionId;
  f.controls.onHttp=async url=>{if(url.pathname!=='/v2/calendars/busy-times')return;
   if(change==='source_revision')await f.fixture.db.query('UPDATE crm_mail_sources SET source_revision=source_revision+1 WHERE workspace_id=$1 AND source_id=$2',[f.fixture.alpha.workspaceId,f.payload.agreement.sourceId]);
   if(change==='mailbox_disconnect')await f.fixture.db.query("UPDATE mailboxes SET status='disconnected' WHERE workspace_id=$1 AND id=$2",[f.fixture.alpha.workspaceId,f.mailbox.id]);
   if(change==='owner_role'){await f.fixture.db.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[f.fixture.alpha.workspaceId,f.fixture.alpha.salesperson.userId]);await f.fixture.db.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2",[f.fixture.alpha.workspaceId,f.fixture.alpha.admin.userId]);}
   if(change==='policy_revoke')expect((await f.request('POST','/meetings/booking-policy',f.command({action:'revoke',expectedRevision:1}))).status).toBe(200);
   if(change==='account_generation')f.bindings.account.generation++;
   if(change==='event_configuration')f.bindings.event.configurationRevision='changed-external-event';
   if(change==='calendar_binding')f.bindings.calendars[0]!.externalId='changed-external-calendar';
   if(change==='cost_unknown')f.runtime.readCostContract=async()=>null;
  };
  await f.runBooking();expect(f.requests.filter(r=>r.init.method==='POST')).toHaveLength(0);
  const row=(await f.fixture.db.query<{state:string;dispatch_started_at:Date|null}>('SELECT state,dispatch_started_at FROM booking_create_submissions WHERE id=$1',[id])).rows[0];expect(row).toMatchObject({state:'failed',dispatch_started_at:null});
  }finally{await f.fixture.stop();}
 });
 it.each([null,1] as const)('unknown or unsupported nonzero contractual cost %s is not guessed free or called budget exhaustion',async maximum=>{
  const f=await setupBooking();try{f.runtime.readCostContract=async()=>maximum===null?null:{accountId:'9',eventTypeId:7,operationScope:'availability_create_inspection',maximumCents:maximum,verifiedAt:'2026-10-13T16:00:00Z',validUntil:'2026-10-14T20:00:00Z',reference:'controlled-cost'};
  expect((await f.request('POST','/meetings/booking-create',f.command(f.payload))).body).toMatchObject({reason:maximum===null?'unknown_cost':'unsupported_provider_cost'});expect(f.requests).toHaveLength(0);
  }finally{await f.fixture.stop();}
 });

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
