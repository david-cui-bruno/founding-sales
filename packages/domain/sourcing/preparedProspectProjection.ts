import type {PreparedProspectCallable,PreparedProspectCurrentBrief,PreparedProspectTarget} from '@fss/contracts';
import {projectManualProspect,type ManualProspectRow} from './manualProspectProjection.ts';
import type {ManualPhoneSnapshot} from './manualProspectPhone.ts';
import {originalLineage} from './manualProspectOriginalAuthority.ts';
import {admitPreparedPages,type PreparedSourceExpirations} from './preparedPageAdmission.ts';
import {classifyPreparedPassage,type PreparedPassageClassification} from './preparedProspectFields.ts';
import {blockPhoneLabels} from './manualProspectLiteralPhone.ts';
import {classifyDiscoveryPage,companyHost} from './discoveryIdentity.ts';

export interface PreparedRunIdentity {id:string;candidate_revision:number}
type Passage=PreparedProspectCurrentBrief['passages'][number];
/** Dated original passages only. A preparation assessment never changes a stored
 * qualification, resolves a canonical identity, or grants a channel/endpoint. */
export function projectPreparedProspect(row:ManualProspectRow,snapshot:ManualPhoneSnapshot|undefined,latest:PreparedRunIdentity|undefined,now:number,expirations:PreparedSourceExpirations=new Map()):PreparedProspectCurrentBrief|null {
 const observed=projectManualProspect(row);if(!observed)return null;
 const target:PreparedProspectTarget={candidateId:row.id,candidateRevision:row.revision,runId:latest?.id??null};
 const passages:Passage[]=[],all:{passage:Passage;classification:PreparedPassageClassification;phone:string|null}[]=[],usedSourceDeadlines:number[]=[];
 let usablePages=0,partialPages=0,unshown=false,contraryBeyondBound=false;
 if(snapshot&&!snapshot.dependency_changed&&snapshot.id===latest?.id&&snapshot.candidate_revision===row.revision&&originalLineage(snapshot)){
  const admitted=admitPreparedPages(snapshot,now,expirations);
  unshown=admitted.unshown;
  for(const {source,captured,expires} of admitted.pages){
   usablePages++;if(source.truncated)partialPages++;
   if(captured&&admitted.captureDeadline!==null)usedSourceDeadlines.push(admitted.captureDeadline);
   if(expires!==undefined)usedSourceDeadlines.push(expires);
   for(const block of source.blocks){
    const classification=classifyPreparedPassage(block.text,observed.locality??'');
    if(block.text.length>2000){unshown=true;if(classification.contrary)contraryBeyondBound=true;continue;}
    if(!classification.kinds.length)continue;
    // Callable needs a supported US literal under the reviewed same-block phone grammar, as published.
    const phone=classification.kinds.includes('contact')?blockPhoneLabels(block.text).flatMap(label=>label.literals).find(literal=>literal.value?.startsWith('+1'))?.literal??null:null;
    all.push({classification,phone,passage:{kind:classification.kinds[0]!,observationId:source.id,blockId:block.id,url:source.url,retrievedAt:source.retrievedAt,quote:block.text,sourceCoverage:source.truncated?'partial_page':'complete_page'}});
   }
  }
 }
 // Retain contrary context before positive categories, without duplicating or
 // concatenating blocks. A category is presentation, not a replacement fact.
 // Identical quote text from another block is shown once: the first is kept whole.
 for(const [kind,limit]of [['contrary',2],['business',4],['contact',2],['person',2],['location',3],['workflow',3]] as const){
  // Phone- and short person-bearing blocks lead their bounded sections so callable facts stay traceable.
  const entries=kind==='workflow'?[...all].sort((a,b)=>Number(b.classification.usefulOperations)-Number(a.classification.usefulOperations)):kind==='contact'?[...all].sort((a,b)=>Number(b.phone!==null)-Number(a.phone!==null))
   :kind==='person'?[...all].sort((a,b)=>Number(b.passage.quote.length<=200)-Number(a.passage.quote.length<=200)):all;
  let added=0;for(const entry of entries){
   if(added>=limit||passages.length>=16)break;
   if(!entry.classification.kinds.includes(kind)||passages.some(p=>p.observationId===entry.passage.observationId&&p.blockId===entry.passage.blockId||p.quote===entry.passage.quote))continue;
   passages.push({...entry.passage,kind});added++;
  }
 }
 const has=(kind:Passage['kind'])=>all.some(item=>item.classification.kinds.includes(kind));
 const hasContrary=has('contrary')||contraryBeyondBound;
 const hasOperations=all.some(item=>item.classification.usefulOperations);
 const hasResidential=all.some(item=>item.classification.residentialContext);
 const prepared=(has('business')||hasOperations)&&!hasContrary;
 // ADR0034: research readiness only. Only a company page is callable; phone and person
 // come from blocks included in this brief.
 const included=all.filter(item=>passages.some(p=>p.observationId===item.passage.observationId&&p.blockId===item.passage.blockId));
 const phone=included.find(item=>item.phone!==null)?.phone??null,person=included.find(item=>item.classification.kinds.includes('person')&&item.passage.quote.length<=200)?.passage.quote??null;
 const page=observed.website===null?null:classifyDiscoveryPage({url:observed.website,title:observed.observedName});
 const missing:PreparedProspectCallable['missing']=[...(!prepared?['needs_research' as const]:[]),...(hasContrary?['contrary_context' as const]:[]),
  ...(!has('business')?['no_business_context' as const]:[]),...(phone===null?['no_published_phone' as const]:[]),...(page==='list'?['list_page' as const]:page!=='company'?['not_company_page' as const]:[])];
 const callable:PreparedProspectCallable={state:missing.length?'not_callable':'callable',missing,phone,person,residential:hasResidential};
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
  unknowns,validUntil:deadlines.length?new Date(Math.min(...deadlines)).toISOString():null,callable,companyHost:observed.website===null?null:companyHost(observed.website),
  policyVersion:'prepared-prospect-v2',checkedAt:new Date(now).toISOString(),passages,coverage:partialPages?'partial_retained_pages':usablePages?'complete_retained_pages':'no_usable_retained_pages',
  nextAction:prepared?'Research the appropriate Person and current route. Ask how maintenance requests are coordinated without assuming a problem.':'Review the actual source or fit gap; no automatic capture or qualification is started by opening this brief.',contactAuthority:'not_granted'};
}
