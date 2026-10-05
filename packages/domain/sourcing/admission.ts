import {readResearchSettings} from '../research/settings.ts';
import {QUALIFICATION_POLICY_VERSION,QUALIFICATION_PROMPT_VERSION} from './qualificationStore.ts';
import type {CandidateInput} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {decideAdminOnly} from '../crm/authorization.ts';
import {createFirm,loadFirmForUpdate,resolveZoneForFirm} from '../crm/firms.ts';
import {firmNameKey,websiteDomain} from '../crm/import.ts';
import {addPhoneRoute} from '../crm/routes.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {databaseNow} from '../policy/clock.ts';
import {applicablePosture} from '../policy/postures.ts';
import {listApplicableHolds} from '../policy/holds.ts';
import {firstSuppressed} from '../suppression/effective.ts';
import {suppressionKeys} from '../dial/authorize.ts';
import {lockTodayForFirmChange,refreshTodayForFirm} from '../today/build.ts';
import type {QualificationRunRow,SourcingResult} from './qualificationStore.ts';
import {qualifyCandidate,supportedBusinessPhone} from './qualificationPolicy.ts';
import {candidateIdentity} from './qualificationDecision.ts';
interface AdmissionInput {candidateId:string;expectedRevision:number;qualificationRunId:string;mode:'automatic'|'reviewed'}
interface AdmissionResult {firmId:string;routeId:string;alreadyAdmitted:boolean}
const refused=(reason:string):SourcingResult<AdmissionResult>=>({ok:false,reason});
const cityKey=(s:string)=>firmNameKey(s).replace(/[^a-z ]/gu,'');
const centralTexas=new Set(['dallas','fort worth','dfw','arlington','plano','frisco','denton','irving','mckinney','garland','mesquite','richardson','lewisville','carrollton','allen','grand prairie','austin','houston','san antonio']);
export function sourcingTimeZone(region:string,locality:string):string|null {
 if(region==='RI'||region==='MA')return 'America/New_York';
 if(region==='TX'&&centralTexas.has(cityKey(locality)))return 'America/Chicago';
 if(region==='TX'&&cityKey(locality)==='el paso')return 'America/Denver';
 return null;
}
/** A transaction/savepoint makes every refused admission leave the CRM unchanged. */
export async function admitCandidate(ctx:RepositoryContext,input:AdmissionInput):Promise<SourcingResult<AdmissionResult>> {
 if(!decideAdminOnly(ctx).permitted)return refused('admin_only');
 if(input.mode==='reviewed'&&ctx.scope.actor.kind!=='user')return refused('admin_only');
 await ctx.db.query('SAVEPOINT sourcing_admission');
 try{
  const result=await admit(ctx,input);
  if(!result.ok)await ctx.db.query('ROLLBACK TO SAVEPOINT sourcing_admission');
  await ctx.db.query('RELEASE SAVEPOINT sourcing_admission');return result;
 }catch(error){await ctx.db.query('ROLLBACK TO SAVEPOINT sourcing_admission');await ctx.db.query('RELEASE SAVEPOINT sourcing_admission');throw error;}
}
async function admit(ctx:RepositoryContext,input:AdmissionInput):Promise<SourcingResult<AdmissionResult>> {
 const w=ctx.scope.workspaceId;
 // Merge/stop paths use gate -> Today -> firms. Admission takes that same order.
 await lockSendGateForStopFact(ctx);await lockTodayForFirmChange(ctx);
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sourcing-identity:${w}`]);
 const peek=(await ctx.db.query<{payload:CandidateInput}>('SELECT payload FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2',[w,input.candidateId])).rows[0];
 if(!peek)return refused('not_found');
 const domain=websiteDomain(peek.payload.website),name=firmNameKey(peek.payload.firmName);
 const matches=(await ctx.db.query<{id:string;name:string;website:string|null;locality:string|null;region_code:string|null}>(
  `SELECT id,name,website,locality,region_code FROM firms WHERE workspace_id=$1 AND (lower(regexp_replace(trim(name),'\\s+',' ','g'))=$2 OR regexp_replace(lower(split_part(website,'/',3)),'^www\\.','')=$3) ORDER BY id FOR UPDATE`,[w,name,domain])).rows;
 const candidate=(await ctx.db.query<{revision:number;status:string;qualification_blocked:boolean;payload:CandidateInput}>('SELECT revision,status,qualification_blocked,payload FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,input.candidateId])).rows[0];
 const run=(await ctx.db.query<QualificationRunRow>('SELECT * FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=$2 AND candidate_id=$3 FOR UPDATE',[w,input.qualificationRunId,input.candidateId])).rows[0];
 if(!candidate||!run)return refused('not_found');
 if(candidate.qualification_blocked)return refused('identity_review_required');
 if(candidate.revision!==input.expectedRevision||candidate.revision!==run.candidate_revision||candidate.status==='dismissed')return refused('candidate_changed');
 const already=(await ctx.db.query<{firm_id:string;route_id:string}>('SELECT firm_id,route_id FROM sourcing_admissions WHERE workspace_id=$1 AND candidate_id=$2',[w,input.candidateId])).rows[0];
 if(already)return {ok:true,value:{firmId:already.firm_id,routeId:already.route_id,alreadyAdmitted:true}};
 if(input.mode==='automatic'){
  const settings=(await ctx.db.query<{auto_admission_enabled:boolean;qualification_evaluation:{policyVersion?:string;promptVersion?:string;reportSha256?:string;reviewedEligible?:number;falseEligible?:number}|null}>('SELECT auto_admission_enabled,qualification_evaluation FROM sourcing_discovery_settings WHERE workspace_id=$1 FOR SHARE',[w])).rows[0];
  if(!settings?.auto_admission_enabled)return refused('automatic_admission_disabled');
  const evaluation=settings.qualification_evaluation;
  if(!evaluation||evaluation.policyVersion!==QUALIFICATION_POLICY_VERSION||evaluation.promptVersion!==QUALIFICATION_PROMPT_VERSION||!evaluation.reportSha256?.match(/^[a-f0-9]{64}$/u)||!(Number(evaluation.reviewedEligible)>0)||evaluation.falseEligible!==0)return refused('evaluation_required');
  if(!(await readResearchSettings(ctx)).enabled)return refused('research_disabled');
  if((await listApplicableHolds(ctx,{actionKind:'research'})).length)return refused('research_held');
 }
 if(!['review','eligible'].includes(run.state)||run.reason)return refused('evidence_unavailable');
 const identity=candidateIdentity(candidate.payload,run.facts,run.observations),now=await databaseNow(ctx);
 const verdict=qualifyCandidate({identity,facts:run.facts,observations:run.observations,now});
 if(input.mode==='automatic'&&verdict.decision!=='eligible')return refused('qualification_requires_review');
 const reviewable=new Set(['maintenance_need_unconfirmed','help_date_unknown','help_needs_revalidation','need_evidence_conflicts','job_date_unknown','growth_date_unknown','event_needs_revalidation']);
 const invalid=verdict.unknowns.find(reason=>!reviewable.has(reason));if(invalid)return refused(invalid);
 const phone=supportedBusinessPhone(run.facts,identity);if(!phone)return refused('business_phone_unresolved');
 const zone=sourcingTimeZone(candidate.payload.region,candidate.payload.locality);if(!zone)return refused('zone_unresolved');
 if((await applicablePosture(ctx,candidate.payload.region,now)).decision.kind==='refused')return refused('calling_state_not_enabled');
 let owner=ctx.scope.actor.kind==='user'&&input.mode==='reviewed'?ctx.scope.actor.userId:null;
 if(input.mode==='automatic'){
  owner=(await ctx.db.query<{owner_user_id:string|null}>('SELECT owner_user_id FROM sourcing_discovery_settings WHERE workspace_id=$1',[w])).rows[0]?.owner_user_id??null;
  if(!owner){
   const members=(await ctx.db.query<{user_id:string}>('SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND status=\'active\' ORDER BY user_id FOR SHARE',[w])).rows;
   if(members.length!==1)return refused('sourcing_owner_required');owner=members[0]!.user_id;
   await ctx.db.query('INSERT INTO sourcing_discovery_settings(workspace_id,owner_user_id) VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET owner_user_id=$2',[w,owner]);
  }
 }
 if(!owner||(await ctx.db.query('SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status=\'active\' FOR SHARE',[w,owner])).rows.length!==1)return refused('sourcing_owner_inactive');
 const exact=matches.filter(f=>firmNameKey(f.name)===name&&cityKey(f.locality??'')===cityKey(candidate.payload.locality)&&f.region_code===candidate.payload.region&&websiteDomain(f.website)===domain);
 if(exact.length>1||(exact.length===0&&matches.some(f=>websiteDomain(f.website)===domain||(cityKey(f.locality??'')===cityKey(candidate.payload.locality)&&f.region_code===candidate.payload.region))))return refused('firm_identity_ambiguous');
 let firm=exact[0]?await loadFirmForUpdate(ctx,exact[0].id):null;
 if(firm?.status==='merged')return refused('firm_merged');
 if(firm&&firm.assigned_user_id!==owner)return refused('firm_assigned_elsewhere');
 if(await firstSuppressed(ctx,[{scope:'handle',canonicalKey:phone},...(firm?[{scope:'firm' as const,canonicalKey:firm.id}]:[])],'phone'))return refused('phone_or_firm_stopped');
 const otherRoute=(await ctx.db.query<{firm_id:string}>('SELECT firm_id FROM phone_routes WHERE workspace_id=$1 AND e164=$2 AND retired_at IS NULL AND firm_id<>COALESCE($3::uuid,\'00000000-0000-0000-0000-000000000000\') LIMIT 1',[w,phone,firm?.id??null])).rows[0];
 if(otherRoute)return refused('phone_association_ambiguous');
 if(firm&&(await ctx.db.query('SELECT id FROM sequence_enrollments WHERE workspace_id=$1 AND firm_id=$2 AND ended_at IS NULL LIMIT 1',[w,firm.id])).rows.length)return refused('firm_already_enrolled');
 if((await listApplicableHolds(ctx,{actionKind:'dial_authorization',...(firm?{firmId:firm.id}:{}),ownerUserId:owner,channel:'call'})).length)return refused('calling_held');
 if(!firm){const made=await createFirm(ctx,{name:candidate.payload.firmName,website:candidate.payload.website,locality:candidate.payload.locality,regionCode:candidate.payload.region,assignedUserId:owner});if(!made.ok)return refused(made.reason);firm=made.value;}
 const existing=(await ctx.db.query<{id:string;contact_id:string|null;e164:string;eligibility:string}>('SELECT id,contact_id,e164,eligibility FROM phone_routes WHERE workspace_id=$1 AND firm_id=$2 AND e164=$3 ORDER BY id LIMIT 1 FOR UPDATE',[w,firm.id,phone])).rows[0];
 if(existing&&['invalid','retired'].includes(existing.eligibility))return refused('route_unavailable');
 if(existing&&await firstSuppressed(ctx,await suppressionKeys(ctx,firm,existing,undefined),'phone'))return refused('phone_or_firm_stopped');
 const route=existing?{ok:true as const,value:existing}:await addPhoneRoute(ctx,{firmId:firm.id,e164:phone,source:'website',retrievedAt:new Date(run.observations[0]!.retrievedAt)});
 if(!route.ok)return refused(route.reason);
 if(firm.time_zone===null){const resolved=await resolveZoneForFirm(ctx,{firmId:firm.id,recordedZone:zone});if(!resolved.ok)return refused(resolved.reason);}
 await ctx.db.query('INSERT INTO sourcing_admissions(workspace_id,candidate_id,run_id,firm_id,route_id) VALUES($1,$2,$3,$4,$5)',[w,input.candidateId,run.id,firm.id,route.value.id]);
 await ctx.db.query("UPDATE sourcing_qualification_runs SET state='admitted',verdict=$3::jsonb WHERE workspace_id=$1 AND id=$2",[w,run.id,JSON.stringify(verdict)]);
 await recordCrmAuditEvent(ctx,{action:'sourcing.candidate_admitted',subjectKind:'firm',subjectId:firm.id,detail:{candidateId:input.candidateId,runId:run.id,mode:input.mode,decision:verdict.decision}});
 await refreshTodayForFirm(ctx,{firmId:firm.id});
 return {ok:true,value:{firmId:firm.id,routeId:route.value.id,alreadyAdmitted:false}};
}
