import {z} from 'zod';
import {uuid} from './foundationRows.ts';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';
import {answerBlockSchema} from './outreach.ts';

export const replyFactRefSchema=z.strictObject({id:uuid,version:z.number().int().positive()});
export const replyDraftEnvelopeSchema=z.strictObject({to:z.array(z.email().max(320)).min(1).max(10),cc:z.array(z.email().max(320)).max(10)});
export const replyDraftContextInputSchema=z.strictObject({messageId:uuid,factRefs:z.array(replyFactRefSchema).max(20).optional(),envelope:replyDraftEnvelopeSchema.optional()});
export const replyDraftContextSchema=z.strictObject({
 messageId:uuid,sourceRevision:z.string().regex(/^[a-f0-9]{64}$/u),firmId:uuid,contactId:uuid,
 authorUserId:uuid,mailboxId:uuid,mailboxOwnerUserId:uuid,authorAddress:z.email(),authorizationRevision:z.number().int().positive(),
 subject:z.string().max(998),senderAddress:z.email(),providerThreadId:z.string().min(1).max(500),inReplyTo:z.string().min(1).max(998),references:z.array(z.string()).max(101),
 observedTo:z.array(z.string()).max(200),observedCc:z.array(z.string()).max(200),replyToMetadata:z.literal('unavailable'),
 envelope:replyDraftEnvelopeSchema,recipientOptions:z.array(z.strictObject({address:z.email(),contactId:uuid})).max(20),
 messageText:z.string().max(200000),priorContext:z.array(z.strictObject({direction:z.enum(['incoming','outgoing']),text:z.string().max(200000)})).max(19),
 bookings:z.array(z.strictObject({id:uuid,state:z.enum(['booked','rescheduled','cancelled','held','no_show']),startsAt:z.string(),endsAt:z.string()})).max(20),
 facts:z.array(answerBlockSchema).max(20),availableFacts:z.array(answerBlockSchema).max(50),
});
export const replyDraftGenerateInputSchema=replyDraftContextInputSchema.safeExtend({commandId:commandIdSchema,clientVersion:semanticVersionSchema,sourceRevision:z.string().regex(/^[a-f0-9]{64}$/u),factRefs:z.array(replyFactRefSchema).max(20),envelope:replyDraftEnvelopeSchema});
export const replyGeneratedDraftSchema=z.strictObject({sourceRevision:z.string().regex(/^[a-f0-9]{64}$/u),draftRevision:z.string().regex(/^[a-f0-9]{64}$/u),text:z.string().min(1).max(12000),factRefs:z.array(replyFactRefSchema).max(20),reviewRequired:z.literal(true),reviewNotes:z.array(z.string().min(1).max(500)).min(1).max(10)});
export const replyComposerRefusalSchema=z.strictObject({ok:z.literal(false),reason:z.string().min(1).max(100)});
export const replyDraftContextResultSchema=z.discriminatedUnion('ok',[z.strictObject({ok:z.literal(true),value:replyDraftContextSchema}),replyComposerRefusalSchema]);
export const replyDraftGenerateResultSchema=z.discriminatedUnion('ok',[z.strictObject({ok:z.literal(true),value:replyGeneratedDraftSchema}),replyComposerRefusalSchema]);
export type ReplyFactRef=z.infer<typeof replyFactRefSchema>;
export type ReplyDraftEnvelope=z.infer<typeof replyDraftEnvelopeSchema>;
export type ReplyDraftContextInput=z.infer<typeof replyDraftContextInputSchema>;
export type ReplyDraftContext=z.infer<typeof replyDraftContextSchema>;
export type ReplyDraftGenerateInput=z.infer<typeof replyDraftGenerateInputSchema>;
export type ReplyGeneratedDraft=z.infer<typeof replyGeneratedDraftSchema>;
export type ReplyComposerResult<T>={ok:true;value:T}|{ok:false;reason:string};

export const humanReplyPreviewInputSchema=replyDraftContextInputSchema.safeExtend({text:z.string().min(1).max(12000),factRefs:z.array(replyFactRefSchema).max(20),envelope:replyDraftEnvelopeSchema});
export const humanReplyPreviewSchema=z.strictObject({sourceRevision:z.string().regex(/^[a-f0-9]{64}$/u),draftRevision:z.string().regex(/^[a-f0-9]{64}$/u),subject:z.string().max(998),body:z.string().min(1).max(16000),envelope:replyDraftEnvelopeSchema});
export const humanReplySendInputSchema=humanReplyPreviewInputSchema.safeExtend({commandId:commandIdSchema,clientVersion:semanticVersionSchema,sourceRevision:z.string().regex(/^[a-f0-9]{64}$/u),draftRevision:z.string().regex(/^[a-f0-9]{64}$/u)});
export const humanReplySendReadInputSchema=z.strictObject({messageId:uuid});
export const humanReplySendStatusSchema=z.strictObject({messageId:uuid,outboundMessageId:uuid,state:z.enum(['queued','held','dispatching','reconciling','sent','unknown_terminal']),providerMessageId:z.string().nullable(),sentAt:z.string().nullable(),reason:z.string().nullable()});
export const humanReplyPreviewResultSchema=z.discriminatedUnion('ok',[z.strictObject({ok:z.literal(true),value:humanReplyPreviewSchema}),replyComposerRefusalSchema]);
export const humanReplySendResultSchema=z.discriminatedUnion('ok',[z.strictObject({ok:z.literal(true),value:humanReplySendStatusSchema}),replyComposerRefusalSchema]);
export type HumanReplyPreviewInput=z.infer<typeof humanReplyPreviewInputSchema>;
export type HumanReplyPreview=z.infer<typeof humanReplyPreviewSchema>;
export type HumanReplySendInput=z.infer<typeof humanReplySendInputSchema>;
export type HumanReplySendStatus=z.infer<typeof humanReplySendStatusSchema>;
