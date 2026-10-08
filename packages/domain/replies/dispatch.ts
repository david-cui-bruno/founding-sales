import {createHash} from 'node:crypto';
import {humanReplyPreviewInputSchema,humanReplySendInputSchema,type HumanReplyPreviewInput,type HumanReplyPreview,type HumanReplySendInput,type HumanReplySendStatus,type ReplyComposerResult} from '../../contracts/src/replyComposer.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {readReplyDraftContext} from './composer.ts';
import {composeBodyForWorkspace} from '../outbound/footer.ts';
import {readFirm} from '../crm/firms.ts';
import {decideFirmRead} from '../crm/authorization.ts';
import {prepareHumanReplyFence,readFence,readFenceByDraftId,lockFenceForClaim,rewritePreparedBody,releaseFence} from '../outbound/fence.ts';
import {enqueueJob} from '../jobs/jobStore.ts';
import {directSendTargetOf} from '../mail/matching.ts';
import {workspaceBusinessZone} from '../research/ledger.ts';

export interface HumanReplyIdentity {sessionId:string;deviceId:string}
export async function previewHumanReply(ctx:RepositoryContext,input:HumanReplyPreviewInput):Promise<ReplyComposerResult<HumanReplyPreview>>{
 if(!humanReplyPreviewInputSchema.safeParse(input).success||!input.text.trim())return {ok:false,reason:'invalid_input'};
 const context=await readReplyDraftContext(ctx,{messageId:input.messageId,factRefs:input.factRefs,envelope:input.envelope});if(!context.ok)return context;
 const body=await composeBodyForWorkspace(ctx,{body:input.text,signOff:''});if(!body.composed)return {ok:false,reason:body.reason};
 const subject=context.value.subject;
 if(subject.length>998||/[\r\n]/u.test(subject))return {ok:false,reason:'invalid_subject'};
 const value={sourceRevision:context.value.sourceRevision,subject,body:body.body,envelope:context.value.envelope};
 return {ok:true,value:{...value,draftRevision:createHash('sha256').update(JSON.stringify(value)).digest('hex')}};
}

export async function humanReplyIdentityLive(ctx:RepositoryContext,identity:HumanReplyIdentity,userId:string,role:string):Promise<boolean>{
 return (await ctx.db.query(`SELECT 1 FROM sessions s JOIN devices d ON d.workspace_id=s.workspace_id AND d.id=s.device_id JOIN workspace_memberships m ON m.workspace_id=s.workspace_id AND m.user_id=s.user_id
 WHERE s.workspace_id=$1 AND s.id=$2 AND s.device_id=$3 AND s.user_id=$4 AND m.role=$5 AND s.status='active' AND s.expires_at>clock_timestamp() AND s.reauthenticate_after>clock_timestamp() AND d.status='active' AND m.status='active' FOR SHARE OF s,d,m`,[ctx.scope.workspaceId,identity.sessionId,identity.deviceId,userId,role])).rows.length===1;
}

/** Read the original durable attempt even when the source is answered or its body expires. */
export async function readHumanReplySend(ctx:RepositoryContext,input:{messageId:string}):Promise<ReplyComposerResult<HumanReplySendStatus>>{
 const row=(await ctx.db.query<{outbound_message_id:string;refusal:string|null;authorized:boolean;expired:boolean}>('SELECT outbound_message_id,refusal,authorized,expires_at<=clock_timestamp() AS expired FROM human_reply_send_intents WHERE workspace_id=$1 AND message_id=$2',[ctx.scope.workspaceId,input.messageId])).rows[0];
 const fence=row?await readFence(ctx,row.outbound_message_id):await readFenceByDraftId(ctx,input.messageId);if(!fence)return {ok:false,reason:row?'message_unavailable':'no_send_attempt'};
 const firm=await readFirm(ctx,fence.firmId);if(!firm||decideFirmRead(ctx,firm)!=='assigned_or_admin')return {ok:false,reason:'not_assigned'};
 const state=fence.state==='prepared'?(row?.authorized&&!row.expired?'queued':'held'):fence.state;
 return {ok:true,value:{messageId:input.messageId,outboundMessageId:fence.id,state,providerMessageId:fence.providerMessageId,sentAt:fence.sentAt,reason:fence.adminResolution?`admin_marked_${fence.adminResolution}`:row?.refusal??(state==='held'?'fresh_approval_required':null)}};
}

/** Caller owns the transaction: exact authority, original fence and queue commit together. */
export async function requestHumanReplySend(ctx:RepositoryContext,input:HumanReplySendInput,identity:HumanReplyIdentity):Promise<ReplyComposerResult<HumanReplySendStatus>>{
 if(!humanReplySendInputSchema.safeParse(input).success)return {ok:false,reason:'invalid_input'};
 const actor=ctx.scope.actor;if(actor.kind!=='user')return {ok:false,reason:'human_required'};
 if(!await humanReplyIdentityLive(ctx,identity,actor.userId,actor.role))return {ok:false,reason:'session_changed'};
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`human-reply:${ctx.scope.workspaceId}:${input.messageId}`]);
 const existing=await readHumanReplySend(ctx,input);
 if(!existing.ok&&existing.reason!=='no_send_attempt')return existing;
 if(existing.ok&&existing.value.state!=='held')return existing;
 if(existing.ok){
  const previous=(await ctx.db.query<{command_id:string}>('SELECT command_id FROM human_reply_send_intents WHERE workspace_id=$1 AND message_id=$2',[ctx.scope.workspaceId,input.messageId])).rows[0];
  if(previous?.command_id===input.commandId)return existing;
 }
 const preview=await previewHumanReply(ctx,{messageId:input.messageId,text:input.text,factRefs:input.factRefs,envelope:input.envelope});if(!preview.ok)return preview;
 if(preview.value.sourceRevision!==input.sourceRevision||preview.value.draftRevision!==input.draftRevision)return {ok:false,reason:'draft_changed'};
 const context=await readReplyDraftContext(ctx,{messageId:input.messageId,factRefs:input.factRefs,envelope:input.envelope});if(!context.ok)return context;
 if(context.value.sourceRevision!==input.sourceRevision)return {ok:false,reason:'draft_changed'};
 if(existing.ok){
  const fence=await lockFenceForClaim(ctx,existing.value.outboundMessageId);
  if(!fence||fence.attemptToken!==null||!['prepared','held'].includes(fence.state))return readHumanReplySend(ctx,input);
  if(fence.mailboxId!==context.value.mailboxId||fence.firmId!==context.value.firmId||fence.contactId!==context.value.contactId||fence.recipientAddress!==context.value.senderAddress)return {ok:false,reason:'owner_changed'};
  const rewritten=await rewritePreparedBody(ctx,{outboundMessageId:fence.id,body:preview.value.body,subject:preview.value.subject,reason:'human_fresh_approval'});if(!rewritten.ok)return {ok:false,reason:rewritten.reason};
  if(fence.state==='held'){const released=await releaseFence(ctx,{outboundMessageId:fence.id});if(!released.ok)return {ok:false,reason:released.reason};}
  const row=(await ctx.db.query<{revision:number}>(`UPDATE human_reply_send_intents SET user_id=$3,role=$4,session_id=$5,device_id=$6,command_id=$7,revision=revision+1,authorized=true,expires_at=clock_timestamp()+interval '2 minutes',source_revision=$8,draft_revision=$9,fact_refs=$10::jsonb,envelope=$11::jsonb,refusal=NULL WHERE workspace_id=$1 AND message_id=$2 RETURNING revision`,[ctx.scope.workspaceId,input.messageId,actor.userId,actor.role,identity.sessionId,identity.deviceId,input.commandId,input.sourceRevision,input.draftRevision,JSON.stringify(input.factRefs),JSON.stringify(input.envelope)])).rows[0]!;
  await enqueueJob(ctx.db,{workspaceId:ctx.scope.workspaceId,kind:'reply.human_send',idempotencyKey:`human-reply:${input.messageId}:${row.revision}`,payload:{outboundMessageId:fence.id,revision:row.revision}});
  return readHumanReplySend(ctx,input);
 }
 const route=(await ctx.db.query<{id:string;version:number}>('SELECT id,version FROM email_addresses WHERE workspace_id=$1 AND firm_id=$2 AND contact_id=$3 AND address=$4 AND retired_at IS NULL',[ctx.scope.workspaceId,context.value.firmId,context.value.contactId,context.value.senderAddress])).rows[0];if(!route)return {ok:false,reason:'recipient_unverified'};
 const firm=await readFirm(ctx,context.value.firmId),target=await directSendTargetOf(ctx,input.messageId);
 const prepared=await prepareHumanReplyFence(ctx,{draftId:input.messageId,mailboxId:context.value.mailboxId,firmId:context.value.firmId,contactId:context.value.contactId,opportunityId:target?.opportunityId??null,address:context.value.senderAddress,routeId:route.id,routeVersion:route.version,subject:preview.value.subject,body:preview.value.body,sourceZone:firm?.time_zone??await workspaceBusinessZone(ctx)});if(!prepared.ok)return {ok:false,reason:prepared.reason};
 await ctx.db.query(`INSERT INTO human_reply_send_intents(workspace_id,message_id,outbound_message_id,user_id,role,session_id,device_id,command_id,expires_at,source_revision,draft_revision,fact_refs,envelope,provider_thread_id,in_reply_to,reference_ids,author_address,outreach_plan_id)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '2 minutes',$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15::jsonb,$16,$17)`,[ctx.scope.workspaceId,input.messageId,prepared.value.outboundMessageId,actor.userId,actor.role,identity.sessionId,identity.deviceId,input.commandId,input.sourceRevision,input.draftRevision,JSON.stringify(input.factRefs),JSON.stringify(input.envelope),context.value.providerThreadId,context.value.inReplyTo,JSON.stringify(context.value.references),context.value.authorAddress,target?.outreachPlanId??null]);
 await enqueueJob(ctx.db,{workspaceId:ctx.scope.workspaceId,kind:'reply.human_send',idempotencyKey:`human-reply:${input.messageId}:1`,payload:{outboundMessageId:prepared.value.outboundMessageId,revision:1}});
 return readHumanReplySend(ctx,input);
}
