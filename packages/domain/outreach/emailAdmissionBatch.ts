import type {EmailAdmissionRuntime} from './emailActivation.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {withTransaction,type SessionQueryable} from '../db/queryable.ts';
import {admitAutomaticEmailCandidate} from './automaticEmail.ts';
import {automaticEmailConfiguration} from './emailControl.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {databaseNow} from '../policy/clock.ts';
import {candidateIdentity} from '../sourcing/qualificationDecision.ts';
import {QUALIFICATION_PROMPT_VERSION,QUALIFICATION_POLICY_VERSION,type QualificationRunRow} from '../sourcing/qualificationStore.ts';
import {qualifyEmailCandidate} from './selection.ts';
import {rankQualifiedLeads,type RankedQualifiedLead} from '../sourcing/qualificationPolicy.ts';
import type {CandidateInput} from '@fss/contracts';
export interface AdmissionBatch {checked:number;deferred:{candidateId:string;reason:string;retryAt:string|null}[];admitted:{candidateId:string;enrollmentId:string}[];reason:string|null}
/** One bounded, database-only worker unit. Overflow refuses the entire pool so a
 * database page cannot put a weaker lead ahead of an unseen stronger lead. */
export async function runAutomaticEmailBatch(ctx:RepositoryContext,controlRevision:number,runtime?:EmailAdmissionRuntime):Promise<AdmissionBatch>{
 return withTransaction(ctx.db,async()=>{
  await lockSendGateForStopFact(ctx);
  const config=await automaticEmailConfiguration(ctx,controlRevision,runtime);
  const report:AdmissionBatch={checked:0,deferred:[],admitted:[],reason:null};
  if(!config.ok)return await finish({...report,reason:config.reason});
  const binding=config.value;
  const now=await databaseNow(ctx);
  const rows=(await ctx.db.query<QualificationRunRow&{payload:CandidateInput;email_admission_attempts:number;email_admission_control_revision:number|null}>(`SELECT r.*,c.payload FROM sourcing_candidates c
   ${latestQualificationJoin}
   WHERE c.workspace_id=$1 AND ${candidatePoolPredicate('$4','$5')}
   ORDER BY r.id LIMIT 501`,[ctx.scope.workspaceId,QUALIFICATION_PROMPT_VERSION,QUALIFICATION_POLICY_VERSION,controlRevision,now])).rows;
  if(rows.length>500)return await finish({...report,reason:'candidate_pool_limit'});
  const ranked:{row:typeof rows[number];lead:RankedQualifiedLead}[]=[];
  for(const row of rows){
   const verdict=qualifyEmailCandidate({identity:candidateIdentity(row.payload,row.facts,row.observations),facts:row.facts,observations:row.observations,now});
   if(verdict.decision!=='eligible'||!verdict.route){await recordDisposition(row,verdict.unknowns[0]??'business_email_unresolved',false);continue;}
   const supporting=row.observations.filter(o=>row.facts.some(f=>f.observationId===o.id));
   ranked.push({row,lead:{id:row.candidate_id,firmName:row.payload.firmName,rank:verdict.rank,corroboratingSources:new Set(supporting.map(o=>o.url)).size,observedAt:supporting.map(o=>o.retrievedAt).sort().at(-1)??now,namedContact:verdict.route.identityKind==='named'}});
  }
  ranked.sort((a,b)=>rankQualifiedLeads(a.lead,b.lead));
  for(const {row,lead} of ranked.slice(0,25)){
   const result=await admitAutomaticEmailCandidate(ctx,{candidateId:row.candidate_id,qualificationRunId:row.id,expectedRevision:row.candidate_revision,expectedControlRevision:controlRevision},runtime);
   if(result.ok){report.admitted.push({candidateId:row.candidate_id,enrollmentId:result.value.enrollmentId});await recordDisposition(row,'enrolled',false,lead.rank);}
   else {const temporary=['mailbox_capacity_exhausted','sender_unhealthy','prospect_held'].includes(result.reason);await recordDisposition(row,result.reason,temporary,lead.rank);
    if(['mailbox_capacity_exhausted','sender_unhealthy'].includes(result.reason)){report.reason=result.reason;break;}
   }
  }
  return await finish(report);
  async function finish(value:AdmissionBatch){await recordCrmAuditEvent(ctx,{action:'outreach.email_admission_batch',subjectKind:'workspace',subjectId:ctx.scope.workspaceId,detail:{controlRevision,checked:value.checked,admitted:value.admitted.length,reason:value.reason}});return value;}

  async function recordDisposition(row:typeof rows[number],reason:string,temporary:boolean,rank:string|null=null){
   const attempts=(row.email_admission_control_revision===controlRevision?row.email_admission_attempts:0)+1;
   const retry=temporary&&attempts<7;
   const wake=(await ctx.db.query<{email_admission_next_at:Date|null}>(`UPDATE sourcing_qualification_runs SET email_admission_control_revision=$3,email_admission_attempts=$4,email_admission_reason=$5,
    email_admission_next_at=CASE WHEN NOT $6 THEN NULL WHEN $5='mailbox_capacity_exhausted' THEN
     (((($7::timestamptz AT TIME ZONE (SELECT business_time_zone FROM workspaces WHERE id=$1))::date+1)::timestamp+interval '5 minutes') AT TIME ZONE (SELECT business_time_zone FROM workspaces WHERE id=$1))
     ELSE $7::timestamptz+interval '1 hour' END WHERE workspace_id=$1 AND id=$2 RETURNING email_admission_next_at`,[ctx.scope.workspaceId,row.id,controlRevision,attempts,reason,retry,now])).rows[0];
   await recordCrmAuditEvent(ctx,{action:'outreach.email_admission_decided',subjectKind:'sourcing_candidate',subjectId:row.candidate_id,detail:{...binding,candidateId:row.candidate_id,runId:row.id,candidateRevision:row.candidate_revision,controlRevision,reason,checks:attempts,rank,status:reason==='enrolled'?'enrolled':temporary?(retry?'held':'exhausted'):'deferred',retryAt:wake?.email_admission_next_at?.toISOString()??null}});
   report.checked++;
   if(reason!=='enrolled')report.deferred.push({candidateId:row.candidate_id,reason:temporary&&!retry?'rechecks_exhausted':reason,retryAt:wake?.email_admission_next_at?.toISOString()??null});
  }
 });
}

/** Shared current-evidence/recheck policy. Its SQL names are fixed by this module. */
function candidatePoolPredicate(revision:'$4'|'s.revision',now:'$5'|'$1'){
 return `c.status<>'dismissed' AND NOT c.qualification_blocked AND c.revision=r.candidate_revision
   AND r.state IN ('eligible','review') AND r.reason IS NULL AND r.prompt_version=$2 AND r.policy_version=$3
   AND (r.email_admission_control_revision IS DISTINCT FROM ${revision} OR (r.email_admission_next_at<=${now}::timestamptz AND r.email_admission_attempts<7))`;
}
const latestQualificationJoin=`JOIN LATERAL (SELECT * FROM sourcing_qualification_runs q WHERE q.workspace_id=c.workspace_id AND q.candidate_id=c.id ORDER BY q.requested_at DESC,q.id DESC LIMIT 1) r ON true`;

/** Discover due work under the scheduler's existing transaction and settings lock.
 * This does not enqueue jobs or advance the scheduler's last-at marker. */
export async function findAutomaticEmailWorkspaces(session:SessionQueryable,now:string){
 return (await session.query<{workspace_id:string;revision:number}>(`SELECT s.workspace_id,s.revision FROM outreach_email_admission_settings s
   WHERE s.enabled AND (s.batch_last_at IS NULL OR s.batch_last_at<=$1::timestamptz-interval '1 hour')
   AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.workspace_id=s.workspace_id AND j.kind='outreach.email_admit' AND j.state IN ('queued','running','retryable'))
   AND EXISTS(SELECT 1 FROM sourcing_candidates c ${latestQualificationJoin}
    WHERE c.workspace_id=s.workspace_id AND ${candidatePoolPredicate('s.revision','$1')})
   ORDER BY s.batch_last_at NULLS FIRST,s.workspace_id LIMIT 25 FOR UPDATE OF s`,[now,QUALIFICATION_PROMPT_VERSION,QUALIFICATION_POLICY_VERSION])).rows;
}

