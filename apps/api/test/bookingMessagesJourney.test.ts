import {randomBytes} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {bookingCreateSourceFixture} from './support/bookingCreateFixture.ts';
import type {BookingPolicyBindings} from '@fss/contracts';
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
import {recordedGmailClient,type GmailFixture} from '@fss/domain/mail/gmailClientFake.ts';
import {localEnvelopeCipher} from '@fss/domain/mail/envelope.ts';
import {storeRefreshToken} from '@fss/domain/mail/tokens.ts';
import {mailConfig} from '../../../packages/domain/test/mail/support/mailWorld.ts';
import {storeFixtureCiGateRecord,FIXTURE_CI_COMMIT,FIXTURE_WORKER_DIGEST} from '../../../packages/domain/test/release/support/releaseRecords.ts';
import {ciGateReleaseReference} from '@fss/contracts';
import type {BookingMessageRuntime} from '@fss/domain/meetings/bookingMessagesRuntime.ts';
import {bookingMessageViewSchema} from '../../../packages/contracts/src/bookingMessages.ts';

/** Public commands and normal worker path drive all booking behavior. SQL below seeds only existing mailbox/release infrastructure. */
async function setupMessages(){
 const base=await bookingCreateSourceFixture();
 const bindings:BookingPolicyBindings={ownerUserId:base.fixture.alpha.admin.userId,account:{provider:'calcom',accountId:'9',email:'owner@booking.example',generation:1},event:{eventTypeId:7,bookingUrl:'https://cal.com/controlled/booking',configurationRevision:'controlled-event-1'},calendars:[{credentialId:3,externalId:'controlled-calendar'}],source:{scopeRevision:'controlled-source-1',dataScope:'necessary_booking_context_attendee_selected_freebusy',dataHandlingVersion:'minimized-1'},sender:{channel:'email',accountId:base.binding,authorityRevision:'controlled-sender-1'},model:{providerKey:'aws_bedrock',route:'us.anthropic.claude-haiku-4-5-20251001-v1:0',modelVersion:'anthropic.claude-haiku-4-5-20251001-v1:0',accountBinding:'controlled-bedrock',consentRevision:'controlled-consent',purpose:'booking_interpretation',qualityReviewRevision:'controlled-quality',selection:'initial_haiku'},budget:{lane:'booking',timeZone:'America/New_York',dailyCeilingCents:200,monthlyCeilingCents:2500}};
 let clock='2026-10-13T17:00:00Z';
 const policy:BookingPolicyRuntime={now:()=>clock,readEvidence:async()=>({evidenceKind:'controlled',binding:bindings,verifiedAt:'2026-10-13T16:00:00Z',validUntil:'2026-10-14T20:00:00Z',accountAccess:true,calendarFreeBusy:true,eventSettings:true,modelConsent:true,modelAcceptance:true,senderAuthority:true,sourceAuthority:true,providerAdapter:true,releaseReady:true,funding:{status:'verified',sharedRemainingDailyCents:200,sharedRemainingMonthlyCents:2500}})};
 const f={...base,bindings,runtime:{policy},setClock:(at:string)=>{clock=at;},stop:()=>base.fixture.stop()};
 expect((await f.request('POST','/meetings/booking-policy',f.command({action:'save',expectedRevision:0,bindings}))).status).toBe(200);
 const authority=createBookingInterpretationAuthority(f.runtime.policy);
 const conversation={policy:f.runtime.policy,interpretationAuthority:authority};
 const gmailFixture:GmailFixture={emailAddress:'owner@booking.example',historyId:'1000',messages:[],refreshToken:randomBytes(24).toString('base64url')};
 const gmail=recordedGmailClient(gmailFixture),cipher=localEnvelopeCipher('booking-message-controlled');
 const config=mailConfig(),ctx=repositoryContext(workspaceScope(f.fixture.alpha.workspaceId,{kind:'user',userId:f.fixture.alpha.admin.userId,role:'admin'}),f.fixture.db);
 const runtime:BookingMessageRuntime={policy:f.runtime.policy,conversation,send:{gmail,cipher,oauth:{...config,clientSecret:randomBytes(24).toString('base64url')},deploymentSendingEnabled:true,workerImageDigest:FIXTURE_WORKER_DIGEST,now:()=>new Date(f.runtime.policy.now())},readSender:async()=>({mailboxId:f.mailbox.id,accountBinding:f.binding,generation:1,authorityRevision:f.bindings.sender.authorityRevision,verifiedAt:'2026-10-13T16:00:00Z',validUntil:'2026-10-14T20:00:00Z',maximumCents:0,reference:'controlled-configured-zero-cost-not-actual-gmail-evidence'})};
 const request=async(method:string,path:string,body?:unknown)=>{const url=new URL(path,'https://fixture.test');return dispatch({method,path:url.pathname,query:url.searchParams,body,headers:{authorization:`Bearer ${f.token}`}},{session:f.db,auth:{...f.fixture.deps,db:f.db},supportedClientVersions:f.fixture.deps.config.supportedClientVersions,sendingEnabled:false,bookingMessages:runtime,bookingConversation:conversation,bookingInterpretationAuthority:authority});};
 await f.fixture.db.query(`UPDATE mailboxes SET sync_state='ready',history_id='1000',history_id_updated_at=now(),baseline_from_at=now()-interval '30 days',baseline_completed_at=now(),coverage_watermark_at=now() WHERE workspace_id=$1 AND id=$2`,[f.fixture.alpha.workspaceId,f.mailbox.id]);
 await storeRefreshToken(ctx,{mailboxId:f.mailbox.id,plaintext:gmailFixture.refreshToken!,cipher});
 await f.fixture.db.query(`INSERT INTO sending_domains(workspace_id,domain,is_primary,spf_pass,dkim_pass,dmarc_pass,authentication_checked_at,authentication_checked_by_user_id,postmaster_reviewed_at,automated_sending_enabled,automated_sending_enabled_at) VALUES($1,'booking.example',true,true,true,true,now(),$2,now(),true,now())`,[f.fixture.alpha.workspaceId,f.fixture.alpha.admin.userId]);
 await storeFixtureCiGateRecord(f.fixture.db,'6240001');
 await f.fixture.db.query(`INSERT INTO workspace_settings(workspace_id,setting_key,version,value,change_note,changed_by_user_id) VALUES($1,'sending_enabled',1,$2::jsonb,'controlled sender infrastructure',$3)`,[f.fixture.alpha.workspaceId,JSON.stringify({enabled:true,releaseGateReference:ciGateReleaseReference('6240001',FIXTURE_CI_COMMIT)}),f.fixture.alpha.admin.userId]);
 // Normal metadata admission precedes canonical body capture, preserving the real RFC thread envelope.
 const metadata=await withTransaction(f.fixture.db,()=>recordMessage(ctx,{mailboxId:f.mailbox.id,metadata:{providerMessageId:'booking-source-1',providerThreadId:'booking-thread',rfcMessageId:'controlled-interest@booking.example',direction:'incoming',internalDate:'2026-10-13T16:00:00.000Z',headerFrom:'prospect@booking.example',headerTo:['owner@booking.example'],headerCc:[],subject:'Agreed call',referenceMessageIds:[],inReplyTo:null,autoSubmitted:null,listId:null,labelIds:['INBOX'],attachments:[]}}));
 const stage=(await f.fixture.db.query<{id:string}>('SELECT id FROM pipeline_stages WHERE workspace_id=$1 ORDER BY position LIMIT 1',[f.fixture.alpha.workspaceId])).rows[0]!;
 const opportunity=(await f.fixture.db.query<{id:string}>('INSERT INTO opportunities(workspace_id,firm_id,stage_id,control_mode_changed_at) VALUES($1,$2,$3,now()) RETURNING id',[f.fixture.alpha.workspaceId,f.firmId,stage.id])).rows[0]!;
 await withTransaction(f.fixture.db,()=>recordMatches(ctx,{messageId:metadata.message.id,candidates:[{firmId:f.firmId,contactId:f.contactId,opportunityId:opportunity.id,rule:'participant',viaClosedOpportunity:false}]}));
 const text='Can we arrange a call?',source=await f.capture(text);
 const model=createBookingInterpretationModel({accountBinding:'controlled-bedrock',fundingVerifiedUntil:'2026-10-14T20:00:00Z',surface:{endpointId:'bedrock-runtime.us-east-1.amazonaws.com',converse:async()=>({stopReason:'end_turn',usage:{inputTokens:40,outputTokens:20},output:{message:{role:'assistant',content:[{text:JSON.stringify({intent:'interest',agreement:{sourceId:source.sourceId,start:0,end:text.length,quote:text},slot:null,substantive:null})}]}}})}});
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
   const id=idOf(requested.body);await f.run();
   const read=await f.read(id);expect(read.body).toMatchObject({state:'sent',providerMessageId:expect.any(String),sentAt:expect.any(String)});expect(bookingMessageViewSchema.safeParse(read.body).success).toBe(true);
   expect(f.gmail.sends).toHaveLength(1);expect(f.gmail.sends[0]).toMatchObject({to:'prospect@booking.example',threadId:'booking-thread',inReplyTo:'<controlled-interest@booking.example>',subject:'Re: Agreed call'});expect(f.gmail.sends[0]!.body).toContain(f.bindings.event.bookingUrl);
   expect(f.gmail.sends[0]!.body).not.toMatch(/pricing|product|objection/iu);
   expect(idOf((await f.send()).body)).toBe(id);await f.run();expect(f.gmail.sends).toHaveLength(1);
  }finally{await f.stop();}
 });
});
