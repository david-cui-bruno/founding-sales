import {createHash} from 'node:crypto';
import type {BookingChangePayload} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {readCurrentBookingPolicy,revalidateBookingPolicy,bookingPolicySnapshotReadyAt} from './bookingPolicy.ts';
import {lockSettingForRead} from '../settings/store.ts';
import {readMailConversationV2} from '../mail/crmMailOriginals.ts';
import {snapshotMailCopyAuthorityBatch,lockMailCopyAuthorityBatch} from '../mail/crmSources.ts';
import {lockIdentityContext} from '../crm/identityAccess.ts';
import {bookingSlotReason} from './bookingCreate.ts';
import {bookingChangeCostReason,type BookingChangeRuntime} from './bookingChangeProvider.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
export interface BookingChangeMeeting extends Record<string,unknown>{id:string;firm_id:string;contact_id:string;state:string;current_booking_uid:string;starts_at:Date;ends_at:Date;last_event_at:Date;organizer_email:string;attendee_email:string}
export function bookingChangeHash(value:unknown):string {
 function canonical(v:unknown):string {if(v instanceof Date)return JSON.stringify(v.toISOString());if(Array.isArray(v))return `[${v.map(canonical).join(',')}]`;if(v!==null&&typeof v==='object')return `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical((v as Record<string,unknown>)[k])}`).join(',')}}`;return JSON.stringify(v);}
 return createHash('sha256').update(canonical(value)).digest('hex');
}
/** Source/read/access ports are shared, but a cancellation is never forged into a create agreement. */
export async function validateBookingChange(context:RepositoryContext,input:BookingChangePayload,runtime:BookingChangeRuntime,expectedBindingKey?:string,inspectionOnly=false){
 const actor=context.scope.actor;if(actor.kind!=='user'||actor.role!=='admin')return {ok:false as const,reason:'owner_required'};
 // Same workspace send gate as opt-out and Cal lifecycle writers, before any rows.
 await lockSendGateForStopFact(context);
 const member=(await context.db.query<{role:string;status:string}>('SELECT role,status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[context.scope.workspaceId,actor.userId])).rows[0];if(member?.role!=='admin'||member.status!=='active')return {ok:false as const,reason:'owner_required'};
 const sources=[input.agreement,...(input.action==='reschedule'&&input.offeredContext!==undefined?[input.offeredContext]:[])];
 const routeIdentity=(await context.db.query<{firm_id:string;contact_id:string}>('SELECT firm_id,contact_id FROM email_addresses WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,input.attendeeRouteId])).rows[0];
 if(!routeIdentity)return {ok:false as const,reason:'attendee_unsupported'};
 const closure=await snapshotMailCopyAuthorityBatch(context,sources);
 if(closure===null||!await lockIdentityContext(context,{firmIds:[...closure.firmIds,routeIdentity.firm_id],personIds:closure.personIds})||!await lockMailCopyAuthorityBatch(context,closure,{firmIds:closure.firmIds,personIds:closure.personIds,lockMode:'write'}))return {ok:false as const,reason:'source_unavailable'};
 // Match interpretation reads: acquire the canonical source closure before policy authority.
 await lockSettingForRead(context,'booking_policy');
 const policy=await readCurrentBookingPolicy(context,{ownerUserId:actor.userId,capability:'provider_action',expectedRevision:input.expectedPolicyRevision,...(expectedBindingKey===undefined?{}:{expectedBindingKey})},runtime.policy);
 if(policy.kind!=='available')return {ok:false as const,reason:policy.reason};const snapshot=policy.snapshot;
 if(!snapshot.operationalReady)return {ok:false as const,reason:'booking_readiness_unavailable'};
 if(!/^\d+$/.test(snapshot.bindings.account.accountId)||!Number.isSafeInteger(Number(snapshot.bindings.account.accountId))||Number(snapshot.bindings.account.accountId)<1)return {ok:false as const,reason:'unsupported_provider_account'};
 const agreement=await readMailConversationV2(context,input.agreement);
 if(agreement.state!=='available'||!('originalObservation' in agreement.source))return {ok:false as const,reason:'source_unavailable'};const source=agreement.source;
 if(source.ownerUserId!==actor.userId||source.direction!=='incoming'||source.accountBinding!==snapshot.bindings.sender.accountId||source.originalObservation.connectionState!=='current'||['trashed','confirmed_missing','transient_unavailable'].includes(source.originalObservation.state)||source.completeness!=='complete'||(!Array.isArray(source.ranges)||!source.ranges.some((r:unknown)=>typeof r==='object'&&r!==null&&'kind' in r&&r.kind==='authored')))return {ok:false as const,reason:'source_authority_changed'};
 const route=(await context.db.query<{address:string;full_name:string;version:number;firm_id:string;contact_id:string}>(`SELECT e.address,c.full_name,e.version,e.firm_id,e.contact_id FROM email_addresses e JOIN contacts c ON c.workspace_id=e.workspace_id AND c.id=e.contact_id WHERE e.workspace_id=$1 AND e.id=$2 AND e.retired_at IS NULL AND e.technical_validation='passed' AND e.association_confidence>=0.8 AND c.firm_id=e.firm_id FOR SHARE OF e,c`,[context.scope.workspaceId,input.attendeeRouteId])).rows[0];
 if(!route||route.firm_id!==routeIdentity.firm_id||route.contact_id!==routeIdentity.contact_id||route.address.toLowerCase()!==source.envelope.from?.toLowerCase())return {ok:false as const,reason:'attendee_unsupported'};
 if((await context.db.query('SELECT id FROM email_addresses WHERE workspace_id=$1 AND lower(address)=lower($2) AND retired_at IS NULL AND (contact_id IS DISTINCT FROM $3 OR firm_id IS DISTINCT FROM $4)',[context.scope.workspaceId,route.address,route.contact_id,route.firm_id])).rows.length)return {ok:false as const,reason:'attendee_ambiguous'};
 if((await context.db.query(`SELECT event_id FROM effective_suppressions WHERE workspace_id=$1 AND ((scope='firm' AND canonical_key=$2) OR (scope='handle' AND canonical_key=lower($3))) LIMIT 1`,[context.scope.workspaceId,route.firm_id,route.address])).rows.length)return {ok:false as const,reason:'attendee_opted_out'};
 const thread=(await context.db.query<{provider_thread_id:string}>('SELECT provider_thread_id FROM mail_messages WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,source.sourceId])).rows[0]?.provider_thread_id;
 if(!thread)return {ok:false as const,reason:'source_unavailable'};
 if(input.action==='reschedule'&&input.offeredContext!==undefined){const prior=await readMailConversationV2(context,input.offeredContext);if(prior.state!=='available'||!('originalObservation' in prior.source))return {ok:false as const,reason:'offered_context_unavailable'};const offer=prior.source;
 const priorThread=(await context.db.query<{provider_thread_id:string}>('SELECT provider_thread_id FROM mail_messages WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,offer.sourceId])).rows[0]?.provider_thread_id;
 if(offer.ownerUserId!==actor.userId||offer.direction!=='outgoing'||!offer.sentProof||offer.originalObservation.connectionState!=='current'||['trashed','confirmed_missing','transient_unavailable'].includes(offer.originalObservation.state)||offer.mailboxId!==source.mailboxId||offer.accountBinding!==source.accountBinding||offer.acquiredGeneration!==source.acquiredGeneration||priorThread!==thread||Date.parse(offer.occurredAt)>=Date.parse(source.occurredAt)||!offer.envelope.to.some(email=>email.toLowerCase()===route.address.toLowerCase()))return {ok:false as const,reason:'offered_context_unsupported'};}
 const meeting=(await context.db.query<BookingChangeMeeting>('SELECT id,firm_id,contact_id,state,current_booking_uid,starts_at,ends_at,last_event_at,organizer_email,attendee_email FROM meetings WHERE workspace_id=$1 AND id=$2 FOR SHARE',[context.scope.workspaceId,input.meetingId])).rows[0];
 const knownTarget=meeting!==undefined&&(meeting.current_booking_uid===input.expectedBookingUid||inspectionOnly&&(await context.db.query('SELECT booking_uid FROM meeting_booking_uids WHERE workspace_id=$1 AND meeting_id=$2 AND booking_uid=$3',[context.scope.workspaceId,input.meetingId,input.expectedBookingUid])).rows.length===1);
 if(!meeting||!knownTarget||meeting.firm_id!==route.firm_id||meeting.contact_id!==route.contact_id||meeting.attendee_email?.toLowerCase()!==route.address.toLowerCase()||meeting.organizer_email?.toLowerCase()!==snapshot.bindings.account.email.toLowerCase())return {ok:false as const,reason:'meeting_unsupported'};
 if(!inspectionOnly&&(!['booked','rescheduled'].includes(meeting.state)||meeting.ends_at.getTime()-meeting.starts_at.getTime()!==20*60_000||meeting.starts_at.getTime()<=Date.parse(runtime.policy.now())))return {ok:false as const,reason:'meeting_not_changeable'};
 // Re-read canonical policy and exact change cost after source/identity/meeting waits.
 const cost=await runtime.readCostContract(snapshot);
 const current=await revalidateBookingPolicy(context,snapshot,runtime.policy);
 if(current.kind!=='available')return {ok:false as const,reason:current.reason};if(!current.snapshot.operationalReady)return {ok:false as const,reason:'booking_readiness_unavailable'};
 const now=runtime.policy.now();
 if(!bookingPolicySnapshotReadyAt(current.snapshot,now))return {ok:false as const,reason:'booking_readiness_unavailable'};
 const costReason=bookingChangeCostReason(cost,snapshot,now);if(costReason!==null)return {ok:false as const,reason:costReason};
 if(input.action==='reschedule'&&!inspectionOnly){const slot=bookingSlotReason(input.agreedSlot.startsAt,now);if(slot!==null)return {ok:false as const,reason:slot};}
 return {ok:true as const,snapshot,meeting,attendeeAuthority:{routeId:input.attendeeRouteId,firmId:route.firm_id,contactId:route.contact_id,address:route.address,version:route.version},attendeeEmail:route.address.toLowerCase(),fingerprint:bookingChangeHash({closure,route,thread,original:source.originalObservation,account:source.accountBinding,generation:source.acquiredGeneration}),targetFingerprint:bookingChangeHash(meeting),validUntil:Math.min(Date.parse(current.snapshot.authorityValidUntil!),Date.parse(cost!.validUntil))};
}
