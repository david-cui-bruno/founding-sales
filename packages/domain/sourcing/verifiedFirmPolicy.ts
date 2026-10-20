import type {RepositoryContext} from '../db/workspaceScope.ts';
import {QUALIFICATION_POLICY_VERSION,QUALIFICATION_PROMPT_VERSION} from './qualificationStore.ts';
import {qualificationEvidenceSchema,type QualificationFact,type SourceObservation} from '@fss/contracts';
import type {QualificationCandidateContext} from './qualificationCitationRoles.ts';
import {deniesManagedResidences,supportsResidentialManagement,type SourcingIdentity} from './qualificationPolicy.ts';
import {verifiedOfficePhone} from './verifiedOfficePhone.ts';
import {isDiscoveryDirectory} from './discoveryIdentity.ts';

/** A new owner attestation is required. A historical auto-admission flag is not consent. */
// Earlier attestations do not cover the current residential vocabulary and office layouts.
export const VERIFIED_FIRM_POLICY_VERSION='verified-firm-v3';
export interface VerifiedFirmAttestation {
 policyVersion?:string;promptVersion?:string;verifiedFirmPolicyVersion?:string;
 reportSha256?:string;reviewedEligible?:number;falseEligible?:number;
}
export function validVerifiedFirmAttestation(value:VerifiedFirmAttestation|null):boolean {
 return value?.verifiedFirmPolicyVersion===VERIFIED_FIRM_POLICY_VERSION&&value.policyVersion===QUALIFICATION_POLICY_VERSION&&value.promptVersion===QUALIFICATION_PROMPT_VERSION&&/^[a-f0-9]{64}$/u.test(value.reportSha256??'')&&Number.isSafeInteger(value.reviewedEligible)&&Number(value.reviewedEligible)>0&&value.falseEligible===0;
}
/** Read-only authority, rechecked by publication inside the normal transaction. */
export async function verifiedFirmOwner(ctx:RepositoryContext):Promise<string|null> {
 const row=(await ctx.db.query<{owner_user_id:string;qualification_evaluation:VerifiedFirmAttestation|null}>(`SELECT s.owner_user_id,s.qualification_evaluation FROM sourcing_discovery_settings s JOIN workspace_memberships m ON m.workspace_id=s.workspace_id AND m.user_id=s.owner_user_id AND m.status='active' WHERE s.workspace_id=$1 AND s.auto_admission_enabled FOR SHARE OF s,m`,[ctx.scope.workspaceId])).rows[0];
 return row&&validVerifiedFirmAttestation(row.qualification_evaluation)?row.owner_user_id:null;
}

export const IDENTITY_REVIEW_REASONS=['identity_unresolved','firm_identity_ambiguous','phone_association_ambiguous'] as const;
export function isIdentityReviewReason(reason:string|null):boolean {return IDENTITY_REVIEW_REASONS.some(value=>value===reason);}
export const identityFold=(value:string):string=>value.normalize('NFKC').replace(/\s+/gu,' ').trim().toLowerCase();
/** Branch paths are supported. Only known non-identity tracking queries may be ignored. */
export function verifiedWebsiteKey(value:string|null):string|null {
 try{const url=new URL(value??'');const trackingOnly=[...url.searchParams.keys()].every(key=>/^(?:utm_(?:source|medium|campaign|term|content|id)|gclid|fbclid)$/u.test(key));return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&trackingOnly?`${url.hostname.toLowerCase().replace(/^www\./u,'')}${url.pathname.replace(/\/+$/u,'')}`:null;}catch{return null;}
}
export type VerifiedFirmEvidence={kind:'verified';identity:SourcingIdentity;phone:string|null}|{kind:'pending'|'unclear';reason:string};
const stateNames:Record<string,string>={TX:'texas',RI:'rhode island',MA:'massachusetts'};
/** Literal contrary text beats a model's positive fact label, even if not selected. */
function deniesResidential(text:string):boolean {
 return deniesManagedResidences(text)||/\b(?:do\s+not|does\s+not|don['’]t|doesn['’]t|never|no\s+longer)\s+(?:\w+\s+){0,3}(?:manage|offer|provide|handle|speciali[sz]e)\b[^.!?\n]{0,100}\bresidential\b/iu.test(text)
  || /\b(?:commercial|industrial)\b[^.!?\n]{0,80}\b(?:only|exclusively)\b|\b(?:only|exclusively)\b[^.!?\n]{0,80}\b(?:commercial|industrial)\b/iu.test(text);
}
/** Only literal, current, complete first-party citations establish an office. No model-written decisions. */
export function verifiedFirmEvidence(input:{candidate:QualificationCandidateContext;facts:readonly QualificationFact[];observations:readonly SourceObservation[];now:string}):VerifiedFirmEvidence {
 const sourceHost=(value:string)=>{try{return verifiedWebsiteKey(value)===null?null:new URL(value).hostname.toLowerCase().replace(/^www\./u,'');}catch{return null;}};
 const {candidate}=input,now=Date.parse(input.now),host=sourceHost(candidate.website);
 if(!Number.isFinite(now)||!host||!qualificationEvidenceSchema.safeParse({facts:input.facts,observations:input.observations}).success)return {kind:'pending',reason:'invalid_evidence'};
 if(isDiscoveryDirectory(candidate.website))return {kind:'unclear',reason:'identity_unresolved'};
 const sources=new Map(input.observations.filter(s=>s.firstParty&&!s.truncated&&sourceHost(s.url)===host&&now>=Date.parse(s.retrievedAt)&&now-Date.parse(s.retrievedAt)<=7*86400000).map(s=>[s.id,s]));
 if(sources.size===0)return {kind:'pending',reason:'source_incomplete_or_unverified'};
 const facts=input.facts.filter(f=>sources.has(f.observationId));
 const name=identityFold(candidate.firmName),identities=facts.filter(f=>f.kind==='firm_identity');
 const matches=(value:string,part:string)=>` ${identityFold(value).replace(/[^\p{L}\p{N}]+/gu,' ')} `.includes(` ${identityFold(part).replace(/[^\p{L}\p{N}]+/gu,' ')} `);
 if(name.length<4||/^(?:property management|property manager|rentals|home|contact|about us)$/u.test(name)||identities.length===0)return {kind:'unclear',reason:'identity_unresolved'};
 if(identities.some(f=>!matches(f.value,name)||/\b(?:powered by|website by|web design|testimonial|customer review)\b/iu.test(f.value)))return {kind:'unclear',reason:'firm_identity_ambiguous'};
 const state=stateNames[candidate.region];
 const geography=facts.some(f=>f.kind==='service_area'&&matches(f.value,candidate.locality)&&(matches(f.value,candidate.region)||matches(f.value,state??'__unknown__')));
 if(!geography)return {kind:'unclear',reason:'identity_unresolved'};
 if([...sources.values()].some(source=>source.blocks.some(block=>deniesResidential(block.text)))||!facts.some(f=>f.kind==='residential_management'&&supportsResidentialManagement(f.value)))return {kind:'pending',reason:'residential_fit_unknown'};
 const identity:SourcingIdentity={status:'resolved',name:candidate.firmName,website:candidate.website,locality:candidate.locality,region:candidate.region};
 const proof=verifiedOfficePhone({identity,facts,observations:[...sources.values()]});
 if(proof.ambiguous)return {kind:'unclear',reason:'phone_association_ambiguous'};
 return {kind:'verified',identity,phone:proof.phone};
}
