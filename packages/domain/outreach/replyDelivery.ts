import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {FollowUpPermissionRow,FollowUpSubject} from '../sequences/followUpPermissions.ts';
import {readReplyRequest,readRoutineSource} from './replyRequests.ts';
import {renderRoutineReply} from './content.ts';
import {readTemplateVersion,renderTemplateVersion} from '../templates/templates.ts';
import {templateVariablesFor} from '../sequences/variables.ts';
import {readSequenceVersion} from '../sequences/rows.ts';
import {enrollContact} from '../sequences/enrollments.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {databaseNow} from '../policy/clock.ts';
import {readFence,renderedHash} from '../outbound/fence.ts';
import {composeBodyForWorkspace} from '../outbound/footer.ts';
type Result<T>={ok:true;value:T}|{ok:false;reason:string};
interface Delivery {[key:string]:unknown;request_id:string;permission_id:string;sequence_version_id:string;template_version_id:string;template_hash:string;draft_hash:string;execution_id:string|null;fence_id:string|null;thread_id:string;reply_to:string;reference_ids:string[]}
async function render(ctx:RepositoryContext,requestId:string,templateId:string,sequenceId:string){
 const request=await readReplyRequest(ctx,requestId);
 if(!request||request.state!=='ready'||!request.message_id||request.decision?.kind!=='answer')return {ok:false as const,reason:'reply_not_ready'};
 const source=await readRoutineSource(ctx,{planId:request.plan_id,messageId:request.message_id});if(!source.ok)return source;
 if(source.value.hash!==request.source_hash)return {ok:false as const,reason:'source_changed'};
 const settings=(await ctx.db.query<{routine_replies_enabled:boolean;booking_url:string|null;reply_sequence_version_id:string|null}>('SELECT routine_replies_enabled,booking_url,reply_sequence_version_id FROM outreach_settings WHERE workspace_id=$1',[ctx.scope.workspaceId])).rows[0];
 if(!settings?.routine_replies_enabled)return {ok:false as const,reason:'routine_replies_disabled'};
 if(settings.reply_sequence_version_id!==sequenceId)return {ok:false as const,reason:'reply_policy_changed'};
 if(Date.parse(await databaseNow(ctx))>=Date.parse(source.value.receivedAt)+48*3600000)return {ok:false as const,reason:'reply_expired'};
 const template=await readTemplateVersion(ctx,templateId);
 if(!template||!template.approvedAt||template.retiredAt)return {ok:false as const,reason:'template_unapproved'};
 const wrapper=renderTemplateVersion(template,await templateVariablesFor(ctx,{firmId:source.value.firmId,contactId:source.value.contactId}));
 if(!wrapper.rendered)return {ok:false as const,reason:'missing_variables'};
 const opening=wrapper.body.endsWith(template.footerSignOff)?wrapper.body.slice(0,-template.footerSignOff.length).trim():wrapper.body;
 const body=renderRoutineReply({decision:request.decision,blocks:source.value.input.blocks,template:{subject:/^re:/i.test(source.value.subject)?source.value.subject:`Re: ${source.value.subject}`,opening,signOff:template.footerSignOff},bookingUrl:settings.booking_url});
 if(!body.ok)return body;
 const composed=await composeBodyForWorkspace(ctx,{body:body.value.body,signOff:template.footerSignOff});if(!composed.composed)return {ok:false as const,reason:'presentation_invalid'};
 return {ok:true as const,value:{request,source:source.value,template,subject:body.value.subject,body:composed.body,hash:renderedHash(body.value.subject,composed.body)}};
}
export async function verifyRoutinePermission(ctx:RepositoryContext,permission:FollowUpPermissionRow,subject:FollowUpSubject):Promise<string|null>{
 const d=(await ctx.db.query<Delivery>('SELECT * FROM outreach_reply_deliveries WHERE workspace_id=$1 AND permission_id=$2',[ctx.scope.workspaceId,permission.id])).rows[0];
 if(!d||permission.scope!=='routine_reply'||permission.maxSteps!==1||permission.templateVersionId!==d.template_version_id)return 'routine_permission_unbound';
 if(subject.sequenceVersionId!=null&&subject.sequenceVersionId!==d.sequence_version_id)return 'another_version';
 const current=await render(ctx,d.request_id,d.template_version_id,d.sequence_version_id);if(!current.ok)return current.reason;
 const v=current.value;
 if(permission.mailMessageId!==v.request.message_id||permission.firmId!==v.source.firmId||permission.contactId!==v.source.contactId||Date.parse(permission.expiresAt)>Date.parse(v.source.receivedAt)+48*3600000)return 'routine_scope_changed';
 if(v.source.threadId!==d.thread_id||v.source.replyTo!==d.reply_to||JSON.stringify(v.source.references)!==JSON.stringify(d.reference_ids))return 'thread_changed';
 if(v.hash!==d.draft_hash||v.template.contentHash!==d.template_hash)return 'draft_changed';
 return null;
}
export async function prepareRoutineReply(ctx:RepositoryContext,input:{requestId:string;expectedRevision:number}):Promise<Result<{executionId:string;draftHash:string}>>{
 await lockSendGateForStopFact(ctx);
 const request=await readReplyRequest(ctx,input.requestId,true);if(!request||request.revision!==input.expectedRevision)return {ok:false,reason:'stale_revision'};
 const previous=(await ctx.db.query<Delivery>('SELECT * FROM outreach_reply_deliveries WHERE workspace_id=$1 AND request_id=$2',[ctx.scope.workspaceId,request.id])).rows[0];
 if(previous?.execution_id)return {ok:true,value:{executionId:previous.execution_id,draftHash:previous.draft_hash}};
 const setting=(await ctx.db.query<{reply_sequence_version_id:string|null}>('SELECT reply_sequence_version_id FROM outreach_settings WHERE workspace_id=$1',[ctx.scope.workspaceId])).rows[0];
 const version=setting?.reply_sequence_version_id?await readSequenceVersion(ctx,setting.reply_sequence_version_id):null;
 if(!version||version.state!=='published'||version.steps.length!==1||version.steps[0]?.channel!=='email'||!version.steps[0].templateVersionId)return {ok:false,reason:'one_reply_sequence_required'};
 const current=await render(ctx,request.id,version.steps[0].templateVersionId,version.id);if(!current.ok)return current;
 const v=current.value,at=await databaseNow(ctx);
 // Savepoint guarantees a refused enrollment leaves no partial permission or released hold.
 await ctx.db.query('SAVEPOINT routine_reply_prepare');
 try{
  const permission=(await ctx.db.query<{id:string}>(`INSERT INTO follow_up_permissions(workspace_id,firm_id,contact_id,kind,scope,mail_message_id,template_version_id,max_steps,granted_at,expires_at,granted_by_rule) VALUES($1,$2,$3,'request','routine_reply',$4,$5,1,$6,$7,'outreach.routine_reply') RETURNING id`,[ctx.scope.workspaceId,v.source.firmId,v.source.contactId,request.message_id,v.template.id,at,new Date(Date.parse(v.source.receivedAt)+48*3600000).toISOString()])).rows[0]!.id;
  await ctx.db.query(`INSERT INTO outreach_reply_deliveries(workspace_id,request_id,permission_id,sequence_version_id,template_version_id,template_hash,draft_hash,thread_id,reply_to,reference_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[ctx.scope.workspaceId,request.id,permission,version.id,v.template.id,v.template.contentHash,v.hash,v.source.threadId,v.source.replyTo,[...v.source.references]]);
  const enrolled=await enrollContact(ctx,{subject:{kind:'outreach',outreachPlanId:request.plan_id},originKind:'follow_up',permissionId:permission,sequenceVersionId:version.id,firmId:v.source.firmId,contactId:v.source.contactId});
  if(!enrolled.ok){await ctx.db.query('ROLLBACK TO SAVEPOINT routine_reply_prepare');await ctx.db.query('RELEASE SAVEPOINT routine_reply_prepare');return enrolled;}
  await ctx.db.query('UPDATE outreach_reply_deliveries SET execution_id=$3 WHERE workspace_id=$1 AND request_id=$2',[ctx.scope.workspaceId,request.id,enrolled.value.firstExecutionId]);
  // Only the one source-message review hold can be resolved by this validated answer.
  await ctx.db.query(`UPDATE active_holds SET released_at=now() WHERE workspace_id=$1 AND source_event_kind='mail_message' AND source_event_id=$2 AND reason_code='uncertain_reply' AND scope_kind='firm' AND scope_key=$3 AND released_at IS NULL`,[ctx.scope.workspaceId,request.message_id,v.source.firmId]);
  await ctx.db.query('RELEASE SAVEPOINT routine_reply_prepare');
  return {ok:true,value:{executionId:enrolled.value.firstExecutionId,draftHash:v.hash}};
 }catch(error){await ctx.db.query('ROLLBACK TO SAVEPOINT routine_reply_prepare');await ctx.db.query('RELEASE SAVEPOINT routine_reply_prepare');throw error;}
}
export async function routineDraftForExecution(ctx:RepositoryContext,executionId:string):Promise<Result<{subject:string;body:string;draftHash:string}>|null>{
 const d=(await ctx.db.query<Delivery>('SELECT * FROM outreach_reply_deliveries WHERE workspace_id=$1 AND execution_id=$2',[ctx.scope.workspaceId,executionId])).rows[0];if(!d)return null;
 const value=await render(ctx,d.request_id,d.template_version_id,d.sequence_version_id);if(!value.ok)return value;
 if(value.value.hash!==d.draft_hash||value.value.template.contentHash!==d.template_hash)return {ok:false,reason:'draft_changed'};
 return {ok:true,value:{subject:value.value.subject,body:value.value.body,draftHash:d.draft_hash}};
}
export async function attachRoutineFence(ctx:RepositoryContext,input:{executionId:string;fenceId:string}):Promise<void>{
 await ctx.db.query(`UPDATE outreach_reply_deliveries d SET fence_id=$3 FROM outbound_messages f WHERE d.workspace_id=$1 AND d.execution_id=$2 AND f.workspace_id=d.workspace_id AND f.id=$3 AND f.step_execution_id=d.execution_id AND f.rendered_hash=d.draft_hash AND (d.fence_id IS NULL OR d.fence_id=$3)`,[ctx.scope.workspaceId,input.executionId,input.fenceId]);
}
export async function verifyRoutineReplyFence(ctx:RepositoryContext,input:{fenceId:string;at:string}):Promise<Result<{requestId:string|null}>>{
 const f=await readFence(ctx,input.fenceId);if(!f?.stepExecutionId)return {ok:true,value:{requestId:null}};
 const d=(await ctx.db.query<Delivery>('SELECT * FROM outreach_reply_deliveries WHERE workspace_id=$1 AND execution_id=$2',[ctx.scope.workspaceId,f.stepExecutionId])).rows[0];if(!d)return {ok:true,value:{requestId:null}};
 if(d.fence_id!==f.id||f.renderedHash!==d.draft_hash||renderedHash(f.subject,f.body)!==d.draft_hash||f.templateVersionId!==d.template_version_id)return {ok:false,reason:'draft_changed'};
 const rendered=await routineDraftForExecution(ctx,f.stepExecutionId);if(!rendered?.ok)return {ok:false,reason:rendered?.reason??'draft_missing'};
 return {ok:true,value:{requestId:d.request_id}};
}

export async function routineReplyThreading(ctx:RepositoryContext,fenceId:string):Promise<{threadId:string;inReplyTo:string;references:readonly string[]}|null>{
 const d=(await ctx.db.query<Delivery>('SELECT * FROM outreach_reply_deliveries WHERE workspace_id=$1 AND fence_id=$2',[ctx.scope.workspaceId,fenceId])).rows[0];
 return d?{threadId:d.thread_id,inReplyTo:d.reply_to,references:d.reference_ids}:null;
}
export async function recordRoutineDelivery(ctx:RepositoryContext,fenceId:string):Promise<void>{
 await ctx.db.query(`UPDATE outreach_reply_requests r SET state='delivered',revision=revision+1,updated_at=now() FROM outreach_reply_deliveries d JOIN outbound_messages f ON f.workspace_id=d.workspace_id AND f.id=d.fence_id WHERE d.workspace_id=$1 AND d.fence_id=$2 AND f.state='sent' AND r.workspace_id=d.workspace_id AND r.id=d.request_id AND r.state='ready'`,[ctx.scope.workspaceId,fenceId]);
}
