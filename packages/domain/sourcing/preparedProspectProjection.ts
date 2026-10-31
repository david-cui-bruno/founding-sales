import {createHash} from 'node:crypto';
import {sourceObservationSchema,type PreparedProspectBrief,type PreparedProspectTarget} from '@fss/contracts';
import {projectManualProspect,type ManualProspectRow} from './manualProspectProjection.ts';
import type {ManualPhoneSnapshot} from './manualProspectPhone.ts';
import {originalAuthorities,originalLineage} from './manualProspectOriginalAuthority.ts';
import {preparedCaptureObservationIds} from './preparedCapture.ts';

export interface PreparedRunIdentity {id:string;candidate_revision:number}
export type PreparedSourceExpirations=ReadonlyMap<string,number>;
type Passage=PreparedProspectBrief['passages'][number];
const host=(value:string|null)=>{try{const url=new URL(value??'');return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.hostname.toLowerCase().replace(/^www\./u,''):null;}catch{return null;}};
const attribution=/\b(?:testimonial|customer review|powered by|website by|web design|we help property managers|software for property managers|platform for property managers)\b/iu;
const residential=/\b(?:residential|single.family|multi.family|multifamily|homes|houses|apartments|condominiums|residences)\b/iu;
const management=/\b(?:manag(?:e|es|ed|ing|ement)|leasing|rental management)\b/iu;
const vendor=/\b(?:software|platform|tools?|technology)\b[^.!?\n]{0,100}\b(?:helps?|enables?|empowers?|for)\b[^.!?\n]{0,60}\b(?:property managers?|management companies|landlords?)\b|\b(?:we|our company)\b[^.!?\n]{0,60}\b(?:sell|build|develop|provide|offer)\b[^.!?\n]{0,60}\b(?:software|platform|tools?)\b/iu;
const ownManager=/\b(?:we|our (?:team|company|firm|office|management|property|residential|rental))\b[^.!?\n]{0,200}\b(?:manag(?:e|es|ed|ing|ement)|leasing)\b/iu;
const namedManager=/\b(?:[A-Z][\p{L}\d&'-]*\s+){1,5}(?:Property Management|Properties|Realty|Management|Residential)\b[^.!?\n]{0,100}\b(?:manages?|provides?|offers?|speciali[sz]es?|serves?|is|has been)\b/u;
const contrary=/\b(?:do not|does not|don't|doesn't|never|no longer)\s+(?:\w+\s+){0,4}(?:manage|offer|provide|speciali[sz]e)\b[^.!?\n]{0,120}\b(?:residential|homes|houses|apartments|residences)\b|\b(?:commercial|industrial)\b[^.!?\n]{0,60}\b(?:only|exclusively)\b|\b(?:only|exclusively)\b[^.!?\n]{0,60}\b(?:commercial|industrial)\b/iu;
function business(text:string):boolean {
 return text.length>=50&&text.trim().split(/\s+/u).length>=8&&residential.test(text)&&management.test(text)&&(ownManager.test(text)||namedManager.test(text))&&!vendor.test(text)&&!attribution.test(text)&&!contrary.test(text);
}
const passageKinds=(text:string,locality:string):Passage['kind'][]=>{
 const result:Passage['kind'][]=[];
 if(contrary.test(text))result.push('contrary');
 if(business(text))result.push('business');
 if(/\b(?:office|located|location|service area|serving|we serve|headquarters)\b|\b\d{5}(?:-\d{4})?\b/iu.test(text)||locality.trim().length>1&&text.toLowerCase().includes(locality.toLowerCase()))result.push('location');
 if(/\b(?:maintenance|repair|vendors?|tenants?|requests?|dispatch|rent collection|screening|leasing|after.hours)\b/iu.test(text)&&text.length>=30)result.push('workflow');
 if(/\b(?:CEO|president|founder|owner|principal|director|leadership|our team|meet our)\b/iu.test(text)&&/\b[A-Z][\p{Ll}]+(?:\s+[A-Z][\p{Ll}]+){1,3}\b/u.test(text))result.push('person');
 if(/\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?:\+?1[ .-]?)?\(?[2-9]\d{2}\)?[ .-]?\d{3}[ .-]?\d{4}/iu.test(text))result.push('contact');
 return result;
};

/** Dated original passages only. A preparation assessment never changes a stored
 * qualification, resolves a canonical identity, or grants a channel/endpoint. */
export function projectPreparedProspect(row:ManualProspectRow,snapshot:ManualPhoneSnapshot|undefined,latest:PreparedRunIdentity|undefined,now:number,expirations:PreparedSourceExpirations=new Map()):PreparedProspectBrief|null {
 const observed=projectManualProspect(row);if(!observed)return null;
 const target:PreparedProspectTarget={candidateId:row.id,candidateRevision:row.revision,runId:latest?.id??null};
 const passages:Passage[]=[],all:{passage:Passage;kinds:Passage['kind'][]}[]=[],usedSourceDeadlines:number[]=[];
 let usablePages=0,unshown=false,contraryBeyondBound=false;
 if(snapshot&&!snapshot.dependency_changed&&snapshot.id===latest?.id&&snapshot.candidate_revision===row.revision&&originalLineage(snapshot)){
  const raw=Array.isArray(snapshot.observations)&&snapshot.observations.length<=8&&Buffer.byteLength(JSON.stringify(snapshot.observations))<=100_000?snapshot.observations:[];
  // Source grants are indexed by observation ID. A duplicate could otherwise
  // borrow a different URL's grant; refuse the collection without trusting old facts.
  const ids=raw.flatMap(value=>{const parsed=sourceObservationSchema.safeParse(value);return parsed.success?[parsed.data.id]:[];});
  const unique=new Set(ids).size===ids.length;
  if(!unique)unshown=true;
  const grants=originalAuthorities(snapshot),captured=preparedCaptureObservationIds(snapshot),expectedHost=host(grants.website);
  for(const value of unique?raw:[]){
   const parsed=sourceObservationSchema.safeParse(value);
   if(!parsed.success){unshown=true;continue;}
   const source=parsed.data,expires=expirations.get(source.url);
   if(!snapshot.permitted_urls.includes(source.url)||new Set(source.blocks.map(block=>block.id)).size!==source.blocks.length||(!grants.authorities[source.id]&&!captured.has(source.id))||!expectedHost||host(source.url)!==expectedHost||!source.firstParty||source.truncated||Date.parse(source.retrievedAt)>now||expires!==undefined&&expires<=now||createHash('sha256').update(JSON.stringify(source.blocks)).digest('hex')!==source.relevantTextHash){unshown=true;continue;}
   usablePages++;
   if(expires!==undefined)usedSourceDeadlines.push(expires);
   for(const block of source.blocks){
    if(block.text.length>2000){unshown=true;if(contrary.test(block.text))contraryBeyondBound=true;continue;}
    const kinds=passageKinds(block.text,observed.locality??'');if(!kinds.length)continue;
    all.push({kinds,passage:{kind:kinds[0]!,observationId:source.id,blockId:block.id,url:source.url,retrievedAt:source.retrievedAt,quote:block.text}});
   }
  }
 }
 // Retain contrary context before positive categories, without duplicating or
 // concatenating blocks. A category is presentation, not a replacement fact.
 for(const [kind,limit]of [['contrary',2],['business',4],['contact',2],['person',2],['location',3],['workflow',3]] as const){
  let added=0;for(const entry of all){
   if(added>=limit||passages.length>=16)break;
   if(!entry.kinds.includes(kind)||passages.some(p=>p.observationId===entry.passage.observationId&&p.blockId===entry.passage.blockId))continue;
   passages.push({...entry.passage,kind});added++;
  }
 }
 const has=(kind:Passage['kind'])=>all.some(item=>item.kinds.includes(kind));
 const hasContrary=has('contrary')||contraryBeyondBound;
 const prepared=has('business')&&!hasContrary;
 // Hidden/oversized contrary context still contributes to the assessment.
 const deadlines=usedSourceDeadlines;
 const unknowns=[
  'The discovery label is not a verified canonical company identity',
  'Buyer, purchasing authority and buying intent are unknown',
  'Maintenance pain or an unmet need has not been established',
  'Phone and email passages are observations, not verified routes or contact permission',
  ...(!has('location')?['Office location and service coverage are unknown; query geography is a targeting hint']:['Observed office or market wording does not establish complete service coverage']),
  ...(!has('person')?['No current named buyer is established']:['Dated people or roles are leads for research, not confirmed current buying authority']),
  ...(!has('contact')?['No current contact passage is available']:['Endpoint purpose, ownership and reachability remain unverified']),
  ...(unshown?['Only permitted complete retained pages are shown; other coverage is unknown']:[]),
  ...(hasContrary?['Contrary retained business context needs research']:[]),
  ...(contraryBeyondBound?['Contrary wording exceeds the displayed passage limit; the company needs research']:[]),
  ...(!usablePages?['No usable retained first-party page supports a company brief']:[]),
 ];
 return {target,displayName:observed.observedName,discoveryLabel:observed.observedName,website:observed.website,
  targetingLocality:observed.locality??'',targetingRegion:observed.region??'',sourceNotices:observed.sourceNotices,state:prepared?'prepared':'needs_research',
  summary:prepared?'Retained first-party context describes residential property management. Review the original business, workflow and location passages with their unknowns.':hasContrary?'Retained business context conflicts with residential-management fit. Review the contrary passage before treating this as a prepared company.':'The permitted discovery record still needs substantive current company research; a search label alone is not a prepared brief.',
  unknowns,validUntil:deadlines.length?new Date(Math.min(...deadlines)).toISOString():null,
  policyVersion:'prepared-prospect-v1',checkedAt:new Date(now).toISOString(),passages,coverage:usablePages?'complete_retained_pages':'no_usable_retained_pages',
  nextAction:prepared?'Research the appropriate Person and current route. Ask how maintenance requests are coordinated without assuming a problem.':'Review the actual source or fit gap; no automatic capture or qualification is started by opening this brief.',contactAuthority:'not_granted'};
}
