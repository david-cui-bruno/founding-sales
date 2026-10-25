import {isDeepStrictEqual} from 'node:util';
import {candidateInputSchema,discoveryCandidatePayloadSchema,discoveryOriginSchema,sourceObservationSchema} from '@fss/contracts';
import type {LiteralAuthority,LiteralLineage} from './manualProspectLiteralPhone.ts';
import type {ManualPhoneSnapshot} from './manualProspectPhone.ts';

export interface ManualOriginalSnapshot {
 payload?:unknown;origins?:unknown;retained_identity_decision_id?:string|null;
 original_run_id?:string|null;original_revision?:number|null;result_revision?:number|null;
 decision_candidate_id?:string|null;original_candidate_id?:string|null;ancestor_revision?:number|null;
 original_observations?:unknown;evidence_authorities?:{id:string;url:string;contentHash:string;retrievedAt:string}[];
 original_reason?:string|null;decision_observation_id?:string|null;decision_block_id?:string|null;decision_content_hash?:string|null;decision_text_hash?:string|null;
 dependency_changed?:boolean;
}
export function originalLineage(snapshot:ManualPhoneSnapshot):LiteralLineage|null{
 if(!snapshot.retained_identity_decision_id)return {kind:'provider_original'};
 if(!snapshot.original_run_id||!snapshot.original_revision||snapshot.result_revision!==snapshot.candidate_revision||
  snapshot.decision_candidate_id!==snapshot.candidate_id||snapshot.original_candidate_id!==snapshot.candidate_id||
  snapshot.ancestor_revision!==snapshot.original_revision||!isDeepStrictEqual(snapshot.observations,snapshot.original_observations))return null;
 if(['source_unavailable','source_not_permitted','no_readable_text'].includes(snapshot.original_reason??''))return null;
 const anchor=Array.isArray(snapshot.original_observations)?snapshot.original_observations.map(value=>sourceObservationSchema.safeParse(value)).find(value=>value.success&&value.data.id===snapshot.decision_observation_id):undefined;
 if(!anchor?.success||!anchor.data.blocks.some(block=>block.id===snapshot.decision_block_id)||anchor.data.contentHash!==snapshot.decision_content_hash||anchor.data.relevantTextHash!==snapshot.decision_text_hash)return null;
 return {kind:'retained_interpretation',decisionId:snapshot.retained_identity_decision_id,originalRunId:snapshot.original_run_id,
  originalRevision:snapshot.original_revision,resultRevision:snapshot.result_revision};
}
/** Provenance describes the precise EXISTING granting branch, not website/host
 * ownership. Discovery metadata must still equal its raw row observation. */
export function originalAuthorities(snapshot:ManualPhoneSnapshot):{website:string|null;authorities:Record<string,LiteralAuthority>}{
 const ordinary=candidateInputSchema.safeParse(snapshot.payload),discovery=discoveryCandidatePayloadSchema.safeParse(snapshot.payload);
 const authorities:Record<string,LiteralAuthority>={};
 const website=ordinary.success?ordinary.data.website:discovery.success?discovery.data.row.website:null;
 for(const raw of Array.isArray(snapshot.observations)?snapshot.observations:[]){
  const parsed=sourceObservationSchema.safeParse(raw);if(!parsed.success)continue;const source=parsed.data;
  if(!snapshot.permitted_urls.includes(source.url))continue;
  if(ordinary.success&&ordinary.data.sourceUrl===source.url){authorities[source.id]={kind:'candidate_source',sourceUrl:source.url};continue;}
  if(discovery.success&&Array.isArray(snapshot.origins)){
   const origins=snapshot.origins.map(value=>discoveryOriginSchema.safeParse(value));
   const match=origins.flatMap(value=>value.success?[value.data.source]:[]).find(origin=>origin.sourceUrl===source.url&&
    discovery.data.row.observations.some(observation=>isDeepStrictEqual(observation,origin)));
   if(match){authorities[source.id]={kind:'discovery_origin',sourceUrl:match.sourceUrl,provider:match.provider,release:match.release,recordId:match.recordId,retrievedAt:match.retrievedAt};continue;}
  }
  const evidence=snapshot.evidence_authorities?.find(item=>item.url===source.url&&item.contentHash===source.contentHash&&item.retrievedAt===source.retrievedAt);
  if(evidence)authorities[source.id]={kind:'retained_evidence',evidenceId:evidence.id};
 }
 return {website,authorities};
}
