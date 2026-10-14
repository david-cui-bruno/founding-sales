import {bookingCreatePayloadSchema} from '@fss/contracts';
import {createHash} from 'node:crypto';
import type {JobHandler,JobHandlerInput} from '@fss/domain/jobs/handlerRegistry.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {validateBookingCreate,recheckBookingCreateAttendee,bookingSlotReason,type BookingCreateRow} from '@fss/domain/meetings/bookingCreate.ts';
import {revalidateBookingPolicy,bookingPolicySnapshotReadyAt} from '@fss/domain/meetings/bookingPolicy.ts';
import {bookingCreateCostContractReason} from '@fss/domain/meetings/bookingCreateRuntime.ts';
import type {BookingCreateRuntime} from '@fss/domain/meetings/bookingCreateRuntime.ts';
import type {BookingCreateCall,BookingCreateObservation} from '@fss/domain/meetings/bookingCreateProvider.ts';
import {receiveSynthesizedCalcomEvent} from '@fss/domain/meetings/calcom.ts';

/** Outbound at-most-once: commit unknown before HTTP. A restart or second handler inspects, never creates. */
export function bookingCreateJobHandler(runtime?:BookingCreateRuntime):JobHandler{return {kind:'meeting.booking_create',protection:'outbound_fence',maxAttempts:4,leaseSeconds:120,async handle(input){
 const id=input.job.payload['submissionId'];if(typeof id!=='string'||runtime===undefined)return;
 const first=await stage(input,id,runtime,false);if(first===null)return;
 let observation:BookingCreateObservation;
 if(first.row.dispatch_started_at!==null){try{observation=await runtime.provider.inspect(first.call);}catch{observation={state:'unknown',reason:'provider_inspection_unavailable'};}}
 else{
  let availability:{available:boolean;reason:string|null};try{availability=await runtime.provider.availability({eventTypeId:first.call.eventTypeId,startsAt:first.call.startsAt,calendars:first.snapshot.bindings.calendars});}catch{availability={available:false,reason:'availability_unknown'};}
  const claimed=await stage(input,id,runtime,true,availability);if(claimed===null)return;
  // Another caller or recovery worker may have crossed the marker while this one waited.
  if(!claimed.dispatchClaimed){try{observation=await runtime.provider.inspect(claimed.call);}catch{observation={state:'unknown',reason:'provider_inspection_unavailable'};}}
  else{try{observation=await runtime.provider.create(claimed.call);}catch{observation={state:'unknown',reason:'provider_acceptance_unknown'};}}
 }
 await settle(input,id,observation);
}};}
async function liveLease(input:JobHandlerInput):Promise<boolean>{return (await input.session.query(`SELECT id FROM jobs WHERE workspace_id=$1 AND id=$2 AND state='running' AND lease_owner=$3 AND fencing_token=$4::bigint AND lease_expires_at>clock_timestamp() FOR UPDATE`,[input.scope.workspaceId,input.job.id,input.job.leaseOwner,input.job.fencingToken])).rows.length===1;}
async function stage(input:JobHandlerInput,id:string,runtime:BookingCreateRuntime,dispatch:boolean,availability?:{available:boolean;reason:string|null}){
 return withTransaction(input.session,async()=>{
  if(!await liveLease(input))return null;
  let row=(await input.session.query<BookingCreateRow>('SELECT * FROM booking_create_submissions WHERE workspace_id=$1 AND id=$2',[input.scope.workspaceId,id])).rows[0];if(!row||['accepted','failed'].includes(row.state))return null;
  if(input.job.payload['inspectionOnly']===true&&row.dispatch_started_at===null)return null;
  const context=repositoryContext(workspaceScope(input.scope.workspaceId,{kind:'user',userId:row.owner_user_id,role:'admin'}),input.session);
  const payload=bookingCreatePayloadSchema.safeParse(row.payload);if(!payload.success||row['provenance_state']!=='current')return null;
  const valid=await validateBookingCreate(context,payload.data,runtime,row.binding_key,row.dispatch_started_at!==null);
  if(!valid.ok||valid.fingerprint!==row['source_fingerprint']){
   const reason=valid.ok?'source_authority_changed':valid.reason;
   await input.session.query(`UPDATE booking_create_submissions SET state=CASE WHEN dispatch_started_at IS NULL THEN 'failed' ELSE state END,reason=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2`,[input.scope.workspaceId,id,reason]);return null;
  }
  row=(await input.session.query<BookingCreateRow>('SELECT * FROM booking_create_submissions WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[input.scope.workspaceId,id])).rows[0];if(!row||['accepted','failed'].includes(row.state)||row['provenance_state']!=='current'||valid.fingerprint!==row['source_fingerprint'])return null;
  // Source and receipt waits are complete. Retain cost before the final canonical
  // observation, so changed scoped readiness during that await cannot authorize HTTP.
  const cost=await runtime.readCostContract(valid.snapshot);
  const policy=await revalidateBookingPolicy(context,valid.snapshot,runtime.policy);
  // A normal Route add on a disjoint firm can commit during receipt/cost waits.
  // Observe ambiguity again without extending the held sorted firm closure.
  const attendeeReason=await recheckBookingCreateAttendee(context,valid.attendeeAuthority);
  if(!await liveLease(input))return null;
  const at=runtime.policy.now();
  const reason=policy.kind!=='available'?policy.reason:!bookingPolicySnapshotReadyAt(policy.snapshot,at)?'booking_readiness_unavailable':bookingCreateCostContractReason(cost,policy.snapshot,at)??attendeeReason??(row.dispatch_started_at===null?bookingSlotReason(row.starts_at.toISOString(),at):null);
  if(reason!==null){await input.session.query("UPDATE booking_create_submissions SET state=CASE WHEN dispatch_started_at IS NULL THEN 'failed' ELSE state END,reason=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2",[input.scope.workspaceId,id,reason]);return null;}
  const call:BookingCreateCall={submissionId:id,eventTypeId:valid.snapshot.bindings.event.eventTypeId,accountId:Number(valid.snapshot.bindings.account.accountId),organizerEmail:valid.snapshot.bindings.account.email,startsAt:row.starts_at.toISOString(),attendee:valid.attendee};
  if(dispatch&&row.dispatch_started_at===null){
   if(availability?.available!==true){await input.session.query("UPDATE booking_create_submissions SET state='failed',reason=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2",[input.scope.workspaceId,id,availability?.reason??'availability_unknown']);return null;}
   // This exact statement must still hold the matching owner/token and wall-clock lease.
   const marker=await input.session.query("UPDATE booking_create_submissions SET state='unknown',dispatch_started_at=clock_timestamp(),reason='provider_acceptance_unknown',updated_at=now() WHERE workspace_id=$1 AND id=$2 AND dispatch_started_at IS NULL AND EXISTS(SELECT 1 FROM jobs WHERE workspace_id=$1 AND id=$3 AND state='running' AND lease_owner=$4 AND fencing_token=$5::bigint AND lease_expires_at>clock_timestamp()) RETURNING id",[input.scope.workspaceId,id,input.job.id,input.job.leaseOwner,input.job.fencingToken]);
   if(marker.rows.length!==1)return null;
   return {row,snapshot:valid.snapshot,call,dispatchClaimed:true};
  }
  return {row,snapshot:valid.snapshot,call,dispatchClaimed:false};
 });
}
async function settle(input:JobHandlerInput,id:string,observation:BookingCreateObservation):Promise<void>{
 await withTransaction(input.session,async()=>{
  let row=(await input.session.query<BookingCreateRow>('SELECT * FROM booking_create_submissions WHERE workspace_id=$1 AND id=$2',[input.scope.workspaceId,id])).rows[0];if(!row||row.dispatch_started_at===null||row.state==='accepted'||row.state==='failed')return;
  // Accepted external facts must not vanish on lease expiry or source revocation during POST.
  if(!('booking' in observation)){row=(await input.session.query<BookingCreateRow>('SELECT * FROM booking_create_submissions WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[input.scope.workspaceId,id])).rows[0];if(!row||['accepted','failed'].includes(row.state))return;await input.session.query("UPDATE booking_create_submissions SET state=$3,reason=CASE WHEN provenance_state='redacted' THEN reason ELSE $4 END,updated_at=now() WHERE workspace_id=$1 AND id=$2",[input.scope.workspaceId,id,observation.state,observation.reason]);return;}
  const b=observation.booking;
  if(b.submissionId!==id||b.accountId!==Number(row.provider_account_id)||b.eventTypeId!==Number(row.event_type_id)||Date.parse(b.startsAt)!==row.starts_at.getTime()||Date.parse(b.endsAt)-Date.parse(b.startsAt)!==20*60_000){await input.session.query("UPDATE booking_create_submissions SET state='unknown',reason='provider_evidence_mismatch',updated_at=now() WHERE workspace_id=$1 AND id=$2",[input.scope.workspaceId,id]);return;}
  let meetingId:string|null=null;
  if(observation.state==='accepted'){
   await receiveSynthesizedCalcomEvent(input.session,{workspaceId:input.scope.workspaceId,eventId:createHash('sha256').update(`booking_create:${id}:${b.uid}:${b.updatedAt}`).digest('hex'),event:{trigger:'BOOKING_CREATED',createdAt:b.updatedAt,uid:b.uid,rescheduleUid:null,startsAt:b.startsAt,endsAt:b.endsAt,organizerEmail:b.organizerEmail,attendeeEmail:b.attendeeEmail,noShow:null}});
   meetingId=(await input.session.query<{id:string}>(`SELECT m.id FROM meetings m WHERE m.workspace_id=$1 AND (m.booking_uid=$2 OR m.current_booking_uid=$2 OR EXISTS(SELECT 1 FROM meeting_booking_uids a WHERE a.workspace_id=m.workspace_id AND a.meeting_id=m.id AND a.booking_uid=$2)) ORDER BY m.created_at,m.id LIMIT 1`,[input.scope.workspaceId,b.uid])).rows[0]?.id??null;
  }
  row=(await input.session.query<BookingCreateRow>('SELECT * FROM booking_create_submissions WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[input.scope.workspaceId,id])).rows[0];if(!row||['accepted','failed'].includes(row.state))return;
  await input.session.query("UPDATE booking_create_submissions SET state=$3,provider_booking_uid=$4,meeting_id=$5,reason=CASE WHEN provenance_state='redacted' THEN reason ELSE NULL END,updated_at=now() WHERE workspace_id=$1 AND id=$2",[input.scope.workspaceId,id,observation.state,b.uid,meetingId]);
 });
}
