import { createHash, randomUUID } from 'node:crypto';
import {
  qualificationRequestSchema, qualificationEvidenceSchema, type QualificationView,
  type SourceObservation, type QualificationFact, type QualificationVerdict, type QualificationStatus,
} from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { decideAdminOnly } from '../crm/authorization.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { databaseNow } from '../policy/clock.ts';
import { listApplicableHolds } from '../policy/holds.ts';
import { readResearchSettings } from '../research/settings.ts';
import { incrementDailyCounter } from '../jobs/counters.ts';
import { RESEARCH_FIRM_RUN_COUNTER } from '../research/ceilings.ts';
import { workspaceBusinessZone } from '../research/ledger.ts';
import { enqueueJob } from '../jobs/jobStore.ts';
import { jobIdempotencyKey } from '../jobs/jobKinds.ts';

export const QUALIFICATION_PROMPT_VERSION='qualification-v1';
export const QUALIFICATION_POLICY_VERSION='qualification-v1';
export type SourcingResult<T>={ok:true;value:T}|{ok:false;reason:string};
export interface QualificationRunRow {
  id:string;candidate_id:string;candidate_revision:number;model_name:string;
  prompt_version:string;policy_version:string;state:QualificationStatus;reason:string|null;
  observations:SourceObservation[];facts:QualificationFact[];verdict:QualificationVerdict|null;
  opening_question:string|null;requested_at:Date;deadline_at:Date;[key:string]:unknown;
}
interface CandidateRow {id:string;revision:number;status:string;[key:string]:unknown}
const candidateRead='SELECT id,revision,status FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2';
const refused=(reason:string):{ok:false;reason:string}=>({ok:false,reason});

/** Caller transaction holds the candidate before runs, matching triage/admission. */
export async function requestQualification(context:RepositoryContext,input:{candidateId:string;expectedRevision:number}):Promise<SourcingResult<{runId:string}>> {
  if(!decideAdminOnly(context).permitted)return refused('admin_only');
  if(!qualificationRequestSchema.safeParse(input).success)return refused('invalid_input');
  const workspaceId=context.scope.workspaceId;
  const candidate=(await context.db.query<CandidateRow>(`${candidateRead} FOR UPDATE`,[workspaceId,input.candidateId])).rows[0];
  if(!candidate)return refused('not_found');
  if(candidate.revision!==input.expectedRevision)return refused('candidate_changed');
  if(candidate.status==='dismissed')return refused('candidate_dismissed');
  const now=await databaseNow(context),settings=await readResearchSettings(context);
  const fingerprint=createHash('sha256').update(JSON.stringify([candidate.revision,QUALIFICATION_PROMPT_VERSION,QUALIFICATION_POLICY_VERSION,settings.modelName,now.slice(0,10)])).digest('hex');
  const previous=(await context.db.query<{id:string}>(
    'SELECT id FROM sourcing_qualification_runs WHERE workspace_id=$1 AND candidate_id=$2 AND fingerprint=$3',
    [workspaceId,candidate.id,fingerprint])).rows[0];
  if(previous)return {ok:true,value:{runId:previous.id}};
  if(!settings.enabled)return refused('research_disabled');
  if((await listApplicableHolds(context,{actionKind:'research'})).length)return refused('research_held');
  const count=await incrementDailyCounter(context,{subjectKind:'workspace',subjectKey:workspaceId,counterKind:RESEARCH_FIRM_RUN_COUNTER,
    businessTimeZone:await workspaceBusinessZone(context),at:now},settings.dailyFirmCeiling);
  if(!count.allowed)return refused('daily_firm_ceiling');
  const runId=randomUUID();
  await context.db.query(`INSERT INTO sourcing_qualification_runs
    (workspace_id,id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[workspaceId,runId,candidate.id,candidate.revision,fingerprint,QUALIFICATION_PROMPT_VERSION,QUALIFICATION_POLICY_VERSION,settings.modelName]);
  await enqueueJob(context.db,{workspaceId,kind:'sourcing.qualify',idempotencyKey:jobIdempotencyKey.sourcingQualify(runId),
    payload:{runId,candidateId:candidate.id,candidateRevision:candidate.revision,promptVersion:QUALIFICATION_PROMPT_VERSION,policyVersion:QUALIFICATION_POLICY_VERSION},maxAttempts:1});
  await recordCrmAuditEvent(context,{action:'sourcing.qualification_requested',subjectKind:'sourcing_candidate',subjectId:candidate.id,detail:{runId,candidateRevision:candidate.revision}});
  return {ok:true,value:{runId}};
}

export async function readQualification(context:RepositoryContext,input:{candidateId:string}):Promise<QualificationView|null> {
  if(!decideAdminOnly(context).permitted)return null;
  const candidate=(await context.db.query<CandidateRow>(candidateRead,[context.scope.workspaceId,input.candidateId])).rows[0];
  if(!candidate)return null;
  const rows=(await context.db.query<QualificationRunRow>(`SELECT * FROM sourcing_qualification_runs
    WHERE workspace_id=$1 AND candidate_id=$2 ORDER BY requested_at DESC,id DESC LIMIT 20`,[context.scope.workspaceId,candidate.id])).rows;
  const current=rows[0];if(!current)return null;
  const now=await databaseNow(context);
  const reason=candidate.status==='dismissed'?'candidate_dismissed':candidate.revision!==current.candidate_revision?'candidate_changed':
    (['pending','running'].includes(current.state) && current.deadline_at.getTime()<=Date.parse(now))?'qualification_expired':current.reason;
  const admission=(await context.db.query<{firm_id:string;route_id:string}>(
    'SELECT firm_id,route_id FROM sourcing_admissions WHERE workspace_id=$1 AND candidate_id=$2',[context.scope.workspaceId,candidate.id])).rows[0];
  return {candidateId:candidate.id,runId:current.id,candidateRevision:current.candidate_revision,status:reason?'unavailable':current.state,reason,
    requestedAt:current.requested_at.toISOString(),deadlineAt:current.deadline_at.toISOString(),observations:current.observations,facts:current.facts,
    verdict:reason?null:current.verdict,openingQuestion:reason?null:current.opening_question,
    admission:admission?{firmId:admission.firm_id,routeId:admission.route_id}:null,
    history:rows.slice(1).filter(row=>row.observations.length>0).map(row=>({runId:row.id,observations:row.observations,facts:row.facts}))};
}

/** Persist only locally validated source references; this never grants eligibility. */
export async function finishQualification(context:RepositoryContext,input:{runId:string;observations:unknown[];facts:unknown[];reason:string|null;openingQuestion?:string|null}):Promise<SourcingResult<{runId:string}>> {
  if(!decideAdminOnly(context).permitted)return refused('admin_only');
  const evidence=qualificationEvidenceSchema.safeParse({observations:input.observations,facts:input.facts});
  if(!evidence.success || Buffer.byteLength(JSON.stringify(input.observations),'utf8')>100_000 || Buffer.byteLength(JSON.stringify(input.facts),'utf8')>50_000 ||
    (input.reason!==null && (input.reason.length===0 || input.reason.length>120)) || (input.openingQuestion?.length??0)>240)return refused('invalid_evidence');
  const workspaceId=context.scope.workspaceId;
  const identity=(await context.db.query<{candidate_id:string}>('SELECT candidate_id FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=$2',[workspaceId,input.runId])).rows[0];
  if(!identity)return refused('not_found');
  const candidate=(await context.db.query<CandidateRow>(`${candidateRead} FOR UPDATE`,[workspaceId,identity.candidate_id])).rows[0];
  if(!candidate)return refused('not_found');
  const run=(await context.db.query<QualificationRunRow>('SELECT * FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[workspaceId,input.runId])).rows[0];
  if(!run)return refused('not_found');
  if(!['pending','running'].includes(run.state))return refused('run_finished');
  const now=await databaseNow(context);
  const invalid=candidate.status==='dismissed'?'candidate_dismissed':candidate.revision!==run.candidate_revision?'candidate_changed':
    run.deadline_at.getTime()<=Date.parse(now)?'qualification_expired':null;
  if(invalid){
    await context.db.query("UPDATE sourcing_qualification_runs SET state='unavailable',reason=$3,finished_at=now() WHERE workspace_id=$1 AND id=$2",[workspaceId,run.id,invalid]);
    return refused(invalid);
  }
  if(evidence.data.observations.some(source=>Date.parse(source.retrievedAt)>Date.parse(now)+1000))return refused('invalid_evidence');
  await context.db.query(`UPDATE sourcing_qualification_runs SET state=$3,reason=$4,observations=$5::jsonb,facts=$6::jsonb,
    opening_question=$7,finished_at=now() WHERE workspace_id=$1 AND id=$2`,
    [workspaceId,run.id,input.reason?'unavailable':'review',input.reason,JSON.stringify(evidence.data.observations),JSON.stringify(evidence.data.facts),input.openingQuestion??null]);
  await recordCrmAuditEvent(context,{action:'sourcing.qualification_recorded',subjectKind:'sourcing_candidate',subjectId:candidate.id,detail:{runId:run.id,state:input.reason?'unavailable':'review'}});
  return {ok:true,value:{runId:run.id}};
}
