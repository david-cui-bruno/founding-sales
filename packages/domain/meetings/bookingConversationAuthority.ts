import {z} from 'zod';
import {bookingCreatePayloadSchema,bookingInterpretationOutcomeSchema} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {loadBookingInterpretationSources} from '../crm/bookingInterpretationSources.ts';
import type {BookingInterpretationRow} from '../crm/bookingInterpretation.ts';
import {readCurrentBookingPolicy,bookingPolicySnapshotReadyAt} from './bookingPolicy.ts';
import type {BookingPolicyRuntime,BookingPolicySnapshot} from './bookingPolicyTypes.ts';

/** Server-private input. Public human confirmation contracts remain unchanged. */
export const bookingStandingCreateSchema=bookingCreatePayloadSchema.omit({confirmation:true}).extend({standingOrigin:z.strictObject({conversationId:z.uuid(),interpretationRequestId:z.uuid()})});
export type BookingStandingCreateInput=z.infer<typeof bookingStandingCreateSchema>;
export interface BookingConversationRow extends Record<string,unknown>{id:string;owner_user_id:string;interpretation_request_id:string;policy_revision:number;binding_key:string;source_fingerprint:string;source_refs:BookingInterpretationRow['source_refs'];state:'pending'|'awaiting_time'|'booking_pending'|'booked'|'stopped'|'handoff'|'stale'|'unknown';target_meeting_id:string|null;target_booking_uid:string|null;source_conversation_id:string|null;create_submission_id:string|null;change_submission_id:string|null;reason:string|null;handoff_action:'answer_sales_question'|'review_conditional_scheduling'|'review_booking'|null;nudge_count:number;nudges_stopped_at:Date|null;last_reply_at:Date|null;explicit_no_show_at:Date|null;no_show_rebooking_used:boolean;created_at:Date}
export async function loadBookingConversation(context:RepositoryContext,id:string):Promise<BookingConversationRow|null>{
 const actor=context.scope.actor;if(actor.kind!=='user'||actor.role!=='admin')return null;
 return (await context.db.query<BookingConversationRow>(`SELECT b.* FROM booking_conversations b JOIN workspace_memberships m ON m.workspace_id=b.workspace_id AND m.user_id=b.owner_user_id WHERE b.workspace_id=$1 AND b.id=$2 AND b.owner_user_id=$3 AND m.status='active' AND m.role='admin'`,[context.scope.workspaceId,id,actor.userId])).rows[0]??null;
}
export async function bookingConversationReplyReason(context:RepositoryContext,row:BookingConversationRow):Promise<string|null>{
 if(row.last_reply_at!==null)return row.reason==='reply_order_unknown'?'reply_order_unknown':'new_reply_requires_interpretation';
 const sourceId=row.source_refs[0]?.sourceId;if(sourceId===undefined)return 'standing_source_changed';
 const replies=await context.db.query<{later:boolean}>(`SELECT newer.provider_at>original.provider_at AS later FROM crm_mail_sources original JOIN crm_mail_sources newer ON newer.workspace_id=original.workspace_id AND newer.owner_user_id=original.owner_user_id AND newer.account_binding=original.account_binding AND newer.acquired_generation=original.acquired_generation AND newer.conversation_id=original.conversation_id AND newer.source_id<>original.source_id JOIN mail_messages m ON m.workspace_id=newer.workspace_id AND m.id=newer.source_id AND m.direction='incoming' WHERE original.workspace_id=$1 AND original.source_id=$2 AND newer.availability='available' AND newer.diagnostic_authorization_id IS NULL AND (newer.provider_at>=original.provider_at OR newer.provider_at IS NULL OR original.provider_at IS NULL) ORDER BY newer.provider_at DESC NULLS FIRST LIMIT 1`,[context.scope.workspaceId,sourceId]);
 return replies.rows.length===0?null:replies.rows[0]!.later===true?'new_reply_requires_interpretation':'reply_order_unknown';
}
/** A local wall-clock slot must identify exactly one instant, including DST folds. */
export function bookingConversationSlotInstant(slot:{localDate:string;localTime:string;timeZone:string}):string|null{
 const desired=`${slot.localDate}T${slot.localTime}`,base=Date.parse(`${desired}:00Z`);if(!Number.isFinite(base))return null;
 try{
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:slot.timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const local=(at:number)=>{const parts=formatter.formatToParts(at),part=(key:string)=>parts.find(p=>p.type===key)?.value;return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;};
  const offsets=new Set([-86400000,0,86400000].map(delta=>Date.parse(`${local(base+delta)}Z`)-(base+delta)));
  const matches=[...offsets].map(offset=>base-offset).filter(at=>local(at)===`${desired}:00`);
  return matches.length===1?new Date(matches[0]!).toISOString():null;
 }catch{return null;}
}
/** Re-read reference-only standing provenance, never promote candidate.permission.
 * A caller's already-validated policy snapshot may be supplied at terminal dispatch
 * so this source recheck does not introduce a second readiness observation fork. */
export async function revalidateBookingConversationCreate(context:RepositoryContext,input:BookingStandingCreateInput,policyRuntime:BookingPolicyRuntime,at=policyRuntime.now(),validatedSnapshot?:BookingPolicySnapshot):Promise<string|null>{
 const row=await loadBookingConversation(context,input.standingOrigin.conversationId);
 if(row===null||row.interpretation_request_id!==input.standingOrigin.interpretationRequestId||row.policy_revision!==input.expectedPolicyRevision)return 'standing_origin_unavailable';
 if(!['pending','booking_pending','unknown','booked'].includes(row.state))return 'standing_conversation_stopped';
 const replyReason=await bookingConversationReplyReason(context,row);if(replyReason!==null)return replyReason;
 const interpretation=(await context.db.query<BookingInterpretationRow>('SELECT * FROM crm_booking_interpretations WHERE workspace_id=$1 AND id=$2 AND requested_by=$3',[context.scope.workspaceId,row.interpretation_request_id,row.owner_user_id])).rows[0];
 if(!interpretation||interpretation.state!=='complete'||interpretation.source_fingerprint!==row.source_fingerprint)return 'standing_interpretation_unavailable';
 const outcome=bookingInterpretationOutcomeSchema.safeParse(interpretation.outcome);
 if(!outcome.success||outcome.data.kind!=='slot_proposal'||outcome.data.schedulingPaused||outcome.data.permission!==false)return 'standing_supported_slot_required';
 const supported=outcome.data;
 const sources=await loadBookingInterpretationSources(context,interpretation.source_refs);
 if(sources===null||sources.fingerprint!==row.source_fingerprint||sources.originals[0]!.ownerUserId!==row.owner_user_id)return 'standing_source_changed';
 const source=interpretation.source_refs[0]!,offer=interpretation.source_refs.find(ref=>ref.sourceId===supported.slot.evidence.sourceId&&ref.sourceId!==source.sourceId);
 const exactRef=(a:{sourceId:string;sourceRevision:number;contentHash:string|null}|undefined,b:typeof source|undefined)=>a===undefined||b===undefined?a===b:a.sourceId===b.sourceId&&a.sourceRevision===b.sourceRevision&&a.contentHash===b.contentHash;
 if(!exactRef(input.agreement,source)||!exactRef(input.offeredContext,offer)||input.agreedSlot.timeZone!==supported.slot.timeZone||Date.parse(input.agreedSlot.startsAt)!==Date.parse(bookingConversationSlotInstant(supported.slot)??'')||sources.originals[0]!.envelope.from?.toLowerCase()!==outcome.data.attendeeAddress.toLowerCase())return 'standing_action_changed';
 const route=(await context.db.query<{address:string}>('SELECT address FROM email_addresses WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,input.attendeeRouteId])).rows[0];
 if(route?.address.toLowerCase()!==outcome.data.attendeeAddress.toLowerCase())return 'standing_attendee_changed';
 let snapshot=validatedSnapshot;
 if(snapshot===undefined){const policy=await readCurrentBookingPolicy(context,{ownerUserId:row.owner_user_id,expectedRevision:row.policy_revision,expectedBindingKey:row.binding_key,capability:'booking'},policyRuntime);if(policy.kind!=='available')return policy.reason;snapshot=policy.snapshot;}
 if(snapshot.capability!=='booking'||snapshot.ownerUserId!==row.owner_user_id||snapshot.policyRevision!==row.policy_revision||snapshot.bindingKey!==row.binding_key||!bookingPolicySnapshotReadyAt(snapshot,at))return 'standing_policy_changed';
 return null;
}
