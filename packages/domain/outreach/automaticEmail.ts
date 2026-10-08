import {readRampStanding,readSendDayHealth,rampHealthFailure} from '../outbound/ramp.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {automaticEmailConfiguration} from './emailControl.ts';
import {admitEmailCandidate} from './emailAdmission.ts';
import {createOutreachPlan} from './plans.ts';
import {enrollContact} from '../sequences/enrollments.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
export interface AutomaticEmailInput {candidateId:string;qualificationRunId:string;expectedRevision:number;expectedControlRevision:number}
declare const capabilityBrand:unique symbol;
export interface AutomaticEmailAuthority {readonly [capabilityBrand]:true}
type Binding={candidateId:string;qualificationRunId:string;expectedRevision:number;ownerUserId:string;mailboxId:string;sequenceVersionId:string;firmId?:string;contactId?:string};
const authorities=new WeakMap<AutomaticEmailAuthority,{ctx:RepositoryContext;binding:Binding}>();
/** No serializable flag can confer authority. Tokens are issued only below,
 * bound to this context/input, and invalidated before the transaction returns. */
export function matchesAutomaticEmailAuthority(ctx:RepositoryContext,token:AutomaticEmailAuthority|undefined,input:Partial<Binding>):boolean{
 if(!token)return false;
 const entry=authorities.get(token);
 return entry?.ctx===ctx&&Object.entries(input).every(([key,value])=>entry.binding[key as keyof Binding]===value);
}
type Result={ok:true;value:{firmId:string;contactId:string;routeId:string;planId:string;enrollmentId:string}}|{ok:false;reason:string};
/** Caller transaction. One admission, including its normal enrollment, is atomic. */
export async function admitAutomaticEmailCandidate(ctx:RepositoryContext,input:AutomaticEmailInput):Promise<Result>{
 const result=await admit(ctx,input);
 if(!result.ok&&ctx.scope.actor.kind==='system'&&ctx.scope.actor.component==='worker')await recordCrmAuditEvent(ctx,{action:'outreach.email_automatic_refused',subjectKind:'workspace',subjectId:ctx.scope.workspaceId,detail:{candidateId:input.candidateId,runId:input.qualificationRunId,candidateRevision:input.expectedRevision,controlRevision:input.expectedControlRevision,reason:result.reason,authority:'automatic_email'}});
 return result;
}
async function admit(ctx:RepositoryContext,input:AutomaticEmailInput):Promise<Result>{
 await lockSendGateForStopFact(ctx);
 const config=await automaticEmailConfiguration(ctx,input.expectedControlRevision);if(!config.ok)return config;
 const health=await readSendDayHealth(ctx,config.value.mailboxId);
 if(!health?.authenticationPasses||!health.coverageHealthy||health.providerWarning)return {ok:false,reason:'sender_unhealthy'};
 const ramp=await readRampStanding(ctx,config.value.mailboxId);
 if(!ramp||ramp.effectiveCap<=0)return {ok:false,reason:'mailbox_capacity_exhausted'};
 // Conservative backlog bound: queued first touches count even when their
 // morning slot is tomorrow. Due follow-ups and claimed sends take priority.
 const load=(await ctx.db.query<{used:number;queued:number;provider_errors:number;bounces:number;opt_outs:number}>(`WITH day AS (
 SELECT (clock_timestamp() AT TIME ZONE business_time_zone)::date AS date FROM workspaces WHERE id=$1)
 SELECT COALESCE((SELECT automated_sent FROM mailbox_send_days d,day WHERE d.workspace_id=$1 AND d.mailbox_id=$2 AND d.business_date=day.date),0) AS used,
 COALESCE((SELECT provider_errors FROM mailbox_send_days d,day WHERE d.workspace_id=$1 AND d.mailbox_id=$2 AND d.business_date=day.date),0) AS provider_errors,
 COALESCE((SELECT bounces FROM mailbox_send_days d,day WHERE d.workspace_id=$1 AND d.mailbox_id=$2 AND d.business_date=day.date),0) AS bounces,
 COALESCE((SELECT opt_outs FROM mailbox_send_days d,day WHERE d.workspace_id=$1 AND d.mailbox_id=$2 AND d.business_date=day.date),0) AS opt_outs,
 (SELECT count(*)::int FROM step_executions s JOIN sequence_enrollments e ON e.workspace_id=s.workspace_id AND e.id=s.enrollment_id
 LEFT JOIN outreach_plans p ON p.workspace_id=e.workspace_id AND p.id=e.outreach_plan_id,day
 WHERE s.workspace_id=$1 AND e.assigned_user_id=$3 AND (p.id IS NULL OR p.mailbox_id=$2) AND e.ended_at IS NULL
 AND s.channel='email' AND s.state IN ('pending','held','dispatched')
 AND (s.ordinal=1 OR (s.due_at AT TIME ZONE (SELECT business_time_zone FROM workspaces WHERE id=$1))::date<=day.date)
 AND NOT EXISTS(SELECT 1 FROM outbound_messages f WHERE f.workspace_id=s.workspace_id AND f.step_execution_id=s.id AND f.attempt_token IS NOT NULL AND f.business_date=day.date)) AS queued`,[ctx.scope.workspaceId,config.value.mailboxId,config.value.ownerUserId])).rows[0]!;
 const failure=rampHealthFailure({...health,automatedSent:load.used,providerErrors:load.provider_errors,bounces:load.bounces,optOuts:load.opt_outs});
 if(failure&&failure!=='no_sends')return {ok:false,reason:'sender_unhealthy'};
 if(load.used+load.queued>=ramp.effectiveCap)return {ok:false,reason:'mailbox_capacity_exhausted'};
 await ctx.db.query('SAVEPOINT automatic_email_prospect');
 const token=Object.freeze({}) as AutomaticEmailAuthority;
 const binding:Binding={...input,...config.value};
 authorities.set(token,{ctx,binding});
 try{
  const admission=await admitEmailCandidate(ctx,{...input,expectedOwnerUserId:binding.ownerUserId,reviewed:false},token);
  if(!admission.ok)return await rollback(admission);
  Object.assign(binding,{firmId:admission.value.firmId,contactId:admission.value.contactId});
  const plan=await createOutreachPlan(ctx,{firmId:admission.value.firmId,contactId:admission.value.contactId,mailboxId:binding.mailboxId,lane:'email_first',qualificationRunId:input.qualificationRunId,expectedOwnerUserId:binding.ownerUserId},token);
  if(!plan.ok)return await rollback(plan);
  const enrollment=await enrollContact(ctx,{originKind:'prospecting',sequenceVersionId:binding.sequenceVersionId,subject:{kind:'outreach',outreachPlanId:plan.value.id},firmId:admission.value.firmId,contactId:admission.value.contactId});
  if(!enrollment.ok)return await rollback(enrollment);
  await recordCrmAuditEvent(ctx,{action:'outreach.email_automatically_enrolled',subjectKind:'outreach_plan',subjectId:plan.value.id,detail:{...config.value,firmId:admission.value.firmId,contactId:admission.value.contactId,routeId:admission.value.routeId,planId:plan.value.id,candidateId:input.candidateId,runId:input.qualificationRunId,candidateRevision:input.expectedRevision,controlRevision:config.value.revision,evaluationSha256:config.value.evaluationSha256,mailboxId:binding.mailboxId,sequenceVersionId:binding.sequenceVersionId,enrollmentId:enrollment.value.enrollmentId,policyVersion:'outreach-email-fit-v1',authority:'automatic_email',reviewed:false}});
  await ctx.db.query('RELEASE SAVEPOINT automatic_email_prospect');
  return {ok:true,value:{firmId:admission.value.firmId,contactId:admission.value.contactId,routeId:admission.value.routeId,planId:plan.value.id,enrollmentId:enrollment.value.enrollmentId}};
 }catch(error){await ctx.db.query('ROLLBACK TO SAVEPOINT automatic_email_prospect');await ctx.db.query('RELEASE SAVEPOINT automatic_email_prospect');throw error;}
 finally{authorities.delete(token);}
 async function rollback(result:{ok:false;reason:string}){await ctx.db.query('ROLLBACK TO SAVEPOINT automatic_email_prospect');await ctx.db.query('RELEASE SAVEPOINT automatic_email_prospect');return result;}
}
