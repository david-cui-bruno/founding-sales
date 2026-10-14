import {z} from 'zod';
import type {JobHandler} from '@fss/domain/jobs/handlerRegistry.ts';
import {repositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {dispatchOutboundMessage} from '@fss/domain/outbound/send.ts';
import {bookingMessageFenceId,refuseBookingMessage} from '@fss/domain/meetings/bookingMessages.ts';
import type {BookingMessageRuntime} from '@fss/domain/meetings/bookingMessagesRuntime.ts';
const payload=z.strictObject({messageId:z.uuid()});
export function bookingMessageSendJobHandler(runtime?:BookingMessageRuntime):JobHandler{
 return {kind:'booking.message_send',protection:'outbound_fence',maxAttempts:4,leaseSeconds:180,handle:async input=>{
  const parsed=payload.safeParse(input.job.payload);if(!parsed.success)return;
  const ctx=repositoryContext(input.scope,input.session),id=parsed.data.messageId;
  if(!runtime){await refuseBookingMessage(ctx,id,'booking_sender_unavailable');return;}
  const outboundMessageId=await bookingMessageFenceId(ctx,id);if(!outboundMessageId)return;
  const result=await dispatchOutboundMessage(ctx,{...runtime.send,bookingMessageRuntime:runtime},{outboundMessageId});
  if(!['sent','already_terminal'].includes(result.outcome))await refuseBookingMessage(ctx,id,result.detail??result.refusal??result.outcome);
 }};
}
