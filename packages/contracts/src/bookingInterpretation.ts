import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { mailConversationSchema } from './crmMail.ts';

export const bookingInterpretationSourceSchema = z.strictObject({
  sourceId: z.uuid(), sourceRevision: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const bookingInterpretationRequestSchema = z.strictObject({
  commandId: commandIdSchema, clientVersion: semanticVersionSchema,
  source: bookingInterpretationSourceSchema,
  priorSources: z.array(bookingInterpretationSourceSchema).max(3),
});
export const bookingInterpretationReadSchema = z.strictObject({ requestId: z.uuid() });
export type BookingInterpretationSource = z.infer<typeof bookingInterpretationSourceSchema>;
export type BookingInterpretationRequest = z.infer<typeof bookingInterpretationRequestSchema>;
const citationSchema=z.object({sourceId:z.uuid(),start:z.number().int().nonnegative(),end:z.number().int().positive(),quote:z.string().min(1).max(12000)});
const handoffSchema=z.object({ownerUserId:z.uuid(),action:z.enum(['answer_sales_question','review_conditional_scheduling']),evidence:citationSchema});
const guard={permission:z.literal(false),handoff:handoffSchema.optional()};
export const bookingInterpretationOutcomeSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('approved_link'),bookingUrl:z.string().url().startsWith('https://cal.com/'),schedulingPaused:z.literal(false),...guard}),
 z.object({kind:z.literal('slot_proposal'),slot:z.object({localDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),localTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),timeZone:z.string().max(100),evidence:citationSchema}),agreement:citationSchema,attendeeAddress:z.email(),schedulingPaused:z.literal(false),requires:z.tuple([z.literal('current_attendee_route'),z.literal('fresh_freebusy'),z.literal('guarded_create')]),...guard}),
 z.object({kind:z.literal('clarification'),reason:z.literal('booking_candidate_requires_review'),...guard}),
 z.object({kind:z.literal('david_handoff'),schedulingPaused:z.literal(true),permission:z.literal(false),handoff:handoffSchema}),
 z.object({kind:z.literal('stop'),reason:z.enum(['opt_out','refusal']),evidence:citationSchema,permission:z.literal(false)}),
]);
const mailSource=mailConversationSchema.options[1].shape.source;
export const bookingInterpretationViewSchema=z.object({
 requestId:z.uuid(),state:z.enum(['unavailable','pending','processing','complete','stale','unknown_acceptance']),reason:z.string().max(100).nullable(),outcome:bookingInterpretationOutcomeSchema.nullable(),
 provenance:z.object({source:bookingInterpretationSourceSchema.strip(),priorSources:z.array(bookingInterpretationSourceSchema.strip()).max(3),occurredAt:mailSource.shape.occurredAt,observedAt:mailSource.shape.observedAt,rawSenderDate:mailSource.shape.rawSenderDate,participant:z.string().max(320).nullable(),originalContexts:z.array(mailSource.shape.originalContexts.element.strip()).max(100),reviewedContexts:z.array(mailSource.shape.reviewedContexts.element.strip()).max(100),accountBinding:mailSource.shape.accountBinding,generation:mailSource.shape.acquiredGeneration}).nullable(),
 financial:z.object({state:z.enum(['reserved','calling','settled','estimated','released']),reservedCents:z.number().int().nonnegative(),settledCents:z.number().int().nonnegative()}).nullable().default(null),
 limitations:z.array(z.enum(['candidate_not_permission','no_sending_or_booking','linkedin_intake_unavailable','actual_model_quality_unverified'])).max(4),
});
export type BookingInterpretationView=z.infer<typeof bookingInterpretationViewSchema>;
