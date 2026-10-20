import type {CandidateInput,QualificationFact,SourceObservation} from '@fss/contracts';
import {supportsResidentialManagement} from './qualificationPolicy.ts';
import {normalizeQualificationExtractionDiagnostic,type QualificationExtractionDiagnostic} from './qualificationDiagnostics.ts';

export type QualificationCandidateContext=Pick<CandidateInput,'firmName'|'locality'|'region'|'website'>;
const fold=(value:string)=>value.normalize('NFKC').replace(/\s+/gu,' ').trim().toLowerCase();
const literal=(text:string,value:string)=>` ${fold(text).replace(/[^\p{L}\p{N}]+/gu,' ')} `.includes(` ${fold(value).replace(/[^\p{L}\p{N}]+/gu,' ')} `);
const states:Record<string,string>={MA:'Massachusetts',RI:'Rhode Island',TX:'Texas'};
const host=(url:string|null)=>{try{return new URL(url??'').hostname.toLowerCase().replace(/^www\./u,'');}catch{return null;}};
/** Candidate context is a search target, never evidence or permission. No source text is rewritten. */
export function qualificationCitationRoles(candidate:QualificationCandidateContext,selected:readonly QualificationFact[],observations:readonly SourceObservation[]):{ok:true;facts:QualificationFact[]}|{ok:false;reason:'invalid_evidence';diagnostic?:QualificationExtractionDiagnostic} {
 const fail=(code:QualificationExtractionDiagnostic['code'],selectionIndex?:number)=>{
  const fact=selectionIndex===undefined?undefined:selected[selectionIndex];
  const diagnostic=normalizeQualificationExtractionDiagnostic({stage:'citation_roles',code,selectionIndex,selectionCount:selected.length,observationId:fact?.observationId,blockId:fact?.blockId},observations);
  return {ok:false as const,reason:'invalid_evidence' as const,...(diagnostic?{diagnostic}:{})};
 };
 if(!candidate.firmName.trim()||!candidate.locality.trim()||!host(candidate.website))return fail('candidate_invalid');
 if(selected.length>30)return fail('selections_over_bound');
 const sources=observations.filter(s=>s.firstParty&&!s.truncated&&host(s.url)===host(candidate.website));
 for(const [index,fact] of selected.entries()){
  const source=sources.find(s=>s.id===fact.observationId),block=source?.blocks.find(b=>b.id===fact.blockId);
  if(!source)return fail('source_unusable',index);
  if(!block)return fail('block_missing',index);
  if(block.text!==fact.value)return fail('citation_mismatch',index);
  if(block.text.length>2000)return fail('block_over_bound',index);
  // A generic heading is not a firm identity. Refuse the whole interpretation,
  // including a contrary real company name, never drop it to manufacture agreement.
  if(fact.kind==='firm_identity'){
   if(!literal(fact.value,candidate.firmName))return fail('identity_not_literal',index);
   if(/\b(?:powered by|website by|web design|testimonial|customer review)\b/iu.test(fact.value))return fail('identity_forbidden',index);
  }
 }
 const facts=[...selected];
 const appendUnique=(kind:'firm_identity'|'service_area',matches:{source:SourceObservation;block:SourceObservation['blocks'][number]}[])=>{
  if(matches.length!==1)return;
  const {source,block}=matches[0]!;
  if(!facts.some(f=>f.kind===kind&&f.observationId===source.id&&f.blockId===block.id))facts.push({kind,value:block.text,observationId:source.id,blockId:block.id});
 };
 const blocks=sources.flatMap(source=>source.blocks.filter(block=>block.text.length<=2000).map(block=>({source,block})));
 if(!facts.some(f=>f.kind==='firm_identity'))appendUnique('firm_identity',blocks.filter(({block})=>fold(block.text)===fold(candidate.firmName)));
 const geography=(text:string)=>literal(text,candidate.locality)&&(literal(text,candidate.region)||literal(text,states[candidate.region]??'__unknown__'));
 const escape=(text:string)=>text.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
 const explicitLocation=new RegExp(`(?:^|[\\s(,:])${escape(candidate.locality)},?\\s+(?:${escape(candidate.region)}|${escape(states[candidate.region]??'__unknown__')})\\b`,'iu');
 // Only a named descriptive residential-management statement can supplement
 // geography. Never borrow a utility address, unrelated office or bare city menu.
 if(!facts.some(f=>f.kind==='service_area'&&geography(f.value)))appendUnique('service_area',blocks.filter(({block})=>literal(block.text,candidate.firmName)&&explicitLocation.test(block.text)&&supportsResidentialManagement(block.text)));
 return facts.length<=30?{ok:true,facts}:fail('supplement_over_bound');
}
