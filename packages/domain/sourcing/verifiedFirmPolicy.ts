import type {RepositoryContext} from '../db/workspaceScope.ts';
import {QUALIFICATION_POLICY_VERSION,QUALIFICATION_PROMPT_VERSION} from './qualificationStore.ts';

/** A new owner attestation is required. A historical auto-admission flag is not consent. */
export const VERIFIED_FIRM_POLICY_VERSION='verified-firm-v1';
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
