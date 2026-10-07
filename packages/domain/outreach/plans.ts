import {matchesAutomaticEmailAuthority,type AutomaticEmailAuthority} from './automaticEmail.ts';
import {createOutreachPlanSchema,type CreateOutreachPlan,type OutreachPlan} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {loadFirmForUpdate} from '../crm/firms.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {authorizationForMailbox} from './authorization.ts';
import {buildOutreachCadence} from './cadence.ts';
import {databaseNow} from '../policy/clock.ts';
import {assessEmailCandidate} from './selection.ts';
type Result<T>={ok:true;value:T}|{ok:false;reason:string};
export async function readOutreachPlan(ctx:RepositoryContext,id:string):Promise<OutreachPlan|null>{
 return (await ctx.db.query<OutreachPlan & Record<string,unknown>>(`SELECT id,firm_id AS "firmId",contact_id AS "contactId",owner_user_id AS "ownerUserId",mailbox_id AS "mailboxId",lane,revision,state FROM outreach_plans WHERE workspace_id=$1 AND id=$2`,[ctx.scope.workspaceId,id])).rows[0]??null;
}
/** Explicit selected-cohort setup. It does not create a deal or activate sending. */
export async function createOutreachPlan(ctx:RepositoryContext,input:CreateOutreachPlan,authority?:AutomaticEmailAuthority):Promise<Result<OutreachPlan>>{
 const automatic=input.lane==='email_first'&&matchesAutomaticEmailAuthority(ctx,authority,{firmId:input.firmId,contactId:input.contactId,mailboxId:input.mailboxId,qualificationRunId:input.qualificationRunId,ownerUserId:input.expectedOwnerUserId});
 const actor=ctx.scope.actor;if(!automatic&&(actor.kind!=='user'||actor.role!=='admin'))return {ok:false,reason:'admin_required'};
 if(!createOutreachPlanSchema.safeParse(input).success)return {ok:false,reason:'invalid_input'};
 await lockSendGateForStopFact(ctx);
 const firm=await loadFirmForUpdate(ctx,input.firmId);if(!firm||firm.status!=='active')return {ok:false,reason:'firm_unavailable'};
 if(firm.assigned_user_id!==input.expectedOwnerUserId||(!automatic&&(actor.kind!=='user'||actor.userId!==input.expectedOwnerUserId)))return {ok:false,reason:'owner_changed'};
 if((await ctx.db.query("SELECT id FROM outreach_plans WHERE workspace_id=$1 AND firm_id=$2 FOR UPDATE",[ctx.scope.workspaceId,firm.id])).rows.length)return {ok:false,reason:'firm_already_enrolled'};
 const contact=(await ctx.db.query("SELECT id FROM contacts WHERE workspace_id=$1 AND id=$2 AND firm_id=$3 AND status='active' FOR UPDATE",[ctx.scope.workspaceId,input.contactId,firm.id])).rows[0];if(!contact)return {ok:false,reason:'contact_unavailable'};
 const source=(await ctx.db.query<{candidate_id:string;reviewed:boolean}>(`SELECT candidate_id,reviewed FROM outreach_email_sources WHERE workspace_id=$1 AND firm_id=$2 AND contact_id=$3 AND run_id=$4 AND NOT association_review_required`,[ctx.scope.workspaceId,firm.id,input.contactId,input.qualificationRunId])).rows[0];if(!source)return {ok:false,reason:'source_unavailable'};
 const assessment=await assessEmailCandidate(ctx,{candidateId:source.candidate_id,qualificationRunId:input.qualificationRunId});if(!assessment.ok)return assessment;
 if(assessment.value.firmId!==firm.id||(automatic?!assessment.value.verifiedFit:assessment.value.reviewRequired&&!source.reviewed))return {ok:false,reason:'source_changed'};
 if(input.lane==='call_first'&&assessment.value.lane!=='call_first')return {ok:false,reason:'call_route_unavailable'};
 const mailbox=(await ctx.db.query('SELECT id FROM mailboxes WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 AND status=\'connected\' FOR SHARE',[ctx.scope.workspaceId,input.mailboxId,input.expectedOwnerUserId])).rows[0];if(!mailbox||!(await authorizationForMailbox(ctx,input.mailboxId)).allowed)return {ok:false,reason:'mailbox_not_authorized'};
 // Human-controlled conversations are never reallocated to prospecting.
 if((await ctx.db.query("SELECT id FROM opportunities WHERE workspace_id=$1 AND firm_id=$2 AND status='open' AND control_mode='manual' LIMIT 1",[ctx.scope.workspaceId,firm.id])).rows.length)return {ok:false,reason:'human_conversation'};
 if(firm.time_zone===null)return {ok:false,reason:'time_zone_unknown'};
 const cadence=buildOutreachCadence({lane:input.lane,startsAt:await databaseNow(ctx),timeZone:firm.time_zone});
 const row=(await ctx.db.query<{id:string}>(`INSERT INTO outreach_plans(workspace_id,firm_id,contact_id,owner_user_id,mailbox_id,candidate_id,qualification_run_id,lane,cadence,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING id`,[ctx.scope.workspaceId,firm.id,input.contactId,input.expectedOwnerUserId,input.mailboxId,source.candidate_id,input.qualificationRunId,input.lane,JSON.stringify(cadence),cadence.expiresAt])).rows[0]!;
 await recordCrmAuditEvent(ctx,{action:'outreach.plan_created',subjectKind:'outreach_plan',subjectId:row.id,detail:{firmId:firm.id,contactId:input.contactId,lane:input.lane}});
 return {ok:true,value:(await readOutreachPlan(ctx,row.id))!};
}
