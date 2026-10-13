import {createHash,randomUUID} from 'node:crypto';
import {bookingCreatePayloadSchema,type BookingCreatePayload,type BookingCreateReceipt} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {readCurrentBookingPolicy} from './bookingPolicy.ts';
import {lockSettingForRead} from '../settings/store.ts';
import {readMailConversationV2} from '../mail/crmMailOriginals.ts';
import {snapshotMailCopyAuthorityBatch,lockMailCopyAuthorityBatch} from '../mail/crmSources.ts';
import {lockIdentityContext} from '../crm/identityAccess.ts';
import {enqueueJob} from '../jobs/jobStore.ts';
import {jobIdempotencyKey} from '../jobs/jobKinds.ts';
import {bookingCreateCostReason,type BookingCreateRuntime} from './bookingCreateRuntime.ts';
import type {BookingPolicySnapshot} from './bookingPolicyTypes.ts';
export type BookingCreateResult={ok:true;value:BookingCreateReceipt}|{ok:false;reason:string};
export interface BookingCreateRow extends Record<string,unknown>{id:string;owner_user_id:string;policy_revision:number;binding_key:string;payload:BookingCreatePayload;request_hash:string;state:BookingCreateReceipt['state'];provider_booking_uid:string|null;meeting_id:string|null;reason:string|null;dispatch_started_at:Date|null;starts_at:Date;provider_account_id:string;event_type_id:string}
export function bookingCreateReceipt(row:BookingCreateRow):BookingCreateReceipt{return {submissionId:row.id,state:row.state,providerBookingUid:row.provider_booking_uid,meetingId:row.meeting_id,reason:row.reason,dispatchStartedAt:row.dispatch_started_at?.toISOString()??null};}
export function bookingSlotReason(startsAt:string,now:string):string|null{
 const start=Date.parse(startsAt),current=Date.parse(now);if(!Number.isFinite(start)||!Number.isFinite(current))return 'invalid_slot';
 if(start-current<120*60_000)return 'notice_too_short';if(start-current>14*86400_000)return 'outside_booking_horizon';
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',weekday:'short',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(start),get=(key:string)=>parts.find(p=>p.type===key)?.value;
 const minute=Number(get('hour'))*60+Number(get('minute'));if(['Sat','Sun'].includes(get('weekday')??'')||minute<540||minute+20>1080||get('second')!=='00'||start%1000!==0)return 'outside_business_hours';return null;
}
/** Re-read exact originals and immutable contexts under their existing authority lock closure. No second copy of mail. */
export async function validateBookingCreate(context:RepositoryContext,input:BookingCreatePayload,runtime:BookingCreateRuntime,expectedBindingKey?:string):Promise<{ok:true;snapshot:BookingPolicySnapshot;attendee:{name:string;email:string;timeZone:string};fingerprint:string}|{ok:false;reason:string}>{
 const actor=context.scope.actor;if(actor.kind!=='user'||actor.role!=='admin')return {ok:false,reason:'owner_required'};
 const member=(await context.db.query<{role:string;status:string}>('SELECT role,status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[context.scope.workspaceId,actor.userId])).rows[0];if(member?.role!=='admin'||member.status!=='active')return {ok:false,reason:'owner_required'};
 await lockSettingForRead(context,'booking_policy');
 const policy=await readCurrentBookingPolicy(context,{ownerUserId:actor.userId,expectedRevision:input.expectedPolicyRevision,...(expectedBindingKey===undefined?{}:{expectedBindingKey})},runtime.policy);
 if(policy.kind!=='available')return {ok:false,reason:policy.reason};const snapshot=policy.snapshot;
 if(!snapshot.operationalReady)return {ok:false,reason:'booking_readiness_unavailable'};
 const cost=await bookingCreateCostReason(runtime,snapshot);if(cost!==null)return {ok:false,reason:cost};
 const slot=bookingSlotReason(input.agreedSlot.startsAt,runtime.policy.now());if(slot!==null)return {ok:false,reason:slot};
 if(!/^\d+$/.test(snapshot.bindings.account.accountId)||!Number.isSafeInteger(Number(snapshot.bindings.account.accountId))||Number(snapshot.bindings.account.accountId)<1)return {ok:false,reason:'unsupported_provider_account'};
 const sources=[input.agreement,...(input.offeredContext===undefined?[]:[input.offeredContext])];
 const closure=await snapshotMailCopyAuthorityBatch(context,sources);if(closure===null||!await lockIdentityContext(context,{firmIds:closure.firmIds,personIds:closure.personIds})||!await lockMailCopyAuthorityBatch(context,closure,{firmIds:closure.firmIds,personIds:closure.personIds,lockMode:'read'}))return {ok:false,reason:'source_unavailable'};
 const agreement=await readMailConversationV2(context,input.agreement);if(agreement.state!=='available'||!('originalObservation' in agreement.source))return {ok:false,reason:'source_unavailable'};
 const source=agreement.source;
 if(source.ownerUserId!==actor.userId||source.direction!=='incoming'||source.accountBinding!==snapshot.bindings.sender.accountId||source.originalObservation.connectionState!=='current'||['trashed','confirmed_missing','transient_unavailable'].includes(source.originalObservation.state)||source.completeness!=='complete'||(!Array.isArray(source.ranges)||!source.ranges.some((r:unknown)=>typeof r==='object'&&r!==null&&'kind' in r&&r.kind==='authored')))return {ok:false,reason:'source_authority_changed'};
 const route=(await context.db.query<{address:string;full_name:string;version:number;firm_id:string;contact_id:string}>(`SELECT e.address,c.full_name,e.version,e.firm_id,e.contact_id FROM email_addresses e JOIN contacts c ON c.workspace_id=e.workspace_id AND c.id=e.contact_id WHERE e.workspace_id=$1 AND e.id=$2 AND e.retired_at IS NULL AND e.technical_validation='passed' AND e.association_confidence>=0.8 AND c.firm_id=e.firm_id FOR SHARE OF e,c`,[context.scope.workspaceId,input.attendeeRouteId])).rows[0];
 if(route===undefined||route.address.toLowerCase()!==source.envelope.from?.toLowerCase()||!(await context.db.query('SELECT id FROM firms WHERE workspace_id=$1 AND id=$2 AND (assigned_user_id=$3 OR $4) FOR SHARE',[context.scope.workspaceId,route.firm_id,actor.userId,actor.role==='admin'])).rows.length)return {ok:false,reason:'attendee_unsupported'};
 if((await context.db.query('SELECT id FROM email_addresses WHERE workspace_id=$1 AND lower(address)=lower($2) AND retired_at IS NULL AND (contact_id IS DISTINCT FROM $3 OR firm_id IS DISTINCT FROM $4)',[context.scope.workspaceId,route.address,route.contact_id,route.firm_id])).rows.length)return {ok:false,reason:'attendee_ambiguous'};
 const thread=(await context.db.query<{provider_thread_id:string}>('SELECT provider_thread_id FROM mail_messages WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,source.sourceId])).rows[0]?.provider_thread_id;
 if(!thread)return {ok:false,reason:'source_unavailable'};
 if(input.offeredContext!==undefined){const prior=await readMailConversationV2(context,input.offeredContext);if(prior.state!=='available'||!('originalObservation' in prior.source))return {ok:false,reason:'offered_context_unavailable'};const offer=prior.source;
 const priorThread=(await context.db.query<{provider_thread_id:string}>('SELECT provider_thread_id FROM mail_messages WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,offer.sourceId])).rows[0]?.provider_thread_id;
 if(offer.ownerUserId!==actor.userId||offer.direction!=='outgoing'||!offer.sentProof||offer.originalObservation.connectionState!=='current'||['trashed','confirmed_missing','transient_unavailable'].includes(offer.originalObservation.state)||offer.mailboxId!==source.mailboxId||offer.accountBinding!==source.accountBinding||offer.acquiredGeneration!==source.acquiredGeneration||priorThread!==thread||Date.parse(offer.occurredAt)>=Date.parse(source.occurredAt)||!offer.envelope.to.some(email=>email.toLowerCase()===route.address.toLowerCase()))return {ok:false,reason:'offered_context_unsupported'};}
 return {ok:true,snapshot,attendee:{name:route.full_name,email:route.address.toLowerCase(),timeZone:input.agreedSlot.timeZone},fingerprint:createHash('sha256').update(JSON.stringify({closure,route,thread,original:source.originalObservation,account:source.accountBinding,generation:source.acquiredGeneration})).digest('hex')};
}
/** Ordinary command transaction owns the durable reservation and job atomically. */
export async function requestBookingCreate(context:RepositoryContext,raw:BookingCreatePayload,runtime?:BookingCreateRuntime):Promise<BookingCreateResult>{
 const parsed=bookingCreatePayloadSchema.safeParse(Object.fromEntries(Object.entries(raw).filter(([key])=>key!=='commandId'&&key!=='clientVersion')));if(!parsed.success)return {ok:false,reason:'invalid_input'};const input=parsed.data;
 if(runtime===undefined)return {ok:false,reason:'booking_runtime_unavailable'};
 const valid=await validateBookingCreate(context,input,runtime);if(!valid.ok)return valid;
 const owner=context.scope.actor;if(owner.kind!=='user')return {ok:false,reason:'owner_required'};
 await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${context.scope.workspaceId}:booking_create:${valid.snapshot.bindings.account.accountId}`]);
 const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
 const duplicate=(await context.db.query<BookingCreateRow>('SELECT * FROM booking_create_submissions WHERE workspace_id=$1 AND owner_user_id=$2 AND request_hash=$3',[context.scope.workspaceId,owner.userId,hash])).rows[0];if(duplicate)return {ok:true,value:bookingCreateReceipt(duplicate)};
 if((await context.db.query(`SELECT id FROM booking_create_submissions WHERE workspace_id=$1 AND provider_account_id=$2 AND state IN ('pending','accepted','unknown') AND starts_at<$3::timestamptz+interval '30 minutes' AND buffer_ends_at>$3::timestamptz`,[context.scope.workspaceId,valid.snapshot.bindings.account.accountId,input.agreedSlot.startsAt])).rows.length)return {ok:false,reason:'slot_unavailable'};
 const row=(await context.db.query<BookingCreateRow>(`INSERT INTO booking_create_submissions(workspace_id,owner_user_id,policy_revision,binding_key,provider_account_id,event_type_id,request_hash,payload,starts_at,buffer_ends_at,source_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9::timestamptz+interval '30 minutes',$10) RETURNING *`,[context.scope.workspaceId,owner.userId,valid.snapshot.policyRevision,valid.snapshot.bindingKey,valid.snapshot.bindings.account.accountId,valid.snapshot.bindings.event.eventTypeId,hash,JSON.stringify(input),input.agreedSlot.startsAt,valid.fingerprint])).rows[0]!;
 await enqueueJob(context.db,{workspaceId:context.scope.workspaceId,kind:'meeting.booking_create',idempotencyKey:jobIdempotencyKey.bookingCreate(row.id),payload:{submissionId:row.id}});return {ok:true,value:bookingCreateReceipt(row)};
}
export async function readBookingCreate(context:RepositoryContext,submissionId:string):Promise<BookingCreateReceipt|null>{const actor=context.scope.actor;if(actor.kind!=='user')return null;const row=(await context.db.query<BookingCreateRow>(`SELECT b.* FROM booking_create_submissions b JOIN workspace_memberships m ON m.workspace_id=b.workspace_id AND m.user_id=b.owner_user_id WHERE b.workspace_id=$1 AND b.id=$2 AND b.owner_user_id=$3 AND m.status='active' AND m.role='admin'`,[context.scope.workspaceId,submissionId,actor.userId])).rows[0];return row?bookingCreateReceipt(row):null;}
export async function requestBookingInspection(context:RepositoryContext,submissionId:string):Promise<BookingCreateResult>{const receipt=await readBookingCreate(context,submissionId);if(receipt===null)return {ok:false,reason:'booking_unknown'};if(receipt.dispatchStartedAt!==null&&['unknown','pending'].includes(receipt.state))await enqueueJob(context.db,{workspaceId:context.scope.workspaceId,kind:'meeting.booking_create',idempotencyKey:`${jobIdempotencyKey.bookingCreate(submissionId)}:inspect:${randomUUID()}`,payload:{submissionId,inspectionOnly:true}});return {ok:true,value:receipt};}
