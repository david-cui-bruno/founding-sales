import {expect} from 'vitest';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {registerHandlers} from '../../../worker/src/bootstrap/main.ts';
import {runOnce} from '../../../worker/src/runner/jobRunner.ts';
import {createBookingInterpretationModel} from '../../../worker/src/providers/bookingInterpretationModel.ts';
import {createBookingInterpretationAuthority} from '@fss/domain/crm/bookingInterpretationAuthority.ts';
import type {BookingPolicyBindings} from '@fss/contracts';
import type {BookingCreateRuntime} from '@fss/domain/meetings/bookingCreateRuntime.ts';
import {bookingCreateSourceFixture} from './bookingCreateFixture.ts';
import {createHash,randomUUID} from 'node:crypto';
import {enqueueJob,claimJobs} from '@fss/domain/jobs/jobStore.ts';
import {workspaceScope,repositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {recordMessage} from '@fss/domain/mail/messages.ts';
import {recordMatches,findMatchCandidates} from '@fss/domain/mail/matching.ts';

export async function captureAt(f:Awaited<ReturnType<typeof bookingCreateSourceFixture>>,text:string,providerAt:string,subject='Agreed call'){
 const key=randomUUID();
 const ctx=repositoryContext(workspaceScope(f.fixture.alpha.workspaceId,{kind:'user',userId:f.fixture.alpha.admin.userId,role:'admin'}),f.fixture.db);
 const observed={providerMessageId:key,providerThreadId:'booking-thread',rfcMessageId:`${key}@booking.example`,direction:'incoming' as const,internalDate:providerAt,headerFrom:'prospect@booking.example',headerTo:['owner@booking.example'],headerCc:[],subject,referenceMessageIds:[],inReplyTo:null,autoSubmitted:null,listId:null,labelIds:['INBOX'],attachments:[]};
 const metadata=await withTransaction(f.fixture.db,()=>recordMessage(ctx,{mailboxId:f.mailbox.id,metadata:observed}));
 const matched=await withTransaction(f.fixture.db,async()=>recordMatches(ctx,{messageId:metadata.message.id,candidates:await findMatchCandidates(ctx,{mailboxId:f.mailbox.id,messageId:metadata.message.id,metadata:observed})}));
 expect(matched.ambiguous).toBe(false);expect(matched.candidates).toHaveLength(1);expect(metadata.message.rfcMessageId).toBe(observed.rfcMessageId);
 await enqueueJob(f.fixture.db,{workspaceId:f.fixture.alpha.workspaceId,kind:'crm.mail_capture',idempotencyKey:key,payload:{mailboxId:f.mailbox.id,providerMessageId:key,providerAccountId:'controlled-google',generation:1,conversationId:(await f.fixture.db.query<{id:string}>('SELECT id FROM crm_business_conversations WHERE workspace_id=$1 AND mailbox_id=$2 AND provider_thread_id=$3',[f.fixture.alpha.workspaceId,f.mailbox.id,'booking-thread'])).rows[0]!.id,controlsRevision:1,policyRevision:1,decisionRevision:0}});
 const job=(await claimJobs(f.fixture.db,{owner:key,kinds:['crm.mail_capture'],limit:1,leaseSeconds:120}))[0]!;
 const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailCapture:{proofVerifier:{verify:async proof=>proof.grantReceipt==='fixture-grant'&&proof.accountBinding===f.binding},provider:{read:async()=>({providerAccountId:'controlled-google',messageId:key,threadId:'booking-thread',labels:['INBOX'],origin:'received',providerAt,rawSenderDate:null,from:'prospect@booking.example',to:['owner@booking.example'],cc:[],subject,body:text,parserVersion:'controlled-mime-v1',representation:'plain_text',completeness:'complete',ranges:[{start:0,end:text.length,kind:'authored'}]})}}});
 const input={session:f.fixture.db,scope:workspaceScope(f.fixture.alpha.workspaceId,{kind:'system' as const,component:'worker' as const}),job};
 const result=await registry.get('crm.mail_capture')!.handle(input);
 expect(result).toMatchObject({progress:{outcome:'captured',sourceId:expect.any(String)}});
 const sourceId=String(result?.progress['sourceId']);
 const source={sourceId,sourceRevision:1,contentHash:createHash('sha256').update(text).digest('hex')};
 expect((await f.request('POST','/crm/business/mail/read',source)).body).toMatchObject({state:'available',source:{passage:text}});
 return {source,replay:()=>registry.get('crm.mail_capture')!.handle(input)};
}

export async function setupConversation(){
 const f=await bookingCreateSourceFixture();
 try{
  const opened=await f.request('POST','/opportunities/v2/open',f.command({firmId:f.firmId,name:'Booking conversation'}));
  expect(opened.status,JSON.stringify(opened.body)).toBe(200);
  const bindings:BookingPolicyBindings={ownerUserId:f.fixture.alpha.admin.userId,account:{provider:'calcom',accountId:'9',email:'owner@booking.example',generation:1},event:{eventTypeId:7,bookingUrl:'https://cal.com/controlled/booking',configurationRevision:'controlled-event-1'},calendars:[{credentialId:3,externalId:'controlled-calendar'}],source:{scopeRevision:'controlled-source-1',dataScope:'necessary_booking_context_attendee_selected_freebusy',dataHandlingVersion:'minimized-1'},sender:{channel:'email',accountId:f.binding,authorityRevision:'controlled-sender-1'},model:{providerKey:'aws_bedrock',route:'us.anthropic.claude-haiku-4-5-20251001-v1:0',modelVersion:'anthropic.claude-haiku-4-5-20251001-v1:0',accountBinding:'controlled-bedrock',consentRevision:'controlled-consent',purpose:'booking_interpretation',qualityReviewRevision:'controlled-quality',selection:'initial_haiku'},budget:{lane:'booking',timeZone:'America/New_York',dailyCeilingCents:200,monthlyCeilingCents:2500}};
  const now=new Date().toISOString(),verifiedAt=new Date(Date.now()-60_000).toISOString(),validUntil=new Date(Date.now()+7*86400_000).toISOString();
  const target=new Date();target.setUTCDate(target.getUTCDate()+2);target.setUTCHours(15,0,0,0);while([0,6].includes(target.getUTCDay()))target.setUTCDate(target.getUTCDate()+1);
  const startsAt=target.toISOString(),endsAt=new Date(target.getTime()+20*60_000).toISOString();
  const localDate=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(target),localTime=new Intl.DateTimeFormat('en-GB',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(target);
  const providerCalls:{submissionId:string;startsAt:string}[]=[];
  const runtime:BookingCreateRuntime={policy:{now:()=> new Date().toISOString(),readEvidence:async()=>({evidenceKind:'controlled',binding:bindings,verifiedAt,validUntil,accountAccess:true,calendarFreeBusy:true,eventSettings:true,modelConsent:true,modelAcceptance:true,senderAuthority:true,sourceAuthority:true,providerAdapter:true,releaseReady:true,funding:{status:'verified',sharedRemainingDailyCents:200,sharedRemainingMonthlyCents:2500}})},readCostContract:async()=>({accountId:'9',eventTypeId:7,operationScope:'availability_create_inspection',maximumCents:0,verifiedAt,validUntil,reference:'controlled-zero-cost-contract'}),provider:{availability:async()=>({available:true,reason:null}),create:async call=>{providerCalls.push({submissionId:call.submissionId,startsAt:call.startsAt});return {state:'accepted',booking:{uid:'standing-booking',id:31,startsAt:call.startsAt,endsAt,attendeeEmail:call.attendee.email,attendeeName:call.attendee.name,eventTypeId:7,accountId:9,organizerEmail:'owner@booking.example',updatedAt:now,submissionId:call.submissionId}};},inspect:async()=>({state:'unknown',reason:'not_found'})}};
  f.runtimeOptions.bookingCreate=runtime;f.runtimeOptions.bookingPolicyRuntime=runtime.policy;
  const authority=createBookingInterpretationAuthority(runtime.policy);
  const conversation={policy:runtime.policy,interpretationAuthority:authority,create:runtime};
  Object.assign(f.runtimeOptions,{bookingInterpretationAuthority:authority,bookingConversation:conversation});
  expect((await f.request('POST','/meetings/booking-policy',f.command({action:'save',expectedRevision:0,bindings}))).status).toBe(200);
  expect((await f.request('POST','/settings/update',f.command({settingKey:'calendar_integration',value:{integration:'calcom'}}))).status).toBe(200);
  const offerText=`Can you join ${localDate} at ${localTime} America/New_York for a 20 minute call?`;
  const incomingText='Yes, that works. What does Callie cost?';
  const offer=await f.capture(offerText,'outgoing'),{source}=await captureAt(f,incomingText,'2026-10-13T16:00:00.000Z');
  const interpreted=await f.request('POST','/crm/booking/interpretation/request',f.command({source,priorSources:[offer]}));
  expect(interpreted.status).toBe(200);
  const requestId=(interpreted.body as {result:{requestId:string}}).result.requestId;
  const evidence=(sourceId:string,quote:string,start=0)=>({sourceId,start,end:start+quote.length,quote});
  let candidate:unknown={intent:'accept_slot',agreement:evidence(source.sourceId,'Yes, that works.'),slot:{localDate,localTime,timeZone:'America/New_York',evidence:evidence(offer.sourceId,offerText)},substantive:evidence(source.sourceId,'What does Callie cost?',17)};
  const model=createBookingInterpretationModel({accountBinding:'controlled-bedrock',fundingVerifiedUntil:validUntil,surface:{endpointId:'bedrock-runtime.us-east-1.amazonaws.com',converse:async()=>({stopReason:'end_turn',usage:{inputTokens:40,outputTokens:20},output:{message:{role:'assistant',content:[{text:JSON.stringify(candidate)}]}}})}});
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,bookingInterpretation:{authority,model},bookingCreate:runtime,bookingConversation:conversation});
  await runOnce(f.db,{registry,owner:'conversation-interpreter',limit:20});
  const admissionCommand=f.command({interpretationRequestId:requestId,expectedPolicyRevision:1});
  const admitted=await f.request('POST','/meetings/booking-conversation',admissionCommand);
  expect(admitted.status,JSON.stringify(admitted.body)).toBe(200);
  const conversationId=(admitted.body as {result:{conversationId:string}}).result.conversationId;
  return {...f,bindings,runtime,conversation,registry,conversationId,admissionCommand,source,offer,startsAt,providerCalls,setCandidate:(value:unknown)=>{candidate=value;}};
 }catch(error){await f.fixture.stop();throw error;}
}
