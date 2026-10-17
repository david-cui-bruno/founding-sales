import {bookingInterpretationOutcomeSchema,bookingInterpretationViewSchema,type BookingInterpretationView,type BookingConversationView,type BookingConversationInput} from '@fss/contracts';
import {createHash} from 'node:crypto';
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
import {directSendTargetOf} from '../mail/matching.ts';
import {readBookingCreate} from './bookingCreate.ts';
import {loadBookingConversation,bookingConversationReplyReason,bookingConversationSlotInstant,type BookingConversationRow} from './bookingConversationAuthority.ts';
export interface BookingConversationRuntime {policy:BookingPolicyRuntime;interpretationAuthority:BookingInterpretationAuthorityPort;create?:BookingCreateRuntime;change?:BookingChangeRuntime;messages?:BookingMessageRuntime}
export interface BookingConversationMessageContext {
 conversationId:string;ownerUserId:string;interpretationRequestId:string;policyRevision:number;sourceRefs:BookingInterpretationRow['source_refs'];sourceFingerprint:string;
 outcome:NonNullable<BookingInterpretationView['outcome']>;provenance:NonNullable<BookingInterpretationView['provenance']>;snapshot:BookingPolicySnapshot;
 state:BookingConversationRow['state']|'cancelled';nudgeCount:number;nudgesStoppedAt:string|null;lastReplyAt:string|null;explicitNoShowAt:string|null;noShowRebookingUsed:boolean;createdAt:string;
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
 // The canonical agreement identifies the episode, not a model execution. Keep
 // its original authority and every shared counter/stop when that source is rerun.
 // Private provenance may be erased on any source refresh. This body-free key
 // survives that erasure solely to prevent a fresh allowance for the same source.
 // The no-op conflict never restores a redacted interpretation or stale authority.
 const episodeKey=createHash('sha256').update(`${context.scope.workspaceId}:${actor.userId}:${interpreted.source_refs[0]!.sourceId}`).digest('hex');
 const row=(await context.db.query<BookingConversationRow>(`INSERT INTO booking_conversations(workspace_id,owner_user_id,interpretation_request_id,policy_revision,binding_key,source_fingerprint,source_refs,state,reason,handoff_action,nudges_stopped_at,source_conversation_id,target_meeting_id,target_booking_uid,episode_key) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,CASE WHEN $8 IN ('stopped','handoff') THEN now() ELSE NULL END,(SELECT conversation_id FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=$11),$12,$13,$14) ON CONFLICT(workspace_id,owner_user_id,episode_key) DO UPDATE SET updated_at=booking_conversations.updated_at RETURNING *`,[context.scope.workspaceId,actor.userId,interpreted.id,policy.snapshot.policyRevision,policy.snapshot.bindingKey,interpreted.source_fingerprint,JSON.stringify(interpreted.source_refs),state,reason,handoff?.action??(state==='handoff'?'review_booking':null),interpreted.source_refs[0]!.sourceId,target?.id??null,target?.current_booking_uid??null,episodeKey])).rows[0]!;
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
 // A signed normal link booking need not have a create submission or later mail.
 // Use current canonical participants and the source's actual operational match,
 // never an enrollment flag or a booking for a different organizer/contact.
 // Booking stops this episode permanently, including when cancellation arrives
 // before its first read. Retained applied create/reschedule history, rather than
 // current active state or a later cancellation timestamp, proves that stop.
 const match=parsed.data.kind==='approved_link'?await directSendTargetOf(context,row.source_refs[0]!.sourceId):undefined;
 const booking=match?.contactId==null?undefined:(await context.db.query<{stopped_at:Date;state:'booked'|'cancelled'}>(`SELECT e.payload_created_at AS stopped_at,CASE WHEN m.state='cancelled' THEN 'cancelled' ELSE 'booked' END AS state FROM meetings m JOIN calcom_events e ON e.workspace_id=m.workspace_id AND e.meeting_id=m.id JOIN mail_messages original ON original.workspace_id=m.workspace_id AND original.id=$2 JOIN firms f ON f.workspace_id=m.workspace_id AND f.id=m.firm_id WHERE m.workspace_id=$1 AND m.firm_id=$5 AND m.contact_id=$6 AND original.direction='incoming' AND original.matched=true AND f.assigned_user_id=$3 AND f.status='active' AND lower(m.attendee_email)=lower(original.header_from) AND lower(m.organizer_email)=lower($4) AND m.current_booking_uid IS NOT NULL AND e.trigger_event IN ('BOOKING_CREATED','BOOKING_RESCHEDULED') AND e.outcome='applied' AND e.payload_created_at>=original.internal_date AND m.starts_at>=original.internal_date ORDER BY e.payload_created_at LIMIT 1`,[context.scope.workspaceId,row.source_refs[0]!.sourceId,row.owner_user_id,policy.snapshot.bindings.account.email,match.firmId,match.contactId])).rows[0];
 return {kind:'available',conversation:{conversationId:row.id,ownerUserId:row.owner_user_id,interpretationRequestId:row.interpretation_request_id,policyRevision:row.policy_revision,sourceRefs:row.source_refs,sourceFingerprint:row.source_fingerprint,outcome:parsed.data,provenance:view.data.provenance,snapshot:policy.snapshot,state:booking?.state??row.state,nudgeCount:row.nudge_count,nudgesStoppedAt:iso(row.nudges_stopped_at??booking?.stopped_at??null),lastReplyAt:iso(row.last_reply_at),explicitNoShowAt:iso(row.explicit_no_show_at),noShowRebookingUsed:row.no_show_rebooking_used,createdAt:row.created_at.toISOString()}};
}
export async function readBookingConversation(context:RepositoryContext,id:string,runtime?:BookingConversationRuntime,authorize?:()=>Promise<boolean>,onObservation?:(snapshot:BookingPolicySnapshot)=>void):Promise<BookingConversationView|null>{
 const row=await loadBookingConversation(context,id);if(row===null)return null;
 let current=runtime===undefined?{kind:'unavailable' as const,reason:'booking_runtime_unavailable'}:await readCurrentBookingConversationForMessages(context,id,runtime);
 const booking=row.create_submission_id===null?null:await readBookingCreate(context,row.create_submission_id);
 const change=row.change_submission_id===null?null:await readBookingChange(context,row.change_submission_id);
 if(authorize!==undefined&&!await authorize())return null;
 if(current.kind==='available'&&runtime!==undefined&&!bookingPolicySnapshotReadyAt(current.conversation.snapshot,runtime.policy.now()))current={kind:'unavailable',reason:'booking_readiness_unavailable'};
 if(current.kind==='available')onObservation?.(current.conversation.snapshot);
 const outcome=current.kind==='available'?current.conversation.outcome:null;
 const handoff=current.kind==='available'&&'handoff' in current.conversation.outcome?current.conversation.outcome.handoff:null;
 const state=current.kind==='unavailable'?row.state==='stopped'?'stopped':row.state==='handoff'&&['new_reply_requires_interpretation','reply_order_unknown'].includes(current.reason)?'handoff':'stale':change?.state==='accepted'?change.action==='cancel'?'cancelled':'rescheduled':change?.state==='unknown'?'unknown':change?.state==='failed'?'handoff':booking?.state==='accepted'?'booked':booking?.state==='unknown'?'unknown':booking?.state==='failed'?'handoff':current.conversation.state;
 return {conversationId:row.id,interpretationRequestId:row.interpretation_request_id,policyRevision:row.policy_revision,origin:'standing_policy',enabled:false,state,reason:current.kind==='unavailable'?current.reason:change?.reason??booking?.reason??row.reason,outcome,handoff:handoff??(row.handoff_action!==null&&(current.kind==='available'||state==='handoff')?{ownerUserId:row.owner_user_id,action:row.handoff_action}:null),booking,change,nudgeCount:row.nudge_count,nudgesStoppedAt:current.kind==='available'?current.conversation.nudgesStoppedAt:iso(row.nudges_stopped_at),lastReplyAt:iso(row.last_reply_at),explicitNoShowAt:iso(row.explicit_no_show_at),noShowRebookingUsed:row.no_show_rebooking_used,limitations};
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
  if(current.kind!=='available'||current.conversation.state!=='awaiting_time'||current.conversation.nudgesStoppedAt!==null||row.state!=='awaiting_time'||row.nudges_stopped_at!==null||row.nudge_count>=2)return {ok:false as const,reason:'booking_nudges_stopped'};
  await context.db.query("UPDATE booking_conversations SET nudge_count=nudge_count+1,state=CASE WHEN nudge_count=1 THEN 'handoff' ELSE state END,handoff_action=CASE WHEN nudge_count=1 THEN 'review_booking' ELSE handoff_action END,nudges_stopped_at=CASE WHEN nudge_count=1 THEN now() ELSE nudges_stopped_at END,updated_at=now() WHERE workspace_id=$1 AND id=$2",[context.scope.workspaceId,row.id]);
  if(row.nudge_count===0&&runtime.messages!==undefined&&current.kind==='available')await enqueueConversationFollowup(context,row.id,'nudge_7',current.conversation.provenance.occurredAt);
 }else if(input.event==='confirm_no_show'){
  if(current.kind!=='available'||row.explicit_no_show_at!==null)return {ok:false as const,reason:'accepted_booking_required'};
  const meeting=await currentNoShowBooking(context,row,current.conversation);
  if(meeting===null)return {ok:false as const,reason:'accepted_booking_required'};
  const confirmation=(await context.db.query<{attendance_confirmed_at:Date}>("SELECT attendance_confirmed_at FROM meetings WHERE workspace_id=$1 AND id=$2 AND current_booking_uid=$4 AND state='no_show' AND attendance_source='manual' AND attendance_confirmed_by=$3 AND attendance_confirmed_at IS NOT NULL",[context.scope.workspaceId,meeting.id,row.owner_user_id,meeting.current_booking_uid])).rows[0];
  if(confirmation===undefined)return {ok:false as const,reason:'david_no_show_confirmation_required'};
  // PostgreSQL retains microseconds that JavaScript Date truncates. Keep the
  // authority stamp native, otherwise even unchanged confirmation fails equality.
  // A change's target pair is historical command-origin authority. Its accepted
  // receipt already pins the replacement UID, so never rewrite that old target.
  await context.db.query('UPDATE booking_conversations b SET explicit_no_show_at=m.attendance_confirmed_at,target_meeting_id=COALESCE(b.target_meeting_id,m.id),target_booking_uid=COALESCE(b.target_booking_uid,m.current_booking_uid),updated_at=now() FROM meetings m WHERE b.workspace_id=$1 AND b.id=$2 AND m.workspace_id=b.workspace_id AND m.id=$3 AND m.current_booking_uid=$4',[context.scope.workspaceId,row.id,meeting.id,meeting.current_booking_uid]);
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
 if(row.state!=='awaiting_time'||conversation.state!=='awaiting_time'||conversation.nudgesStoppedAt!==null||row.nudges_stopped_at!==null||row.nudge_count>=2||conversation.outcome.kind!=='approved_link')return 'booking_nudges_stopped';
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
  const meeting=await currentNoShowBooking(context,row,current.conversation);
  if(meeting===null||!await currentDavidNoShow(context,row,meeting))return 'david_no_show_confirmation_required';
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
  const meeting=await currentNoShowBooking(context,row,afterWait.conversation);
  if(meeting===null||!await currentDavidNoShow(context,row,meeting))return 'david_no_show_confirmation_required';
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
/** Resolve only this admitted source episode through existing operational matching
 * and applied UID history. Interest alone, a model target, or a historical UID is
 * not a booking. Accepted create/change receipts narrow the exact meeting; a link
 * requires one unambiguous signed booking after its original agreement. */
async function currentNoShowBooking(context:RepositoryContext,row:BookingConversationRow,conversation:BookingConversationMessageContext):Promise<{id:string;current_booking_uid:string}|null>{
 const sourceId=row.source_refs[0]?.sourceId;if(sourceId===undefined)return null;
 const match=await directSendTargetOf(context,sourceId);if(match?.contactId==null)return null;
 const bindings=conversation.snapshot.bindings;
 const meetings=await context.db.query<{id:string;current_booking_uid:string}>(`SELECT m.id,m.current_booking_uid
 FROM meetings m JOIN firms f ON f.workspace_id=m.workspace_id AND f.id=m.firm_id
 JOIN mail_messages original ON original.workspace_id=m.workspace_id AND original.id=$2
 JOIN crm_mail_sources source ON source.workspace_id=original.workspace_id AND source.source_id=original.id
 WHERE m.workspace_id=$1 AND m.firm_id=$5 AND m.contact_id=$6 AND f.assigned_user_id=$3 AND f.status='active'
 AND source.owner_user_id=$3 AND original.direction='incoming' AND original.matched=true
 AND lower(m.attendee_email)=lower(original.header_from) AND lower(m.organizer_email)=lower($4)
 AND m.state<>'cancelled' AND m.current_booking_uid IS NOT NULL
 AND ($10::timestamptz IS NULL OR $13::uuid IS NOT NULL OR (m.id=$11::uuid AND m.current_booking_uid=$12))
 AND EXISTS(SELECT 1 FROM calcom_events e WHERE e.workspace_id=m.workspace_id AND e.meeting_id=m.id
  AND e.booking_uid=m.current_booking_uid AND e.trigger_event IN ('BOOKING_CREATED','BOOKING_RESCHEDULED') AND e.outcome='applied')
 AND NOT EXISTS(SELECT 1 FROM calcom_events e WHERE e.workspace_id=m.workspace_id AND e.meeting_id=m.id
  AND e.booking_uid=m.current_booking_uid AND e.trigger_event='BOOKING_CANCELLED' AND e.outcome='applied')
 -- Canonical reschedules preserve human attendance. A delayed callback can
 -- predate that stamp at the provider while arriving after the human decision.
 -- Require the current episode to have been observed before manual attendance.
 AND (m.attendance_confirmed_at IS NULL OR NOT EXISTS(SELECT 1 FROM calcom_events e
  WHERE e.workspace_id=m.workspace_id AND e.meeting_id=m.id AND e.booking_uid=m.current_booking_uid
  AND e.trigger_event IN ('BOOKING_CREATED','BOOKING_RESCHEDULED') AND e.outcome='applied'
  AND (e.payload_created_at IS NULL OR e.payload_created_at>m.attendance_confirmed_at OR e.received_at>m.attendance_confirmed_at)))
 AND (
  ($7::uuid IS NOT NULL AND EXISTS(SELECT 1 FROM booking_create_submissions b
   JOIN meeting_booking_uids u ON u.workspace_id=b.workspace_id AND u.meeting_id=b.meeting_id AND u.booking_uid=b.provider_booking_uid
   WHERE b.workspace_id=m.workspace_id AND b.id=$7 AND b.meeting_id=m.id AND b.owner_user_id=$3 AND b.state='accepted'
   AND b.provider_account_id=$8 AND b.event_type_id=$9 AND b.payload->'agreement'->>'sourceId'=$2::text))
  OR ($13::uuid IS NOT NULL AND EXISTS(SELECT 1 FROM booking_change_submissions b
   WHERE b.workspace_id=m.workspace_id AND b.id=$13 AND b.meeting_id=m.id AND b.owner_user_id=$3 AND b.state='accepted' AND b.action='reschedule'
   AND b.provider_booking_uid=m.current_booking_uid AND b.provider_account_id=$8 AND b.event_type_id=$9 AND b.payload->'agreement'->>'sourceId'=$2::text))
  OR ($7::uuid IS NULL AND $13::uuid IS NULL AND $14::boolean AND m.starts_at>=original.internal_date
   AND EXISTS(SELECT 1 FROM calcom_events e WHERE e.workspace_id=m.workspace_id AND e.meeting_id=m.id AND e.booking_uid=m.booking_uid
    AND e.trigger_event='BOOKING_CREATED' AND e.outcome='applied' AND e.payload_created_at>=original.internal_date))
 )`,[context.scope.workspaceId,sourceId,row.owner_user_id,bindings.account.email,match.firmId,match.contactId,row.create_submission_id,bindings.account.accountId,String(bindings.event.eventTypeId),row.explicit_no_show_at,row.target_meeting_id,row.target_booking_uid,row.change_submission_id,conversation.outcome.kind==='approved_link']);
 return meetings.rows.length===1?meetings.rows[0]!:null;
}
async function currentDavidNoShow(context:RepositoryContext,row:BookingConversationRow,meeting:{id:string;current_booking_uid:string}):Promise<boolean>{
 // Compare the two retained native timestamps, not a millisecond Date round-trip.
 return (await context.db.query("SELECT m.id FROM meetings m JOIN booking_conversations b ON b.workspace_id=m.workspace_id AND b.id=$4 WHERE m.workspace_id=$1 AND m.id=$2 AND m.current_booking_uid=$5 AND m.state='no_show' AND m.attendance_source='manual' AND m.attendance_confirmed_by=$3 AND m.attendance_confirmed_at=b.explicit_no_show_at",[context.scope.workspaceId,meeting.id,row.owner_user_id,row.id,meeting.current_booking_uid])).rows.length===1;
}
