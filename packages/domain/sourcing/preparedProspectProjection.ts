import {createHash} from 'node:crypto';
import {sourceObservationSchema,type PreparedProspectBrief,type PreparedProspectTarget} from '@fss/contracts';
import {projectManualProspect,type ManualProspectRow} from './manualProspectProjection.ts';
import type {ManualPhoneSnapshot} from './manualProspectPhone.ts';
import {originalAuthorities,originalLineage} from './manualProspectOriginalAuthority.ts';
import {preparedCaptureAuthority} from './preparedCapture.ts';
import {classifyPreparedPassage,type PreparedPassageClassification} from './preparedProspectFields.ts';

export interface PreparedRunIdentity {id:string;candidate_revision:number}
export type PreparedSourceExpirations=ReadonlyMap<string,number>;
type Passage=PreparedProspectBrief['passages'][number];
const host=(value:string|null)=>{try{const url=new URL(value??'');return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.hostname.toLowerCase().replace(/^www\./u,''):null;}catch{return null;}};
/** Dated original passages only. A preparation assessment never changes a stored
 * qualification, resolves a canonical identity, or grants a channel/endpoint. */
export function projectPreparedProspect(row:ManualProspectRow,snapshot:ManualPhoneSnapshot|undefined,latest:PreparedRunIdentity|undefined,now:number,expirations:PreparedSourceExpirations=new Map()):PreparedProspectBrief|null {
 const observed=projectManualProspect(row);if(!observed)return null;
 const target:PreparedProspectTarget={candidateId:row.id,candidateRevision:row.revision,runId:latest?.id??null};
 const passages:Passage[]=[],all:{passage:Passage;classification:PreparedPassageClassification}[]=[],usedSourceDeadlines:number[]=[];
 let usablePages=0,partialPages=0,unshown=false,contraryBeyondBound=false;
 if(snapshot&&!snapshot.dependency_changed&&snapshot.id===latest?.id&&snapshot.candidate_revision===row.revision&&originalLineage(snapshot)){
  const raw=Array.isArray(snapshot.observations)&&snapshot.observations.length<=8&&Buffer.byteLength(JSON.stringify(snapshot.observations))<=100_000?snapshot.observations:[];
  // Source grants are indexed by observation ID. A duplicate could otherwise
  // borrow a different URL's grant; refuse the collection without trusting old facts.
  const ids=raw.flatMap(value=>{const parsed=sourceObservationSchema.safeParse(value);return parsed.success?[parsed.data.id]:[];});
  const unique=new Set(ids).size===ids.length;
  if(!unique)unshown=true;
  const grants=originalAuthorities(snapshot),capture=preparedCaptureAuthority(snapshot),expectedHost=host(grants.website);
  const captureDeadline=capture.validUntil===null?null:Date.parse(capture.validUntil);
  const captured=captureDeadline===null||Number.isFinite(captureDeadline)&&captureDeadline>now?capture.observationIds:new Set<string>();
  for(const value of unique?raw:[]){
   const parsed=sourceObservationSchema.safeParse(value);
   if(!parsed.success){unshown=true;continue;}
   const source=parsed.data,expires=expirations.get(source.url);
   if((!snapshot.permitted_urls.includes(source.url)&&!captured.has(source.id))||new Set(source.blocks.map(block=>block.id)).size!==source.blocks.length||(!grants.authorities[source.id]&&!captured.has(source.id))||!expectedHost||host(source.url)!==expectedHost||!source.firstParty||Date.parse(source.retrievedAt)>now||expires!==undefined&&expires<=now||createHash('sha256').update(JSON.stringify(source.blocks)).digest('hex')!==source.relevantTextHash){unshown=true;continue;}
   usablePages++;if(source.truncated)partialPages++;
   if(captured.has(source.id)&&captureDeadline!==null)usedSourceDeadlines.push(captureDeadline);
   if(expires!==undefined)usedSourceDeadlines.push(expires);
   for(const block of source.blocks){
    const classification=classifyPreparedPassage(block.text,observed.locality??'');
    if(block.text.length>2000){unshown=true;if(classification.contrary)contraryBeyondBound=true;continue;}
    if(!classification.kinds.length)continue;
    all.push({classification,passage:{kind:classification.kinds[0]!,observationId:source.id,blockId:block.id,url:source.url,retrievedAt:source.retrievedAt,quote:block.text,sourceCoverage:source.truncated?'partial_page':'complete_page'}});
   }
  }
 }
 // Retain contrary context before positive categories, without duplicating or
 // concatenating blocks. A category is presentation, not a replacement fact.
 for(const [kind,limit]of [['contrary',2],['business',4],['contact',2],['person',2],['location',3],['workflow',3]] as const){
  const entries=kind==='workflow'?[...all].sort((a,b)=>Number(b.classification.usefulOperations)-Number(a.classification.usefulOperations)):all;
  let added=0;for(const entry of entries){
   if(added>=limit||passages.length>=16)break;
   if(!entry.classification.kinds.includes(kind)||passages.some(p=>p.observationId===entry.passage.observationId&&p.blockId===entry.passage.blockId))continue;
   passages.push({...entry.passage,kind});added++;
  }
 }
 const has=(kind:Passage['kind'])=>all.some(item=>item.classification.kinds.includes(kind));
 const hasContrary=has('contrary')||contraryBeyondBound;
 const hasOperations=all.some(item=>item.classification.usefulOperations);
 const hasResidential=all.some(item=>item.classification.usefulBusiness&&item.classification.residentialContext);
 const prepared=(has('business')||hasOperations)&&!hasContrary;
 // Hidden/oversized contrary context still contributes to the assessment.
 const deadlines=usedSourceDeadlines;
 const unknowns=[
  'The discovery label, source publisher and company identity are not independently verified',
  'Buyer, purchasing authority and buying intent are unknown',
  'Maintenance pain or an unmet need has not been established',
  'Phone and email passages are observations, not verified routes or contact permission',
  ...(!hasResidential?['Residential-management fit is unknown; retained context alone does not establish it']:[]),
  ...(!has('location')?['Office location and service coverage are unknown; query geography is a targeting hint']:['Observed office or market wording does not establish complete service coverage']),
  ...(!has('person')?['No current named buyer is established']:['Dated people or roles are leads for research, not confirmed current buying authority']),
  ...(!has('contact')?[partialPages?'Contact context remains unknown in the retained portion':'No current contact passage is available']:['Endpoint purpose, ownership and reachability remain unverified']),
  ...(partialPages?['Some source pages are incomplete; intact retained passages are shown, but omitted qualifications or contrary context remain unknown']:unshown?['Only currently permitted retained pages are shown; other coverage is unknown']:[]),
  ...(hasContrary?['Contrary retained business context needs research']:[]),
  ...(contraryBeyondBound?['Contrary wording exceeds the displayed passage limit; the company needs research']:[]),
  ...(!usablePages?['No currently permitted retained page supports a company brief']:[]),
 ];
 return {target,displayName:observed.observedName,discoveryLabel:observed.observedName,website:observed.website,
  targetingLocality:observed.locality??'',targetingRegion:observed.region??'',sourceNotices:observed.sourceNotices,state:prepared?'prepared':'needs_research',
  summary:prepared?(hasResidential?'Attributed retained source/site context describes residential property management. Publisher and company identity remain unverified.':has('business')?'Attributed retained source/site context describes property-management services. Residential fit, publisher and company identity remain unverified.':'Attributed retained source/site context describes property operations. Residential fit, publisher and company identity remain unverified.'):hasContrary?'Retained business context conflicts with residential-management fit. Review the contrary passage before treating this as a prepared company.':'The permitted discovery record still needs substantive current company research; a search label alone is not a prepared brief.',
  unknowns,validUntil:deadlines.length?new Date(Math.min(...deadlines)).toISOString():null,
  policyVersion:'prepared-prospect-v2',checkedAt:new Date(now).toISOString(),passages,coverage:partialPages?'partial_retained_pages':usablePages?'complete_retained_pages':'no_usable_retained_pages',
  nextAction:prepared?'Research the appropriate Person and current route. Ask how maintenance requests are coordinated without assuming a problem.':'Review the actual source or fit gap; no automatic capture or qualification is started by opening this brief.',contactAuthority:'not_granted'};
}
