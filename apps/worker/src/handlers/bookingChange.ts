import {bookingChangePayloadSchema} from '@fss/contracts';
import {createHash} from 'node:crypto';
import type {JobHandler,JobHandlerInput} from '@fss/domain/jobs/handlerRegistry.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {validateBookingChange} from '@fss/domain/meetings/bookingChangeAuthority.ts';
import type {BookingChangeRow} from '@fss/domain/meetings/bookingChange.ts';
import {revalidateBookingPolicy,bookingPolicySnapshotReadyAt} from '@fss/domain/meetings/bookingPolicy.ts';
import {bookingChangeCostReason,type BookingChangeRuntime,type BookingChangeCall,type BookingChangeObservation,type BookingChangeTarget} from '@fss/domain/meetings/bookingChangeProvider.ts';
import {bookingSlotReason} from '@fss/domain/meetings/bookingCreate.ts';
import {receiveSynthesizedCalcomEvent} from '@fss/domain/meetings/calcom.ts';
import {attendeeTombstoned} from '@fss/domain/meetings/reconcile.ts';
import {lockSendGateForStopFact} from '@fss/domain/policy/sendGate.ts';

/** Commit unknown before the provider write. Recovery can inspect only, never replay. */
export function bookingChangeJobHandler(runtime?:BookingChangeRuntime):JobHandler{return {kind:'meeting.booking_change',protection:'outbound_fence',maxAttempts:4,leaseSeconds:120,async handle(input){
 const id=input.job.payload['submissionId'];if(typeof id!=='string'||runtime===undefined)return;
 const first=await stage(input,id,runtime,false);if(first===null)return;
 let observation:BookingChangeObservation;
 if(first.row.dispatch_started_at!==null){try{observation=await runtime.provider.inspect(first.call);}catch{observation={state:'unknown',reason:'provider_inspection_unavailable'};}}
 else {
  // Independent external reads run together. No database transaction spans the waits.
  const [target,availability]=await Promise.all([
   runtime.provider.readTarget(first.call).catch(()=>null),
   first.call.action==='cancel'?Promise.resolve({available:true,reason:null}):runtime.provider.availability({eventTypeId:first.call.eventTypeId,startsAt:first.call.startsAt!,calendars:first.snapshot.bindings.calendars,excludeBookingUid:first.call.bookingUid}).catch(()=>({available:false,reason:'availability_unknown'})),
  ]);
  const claimed=await stage(input,id,runtime,true,{target,availability});if(claimed===null)return;
  if(!claimed.dispatchClaimed){try{observation=await runtime.provider.inspect(claimed.call);}catch{observation={state:'unknown',reason:'provider_inspection_unavailable'};}}
  else{try{observation=await runtime.provider.change(claimed.call);}catch{observation={state:'unknown',reason:'provider_acceptance_unknown'};}}
 }
 await settle(input,id,observation,first.call);
}};}
async function liveLease(input:JobHandlerInput):Promise<boolean>{return (await input.session.query(`SELECT id FROM jobs WHERE workspace_id=$1 AND id=$2 AND state='running' AND lease_owner=$3 AND fencing_token=$4::bigint AND lease_expires_at>clock_timestamp() FOR UPDATE`,[input.scope.workspaceId,input.job.id,input.job.leaseOwner,input.job.fencingToken])).rows.length===1;}
function matchesTarget(call:BookingChangeCall,target:BookingChangeTarget|null):boolean{return target!==null&&target.status==='accepted'&&target.uid===call.bookingUid&&target.accountId===call.accountId&&target.eventTypeId===call.eventTypeId&&target.organizerEmail.toLowerCase()===call.organizerEmail.toLowerCase()&&target.attendeeEmail.toLowerCase()===call.attendeeEmail&&Date.parse(target.startsAt)===Date.parse(call.originalStartsAt)&&Date.parse(target.endsAt)===Date.parse(call.originalEndsAt);}
async function stage(input:JobHandlerInput,id:string,runtime:BookingChangeRuntime,dispatch:boolean,reads?:{target:BookingChangeTarget|null;availability:{available:boolean;reason:string|null}}){return withTransaction(input.session,async()=>{
 await lockSendGateForStopFact(repositoryContext(input.scope,input.session));
 if(!await liveLease(input))return null;
 let row=(await input.session.query<BookingChangeRow>('SELECT * FROM booking_change_submissions WHERE workspace_id=$1 AND id=$2',[input.scope.workspaceId,id])).rows[0];if(!row||['accepted','failed'].includes(row.state)||row.provenance_state!=='current')return null;
 if(input.job.payload['inspectionOnly']===true&&row.dispatch_started_at===null)return null;
 const parsed=bookingChangePayloadSchema.safeParse(row.payload);if(!parsed.success)return null;
 const context=repositoryContext(workspaceScope(input.scope.workspaceId,{kind:'user',userId:row.owner_user_id,role:'admin'}),input.session);
 const valid=await validateBookingChange(context,parsed.data,runtime,row.binding_key,row.dispatch_started_at!==null);
 const reason=!valid.ok?valid.reason:valid.fingerprint!==row.source_fingerprint?'source_authority_changed':row.dispatch_started_at===null&&valid.targetFingerprint!==row.target_fingerprint?'meeting_changed':null;
 if(reason!==null||!valid.ok){await input.session.query(`UPDATE booking_change_submissions SET state=CASE WHEN dispatch_started_at IS NULL THEN 'failed' ELSE state END,reason=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state NOT IN ('accepted','failed')`,[input.scope.workspaceId,id,reason]);return null;}
 row=(await input.session.query<BookingChangeRow>('SELECT * FROM booking_change_submissions WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[input.scope.workspaceId,id])).rows[0];if(!row||['accepted','failed'].includes(row.state)||row.provenance_state!=='current'||valid.fingerprint!==row.source_fingerprint)return null;
 // Source locks precede the receipt lock. Once its wait finishes, observe exact
 // cost FIRST and canonical captured readiness AFTER that await, not cached flags.
 const cost=await runtime.readCostContract(valid.snapshot);
 const policy=Number.isFinite(Date.parse(runtime.policy.now()))?await revalidateBookingPolicy(context,valid.snapshot,runtime.policy):{kind:'unavailable' as const,reason:'booking_readiness_unavailable'};
 if(!await liveLease(input))return null;
 const finalNow=runtime.policy.now(),finalAt=Date.parse(finalNow);
 const terminalReason=policy.kind!=='available'?policy.reason:!bookingPolicySnapshotReadyAt(policy.snapshot,finalNow)?'booking_readiness_unavailable':bookingChangeCostReason(cost,policy.snapshot,finalNow)??(row.dispatch_started_at===null&&row.original_starts_at.getTime()<=finalAt?'meeting_not_changeable':row.dispatch_started_at===null&&row.action==='reschedule'?bookingSlotReason(row.starts_at!.toISOString(),finalNow):null);
 if(terminalReason!==null||policy.kind!=='available'){await input.session.query("UPDATE booking_change_submissions SET state=CASE WHEN dispatch_started_at IS NULL THEN 'failed' ELSE state END,reason=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2",[input.scope.workspaceId,id,terminalReason]);return null;}
 const snapshot=policy.snapshot,validUntil=Math.min(Date.parse(snapshot.authorityValidUntil!),Date.parse(cost!.validUntil));
 const call:BookingChangeCall={submissionId:id,action:row.action,bookingUid:row.target_booking_uid,accountId:Number(row.provider_account_id),eventTypeId:Number(row.event_type_id),organizerEmail:snapshot.bindings.account.email,attendeeEmail:valid.attendeeEmail,originalStartsAt:row.original_starts_at.toISOString(),originalEndsAt:row.original_ends_at.toISOString(),startsAt:row.starts_at?.toISOString()??null,timeZone:parsed.data.action==='reschedule'?parsed.data.agreedSlot.timeZone:null};
 if(dispatch&&row.dispatch_started_at===null){
  // No await after terminal time/slot checks before the durable marker query is issued.
  const now=runtime.policy.now();const slot=call.action==='reschedule'?bookingSlotReason(call.startsAt!,now):null;
  const refusal=!Number.isFinite(Date.parse(now))||Date.parse(now)>=validUntil?'booking_readiness_unavailable':Date.parse(call.originalStartsAt)<=Date.parse(now)?'meeting_not_changeable':slot??(!matchesTarget(call,reads?.target??null)?'provider_target_unsupported':reads?.availability.available!==true?reads?.availability.reason??'availability_unknown':null);
  if(refusal!==null){await input.session.query("UPDATE booking_change_submissions SET state='failed',reason=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2",[input.scope.workspaceId,id,refusal]);return null;}
  const marked=await input.session.query("UPDATE booking_change_submissions SET state='unknown',dispatch_started_at=clock_timestamp(),reason='provider_acceptance_unknown',updated_at=now() WHERE workspace_id=$1 AND id=$2 AND dispatch_started_at IS NULL AND EXISTS(SELECT 1 FROM jobs WHERE workspace_id=$1 AND id=$3 AND state='running' AND lease_owner=$4 AND fencing_token=$5::bigint AND lease_expires_at>clock_timestamp()) RETURNING id",[input.scope.workspaceId,id,input.job.id,input.job.leaseOwner,input.job.fencingToken]);if(marked.rows.length!==1)return null;
  return {row,snapshot,call,dispatchClaimed:true};
 }
 return {row,snapshot,call,dispatchClaimed:false};
});}
async function settle(input:JobHandlerInput,id:string,observation:BookingChangeObservation,call:BookingChangeCall):Promise<void>{await withTransaction(input.session,async()=>{
 const context=repositoryContext(input.scope,input.session);
 await lockSendGateForStopFact(context);
 let row=(await input.session.query<BookingChangeRow>('SELECT * FROM booking_change_submissions WHERE workspace_id=$1 AND id=$2',[input.scope.workspaceId,id])).rows[0];if(!row||row.dispatch_started_at===null||['accepted','failed'].includes(row.state))return;
 // Subject deletion and source erasure are distinct. Keep external action facts,
 // but never reintroduce a deleted attendee through the no-meeting event branch.
 const subjectDeleted=await attendeeTombstoned(context,call.attendeeEmail);
 if(subjectDeleted)await input.session.query("UPDATE booking_change_submissions SET payload='{}'::jsonb,source_fingerprint=repeat('0',64),target_fingerprint=repeat('0',64),provenance_state='redacted',meeting_id=NULL,reason='subject_deleted',updated_at=now() WHERE workspace_id=$1 AND id=$2",[input.scope.workspaceId,id]);
 if(observation.state!=='accepted'){row=(await input.session.query<BookingChangeRow>('SELECT * FROM booking_change_submissions WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[input.scope.workspaceId,id])).rows[0];if(!row||['accepted','failed'].includes(row.state))return;await input.session.query("UPDATE booking_change_submissions SET state=$3,reason=CASE WHEN provenance_state='redacted' THEN reason ELSE $4 END,updated_at=now() WHERE workspace_id=$1 AND id=$2",[input.scope.workspaceId,id,observation.state,observation.reason]);return;}
 const b=observation.booking,startsAt=row.action==='reschedule'?row.starts_at!:row.original_starts_at;
 // External evidence is retained even if deletion or revocation won the wait. Never invent undo.
 if(!/^[A-Za-z0-9_-]{1,128}$/u.test(b.uid)||!Number.isFinite(Date.parse(b.updatedAt))||b.organizerEmail.toLowerCase()!==call.organizerEmail.toLowerCase()||b.attendeeEmail.toLowerCase()!==call.attendeeEmail||b.submissionId!==id||b.previousUid!==row.target_booking_uid||b.action!==row.action||b.accountId!==Number(row.provider_account_id)||b.eventTypeId!==Number(row.event_type_id)||Date.parse(b.startsAt)!==startsAt.getTime()||Date.parse(b.endsAt)-Date.parse(b.startsAt)!==20*60_000||b.reminderState!=='unverified'&&b.reminderState!==(row.action==='cancel'?'stopped':'replaced')||row.action==='cancel'&&b.uid!==row.target_booking_uid){await input.session.query("UPDATE booking_change_submissions SET state='unknown',reason=CASE WHEN provenance_state='redacted' THEN reason ELSE 'provider_evidence_mismatch' END,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state NOT IN ('accepted','failed')",[input.scope.workspaceId,id]);return;}
 if(!subjectDeleted)await receiveSynthesizedCalcomEvent(input.session,{workspaceId:input.scope.workspaceId,eventId:createHash('sha256').update(`booking_change:${id}:${b.uid}:${b.updatedAt}`).digest('hex'),event:{trigger:row.action==='cancel'?'BOOKING_CANCELLED':'BOOKING_RESCHEDULED',createdAt:b.updatedAt,uid:b.uid,rescheduleUid:row.action==='reschedule'?row.target_booking_uid:null,startsAt:b.startsAt,endsAt:b.endsAt,organizerEmail:b.organizerEmail,attendeeEmail:b.attendeeEmail,noShow:null}});
 row=(await input.session.query<BookingChangeRow>('SELECT * FROM booking_change_submissions WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[input.scope.workspaceId,id])).rows[0];if(!row||['accepted','failed'].includes(row.state))return;
 await input.session.query("UPDATE booking_change_submissions SET state=$5,provider_booking_uid=$3,reminder_state=$4,reason=CASE WHEN provenance_state='redacted' THEN reason ELSE $6 END,updated_at=now() WHERE workspace_id=$1 AND id=$2",[input.scope.workspaceId,id,b.uid,b.reminderState,b.reminderState==='unverified'?'unknown':'accepted',b.reminderState==='unverified'?'provider_reminder_unverified':null]);
});}
