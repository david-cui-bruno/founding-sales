import type {SourceObservation} from '@fss/contracts';
import type {LiteralAuthority} from './manualProspectLiteralPhone.ts';
import type {ManualPhoneSnapshot} from './manualProspectPhone.ts';
import {admitPreparedPages} from './preparedPageAdmission.ts';

/** A prepared page supports a manual phone for at most this long after retrieval, matching the
 * seven-day ceiling of a phone-discovery run; an earlier source or capture deadline still wins. */
export const PREPARED_PHONE_HORIZON_MS=7*24*60*60*1000;
export interface PreparedPhoneSource {observations:SourceObservation[];authorities:Record<string,LiteralAuthority>;website:string|null;partial:boolean}
/** ADR0034: Calling's prepared phone read scans exactly the pages the prepared brief may cite (shared admission:
 * current grant or current prepared source association, same host, hash-bound, unexpired), each under the
 * `prepared_capture` authority and bounded by its own deadline. The brief needs no capture manifest (a page can be
 * admitted through its exact candidate/origin/evidence grant), so neither does this read. Pages the brief would not
 * show are skipped rather than poisoning the scan, and `partial` records that skip. Null only when no page is admitted,
 * which keeps the unchanged exact retained-original path. */
export function preparedPhoneSource(snapshot:ManualPhoneSnapshot,now:number):PreparedPhoneSource|null{
 // Page deadlines come from the shared prepared-source collection. A snapshot never decorated with them is not a basis.
 const recorded=snapshot['prepared_source_deadlines'];
 if(typeof recorded!=='object'||recorded===null||Array.isArray(recorded))return null;
 const deadlines=new Map(Object.entries(recorded).flatMap(([url,at])=>typeof at==='number'?[[url,at] as const]:[]));
 const admitted=admitPreparedPages(snapshot,now,deadlines);
 const observations:SourceObservation[]=[],authorities:Record<string,LiteralAuthority>={};
 let partial=admitted.unshown;
 for(const {source,expires} of admitted.pages){
  const expiresAt=Math.min(Date.parse(source.retrievedAt)+PREPARED_PHONE_HORIZON_MS,admitted.captureDeadline??Infinity,expires??Infinity);
  if(!Number.isFinite(expiresAt)||expiresAt<=now){partial=true;continue;}
  observations.push(source);
  authorities[source.id]={kind:'prepared_capture',sourceUrl:source.url,expiresAt:new Date(expiresAt).toISOString()};
 }
 return observations.length?{observations,authorities,website:admitted.website,partial}:null;
}
