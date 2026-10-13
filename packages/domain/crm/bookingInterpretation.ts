import type { BookingInterpretationRequest, BookingInterpretationSource } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { loadBookingInterpretationSources } from './bookingInterpretationSources.ts';
import {unavailableBookingInterpretationAuthority,type BookingInterpretationAuthorityPort} from './bookingInterpretationAuthority.ts';
import {enqueueJob} from '../jobs/jobStore.ts';
import {jobIdempotencyKey} from '../jobs/jobKinds.ts';
import {readAttempt} from '../research/reservations.ts';
import type {BookingPolicySnapshot} from '../meetings/bookingPolicyTypes.ts';
import {bookingPolicySnapshotReadyAt} from '../meetings/bookingPolicy.ts';
import {settingLockName} from '../settings/store.ts';

export interface BookingInterpretationRow extends Record<string, unknown> {
  id: string; requested_by: string; source_refs: BookingInterpretationSource[]; source_fingerprint: string;
  provenance: unknown; authority_snapshot: unknown; state: string; reason: string | null; outcome: unknown; reservation_id: string | null;
}
export const BOOKING_INTERPRETATION_LIMITATIONS = ['candidate_not_permission', 'no_sending_or_booking', 'linkedin_intake_unavailable', 'actual_model_quality_unverified'] as const;
function view(row: BookingInterpretationRow) {
  return { requestId: row.id, state: row.state, reason: row.reason, outcome: row.outcome,
    provenance: row.provenance, limitations: BOOKING_INTERPRETATION_LIMITATIONS };
}
export async function unresolvedBookingModelAttempt(context:RepositoryContext,sourceId:string,exceptRequestId?:string) {
 return (await context.db.query(`SELECT 1 FROM crm_booking_interpretations i JOIN provider_reservations r ON r.workspace_id=i.workspace_id AND r.id=i.reservation_id WHERE i.workspace_id=$1 AND i.source_refs @> $2::jsonb AND ($3::uuid IS NULL OR i.id<>$3) AND r.state IN ('calling','estimated') LIMIT 1`,[context.scope.workspaceId,JSON.stringify([{sourceId}]),exceptRequestId??null])).rows.length>0;
}
export async function requestBookingInterpretation(context: RepositoryContext, input: BookingInterpretationRequest, authority:BookingInterpretationAuthorityPort=unavailableBookingInterpretationAuthority) {
  if (context.scope.actor.kind !== 'user') return { ok: false as const, reason: 'booking_access_denied' };
  const sources = [input.source, ...input.priorSources];
  const loaded = await loadBookingInterpretationSources(context, sources);
  if (!loaded || loaded.originals[0]!.ownerUserId !== context.scope.actor.userId) return { ok: false as const, reason: 'booking_source_unavailable' };
  const current=await authority.read(context,{ownerUserId:context.scope.actor.userId});
  const unresolved=await unresolvedBookingModelAttempt(context,input.source.sourceId);
  const snapshot=!unresolved&&current.kind==='available'&&bookingPolicySnapshotReadyAt(current.snapshot,new Date().toISOString())&&current.snapshot.capability==='interpretation'?current.snapshot:null;
  const state=snapshot===null?'unavailable':'pending';
  const reason=unresolved?'prior_model_acceptance_unresolved':current.kind==='unavailable'?current.reason:snapshot===null?'booking_interpretation_not_ready':null;
  const row = (await context.db.query<BookingInterpretationRow>(
    `INSERT INTO crm_booking_interpretations(workspace_id,requested_by,source_refs,source_fingerprint,provenance,state,reason,authority_snapshot)
     VALUES($1,$2,$3::jsonb,$4,$5::jsonb,$6,$7,$8::jsonb) RETURNING *`,
    [context.scope.workspaceId, context.scope.actor.userId, JSON.stringify(sources), loaded.fingerprint, JSON.stringify(loaded.provenance),state,reason,snapshot===null?null:JSON.stringify(snapshot)])).rows[0]!;
  if(snapshot!==null){
   await enqueueJob(context.db,{workspaceId:context.scope.workspaceId,kind:'crm.booking_interpretation',idempotencyKey:jobIdempotencyKey.bookingInterpretation(row.id),payload:{requestId:row.id}});
   if(!bookingPolicySnapshotReadyAt(snapshot,new Date().toISOString()))await context.db.query("UPDATE crm_booking_interpretations SET state='unavailable',reason='booking_authority_expired_before_queue',authority_snapshot=NULL WHERE workspace_id=$1 AND id=$2 AND state='pending'",[context.scope.workspaceId,row.id]);
  }
  return { ok: true as const, value: {requestId:row.id} };
}
export async function readBookingInterpretation(context: RepositoryContext, input: { requestId: string },authority:BookingInterpretationAuthorityPort=unavailableBookingInterpretationAuthority,authorize?:()=>Promise<boolean>) {
  if (context.scope.actor.kind !== 'user') return null;
  const row = (await context.db.query<BookingInterpretationRow>('SELECT * FROM crm_booking_interpretations WHERE workspace_id=$1 AND id=$2 AND requested_by=$3',
    [context.scope.workspaceId, input.requestId, context.scope.actor.userId])).rows[0];
  if (!row) return null;
  const receipt=await readAttempt(context,{subjectKind:'booking_interpretation',subjectId:row.id,attempt:1});
  const financial=receipt===null?null:{state:receipt.state,reservedCents:receipt.cents,settledCents:receipt.settledCents};
  const loaded = await loadBookingInterpretationSources(context, row.source_refs);
  if(authorize!==undefined&&!await authorize())return null;
  if (!loaded || loaded.fingerprint !== row.source_fingerprint) return { requestId: row.id, state: 'stale', reason: 'source_or_access_changed', outcome: null, provenance: null, financial, limitations: BOOKING_INTERPRETATION_LIMITATIONS };
  if(row.authority_snapshot!==null){
   await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[settingLockName(context.scope.workspaceId,'booking_policy')]);
   const current=await authority.revalidate(context,row.authority_snapshot as BookingPolicySnapshot);
   if(authorize!==undefined&&!await authorize())return null;
   if(current.kind!=='available'||!bookingPolicySnapshotReadyAt(current.snapshot,new Date().toISOString()))return {...view(row),state:'unavailable',reason:'booking_authority_changed',outcome:null,financial};
  }
  return {...view(row),financial};
}
