import {callingWrapCommandSchema,callingWrapResultSchema,type CallingWrapCommand,type CallingWrapResult,type CallingFollowUpSource} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {SuppressionJournal} from '../suppression/journal.ts';
import {logCallOutcome} from '../dial/calls.ts';
import {callOutcomeEffects,REACHED_OUTCOMES} from '../dial/outcomes.ts';
import {saveManualProspectActivity} from '../sourcing/manualProspectActivity.ts';
import {createCallingDraft} from './followUpDrafts.ts';
import {currentCallingSource,requireCallingAuthority,type CallingAuthority} from './followUpDraftAccess.ts';
export type CallingWrapDecision={ok:true;value:CallingWrapResult}|{ok:false;reason:string};
/** Existing stopped state under the log owner's exclusive gate, never setManual as a proxy. */
export async function callingStopConfirmed(ctx:RepositoryContext,firmId:string):Promise<boolean>{
 const rows=await ctx.db.query(`SELECT 1 FROM sequence_enrollments WHERE workspace_id=$1 AND firm_id=$2 AND ended_at IS NULL
 UNION ALL SELECT 1 FROM outreach_plans WHERE workspace_id=$1 AND firm_id=$2 AND state='active'
 UNION ALL SELECT 1 FROM step_executions s JOIN sequence_enrollments e ON e.workspace_id=s.workspace_id AND e.id=s.enrollment_id
 WHERE e.workspace_id=$1 AND e.firm_id=$2 AND s.state IN ('pending','held') LIMIT 1`,[ctx.scope.workspaceId,firmId]);
 return rows.rows.length===0;
}
async function promisedDraft(ctx:RepositoryContext,input:CallingWrapCommand,source:CallingFollowUpSource,authority:CallingAuthority):Promise<CallingWrapResult['followUp']>{
 if(!input.promisedEmail)return {state:'not_requested'};
 await ctx.db.query('SAVEPOINT calling_private_draft');
 const {draftId,subject,body}=input.promisedEmail;
 // Only explicit edited content crosses this boundary, never report.note.
 const saved=await createCallingDraft(ctx,draftId,source,{subject,body},authority);
 if(!saved.ok)await ctx.db.query('ROLLBACK TO SAVEPOINT calling_private_draft');
 await ctx.db.query('RELEASE SAVEPOINT calling_private_draft');
 return saved.ok?{state:'queued_for_review',...saved.value}:{state:'not_queued',reason:saved.reason};
}
/** Caller owns one command transaction, one receipt and final beforeCommit authority check. */
export async function wrapCalling(ctx:RepositoryContext,raw:CallingWrapCommand,authority:CallingAuthority,journal:SuppressionJournal):Promise<CallingWrapDecision>{
 const parsed=callingWrapCommandSchema.safeParse(raw);if(!parsed.success)return {ok:false,reason:'invalid_input'};
 const input=parsed.data;
 // Initial actor check does not acquire row locks before canonical log's send gate.
 if(ctx.scope.actor.kind!=='user')return {ok:false,reason:'invalid_input'};
 if(input.kind==='candidate'){
  const saved=await saveManualProspectActivity(ctx,{operation:'create',candidateId:input.candidateId,expectedCandidateRevision:input.expectedCandidateRevision,attemptId:input.attemptId,...input.report},authority);
  if(!saved.ok)return saved;
  const source:CallingFollowUpSource={kind:'candidate',candidateId:input.candidateId,candidateRevision:input.expectedCandidateRevision,attemptId:input.attemptId};
  const followUp=await promisedDraft(ctx,input,source,authority);
  await currentCallingSource(ctx,source,authority);
  return {ok:true,value:callingWrapResultSchema.parse({kind:'candidate',activity:saved.value,staleIntroductions:'not_applicable',followUp})};
 }
 const {performedByUser:_attestation,...report}=input.report;
 const logged=await logCallOutcome(ctx,{firmId:input.firmId,...report,...(input.itemId?{itemId:input.itemId}:{}),...(input.opportunityId?{opportunityId:input.opportunityId}:{}),commandId:input.commandId,journal});
 if(!logged.ok)return logged;
 const source:CallingFollowUpSource={kind:'firm',firmId:input.firmId,callLogId:logged.value.callLogId};
 const failed=logged.value.followUps.some(item=>item.kind==='effects_not_applied');
 const engaged=callOutcomeEffects(input.report.outcome).setsManual;
 const stopped=engaged&&!failed&&await callingStopConfirmed(ctx,input.firmId);
 const followUp:CallingWrapResult['followUp']=!input.promisedEmail?{state:'not_requested'}:failed||!stopped?{state:'not_queued',reason:'effects_not_applied'}:
  REACHED_OUTCOMES.has(input.report.outcome)?await promisedDraft(ctx,input,source,authority):{state:'not_queued',reason:'draft_unavailable'};
 await currentCallingSource(ctx,source,authority);
 const attention=logged.value.followUps.flatMap(item=>item.kind==='effects_not_applied'||item.kind==='callback_time_needed'||item.kind==='route_not_named'?[item.kind]:[]);
 await requireCallingAuthority(ctx,authority);
 return {ok:true,value:callingWrapResultSchema.parse({kind:'firm',firmId:input.firmId,callLogId:logged.value.callLogId,staleIntroductions:engaged?(stopped?'stopped':'not_confirmed'):'not_applicable',attention:[...new Set(attention)],followUp})};
}
/** Same source is revalidated after receipt uniqueness waits by the route beforeCommit hook. */
export function callingWrapSource(result:CallingWrapResult):CallingFollowUpSource{
 return result.kind==='candidate'?{kind:'candidate',candidateId:result.activity.candidateId,candidateRevision:result.activity.candidateRevision,attemptId:result.activity.attemptId}:{kind:'firm',firmId:result.firmId,callLogId:result.callLogId};
}
