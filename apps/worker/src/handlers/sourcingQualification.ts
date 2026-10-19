import {withTransaction} from '@fss/domain/db/queryable.ts';
import {evaluateQualification} from '@fss/domain/sourcing/qualificationDecision.ts';
import {advanceVerifiedFirm} from '@fss/domain/sourcing/verifiedFirmPipeline.ts';
import {verifiedFirmOwner,VERIFIED_FIRM_POLICY_VERSION,IDENTITY_REVIEW_REASONS} from '@fss/domain/sourcing/verifiedFirmPolicy.ts';
import {lockSendGateForStopFact} from '@fss/domain/policy/sendGate.ts';
import {lockTodayForFirmChange} from '@fss/domain/today/build.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import type {JobHandler} from '@fss/domain/jobs/handlerRegistry.ts';
import type {JobSpecification} from '@fss/domain/jobs/jobStore.ts';
import {jobIdempotencyKey} from '@fss/domain/jobs/jobKinds.ts';
import type {PageFetchProvider} from '@fss/domain/research/providers.ts';
import type {QualificationExtractionProvider} from '@fss/domain/sourcing/qualificationPrompt.ts';
import {runQualification,expireQualificationsInTransaction} from '@fss/domain/sourcing/qualificationRun.ts';
import {requestQualification,QUALIFICATION_PROMPT_VERSION,QUALIFICATION_POLICY_VERSION} from '@fss/domain/sourcing/qualificationStore.ts';
import type {DueWorkSource} from '../scheduler/schedulerPass.ts';
export function sourcingQualificationHandler(deps:{pageFetch:PageFetchProvider;extraction:QualificationExtractionProvider|null}):JobHandler {
 return {kind:'sourcing.qualify',protection:'outbound_fence',maxAttempts:1,leaseSeconds:180,
 handle:async input=>{
  const runId=input.job.payload['runId'];if(typeof runId!=='string')return;
  const ctx=repositoryContext(input.scope,input.session);
  await runQualification(ctx,{runId},deps);
  await withTransaction(input.session,async()=>{
   await lockSendGateForStopFact(ctx);await lockTodayForFirmChange(ctx);
   await evaluateQualification(ctx,{runId});
   await advanceVerifiedFirm(ctx,{runId});
  });
 }};
}
/** Scheduler transaction owns these mutations; no network or nested transaction. */
export function sourcingQualificationSource(enabled:boolean):DueWorkSource {
 return {name:'sourcing-qualification',find:async(session,now)=>{
  const workspaces=(await session.query<{id:string}>(`SELECT w.id FROM workspaces w LEFT JOIN sourcing_discovery_settings scheduling ON scheduling.workspace_id=w.id WHERE EXISTS(SELECT 1 FROM sourcing_qualification_runs r WHERE r.workspace_id=w.id AND r.state IN ('pending','running') AND r.deadline_at<=$1::timestamptz)
   OR EXISTS(SELECT 1 FROM provider_reservations p WHERE p.workspace_id=w.id AND p.subject_kind='sourcing_qualification' AND p.state IN ('reserved','calling') AND p.created_at<=$1::timestamptz-interval '30 minutes')
   OR ($2 AND EXISTS(SELECT 1 FROM sourcing_candidates c WHERE c.workspace_id=w.id AND NOT c.qualification_blocked AND (c.status='kept' OR (c.status='needs_review' AND scheduling.auto_admission_enabled AND scheduling.qualification_evaluation->>'verifiedFirmPolicyVersion'=$3)))) ORDER BY scheduling.qualification_last_pass_at NULLS FIRST,w.id LIMIT 25`,[now,enabled,VERIFIED_FIRM_POLICY_VERSION])).rows;
  const jobs:JobSpecification[]=[];
  // Fairness selects the batch. Stable lock order prevents overlapping scheduler
  // batches from taking the same workspace gates in opposite orders.
  for(const workspace of [...workspaces].sort((a,b)=>a.id.localeCompare(b.id))){
   const ctx=repositoryContext(workspaceScope(workspace.id,{kind:'system',component:'scheduler'}),session);
   await lockSendGateForStopFact(ctx);await lockTodayForFirmChange(ctx);
   await session.query('INSERT INTO sourcing_discovery_settings(workspace_id,qualification_last_pass_at) VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET qualification_last_pass_at=$2',[workspace.id,now]);
   await expireQualificationsInTransaction(ctx);
   if(!enabled)continue;
   const automatic=await verifiedFirmOwner(ctx)!==null;
   if(automatic){
    // Recover only committed evidence, never replay a provider dispatch. Publication
    // refusals stay pending and are checked at most hourly without spending again.
    const ready=(await session.query<{id:string}>(`SELECT r.id FROM sourcing_qualification_runs r JOIN sourcing_candidates c ON c.workspace_id=r.workspace_id AND c.id=r.candidate_id WHERE r.workspace_id=$1 AND c.status<>'dismissed' AND NOT c.qualification_blocked AND c.revision=r.candidate_revision AND r.state IN ('review','eligible') AND r.reason IS NULL AND (r.admission_checked_at IS NULL OR r.admission_checked_at<$2::timestamptz-interval '1 hour') AND NOT EXISTS(SELECT 1 FROM sourcing_qualification_runs newer WHERE newer.workspace_id=r.workspace_id AND newer.candidate_id=r.candidate_id AND (newer.requested_at,newer.id)>(r.requested_at,r.id)) ORDER BY r.requested_at,r.id LIMIT 25`,[workspace.id,now])).rows;
    for(const run of ready)await advanceVerifiedFirm(ctx,{runId:run.id});
   }
   // Old evidence versions are due now, but a version bump is not an identity
   // correction: the same-revision review stop remains outside every due alternative.
   const due=(await session.query<{id:string;revision:number}>(`SELECT c.id,c.revision FROM sourcing_candidates c LEFT JOIN LATERAL
    (SELECT r.requested_at,r.candidate_revision,r.prompt_version,r.policy_version,r.state,r.reason,r.admission_reason FROM sourcing_qualification_runs r WHERE r.workspace_id=c.workspace_id AND r.candidate_id=c.id ORDER BY r.requested_at DESC,r.id DESC LIMIT 1) last ON true
    WHERE c.workspace_id=$1 AND (c.status='kept' OR ($3 AND c.status='needs_review' AND (c.payload->>'preparedBy'='Tavily Basic search · not verified' OR EXISTS(SELECT 1 FROM sourcing_apollo_candidate_origins origin JOIN sourcing_apollo_attempts attempt ON attempt.workspace_id=origin.workspace_id AND attempt.id=origin.attempt_id WHERE origin.workspace_id=c.workspace_id AND origin.candidate_id=c.id AND origin.candidate_revision<=c.revision AND origin.domain=regexp_replace(lower(split_part(c.payload->>'website','/',3)),'^www\\.','') AND attempt.state='complete')))) AND NOT c.qualification_blocked AND NOT ($3 AND last.candidate_revision=c.revision AND COALESCE(last.admission_reason=ANY($4::text[]),false)) AND (last.requested_at IS NULL OR last.candidate_revision<>c.revision OR
     last.prompt_version<>$5 OR last.policy_version<>$6 OR last.requested_at<$2::timestamptz-interval '7 days' OR (last.state='unavailable' AND last.requested_at<$2::timestamptz-interval '1 day'))
    ORDER BY EXISTS(SELECT 1 FROM sourcing_admissions a WHERE a.workspace_id=c.workspace_id AND a.candidate_id=c.id),c.status<>'kept',last.requested_at NULLS FIRST,c.created_at,c.id LIMIT 25`,[workspace.id,now,automatic,IDENTITY_REVIEW_REASONS,QUALIFICATION_PROMPT_VERSION,QUALIFICATION_POLICY_VERSION])).rows;
   for(const candidate of due){
    const queued=await requestQualification(ctx,{candidateId:candidate.id,expectedRevision:candidate.revision},{enqueue:false});
    if(!queued.ok){
     if(['daily_firm_ceiling','research_disabled','research_held'].includes(queued.reason)){
      await session.query('INSERT INTO sourcing_discovery_settings(workspace_id,qualification_wait_reason) VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET qualification_wait_reason=$2',[workspace.id,queued.reason]);break;
     }
     continue;
    }
    jobs.push({workspaceId:workspace.id,kind:'sourcing.qualify',idempotencyKey:jobIdempotencyKey.sourcingQualify(queued.value.runId),payload:{runId:queued.value.runId,candidateId:candidate.id,candidateRevision:candidate.revision,promptVersion:QUALIFICATION_PROMPT_VERSION,policyVersion:QUALIFICATION_POLICY_VERSION},maxAttempts:1});
    await session.query("UPDATE sourcing_candidates SET next_source_check_at=CASE WHEN status='kept' THEN now()+interval '7 days' ELSE next_source_check_at END WHERE workspace_id=$1 AND id=$2",[workspace.id,candidate.id]);
    await session.query('UPDATE sourcing_discovery_settings SET qualification_wait_reason=NULL WHERE workspace_id=$1',[workspace.id]);
   }
  }
  return jobs;
 }};
}
