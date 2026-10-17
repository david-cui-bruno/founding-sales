import {expect,it} from 'vitest';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import type {BookingChangeRuntime} from '@fss/domain/meetings/bookingChangeProvider.ts';
import {captureAt,setupConversation} from './support/bookingConversationFixture.ts';
import {setupBookingMessageSender} from './support/bookingMessageFixture.ts';

it.each([{targetKind:'firm',action:'cancel'},{targetKind:'contact',action:'cancel'},{targetKind:'firm',action:'reschedule'},{targetKind:'contact',action:'reschedule'}] as const)('public $targetKind retention deletes a $action booking and detaches both retained target identifiers',async({targetKind,action})=>{
 const f=await setupConversation();
 try{
  await runOnce(f.db,{registry:f.registry,owner:'deletion-create-admission',limit:20});
  await runOnce(f.db,{registry:f.registry,owner:'deletion-create-provider',limit:20});
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
  await runOnce(f.db,{registry:f.registry,owner:'deletion-change-interpreter',limit:20});
  const interpretationRequestId=(requested.body as {result:{requestId:string}}).result.requestId;
  const command=f.command({interpretationRequestId,expectedPolicyRevision:1});
  const admitted=await f.request('POST','/meetings/booking-conversation',command);
  expect(admitted.status,JSON.stringify(admitted.body)).toBe(200);
  const id=(admitted.body as {result:{conversationId:string}}).result.conversationId;
  await runOnce(f.db,{registry,owner:'deletion-change-lifecycle',limit:20});
  await runOnce(f.db,{registry,owner:'deletion-change-provider',limit:20});
  expect((await f.request('GET',`/meetings/booking-conversation?conversationId=${id}`)).body).toMatchObject({state:action==='cancel'?'cancelled':'rescheduled',change:{state:'accepted',reminderState:action==='cancel'?'stopped':'replaced'}});
  const before=(await f.fixture.db.query('SELECT target_meeting_id,target_booking_uid,change_submission_id FROM booking_conversations WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,id])).rows[0]!;
  expect(before['target_meeting_id']).toEqual(expect.any(String));expect(before['target_booking_uid']).toBe('standing-booking');
  const preview=await f.request('POST','/retention/deletions/preview',f.command({targetKind,firmId:f.firmId,...(targetKind==='contact'?{contactId:f.contactId}:{})}));
  expect(preview.status,JSON.stringify(preview.body)).toBe(200);
  const shown=(preview.body as {result:{requestId:string;previewHash:string}}).result;
  const committed=await f.request('POST','/retention/deletions/commit',f.command({requestId:shown.requestId,previewHash:shown.previewHash}));
  expect(committed.status,JSON.stringify(committed.body)).toBe(200);
  expect((await f.fixture.db.query('SELECT id FROM meetings WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,before['target_meeting_id']])).rows).toHaveLength(0);
  const retained=(await f.fixture.db.query('SELECT target_meeting_id,target_booking_uid,change_submission_id,source_refs,source_fingerprint,source_conversation_id,handoff_action,state FROM booking_conversations WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,id])).rows[0]!;
  expect(retained).toMatchObject({target_meeting_id:null,target_booking_uid:null,change_submission_id:before['change_submission_id'],source_refs:[],source_fingerprint:'0'.repeat(64),source_conversation_id:null,handoff_action:null,state:'stale'});
  const receipt=(await f.fixture.db.query('SELECT state,dispatch_started_at,provider_booking_uid,payload FROM booking_change_submissions WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,before['change_submission_id']])).rows[0]!;
  expect(receipt).toMatchObject({state:'accepted',dispatch_started_at:expect.any(Date),provider_booking_uid:action==='cancel'?'standing-booking':'standing-replaced',payload:{}});
  expect((await f.request('POST','/meetings/booking-conversation',command)).body).toMatchObject({replayed:true,result:{state:'stale',handoff:null}});
  expect(changes).toBe(1);expect(f.providerCalls).toHaveLength(1);
 }finally{await f.fixture.stop();}
});

it('public source deletion erases the queued standing fence copied subject without removing its receipt or dispatching',async()=>{
 const f=await setupConversation();
 try{
  const sender=await setupBookingMessageSender(f,f.runtime.policy,f.bindings,f.conversation);
  Object.assign(f.conversation,{messages:sender.runtime});Object.assign(f.runtimeOptions,{bookingMessages:sender.runtime});
  const text='Yes, let us arrange our call.',secret='Sensitive customer / private deal X';
  const {source}=await captureAt(f,text,'2026-10-13T17:00:00.000Z',secret);
  f.setCandidate({intent:'interest',agreement:{sourceId:source.sourceId,start:0,end:text.length,quote:text},slot:null,substantive:null});
  const requested=await f.request('POST','/crm/booking/interpretation/request',f.command({source,priorSources:[]}));
  expect(requested.status,JSON.stringify(requested.body)).toBe(200);
  await runOnce(f.db,{registry:f.registry,owner:'privacy-message-interpreter',limit:20});
  const interpretationRequestId=(requested.body as {result:{requestId:string}}).result.requestId;
  const admitted=await f.request('POST','/meetings/booking-conversation',f.command({interpretationRequestId,expectedPolicyRevision:1}));
  expect(admitted.status,JSON.stringify(admitted.body)).toBe(200);
  const conversationId=(admitted.body as {result:{conversationId:string}}).result.conversationId;
  const queued=await f.request('POST','/meetings/booking-messages',f.command({conversationId,kind:'approved_link'}));
  expect(queued.status,JSON.stringify(queued.body)).toBe(200);
  const receipt=(queued.body as {result:{messageId:string;outboundMessageId:string}}).result;
  expect((await f.fixture.db.query('SELECT subject,attempt_token,dispatch_started_at FROM outbound_messages WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,receipt.outboundMessageId])).rows[0]).toMatchObject({subject:`Re: ${secret}`,attempt_token:null,dispatch_started_at:null});
  expect((await f.request('POST','/crm/business/mail/delete',f.command({sourceId:source.sourceId,expectedRevision:1}))).status).toBe(200);
  const fence=(await f.fixture.db.query('SELECT subject,attempt_token,dispatch_started_at,provider_message_id,sent_at FROM outbound_messages WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,receipt.outboundMessageId])).rows[0];
  expect(fence).toMatchObject({subject:'Re: Our call',attempt_token:null,dispatch_started_at:null,provider_message_id:null,sent_at:null});
  expect((await f.request('GET',`/meetings/booking-messages?messageId=${receipt.messageId}`)).body).toMatchObject({messageId:receipt.messageId,outboundMessageId:receipt.outboundMessageId});
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,bookingConversation:f.conversation,bookingMessages:sender.runtime});
  await runOnce(f.db,{registry,owner:'privacy-queued-sender',limit:20});
  expect(sender.gmail.sends).toHaveLength(0);
  expect((await f.request('POST','/crm/business/mail/read',source)).body).toMatchObject({state:'unavailable'});
 }finally{await f.fixture.stop();}
});
