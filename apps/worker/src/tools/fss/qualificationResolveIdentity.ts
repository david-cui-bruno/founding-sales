import {z} from 'zod';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {recordCrmAuditEvent} from '@fss/domain/crm/audit.ts';
import {lockSendGateForStopFact} from '@fss/domain/policy/sendGate.ts';
import type {AdminInvocation,AdminOutcome} from './admin.ts';
const optionsSchema=z.object({'--workspace-id':z.uuid(),'--candidate-id':z.uuid(),'--expected-revision':z.coerce.number().int().positive(),'--confirmed-identity':z.literal('true'),'--reason':z.string().trim().min(10).max(500)});
/** Explicit human identity review invalidates every old run and association before rechecking.
 * CRM calls, stops, deals and tasks are never removed or reassigned. */
export async function qualificationResolveIdentityCommand(input:Pick<AdminInvocation,'session'|'options'|'launch'>):Promise<AdminOutcome>{
 const parsed=optionsSchema.safeParse(input.options);
 if(!parsed.success)return {ok:false,reason:'invalid_options',detail:'Supply the displayed revision, explicit identity confirmation and a review reason.'};
 const launch=input.launch;
 if(!launch?.launchedBy?.startsWith('arn:aws:')||!launch.taskArn?.startsWith('arn:aws:ecs:'))return {ok:false,reason:'launcher_unknown',detail:'Run through the audited ECS operations task.'};
 const o=parsed.data,w=o['--workspace-id'],id=o['--candidate-id'],db=input.session;
 return await withTransaction(db,async()=>{
  const ctx=repositoryContext(workspaceScope(w,{kind:'system',component:'worker'}),db);await lockSendGateForStopFact(ctx);
  const row=(await db.query<{revision:number;qualification_blocked:boolean}>('SELECT revision,qualification_blocked FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,id])).rows[0];
  if(!row)return {ok:false,reason:'not_found',detail:'Candidate not found in this workspace.'};
  if(row.revision!==o['--expected-revision'])return {ok:false,reason:'candidate_changed',detail:'Read the current candidate before resolving its identity.'};
  if(!row.qualification_blocked)return {ok:false,reason:'not_blocked',detail:'No unresolved wrong-firm correction exists.'};
  const associations=(await db.query<{firm_id:string;route_id:string}>('DELETE FROM sourcing_admissions WHERE workspace_id=$1 AND candidate_id=$2 RETURNING firm_id,route_id',[w,id])).rows;
  await db.query("UPDATE sourcing_qualification_runs SET state='unavailable',reason='identity_recheck_required',verdict=NULL,opening_question=NULL WHERE workspace_id=$1 AND candidate_id=$2",[w,id]);
  await db.query("UPDATE sourcing_candidates SET revision=revision+1,qualification_blocked=false,status='needs_review',updated_at=now() WHERE workspace_id=$1 AND id=$2",[w,id]);
  await recordCrmAuditEvent(ctx,{action:'sourcing.identity_reviewed',subjectKind:'sourcing_candidate',subjectId:id,detail:{previousRevision:row.revision,reason:o['--reason'],detachedAssociations:associations,launchedBy:launch.launchedBy,taskArn:launch.taskArn}});
  return {ok:true,value:{candidateId:id,revision:row.revision+1,researchRequired:true}};
 });
}
