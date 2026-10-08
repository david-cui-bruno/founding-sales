import {z} from 'zod';
import type {JobHandler} from '@fss/domain/jobs/handlerRegistry.ts';
import {repositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {dispatchOutboundMessage,type OutboundSendDeps} from '@fss/domain/outbound/send.ts';
import {refuseHumanReplyApproval} from '@fss/domain/replies/sendAuthority.ts';

const payloadSchema=z.strictObject({outboundMessageId:z.uuid(),revision:z.number().int().positive()});
/** No scheduler source. Only a current explicit human command can enqueue this work. */
export function humanReplySendJobHandler(deps?:OutboundSendDeps):JobHandler{
 return {kind:'reply.human_send',protection:'outbound_fence',maxAttempts:4,leaseSeconds:180,handle:async input=>{
  const parsed=payloadSchema.safeParse(input.job.payload);if(!parsed.success)return;
  const {outboundMessageId,revision}=parsed.data,ctx=repositoryContext(input.scope,input.session);
  const row=(await ctx.db.query<{revision:number}>('SELECT revision FROM human_reply_send_intents WHERE workspace_id=$1 AND outbound_message_id=$2',[ctx.scope.workspaceId,outboundMessageId])).rows[0];
  if(row?.revision!==revision)return;
  if(!deps){await refuseHumanReplyApproval(ctx,outboundMessageId,'sender_unavailable',revision);return;}
  const result=await dispatchOutboundMessage(ctx,{...deps,humanReplyRevision:revision},{outboundMessageId});
  if(['held','not_ready','fence_unknown'].includes(result.outcome))await refuseHumanReplyApproval(ctx,outboundMessageId,result.refusal??'fresh_approval_required',revision);
 }};
}
