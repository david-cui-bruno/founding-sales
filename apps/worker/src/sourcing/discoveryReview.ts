import type {EvaluationReport} from './evaluateDiscovery.ts';
import {z} from 'zod';
import type {DiscoveryHit} from '@fss/domain/sourcing/discoveryProvider.ts';
import {isPublicResearchUrl} from '@fss/domain/research/sourcePolicy.ts';
export interface ReviewedEvidence {
 geography:'confirmed'|'rejected'|'unknown';
 residentialManager:'confirmed'|'rejected'|'unknown';
 crmMatch:'new'|'existing'|'unknown';
 need:'active_vacancy'|'direct_workload_statement'|'generic_careers'|'marketing'|'existing_support'|'unknown';
 sourceUrl:string;checkedOn:string;current:boolean;
}
/** Operator-reviewed evidence only. Search keywords never populate these fields. */
export function qualifyDiscovery(e:ReviewedEvidence):'exclude'|'existing_firm'|'needs_review'|'fit_only'|'signal_supported'{
 if(e.geography==='rejected'||e.residentialManager==='rejected')return 'exclude';
 if(e.crmMatch==='existing')return 'existing_firm';
 if(e.geography!=='confirmed'||e.residentialManager!=='confirmed'||e.crmMatch!=='new')return 'needs_review';
 if(!isPublicResearchUrl(e.sourceUrl)||!z.iso.date().safeParse(e.checkedOn).success||!e.current)return 'needs_review';
 return e.need==='active_vacancy'||e.need==='direct_workload_statement'?'signal_supported':'fit_only';
}
/** Host grouping is a review aid, not verified legal-entity deduplication. */
export function buildDiscoveryReview<T extends DiscoveryHit&{queryId:string}>(hits:readonly T[]){
 const groups=new Map<string,{host:string;hits:T[];evidence:ReviewedEvidence;decision:ReturnType<typeof qualifyDiscovery>}>();
 for(const hit of hits){
  if(!isPublicResearchUrl(hit.url))continue;
  const host=new URL(hit.url).hostname.toLowerCase().replace(/^www\./u,'');
  let group=groups.get(host);
  if(!group){
   const evidence:ReviewedEvidence={geography:'unknown',residentialManager:'unknown',crmMatch:'unknown',need:'unknown',sourceUrl:'',checkedOn:'',current:false};
   group={host,hits:[],evidence,decision:qualifyDiscovery(evidence)};groups.set(host,group);
  }
  group.hits.push(hit);
 }
 return [...groups.values()];
}

/** Keep the original attempt reference when the same query is run on later days. */
export function reviewEvaluation(report:EvaluationReport){
 return buildDiscoveryReview(report.results.flatMap(r=>r.result.ok?r.result.hits.map(h=>({...h,queryId:r.queryId,attemptId:r.attemptId,observedAt:r.observedAt,provider:report.provider,requestId:r.result.ok?r.result.requestId:'',query:r.query,cohort:r.cohort})):[]));
}
