import {expect,it} from 'vitest';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import type {BookingChangeRuntime} from '@fss/domain/meetings/bookingChangeProvider.ts';
import {claimJobs} from '@fss/domain/jobs/jobStore.ts';
import {workspaceScope,repositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {readBookingConversation} from '@fss/domain/meetings/bookingConversation.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {startIntegrationServer} from './support/integrationServer.ts';
import {setupBookingMessageSender} from './support/bookingMessageFixture.ts';

import {captureAt,setupConversation} from './support/bookingConversationFixture.ts';
it('accepted prior offer books through standing origin and retains an actionable sales handoff without human confirmation',async()=>{
 const f=await setupConversation();
 const {registry,conversationId,startsAt,providerCalls}=f;
 try{
  await runOnce(f.db,{registry,owner:'conversation-lifecycle',limit:20});
  await runOnce(f.db,{registry,owner:'conversation-create',limit:20});
  const read=await f.request('GET',`/meetings/booking-conversation?conversationId=${conversationId}`);
  expect(read.status).toBe(200);
  expect(read.body).toMatchObject({conversationId,state:'booked',origin:'standing_policy',enabled:false,booking:{state:'accepted',providerBookingUid:'standing-booking',meetingId:expect.any(String)},handoff:{action:'answer_sales_question',evidence:{quote:'What does Callie cost?'}}});
  expect(providerCalls[0]).toMatchObject({startsAt});
  const meetingId=(read.body as {booking:{meetingId:string}}).booking.meetingId;
  expect(JSON.stringify((await f.request('GET','/today/actions/v2')).body)).toContain(meetingId);
  expect(providerCalls).toHaveLength(1);
  expect(JSON.stringify(read.body)).not.toContain('owner_confirmed_unconditional_exact_slot');
 }finally{await f.fixture.stop();}
});

it('a later canonical reply stops the pending old conversation without creating an appointment',async()=>{
 const f=await setupConversation();try{
  await captureAt(f,'Wait, I need to check with my colleague.',new Date().toISOString());
  await runOnce(f.db,{registry:f.registry,owner:'reply-stopped-lifecycle',limit:20});
  await runOnce(f.db,{registry:f.registry,owner:'reply-stopped-create',limit:20});
  const read=await f.request('GET',`/meetings/booking-conversation?conversationId=${f.conversationId}`);
  expect(read.body).toMatchObject({state:'handoff',reason:'new_reply_requires_interpretation',nudgesStoppedAt:expect.any(String),lastReplyAt:expect.any(String),booking:null});
  expect(f.providerCalls).toHaveLength(0);
 }finally{await f.fixture.stop();}
});

it('a stolen lifecycle lease cannot admit a write and valid repeated execution creates only once',async()=>{
 const f=await setupConversation();try{
  const job=(await claimJobs(f.fixture.db,{owner:'lease-proof',kinds:['meeting.booking_conversation'],limit:1,leaseSeconds:120}))[0]!;
  const handler=f.registry.get('meeting.booking_conversation')!;
  const input={session:f.fixture.db,scope:workspaceScope(f.fixture.alpha.workspaceId,{kind:'system' as const,component:'worker' as const}),job};
  await expect(handler.handle({...input,job:{...job,fencingToken:String(BigInt(job.fencingToken)+1n)}})).rejects.toThrow('booking_conversation_lease_lost');
  expect((await f.fixture.db.query('SELECT id FROM booking_create_submissions WHERE workspace_id=$1',[f.fixture.alpha.workspaceId])).rows).toHaveLength(0);
  const observe=f.runtime.policy.readEvidence;let stolen=false;
  f.runtime.policy.readEvidence=async(...args)=>{
   if(!stolen){stolen=true;await f.fixture.db.query('UPDATE jobs SET lease_owner=$3 WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,job.id,'other-worker']);}
   return observe(...args);
  };
  await expect(handler.handle(input)).rejects.toThrow('booking_conversation_lease_lost');
  expect(stolen).toBe(true);expect((await f.fixture.db.query('SELECT id FROM booking_create_submissions WHERE workspace_id=$1',[f.fixture.alpha.workspaceId])).rows).toHaveLength(0);
  f.runtime.policy.readEvidence=observe;
  await handler.handle(input);await handler.handle(input);
  expect((await f.fixture.db.query('SELECT id FROM booking_create_submissions WHERE workspace_id=$1',[f.fixture.alpha.workspaceId])).rows).toHaveLength(1);
  await runOnce(f.db,{registry:f.registry,owner:'lease-valid-create',limit:20});await runOnce(f.db,{registry:f.registry,owner:'lease-valid-restart',limit:20});
  expect(f.providerCalls).toHaveLength(1);
 }finally{await f.fixture.stop();}
});

it('source deletion during availability erases private provenance and command replay reads current stale state',async()=>{
 const f=await setupConversation();try{
  await runOnce(f.db,{registry:f.registry,owner:'privacy-lifecycle',limit:20});
  f.runtime.provider.availability=async()=>{
   expect((await f.request('POST','/crm/business/mail/delete',f.command({sourceId:f.source.sourceId,expectedRevision:1}))).status).toBe(200);
   return {available:true,reason:null};
  };
  await runOnce(f.db,{registry:f.registry,owner:'privacy-calendar-wait',limit:20});
  const replay=await f.request('POST','/meetings/booking-conversation',f.admissionCommand);
  expect(replay.body).toMatchObject({replayed:true,result:{state:'stale',outcome:null,handoff:null,booking:{state:'failed',sourceState:'redacted'}}});
  expect(f.providerCalls).toHaveLength(0);
  const retained=(await f.fixture.db.query<{source_refs:unknown;source_fingerprint:string;source_conversation_id:string|null}>('SELECT source_refs,source_fingerprint,source_conversation_id FROM booking_conversations WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,f.conversationId])).rows[0];
  expect(retained).toEqual({source_refs:[],source_fingerprint:'0'.repeat(64),source_conversation_id:null});
  expect(JSON.stringify(replay.body)).not.toContain('What does Callie cost?');
 }finally{await f.fixture.stop();}
});

it.each(['cancel','reschedule'] as const)('a verified attendee %s in the original thread changes the unique current booking without human confirmation',async action=>{
 const f=await setupConversation();try{
  await runOnce(f.db,{registry:f.registry,owner:'cancel-create-admission',limit:20});
  await runOnce(f.db,{registry:f.registry,owner:'cancel-create-provider',limit:20});
  const verifiedAt=new Date(Date.now()-60_000).toISOString(),validUntil=new Date(Date.now()+86400_000).toISOString();
  let changes=0;
  const change:BookingChangeRuntime={policy:f.runtime.policy,readCostContract:async()=>({accountId:'9',eventTypeId:7,operationScope:'availability_reschedule_cancel_inspection',maximumCents:0,verifiedAt,validUntil,reference:'controlled-change-cost'}),provider:{availability:async()=>({available:true,reason:null}),readTarget:async call=>({uid:call.bookingUid,id:31,startsAt:call.originalStartsAt,endsAt:call.originalEndsAt,attendeeEmail:call.attendeeEmail,attendeeName:'Prospect',organizerEmail:call.organizerEmail,accountId:9,eventTypeId:7,updatedAt:verifiedAt,status:'accepted'}),change:async call=>{changes++;return {state:'accepted',booking:{uid:call.action==='reschedule'?'standing-replaced':call.bookingUid,previousUid:call.bookingUid,id:31,startsAt:call.startsAt??call.originalStartsAt,endsAt:call.startsAt===null?call.originalEndsAt:new Date(Date.parse(call.startsAt)+20*60_000).toISOString(),attendeeEmail:call.attendeeEmail,attendeeName:'Prospect',organizerEmail:call.organizerEmail,accountId:9,eventTypeId:7,updatedAt:new Date().toISOString(),submissionId:call.submissionId,action:call.action,reminderState:call.action==='reschedule'?'replaced':'stopped'}};},inspect:async()=>({state:'unknown',reason:'not_found'})}};
  Object.assign(f.conversation,{change});Object.assign(f.runtimeOptions,{bookingChange:change});
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,bookingConversation:f.conversation,bookingChange:change});
  const replacement=new Date(Date.parse(f.startsAt)+86400_000);while([0,6].includes(replacement.getUTCDay()))replacement.setUTCDate(replacement.getUTCDate()+1);
  const localDate=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(replacement),localTime=new Intl.DateTimeFormat('en-GB',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(replacement);
  const text=action==='cancel'?'Please cancel our call.':`Please reschedule our call to ${localDate} at ${localTime} America/New_York.`;
  const {source}=await captureAt(f,text,new Date().toISOString());
  f.setCandidate({intent:'change',agreement:{sourceId:source.sourceId,start:0,end:text.length,quote:text},slot:action==='cancel'?null:{localDate,localTime,timeZone:'America/New_York',evidence:{sourceId:source.sourceId,start:0,end:text.length,quote:text}},substantive:null});
  const requested=await f.request('POST','/crm/booking/interpretation/request',f.command({source,priorSources:[]}));
  expect(requested.status,JSON.stringify(requested.body)).toBe(200);
  await runOnce(f.db,{registry:f.registry,owner:'cancel-interpreter',limit:20});
  const requestId=(requested.body as {result:{requestId:string}}).result.requestId;
  const admitted=await f.request('POST','/meetings/booking-conversation',f.command({interpretationRequestId:requestId,expectedPolicyRevision:1}));
  expect(admitted.status,JSON.stringify(admitted.body)).toBe(200);
  const id=(admitted.body as {result:{conversationId:string}}).result.conversationId;
  await runOnce(f.db,{registry,owner:'cancel-lifecycle',limit:20});
  await runOnce(f.db,{registry,owner:'cancel-provider',limit:20});
  const read=await f.request('GET',`/meetings/booking-conversation?conversationId=${id}`);
  expect(read.body).toMatchObject({state:action==='cancel'?'cancelled':'rescheduled',origin:'standing_policy',enabled:false,change:{state:'accepted',action,reminderState:action==='cancel'?'stopped':'replaced'}});
  expect(changes).toBe(1);
  expect(JSON.stringify(read.body)).not.toContain('owner_confirmed_unconditional');
 }finally{await f.fixture.stop();}
});

it.each(['automatic','manual_first','later_reply'] as const)('admitted call interest automatically sends the original-thread link and bounds due nudges: %s',async mode=>{
 const f=await setupConversation();try{
  const sender=await setupBookingMessageSender(f,f.runtime.policy,f.bindings,f.conversation);
  Object.assign(f.conversation,{messages:sender.runtime});Object.assign(f.runtimeOptions,{bookingMessages:sender.runtime});
  const text='Yes, let us arrange our call.';
  const {source}=await captureAt(f,text,'2026-10-13T17:00:00.000Z');
  f.setCandidate({intent:'interest',agreement:{sourceId:source.sourceId,start:0,end:text.length,quote:text},slot:null,substantive:null});
  const request=await f.request('POST','/crm/booking/interpretation/request',f.command({source,priorSources:[]}));
  expect(request.status,JSON.stringify(request.body)).toBe(200);
  await runOnce(f.db,{registry:f.registry,owner:'link-interpreter',limit:20});
  const requestId=(request.body as {result:{requestId:string}}).result.requestId;
  const admitted=await f.request('POST','/meetings/booking-conversation',f.command({interpretationRequestId:requestId,expectedPolicyRevision:1}));
  expect(admitted.status,JSON.stringify(admitted.body)).toBe(200);
  const id=(admitted.body as {result:{conversationId:string}}).result.conversationId;
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,bookingConversation:f.conversation,bookingMessages:sender.runtime});
  const daytime=new Date();daytime.setUTCDate(daytime.getUTCDate()+1);daytime.setUTCHours(16,0,0,0);while([0,6].includes(daytime.getUTCDay()))daytime.setUTCDate(daytime.getUTCDate()+1);
  f.runtime.policy.now=()=>daytime.toISOString();
  await runOnce(f.db,{registry,owner:'link-lifecycle',limit:20});
  await runOnce(f.db,{registry,owner:'link-sender',limit:20});
  const messages=(await f.fixture.db.query<{id:string}>('SELECT id FROM booking_message_requests WHERE workspace_id=$1 AND conversation_id=$2',[f.fixture.alpha.workspaceId,id])).rows;
  expect(messages,JSON.stringify((await f.request('GET',`/meetings/booking-conversation?conversationId=${id}`)).body)).toHaveLength(1);
  expect((await f.request('GET',`/meetings/booking-messages?messageId=${messages[0]!.id}`)).body).toMatchObject({kind:'approved_link',state:'sent'});
  expect(sender.gmail.sends).toHaveLength(1);
  expect(sender.gmail.sends[0]).toMatchObject({threadId:'booking-thread',to:'prospect@booking.example',inReplyTo:expect.stringMatching(/^<.+@booking\.example>$/u)});
  const due=(await f.fixture.db.query<{payload:{messageKind:string};run_at:Date}>("SELECT payload,run_at FROM jobs WHERE workspace_id=$1 AND kind='meeting.booking_conversation' AND payload->>'conversationId'=$2 AND payload->>'messageKind'='nudge_3'",[f.fixture.alpha.workspaceId,id])).rows;
  expect(due).toHaveLength(1);expect(due[0]!.run_at.getTime()).toBeGreaterThan(Date.now());
  expect((await f.request('GET',`/meetings/booking-conversation?conversationId=${id}`)).body).toMatchObject({state:'awaiting_time',nudgeCount:0,enabled:false});
  if(mode==='manual_first')expect((await f.request('POST','/meetings/booking-conversation/event',f.command({conversationId:id,expectedPolicyRevision:1,event:'manual_nudge'}))).status).toBe(200);
  if(mode==='later_reply')await captureAt(f,'Wait, I need to check our schedule.','2026-10-13T18:00:00.000Z');
  for(const [kind,count] of [['nudge_3',1],['nudge_7',2]] as const){
   const scheduled=(await f.fixture.db.query<{id:string;run_at:Date}>("SELECT id,run_at FROM jobs WHERE workspace_id=$1 AND kind='meeting.booking_conversation' AND payload->>'conversationId'=$2 AND payload->>'messageKind'=$3",[f.fixture.alpha.workspaceId,id,kind])).rows;
   expect(scheduled).toHaveLength(1);
   f.runtime.policy.now=()=>scheduled[0]!.run_at.toISOString();
   // Advance only the controlled queue timer. Eligibility, source, sender window,
   // aggregate counters, reservation and irreversible marker remain real guards.
   await f.fixture.db.query('UPDATE jobs SET run_at=now() WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,scheduled[0]!.id]);
   await runOnce(f.db,{registry,owner:`automatic-${kind}-lifecycle`,limit:20});
   await runOnce(f.db,{registry,owner:`automatic-${kind}-sender`,limit:20});
   const receipt=(await f.fixture.db.query<{id:string}>('SELECT id FROM booking_message_requests WHERE workspace_id=$1 AND conversation_id=$2 AND kind=$3',[f.fixture.alpha.workspaceId,id,kind])).rows;
   if(mode==='later_reply'||mode==='manual_first'&&kind==='nudge_3'){
    expect(receipt).toHaveLength(0);expect(sender.gmail.sends).toHaveLength(1);
    if(mode==='later_reply'){
     expect((await f.request('GET',`/meetings/booking-conversation?conversationId=${id}`)).body).toMatchObject({state:'handoff',reason:'new_reply_requires_interpretation',nudgeCount:0});
     break;
    }
    expect((await f.request('GET',`/meetings/booking-conversation?conversationId=${id}`)).body).toMatchObject({state:'awaiting_time',nudgeCount:1});
    continue;
   }
   expect(receipt,JSON.stringify((await f.request('GET',`/meetings/booking-conversation?conversationId=${id}`)).body)).toHaveLength(1);
   expect((await f.request('GET',`/meetings/booking-messages?messageId=${receipt[0]!.id}`)).body).toMatchObject({kind,state:'sent'});
   expect(sender.gmail.sends).toHaveLength(count+(mode==='manual_first'?0:1));
   expect((await f.request('GET',`/meetings/booking-conversation?conversationId=${id}`)).body).toMatchObject({nudgeCount:count,state:count===2?'handoff':'awaiting_time'});
  }
  if(mode!=='later_reply')expect((await f.request('GET',`/meetings/booking-conversation?conversationId=${id}`)).body).toMatchObject({state:'handoff',reason:'two_unanswered_booking_nudges',handoff:{action:'review_booking'},enabled:false});
  await runOnce(f.db,{registry,owner:'automatic-after-two-restart',limit:20});
  expect(sender.gmail.sends).toHaveLength(mode==='later_reply'?1:mode==='manual_first'?2:3);
 }finally{await f.fixture.stop();}
});

it('historical publication and exact capture replay do not stop the current accepted offer',async()=>{
 const f=await setupConversation();try{
  const historical=await captureAt(f,'Earlier scheduling context.','2026-10-12T12:00:00Z');await historical.replay();
  await runOnce(f.db,{registry:f.registry,owner:'historical-lifecycle',limit:20});await runOnce(f.db,{registry:f.registry,owner:'historical-create',limit:20});
  expect((await f.request('GET',`/meetings/booking-conversation?conversationId=${f.conversationId}`)).body).toMatchObject({state:'booked',lastReplyAt:null});
  expect(f.providerCalls).toHaveLength(1);
 }finally{await f.fixture.stop();}
});

it('readback clears private handoff when captured readiness expires during final authorization',async()=>{
 const f=await setupConversation();try{
  const current=f.runtime.policy.now();let clock=current;f.runtime.policy.now=()=>clock;
  const ctx=repositoryContext(workspaceScope(f.fixture.alpha.workspaceId,{kind:'user',userId:f.fixture.alpha.admin.userId,role:'admin'}),f.fixture.db);
  const read=await withTransaction(f.fixture.db,()=>readBookingConversation(ctx,f.conversationId,f.conversation,async()=>{clock=new Date(Date.parse(current)+8*86400_000).toISOString();return true;}));
  expect(read).toMatchObject({state:'stale',reason:'booking_readiness_unavailable',outcome:null,handoff:null});
 }finally{await f.fixture.stop();}
});

it.each(['deliver','attendance_corrected'] as const)('normal manual attendance governs exactly one next-New-York-business-day rebooking job: %s',async mode=>{
 const f=await setupConversation();const server=await startIntegrationServer(f.fixture);try{
  await runOnce(f.db,{registry:f.registry,owner:'attendance-create-admission',limit:20});await runOnce(f.db,{registry:f.registry,owner:'attendance-create',limit:20});
  const sender=await setupBookingMessageSender(f,f.runtime.policy,f.bindings,f.conversation);Object.assign(f.conversation,{messages:sender.runtime});Object.assign(f.runtimeOptions,{bookingMessages:sender.runtime});
  expect((await f.request('POST','/meetings/booking-conversation/event',f.command({conversationId:f.conversationId,expectedPolicyRevision:1,event:'confirm_no_show'}))).body).toMatchObject({reason:'david_no_show_confirmation_required'});
  const previous=new Date(Date.now()-3600_000),raw=JSON.stringify({triggerEvent:'BOOKING_RESCHEDULED',createdAt:new Date().toISOString(),payload:{uid:'elapsed-standing-booking',rescheduleUid:'standing-booking',startTime:previous.toISOString(),endTime:new Date(previous.getTime()+20*60_000).toISOString(),organizer:{email:'owner@booking.example'},attendees:[{email:'prospect@booking.example'}]}});
  expect((await fetch(`${server.origin}/integrations/calcom/webhook`,{method:'POST',headers:{'content-type':'application/json','x-cal-signature-256':server.calcomSign(Buffer.from(raw))},body:raw})).status).toBe(200);
  const read=await f.request('GET',`/meetings/booking-conversation?conversationId=${f.conversationId}`),meetingId=(read.body as {booking:{meetingId:string}}).booking.meetingId;
  expect((await f.request('POST','/meetings/attendance',f.command({meetingId,attendance:'no_show'}))).status).toBe(200);
  const event=f.command({conversationId:f.conversationId,expectedPolicyRevision:1,event:'confirm_no_show'});
  expect((await f.request('POST','/meetings/booking-conversation/event',event)).status).toBe(200);
  expect((await f.request('POST','/meetings/booking-conversation/event',event)).status).toBe(200);
  const jobs=(await f.fixture.db.query<{id:string;payload:{messageKind:string};run_at:Date}>("SELECT id,payload,run_at FROM jobs WHERE workspace_id=$1 AND payload->>'conversationId'=$2 AND payload->>'messageKind'='no_show'",[f.fixture.alpha.workspaceId,f.conversationId])).rows;
  expect(jobs).toHaveLength(1);expect(jobs[0]!.run_at.getTime()).toBeGreaterThan(Date.now());
  const confirmed=(await f.request('GET',`/meetings/booking-conversation?conversationId=${f.conversationId}`)).body as {explicitNoShowAt:string};
  expect(confirmed).toMatchObject({explicitNoShowAt:expect.any(String),noShowRebookingUsed:false});
  const nyDate=(at:Date)=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(at);
  const expectedDay=new Date(`${nyDate(new Date(confirmed.explicitNoShowAt))}T12:00:00Z`);expectedDay.setUTCDate(expectedDay.getUTCDate()+1);while([0,6].includes(expectedDay.getUTCDay()))expectedDay.setUTCDate(expectedDay.getUTCDate()+1);
  expect(nyDate(jobs[0]!.run_at)).toBe(expectedDay.toISOString().slice(0,10));
  expect(new Intl.DateTimeFormat('en-GB',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(jobs[0]!.run_at)).toBe('10:00');
  if(mode==='attendance_corrected')expect((await f.request('POST','/meetings/attendance',f.command({meetingId,attendance:'attended'}))).status).toBe(200);
  // Only the existing queue timer is advanced. No attendance, permission, source,
  // counters or admission rows are seeded or replaced.
  f.runtime.policy.now=()=>jobs[0]!.run_at.toISOString();
  await f.fixture.db.query('UPDATE jobs SET run_at=now() WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,jobs[0]!.id]);
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,bookingConversation:f.conversation,bookingMessages:sender.runtime});
  await runOnce(f.db,{registry,owner:'no-show-due-lifecycle',limit:20});await runOnce(f.db,{registry,owner:'no-show-due-sender',limit:20});
  const sent=(await f.fixture.db.query<{id:string}>('SELECT id FROM booking_message_requests WHERE workspace_id=$1 AND conversation_id=$2',[f.fixture.alpha.workspaceId,f.conversationId])).rows;
  if(mode==='attendance_corrected'){
   expect(sent).toHaveLength(0);expect(sender.gmail.sends).toHaveLength(0);
   expect((await f.request('GET',`/meetings/booking-conversation?conversationId=${f.conversationId}`)).body).toMatchObject({reason:'david_no_show_confirmation_required',noShowRebookingUsed:false});
   return;
  }
  expect(sent,JSON.stringify({rows:(await f.fixture.db.query('SELECT state,reason FROM booking_conversations WHERE workspace_id=$1',[f.fixture.alpha.workspaceId])).rows,view:(await f.request('GET',`/meetings/booking-conversation?conversationId=${f.conversationId}`)).body,jobs:(await f.fixture.db.query('SELECT kind,state,error_code,error_detail,payload FROM jobs WHERE workspace_id=$1',[f.fixture.alpha.workspaceId])).rows})).toHaveLength(1);
  expect((await f.request('GET',`/meetings/booking-messages?messageId=${sent[0]!.id}`)).body).toMatchObject({kind:'no_show',state:'sent'});
  expect(sender.gmail.sends).toHaveLength(1);
  expect((await f.request('GET',`/meetings/booking-conversation?conversationId=${f.conversationId}`)).body).toMatchObject({noShowRebookingUsed:true});
  await runOnce(f.db,{registry,owner:'no-show-restart',limit:20});
  expect(sender.gmail.sends).toHaveLength(1);
  const replay=await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.conversationId,kind:'no_show'}));
  expect(replay.body).toMatchObject({result:{messageId:sent[0]!.id,state:'sent'}});
  expect((await f.fixture.db.query("SELECT id FROM jobs WHERE workspace_id=$1 AND payload->>'conversationId'=$2 AND payload->>'messageKind'='no_show'",[f.fixture.alpha.workspaceId,f.conversationId])).rows).toHaveLength(1);
 }finally{await server.close();await f.fixture.stop();}
});
