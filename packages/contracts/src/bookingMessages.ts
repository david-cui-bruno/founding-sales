import {z} from 'zod';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';
/** References only. Neither text, envelope, candidate nor authority is accepted from a caller. */
export const bookingMessageCommandSchema=z.strictObject({commandId:commandIdSchema,clientVersion:semanticVersionSchema,conversationId:z.uuid(),kind:z.literal('approved_link')});
export type BookingMessageCommand=z.infer<typeof bookingMessageCommandSchema>;
export const bookingMessageViewSchema=z.strictObject({messageId:z.uuid(),conversationId:z.uuid(),kind:z.literal('approved_link'),state:z.enum(['queued','held','dispatching','reconciling','sent','unknown_terminal','unavailable']),reason:z.string().nullable(),outboundMessageId:z.uuid().nullable(),providerMessageId:z.string().nullable(),sentAt:z.string().nullable(),limitations:z.array(z.string())});
export type BookingMessageView=z.infer<typeof bookingMessageViewSchema>;
