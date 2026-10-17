import {expect} from 'vitest';
import type {BookingPolicyBindings} from '@fss/contracts';
import type {BookingPolicyRuntime} from '@fss/domain/meetings/bookingPolicyTypes.ts';
import {bookingCreateSourceFixture} from './bookingCreateFixture.ts';
import {setupBookingMessageSender} from './bookingMessageFixture.ts';
import {createBookingInterpretationAuthority} from '@fss/domain/crm/bookingInterpretationAuthority.ts';
import {createBookingInterpretationModel} from '../../../worker/src/providers/bookingInterpretationModel.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {registerHandlers} from '../../../worker/src/bootstrap/main.ts';
import {runOnce} from '../../../worker/src/runner/jobRunner.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {recordMessage} from '@fss/domain/mail/messages.ts';
import {recordMatches,findMatchCandidates} from '@fss/domain/mail/matching.ts';
import {dispatch} from '../../src/server.ts';

/** Real canonical capture, authenticated commands and registered jobs. Only existing sender infrastructure is seeded. */
export async function bookingStopsFixture(){
 const base=await bookingCreateSourceFixture();
 try{
 const bindings:BookingPolicyBindings={ownerUserId:base.fixture.alpha.admin.userId,account:{provider:'calcom',accountId:'9',email:'owner@booking.example',generation:1},event:{eventTypeId:7,bookingUrl:'https://cal.com/controlled/booking',configurationRevision:'controlled-event-1'},calendars:[{credentialId:3,externalId:'controlled-calendar'}],source:{scopeRevision:'controlled-source-1',dataScope:'necessary_booking_context_attendee_selected_freebusy',dataHandlingVersion:'minimized-1'},sender:{channel:'email',accountId:base.binding,authorityRevision:'controlled-sender-1'},model:{providerKey:'aws_bedrock',route:'us.anthropic.claude-haiku-4-5-20251001-v1:0',modelVersion:'anthropic.claude-haiku-4-5-20251001-v1:0',accountBinding:'controlled-bedrock',consentRevision:'controlled-consent',purpose:'booking_interpretation',qualityReviewRevision:'controlled-quality',selection:'initial_haiku'},budget:{lane:'booking',timeZone:'America/New_York',dailyCeilingCents:200,monthlyCeilingCents:2500}};
 let clock='2026-10-13T17:00:00Z';
 const policy:BookingPolicyRuntime={now:()=>clock,readEvidence:async()=>({evidenceKind:'controlled',binding:bindings,verifiedAt:'2026-10-13T16:00:00Z',validUntil:'2099-01-01T00:00:00Z',accountAccess:true,calendarFreeBusy:true,eventSettings:true,modelConsent:true,modelAcceptance:true,senderAuthority:true,sourceAuthority:true,providerAdapter:true,releaseReady:true,funding:{status:'verified',sharedRemainingDailyCents:200,sharedRemainingMonthlyCents:2500}})};
 expect((await base.request('POST','/meetings/booking-policy',base.command({action:'save',expectedRevision:0,bindings}))).status).toBe(200);
 expect((await base.request('POST','/settings/update',base.command({settingKey:'calendar_integration',value:{integration:'calcom'}}))).status).toBe(200);
 expect((await base.request('POST','/opportunities/v2/open',base.command({firmId:base.firmId,name:'Agreed call'}))).status).toBe(200);
 const authority=createBookingInterpretationAuthority(policy),conversation={policy,interpretationAuthority:authority};
 const sender=await setupBookingMessageSender(base,policy,bindings,conversation);
 const ctx=repositoryContext(workspaceScope(base.fixture.alpha.workspaceId,{kind:'user',userId:base.fixture.alpha.admin.userId,role:'admin'}),base.fixture.db);
 const metadata=await withTransaction(base.fixture.db,()=>recordMessage(ctx,{mailboxId:base.mailbox.id,metadata:{providerMessageId:'booking-source-1',providerThreadId:'booking-thread',rfcMessageId:'controlled-interest@booking.example',direction:'incoming',internalDate:'2026-10-13T16:00:00Z',headerFrom:'prospect@booking.example',headerTo:['owner@booking.example'],headerCc:[],subject:'Agreed call',referenceMessageIds:[],inReplyTo:null,autoSubmitted:null,listId:null,labelIds:['INBOX'],attachments:[]}}));
 await withTransaction(base.fixture.db,async()=>recordMatches(ctx,{messageId:metadata.message.id,candidates:await findMatchCandidates(ctx,{mailboxId:base.mailbox.id,messageId:metadata.message.id,metadata:{...metadata.message,headerTo:['owner@booking.example'],headerCc:[],labelIds:['INBOX'],attachments:[]}})}));
 const text='Yes, let us arrange our call.',source=await base.capture(text);
 const model=createBookingInterpretationModel({accountBinding:'controlled-bedrock',fundingVerifiedUntil:'2099-01-01T00:00:00Z',surface:{endpointId:'bedrock-runtime.us-east-1.amazonaws.com',converse:async()=>({stopReason:'end_turn',usage:{inputTokens:40,outputTokens:20},output:{message:{role:'assistant',content:[{text:JSON.stringify({intent:'interest',agreement:{sourceId:source.sourceId,start:0,end:text.length,quote:text},slot:null,substantive:null})}]}}})}});
 const request=async(method:string,path:string,body?:unknown)=>{const url=new URL(path,'https://fixture.test');return dispatch({method,path:url.pathname,query:url.searchParams,body,headers:{authorization:`Bearer ${base.token}`}},{session:base.db,auth:{...base.fixture.deps,db:base.db},supportedClientVersions:base.fixture.deps.config.supportedClientVersions,sendingEnabled:false,bookingMessages:sender.runtime,bookingConversation:conversation,bookingInterpretationAuthority:authority});};
 const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,bookingInterpretation:{authority,model},bookingConversation:conversation,bookingMessages:sender.runtime});
 const run=async()=>{const result=await runOnce(base.fixture.db,{registry,owner:'booking-stops-worker',limit:30});expect(result.failed).toBe(0);};
 const interpret=async()=>{const requested=await request('POST','/crm/booking/interpretation/request',base.command({source,priorSources:[]}));expect(requested.status,JSON.stringify(requested.body)).toBe(200);await run();return (requested.body as {result:{requestId:string}}).result.requestId;};
 const admit=async(interpretationRequestId:string)=>{const admitted=await request('POST','/meetings/booking-conversation',base.command({interpretationRequestId,expectedPolicyRevision:1}));expect(admitted.status,JSON.stringify(admitted.body)).toBe(200);return (admitted.body as {result:{conversationId:string}}).result.conversationId;};
 const firstInterpretation=await interpret(),conversationId=await admit(firstInterpretation);
 return {...base,...sender,ctx,policy,conversation,request,run,source,interpret,admit,firstInterpretation,conversationId,setClock:(at:string)=>{clock=at;},stop:()=>base.fixture.stop()};
 }catch(error){await base.fixture.stop();throw error;}
}
