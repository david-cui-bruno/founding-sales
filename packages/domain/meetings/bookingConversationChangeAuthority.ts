import {z} from 'zod';
import {bookingChangePayloadSchema,bookingInterpretationOutcomeSchema} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {loadBookingInterpretationSources} from '../crm/bookingInterpretationSources.ts';
import type {BookingInterpretationRow} from '../crm/bookingInterpretation.ts';
import {readCurrentBookingPolicy,bookingPolicySnapshotReadyAt} from './bookingPolicy.ts';
import type {BookingPolicyRuntime,BookingPolicySnapshot} from './bookingPolicyTypes.ts';
import {loadBookingConversation,bookingConversationReplyReason,bookingConversationSlotInstant} from './bookingConversationAuthority.ts';
const origin=z.strictObject({conversationId:z.uuid(),interpretationRequestId:z.uuid()});
export const bookingStandingChangeSchema=z.discriminatedUnion('action',[
 bookingChangePayloadSchema.options[0].omit({confirmation:true}).extend({standingOrigin:origin}),
 bookingChangePayloadSchema.options[1].omit({confirmation:true}).extend({standingOrigin:origin}),
]);
export type BookingStandingChangeInput=z.infer<typeof bookingStandingChangeSchema>;
/** Owner selection is only a target hint. The supported source must identify exactly
 * one current booking, directly by UID or via a unique create-backed same thread. */
export async function revalidateBookingConversationChange(context:RepositoryContext,input:BookingStandingChangeInput,policyRuntime:BookingPolicyRuntime,at=policyRuntime.now(),validatedSnapshot?:BookingPolicySnapshot,inspectionOnly=false):Promise<string|null>{
 const row=await loadBookingConversation(context,input.standingOrigin.conversationId);
 if(row===null||row.interpretation_request_id!==input.standingOrigin.interpretationRequestId||row.policy_revision!==input.expectedPolicyRevision||row.target_meeting_id!==input.meetingId||row.target_booking_uid!==input.expectedBookingUid)return 'standing_change_origin_unavailable';
 if(!['pending','booking_pending','unknown','booked'].includes(row.state))return 'standing_conversation_stopped';
 const reply=await bookingConversationReplyReason(context,row);if(reply!==null)return reply;
 const interpretation=(await context.db.query<BookingInterpretationRow>('SELECT * FROM crm_booking_interpretations WHERE workspace_id=$1 AND id=$2 AND requested_by=$3',[context.scope.workspaceId,row.interpretation_request_id,row.owner_user_id])).rows[0];
 if(!interpretation||interpretation.state!=='complete'||interpretation.source_fingerprint!==row.source_fingerprint)return 'standing_interpretation_unavailable';
 const parsed=bookingInterpretationOutcomeSchema.safeParse(interpretation.outcome);
 if(!parsed.success||parsed.data.kind!=='change_proposal'||parsed.data.action!==input.action)return 'standing_supported_change_required';
 const outcome=parsed.data,loaded=await loadBookingInterpretationSources(context,interpretation.source_refs);
 if(loaded===null||loaded.fingerprint!==row.source_fingerprint||loaded.originals[0]!.ownerUserId!==row.owner_user_id)return 'standing_source_changed';
 const source=interpretation.source_refs[0]!,original=loaded.originals[0]!;
 const sameRef=(a:{sourceId:string;sourceRevision:number;contentHash:string|null}|undefined,b:typeof source|undefined)=>a===undefined||b===undefined?a===b:a.sourceId===b.sourceId&&a.sourceRevision===b.sourceRevision&&a.contentHash===b.contentHash;
 if(!sameRef(input.agreement,source)||original.envelope.from?.toLowerCase()!==outcome.attendeeAddress.toLowerCase())return 'standing_action_changed';
 if(input.action==='reschedule'){
  if(outcome.slot===undefined)return 'standing_supported_slot_required';
  const offer=interpretation.source_refs.find(ref=>ref.sourceId===outcome.slot!.evidence.sourceId&&ref.sourceId!==source.sourceId);
  if(!sameRef(input.offeredContext,offer)||input.agreedSlot.timeZone!==outcome.slot.timeZone||Date.parse(input.agreedSlot.startsAt)!==Date.parse(bookingConversationSlotInstant(outcome.slot)??''))return 'standing_action_changed';
 }
 let snapshot=validatedSnapshot;
 if(snapshot===undefined){const policy=await readCurrentBookingPolicy(context,{ownerUserId:row.owner_user_id,expectedRevision:row.policy_revision,expectedBindingKey:row.binding_key,capability:'booking'},policyRuntime);if(policy.kind!=='available')return policy.reason;snapshot=policy.snapshot;}
 if(snapshot.capability!=='booking'||snapshot.ownerUserId!==row.owner_user_id||snapshot.policyRevision!==row.policy_revision||snapshot.bindingKey!==row.binding_key||!bookingPolicySnapshotReadyAt(snapshot,at))return 'standing_policy_changed';
 if(inspectionOnly){
  const known=await context.db.query('SELECT m.id FROM meetings m WHERE m.workspace_id=$1 AND m.id=$2 AND (m.current_booking_uid=$3 OR EXISTS(SELECT 1 FROM meeting_booking_uids u WHERE u.workspace_id=m.workspace_id AND u.meeting_id=m.id AND u.booking_uid=$3)) AND lower(m.attendee_email)=lower($4) AND lower(m.organizer_email)=lower($5)',[context.scope.workspaceId,input.meetingId,input.expectedBookingUid,outcome.attendeeAddress,snapshot.bindings.account.email]);
  return known.rows.length===1?null:'standing_booking_changed';
 }
 const target=await resolveBookingConversationTarget(context,{attendeeAddress:outcome.attendeeAddress,agreementQuote:outcome.agreement.quote,source:original,snapshot,at});
 return target?.id===input.meetingId&&target.current_booking_uid===input.expectedBookingUid?null:'standing_booking_ambiguous';
}
type BookingOriginal=NonNullable<Awaited<ReturnType<typeof loadBookingInterpretationSources>>>['originals'][number];
export async function resolveBookingConversationTarget(context:RepositoryContext,input:{attendeeAddress:string;agreementQuote:string;source:BookingOriginal;snapshot:BookingPolicySnapshot;at:string}):Promise<{id:string;current_booking_uid:string}|null>{
 const {source:original,snapshot,at}=input;
 const meetings=await context.db.query<{id:string;current_booking_uid:string;thread_supported:boolean}>(`SELECT m.id,m.current_booking_uid,EXISTS(SELECT 1 FROM booking_create_submissions b JOIN mail_messages original ON original.workspace_id=b.workspace_id AND original.id=(b.payload->'agreement'->>'sourceId')::uuid WHERE b.workspace_id=m.workspace_id AND b.meeting_id=m.id AND b.owner_user_id=$3 AND b.provider_account_id=$4 AND b.event_type_id=$5 AND original.mailbox_id=$6 AND original.provider_thread_id=$7) AS thread_supported FROM meetings m WHERE m.workspace_id=$1 AND lower(m.attendee_email)=lower($2) AND lower(m.organizer_email)=lower($8) AND m.state IN ('booked','rescheduled') AND m.starts_at>$9::timestamptz`,[context.scope.workspaceId,input.attendeeAddress,snapshot.ownerUserId,snapshot.bindings.account.accountId,snapshot.bindings.event.eventTypeId,original.mailboxId,original.threadId,snapshot.bindings.account.email,at]);
 const uidTokens=input.agreementQuote.split(/[^A-Za-z0-9_-]+/u);
 const explicitlyNamed=meetings.rows.filter(meeting=>uidTokens.includes(meeting.current_booking_uid));
 const candidates=explicitlyNamed.length>0?explicitlyNamed:meetings.rows.filter(meeting=>meeting.thread_supported);
 return candidates.length===1?{id:candidates[0]!.id,current_booking_uid:candidates[0]!.current_booking_uid}:null;
}
