import type {RepositoryContext} from '../db/workspaceScope.ts';
import {withTransaction} from '../db/queryable.ts';
import {readFence} from '../outbound/fence.ts';
import {recordMessage,storeMessageBody} from '../mail/messages.ts';
import {recordMatches} from '../mail/matching.ts';
import {applyDirectSendEffects} from '../mail/effects.ts';

/** Confirmed provider evidence uses existing mail retention and direct human conversation effects. */
export async function recordHumanReplyDelivery(ctx:RepositoryContext,id:string):Promise<void>{
 const fence=await readFence(ctx,id);if(fence?.originKind!=='draft'||fence.state!=='sent'||!fence.providerMessageId||!fence.providerThreadId||!fence.sentAt)return;
 const intent=(await ctx.db.query<{envelope:{to:string[];cc:string[]};in_reply_to:string;reference_ids:string[];author_address:string}>('SELECT envelope,in_reply_to,reference_ids,author_address FROM human_reply_send_intents WHERE workspace_id=$1 AND outbound_message_id=$2',[ctx.scope.workspaceId,id])).rows[0];if(!intent||!fence.contactId)return;
 await withTransaction(ctx.db,async()=>{
  const stored=await recordMessage(ctx,{mailboxId:fence.mailboxId,metadata:{providerMessageId:fence.providerMessageId!,providerThreadId:fence.providerThreadId!,rfcMessageId:fence.providerMessageIdHeader.replace(/^<|>$/gu,''),direction:'outgoing',internalDate:fence.sentAt!,headerFrom:intent.author_address,headerTo:intent.envelope.to,headerCc:intent.envelope.cc,subject:fence.subject,referenceMessageIds:intent.reference_ids,inReplyTo:intent.in_reply_to,autoSubmitted:null,listId:null,labelIds:['SENT'],attachments:[]}});
  const candidate={firmId:fence.firmId,contactId:fence.contactId!,opportunityId:fence.opportunityId,rule:'participant' as const,viaClosedOpportunity:false};
  await recordMatches(ctx,{messageId:stored.message.id,candidates:[candidate]});
  await storeMessageBody(ctx,{messageId:stored.message.id,text:fence.body,truncated:false});
  await applyDirectSendEffects(ctx,{message:stored.message,candidate});
 });
}
