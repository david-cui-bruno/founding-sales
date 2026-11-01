import {createHash} from 'node:crypto';
import {sourceObservationSchema,type SourceObservation} from '@fss/contracts';
import type {ManualPhoneSnapshot} from './manualProspectPhone.ts';
import {originalAuthorities} from './manualProspectOriginalAuthority.ts';
import {preparedCaptureAuthority} from './preparedCapture.ts';

export type PreparedSourceExpirations=ReadonlyMap<string,number>;
export interface AdmittedPreparedPage {source:SourceObservation;captured:boolean;expires:number|undefined}
export interface AdmittedPreparedPages {pages:AdmittedPreparedPage[];unshown:boolean;captureDeadline:number|null;capturedIds:ReadonlySet<string>;website:string|null}
const host=(value:string|null)=>{try{const url=new URL(value??'');return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.hostname.toLowerCase().replace(/^www\./u,''):null;}catch{return null;}};

/** The one rule for which retained pages a prepared company may cite. The prepared brief
 * and Calling's prepared phone evidence both read pages through it, so a phone shown as
 * published is exactly one Calling can show. Caller has already required the latest run,
 * its revision, no changed dependency and a valid retained lineage. */
export function admitPreparedPages(snapshot:ManualPhoneSnapshot,now:number,expirations:PreparedSourceExpirations=new Map()):AdmittedPreparedPages{
 const raw=Array.isArray(snapshot.observations)&&snapshot.observations.length<=8&&Buffer.byteLength(JSON.stringify(snapshot.observations))<=100_000?snapshot.observations:[];
 // Source grants are indexed by observation ID. A duplicate could otherwise
 // borrow a different URL's grant; refuse the collection without trusting old facts.
 const ids=raw.flatMap(value=>{const parsed=sourceObservationSchema.safeParse(value);return parsed.success?[parsed.data.id]:[];});
 const unique=new Set(ids).size===ids.length;
 const grants=originalAuthorities(snapshot),capture=preparedCaptureAuthority(snapshot),expectedHost=host(grants.website);
 const captureDeadline=capture.validUntil===null?null:Date.parse(capture.validUntil);
 const captured=captureDeadline===null||Number.isFinite(captureDeadline)&&captureDeadline>now?capture.observationIds:new Set<string>();
 const result:AdmittedPreparedPages={pages:[],unshown:!unique,captureDeadline,capturedIds:captured,website:grants.website};
 for(const value of unique?raw:[]){
  const parsed=sourceObservationSchema.safeParse(value);
  if(!parsed.success){result.unshown=true;continue;}
  const source=parsed.data,expires=expirations.get(source.url);
  if((!snapshot.permitted_urls.includes(source.url)&&!captured.has(source.id))||new Set(source.blocks.map(block=>block.id)).size!==source.blocks.length||(!grants.authorities[source.id]&&!captured.has(source.id))||!expectedHost||host(source.url)!==expectedHost||!source.firstParty||Date.parse(source.retrievedAt)>now||expires!==undefined&&expires<=now||createHash('sha256').update(JSON.stringify(source.blocks)).digest('hex')!==source.relevantTextHash){result.unshown=true;continue;}
  result.pages.push({source,captured:captured.has(source.id),expires});
 }
 return result;
}
