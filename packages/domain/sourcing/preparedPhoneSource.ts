import type {SourceObservation} from '@fss/contracts';
import type {LiteralAuthority} from './manualProspectLiteralPhone.ts';
import type {ManualPhoneSnapshot} from './manualProspectPhone.ts';
import {admitPreparedPages} from './preparedPageAdmission.ts';

/** A prepared page supports a manual phone for at most this long after retrieval, matching the
 * seven-day ceiling of a phone-discovery run; an earlier source or capture deadline still wins. */
export const PREPARED_PHONE_HORIZON_MS=7*24*60*60*1000;
export interface PreparedPhoneSource {observations:SourceObservation[];authorities:Record<string,LiteralAuthority>;website:string|null;partial:boolean}
/** ADR0034: for a candidate whose latest run has a current prepared source association, the
 * literal scan reads exactly the pages the prepared brief may cite (shared admission), each under
 * the `prepared_capture` authority, never the broader retained-original grants. Pages the brief
 * would not show are skipped rather than poisoning the scan, and `partial` records that skip.
 * Any other candidate returns null and keeps the unchanged exact retained-original path. */
export function preparedPhoneSource(snapshot:ManualPhoneSnapshot,now:number):PreparedPhoneSource|null{
 const admitted=admitPreparedPages(snapshot,now);
 if(!admitted.capturedIds.size)return null;
 const observations:SourceObservation[]=[],authorities:Record<string,LiteralAuthority>={};
 let partial=admitted.unshown;
 for(const {source} of admitted.pages){
  const expiresAt=Math.min(Date.parse(source.retrievedAt)+PREPARED_PHONE_HORIZON_MS,admitted.captureDeadline??Infinity);
  if(!Number.isFinite(expiresAt)||expiresAt<=now){partial=true;continue;}
  observations.push(source);
  authorities[source.id]={kind:'prepared_capture',sourceUrl:source.url,expiresAt:new Date(expiresAt).toISOString()};
 }
 return {observations,authorities,website:admitted.website,partial};
}
