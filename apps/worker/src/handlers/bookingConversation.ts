import type {JobHandler} from '@fss/domain/jobs/handlerRegistry.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {requestBookingStandingCreate} from '@fss/domain/meetings/bookingCreate.ts';
import {requestBookingStandingChange} from '@fss/domain/meetings/bookingChange.ts';
import {requestBookingStandingMessage} from '@fss/domain/meetings/bookingMessages.ts';
import {readCurrentBookingConversationForMessages,type BookingConversationRuntime} from '@fss/domain/meetings/bookingConversation.ts';
import {bookingConversationSlotInstant,type BookingConversationRow} from '@fss/domain/meetings/bookingConversationAuthority.ts';
import {lockSendGateForStopFact} from '@fss/domain/policy/sendGate.ts';
/** Reference-only orchestration. The existing guarded worker owns all provider waits. */
export function bookingConversationJobHandler(runtime?:BookingConversationRuntime):JobHandler{return {kind:'meeting.booking_conversation',protection:'outbound_fence',maxAttempts:2,leaseSeconds:120,async handle(input){
 const id=input.job.payload['conversationId'];if(typeof id!=='string'||runtime===undefined)return;
 return withTransaction(input.session,async()=>{
  await lockSendGateForStopFact(repositoryContext(input.scope,input.session));
  const assertLease=async()=>{const lease=await input.session.query("SELECT id FROM jobs WHERE workspace_id=$1 AND id=$2 AND state='running' AND lease_owner=$3 AND fencing_token=$4::bigint AND lease_expires_at>clock_timestamp() FOR UPDATE",[input.scope.workspaceId,input.job.id,input.job.leaseOwner,input.job.fencingToken]);if(lease.rows.length!==1)throw new Error('booking_conversation_lease_lost');};
  await assertLease();
  const row=(await input.session.query<BookingConversationRow>('SELECT * FROM booking_conversations WHERE workspace_id=$1 AND id=$2',[input.scope.workspaceId,id])).rows[0];
  if(!row||!['pending','awaiting_time','booking_pending','booked','handoff'].includes(row.state))return;
  // A manual touch consumes the same ordinal. A superseded due job cannot
  // consume it again or stop the still-eligible remaining day-seven touch.
  if(input.job.payload['messageKind']==='nudge_3'&&row.nudge_count>0)return;
  if(input.job.payload['messageKind']==='nudge_7'&&row.nudge_count>=2)return;
  if(row.state==='pending'&&(row.create_submission_id!==null||row.change_submission_id!==null))return;
  const context=repositoryContext(workspaceScope(input.scope.workspaceId,{kind:'user',userId:row.owner_user_id,role:'admin'}),input.session);
  const current=await readCurrentBookingConversationForMessages(context,id,runtime);
  let reason:string|null=current.kind==='unavailable'?current.reason:null;
  if(current.kind==='available'){
   const outcome=current.conversation.outcome;
   if(outcome.kind==='approved_link'||outcome.kind==='clarification'||input.job.payload['messageKind']==='no_show'){
    const kind=input.job.payload['messageKind'];
    if(runtime.messages===undefined)reason='booking_sender_unavailable';
    else if(kind===undefined||kind==='nudge_3'||kind==='nudge_7'||kind==='no_show'){
     const result=await requestBookingStandingMessage(repositoryContext(input.scope,input.session),{conversationId:row.id,kind:kind??(outcome.kind==='clarification'?'clarification':'approved_link')},runtime.messages);
     if(result.ok){await assertLease();return;}
     reason=result.reason;
    }else reason='booking_message_kind_unsupported';
   }else if(outcome.kind==='change_proposal'){
    if(runtime.change===undefined)reason='booking_change_unavailable';
    else if(row.target_meeting_id===null||row.target_booking_uid===null)reason='standing_booking_ambiguous';
    else{
     const routes=await input.session.query<{id:string}>('SELECT id FROM email_addresses WHERE workspace_id=$1 AND lower(address)=lower($2) AND retired_at IS NULL',[input.scope.workspaceId,outcome.attendeeAddress]);
     if(routes.rows.length!==1)reason='attendee_ambiguous';
     else{
      const source=current.conversation.sourceRefs[0]!,base={expectedPolicyRevision:row.policy_revision,meetingId:row.target_meeting_id,expectedBookingUid:row.target_booking_uid,attendeeRouteId:routes.rows[0]!.id,agreement:source,standingOrigin:{conversationId:row.id,interpretationRequestId:row.interpretation_request_id}};
      const slot=outcome.action==='reschedule'&&outcome.slot!==undefined?outcome.slot:null;
      const startsAt=slot===null?null:bookingConversationSlotInstant(slot);
      const offer=slot===null?undefined:current.conversation.sourceRefs.find(ref=>ref.sourceId===slot.evidence.sourceId&&ref.sourceId!==source.sourceId);
      if(outcome.action==='reschedule'&&(slot===null||startsAt===null))reason='supported_slot_required';
      else{
       const result=await requestBookingStandingChange(repositoryContext(input.scope,input.session),outcome.action==='cancel'?{...base,action:'cancel'}:{...base,action:'reschedule',...offer===undefined?{}:{offeredContext:offer},agreedSlot:{startsAt:startsAt!,timeZone:slot!.timeZone}},runtime.change);
       if(result.ok){await assertLease();await input.session.query("UPDATE booking_conversations SET state='booking_pending',change_submission_id=$3,nudges_stopped_at=COALESCE(nudges_stopped_at,now()),updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state='pending'",[input.scope.workspaceId,row.id,result.value.submissionId]);return;}
       reason=result.reason;
      }
     }
    }
   }else if(outcome.kind!=='slot_proposal')reason='supported_slot_required';
   else if(runtime.create===undefined)reason='booking_create_unavailable';
   else{
    const startsAt=bookingConversationSlotInstant(outcome.slot);
    const routes=await input.session.query<{id:string}>('SELECT id FROM email_addresses WHERE workspace_id=$1 AND lower(address)=lower($2) AND retired_at IS NULL',[input.scope.workspaceId,outcome.attendeeAddress]);
    if(startsAt===null)reason='slot_timezone_ambiguous';
    else if(routes.rows.length!==1)reason='attendee_ambiguous';
    else{
     await assertLease();
     const source=current.conversation.sourceRefs[0]!,offer=current.conversation.sourceRefs.find(ref=>ref.sourceId===outcome.slot.evidence.sourceId&&ref.sourceId!==source.sourceId);
     const result=await requestBookingStandingCreate(repositoryContext(input.scope,input.session),{expectedPolicyRevision:row.policy_revision,attendeeRouteId:routes.rows[0]!.id,agreement:source,...offer===undefined?{}:{offeredContext:offer},agreedSlot:{startsAt,timeZone:outcome.slot.timeZone},standingOrigin:{conversationId:row.id,interpretationRequestId:row.interpretation_request_id}},runtime.create);
     if(result.ok){await assertLease();await input.session.query("UPDATE booking_conversations SET state='booking_pending',create_submission_id=$3,nudges_stopped_at=COALESCE(nudges_stopped_at,now()),updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state='pending'",[input.scope.workspaceId,row.id,result.value.submissionId]);return;}
     reason=result.reason;
    }
   }
  }
  await assertLease();
  if(input.job.payload['messageKind']==='no_show')await input.session.query('UPDATE booking_conversations SET reason=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2',[input.scope.workspaceId,id,reason]);
  await input.session.query("UPDATE booking_conversations SET state='handoff',reason=$3,handoff_action=COALESCE(handoff_action,'review_booking'),nudges_stopped_at=COALESCE(nudges_stopped_at,now()),updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state IN ('pending','awaiting_time')",[input.scope.workspaceId,id,reason]);
  return {progress:{reason:reason??'booking_conversation_unavailable'},done:true};
 });
}};}
