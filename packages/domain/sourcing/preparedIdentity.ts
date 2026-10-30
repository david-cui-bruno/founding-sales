import {createHash} from 'node:crypto';
import type {QualificationFact,SourceObservation} from '@fss/contracts';
import {US_BUSINESS_STATE_NAMES} from '../../contracts/src/usBusinessGeography.ts';
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
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const host=(url:string)=>{try{return new URL(url).hostname.toLowerCase().replace(/^www\./u,'');}catch{return null;}};
const fold=(value:string)=>value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const literal=(text:string,value:string)=>` ${fold(text)} `.includes(` ${fold(value)} `);
const usable=(candidate:QualificationCandidateContext,observations:readonly SourceObservation[])=>observations.filter(s=>s.firstParty&&!s.truncated&&host(candidate.website)!==null&&host(s.url)===host(candidate.website));
/** Accept a whole short company label; never extract a name from descriptive prose. */
function standaloneName(text:string,candidate:QualificationCandidateContext):boolean {
 const name=text.trim();
 if(name.length<4||name.length>160||/[\r\n]/u.test(name)||! /^[\p{L}\p{N}\s&+'’.,()/-]+$/u.test(name)||name.split(/\s+/u).length>16)return false;
 if(/(?:https?|www\.|@|\b(?:we|our|your|you|provides?|offers?|serves?|manages?|specializes?|specialises?|is|are|welcome|home|menu|contact|about|login|sign in|powered by|website by|web design|testimonial|customer review|copyright|all rights reserved|amo)\b)/iu.test(name))return false;
 const words=name.match(/[\p{L}\p{N}]+/gu)??[];
 const suffix=new Set(['property','properties','realty','residential','management','real','estate','company','co','inc','incorporated','llc','limited','ltd','group','and','the','of','services','service','association','associates']);
 const business=words.findIndex(word=>/^(?:property|properties|realty|residential|management|real)$/iu.test(word));
 // A company label has a distinctive name followed only by its business/legal suffix.
 // Sentence continuations, even title-cased ones, cannot become a canonical name.
 if(business<1||words.slice(business).some(word=>!suffix.has(word.toLowerCase())))return false;
 if(words.some(word=>! /^(?:and|the|of)$/u.test(word)&&! /^[\p{Lu}\p{N}]/u.test(word)))return false;
 const distinct=fold(name).replace(/\b(?:property|properties|realty|residential|management|real|estate|company|co|inc|incorporated|llc|limited|ltd|group|and|the|of|services|service|association|associates)\b/gu,' ');
 const location=new Set([...fold(candidate.locality).split(' '),...fold(candidate.region).split(' '),...fold(US_BUSINESS_STATE_NAMES[candidate.region]??'').split(' ')]);
 return distinct.trim().split(/\s+/u).some(word=>word.length>1&&!location.has(word));
}
function proofFor(source:SourceObservation,block:SourceObservation['blocks'][number]):PreparedIdentityProof {
 return {producerVersion:PREPARED_IDENTITY_PRODUCER,observationId:source.id,blockId:block.id,contentHash:source.contentHash,relevantTextHash:source.relevantTextHash,blockTextHash:hash(block.text)};
}
/** Current producer seam; the default retains the exact legacy response interpretation. */
export function preparedIdentityCitationRoles(candidate:QualificationCandidateContext,selected:readonly QualificationFact[],observations:readonly SourceObservation[],producer:QualificationProducerVersion=LEGACY_QUALIFICATION_PRODUCER):PreparedCitationResult {
 const original=qualificationExtractionCitationRoles(candidate,selected,observations);
 if(original.ok||producer!==PREPARED_IDENTITY_PRODUCER||original.diagnostic?.code!=='identity_not_literal')return original;
 const identities=selected.filter(f=>f.kind==='firm_identity');
 if(identities.length!==1)return original;
 const fact=identities[0]!,sources=usable(candidate,observations);
 // A supported original name cannot be replaced by a selected affiliate or contrary identity.
 if(sources.some(s=>s.blocks.some(b=>literal(b.text,candidate.firmName))))return original;
 const source=sources.find(s=>s.id===fact.observationId),block=source?.blocks.find(b=>b.id===fact.blockId);
 if(!source||!block||block.text!==fact.value||!standaloneName(block.text,candidate))return original;
 const names=new Set(sources.flatMap(s=>s.blocks.filter(b=>standaloneName(b.text,candidate)).map(b=>fold(b.text))));
 if(names.size!==1)return original;
 const resolved=qualificationExtractionCitationRoles({...candidate,firmName:block.text.trim()},selected,observations);
 return resolved.ok?{...resolved,preparedIdentity:proofFor(source,block)}:resolved;
}
function sameProof(value:unknown,expected:PreparedIdentityProof):boolean {
 if(typeof value!=='object'||value===null||Array.isArray(value))return false;
 const actual=value as Record<string,unknown>,keys=Object.keys(expected) as (keyof PreparedIdentityProof)[];
 return Object.keys(actual).length===keys.length&&keys.every(key=>actual[key]===expected[key]);
}
/** Revalidate source identity on every current prepared read; never mutate the discovery label. */
export function effectivePreparedCandidate<T extends QualificationCandidateContext>(candidate:T,facts:readonly QualificationFact[],observations:readonly SourceObservation[],producer:unknown,proof:unknown,now:string):T|null {
 if(producer!==LEGACY_QUALIFICATION_PRODUCER&&producer!==PREPARED_IDENTITY_PRODUCER)return null;
 if(proof==null)return candidate;
 if(producer!==PREPARED_IDENTITY_PRODUCER)return null;
 const result=preparedIdentityCitationRoles(candidate,facts,observations,producer);
 if(!result.ok||!result.preparedIdentity||!sameProof(proof,result.preparedIdentity))return null;
 const source=observations.find(s=>s.id===result.preparedIdentity!.observationId)!;
 const age=Date.parse(now)-Date.parse(source.retrievedAt);
 if(!Number.isFinite(age)||age<0||age>7*86400000)return null;
 const block=source.blocks.find(b=>b.id===result.preparedIdentity!.blockId)!;
 return {...candidate,firmName:block.text.trim()};
}
/** A new interpretation must never enter an unchanged legacy/calling consumer. */
export const hasPreparedIdentity=(run:{[key:string]:unknown}):boolean=>run['prepared_identity']!=null;
