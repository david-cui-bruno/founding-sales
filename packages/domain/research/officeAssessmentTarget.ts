import {createHash} from 'node:crypto';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {databaseNow} from '../policy/clock.ts';
import {researchEligibility} from './eligibility.ts';
import {QUALIFICATION_POLICY_VERSION,QUALIFICATION_PROMPT_VERSION} from '../sourcing/qualificationStore.ts';
import {VERIFIED_FIRM_POLICY_VERSION} from '../sourcing/verifiedFirmPolicy.ts';
import type {QualificationCandidateContext} from '../sourcing/qualificationCitationRoles.ts';
import {OFFICE_CAPTURE_MILLISECONDS,OFFICE_IDENTITY_VERSION,OFFICE_TARGET_VERSION,OFFICE_ASSESSMENT_VERSION,OFFICE_SELECTION_VERSION} from './officeAssessmentContract.ts';
export const officeHash=(value:string):string=>createHash('sha256').update(value).digest('hex');
export interface OfficeParent extends Record<string,unknown> {
 id:string;firm_id:string;research_run_id:string;phone_route_id:string;route_version:number;route_endpoint_hash:string;firm_identity_fingerprint:string;
 identity_version:string;target_version:string;assessment_version:string;selection_version:string;qualification_policy_version:string;qualification_prompt_version:string;verified_firm_policy_version:string;
 captured_at:Date;assessed_at:Date|null;expires_at:Date;result:'pending'|'supported'|'unclear'|'stale';reason:string|null;expected_source_count:number;
}
async function identity(ctx:RepositoryContext,firmId:string){
 const firm=(await ctx.db.query<{name:string;website:string|null;locality:string|null;region_code:string|null}>(`SELECT name,website,locality,region_code FROM firms WHERE workspace_id=$1 AND id=$2`,[ctx.scope.workspaceId,firmId])).rows[0];
 if(!firm)return null;
 return {fingerprint:officeHash(JSON.stringify([OFFICE_IDENTITY_VERSION,firm.name,firm.website,firm.locality,firm.region_code])),
 candidate:firm.website&&firm.locality&&firm.region_code?{firmName:firm.name,website:firm.website,locality:firm.locality,region:firm.region_code} as QualificationCandidateContext:null};
}
async function routes(ctx:RepositoryContext,firmId:string){return (await ctx.db.query<{id:string;version:number;e164:string}>(`SELECT id,version,e164 FROM phone_routes WHERE workspace_id=$1 AND firm_id=$2 AND retired_at IS NULL AND eligibility IN ('candidate','usable') ORDER BY id LIMIT 2`,[ctx.scope.workspaceId,firmId])).rows;}
export async function captureOfficeAssessment(ctx:RepositoryContext,input:{firmId:string;runId:string;at:string}):Promise<void>{
 const firm=await identity(ctx,input.firmId),targets=await routes(ctx,input.firmId),route=targets.length===1?targets[0]:undefined;
 const status=!firm?.candidate?'identity_missing':!targets.length?'target_missing':!route?'target_ambiguous':'bound';
 const changed=await ctx.db.query(`UPDATE research_runs SET office_assessment_capture_status=$3,office_assessment_capture_version=$4
 WHERE workspace_id=$1 AND id=$2 AND purpose='office_evidence' AND outcome='running' AND office_assessment_capture_status IS NULL RETURNING id`,[ctx.scope.workspaceId,input.runId,status,OFFICE_TARGET_VERSION]);
 if(!changed.rows.length||status!=='bound'||!route||!firm)return;
 await ctx.db.query(`INSERT INTO firm_office_assessments(workspace_id,firm_id,research_run_id,phone_route_id,route_version,route_endpoint_hash,firm_identity_fingerprint,
 qualification_policy_version,qualification_prompt_version,verified_firm_policy_version,captured_at,expires_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz,$11::timestamptz+interval '30 minutes')`,[ctx.scope.workspaceId,input.firmId,input.runId,route.id,route.version,officeHash(route.e164),firm.fingerprint,QUALIFICATION_POLICY_VERSION,QUALIFICATION_PROMPT_VERSION,VERIFIED_FIRM_POLICY_VERSION,input.at]);
}
export async function readOfficeAssessmentBinding(ctx:RepositoryContext,runId:string,dispatch=false):Promise<{parent:OfficeParent;candidate:QualificationCandidateContext}|{reason:string}>{
 const parent=(await ctx.db.query<OfficeParent>(`SELECT * FROM firm_office_assessments WHERE workspace_id=$1 AND research_run_id=$2`,[ctx.scope.workspaceId,runId])).rows[0];
 if(!parent){const run=(await ctx.db.query<{office_assessment_capture_status:string|null}>(`SELECT office_assessment_capture_status FROM research_runs WHERE workspace_id=$1 AND id=$2 AND purpose='office_evidence'`,[ctx.scope.workspaceId,runId])).rows[0];return {reason:run?.office_assessment_capture_status??'capture_missing'};}
 if(parent.result==='stale')return {reason:parent.reason??'binding_stale'};
 if(parent.identity_version!==OFFICE_IDENTITY_VERSION||parent.target_version!==OFFICE_TARGET_VERSION||parent.assessment_version!==OFFICE_ASSESSMENT_VERSION||parent.selection_version!==OFFICE_SELECTION_VERSION||parent.qualification_policy_version!==QUALIFICATION_POLICY_VERSION||parent.qualification_prompt_version!==QUALIFICATION_PROMPT_VERSION||parent.verified_firm_policy_version!==VERIFIED_FIRM_POLICY_VERSION)return {reason:'policy_changed'};
 const now=Date.parse(await databaseNow(ctx));
 if(now<parent.captured_at.getTime())return {reason:'capture_invalid'};
 if(dispatch&&now-parent.captured_at.getTime()>=OFFICE_CAPTURE_MILLISECONDS)return {reason:'capture_expired'};
 if(!dispatch&&now>=parent.expires_at.getTime())return {reason:'evidence_expired'};
 const firm=await identity(ctx,parent.firm_id),targets=await routes(ctx,parent.firm_id),route=targets.length===1?targets[0]:undefined;
 if(!firm?.candidate||firm.fingerprint!==parent.firm_identity_fingerprint)return {reason:'identity_changed'};
 if(!route||route.id!==parent.phone_route_id||route.version!==parent.route_version||officeHash(route.e164)!==parent.route_endpoint_hash)return {reason:'route_changed'};
 if(!(await researchEligibility(ctx,parent.firm_id)).ok)return {reason:'research_interrupted'};
 return {parent,candidate:firm.candidate};
}
