import type {RepositoryContext} from '../db/workspaceScope.ts';
import {QUALIFICATION_POLICY_VERSION,QUALIFICATION_PROMPT_VERSION} from './qualificationStore.ts';
import type {SourcingIdentity} from './qualificationPolicy.ts';
import {verifiedOfficePhone} from './verifiedOfficePhone.ts';
import {nativeFirmEvidence,verifiedWebsiteKey,type NativeEvidenceInput} from './nativeFirmEligibility.ts';
export {identityFold,verifiedWebsiteKey} from './nativeFirmEligibility.ts';

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
export type VerifiedFirmEvidence={kind:'verified';identity:SourcingIdentity;phone:string|null}|{kind:'pending'|'unclear';reason:string};
/** Existing calling wrapper: identical pre-phone checks, then identical office-phone proof. */
export function verifiedFirmEvidence(input:NativeEvidenceInput):VerifiedFirmEvidence {
 const core=nativeFirmEvidence(input);if(core.kind!=='verified')return core;
 const sourceHost=(value:string)=>{try{return verifiedWebsiteKey(value)===null?null:new URL(value).hostname.toLowerCase().replace(/^www\./u,'');}catch{return null;}};
 const now=Date.parse(input.now),host=sourceHost(input.candidate.website);
 const sources=input.observations.filter(s=>s.firstParty&&!s.truncated&&sourceHost(s.url)===host&&now>=Date.parse(s.retrievedAt)&&now-Date.parse(s.retrievedAt)<=7*86400000);
 const facts=input.facts.filter(f=>sources.some(s=>s.id===f.observationId));
 const proof=verifiedOfficePhone({identity:core.identity,facts,observations:sources});
 if(proof.ambiguous)return {kind:'unclear',reason:'phone_association_ambiguous'};
 return {kind:'verified',identity:core.identity,phone:proof.phone};
}
