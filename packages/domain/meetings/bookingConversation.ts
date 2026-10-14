import {bookingInterpretationOutcomeSchema,bookingInterpretationViewSchema,type BookingInterpretationView,type BookingConversationView} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {BookingPolicyRuntime,BookingPolicySnapshot} from './bookingPolicyTypes.ts';
import type {BookingCreateRuntime} from './bookingCreateRuntime.ts';
import {readCurrentBookingPolicy,bookingPolicySnapshotReadyAt} from './bookingPolicy.ts';
import {readBookingInterpretation,type BookingInterpretationRow} from '../crm/bookingInterpretation.ts';
import type {BookingInterpretationAuthorityPort} from '../crm/bookingInterpretationAuthority.ts';
import {enqueueJob} from '../jobs/jobStore.ts';
import {readBookingCreate} from './bookingCreate.ts';
import {loadBookingConversation,type BookingConversationRow} from './bookingConversationAuthority.ts';
export interface BookingConversationRuntime {policy:BookingPolicyRuntime;interpretationAuthority:BookingInterpretationAuthorityPort;create?:BookingCreateRuntime}
export interface BookingConversationMessageContext {
 conversationId:string;ownerUserId:string;interpretationRequestId:string;policyRevision:number;sourceRefs:BookingInterpretationRow['source_refs'];sourceFingerprint:string;
 outcome:NonNullable<BookingInterpretationView['outcome']>;provenance:NonNullable<BookingInterpretationView['provenance']>;snapshot:BookingPolicySnapshot;
 state:BookingConversationRow['state'];nudgeCount:number;nudgesStoppedAt:string|null;lastReplyAt:string|null;explicitNoShowAt:string|null;noShowRebookingUsed:boolean;createdAt:string;
}
const limitations=['actual_enable_held','linkedin_intake_unavailable','sender_requires_current_supported_adapter','provider_confirmation_and_reminder_unverified'];
const iso=(value:Date|null)=>value?.toISOString()??null;
/** Commands store references only. A cached command receipt can never replay a quote. */
export async function requestBookingConversation(context:RepositoryContext,input:{interpretationRequestId:string;expectedPolicyRevision:number},runtime?:BookingConversationRuntime){
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
 const state=outcome.kind==='stop'?'stopped':outcome.kind==='david_handoff'||outcome.kind==='clarification'?'handoff':outcome.kind==='approved_link'?'awaiting_time':'pending';
 const row=(await context.db.query<BookingConversationRow>(`INSERT INTO booking_conversations(workspace_id,owner_user_id,interpretation_request_id,policy_revision,binding_key,source_fingerprint,source_refs,state,reason,handoff_action,nudges_stopped_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,CASE WHEN $8 IN ('stopped','handoff') THEN now() ELSE NULL END) ON CONFLICT(workspace_id,owner_user_id,interpretation_request_id) DO UPDATE SET interpretation_request_id=EXCLUDED.interpretation_request_id RETURNING *`,[context.scope.workspaceId,actor.userId,interpreted.id,policy.snapshot.policyRevision,policy.snapshot.bindingKey,interpreted.source_fingerprint,JSON.stringify(interpreted.source_refs),state,outcome.kind==='stop'?outcome.reason:outcome.kind==='clarification'?outcome.reason:null,handoff?.action??(state==='handoff'?'review_booking':null)])).rows[0]!;
 if(row.state==='pending')await enqueueJob(context.db,{workspaceId:context.scope.workspaceId,kind:'meeting.booking_conversation',idempotencyKey:`booking-conversation:${row.id}`,payload:{conversationId:row.id}});
 return {ok:true as const,value:{conversationId:row.id}};
}
/** Current source and policy are required for every use of a private interpretation. */
export async function readCurrentBookingConversationForMessages(context:RepositoryContext,id:string,runtime:BookingConversationRuntime):Promise<{kind:'available';conversation:BookingConversationMessageContext}|{kind:'unavailable';reason:string}>{
 const row=await loadBookingConversation(context,id);if(row===null)return {kind:'unavailable',reason:'booking_conversation_unavailable'};
 if(['stale','stopped','unknown'].includes(row.state))return {kind:'unavailable',reason:row.reason??'booking_conversation_stopped'};
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
 const current=runtime===undefined?{kind:'unavailable' as const,reason:'booking_runtime_unavailable'}:await readCurrentBookingConversationForMessages(context,id,runtime);
 const booking=row.create_submission_id===null?null:await readBookingCreate(context,row.create_submission_id);
 if(authorize!==undefined&&!await authorize())return null;
 const outcome=current.kind==='available'?current.conversation.outcome:null;
 const handoff=current.kind==='available'&&'handoff' in current.conversation.outcome?current.conversation.outcome.handoff:null;
 const state=current.kind==='unavailable'?row.state==='stopped'?'stopped':'stale':booking?.state==='accepted'?'booked':booking?.state==='unknown'?'unknown':booking?.state==='failed'?'handoff':row.state;
 return {conversationId:row.id,interpretationRequestId:row.interpretation_request_id,policyRevision:row.policy_revision,origin:'standing_policy',enabled:false,state,reason:current.kind==='unavailable'?current.reason:booking?.reason??row.reason,outcome,handoff:handoff??(current.kind==='available'&&row.handoff_action!==null?{ownerUserId:row.owner_user_id,action:row.handoff_action}:null),booking,nudgeCount:row.nudge_count,nudgesStoppedAt:iso(row.nudges_stopped_at),lastReplyAt:iso(row.last_reply_at),explicitNoShowAt:iso(row.explicit_no_show_at),noShowRebookingUsed:row.no_show_rebooking_used,limitations};
}
/** Manual activity shares the exact same aggregate counters as automated messages. */
export async function recordBookingConversationEvent(context:RepositoryContext,input:{conversationId:string;expectedPolicyRevision:number;event:'manual_nudge'|'reply'|'refusal'|'opt_out'|'confirm_no_show'},runtime?:BookingConversationRuntime){
 if(runtime===undefined)return {ok:false as const,reason:'booking_runtime_unavailable'};
 const initial=await loadBookingConversation(context,input.conversationId);if(initial===null)return {ok:false as const,reason:'booking_conversation_unavailable'};
 if(initial.policy_revision!==input.expectedPolicyRevision)return {ok:false as const,reason:'booking_policy_changed'};
 const current=await readCurrentBookingConversationForMessages(context,input.conversationId,runtime);
 if(current.kind!=='available')return {ok:false as const,reason:current.reason};
 const row=(await context.db.query<BookingConversationRow>('SELECT * FROM booking_conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[context.scope.workspaceId,input.conversationId])).rows[0]!;
 if(input.event==='manual_nudge'){
  if(row.state!=='awaiting_time'||row.nudges_stopped_at!==null||row.nudge_count>=2)return {ok:false as const,reason:'booking_nudges_stopped'};
  await context.db.query("UPDATE booking_conversations SET nudge_count=nudge_count+1,state=CASE WHEN nudge_count=1 THEN 'handoff' ELSE state END,handoff_action=CASE WHEN nudge_count=1 THEN 'review_booking' ELSE handoff_action END,nudges_stopped_at=CASE WHEN nudge_count=1 THEN now() ELSE nudges_stopped_at END,updated_at=now() WHERE workspace_id=$1 AND id=$2",[context.scope.workspaceId,row.id]);
 }else if(input.event==='confirm_no_show'){
  const booking=row.create_submission_id===null?null:await readBookingCreate(context,row.create_submission_id);
  if(booking?.state!=='accepted'||row.explicit_no_show_at!==null)return {ok:false as const,reason:'accepted_booking_required'};
  await context.db.query('UPDATE booking_conversations SET explicit_no_show_at=now(),updated_at=now() WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,row.id]);
 }else await context.db.query("UPDATE booking_conversations SET nudges_stopped_at=COALESCE(nudges_stopped_at,now()),last_reply_at=CASE WHEN $3='reply' THEN now() ELSE last_reply_at END,state=CASE WHEN $3 IN ('refusal','opt_out') THEN 'stopped' ELSE state END,reason=CASE WHEN $3 IN ('refusal','opt_out') THEN $3 ELSE reason END,updated_at=now() WHERE workspace_id=$1 AND id=$2",[context.scope.workspaceId,row.id,input.event]);
 return {ok:true as const,value:{conversationId:row.id}};
}
