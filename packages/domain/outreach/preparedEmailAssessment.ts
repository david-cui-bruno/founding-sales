import type {RepositoryContext} from '../db/workspaceScope.ts';
import {decideAdminOnly} from '../crm/authorization.ts';
import {firmNameKey,websiteDomain} from '../crm/import.ts';
import {firstSuppressed} from '../suppression/effective.ts';
import {retainedCandidateOnly} from '../sourcing/retainedAcquisition.ts';
import {preparedCandidatePayload} from '../sourcing/discoveryIntake.ts';
import {existingEmailRoute} from './existingEmail.ts';
import {campaignCandidateProvenance} from './emailCampaignAuthority.ts';
import type {PreparedEmailTarget} from './emailCampaignSource.ts';
import type {EmailAssessment} from './selection.ts';

/** `assessEmailCandidate` for an own-site prepared company (ADR0035). The brief's business, no-contrary and company-page tests and the
 * published address are read by the campaign provenance; this adds the Firm and address identity rules. The company is always a NEW
 * Firm: any Firm already carrying its name or website host (a customer, a Calling preparation, a stopped or replied company) refuses,
 * except the Firm admission itself created from this very candidate. */
export async function assessPreparedEmail(ctx:RepositoryContext,input:{candidateId:string;qualificationRunId:string;campaignId?:string},target:PreparedEmailTarget):Promise<{ok:true;value:EmailAssessment}|{ok:false;reason:string}>{
 if(!decideAdminOnly(ctx).permitted)return {ok:false,reason:'admin_required'};
 if(!input.campaignId||input.candidateId!==target.candidateId||input.qualificationRunId!==target.runId)return {ok:false,reason:'campaign_authority_unavailable'};
 const w=ctx.scope.workspaceId;
 const candidate=(await ctx.db.query<{payload:unknown;revision:number;status:string;qualification_blocked:boolean}>('SELECT payload,revision,status,qualification_blocked FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2',[w,input.candidateId])).rows[0];
 if(!candidate)return {ok:false,reason:'not_found'};
 if(await retainedCandidateOnly(ctx,input.candidateId))return {ok:false,reason:'identity_review_required'};
 if(candidate.qualification_blocked||candidate.status==='dismissed'||candidate.revision!==target.candidateRevision)return {ok:false,reason:'candidate_changed'};
 const proof=await campaignCandidateProvenance(ctx,{...input,campaignId:input.campaignId},target);
 if(!proof)return {ok:false,reason:'campaign_authority_unavailable'};
 const payload=preparedCandidatePayload(candidate.payload);if(!payload)return {ok:false,reason:'candidate_changed'};
 const route=proof.route,domain=websiteDomain(payload.website),name=firmNameKey(payload.firmName);
 const admitted=(await ctx.db.query<{firm_id:string}>('SELECT firm_id FROM outreach_email_sources WHERE workspace_id=$1 AND candidate_id=$2 AND run_id=$3 AND campaign_id=$4 AND NOT association_review_required',[w,input.candidateId,input.qualificationRunId,input.campaignId])).rows[0];
 const matches=(await ctx.db.query<{id:string}>(`SELECT id FROM firms WHERE workspace_id=$1 AND (lower(regexp_replace(trim(name),'\\s+',' ','g'))=$2 OR regexp_replace(lower(split_part(website,'/',3)),'^www\\.','')=$3)`,[w,name,domain])).rows;
 if(matches.some(firm=>firm.id!==admitted?.firm_id))return {ok:false,reason:'firm_exists'};
 if(await firstSuppressed(ctx,[{scope:'handle',canonicalKey:route.address},...(admitted?[{scope:'firm' as const,canonicalKey:admitted.firm_id}]:[])],'email'))return {ok:false,reason:'email_or_firm_stopped'};
 if((await ctx.db.query(`SELECT id FROM email_addresses WHERE workspace_id=$1 AND address=$2 AND firm_id<>COALESCE($3::uuid,'00000000-0000-0000-0000-000000000000') AND retired_at IS NULL`,[w,route.address,admitted?.firm_id??null])).rows.length)return {ok:false,reason:'email_association_ambiguous'};
 const existing=admitted?await existingEmailRoute(ctx,admitted.firm_id,route.address,input):{ok:true as const,value:null};
 if(!existing.ok)return existing;
 if(admitted&&(await ctx.db.query('SELECT id FROM sequence_enrollments WHERE workspace_id=$1 AND firm_id=$2 AND ended_at IS NULL LIMIT 1',[w,admitted.firm_id])).rows.length)return {ok:false,reason:'firm_already_enrolled'};
 return {ok:true,value:{firmId:admitted?.firm_id??null,route,lane:'email_first',rank:'fit_only',emailRank:'fit_only',reviewRequired:existing.value!==null&&!existing.value.attributed,verifiedFit:true}};
}
