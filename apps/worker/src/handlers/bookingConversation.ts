import type {JobHandler} from '@fss/domain/jobs/handlerRegistry.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {requestBookingStandingCreate} from '@fss/domain/meetings/bookingCreate.ts';
import {readCurrentBookingConversationForMessages,type BookingConversationRuntime} from '@fss/domain/meetings/bookingConversation.ts';
import {bookingConversationSlotInstant,type BookingConversationRow} from '@fss/domain/meetings/bookingConversationAuthority.ts';
/** Reference-only orchestration. The existing guarded worker owns all provider waits. */
export function bookingConversationJobHandler(runtime?:BookingConversationRuntime):JobHandler{return {kind:'meeting.booking_conversation',protection:'outbound_fence',maxAttempts:2,leaseSeconds:120,async handle(input){
 const id=input.job.payload['conversationId'];if(typeof id!=='string'||runtime===undefined)return;
 await withTransaction(input.session,async()=>{
  const row=(await input.session.query<BookingConversationRow>('SELECT * FROM booking_conversations WHERE workspace_id=$1 AND id=$2',[input.scope.workspaceId,id])).rows[0];
  if(!row||row.state!=='pending'||row.create_submission_id!==null)return;
  const context=repositoryContext(workspaceScope(input.scope.workspaceId,{kind:'user',userId:row.owner_user_id,role:'admin'}),input.session);
  const current=await readCurrentBookingConversationForMessages(context,id,runtime);
  let reason:string|null=current.kind==='unavailable'?current.reason:null;
  if(current.kind==='available'){
   const outcome=current.conversation.outcome;
   if(outcome.kind!=='slot_proposal')reason='supported_slot_required';
   else if(runtime.create===undefined)reason='booking_create_unavailable';
   else{
    const startsAt=bookingConversationSlotInstant(outcome.slot);
    const routes=await input.session.query<{id:string}>('SELECT id FROM email_addresses WHERE workspace_id=$1 AND lower(address)=lower($2) AND retired_at IS NULL',[input.scope.workspaceId,outcome.attendeeAddress]);
    if(startsAt===null)reason='slot_timezone_ambiguous';
    else if(routes.rows.length!==1)reason='attendee_ambiguous';
    else{
     const lease=await input.session.query("SELECT id FROM jobs WHERE workspace_id=$1 AND id=$2 AND state='running' AND lease_owner=$3 AND fencing_token=$4::bigint AND lease_expires_at>clock_timestamp() FOR UPDATE",[input.scope.workspaceId,input.job.id,input.job.leaseOwner,input.job.fencingToken]);
     if(lease.rows.length!==1)return;
     const source=current.conversation.sourceRefs[0]!,offer=current.conversation.sourceRefs.find(ref=>ref.sourceId===outcome.slot.evidence.sourceId&&ref.sourceId!==source.sourceId);
     const result=await requestBookingStandingCreate(repositoryContext(input.scope,input.session),{expectedPolicyRevision:row.policy_revision,attendeeRouteId:routes.rows[0]!.id,agreement:source,...offer===undefined?{}:{offeredContext:offer},agreedSlot:{startsAt,timeZone:outcome.slot.timeZone},standingOrigin:{conversationId:row.id,interpretationRequestId:row.interpretation_request_id}},runtime.create);
     if(result.ok){await input.session.query("UPDATE booking_conversations SET state='booking_pending',create_submission_id=$3,nudges_stopped_at=COALESCE(nudges_stopped_at,now()),updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state='pending'",[input.scope.workspaceId,row.id,result.value.submissionId]);return;}
     reason=result.reason;
    }
   }
  }
  await input.session.query("UPDATE booking_conversations SET state='handoff',reason=$3,handoff_action=COALESCE(handoff_action,'review_booking'),nudges_stopped_at=COALESCE(nudges_stopped_at,now()),updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state='pending'",[input.scope.workspaceId,id,reason]);
 });
}};}
