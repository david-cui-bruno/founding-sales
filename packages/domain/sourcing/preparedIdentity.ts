import type {QualificationFact,SourceObservation} from '@fss/contracts';
import {qualificationExtractionCitationRoles,type QualificationCandidateContext} from './qualificationCitationRoles.ts';

export const LEGACY_QUALIFICATION_PRODUCER='qualification-context-v7';
export const PREPARED_IDENTITY_PRODUCER='prepared-source-identity-v1';
export type QualificationProducerVersion=typeof LEGACY_QUALIFICATION_PRODUCER|typeof PREPARED_IDENTITY_PRODUCER;
/** Opaque source binding only. The name is always derived from its retained whole block. */
export interface PreparedIdentityProof {
 readonly producerVersion:typeof PREPARED_IDENTITY_PRODUCER;
 readonly observationId:string;readonly blockId:string;
 readonly contentHash:string;readonly relevantTextHash:string;readonly blockTextHash:string;
}
export type PreparedCitationResult=ReturnType<typeof qualificationExtractionCitationRoles> extends infer R
 ? R extends {ok:true}?R&{preparedIdentity?:PreparedIdentityProof}:R:never;

/** Current producer seam; the default retains the exact legacy response interpretation. */
export function preparedIdentityCitationRoles(candidate:QualificationCandidateContext,selected:readonly QualificationFact[],observations:readonly SourceObservation[],_producer:QualificationProducerVersion=LEGACY_QUALIFICATION_PRODUCER):PreparedCitationResult {
 return qualificationExtractionCitationRoles(candidate,selected,observations);
}
/** Revalidate source identity on every current prepared read; never mutate the discovery label. */
export function effectivePreparedCandidate<T extends QualificationCandidateContext>(candidate:T,_facts:readonly QualificationFact[],_observations:readonly SourceObservation[],_producer:unknown,proof:unknown,_now:string):T|null {
 return proof==null?candidate:null;
}
/** A new interpretation must never enter an unchanged legacy/calling consumer. */
export const hasPreparedIdentity=(run:{[key:string]:unknown}):boolean=>run['prepared_identity']!=null;
