import type {CandidateInput} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {lockTodayForFirmChange,refreshTodayForFirm} from '../today/build.ts';
import {databaseNow} from '../policy/clock.ts';
import {readResearchSettings} from '../research/settings.ts';
import {listApplicableHolds} from '../policy/holds.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {admitCandidate} from './admission.ts';
import {attachSourcingAttribution} from './attribution.ts';
import {QUALIFICATION_POLICY_VERSION,QUALIFICATION_PROMPT_VERSION,type QualificationRunRow} from './qualificationStore.ts';
import {verifiedFirmOwner,verifiedFirmEvidence,VERIFIED_FIRM_POLICY_VERSION} from './verifiedFirmPolicy.ts';

/** Caller owns the transaction. No providers, contacts, enrollment or send authority. */
export async function advanceVerifiedFirm(ctx:RepositoryContext,input:{runId:string}):Promise<void> {
 if(ctx.scope.actor.kind!=='system'||!['worker','scheduler'].includes(ctx.scope.actor.component))return;
 await lockSendGateForStopFact(ctx);await lockTodayForFirmChange(ctx);
 if(!await verifiedFirmOwner(ctx)||!(await readResearchSettings(ctx)).enabled||(await listApplicableHolds(ctx,{actionKind:'research'})).length)return;
 const w=ctx.scope.workspaceId;
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sourcing-identity:${w}`]);
 const candidate=(await ctx.db.query<{id:string;revision:number;status:string;qualification_blocked:boolean;payload:CandidateInput}>(`SELECT c.* FROM sourcing_candidates c JOIN sourcing_qualification_runs r ON r.workspace_id=c.workspace_id AND r.candidate_id=c.id WHERE c.workspace_id=$1 AND r.id=$2 FOR UPDATE OF c`,[w,input.runId])).rows[0];
 const run=(await ctx.db.query<QualificationRunRow>('SELECT * FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,input.runId])).rows[0];
 if(!candidate||!run||candidate.qualification_blocked||candidate.status==='dismissed'||run.candidate_revision!==candidate.revision||run.policy_version!==QUALIFICATION_POLICY_VERSION||run.prompt_version!==QUALIFICATION_PROMPT_VERSION||run.reason||!['review','eligible','admitted'].includes(run.state))return;
 const proof=verifiedFirmEvidence({candidate:candidate.payload,facts:run.facts,observations:run.observations,now:await databaseNow(ctx)});
 const record=async(reason:string|null)=>ctx.db.query('UPDATE sourcing_qualification_runs SET admission_reason=$3,admission_checked_at=now() WHERE workspace_id=$1 AND id=$2',[w,run.id,reason]);
 if(proof.kind!=='verified'){await record(proof.reason);return;}
 if(candidate.status==='needs_review'){
  // This transaction proved the unchanged payload against this exact run. Only the
  // review status changes. Bind that one verified run to the new revision and audit
  // both revisions; every older run remains stale and every old command is refused.
  const previousRevision=candidate.revision;
  await ctx.db.query("UPDATE sourcing_candidates SET status='kept',revision=revision+1,next_source_check_at=COALESCE(next_source_check_at,now()+interval '7 days'),updated_at=now() WHERE workspace_id=$1 AND id=$2",[w,candidate.id]);
  candidate.revision++;
  await ctx.db.query('UPDATE sourcing_qualification_runs SET candidate_revision=$3 WHERE workspace_id=$1 AND id=$2',[w,run.id,candidate.revision]);
  await recordCrmAuditEvent(ctx,{action:'sourcing.candidate_auto_kept',subjectKind:'sourcing_candidate',subjectId:candidate.id,detail:{runId:run.id,previousRevision,revision:candidate.revision,policyVersion:VERIFIED_FIRM_POLICY_VERSION}});
 }
 if(!proof.phone){await record('business_phone_unresolved');return;}
 const result=await admitCandidate(ctx,{candidateId:candidate.id,expectedRevision:candidate.revision,qualificationRunId:run.id,mode:'automatic'});
 if(!result.ok){await record(result.reason);return;}
 // A fresh source or refresh is a new immutable attribution, not a CRM fact edit.
 // source_key uniqueness makes publication/recovery replay harmless.
 if(result.value.alreadyAdmitted){
  const exists=(await ctx.db.query('SELECT id FROM sourcing_attributions WHERE workspace_id=$1 AND firm_id=$2 AND candidate_id=$3 AND run_id=$4 AND policy_version=$5',[w,result.value.firmId,candidate.id,run.id,VERIFIED_FIRM_POLICY_VERSION])).rows.length>0;
  if(!exists){
   const attached=await attachSourcingAttribution(ctx,{firmId:result.value.firmId,candidateId:candidate.id,qualificationRunId:run.id,queryId:null,hypothesis:run.verdict?.rank??'fit_only',policyVersion:VERIFIED_FIRM_POLICY_VERSION,acquisition:'cold_sourced'});
   if(!attached.ok)throw new Error(`verified_firm_attribution_${attached.reason}`);
  }
 }
 const prior=(await ctx.db.query<{candidate_id:string}>(`SELECT candidate_id FROM sourcing_admissions WHERE workspace_id=$1 AND firm_id=$2 AND candidate_id<>$3 AND NOT association_review_required ORDER BY admitted_at,candidate_id LIMIT 1`,[w,result.value.firmId,candidate.id])).rows[0];
 if(prior&&!result.value.alreadyAdmitted){
  // Evidence and its explicit firm link are durable before the redundant draft is
  // dismissed. Never delete, merge free text, or mutate the canonical CRM record.
  await ctx.db.query("UPDATE sourcing_candidates SET status='dismissed',revision=revision+1,next_source_check_at=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2",[w,candidate.id]);
  await recordCrmAuditEvent(ctx,{action:'sourcing.duplicate_evidence_linked',subjectKind:'sourcing_candidate',subjectId:candidate.id,detail:{firmId:result.value.firmId,canonicalCandidateId:prior.candidate_id,runId:run.id,policyVersion:VERIFIED_FIRM_POLICY_VERSION}});
 }
 await record(null);
 await refreshTodayForFirm(ctx,{firmId:result.value.firmId});
}
