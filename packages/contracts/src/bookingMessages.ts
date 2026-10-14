import {z} from 'zod';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';
export const bookingMessageKindSchema=z.enum(['approved_link','clarification','nudge_3','nudge_7','no_show']);
export type BookingMessageKind=z.infer<typeof bookingMessageKindSchema>;
/** References only. Neither text, envelope, candidate nor authority is accepted from a caller. */
export const bookingMessageCommandSchema=z.strictObject({commandId:commandIdSchema,clientVersion:semanticVersionSchema,conversationId:z.uuid(),kind:bookingMessageKindSchema});
export type BookingMessageCommand=z.infer<typeof bookingMessageCommandSchema>;
export const bookingMessageViewSchema=z.object({messageId:z.uuid(),conversationId:z.uuid(),kind:bookingMessageKindSchema,state:z.enum(['queued','held','dispatching','reconciling','sent','unknown_terminal','unavailable']),reason:z.string().nullable(),outboundMessageId:z.uuid().nullable(),providerMessageId:z.string().nullable(),sentAt:z.string().nullable(),limitations:z.array(z.string())});
export type BookingMessageView=z.infer<typeof bookingMessageViewSchema>;
