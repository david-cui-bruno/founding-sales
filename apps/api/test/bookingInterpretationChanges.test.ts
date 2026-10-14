import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { bookingInterpretationOutcomeSchema, bookingInterpretationViewSchema, wireDrift, type BookingPolicyBindings } from '@fss/contracts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { enqueueJob, claimJobs } from '@fss/domain/jobs/jobStore.ts';
import { businessAccountBinding } from '@fss/domain/business/acquisition.ts';
import { workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { createBookingInterpretationAuthority, type BookingInterpretationAuthorityPort } from '@fss/domain/crm/bookingInterpretationAuthority.ts';
import { registerHandlers } from '../../worker/src/bootstrap/main.ts';
import { runOnce } from '../../worker/src/runner/jobRunner.ts';
import { createBookingInterpretationModel } from '../../worker/src/providers/bookingInterpretationModel.ts';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

let fixture: AuthFixture;
let token: string;
let authority: BookingInterpretationAuthorityPort | undefined;
const command = (body: object) => ({ commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, ...body });
const post = async (path: string, body: unknown) => dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,...authority ? {bookingInterpretationAuthority:authority} : {}});
beforeEach(async () => { authority=undefined; fixture=await createAuthFixture(); token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken; });
afterEach(async () => { await fixture.stop(); });

/** Same canonical capture seam as the existing interpretation controls, not inserted interpretation rows. */
async function capture(text:string, outgoing=false, authoredLength=text.length) {
 const workspaceId=fixture.alpha.workspaceId, ownerUserId=fixture.alpha.admin.userId, key=randomUUID();
 let mailbox=(await fixture.db.query<{id:string;owner_user_id:string;email_address:string;provider_account_id:string;generation:number;status:string}>('SELECT * FROM mailboxes WHERE workspace_id=$1 AND owner_user_id=$2',[workspaceId,ownerUserId])).rows[0];
 const fresh=mailbox===undefined;
 mailbox??=(await fixture.db.query<NonNullable<typeof mailbox>>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,$3,$4,'connected') RETURNING *",[workspaceId,ownerUserId,`${key}@example.test`,key])).rows[0]!;
 const binding=businessAccountBinding(workspaceId,mailbox)!;
 if(fresh){
  await fixture.db.query('INSERT INTO crm_business_policies(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled) VALUES($1,$2,$3,$4,$5,1,1,false)',[workspaceId,mailbox.id,ownerUserId,key,binding]);
  await fixture.db.query("INSERT INTO crm_business_conversations(workspace_id,mailbox_id,owner_user_id,account_binding,provider_thread_id,subject,participants,latest_provider_at,category,reason,classifier_version,metadata_hash) VALUES($1,$2,$3,$4,$5,'Business','[]',now(),'business','fixture','fixture',$6)",[workspaceId,mailbox.id,ownerUserId,binding,key,'a'.repeat(64)]);
  await fixture.db.query("INSERT INTO crm_mail_capture_controls(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled,policy_revision,disclosure_version,disclosure_sha256,grant_receipt,provider_policy_receipt,evaluation_receipt,release_receipt) VALUES($1,$2,$3,$4,$5,1,1,true,1,'controlled-capture',$6,'fixture-grant','fixture-provider','fixture-evaluation','fixture-release')",[workspaceId,mailbox.id,ownerUserId,key,binding,'b'.repeat(64)]);
 }
 const conversation=(await fixture.db.query<{id:string;provider_thread_id:string}>('SELECT id,provider_thread_id FROM crm_business_conversations WHERE workspace_id=$1 AND mailbox_id=$2',[workspaceId,mailbox.id])).rows[0]!;
 await enqueueJob(fixture.db,{workspaceId,kind:'crm.mail_capture',idempotencyKey:key,payload:{mailboxId:mailbox.id,providerMessageId:key,providerAccountId:mailbox.provider_account_id,generation:1,conversationId:conversation.id,controlsRevision:1,policyRevision:1,decisionRevision:0}});
 const job=(await claimJobs(fixture.db,{owner:'change-capture',kinds:['crm.mail_capture'],limit:1,leaseSeconds:120}))[0]!;
 const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailCapture:{proofVerifier:{verify:async proof=>proof.accountBinding===binding&&proof.grantReceipt==='fixture-grant'},provider:{read:async()=>({providerAccountId:mailbox.provider_account_id,messageId:key,threadId:conversation.provider_thread_id,labels:[outgoing?'SENT':'INBOX'],origin:outgoing?'sent':'unknown',providerAt:outgoing?'2026-10-13T13:00:00.000Z':'2026-10-13T14:00:00.000Z',rawSenderDate:outgoing?'Tue, 13 Oct 2026 09:00:00 -0400':'Tue, 13 Oct 2026 10:00:00 -0400',from:outgoing?mailbox.email_address:'casey@example.test',to:[outgoing?'casey@example.test':mailbox.email_address],cc:[],subject:'Call',body:text,parserVersion:'controlled-v1',representation:'plain_text',completeness:'complete',ranges:[{start:0,end:authoredLength,kind:'authored' as const},...(authoredLength===text.length?[]:[{start:authoredLength,end:text.length,kind:'quoted' as const}])]})}}});
 const result=await registry.get('crm.mail_capture')!.handle({session:fixture.db,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job});
 const sourceId=result?.progress['sourceId'];
 if(typeof sourceId!=='string')throw new Error('canonical capture failed');
 return {sourceId,sourceRevision:1,contentHash:createHash('sha256').update(text).digest('hex')};
}
async function interpret(text:string, options:{agreement?:string;slot?:boolean;prior?:string;question?:string;authoredLength?:number}={}) {
 const prior=options.prior?await capture(options.prior,true):undefined;
 const source=await capture(text,false,options.authoredLength);
 const original=await post('/crm/business/mail/read',source);
 expect(original.status).toBe(200);
 const binding=(original.body as {source:{accountBinding:string}}).source.accountBinding;
 const bindings:BookingPolicyBindings={ownerUserId:fixture.alpha.admin.userId,account:{provider:'calcom',accountId:'controlled-calcom',email:'david@example.test',generation:1},event:{eventTypeId:20,bookingUrl:'https://cal.com/controlled/demo',configurationRevision:'controlled-event-v1'},calendars:[{credentialId:1,externalId:'controlled-freebusy'}],source:{scopeRevision:'controlled-booking-scope-v1',dataScope:'necessary_booking_context_attendee_selected_freebusy',dataHandlingVersion:'booking-minimized-v1'},sender:{channel:'email',accountId:binding,authorityRevision:'controlled-sender-v1'},model:{providerKey:'aws_bedrock',route:'us.anthropic.claude-haiku-4-5-20251001-v1:0',modelVersion:'anthropic.claude-haiku-4-5-20251001-v1:0',accountBinding:'controlled-model-account',consentRevision:'controlled-purpose-consent-v1',purpose:'booking_interpretation',qualityReviewRevision:'controlled-quality-v1',selection:'initial_haiku'},budget:{lane:'booking',timeZone:'America/New_York',dailyCeilingCents:200,monthlyCeilingCents:2500}};
 expect((await post('/meetings/booking-policy',command({action:'save',expectedRevision:0,bindings}))).status).toBe(200);
 authority=createBookingInterpretationAuthority({now:()=>new Date().toISOString(),readEvidence:async(_context,observed)=>({evidenceKind:'controlled',binding:observed,verifiedAt:'2026-10-13T00:00:00Z',validUntil:'2099-01-01T00:00:00Z',accountAccess:false,calendarFreeBusy:false,eventSettings:false,modelConsent:true,modelAcceptance:true,senderAuthority:false,sourceAuthority:true,providerAdapter:false,releaseReady:false,funding:{status:'verified',sharedRemainingDailyCents:200,sharedRemainingMonthlyCents:2500}})});
 const requested=await post('/crm/booking/interpretation/request',command({source,priorSources:prior?[prior]:[]}));
 expect(requested.body).toMatchObject({result:{state:'pending',reason:null}});
 const requestId=(requested.body as {result:{requestId:string}}).result.requestId;
 const cite=(quote:string,sourceId=source.sourceId,passage=text)=>({sourceId,start:passage.indexOf(quote),end:passage.indexOf(quote)+quote.length,quote});
 const candidate={intent:'change',agreement:cite(options.agreement??text.slice(0,options.authoredLength)),slot:options.slot?{localDate:'2026-10-20',localTime:'14:00',timeZone:'America/New_York',evidence:prior?cite(options.prior!,prior.sourceId,options.prior!):cite(text)}:null,substantive:options.question?cite(options.question):null};
 const model=createBookingInterpretationModel({accountBinding:'controlled-model-account',fundingVerifiedUntil:'2099-01-01T00:00:00Z',surface:{endpointId:'bedrock-runtime.us-east-1.amazonaws.com',converse:async()=>({stopReason:'end_turn',usage:{inputTokens:40,outputTokens:20},output:{message:{role:'assistant',content:[{text:JSON.stringify(candidate)}]}}})}});
 const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,bookingInterpretation:{authority,model}});
 await runOnce(fixture.db,{registry,owner:'change-interpretation',limit:20});
 const visible=await post('/crm/booking/interpretation/read',{requestId});
 expect(visible.status).toBe(200);
 expect(visible.body).toMatchObject({state:'complete',provenance:{source,participant:'casey@example.test',occurredAt:'2026-10-13T14:00:00.000Z',rawSenderDate:'Tue, 13 Oct 2026 10:00:00 -0400',originalContexts:expect.any(Array)},financial:{state:'settled',settledCents:1}});
 return {visible:visible.body,source,candidate};
}
const requires=['current_attendee_route','unique_current_booking','guarded_change'];
it('canonical capture and registered interpretation produce a cancellation candidate, never authority',async()=>{
 const {visible,candidate}=await interpret('Please cancel our meeting.');
 expect(visible).toMatchObject({outcome:{kind:'change_proposal',action:'cancel',agreement:candidate.agreement,attendeeAddress:'casey@example.test',permission:false,schedulingPaused:false,requires}});
 expect((visible as {outcome:object}).outcome).not.toHaveProperty('slot');
 expect(wireDrift(bookingInterpretationViewSchema,visible)).toEqual([]);
 const outcome=(visible as {outcome:object}).outcome;
 expect(bookingInterpretationOutcomeSchema.safeParse({...outcome,slot:{}}).success).toBe(false);
 expect(bookingInterpretationOutcomeSchema.safeParse({...outcome,permission:true}).success).toBe(false);
 expect(bookingInterpretationOutcomeSchema.safeParse({...outcome,requires:['guarded_change']}).success).toBe(false);
});
it('explicit reschedule with one exact authored replacement slot produces only a guarded candidate',async()=>{
 const {visible,candidate}=await interpret('Please reschedule our meeting to 2026-10-20 at 14:00 America/New_York.',{slot:true});
 expect(visible).toMatchObject({outcome:{kind:'change_proposal',action:'reschedule',slot:candidate.slot,agreement:candidate.agreement,permission:false,schedulingPaused:false,requires}});
 expect(wireDrift(bookingInterpretationViewSchema,visible)).toEqual([]);
 expect(bookingInterpretationOutcomeSchema.safeParse({...((visible as {outcome:object}).outcome),slot:undefined}).success).toBe(false);
});
it('explicit move accepts a uniquely offered exact replacement and preserves a sales-question handoff',async()=>{
 const agreement='Please move our meeting to that time.';const question='What does it cost?';
 const {visible,candidate,source}=await interpret(`${agreement} ${question}`,{agreement,question,slot:true,prior:'Can we reschedule to 2026-10-20 at 14:00 America/New_York?'});
 expect(visible).toMatchObject({outcome:{kind:'change_proposal',action:'reschedule',slot:candidate.slot,permission:false,schedulingPaused:false,handoff:{ownerUserId:fixture.alpha.admin.userId,action:'answer_sales_question',evidence:{sourceId:source.sourceId,quote:question}}}});
 expect(wireDrift(bookingInterpretationViewSchema,visible)).toEqual([]);
});
for(const text of ['Can we change our meeting?','Please reschedule our meeting.','Do not cancel our meeting.','Please cancel our meeting. Actually do not cancel it.','Please cancel our meeting or reschedule it.','Please cancel our meeting. Maybe keep it instead.','Please cancel all our meetings.','Can you cancel our meeting?','I might cancel our meeting.'])it(`fails closed for ambiguous or contradictory authored change: ${text}`,async()=>{
 const {visible}=await interpret(text,{agreement:text.includes('Please cancel our meeting.')?'Please cancel our meeting.':text});
 expect(visible).toMatchObject({outcome:{kind:'clarification',permission:false}});
});
for(const suffix of [' or 2026-10-21 at 15:00 America/New_York.',' Actually do not move it.',' Maybe that time, I am not sure.'])it(`rejects a cropped reschedule citation hiding alternatives or uncertainty: ${suffix}`,async()=>{
 const agreement='Please reschedule our meeting to 2026-10-20 at 14:00 America/New_York.';
 const {visible}=await interpret(agreement+suffix,{agreement,slot:true});
 expect(visible).toMatchObject({outcome:{kind:'clarification',permission:false}});
});
it('conditional cancellation pauses for David rather than granting a change',async()=>{
 const {visible}=await interpret('Please cancel our meeting if the price is above $500.');
 expect(visible).toMatchObject({outcome:{kind:'david_handoff',schedulingPaused:true,permission:false}});
});
it('opt-out in full authored text stops a cropped cancellation candidate',async()=>{
 const {visible}=await interpret('Please cancel our meeting. Do not contact me again.',{agreement:'Please cancel our meeting.'});
 expect(visible).toMatchObject({outcome:{kind:'stop',reason:'refusal',permission:false}});
});
it('quoted cancellation cannot supply authored agreement',async()=>{
 const {visible}=await interpret('Thanks. Please cancel our meeting.',{agreement:'Please cancel our meeting.',authoredLength:7});
 expect(visible).toMatchObject({outcome:{kind:'clarification',permission:false}});
});
it('mixed unconditional cancellation retains a durable sales-question handoff without answering',async()=>{
 const agreement='Please cancel our meeting.',question='What does it cost?';
 const {visible,source}=await interpret(`${agreement} ${question}`,{agreement,question});
 expect(visible).toMatchObject({outcome:{kind:'change_proposal',action:'cancel',permission:false,schedulingPaused:false,handoff:{ownerUserId:fixture.alpha.admin.userId,action:'answer_sales_question',evidence:{sourceId:source.sourceId,quote:question}}}});
 expect(wireDrift(bookingInterpretationViewSchema,visible)).toEqual([]);
});
for(const question of ['Actually postpone it.','Can we postpone the meeting?'])it(`a model sales citation cannot remove contradictory authored logistics: ${question}`,async()=>{
 const agreement='Please cancel our meeting.';
 const {visible}=await interpret(`${agreement} ${question}`,{agreement,question});
 expect(visible).toMatchObject({outcome:{kind:'clarification',permission:false}});
});
it('an ambiguous two-slot prior offer cannot support moving to that time',async()=>{
 const {visible}=await interpret('Please move our meeting to that time.',{slot:true,prior:'Can we reschedule to 2026-10-20 at 14:00 America/New_York or 2026-10-21 at 15:00 America/New_York?'});
 expect(visible).toMatchObject({outcome:{kind:'clarification',permission:false}});
});
