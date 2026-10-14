import {z} from 'zod';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';
import {bookingCreateReceiptSchema} from './bookingCreate.ts';
import {bookingInterpretationOutcomeSchema} from './bookingInterpretation.ts';
export const bookingConversationCommandSchema=z.strictObject({commandId:commandIdSchema,clientVersion:semanticVersionSchema,interpretationRequestId:z.uuid(),expectedPolicyRevision:z.number().int().positive()});
export const bookingConversationEventCommandSchema=z.strictObject({commandId:commandIdSchema,clientVersion:semanticVersionSchema,conversationId:z.uuid(),expectedPolicyRevision:z.number().int().positive(),event:z.enum(['manual_nudge','reply','refusal','opt_out','confirm_no_show'])});
export const bookingConversationViewSchema=z.strictObject({conversationId:z.uuid(),interpretationRequestId:z.uuid(),policyRevision:z.number().int().positive(),origin:z.literal('standing_policy'),enabled:z.literal(false),state:z.enum(['pending','awaiting_time','booking_pending','booked','stopped','handoff','stale','unknown']),reason:z.string().nullable(),outcome:bookingInterpretationOutcomeSchema.nullable(),handoff:z.object({ownerUserId:z.uuid(),action:z.enum(['answer_sales_question','review_conditional_scheduling','review_booking']),evidence:z.object({sourceId:z.uuid(),start:z.number().int(),end:z.number().int(),quote:z.string()}).optional()}).nullable(),booking:bookingCreateReceiptSchema.nullable(),nudgeCount:z.number().int().min(0).max(2),nudgesStoppedAt:z.string().nullable(),lastReplyAt:z.string().nullable(),explicitNoShowAt:z.string().nullable(),noShowRebookingUsed:z.boolean(),limitations:z.array(z.string())});
export type BookingConversationView=z.infer<typeof bookingConversationViewSchema>;
