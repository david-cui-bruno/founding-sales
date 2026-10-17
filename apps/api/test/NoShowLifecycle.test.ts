import {expect,it} from 'vitest';
import {bookingStopsFixture} from './support/bookingStopsFixture.ts';
import {startIntegrationServer} from './support/integrationServer.ts';
import {captureAt,setupConversation} from './support/bookingConversationFixture.ts';
import {setupBookingMessageSender} from './support/bookingMessageFixture.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import type {BookingChangeRuntime} from '@fss/domain/meetings/bookingChangeProvider.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {dispatch} from '../src/server.ts';

type Server=Awaited<ReturnType<typeof startIntegrationServer>>;
async function signed(server:Server,uid:string,options:{previousUid?:string;organizer?:string;attendee?:string;createdAt?:string;startsAt?:string;trigger?:string;noShow?:boolean}={}){
 const start=options.startsAt??new Date(Date.now()-3600_000).toISOString();
 const raw=JSON.stringify({triggerEvent:options.trigger??(options.previousUid===undefined?'BOOKING_CREATED':'BOOKING_RESCHEDULED'),createdAt:options.createdAt??new Date().toISOString(),payload:{uid,rescheduleUid:options.previousUid,startTime:start,endTime:new Date(Date.parse(start)+20*60_000).toISOString(),organizer:{email:options.organizer??'owner@booking.example'},attendees:[{email:options.attendee??'prospect@booking.example',noShow:options.noShow}]}});
 const response=await fetch(`${server.origin}/integrations/calcom/webhook`,{method:'POST',headers:{'content-type':'application/json','x-cal-signature-256':server.calcomSign(Buffer.from(raw))},body:raw});
 expect(response.status).toBe(200);
}
type Journey={fixture:Awaited<ReturnType<typeof bookingStopsFixture>>['fixture'];db:Awaited<ReturnType<typeof bookingStopsFixture>>['db'];command:(body:object)=>object;request:(method:string,path:string,body?:unknown)=>Promise<{status:number;body:unknown}>};
async function confirm(f:Journey,conversationId:string,meetingId:string){
 expect((await f.request('POST','/meetings/attendance',f.command({meetingId,attendance:'no_show'}))).body).toMatchObject({result:{state:'no_show',attendanceSource:'manual'}});
 const event=f.command({conversationId,expectedPolicyRevision:1,event:'confirm_no_show'});
 const result=await f.request('POST','/meetings/booking-conversation/event',event);
 expect(result.status,JSON.stringify(result.body)).toBe(200);
 expect((await f.request('POST','/meetings/booking-conversation/event',event)).status).toBe(200);
 // Both stamps are native PostgreSQL timestamps, including retained microseconds.
 expect((await f.fixture.db.query<{same:boolean}>('SELECT b.explicit_no_show_at=m.attendance_confirmed_at AS same FROM booking_conversations b JOIN meetings m ON m.workspace_id=b.workspace_id AND m.id=$3 WHERE b.workspace_id=$1 AND b.id=$2',[f.fixture.alpha.workspaceId,conversationId,meetingId])).rows[0]?.same).toBe(true);
}
async function deliver(f:Journey,conversationId:string,gmail:{sends:readonly unknown[]},setClock:(at:string)=>void,run:()=>Promise<unknown>,priorSends:number){
 const jobs=(await f.fixture.db.query<{id:string;run_at:Date}>("SELECT id,run_at FROM jobs WHERE workspace_id=$1 AND payload->>'conversationId'=$2 AND payload->>'messageKind'='no_show'",[f.fixture.alpha.workspaceId,conversationId])).rows;
 expect(jobs).toHaveLength(1);
 const due=jobs[0]!;
 const view=(await f.request('GET',`/meetings/booking-conversation?conversationId=${conversationId}`)).body as {explicitNoShowAt:string};
 const dateOf=(at:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
 const next=new Date(`${dateOf(view.explicitNoShowAt)}T12:00:00Z`);next.setUTCDate(next.getUTCDate()+1);while([0,6].includes(next.getUTCDay()))next.setUTCDate(next.getUTCDate()+1);
 expect(dateOf(due.run_at.toISOString())).toBe(next.toISOString().slice(0,10));
 expect(new Intl.DateTimeFormat('en-GB',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(due.run_at)).toBe('10:00');
 setClock(view.explicitNoShowAt);
 expect((await f.request('POST','/meetings/booking-messages',f.command({conversationId,kind:'no_show'}))).status).toBe(409);
 setClock(due.run_at.toISOString());
 // Advance only queue time, not booking, attendance, grants or admission rows.
 await f.fixture.db.query('UPDATE jobs SET run_at=now() WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,due.id]);
 await run();await run();
 const receipts=(await f.fixture.db.query<{id:string}>("SELECT id FROM booking_message_requests WHERE workspace_id=$1 AND conversation_id=$2 AND kind='no_show'",[f.fixture.alpha.workspaceId,conversationId])).rows;
 expect(receipts).toHaveLength(1);
 expect((await f.request('GET',`/meetings/booking-messages?messageId=${receipts[0]!.id}`)).body).toMatchObject({kind:'no_show',state:'sent'});
 expect(gmail.sends).toHaveLength(priorSends+1);
 expect(gmail.sends.at(-1)).toMatchObject({to:'prospect@booking.example',threadId:'booking-thread',inReplyTo:expect.stringMatching(/^<.+@booking\.example>$/u)});
 expect((await f.request('GET',`/meetings/booking-conversation?conversationId=${conversationId}`)).body).toMatchObject({noShowRebookingUsed:true});
 const replay=await f.request('POST','/meetings/booking-messages',f.command({conversationId,kind:'no_show'}));
 expect(replay.body).toMatchObject({result:{messageId:receipts[0]!.id,state:'sent'}});await run();expect(gmail.sends).toHaveLength(priorSends+1);
 expect((await f.fixture.db.query("SELECT id FROM jobs WHERE workspace_id=$1 AND payload->>'conversationId'=$2 AND payload->>'messageKind'='no_show'",[f.fixture.alpha.workspaceId,conversationId])).rows).toHaveLength(1);
}

it.each(['created','rescheduled'] as const)('NoShowLifecycle: approved link then signed %s booking and David manual no-show sends exactly one registered next-business-day original-thread rebooking',async lifecycle=>{
 const f=await bookingStopsFixture(),server=await startIntegrationServer(f.fixture);try{
  Object.assign(f.conversation,{messages:f.runtime});
  const link=await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.conversationId,kind:'approved_link'}));expect(link.status).toBe(200);await f.run();expect(f.gmail.sends).toHaveLength(1);
  await signed(server,'link-no-show');
  const currentUid=lifecycle==='created'?'link-no-show':'link-replaced-no-show';
  if(lifecycle==='rescheduled')await signed(server,currentUid,{previousUid:'link-no-show'});
  const meeting=(await f.fixture.db.query<{id:string;current_booking_uid:string}>('SELECT id,current_booking_uid FROM meetings WHERE workspace_id=$1 AND current_booking_uid=$2',[f.fixture.alpha.workspaceId,currentUid])).rows[0]!;
  expect(meeting).toMatchObject({id:expect.any(String),current_booking_uid:currentUid});
  expect((await f.request('GET',`/meetings/booking-conversation?conversationId=${f.conversationId}`)).body).toMatchObject({booking:null,nudgesStoppedAt:expect.any(String)});
  await confirm(f,f.conversationId,meeting.id);
  await deliver(f,f.conversationId,f.gmail,f.setClock,f.run,1);
  expect((await f.request('POST','/meetings/booking-conversation/event',f.command({conversationId:f.conversationId,expectedPolicyRevision:1,event:'manual_nudge'}))).status).toBe(409);
 }finally{await server.close();await f.stop();}
});

it.each(['deliver','uid_changed','attendance_corrected'] as const)('NoShowLifecycle: accepted create then supported attendee reschedule confirms the newer current UID episode without a create submission: %s',async mode=>{
 const f=await setupConversation(),server=await startIntegrationServer(f.fixture);try{
  const run=async(registry=f.registry)=>{const result=await runOnce(f.db,{registry,owner:'no-show-current-episode',limit:30});expect(result.failed).toBe(0);};
  await run();await run();expect(f.providerCalls).toHaveLength(1);
  const verifiedAt=new Date(Date.now()-60_000).toISOString(),validUntil=new Date(Date.now()+7*86400_000).toISOString();
  let changes=0;
  const change:BookingChangeRuntime={policy:f.runtime.policy,readCostContract:async()=>({accountId:'9',eventTypeId:7,operationScope:'availability_reschedule_cancel_inspection',maximumCents:0,verifiedAt,validUntil,reference:'controlled-no-show-change'}),provider:{availability:async()=>({available:true,reason:null}),readTarget:async call=>({uid:call.bookingUid,id:31,startsAt:call.originalStartsAt,endsAt:call.originalEndsAt,attendeeEmail:call.attendeeEmail,attendeeName:'Prospect',organizerEmail:call.organizerEmail,accountId:9,eventTypeId:7,updatedAt:verifiedAt,status:'accepted'}),change:async call=>{changes++;return {state:'accepted',booking:{uid:'no-show-replaced',previousUid:call.bookingUid,id:31,startsAt:call.startsAt!,endsAt:new Date(Date.parse(call.startsAt!)+20*60_000).toISOString(),attendeeEmail:call.attendeeEmail,attendeeName:'Prospect',organizerEmail:call.organizerEmail,accountId:9,eventTypeId:7,updatedAt:new Date().toISOString(),submissionId:call.submissionId,action:'reschedule',reminderState:'replaced'}};},inspect:async()=>({state:'unknown',reason:'not_found'})}};
  Object.assign(f.conversation,{change});Object.assign(f.runtimeOptions,{bookingChange:change});
  const replacement=new Date(Date.parse(f.startsAt)+86400_000);while([0,6].includes(replacement.getUTCDay()))replacement.setUTCDate(replacement.getUTCDate()+1);
  const localDate=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(replacement),localTime=new Intl.DateTimeFormat('en-GB',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(replacement);
  const text=`Please reschedule our call to ${localDate} at ${localTime} America/New_York.`,{source}=await captureAt(f,text,new Date().toISOString());
  f.setCandidate({intent:'change',agreement:{sourceId:source.sourceId,start:0,end:text.length,quote:text},slot:{localDate,localTime,timeZone:'America/New_York',evidence:{sourceId:source.sourceId,start:0,end:text.length,quote:text}},substantive:null});
  const requested=await f.request('POST','/crm/booking/interpretation/request',f.command({source,priorSources:[]}));expect(requested.status).toBe(200);await run();
  const admitted=await f.request('POST','/meetings/booking-conversation',f.command({interpretationRequestId:(requested.body as {result:{requestId:string}}).result.requestId,expectedPolicyRevision:1}));expect(admitted.status).toBe(200);
  const id=(admitted.body as {result:{conversationId:string}}).result.conversationId;
  const sender=await setupBookingMessageSender(f,f.runtime.policy,f.bindings,f.conversation);Object.assign(f.conversation,{messages:sender.runtime});Object.assign(f.runtimeOptions,{bookingMessages:sender.runtime});
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,bookingConversation:f.conversation,bookingChange:change,bookingMessages:sender.runtime});
  await run(registry);await run(registry);expect(changes).toBe(1);
  const view=(await f.request('GET',`/meetings/booking-conversation?conversationId=${id}`)).body as {change:{meetingId:string}};
  expect(view).toMatchObject({booking:null,state:'rescheduled',change:{state:'accepted',providerBookingUid:'no-show-replaced'}});
  const retained=async()=>({origin:(await f.fixture.db.query('SELECT target_meeting_id,target_booking_uid,change_submission_id FROM booking_conversations WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,id])).rows,receipt:(await f.fixture.db.query('SELECT * FROM booking_change_submissions WHERE workspace_id=$1 AND id=(SELECT change_submission_id FROM booking_conversations WHERE workspace_id=$1 AND id=$2)',[f.fixture.alpha.workspaceId,id])).rows});
  const before=await retained();expect(before.origin[0]).toMatchObject({target_booking_uid:'standing-booking'});
  await signed(server,'no-show-replaced',{previousUid:'no-show-replaced'});
  expect((await f.fixture.db.query('SELECT current_booking_uid FROM meetings WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,view.change.meetingId])).rows[0]).toEqual({current_booking_uid:'no-show-replaced'});
  await confirm(f,id,view.change.meetingId);
  if(mode!=='deliver'){
   if(mode==='uid_changed')await signed(server,'later-replaced-no-show',{previousUid:'no-show-replaced'});
   else expect((await f.request('POST','/meetings/attendance',f.command({meetingId:view.change.meetingId,attendance:'attended'}))).status).toBe(200);
   const job=(await f.fixture.db.query<{id:string;run_at:Date}>("SELECT id,run_at FROM jobs WHERE workspace_id=$1 AND payload->>'conversationId'=$2 AND payload->>'messageKind'='no_show'",[f.fixture.alpha.workspaceId,id])).rows[0]!;
   f.runtime.policy.now=()=>job.run_at.toISOString();
   await f.fixture.db.query('UPDATE jobs SET run_at=now() WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,job.id]);
   await run(registry);await run(registry);expect(sender.gmail.sends).toHaveLength(0);
   expect((await f.fixture.db.query('SELECT no_show_rebooking_used FROM booking_conversations WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,id])).rows[0]).toEqual({no_show_rebooking_used:false});
   expect(await retained()).toEqual(before);return;
  }
  await deliver(f,id,sender.gmail,at=>{f.runtime.policy.now=()=>at;},()=>run(registry),0);
  expect(await retained()).toEqual(before);
  expect((await f.request('POST','/meetings/booking-conversation/event',f.command({conversationId:f.conversationId,expectedPolicyRevision:1,event:'confirm_no_show'}))).status).toBe(409);
 }finally{await server.close();await f.fixture.stop();}
});

it.each(['organizer','attendee','owner','other_confirmer','preagreement','unknown_history','ambiguous','unrelated_meeting','unconfirmed','nonmanual'] as const)('NoShowLifecycle refuses unsupported link episode or attendance: %s',async mode=>{
 const f=await bookingStopsFixture(),server=await startIntegrationServer(f.fixture);try{
  Object.assign(f.conversation,{messages:f.runtime});
  await signed(server,'refused-no-show',{...(mode==='organizer'?{organizer:'other@booking.example'}:{}),...(mode==='attendee'?{attendee:'other@prospect.example'}:{}),...(mode==='preagreement'?{createdAt:'2026-10-12T17:00:00Z',startsAt:'2026-10-12T18:00:00Z'}:{}),...(mode==='unknown_history'?{previousUid:'unknown-original-uid'}:{})});
  const meeting=(await f.fixture.db.query<{id:string}>("SELECT id FROM meetings WHERE workspace_id=$1 AND current_booking_uid='refused-no-show'",[f.fixture.alpha.workspaceId])).rows[0]!;
  expect(meeting).toBeDefined();
  if(mode==='nonmanual'){
   await signed(server,'refused-no-show',{trigger:'BOOKING_NO_SHOW_UPDATED',noShow:true});
   expect((await f.fixture.db.query('SELECT state,attendance_source FROM meetings WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,meeting.id])).rows[0]).toEqual({state:'no_show',attendance_source:'calcom_no_show'});
  }else if(!['unconfirmed','attendee'].includes(mode)){
   if(mode==='other_confirmer'){
    // Give the fixture's existing salesperson their normal firm assignment for
    // the public attendance command, then restore the source owner's assignment.
    // No no-show stamp, booking receipt or standing permission is seeded.
    await f.fixture.db.query('UPDATE firms SET assigned_user_id=$3 WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,f.firmId,f.fixture.alpha.salesperson.userId]);
    const other=await issueSessionFor(f.fixture,f.fixture.alpha,f.fixture.alpha.salesperson);
    const result=await dispatch({method:'POST',path:'/meetings/attendance',query:new URLSearchParams(),body:f.command({meetingId:meeting.id,attendance:'no_show'}),headers:{authorization:`Bearer ${other.accessToken}`}},{session:f.db,auth:{...f.fixture.deps,db:f.db},supportedClientVersions:f.fixture.deps.config.supportedClientVersions,sendingEnabled:false});
    expect(result.status,JSON.stringify(result.body)).toBe(200);
    await f.fixture.db.query('UPDATE firms SET assigned_user_id=$3 WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,f.firmId,f.fixture.alpha.admin.userId]);
   }else expect((await f.request('POST','/meetings/attendance',f.command({meetingId:meeting.id,attendance:'no_show'}))).status).toBe(200);
  }
  // Controlled loss of existing assignment, never an authority grant.
  if(mode==='owner')await f.fixture.db.query('UPDATE firms SET assigned_user_id=$3 WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,f.firmId,f.fixture.alpha.salesperson.userId]);
  if(mode==='ambiguous'||mode==='unrelated_meeting')await signed(server,'other-meeting',{createdAt:mode==='unrelated_meeting'?'2026-10-12T17:00:00Z':new Date().toISOString()});
  if(mode==='unrelated_meeting'){
   // The old signed booking's no-show must not substitute for the current one.
   expect((await f.request('POST','/meetings/attendance',f.command({meetingId:meeting.id,attendance:'unconfirmed'}))).status).toBe(200);
   const older=(await f.fixture.db.query<{id:string}>("SELECT id FROM meetings WHERE workspace_id=$1 AND current_booking_uid='other-meeting'",[f.fixture.alpha.workspaceId])).rows[0]!;
   expect((await f.request('POST','/meetings/attendance',f.command({meetingId:older.id,attendance:'no_show'}))).status).toBe(200);
  }
  const event=await f.request('POST','/meetings/booking-conversation/event',f.command({conversationId:f.conversationId,expectedPolicyRevision:1,event:'confirm_no_show'}));
  expect(event.status,JSON.stringify(event.body)).toBe(409);
  expect((await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.conversationId,kind:'no_show'}))).status).toBe(409);
  await f.run();expect(f.gmail.sends).toHaveLength(0);
  expect((await f.fixture.db.query("SELECT id FROM jobs WHERE workspace_id=$1 AND payload->>'conversationId'=$2 AND payload->>'messageKind'='no_show'",[f.fixture.alpha.workspaceId,f.conversationId])).rows).toHaveLength(0);
 }finally{await server.close();await f.stop();}
});

it.each(['attendance_corrected','uid_changed','cancelled','source_deleted','policy_revoked','readiness_expired','after_oauth_attendance','after_oauth_uid'] as const)('NoShowLifecycle refuses queued rebooking after current authority changes: %s',async mode=>{
 const f=await bookingStopsFixture(),server=await startIntegrationServer(f.fixture);try{
  Object.assign(f.conversation,{messages:f.runtime});
  await signed(server,'confirmed-no-show');
  const meeting=(await f.fixture.db.query<{id:string}>("SELECT id FROM meetings WHERE workspace_id=$1 AND current_booking_uid='confirmed-no-show'",[f.fixture.alpha.workspaceId])).rows[0]!;
  await confirm(f,f.conversationId,meeting.id);
  const due=(await f.fixture.db.query<{id:string;run_at:Date}>("SELECT id,run_at FROM jobs WHERE workspace_id=$1 AND payload->>'conversationId'=$2 AND payload->>'messageKind'='no_show'",[f.fixture.alpha.workspaceId,f.conversationId])).rows[0]!;
  f.setClock(due.run_at.toISOString());
  const lose=async()=>{
   if(mode.includes('attendance'))expect((await f.request('POST','/meetings/attendance',f.command({meetingId:meeting.id,attendance:'attended'}))).status).toBe(200);
   if(mode.includes('uid'))await signed(server,'new-current-uid',{previousUid:'confirmed-no-show'});
   if(mode==='cancelled')await signed(server,'confirmed-no-show',{trigger:'BOOKING_CANCELLED'});
   if(mode==='source_deleted')expect((await f.request('POST','/crm/business/mail/delete',f.command({sourceId:f.source.sourceId,expectedRevision:1}))).status).toBe(200);
   if(mode==='policy_revoked')expect((await f.request('POST','/meetings/booking-policy',f.command({action:'revoke',expectedRevision:1}))).status).toBe(200);
   if(mode==='readiness_expired'){
    const observe=f.policy.readEvidence;f.policy.readEvidence=async(...args)=>{const read=await observe(...args);return read===null?null:{...read,validUntil:'2026-10-13T16:30:00Z'};};
   }
  };
  let observed=false;
  if(mode.startsWith('after_oauth')){
   const refresh=f.gmail.refreshAccessToken;f.gmail.refreshAccessToken=async(...args)=>{observed=true;await lose();return refresh(...args);};
  }else await lose();
  await f.fixture.db.query('UPDATE jobs SET run_at=now() WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,due.id]);
  await f.run();await f.run();
  if(mode.startsWith('after_oauth'))expect(observed).toBe(true);
  expect(f.gmail.sends).toHaveLength(0);
  expect((await f.fixture.db.query('SELECT no_show_rebooking_used FROM booking_conversations WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,f.conversationId])).rows[0]).toEqual({no_show_rebooking_used:false});
  await f.run();expect(f.gmail.sends).toHaveLength(0);
 }finally{await server.close();await f.stop();}
});

it('NoShowLifecycle conserves the single rebooking allowance across unknown sender acceptance and restart',async()=>{
 const f=await bookingStopsFixture(),server=await startIntegrationServer(f.fixture);try{
  Object.assign(f.conversation,{messages:f.runtime});await signed(server,'unknown-send-no-show');
  const meeting=(await f.fixture.db.query<{id:string}>("SELECT id FROM meetings WHERE workspace_id=$1 AND current_booking_uid='unknown-send-no-show'",[f.fixture.alpha.workspaceId])).rows[0]!;
  await confirm(f,f.conversationId,meeting.id);
  const due=(await f.fixture.db.query<{id:string;run_at:Date}>("SELECT id,run_at FROM jobs WHERE workspace_id=$1 AND payload->>'conversationId'=$2 AND payload->>'messageKind'='no_show'",[f.fixture.alpha.workspaceId,f.conversationId])).rows[0]!;
  let dispatches=0;f.gmail.sendMessage=async()=>{dispatches++;return {ok:false,outcome:'indeterminate',detail:'controlled-no-show-response-lost'};};
  f.setClock(due.run_at.toISOString());await f.fixture.db.query('UPDATE jobs SET run_at=now() WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,due.id]);
  await f.run();await f.run();expect(dispatches).toBe(1);
  const receipt=(await f.fixture.db.query<{id:string}>("SELECT id FROM booking_message_requests WHERE workspace_id=$1 AND conversation_id=$2 AND kind='no_show'",[f.fixture.alpha.workspaceId,f.conversationId])).rows[0]!;
  expect((await f.request('GET',`/meetings/booking-messages?messageId=${receipt.id}`)).body).toMatchObject({state:'reconciling'});
  expect((await f.request('GET',`/meetings/booking-conversation?conversationId=${f.conversationId}`)).body).toMatchObject({noShowRebookingUsed:true});
  const fresh=await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.conversationId,kind:'no_show'}));expect(fresh.body).toMatchObject({result:{messageId:receipt.id,state:'reconciling'}});
  await f.run();expect(dispatches).toBe(1);
 }finally{await server.close();await f.stop();}
});

it.each(['newer_payload','delayed_payload'] as const)('NoShowLifecycle refuses a retained manual stamp from the predecessor UID before conversation confirmation: %s',async mode=>{
 const f=await bookingStopsFixture(),server=await startIntegrationServer(f.fixture);try{
  Object.assign(f.conversation,{messages:f.runtime});await signed(server,'manual-predecessor');
  const meeting=(await f.fixture.db.query<{id:string}>("SELECT id FROM meetings WHERE workspace_id=$1 AND current_booking_uid='manual-predecessor'",[f.fixture.alpha.workspaceId])).rows[0]!;
  expect((await f.request('POST','/meetings/attendance',f.command({meetingId:meeting.id,attendance:'no_show'}))).status).toBe(200);
  const manual=(await f.fixture.db.query<{attendance_confirmed_at:Date}>('SELECT attendance_confirmed_at FROM meetings WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,meeting.id])).rows[0]!;
  await signed(server,'not-manually-confirmed-successor',{previousUid:'manual-predecessor',...(mode==='delayed_payload'?{createdAt:new Date(manual.attendance_confirmed_at.getTime()-1).toISOString()}:{})});
  if(mode==='delayed_payload')expect((await f.fixture.db.query<{delayed:boolean}>("SELECT e.payload_created_at<m.attendance_confirmed_at AND e.received_at>m.attendance_confirmed_at AS delayed FROM calcom_events e JOIN meetings m ON m.workspace_id=e.workspace_id AND m.id=e.meeting_id WHERE e.workspace_id=$1 AND e.booking_uid='not-manually-confirmed-successor' AND e.outcome='applied'",[f.fixture.alpha.workspaceId])).rows[0]?.delayed).toBe(true);
  expect((await f.fixture.db.query('SELECT current_booking_uid,state,attendance_source FROM meetings WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,meeting.id])).rows[0]).toEqual({current_booking_uid:'not-manually-confirmed-successor',state:'no_show',attendance_source:'manual'});
  const event=await f.request('POST','/meetings/booking-conversation/event',f.command({conversationId:f.conversationId,expectedPolicyRevision:1,event:'confirm_no_show'}));
  expect(event.status,JSON.stringify(event.body)).toBe(409);
  expect((await f.fixture.db.query('SELECT explicit_no_show_at FROM booking_conversations WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,f.conversationId])).rows[0]).toEqual({explicit_no_show_at:null});
  await f.run();expect(f.gmail.sends).toHaveLength(0);
 }finally{await server.close();await f.stop();}
});
