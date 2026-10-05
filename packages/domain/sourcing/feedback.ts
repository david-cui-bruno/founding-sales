import {sourcingFeedbackSchema} from '@fss/contracts';
import type {z} from 'zod';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {decideAdminOnly} from '../crm/authorization.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import type {SourcingResult} from './qualificationStore.ts';
/** Caller transaction. Feedback never changes a deal, suppression or call obligation. */
export async function recordSourcingFeedback(ctx:RepositoryContext,input:z.infer<typeof sourcingFeedbackSchema>):Promise<SourcingResult<{id:string}>> {
 if(!decideAdminOnly(ctx).permitted||ctx.scope.actor.kind!=='user')return {ok:false,reason:'admin_only'};
 const parsed=sourcingFeedbackSchema.safeParse(input);if(!parsed.success)return {ok:false,reason:'invalid_input'};
 const w=ctx.scope.workspaceId;
 // Admission holds this gate before candidate locks, so a correction cannot lose a race.
 await lockSendGateForStopFact(ctx);
 const candidate=(await ctx.db.query('SELECT id FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,input.candidateId])).rows[0];
 if(!candidate)return {ok:false,reason:'candidate_not_found'};
 const run=(await ctx.db.query('SELECT id FROM sourcing_qualification_runs WHERE workspace_id=$1 AND candidate_id=$2 AND id=$3 FOR UPDATE',[w,input.candidateId,input.qualificationRunId])).rows[0];
 if(!run)return {ok:false,reason:'qualification_not_found'};
 const row=(await ctx.db.query<{id:string}>('INSERT INTO sourcing_feedback(workspace_id,candidate_id,run_id,code,note) VALUES($1,$2,$3,$4,$5) RETURNING id',[w,input.candidateId,input.qualificationRunId,input.code,input.note??null])).rows[0]!;
 if(input.code==='wrong_firm'){
  await ctx.db.query('UPDATE sourcing_candidates SET qualification_blocked=true WHERE workspace_id=$1 AND id=$2',[w,input.candidateId]);
  await ctx.db.query("UPDATE sourcing_qualification_runs SET state='unavailable',reason='wrong_firm',verdict=NULL,opening_question=NULL WHERE workspace_id=$1 AND candidate_id=$2",[w,input.candidateId]);
  await ctx.db.query('UPDATE sourcing_admissions SET association_review_required=true WHERE workspace_id=$1 AND candidate_id=$2',[w,input.candidateId]);
 }
 await recordCrmAuditEvent(ctx,{action:'sourcing.feedback_recorded',subjectKind:'sourcing_candidate',subjectId:input.candidateId,detail:{feedbackId:row.id,runId:input.qualificationRunId,code:input.code}});
 return {ok:true,value:{id:row.id}};
}
