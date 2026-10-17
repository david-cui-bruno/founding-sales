import {z} from 'zod';
import {bookingMessageCommandSchema,type BookingMessageCommand,type BookingMessageView,type BookingMessageKind} from '../../contracts/src/bookingMessages.ts';
import {repositoryContext,workspaceScope,type RepositoryContext} from '../db/workspaceScope.ts';
import {readCurrentBookingConversationForMessages,bookingConversationMessageEligibility,consumeBookingConversationMessage} from './bookingConversation.ts';
import {loadBookingInterpretationSources} from '../crm/bookingInterpretationSources.ts';
import {readCurrentBookingPolicy,bookingPolicySnapshotReadyAt} from './bookingPolicy.ts';
import type {BookingPolicySnapshot} from './bookingPolicyTypes.ts';
import {bookingMessageSenderCurrent,type BookingMessageRuntime,type BookingMessageSenderObservation} from './bookingMessagesRuntime.ts';
import {readMessage} from '../mail/messages.ts';
import {directSendTargetOf} from '../mail/matching.ts';
import {readFirm} from '../crm/firms.ts';
import {decideFirmRead} from '../crm/authorization.ts';
import {coverageRefusal,readMailboxCoverage} from '../mail/coverage.ts';
import {listApplicableHolds} from '../policy/holds.ts';
import {directSendWithinQuietWindow} from '../mail/directSendRecency.ts';
import {composeBodyForWorkspace} from '../outbound/footer.ts';
import {prepareStandingBookingFence,readFence,type OutboundFenceRow} from '../outbound/fence.ts';
import {refuseSend,acceptSend,type SendResult} from '../outbound/types.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {enqueueJob} from '../jobs/jobStore.ts';

interface MessageRow extends Record<string,unknown> {kind:BookingMessageKind;id:string;conversation_id:string;owner_user_id:string;policy_revision:number;source_fingerprint:string;outbound_message_id:string|null;consumed_at:Date|null;reason:string|null}
function bookingMessageText(kind:BookingMessageKind,url:string):string{
 switch(kind){
  case 'clarification':return 'What day and time would work for our call, and in which time zone?';
  case 'approved_link':return `Please choose a time for our call here: ${url}`;
  case 'nudge_3':return `Just following up on arranging our call. You can choose a time here: ${url}`;
  case 'nudge_7':return `One last scheduling follow-up. If you would still like to arrange our call, you can choose a time here: ${url}`;
  case 'no_show':return `Would you like to choose another time for our call? You can rebook here: ${url}`;
 }
}
const limitations=['booking_only','actual_sender_acceptance_unverified','live_enable_not_granted','linkedin_sender_unavailable'];
async function rowById(ctx:RepositoryContext,id:string){return (await ctx.db.query<MessageRow>('SELECT * FROM booking_message_requests WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,id])).rows[0]??null;}
function ownerContext(ctx:RepositoryContext,owner:string){return repositoryContext(workspaceScope(ctx.scope.workspaceId,{kind:'user',userId:owner,role:'admin'}),ctx.db);}

/** All facts are reread from canonical source, saved policy and trusted exact sender composition. */
async function currentMessage(ctx:RepositoryContext,row:Pick<MessageRow,'conversation_id'|'owner_user_id'|'policy_revision'|'source_fingerprint'|'kind'>,runtime:BookingMessageRuntime){
 const owner=ownerContext(ctx,row.owner_user_id);
 const initialPolicy=await readCurrentBookingPolicy(owner,{ownerUserId:row.owner_user_id,expectedRevision:row.policy_revision},runtime.policy);
 if(initialPolicy.kind!=='available')return {ok:false as const,reason:initialPolicy.reason};
 const conversation=await readCurrentBookingConversationForMessages(owner,row.conversation_id,runtime.conversation);
 if(conversation.kind!=='available')return {ok:false as const,reason:conversation.reason};
 const c=conversation.conversation;
 if(c.policyRevision!==row.policy_revision||c.sourceFingerprint!==row.source_fingerprint)return {ok:false as const,reason:'booking_context_changed'};
 if(row.kind==='approved_link'&&(c.state!=='awaiting_time'||!c.outcome||c.outcome.kind!=='approved_link'))return {ok:false as const,reason:'booking_message_not_applicable'};
 if(row.kind!=='approved_link'&&row.kind!=='clarification'){
  const eligibility=await bookingConversationMessageEligibility(owner,{conversationId:row.conversation_id,kind:row.kind,at:runtime.policy.now()},runtime.conversation);
  if(eligibility!==null)return {ok:false as const,reason:eligibility};
 }
 if(row.kind==='clarification'&&(c.state!=='handoff'||c.outcome.kind!=='clarification'||'handoff' in c.outcome))return {ok:false as const,reason:'booking_clarification_not_supported'};
 const sources=await loadBookingInterpretationSources(owner,c.sourceRefs);
 if(!sources||sources.fingerprint!==row.source_fingerprint)return {ok:false as const,reason:'booking_source_unavailable'};
 const original=sources.originals[0]!;
 if(row.kind==='clarification'){
  const ranges=z.array(z.object({kind:z.string(),start:z.number().int(),end:z.number().int()})).safeParse(original.ranges);
  const text=original.passage;
  if(original.direction!=='incoming'||original.completeness!=='complete'||text===null||!ranges.success||ranges.data.length!==1||ranges.data[0]!.kind!=='authored'||ranges.data[0]!.start!==0||ranges.data[0]!.end!==text.length||!/^Yes, let['’]s arrange our call\. What (?:day and time|time) works\?$/iu.test(text.trim()))return {ok:false as const,reason:'booking_clarification_not_supported'};
 }
 const message=await readMessage(owner,original.sourceId),target=message?await directSendTargetOf(owner,message.id):null;
 if(!message||!message.matched||!message.rfcMessageId||!target?.contactId||message.headerFrom!==original.envelope.from||message.listId!==null||message.autoSubmitted!==null&&message.autoSubmitted!=='no')return {ok:false as const,reason:'booking_participant_unverified'};
 const firm=await readFirm(owner,target.firmId);
 if(!firm||firm.status!=='active'||firm.assigned_user_id!==row.owner_user_id||decideFirmRead(owner,firm)!=='assigned_or_admin')return {ok:false as const,reason:'booking_owner_changed'};
 const route=(await ctx.db.query<{id:string;version:number}>(`SELECT id,version FROM email_addresses WHERE workspace_id=$1 AND firm_id=$2 AND contact_id=$3 AND address=$4 AND retired_at IS NULL AND eligibility='usable' AND technical_validation='passed'`,[ctx.scope.workspaceId,firm.id,target.contactId,message.headerFrom])).rows;
 if(route.length!==1)return {ok:false as const,reason:'booking_participant_unverified'};
 const mailbox=(await ctx.db.query<{generation:number;email_address:string;owner_user_id:string;status:string}>(`SELECT generation,email_address,owner_user_id,status FROM mailboxes WHERE workspace_id=$1 AND id=$2`,[ctx.scope.workspaceId,message.mailboxId])).rows[0];
 if(!mailbox||mailbox.owner_user_id!==row.owner_user_id||mailbox.status!=='connected'||!original.envelope.to.includes(mailbox.email_address)||original.envelope.cc.length>0)return {ok:false as const,reason:'booking_sender_unavailable'};
 const coverage=coverageRefusal(await readMailboxCoverage(ctx,{mailboxId:message.mailboxId}));
 if(coverage)return {ok:false as const,reason:coverage.reason};
 const holds=await listApplicableHolds(ctx,{actionKind:'email_send',firmId:firm.id,opportunityId:target.opportunityId??undefined,ownerUserId:row.owner_user_id,mailboxId:message.mailboxId,channel:'email'});
 if(holds.length)return {ok:false as const,reason:'booking_sending_held'};
 if(await directSendWithinQuietWindow(ctx,{firmId:firm.id,contactId:target.contactId}))return {ok:false as const,reason:'direct_send_quiet_window'};
 const later=(await ctx.db.query(`SELECT 1 FROM mail_messages newer WHERE newer.workspace_id=$1 AND newer.mailbox_id=$2 AND newer.provider_thread_id=$3 AND newer.id<>$4 AND newer.internal_date>$5::timestamptz AND NOT (newer.direction='outgoing' AND EXISTS(SELECT 1 FROM outbound_messages fenced JOIN booking_message_requests own ON own.workspace_id=fenced.workspace_id AND own.outbound_message_id=fenced.id WHERE fenced.workspace_id=newer.workspace_id AND fenced.mailbox_id=newer.mailbox_id AND fenced.origin_kind='standing_booking' AND own.conversation_id=$6 AND own.owner_user_id=$7 AND own.consumed_at IS NOT NULL AND (fenced.provider_message_id=newer.provider_message_id OR fenced.provider_message_id_header=('<'||newer.rfc_message_id||'>')))) LIMIT 1`,[ctx.scope.workspaceId,message.mailboxId,message.providerThreadId,message.id,message.internalDate,row.conversation_id,row.owner_user_id])).rows.length>0;
 if(later)return {ok:false as const,reason:'booking_thread_changed'};
 const policy=await readCurrentBookingPolicy(owner,{ownerUserId:row.owner_user_id,expectedRevision:row.policy_revision},runtime.policy);
 if(policy.kind!=='available'||!bookingPolicySnapshotReadyAt(policy.snapshot,runtime.policy.now()))return {ok:false as const,reason:'booking_policy_unavailable'};
 const sender=await runtime.readSender(owner,policy.snapshot);
 if(!bookingMessageSenderCurrent(sender,policy.snapshot,runtime.policy.now()))return {ok:false as const,reason:'booking_sender_unavailable'};
 // A sender observation may wait. Reobserve exact current policy and conversation before admitting it.
 const finalPolicy=await readCurrentBookingPolicy(owner,{ownerUserId:row.owner_user_id,expectedRevision:row.policy_revision,expectedBindingKey:policy.snapshot.bindingKey},runtime.policy);
 const finalConversation=await readCurrentBookingConversationForMessages(owner,row.conversation_id,runtime.conversation);
 const finalSender=finalPolicy.kind==='available'?await runtime.readSender(owner,finalPolicy.snapshot):null;
 const terminalPolicy=await readCurrentBookingPolicy(owner,{ownerUserId:row.owner_user_id,expectedRevision:row.policy_revision,expectedBindingKey:policy.snapshot.bindingKey},runtime.policy);
 if(finalConversation.kind!=='available'||finalConversation.conversation.sourceFingerprint!==row.source_fingerprint||finalConversation.conversation.state!==c.state||terminalPolicy.kind!=='available'||!bookingPolicySnapshotReadyAt(terminalPolicy.snapshot,runtime.policy.now())||!bookingMessageSenderCurrent(finalSender,terminalPolicy.snapshot,runtime.policy.now())||finalSender!.mailboxId!==message.mailboxId||finalSender!.generation!==mailbox.generation||finalSender!.accountBinding!==original.accountBinding)return {ok:false as const,reason:'booking_sender_unavailable'};
 return {ok:true as const,value:{message,original,target,firm,route:route[0]!,policy:terminalPolicy.snapshot,sender:finalSender!,body:bookingMessageText(row.kind,terminalPolicy.snapshot.bindings.event.bookingUrl)}};
}

export async function requestBookingMessage(ctx:RepositoryContext,input:BookingMessageCommand,runtime?:BookingMessageRuntime){
 if(!bookingMessageCommandSchema.safeParse(input).success)return {ok:false as const,reason:'invalid_input'};
 if(ctx.scope.actor.kind!=='user')return {ok:false as const,reason:'owner_required'};
 return requestCurrentBookingMessage(ctx,input,runtime);
}
async function requestCurrentBookingMessage(ctx:RepositoryContext,input:Pick<BookingMessageCommand,'conversationId'|'kind'>,runtime?:BookingMessageRuntime){
 if(!runtime)return {ok:false as const,reason:'booking_sender_unavailable'};
 await lockSendGateForStopFact(ctx);
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`booking-message:${ctx.scope.workspaceId}:${input.conversationId}`]);
 const conversation=await readCurrentBookingConversationForMessages(ctx,input.conversationId,runtime.conversation);
 if(conversation.kind!=='available')return {ok:false as const,reason:conversation.reason};
 const c=conversation.conversation;
 const old=(await ctx.db.query<MessageRow>('SELECT * FROM booking_message_requests WHERE workspace_id=$1 AND conversation_id=$2 AND source_fingerprint=$3 AND kind=$4',[ctx.scope.workspaceId,input.conversationId,c.sourceFingerprint,input.kind])).rows[0];
 if(old){const receipt=await readBookingMessage(ctx,old.id);return receipt?{ok:true as const,value:receipt}:{ok:false as const,reason:'booking_message_unavailable'};}
 const identity={kind:input.kind,conversation_id:input.conversationId,owner_user_id:c.ownerUserId,policy_revision:c.policyRevision,source_fingerprint:c.sourceFingerprint};
 const current=await currentMessage(ctx,identity,runtime);if(!current.ok)return current;
 const v=current.value,body=await composeBodyForWorkspace(ctx,{body:v.body,signOff:''});if(!body.composed)return {ok:false as const,reason:body.reason};
 const row=(await ctx.db.query<MessageRow>(`INSERT INTO booking_message_requests(workspace_id,conversation_id,owner_user_id,kind,policy_revision,source_fingerprint) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[ctx.scope.workspaceId,input.conversationId,c.ownerUserId,input.kind,c.policyRevision,c.sourceFingerprint])).rows[0]!;
 const prepared=await prepareStandingBookingFence(ctx,{draftId:row.id,mailboxId:v.message.mailboxId,firmId:v.firm.id,contactId:v.target.contactId!,opportunityId:v.target.opportunityId??null,address:v.message.headerFrom!,routeId:v.route.id,routeVersion:v.route.version,subject:`Re: ${(v.message.subject??'Our call').replace(/^Re:\s*/iu,'')}`,body:body.body,sourceZone:v.firm.time_zone??'America/New_York'});
 if(!prepared.ok)throw new Error(`booking_fence_preparation:${prepared.reason}`);
 await ctx.db.query('UPDATE booking_message_requests SET outbound_message_id=$3 WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,row.id,prepared.value.outboundMessageId]);
 await enqueueJob(ctx.db,{workspaceId:ctx.scope.workspaceId,kind:'booking.message_send',idempotencyKey:`booking-message:${row.id}`,payload:{messageId:row.id}});
 return {ok:true as const,value:(await readBookingMessage(ctx,row.id))!};
}

/** Worker-only orchestration. Owner identity is read from the durable aggregate, not supplied by a caller. */
export async function requestBookingStandingMessage(ctx:RepositoryContext,input:Pick<BookingMessageCommand,'conversationId'|'kind'>,runtime?:BookingMessageRuntime){
 if(ctx.scope.actor.kind!=='system'||ctx.scope.actor.component!=='worker')return {ok:false as const,reason:'booking_worker_required'};
 const row=(await ctx.db.query<{owner_user_id:string}>('SELECT owner_user_id FROM booking_conversations WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,input.conversationId])).rows[0];
 if(!row)return {ok:false as const,reason:'booking_conversation_unavailable'};
 // Existing canonical copy reads are owner-scoped. This creates no human decision, session, approval or permission row.
 return requestCurrentBookingMessage(ownerContext(ctx,row.owner_user_id),input,runtime);
}
export async function readBookingMessage(ctx:RepositoryContext,id:string):Promise<BookingMessageView|null>{
 const row=await rowById(ctx,id);if(!row||ctx.scope.actor.kind!=='user'||row.owner_user_id!==ctx.scope.actor.userId)return null;
 const fence=row.outbound_message_id?await readFence(ctx,row.outbound_message_id):null;
 return {messageId:row.id,conversationId:row.conversation_id,kind:row.kind,state:fence?.state==='prepared'?'queued':fence?.state??'unavailable',reason:row.reason??fence?.heldReason??null,outboundMessageId:row.outbound_message_id,providerMessageId:fence?.providerMessageId??null,sentAt:fence?.sentAt??null,limitations};
}
export async function decideBookingMessagePermission(ctx:RepositoryContext,fence:OutboundFenceRow,runtime?:BookingMessageRuntime):Promise<SendResult<{policy:BookingPolicySnapshot;sender:BookingMessageSenderObservation}>>{
 if(!runtime||!fence.draftId)return refuseSend('step_ineligible','booking_sender_unavailable');
 const row=await rowById(ctx,fence.draftId);
 if(!row||row.outbound_message_id!==fence.id||row.consumed_at!==null)return refuseSend('step_ineligible','booking_message_consumed');
 const current=await currentMessage(ctx,row,runtime);if(!current.ok)return refuseSend('step_ineligible',current.reason);
 const v=current.value;
 if(fence.mailboxId!==v.message.mailboxId||fence.firmId!==v.firm.id||fence.contactId!==v.target.contactId||fence.recipientAddress!==v.message.headerFrom||fence.recipientRouteId!==v.route.id||fence.recipientRouteVersion!==v.route.version)return refuseSend('step_ineligible','booking_envelope_changed');
 const composed=await composeBodyForWorkspace(ctx,{body:v.body,signOff:''});
 if(!composed.composed||composed.body!==fence.body||fence.subject!==`Re: ${(v.message.subject??'Our call').replace(/^Re:\s*/iu,'')}`)return refuseSend('step_ineligible','booking_content_changed');
 if(!runtime||!bookingPolicySnapshotReadyAt(v.policy,runtime.policy.now())||!bookingMessageSenderCurrent(v.sender,v.policy,runtime.policy.now()))return refuseSend('step_ineligible','booking_authority_expired');
 return acceptSend({policy:v.policy,sender:v.sender});
}
export async function consumeBookingMessagePermission(ctx:RepositoryContext,fence:OutboundFenceRow,runtime?:BookingMessageRuntime):Promise<boolean>{
 const permission=await decideBookingMessagePermission(ctx,fence,runtime);if(!permission.ok||!runtime)return false;
 const {policy,sender}=permission.value;
 const row=fence.draftId?await rowById(ctx,fence.draftId):null;if(!row)return false;
 if(row.kind!=='approved_link'&&row.kind!=='clarification'){
  const reason=await consumeBookingConversationMessage(ownerContext(ctx,row.owner_user_id),{conversationId:row.conversation_id,kind:row.kind,at:runtime.policy.now()},runtime.conversation);
  if(reason!==null)return false;
 }
 const owner=ownerContext(ctx,row.owner_user_id);
 const afterWaitPolicy=await readCurrentBookingPolicy(owner,{ownerUserId:row.owner_user_id,expectedRevision:row.policy_revision,expectedBindingKey:policy.bindingKey},runtime.policy);
 if(afterWaitPolicy.kind!=='available')return false;
 const afterWaitSender=await runtime.readSender(owner,afterWaitPolicy.snapshot);
 const terminalPolicy=await readCurrentBookingPolicy(owner,{ownerUserId:row.owner_user_id,expectedRevision:row.policy_revision,expectedBindingKey:policy.bindingKey},runtime.policy);
 if(terminalPolicy.kind!=='available'||!bookingMessageSenderCurrent(afterWaitSender,terminalPolicy.snapshot,runtime.policy.now())||afterWaitSender!.mailboxId!==sender.mailboxId||afterWaitSender!.generation!==sender.generation||afterWaitSender!.accountBinding!==sender.accountBinding)return false;
 const finalPolicy=terminalPolicy.snapshot,finalSender=afterWaitSender!;
 const consumed=(await ctx.db.query(`UPDATE booking_message_requests SET consumed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND consumed_at IS NULL AND outbound_message_id=$3 AND clock_timestamp()<$4::timestamptz AND clock_timestamp()<$5::timestamptz RETURNING id`,[ctx.scope.workspaceId,fence.draftId,fence.id,finalSender.validUntil,finalPolicy.authorityValidUntil])).rows.length===1;
 // Pure terminal expiry after the final database await. Caller rolls back claim and reservation on false.
 return consumed&&bookingPolicySnapshotReadyAt(finalPolicy,runtime.policy.now())&&bookingMessageSenderCurrent(finalSender,finalPolicy,runtime.policy.now());
}
export async function bookingMessageEnvelope(ctx:RepositoryContext,fence:OutboundFenceRow,runtime?:BookingMessageRuntime){
 if(!runtime||!fence.draftId)return null;
 const row=await rowById(ctx,fence.draftId);if(!row)return null;
 const current=await currentMessage(ctx,row,runtime);if(!current.ok)return null;
 const message=current.value.message,header=(s:string)=>`<${s.replace(/^<|>$/gu,'')}>`;
 return {to:message.headerFrom!,cc:[] as readonly string[],threadId:message.providerThreadId,inReplyTo:header(message.rfcMessageId!),references:[...new Set([...message.referenceMessageIds,message.rfcMessageId!])].map(header)};
}
export async function bookingMessageFenceId(ctx:RepositoryContext,id:string){return (await rowById(ctx,id))?.outbound_message_id??null;}
export async function refuseBookingMessage(ctx:RepositoryContext,id:string,reason:string){await ctx.db.query('UPDATE booking_message_requests SET reason=$3 WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,id,reason]);}
