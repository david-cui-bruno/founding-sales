import {bookingInterpretationOutcomeSchema,bookingInterpretationViewSchema,type BookingInterpretationView,type BookingConversationView,type BookingConversationInput} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {BookingPolicyRuntime,BookingPolicySnapshot} from './bookingPolicyTypes.ts';
import type {BookingCreateRuntime} from './bookingCreateRuntime.ts';
import type {BookingChangeRuntime} from './bookingChangeProvider.ts';
import type {BookingMessageRuntime} from './bookingMessagesRuntime.ts';
import {readBookingChange} from './bookingChange.ts';
import {loadBookingInterpretationSources} from '../crm/bookingInterpretationSources.ts';
import {resolveBookingConversationTarget} from './bookingConversationChangeAuthority.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {readCurrentBookingPolicy,bookingPolicySnapshotReadyAt} from './bookingPolicy.ts';
import {readBookingInterpretation,type BookingInterpretationRow} from '../crm/bookingInterpretation.ts';
import type {BookingInterpretationAuthorityPort} from '../crm/bookingInterpretationAuthority.ts';
import {enqueueJob} from '../jobs/jobStore.ts';
import {readBookingCreate} from './bookingCreate.ts';
import {loadBookingConversation,bookingConversationReplyReason,bookingConversationSlotInstant,type BookingConversationRow} from './bookingConversationAuthority.ts';
export interface BookingConversationRuntime {policy:BookingPolicyRuntime;interpretationAuthority:BookingInterpretationAuthorityPort;create?:BookingCreateRuntime;change?:BookingChangeRuntime;messages?:BookingMessageRuntime}
export interface BookingConversationMessageContext {
 conversationId:string;ownerUserId:string;interpretationRequestId:string;policyRevision:number;sourceRefs:BookingInterpretationRow['source_refs'];sourceFingerprint:string;
 outcome:NonNullable<BookingInterpretationView['outcome']>;provenance:NonNullable<BookingInterpretationView['provenance']>;snapshot:BookingPolicySnapshot;
 state:BookingConversationRow['state'];nudgeCount:number;nudgesStoppedAt:string|null;lastReplyAt:string|null;explicitNoShowAt:string|null;noShowRebookingUsed:boolean;createdAt:string;
}
const limitations=['actual_enable_held','linkedin_intake_unavailable','sender_requires_current_supported_adapter','provider_confirmation_and_reminder_unverified'];
const iso=(value:Date|null)=>value?.toISOString()??null;
/** Commands store references only. A cached command receipt can never replay a quote. */
export async function requestBookingConversation(context:RepositoryContext,input:BookingConversationInput,runtime?:BookingConversationRuntime){
 const actor=context.scope.actor;if(actor.kind!=='user'||actor.role!=='admin')return {ok:false as const,reason:'owner_required'};
 if(runtime===undefined)return {ok:false as const,reason:'booking_runtime_unavailable'};
 const read=await readBookingInterpretation(context,{requestId:input.interpretationRequestId},runtime.interpretationAuthority);
 if(read===null||read.state!=='complete'||read.outcome===null)return {ok:false as const,reason:'booking_interpretation_unavailable'};
 const parsed=bookingInterpretationOutcomeSchema.safeParse(read.outcome);if(!parsed.success)return {ok:false as const,reason:'booking_interpretation_unavailable'};
 const policy=await readCurrentBookingPolicy(context,{ownerUserId:actor.userId,expectedRevision:input.expectedPolicyRevision,capability:'booking'},runtime.policy);
 if(policy.kind!=='available')return {ok:false as const,reason:policy.reason};
 if(!bookingPolicySnapshotReadyAt(policy.snapshot,runtime.policy.now()))return {ok:false as const,reason:'booking_readiness_unavailable'};
 const interpreted=(await context.db.query<BookingInterpretationRow>('SELECT * FROM crm_booking_interpretations WHERE workspace_id=$1 AND id=$2 AND requested_by=$3',[context.scope.workspaceId,input.interpretationRequestId,actor.userId])).rows[0]!;
 const snapshot=interpreted.authority_snapshot as BookingPolicySnapshot|null;
 if(snapshot?.policyRevision!==policy.snapshot.policyRevision||snapshot.bindingKey!==policy.snapshot.bindingKey)return {ok:false as const,reason:'booking_policy_changed'};
 const outcome=parsed.data,handoff='handoff' in outcome?outcome.handoff:null;
 let state:BookingConversationRow['state']=outcome.kind==='stop'?'stopped':outcome.kind==='david_handoff'||outcome.kind==='clarification'?'handoff':outcome.kind==='approved_link'?'awaiting_time':'pending';
 let reason:string|null=outcome.kind==='stop'?outcome.reason:outcome.kind==='clarification'?outcome.reason:null;
 let target:{id:string;current_booking_uid:string}|null=null;
 if(outcome.kind==='change_proposal'){
  const loaded=await loadBookingInterpretationSources(context,interpreted.source_refs);
  target=loaded===null?null:await resolveBookingConversationTarget(context,{attendeeAddress:outcome.attendeeAddress,agreementQuote:outcome.agreement.quote,source:loaded.originals[0]!,snapshot:policy.snapshot,at:runtime.policy.now()});
  if(target===null||input.meetingId!==undefined&&(input.meetingId!==target.id||input.expectedBookingUid!==target.current_booking_uid)){target=null;state='handoff';reason='standing_booking_ambiguous';}
 }
 const row=(await context.db.query<BookingConversationRow>(`INSERT INTO booking_conversations(workspace_id,owner_user_id,interpretation_request_id,policy_revision,binding_key,source_fingerprint,source_refs,state,reason,handoff_action,nudges_stopped_at,source_conversation_id,target_meeting_id,target_booking_uid) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,CASE WHEN $8 IN ('stopped','handoff') THEN now() ELSE NULL END,(SELECT conversation_id FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=$11),$12,$13) ON CONFLICT(workspace_id,owner_user_id,interpretation_request_id) DO UPDATE SET interpretation_request_id=EXCLUDED.interpretation_request_id RETURNING *`,[context.scope.workspaceId,actor.userId,interpreted.id,policy.snapshot.policyRevision,policy.snapshot.bindingKey,interpreted.source_fingerprint,JSON.stringify(interpreted.source_refs),state,reason,handoff?.action??(state==='handoff'?'review_booking':null),interpreted.source_refs[0]!.sourceId,target?.id??null,target?.current_booking_uid??null])).rows[0]!;
 if(row.state==='pending'||row.state==='awaiting_time'&&runtime.messages!==undefined||outcome.kind==='clarification'&&runtime.messages!==undefined)await enqueueJob(context.db,{workspaceId:context.scope.workspaceId,kind:'meeting.booking_conversation',idempotencyKey:`booking-conversation:${row.id}`,payload:{conversationId:row.id}});
 const admittedView=bookingInterpretationViewSchema.safeParse(read);
 if(row.state==='awaiting_time'&&runtime.messages!==undefined&&admittedView.success&&admittedView.data.provenance!==null)await enqueueConversationFollowup(context,row.id,'nudge_3',admittedView.data.provenance.occurredAt);
 return {ok:true as const,value:{conversationId:row.id}};
}
/** Current source and policy are required for every use of a private interpretation. */
export async function readCurrentBookingConversationForMessages(context:RepositoryContext,id:string,runtime:BookingConversationRuntime):Promise<{kind:'available';conversation:BookingConversationMessageContext}|{kind:'unavailable';reason:string}>{
 const row=await loadBookingConversation(context,id);if(row===null)return {kind:'unavailable',reason:'booking_conversation_unavailable'};
 if(['stale','stopped','unknown'].includes(row.state))return {kind:'unavailable',reason:row.reason??'booking_conversation_stopped'};
 const replyReason=await bookingConversationReplyReason(context,row);if(replyReason!==null)return {kind:'unavailable',reason:replyReason};
 const read=await readBookingInterpretation(context,{requestId:row.interpretation_request_id},runtime.interpretationAuthority);
 const view=bookingInterpretationViewSchema.safeParse(read);
 const parsed=bookingInterpretationOutcomeSchema.safeParse(read?.outcome);
 if(!view.success||view.data.state!=='complete'||view.data.provenance===null||!parsed.success)return {kind:'unavailable',reason:'booking_source_or_interpretation_changed'};
 const interpretation=(await context.db.query<BookingInterpretationRow>('SELECT * FROM crm_booking_interpretations WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,row.interpretation_request_id])).rows[0];
 if(interpretation?.source_fingerprint!==row.source_fingerprint)return {kind:'unavailable',reason:'booking_source_changed'};
 const policy=await readCurrentBookingPolicy(context,{ownerUserId:row.owner_user_id,expectedRevision:row.policy_revision,expectedBindingKey:row.binding_key,capability:'booking'},runtime.policy);
 if(policy.kind!=='available'||!bookingPolicySnapshotReadyAt(policy.snapshot,runtime.policy.now()))return {kind:'unavailable',reason:policy.kind==='unavailable'?policy.reason:'booking_readiness_unavailable'};
 return {kind:'available',conversation:{conversationId:row.id,ownerUserId:row.owner_user_id,interpretationRequestId:row.interpretation_request_id,policyRevision:row.policy_revision,sourceRefs:row.source_refs,sourceFingerprint:row.source_fingerprint,outcome:parsed.data,provenance:view.data.provenance,snapshot:policy.snapshot,state:row.state,nudgeCount:row.nudge_count,nudgesStoppedAt:iso(row.nudges_stopped_at),lastReplyAt:iso(row.last_reply_at),explicitNoShowAt:iso(row.explicit_no_show_at),noShowRebookingUsed:row.no_show_rebooking_used,createdAt:row.created_at.toISOString()}};
}
export async function readBookingConversation(context:RepositoryContext,id:string,runtime?:BookingConversationRuntime,authorize?:()=>Promise<boolean>):Promise<BookingConversationView|null>{
 const row=await loadBookingConversation(context,id);if(row===null)return null;
 let current=runtime===undefined?{kind:'unavailable' as const,reason:'booking_runtime_unavailable'}:await readCurrentBookingConversationForMessages(context,id,runtime);
 const booking=row.create_submission_id===null?null:await readBookingCreate(context,row.create_submission_id);
 const change=row.change_submission_id===null?null:await readBookingChange(context,row.change_submission_id);
 if(authorize!==undefined&&!await authorize())return null;
 if(current.kind==='available'&&runtime!==undefined&&!bookingPolicySnapshotReadyAt(current.conversation.snapshot,runtime.policy.now()))current={kind:'unavailable',reason:'booking_readiness_unavailable'};
 const outcome=current.kind==='available'?current.conversation.outcome:null;
 const handoff=current.kind==='available'&&'handoff' in current.conversation.outcome?current.conversation.outcome.handoff:null;
 const state=current.kind==='unavailable'?row.state==='stopped'?'stopped':row.state==='handoff'&&['new_reply_requires_interpretation','reply_order_unknown'].includes(current.reason)?'handoff':'stale':change?.state==='accepted'?change.action==='cancel'?'cancelled':'rescheduled':change?.state==='unknown'?'unknown':change?.state==='failed'?'handoff':booking?.state==='accepted'?'booked':booking?.state==='unknown'?'unknown':booking?.state==='failed'?'handoff':row.state;
 return {conversationId:row.id,interpretationRequestId:row.interpretation_request_id,policyRevision:row.policy_revision,origin:'standing_policy',enabled:false,state,reason:current.kind==='unavailable'?current.reason:change?.reason??booking?.reason??row.reason,outcome,handoff:handoff??(row.handoff_action!==null&&(current.kind==='available'||state==='handoff')?{ownerUserId:row.owner_user_id,action:row.handoff_action}:null),booking,change,nudgeCount:row.nudge_count,nudgesStoppedAt:iso(row.nudges_stopped_at),lastReplyAt:iso(row.last_reply_at),explicitNoShowAt:iso(row.explicit_no_show_at),noShowRebookingUsed:row.no_show_rebooking_used,limitations};
}
/** Manual activity shares the exact same aggregate counters as automated messages. */
export async function recordBookingConversationEvent(context:RepositoryContext,input:{conversationId:string;expectedPolicyRevision:number;event:'manual_nudge'|'reply'|'refusal'|'opt_out'|'confirm_no_show'},runtime?:BookingConversationRuntime){
 if(runtime===undefined)return {ok:false as const,reason:'booking_runtime_unavailable'};
 await lockSendGateForStopFact(context);
 const initial=await loadBookingConversation(context,input.conversationId);if(initial===null)return {ok:false as const,reason:'booking_conversation_unavailable'};
 if(initial.policy_revision!==input.expectedPolicyRevision)return {ok:false as const,reason:'booking_policy_changed'};
 const current=await readCurrentBookingConversationForMessages(context,input.conversationId,runtime);
 if(current.kind!=='available'&&['manual_nudge','confirm_no_show'].includes(input.event))return {ok:false as const,reason:current.reason};
 const row=(await context.db.query<BookingConversationRow>('SELECT * FROM booking_conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[context.scope.workspaceId,input.conversationId])).rows[0]!;
 if(input.event==='manual_nudge'){
  if(row.state!=='awaiting_time'||row.nudges_stopped_at!==null||row.nudge_count>=2)return {ok:false as const,reason:'booking_nudges_stopped'};
  await context.db.query("UPDATE booking_conversations SET nudge_count=nudge_count+1,state=CASE WHEN nudge_count=1 THEN 'handoff' ELSE state END,handoff_action=CASE WHEN nudge_count=1 THEN 'review_booking' ELSE handoff_action END,nudges_stopped_at=CASE WHEN nudge_count=1 THEN now() ELSE nudges_stopped_at END,updated_at=now() WHERE workspace_id=$1 AND id=$2",[context.scope.workspaceId,row.id]);
  if(row.nudge_count===0&&runtime.messages!==undefined&&current.kind==='available')await enqueueConversationFollowup(context,row.id,'nudge_7',current.conversation.provenance.occurredAt);
 }else if(input.event==='confirm_no_show'){
  const booking=row.create_submission_id===null?null:await readBookingCreate(context,row.create_submission_id);
  if(booking?.state!=='accepted'||row.explicit_no_show_at!==null)return {ok:false as const,reason:'accepted_booking_required'};
  const confirmation=(await context.db.query<{attendance_confirmed_at:Date}>("SELECT attendance_confirmed_at FROM meetings WHERE workspace_id=$1 AND id=$2 AND state='no_show' AND attendance_source='manual' AND attendance_confirmed_by=$3 AND attendance_confirmed_at IS NOT NULL",[context.scope.workspaceId,booking.meetingId,row.owner_user_id])).rows[0];
  if(confirmation===undefined)return {ok:false as const,reason:'david_no_show_confirmation_required'};
  // PostgreSQL retains microseconds that JavaScript Date truncates. Keep the
  // authority stamp native, otherwise even unchanged confirmation fails equality.
  await context.db.query('UPDATE booking_conversations b SET explicit_no_show_at=m.attendance_confirmed_at,updated_at=now() FROM meetings m WHERE b.workspace_id=$1 AND b.id=$2 AND m.workspace_id=b.workspace_id AND m.id=$3',[context.scope.workspaceId,row.id,booking.meetingId]);
  if(runtime.messages!==undefined)await enqueueConversationFollowup(context,row.id,'no_show',confirmation.attendance_confirmed_at.toISOString());
 }else await context.db.query("UPDATE booking_conversations SET nudges_stopped_at=COALESCE(nudges_stopped_at,now()),last_reply_at=CASE WHEN $3='reply' THEN now() ELSE last_reply_at END,state=CASE WHEN $3 IN ('refusal','opt_out') THEN 'stopped' WHEN state IN ('pending','booking_pending','awaiting_time') THEN 'handoff' ELSE state END,reason=CASE WHEN $3 IN ('refusal','opt_out') THEN $3 WHEN $3='reply' THEN 'new_reply_requires_interpretation' ELSE reason END,handoff_action=CASE WHEN $3='reply' THEN COALESCE(handoff_action,'review_booking') ELSE handoff_action END,updated_at=now() WHERE workspace_id=$1 AND id=$2",[context.scope.workspaceId,row.id,input.event]);
 return {ok:true as const,value:{conversationId:row.id}};
}

export interface BookingConversationScheduledMessage {conversationId:string;kind:'nudge_3'|'nudge_7'|'no_show';at:string}
function newYorkClock(at:string){
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(at)),part=(key:string)=>parts.find(p=>p.type===key)?.value;
 return {date:`${part('year')}-${part('month')}-${part('day')}`,time:`${part('hour')}:${part('minute')}`};
}
function scheduledMessageReason(row:BookingConversationRow,conversation:BookingConversationMessageContext,input:BookingConversationScheduledMessage):string|null{
 const at=Date.parse(input.at);if(!Number.isFinite(at))return 'booking_message_time_unknown';
 if(input.kind==='no_show'){
  if(row.explicit_no_show_at===null||row.no_show_rebooking_used)return 'explicit_no_show_required';
  const confirmed=newYorkClock(row.explicit_no_show_at.toISOString()),next=new Date(`${confirmed.date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate()+1);while([0,6].includes(next.getUTCDay()))next.setUTCDate(next.getUTCDate()+1);
  return newYorkClock(input.at).date===next.toISOString().slice(0,10)?null:'no_show_next_business_day_only';
 }
 if(row.state!=='awaiting_time'||row.nudges_stopped_at!==null||row.nudge_count>=2||conversation.outcome.kind!=='approved_link')return 'booking_nudges_stopped';
 if(row.nudge_count!==(input.kind==='nudge_3'?0:1))return 'booking_nudge_already_counted';
 const original=newYorkClock(conversation.provenance.occurredAt),dueDate=new Date(`${original.date}T12:00:00Z`);
 dueDate.setUTCDate(dueDate.getUTCDate()+(input.kind==='nudge_3'?3:7));
 const due=bookingConversationSlotInstant({localDate:dueDate.toISOString().slice(0,10),localTime:original.time,timeZone:'America/New_York'});
 return due!==null&&at>=Date.parse(due)?null:'booking_nudge_not_due';
}
export async function bookingConversationMessageEligibility(context:RepositoryContext,input:BookingConversationScheduledMessage,runtime:BookingConversationRuntime):Promise<string|null>{
 const current=await readCurrentBookingConversationForMessages(context,input.conversationId,runtime);if(current.kind!=='available')return current.reason;
 const row=await loadBookingConversation(context,input.conversationId);if(row===null)return 'booking_conversation_unavailable';
 if(input.kind==='no_show'){
  const receipt=row.create_submission_id===null?null:await readBookingCreate(context,row.create_submission_id);
  if(receipt?.state!=='accepted'||!await currentDavidNoShow(context,row,receipt.meetingId))return 'david_no_show_confirmation_required';
 }
 return scheduledMessageReason(row,current.conversation,input);
}
/** Invoke atomically with the existing irreversible sender dispatch marker. Unknown
 * acceptance consumes the same bounded touch. It never refunds or replays a nudge. */
export async function consumeBookingConversationMessage(context:RepositoryContext,input:BookingConversationScheduledMessage,runtime:BookingConversationRuntime):Promise<string|null>{
 const current=await readCurrentBookingConversationForMessages(context,input.conversationId,runtime);if(current.kind!=='available')return current.reason;
 const row=(await context.db.query<BookingConversationRow>('SELECT * FROM booking_conversations WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 FOR UPDATE',[context.scope.workspaceId,input.conversationId,current.conversation.ownerUserId])).rows[0];
 if(row===undefined)return 'booking_conversation_unavailable';
 const afterWait=await readCurrentBookingConversationForMessages(context,input.conversationId,runtime);
 if(afterWait.kind!=='available')return afterWait.reason;
 if(afterWait.conversation.sourceFingerprint!==current.conversation.sourceFingerprint||afterWait.conversation.snapshot.bindingKey!==current.conversation.snapshot.bindingKey)return 'booking_authority_changed_after_wait';
 if(input.kind==='no_show'){
  const receipt=row.create_submission_id===null?null:await readBookingCreate(context,row.create_submission_id);
  if(receipt?.state!=='accepted'||!await currentDavidNoShow(context,row,receipt.meetingId))return 'david_no_show_confirmation_required';
 }
 const reason=scheduledMessageReason(row,afterWait.conversation,input);if(reason!==null)return reason;
 if(input.kind==='no_show')await context.db.query('UPDATE booking_conversations SET no_show_rebooking_used=true,updated_at=now() WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,row.id]);
 else await context.db.query("UPDATE booking_conversations SET nudge_count=nudge_count+1,state=CASE WHEN nudge_count=1 THEN 'handoff' ELSE state END,reason=CASE WHEN nudge_count=1 THEN 'two_unanswered_booking_nudges' ELSE reason END,handoff_action=CASE WHEN nudge_count=1 THEN 'review_booking' ELSE handoff_action END,nudges_stopped_at=CASE WHEN nudge_count=1 THEN now() ELSE nudges_stopped_at END,updated_at=now() WHERE workspace_id=$1 AND id=$2",[context.scope.workspaceId,row.id]);
 if(input.kind==='nudge_3')await enqueueConversationFollowup(context,row.id,'nudge_7',afterWait.conversation.provenance.occurredAt);
 return null;
}
async function enqueueConversationFollowup(context:RepositoryContext,id:string,kind:'nudge_3'|'nudge_7'|'no_show',originAt:string){
 const origin=newYorkClock(originAt),date=new Date(`${origin.date}T12:00:00Z`);
 date.setUTCDate(date.getUTCDate()+(kind==='nudge_3'?3:kind==='nudge_7'?7:1));
 if(kind==='no_show')while([0,6].includes(date.getUTCDay()))date.setUTCDate(date.getUTCDate()+1);
 const runAt=bookingConversationSlotInstant({localDate:date.toISOString().slice(0,10),localTime:kind==='no_show'?'10:00':origin.time,timeZone:'America/New_York'});
 if(runAt!==null)await enqueueJob(context.db,{workspaceId:context.scope.workspaceId,kind:'meeting.booking_conversation',idempotencyKey:`booking-conversation:${id}:${kind}`,payload:{conversationId:id,messageKind:kind},runAt});
}
async function currentDavidNoShow(context:RepositoryContext,row:BookingConversationRow,meetingId:string|null):Promise<boolean>{
 // Compare the two retained native timestamps, not a millisecond Date round-trip.
 return (await context.db.query("SELECT m.id FROM meetings m JOIN booking_conversations b ON b.workspace_id=m.workspace_id AND b.id=$4 WHERE m.workspace_id=$1 AND m.id=$2 AND m.state='no_show' AND m.attendance_source='manual' AND m.attendance_confirmed_by=$3 AND m.attendance_confirmed_at=b.explicit_no_show_at",[context.scope.workspaceId,meetingId,row.owner_user_id,row.id])).rows.length===1;
}
