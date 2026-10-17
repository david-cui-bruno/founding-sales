import {describe,it,expect} from 'vitest';
import {bookingCreateSourceFixture} from './support/bookingCreateFixture.ts';
import {wireDrift,type BookingPolicyBindings} from '@fss/contracts';
import type {BookingPolicyRuntime} from '@fss/domain/meetings/bookingPolicyTypes.ts';
import {dispatch} from '../src/server.ts';
import {createBookingInterpretationAuthority} from '@fss/domain/crm/bookingInterpretationAuthority.ts';
import {createBookingInterpretationModel} from '../../worker/src/providers/bookingInterpretationModel.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {recordMessage} from '@fss/domain/mail/messages.ts';
import {recordMatches} from '@fss/domain/mail/matching.ts';
import {setupBookingMessageSender} from './support/bookingMessageFixture.ts';
import {bookingMessageViewSchema} from '../../../packages/contracts/src/bookingMessages.ts';

/** Public commands and normal worker path drive all booking behavior. SQL below seeds only existing mailbox/release infrastructure. */
async function setupMessages(options:{text?:string;intent?:'interest'|'clarify'|'conditional';malformed?:boolean}={}){
 const base=await bookingCreateSourceFixture();
 const bindings:BookingPolicyBindings={ownerUserId:base.fixture.alpha.admin.userId,account:{provider:'calcom',accountId:'9',email:'owner@booking.example',generation:1},event:{eventTypeId:7,bookingUrl:'https://cal.com/controlled/booking',configurationRevision:'controlled-event-1'},calendars:[{credentialId:3,externalId:'controlled-calendar'}],source:{scopeRevision:'controlled-source-1',dataScope:'necessary_booking_context_attendee_selected_freebusy',dataHandlingVersion:'minimized-1'},sender:{channel:'email',accountId:base.binding,authorityRevision:'controlled-sender-1'},model:{providerKey:'aws_bedrock',route:'us.anthropic.claude-haiku-4-5-20251001-v1:0',modelVersion:'anthropic.claude-haiku-4-5-20251001-v1:0',accountBinding:'controlled-bedrock',consentRevision:'controlled-consent',purpose:'booking_interpretation',qualityReviewRevision:'controlled-quality',selection:'initial_haiku'},budget:{lane:'booking',timeZone:'America/New_York',dailyCeilingCents:200,monthlyCeilingCents:2500}};
 let clock='2026-10-13T17:00:00Z';
 const policy:BookingPolicyRuntime={now:()=>clock,readEvidence:async()=>({evidenceKind:'controlled',binding:bindings,verifiedAt:'2026-10-13T16:00:00Z',validUntil:'2099-01-01T00:00:00Z',accountAccess:true,calendarFreeBusy:true,eventSettings:true,modelConsent:true,modelAcceptance:true,senderAuthority:true,sourceAuthority:true,providerAdapter:true,releaseReady:true,funding:{status:'verified',sharedRemainingDailyCents:200,sharedRemainingMonthlyCents:2500}})};
 const f={...base,bindings,runtime:{policy},setClock:(at:string)=>{clock=at;},stop:()=>base.fixture.stop()};
 expect((await f.request('POST','/meetings/booking-policy',f.command({action:'save',expectedRevision:0,bindings}))).status).toBe(200);
 const authority=createBookingInterpretationAuthority(f.runtime.policy);
 const conversation={policy:f.runtime.policy,interpretationAuthority:authority};
 const {runtime,gmail,gmailFixture}=await setupBookingMessageSender(base,policy,bindings,conversation);
 const ctx=repositoryContext(workspaceScope(f.fixture.alpha.workspaceId,{kind:'user',userId:f.fixture.alpha.admin.userId,role:'admin'}),f.fixture.db);
 const request=async(method:string,path:string,body?:unknown)=>{const url=new URL(path,'https://fixture.test');return dispatch({method,path:url.pathname,query:url.searchParams,body,headers:{authorization:`Bearer ${f.token}`}},{session:f.db,auth:{...f.fixture.deps,db:f.db},supportedClientVersions:f.fixture.deps.config.supportedClientVersions,sendingEnabled:false,bookingMessages:runtime,bookingConversation:conversation,bookingInterpretationAuthority:authority});};
 // Normal metadata admission precedes canonical body capture, preserving the real RFC thread envelope.
 const metadata=await withTransaction(f.fixture.db,()=>recordMessage(ctx,{mailboxId:f.mailbox.id,metadata:{providerMessageId:'booking-source-1',providerThreadId:'booking-thread',rfcMessageId:'controlled-interest@booking.example',direction:'incoming',internalDate:'2026-10-13T16:00:00.000Z',headerFrom:'prospect@booking.example',headerTo:['owner@booking.example'],headerCc:[],subject:'Agreed call',referenceMessageIds:[],inReplyTo:null,autoSubmitted:null,listId:null,labelIds:['INBOX'],attachments:[]}}));
 const stage=(await f.fixture.db.query<{id:string}>('SELECT id FROM pipeline_stages WHERE workspace_id=$1 ORDER BY position LIMIT 1',[f.fixture.alpha.workspaceId])).rows[0]!;
 const opportunity=(await f.fixture.db.query<{id:string}>('INSERT INTO opportunities(workspace_id,firm_id,stage_id,control_mode_changed_at) VALUES($1,$2,$3,now()) RETURNING id',[f.fixture.alpha.workspaceId,f.firmId,stage.id])).rows[0]!;
 await withTransaction(f.fixture.db,()=>recordMatches(ctx,{messageId:metadata.message.id,candidates:[{firmId:f.firmId,contactId:f.contactId,opportunityId:opportunity.id,rule:'participant',viaClosedOpportunity:false}]}));
 const text=options.text??'Can we arrange a call?',source=await f.capture(text);
 const model=createBookingInterpretationModel({accountBinding:'controlled-bedrock',fundingVerifiedUntil:'2099-01-01T00:00:00Z',surface:{endpointId:'bedrock-runtime.us-east-1.amazonaws.com',converse:async()=>({stopReason:'end_turn',usage:{inputTokens:40,outputTokens:20},output:{message:{role:'assistant',content:[{text:JSON.stringify(options.malformed?{unexpected:'not-authority'}:{intent:options.intent??'interest',agreement:{sourceId:source.sourceId,start:0,end:text.length,quote:text},slot:null,substantive:null})}]}}})}});
 const interpretation=await request('POST','/crm/booking/interpretation/request',f.command({source,priorSources:[]}));expect(interpretation.status,JSON.stringify(interpretation.body)).toBe(200);
 const interpretationRequestId=(interpretation.body as {result:{requestId:string}}).result.requestId;
 const registry=()=>registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,bookingInterpretation:{authority,model},bookingConversation:conversation,bookingMessages:runtime});
 const run=async()=>{const result=await runOnce(f.fixture.db,{registry:registry(),owner:'booking-message-normal-worker',limit:30});expect(result.failed).toBe(0);return result;};
 await run();
 const admitted=await request('POST','/meetings/booking-conversation',f.command({interpretationRequestId,expectedPolicyRevision:1}));expect(admitted.status,JSON.stringify(admitted.body)).toBe(200);
 const conversationId=(admitted.body as {result:{conversationId:string}}).result.conversationId;
 const send=()=>request('POST','/meetings/booking-messages',f.command({conversationId,kind:'approved_link'}));
 const read=(messageId:string)=>request('GET',`/meetings/booking-messages?messageId=${messageId}`);
 return {...f,runtime,source,conversationId,gmail,gmailFixture,request,send,read,run};
}
const idOf=(body:unknown)=>(body as {result:{messageId:string}}).result.messageId;
describe('standing booking source-native controlled send',()=>{
 it('sends only a whole-source unconditional scheduling clarification in the original thread once',async()=>{
  const f=await setupMessages({text:"Yes, let's arrange our call. What day and time works?",intent:'clarify'});try{
   const requested=await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.conversationId,kind:'clarification'}));expect(requested.status,JSON.stringify(requested.body)).toBe(200);await f.run();
   expect((await f.read(idOf(requested.body))).body).toMatchObject({state:'sent',kind:'clarification'});expect(f.gmail.sends).toHaveLength(1);expect(f.gmail.sends[0]!.body).toContain('What day and time would work for our call, and in which time zone?');expect(f.gmail.sends[0]!.threadId).toBe('booking-thread');
   const replay=await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.conversationId,kind:'clarification'}));expect(idOf(replay.body)).toBe(idOf(requested.body));await f.run();expect(f.gmail.sends).toHaveLength(1);
  }finally{await f.stop();}
 });
 it.each([{text:'What does the product cost?',malformed:true},{text:"Yes, let's arrange our call if the product is free. What time works?",intent:'conditional' as const},{text:"Yes, let's arrange our call. What day and time works? What does the product cost?",intent:'clarify' as const}])('never uses a generic malformed, conditional or sales clarification as send authority: $text',async options=>{
  const f=await setupMessages(options);try{
   expect((await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.conversationId,kind:'clarification'}))).status).toBe(409);await f.run();expect(f.gmail.sends).toHaveLength(0);
  }finally{await f.stop();}
 });
 it('reobserves sender authority after a real aggregate row-lock wait and rolls back the shared nudge count',async()=>{
  const f=await setupMessages();const blocker=await f.fixture.database.appRuntimeSession(),observer=await f.fixture.database.appRuntimeSession();let running:Promise<unknown>|undefined;
  try{
   f.setClock('2026-10-16T17:00:00Z');const requested=await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.conversationId,kind:'nudge_3'}));expect(requested.status).toBe(200);
   const pid=(await f.fixture.db.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
   await blocker.query('BEGIN');await blocker.query('SELECT id FROM booking_conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[f.fixture.alpha.workspaceId,f.conversationId]);
   running=f.run();let observed=false;
   for(let attempt=0;attempt<100000&&!observed;attempt++)observed=(await observer.query<{blocked:boolean}>('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[pid])).rows[0]!.blocked;
   expect(observed,JSON.stringify((await observer.query("SELECT pid,wait_event_type,wait_event,query FROM pg_stat_activity WHERE datname=current_database()" )).rows)).toBe(true);f.runtime.readSender=async()=>null;await blocker.query('ROLLBACK');await running;running=undefined;
   expect(f.gmail.sends).toHaveLength(0);expect((await f.read(idOf(requested.body))).body).toMatchObject({state:'held',reason:'booking_permission_changed'});
   expect((await f.request('GET',`/meetings/booking-conversation?conversationId=${f.conversationId}`)).body).toMatchObject({nudgeCount:0,state:'awaiting_time'});
  }finally{await blocker.query('ROLLBACK');if(running)await running;await f.stop();}
 });
 it('retains the existing separate mailbox cap rather than treating booking authority as extra capacity',async()=>{
  const f=await setupMessages();try{
   const requested=await f.send();expect(requested.status).toBe(200);
   // Existing sender infrastructure already exhausted its first-ramp daily capacity. No booking state is seeded.
   await f.fixture.db.query(`INSERT INTO mailbox_send_days(workspace_id,mailbox_id,business_date,automated_sent,cap_granted) VALUES($1,$2,'2026-10-13',100,100)`,[f.fixture.alpha.workspaceId,f.mailbox.id]);
   await f.run();expect(f.gmail.sends).toHaveLength(0);expect((await f.read(idOf(requested.body))).body).toMatchObject({state:'held',reason:'automated 100/5'});
  }finally{await f.stop();}
 });
 it('keeps the ordinary email window even for a standing booking link',async()=>{
  const f=await setupMessages();try{
   const requested=await f.send();expect(requested.status).toBe(200);f.setClock('2026-10-14T02:00:00Z');
   await f.run();expect(f.gmail.sends).toHaveLength(0);expect((await f.read(idOf(requested.body))).body).toMatchObject({state:'held',reason:'America/New_York 2026-10-13'});
  }finally{await f.stop();}
 });
 it('a current explicit opt-out stops a queued link without spending standing authority',async()=>{
  const f=await setupMessages();try{
   const requested=await f.send();expect(requested.status).toBe(200);
   expect((await f.request('POST','/meetings/booking-conversation/event',f.command({conversationId:f.conversationId,expectedPolicyRevision:1,event:'opt_out'}))).status).toBe(200);
   await f.run();expect(f.gmail.sends).toHaveLength(0);expect((await f.read(idOf(requested.body))).body).toMatchObject({state:'held'});
  }finally{await f.stop();}
 });
 it('does not admit a day-three nudge before its canonical agreement time',async()=>{
  const f=await setupMessages();try{
   expect(await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.conversationId,kind:'nudge_3'}))).toMatchObject({status:409,body:{reason:'booking_nudge_not_due'}});
   expect(f.gmail.sends).toHaveLength(0);
  }finally{await f.stop();}
 });
 it('sends only the bounded day-three and day-seven nudges and hands the shared conversation back',async()=>{
  const f=await setupMessages();try{
   f.setClock('2026-10-16T17:00:00Z');
   const first=await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.conversationId,kind:'nudge_3'}));expect(first.status,JSON.stringify(first.body)).toBe(200);await f.run();expect((await f.read(idOf(first.body))).body).toMatchObject({state:'sent',kind:'nudge_3'});
   const afterFirst=await f.request('GET',`/meetings/booking-conversation?conversationId=${f.conversationId}`);expect(afterFirst.body).toMatchObject({nudgeCount:1,state:'awaiting_time'});
   f.setClock('2026-10-20T17:00:00Z');
   const second=await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.conversationId,kind:'nudge_7'}));expect(second.status,JSON.stringify(second.body)).toBe(200);await f.run();expect((await f.read(idOf(second.body))).body).toMatchObject({state:'sent',kind:'nudge_7'});
   expect((await f.request('GET',`/meetings/booking-conversation?conversationId=${f.conversationId}`)).body).toMatchObject({nudgeCount:2,state:'handoff',reason:'two_unanswered_booking_nudges'});
   await f.run();expect(f.gmail.sends).toHaveLength(2);
  }finally{await f.stop();}
 });
 it('counts a manual nudge in the same aggregate and any reply stops the remaining queued touch',async()=>{
  const f=await setupMessages();try{
   expect((await f.request('POST','/meetings/booking-conversation/event',f.command({conversationId:f.conversationId,expectedPolicyRevision:1,event:'manual_nudge'}))).status).toBe(200);
   f.setClock('2026-10-16T17:00:00Z');expect(await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.conversationId,kind:'nudge_3'}))).toMatchObject({status:409,body:{reason:'booking_nudge_already_counted'}});
   f.setClock('2026-10-20T17:00:00Z');const last=await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.conversationId,kind:'nudge_7'}));expect(last.status).toBe(200);
   expect((await f.request('POST','/meetings/booking-conversation/event',f.command({conversationId:f.conversationId,expectedPolicyRevision:1,event:'reply'}))).status).toBe(200);
   await f.run();expect(f.gmail.sends).toHaveLength(0);expect((await f.read(idOf(last.body))).body).toMatchObject({state:'held'});
  }finally{await f.stop();}
 });
 it('does not infer a no-show from meeting interest or elapsed time',async()=>{
  const f=await setupMessages();try{
   f.setClock('2026-10-16T17:00:00Z');const reply=await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.conversationId,kind:'no_show'}));expect(reply.status).toBe(409);expect(f.gmail.sends).toHaveLength(0);
  }finally{await f.stop();}
 });
 it('refuses missing and mismatched current sender observations without calling Gmail',async()=>{
  const f=await setupMessages();try{
   f.runtime.readSender=async()=>null;
   expect(await f.send()).toMatchObject({status:409,body:{reason:'booking_sender_unavailable'}});
   expect(f.gmail.sends).toHaveLength(0);
  }finally{await f.stop();}
 });
 it('rechecks policy revocation after OAuth rather than spending cached booking authority',async()=>{
  const f=await setupMessages();try{
   const requested=await f.send();expect(requested.status).toBe(200);const id=idOf(requested.body);
   const refresh=f.gmail.refreshAccessToken;let waited=false;
   f.gmail.refreshAccessToken=async(...args)=>{waited=true;expect((await f.request('POST','/meetings/booking-policy',f.command({action:'revoke',expectedRevision:1}))).status).toBe(200);return refresh(...args);};
   await f.run();expect(waited).toBe(true);expect(f.gmail.sends).toHaveLength(0);
   expect((await f.read(id)).body).toMatchObject({state:'held',reason:'policy_revoked'});
  }finally{await f.stop();}
 });
 it('rechecks sender disappearance after OAuth',async()=>{
  const f=await setupMessages();try{
   const requested=await f.send();expect(requested.status).toBe(200);const id=idOf(requested.body);
   const refresh=f.gmail.refreshAccessToken;let waited=false;
   f.gmail.refreshAccessToken=async(...args)=>{waited=true;f.runtime.readSender=async()=>null;return refresh(...args);};
   await f.run();expect(waited).toBe(true);expect(f.gmail.sends).toHaveLength(0);
   expect((await f.read(id)).body).toMatchObject({state:'held',reason:'booking_sender_unavailable'});
  }finally{await f.stop();}
 });
 it('source deletion prevents a queued message without erasing the body-free receipt',async()=>{
  const f=await setupMessages();try{
   const requested=await f.send();expect(requested.status).toBe(200);const id=idOf(requested.body);
   expect((await f.request('POST','/crm/business/mail/delete',f.command({sourceId:f.source.sourceId,expectedRevision:1}))).status).toBe(200);
   await f.run();expect(f.gmail.sends).toHaveLength(0);
   expect((await f.read(id)).body).toMatchObject({messageId:id,state:'held'});
   expect(JSON.stringify((await f.read(id)).body)).not.toContain('Can we arrange');
  }finally{await f.stop();}
 });
 it('unknown external acceptance survives a fresh command and restarted worker without replay',async()=>{
  const f=await setupMessages();try{
   const requested=await f.send();expect(requested.status).toBe(200);const id=idOf(requested.body);
   f.gmail.sendMessage=async()=>({ok:false,outcome:'indeterminate',detail:'controlled-response-lost'});
   let sends=0;const lost=f.gmail.sendMessage;f.gmail.sendMessage=async(...args)=>{sends++;return lost(...args);};
   await f.run();expect((await f.read(id)).body).toMatchObject({state:'reconciling'});
   expect(idOf((await f.send()).body)).toBe(id);await f.run();expect(sends).toBe(1);
  }finally{await f.stop();}
 });
 it('sends approved link in original thread once through normal registered worker and receipt readback',async()=>{
  const f=await setupMessages();try{
   const requested=await f.send();expect(requested.status,JSON.stringify(requested.body)).toBe(200);expect(requested.body).toMatchObject({result:{state:'queued'}});
   const requestedView=(requested.body as {result:unknown}).result;
   expect(wireDrift(bookingMessageViewSchema,requestedView)).toEqual([]);
   const id=idOf(requested.body);await f.run();
   const read=await f.read(id);expect(read.status).toBe(200);expect(read.body).toMatchObject({state:'sent',providerMessageId:expect.any(String),sentAt:expect.any(String)});
   expect(wireDrift(bookingMessageViewSchema,read.body)).toEqual([]);
   // Compatible additions remain readable on the desktop, while route tests
   // independently detect any undeclared fields in the actual server DTO.
   const extended={...bookingMessageViewSchema.parse(read.body),informational:'future-compatible-field'};
   expect(bookingMessageViewSchema.safeParse(extended).success).toBe(true);
   expect(wireDrift(bookingMessageViewSchema,extended)).toContain('informational: not declared by the contract');
   expect(f.gmail.sends).toHaveLength(1);expect(f.gmail.sends[0]).toMatchObject({to:'prospect@booking.example',threadId:'booking-thread',inReplyTo:'<controlled-interest@booking.example>',subject:'Re: Agreed call'});expect(f.gmail.sends[0]!.body).toContain(f.bindings.event.bookingUrl);
   expect(f.gmail.sends[0]!.body).not.toMatch(/pricing|product|objection/iu);
   const replay=await f.send();expect(replay.status).toBe(200);expect(idOf(replay.body)).toBe(id);
   expect(wireDrift(bookingMessageViewSchema,(replay.body as {result:unknown}).result)).toEqual([]);
   await f.run();expect(f.gmail.sends).toHaveLength(1);
  }finally{await f.stop();}
 });
});
