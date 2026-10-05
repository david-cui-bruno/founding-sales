import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import type {JobHandler} from '@fss/domain/jobs/handlerRegistry.ts';
import type {JobSpecification} from '@fss/domain/jobs/jobStore.ts';
import {jobIdempotencyKey} from '@fss/domain/jobs/jobKinds.ts';
import type {PageFetchProvider} from '@fss/domain/research/providers.ts';
import type {QualificationExtractionProvider} from '@fss/domain/sourcing/qualificationPrompt.ts';
import {runQualification,expireQualificationsInTransaction} from '@fss/domain/sourcing/qualificationRun.ts';
import {requestQualification,QUALIFICATION_PROMPT_VERSION,QUALIFICATION_POLICY_VERSION} from '@fss/domain/sourcing/qualificationStore.ts';
import {evaluateQualification} from '@fss/domain/sourcing/qualificationDecision.ts';
import {admitCandidate} from '@fss/domain/sourcing/admission.ts';
import type {DueWorkSource} from '../scheduler/schedulerPass.ts';
export function sourcingQualificationHandler(deps:{pageFetch:PageFetchProvider;extraction:QualificationExtractionProvider|null}):JobHandler {
 return {kind:'sourcing.qualify',protection:'outbound_fence',maxAttempts:1,leaseSeconds:180,
 handle:async input=>{
  const runId=input.job.payload['runId'];if(typeof runId!=='string')return;
  const ctx=repositoryContext(input.scope,input.session);
  await runQualification(ctx,{runId},deps);
  const decided=await withTransaction(input.session,()=>evaluateQualification(ctx,{runId}));if(!decided.ok)return;
  const row=(await input.session.query<{candidate_id:string;candidate_revision:number}>(`SELECT r.candidate_id,r.candidate_revision FROM sourcing_qualification_runs r
   JOIN sourcing_discovery_settings s ON s.workspace_id=r.workspace_id WHERE r.workspace_id=$1 AND r.id=$2 AND r.state='eligible' AND s.auto_admission_enabled`,[input.scope.workspaceId,runId])).rows[0];
  if(row){
   const admitted=await withTransaction(input.session,()=>admitCandidate(ctx,{candidateId:row.candidate_id,expectedRevision:row.candidate_revision,qualificationRunId:runId,mode:'automatic'}));
   await input.session.query('UPDATE sourcing_qualification_runs SET admission_reason=$3 WHERE workspace_id=$1 AND id=$2',[input.scope.workspaceId,runId,admitted.ok?null:admitted.reason]);
  }
 }};
}
/** Scheduler transaction owns these mutations; no network or nested transaction. */
export function sourcingQualificationSource(enabled:boolean):DueWorkSource {
 return {name:'sourcing-qualification',find:async(session,now)=>{
  const workspaces=(await session.query<{id:string}>(`SELECT w.id FROM workspaces w LEFT JOIN sourcing_discovery_settings scheduling ON scheduling.workspace_id=w.id WHERE EXISTS(SELECT 1 FROM sourcing_qualification_runs r WHERE r.workspace_id=w.id AND r.state IN ('pending','running') AND r.deadline_at<=$1::timestamptz)
   OR EXISTS(SELECT 1 FROM provider_reservations p WHERE p.workspace_id=w.id AND p.subject_kind='sourcing_qualification' AND p.state IN ('reserved','calling') AND p.created_at<=$1::timestamptz-interval '30 minutes')
   OR ($2 AND EXISTS(SELECT 1 FROM sourcing_candidates c WHERE c.workspace_id=w.id AND c.status<>'dismissed' AND NOT c.qualification_blocked)) ORDER BY scheduling.qualification_last_pass_at NULLS FIRST,w.id LIMIT 25`,[now,enabled])).rows;
  const jobs:JobSpecification[]=[];
  for(const workspace of workspaces){
   const ctx=repositoryContext(workspaceScope(workspace.id,{kind:'system',component:'scheduler'}),session);
   await session.query('INSERT INTO sourcing_discovery_settings(workspace_id,qualification_last_pass_at) VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET qualification_last_pass_at=$2',[workspace.id,now]);
   await expireQualificationsInTransaction(ctx);
   if(!enabled)continue;
   // Re-evaluate stored evidence after activation; no new extraction or research counter.
   const reconsider=(await session.query<{id:string;candidate_id:string;candidate_revision:number}>(`SELECT r.id,r.candidate_id,r.candidate_revision FROM sourcing_qualification_runs r
    JOIN sourcing_candidates c ON c.workspace_id=r.workspace_id AND c.id=r.candidate_id
    JOIN sourcing_discovery_settings s ON s.workspace_id=r.workspace_id
    WHERE r.workspace_id=$1 AND s.auto_admission_enabled AND r.state='eligible' AND r.reason IS NULL
     AND c.revision=r.candidate_revision AND c.status<>'dismissed' AND NOT c.qualification_blocked
     AND (r.admission_checked_at IS NULL OR r.admission_checked_at<$2::timestamptz-interval '1 hour')
     AND NOT EXISTS(SELECT 1 FROM sourcing_admissions a WHERE a.workspace_id=r.workspace_id AND a.candidate_id=r.candidate_id)
     AND r.id=(SELECT newest.id FROM sourcing_qualification_runs newest WHERE newest.workspace_id=r.workspace_id AND newest.candidate_id=r.candidate_id ORDER BY newest.requested_at DESC,newest.id DESC LIMIT 1)
    ORDER BY r.admission_checked_at NULLS FIRST,r.requested_at,r.id LIMIT 25 FOR UPDATE OF r`,[workspace.id,now])).rows;
   for(const run of reconsider){
    await session.query('UPDATE sourcing_qualification_runs SET admission_checked_at=$3 WHERE workspace_id=$1 AND id=$2',[workspace.id,run.id,now]);
    jobs.push({workspaceId:workspace.id,kind:'sourcing.qualify',idempotencyKey:`sourcing-admission:${run.id}:${now.slice(0,13)}`,payload:{runId:run.id,candidateId:run.candidate_id,candidateRevision:run.candidate_revision,promptVersion:QUALIFICATION_PROMPT_VERSION,policyVersion:QUALIFICATION_POLICY_VERSION},maxAttempts:1});
   }
   const due=(await session.query<{id:string;revision:number}>(`SELECT c.id,c.revision FROM sourcing_candidates c LEFT JOIN LATERAL
    (SELECT r.requested_at,r.candidate_revision,r.state,r.reason FROM sourcing_qualification_runs r WHERE r.workspace_id=c.workspace_id AND r.candidate_id=c.id ORDER BY r.requested_at DESC,r.id DESC LIMIT 1) last ON true
    WHERE c.workspace_id=$1 AND c.status<>'dismissed' AND NOT c.qualification_blocked AND (last.requested_at IS NULL OR last.candidate_revision<>c.revision OR
     ((c.status='kept' OR EXISTS(SELECT 1 FROM sourcing_admissions a WHERE a.workspace_id=c.workspace_id AND a.candidate_id=c.id)) AND last.requested_at<$2::timestamptz-interval '7 days') OR (last.state='unavailable' AND last.requested_at<$2::timestamptz-interval '1 day'))
    ORDER BY last.requested_at NULLS FIRST,c.created_at,c.id LIMIT 25`,[workspace.id,now])).rows;
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
