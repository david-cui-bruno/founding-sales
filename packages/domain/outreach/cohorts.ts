import {createHash} from 'node:crypto';
import {outreachCohortInputSchema,outreachCohortEnableSchema,type OutreachCohortInput,type OutreachCohortPreview} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {readOutreachControl,campaignKind} from './settings.ts';
import {assessEmailCandidate} from './selection.ts';
import {admitEmailCandidate} from './emailAdmission.ts';
import {admitCandidate} from '../sourcing/admission.ts';
import {createOutreachPlan} from './plans.ts';
import {enrollContact} from '../sequences/enrollments.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
type Result<T>={ok:true;value:T}|{ok:false;reason:string};
export async function previewOutreachCohort(ctx:RepositoryContext,input:OutreachCohortInput):Promise<Result<OutreachCohortPreview>>{
 const actor=ctx.scope.actor;if(actor.kind!=='user'||actor.role!=='admin')return {ok:false,reason:'admin_required'};
 if(!outreachCohortInputSchema.safeParse(input).success)return {ok:false,reason:'invalid_input'};
 const control=await readOutreachControl(ctx),sender=control.senders.find(s=>s.id===input.mailboxId);
 if(!sender||sender.ownerUserId!==actor.userId||!sender.connected)return {ok:false,reason:'mailbox_not_authorized'};
 const rows:OutreachCohortPreview['rows']=[];
 for(const id of input.candidateIds){
  const c=control.candidates.find(c=>c.id===id);if(!c)return {ok:false,reason:'candidate_changed'};
  const a=await assessEmailCandidate(ctx,{candidateId:id,qualificationRunId:c.qualificationRunId});
  let reason=a.ok?null:a.reason;
  if(a.ok){
   const version=a.value.lane==='email_first'?input.emailSequenceVersionId:input.callSequenceVersionId;
   if(!version||await campaignKind(ctx,version)!==a.value.lane)reason='campaign_sequence_required';
   if(a.value.firmId&&(await ctx.db.query('SELECT id FROM outreach_plans WHERE workspace_id=$1 AND firm_id=$2',[ctx.scope.workspaceId,a.value.firmId])).rows.length)reason='firm_already_enrolled';
  }
  rows.push({candidateId:id,name:c.name,revision:c.revision,qualificationRunId:c.qualificationRunId,address:a.ok?a.value.route.address:null,lane:a.ok?a.value.lane:null,reviewRequired:a.ok?a.value.reviewRequired:true,reason});
 }
 const hash=createHash('sha256').update(JSON.stringify({input,sender,rows})).digest('hex');
 return {ok:true,value:{hash,rows}};
}
/** Explicit selected cohort only. Existing cold rows and every sending switch stay untouched. */
export async function enableOutreachCohort(ctx:RepositoryContext,input:unknown):Promise<Result<{enrollmentIds:string[]}>>{
 const parsed=outreachCohortEnableSchema.safeParse(input);if(!parsed.success)return {ok:false,reason:'invalid_input'};
 const {expectedHash,reviewed,...selection}=parsed.data;
 const actor=ctx.scope.actor;if(actor.kind!=='user'||actor.role!=='admin')return {ok:false,reason:'admin_required'};
 await lockSendGateForStopFact(ctx);
 const control=await readOutreachControl(ctx);
 const sender=control.senders.find(s=>s.id===selection.mailboxId);
 if(!sender?.authorized)return {ok:false,reason:'mailbox_not_authorized'};
 const preview=await previewOutreachCohort(ctx,selection);if(!preview.ok)return preview;
 if(preview.value.hash!==expectedHash)return {ok:false,reason:'preview_changed'};
 if(preview.value.rows.some(r=>r.reason!==null))return {ok:false,reason:'cohort_requires_review'};
 if(!reviewed&&preview.value.rows.some(r=>r.reviewRequired))return {ok:false,reason:'qualification_requires_review'};

 await ctx.db.query('SAVEPOINT outreach_cohort');
 const decline=async(reason:string):Promise<Result<{enrollmentIds:string[]}>>=>{await ctx.db.query('ROLLBACK TO SAVEPOINT outreach_cohort');await ctx.db.query('RELEASE SAVEPOINT outreach_cohort');return {ok:false,reason};};
 try{
  const enrollmentIds:string[]=[];
  for(const r of preview.value.rows){
   const admissionInput={candidateId:r.candidateId,qualificationRunId:r.qualificationRunId,expectedRevision:r.revision};
   if(r.lane==='call_first'){const phone=await admitCandidate(ctx,{...admissionInput,mode:'reviewed'});if(!phone.ok)return await decline(phone.reason);}
   const admitted=await admitEmailCandidate(ctx,{...admissionInput,expectedOwnerUserId:actor.userId,reviewed});if(!admitted.ok)return await decline(admitted.reason);
   const plan=await createOutreachPlan(ctx,{firmId:admitted.value.firmId,contactId:admitted.value.contactId,expectedOwnerUserId:actor.userId,mailboxId:selection.mailboxId,lane:r.lane!,qualificationRunId:r.qualificationRunId});if(!plan.ok)return await decline(plan.reason);
   const sequenceVersionId=r.lane==='call_first'?selection.callSequenceVersionId:selection.emailSequenceVersionId;
   const enrolled=await enrollContact(ctx,{subject:{kind:'outreach',outreachPlanId:plan.value.id},originKind:'prospecting',sequenceVersionId:sequenceVersionId!,firmId:admitted.value.firmId,contactId:admitted.value.contactId});if(!enrolled.ok)return await decline(enrolled.reason);
   enrollmentIds.push(enrolled.value.enrollmentId);
  }
  await recordCrmAuditEvent(ctx,{action:'outreach.cohort_enabled',subjectKind:'workspace',subjectId:ctx.scope.workspaceId,detail:{previewHash:expectedHash,enrollmentIds,mailboxId:selection.mailboxId}});
  await ctx.db.query('RELEASE SAVEPOINT outreach_cohort');return {ok:true,value:{enrollmentIds}};
 }catch(error){await ctx.db.query('ROLLBACK TO SAVEPOINT outreach_cohort');await ctx.db.query('RELEASE SAVEPOINT outreach_cohort');throw error;}
}
