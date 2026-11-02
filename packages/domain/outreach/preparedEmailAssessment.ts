import type {RepositoryContext} from '../db/workspaceScope.ts';
import {decideAdminOnly} from '../crm/authorization.ts';
import {preparedEmailTimeZone} from '../sourcing/admission.ts';
import {websiteDomain} from '../crm/import.ts';
import {businessIdentityKey} from '../sourcing/businessName.ts';
import {firstSuppressed} from '../suppression/effective.ts';
import {retainedCandidateOnly} from '../sourcing/retainedAcquisition.ts';
import {preparedCandidatePayload} from '../sourcing/discoveryIntake.ts';
import {existingEmailRoute} from './existingEmail.ts';
import {campaignCandidateProvenance} from './emailCampaignAuthority.ts';
import type {PreparedEmailTarget} from './emailCampaignSource.ts';
import type {EmailAssessment} from './selection.ts';

/** Firms (any status) already carrying the company's resolved business name (the name admission gives the Firm) or website host, other than the Firm admission created from this candidate. Names compare by `businessIdentityKey` on both sides, so an existing "Acme Realty LLC" is the company "Acme Realty"; SQL narrows by name prefix, the key decides. */
async function conflictingFirmIds(ctx:RepositoryContext,company:{businessName:string;website:string},admittedFirmId:string|null):Promise<string[]>{
 const key=businessIdentityKey(company.businessName);
 const matches=(await ctx.db.query<{id:string;name:string;domain_match:boolean}>(`SELECT id,name,regexp_replace(lower(split_part(website,'/',3)),'^www\\.','')=$3 AS domain_match FROM firms WHERE workspace_id=$1 AND (lower(regexp_replace(trim(name),'\\s+',' ','g')) LIKE $2 ESCAPE '\\' OR regexp_replace(lower(split_part(website,'/',3)),'^www\\.','')=$3)`,[ctx.scope.workspaceId,`${key.replaceAll(/[\\%_]/gu,'\\$&')}%`,websiteDomain(company.website)])).rows;
 return matches.flatMap(firm=>firm.id!==admittedFirmId&&(firm.domain_match||businessIdentityKey(firm.name)===key)?[firm.id]:[]);
}
const admittedFirm=async(ctx:RepositoryContext,candidateId:string,runId:string,campaignId:string):Promise<string|null>=>(await ctx.db.query<{firm_id:string}>('SELECT firm_id FROM outreach_email_sources WHERE workspace_id=$1 AND candidate_id=$2 AND run_id=$3 AND campaign_id=$4 AND NOT association_review_required',[ctx.scope.workspaceId,candidateId,runId,campaignId])).rows[0]?.firm_id??null;
/** Selection-time form of the deterministic refusals `assessPreparedEmail` and the Firm admission would make (an existing Firm, an
 * unresolvable time zone, an effective email stop): a company refused this way is left out before the work limit, within the bounded
 * scan of the prepared order (the first 400 records), so it cannot starve later companies inside that window. Advisory and unlocked; admission still decides. */
export async function preparedAdmissionRefusedInAdvance(ctx:RepositoryContext,campaignId:string|null,read:{candidateId:string;runId:string;region:string;locality:string;businessName:string;route:{address:string}}):Promise<boolean>{
 if(preparedEmailTimeZone(read.region,read.locality)===null)return true;
 const w=ctx.scope.workspaceId;
 const candidate=(await ctx.db.query<{payload:unknown}>('SELECT payload FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2',[w,read.candidateId])).rows[0];
 const payload=candidate&&preparedCandidatePayload(candidate.payload);if(!payload)return false;
 const admittedFirmId=campaignId?await admittedFirm(ctx,read.candidateId,read.runId,campaignId):null;
 if((await conflictingFirmIds(ctx,{businessName:read.businessName,website:payload.website},admittedFirmId)).length>0)return true;
 // The same effective email-handle stop admission checks under its locks, so a stopped address cannot fill the scan either.
 return Boolean(await firstSuppressed(ctx,[{scope:'handle',canonicalKey:read.route.address},...(admittedFirmId?[{scope:'firm' as const,canonicalKey:admittedFirmId}]:[])],'email'));
}
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
 if(!proof.businessName)return {ok:false,reason:'business_name_unavailable'};
 const route=proof.route;
 const admittedFirmId=await admittedFirm(ctx,input.candidateId,input.qualificationRunId,input.campaignId);
 if((await conflictingFirmIds(ctx,{businessName:proof.businessName,website:payload.website},admittedFirmId)).length)return {ok:false,reason:'firm_exists'};
 if(await firstSuppressed(ctx,[{scope:'handle',canonicalKey:route.address},...(admittedFirmId?[{scope:'firm' as const,canonicalKey:admittedFirmId}]:[])],'email'))return {ok:false,reason:'email_or_firm_stopped'};
 if((await ctx.db.query(`SELECT id FROM email_addresses WHERE workspace_id=$1 AND address=$2 AND firm_id<>COALESCE($3::uuid,'00000000-0000-0000-0000-000000000000') AND retired_at IS NULL`,[w,route.address,admittedFirmId])).rows.length)return {ok:false,reason:'email_association_ambiguous'};
 const existing=admittedFirmId?await existingEmailRoute(ctx,admittedFirmId,route.address,input):{ok:true as const,value:null};
 if(!existing.ok)return existing;
 if(admittedFirmId&&(await ctx.db.query('SELECT id FROM sequence_enrollments WHERE workspace_id=$1 AND firm_id=$2 AND ended_at IS NULL LIMIT 1',[w,admittedFirmId])).rows.length)return {ok:false,reason:'firm_already_enrolled'};
 return {ok:true,value:{firmId:admittedFirmId,firmName:proof.businessName,route,lane:'email_first',rank:'fit_only',emailRank:'fit_only',reviewRequired:existing.value!==null&&!existing.value.attributed,verifiedFit:true}};
}
