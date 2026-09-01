import { z } from 'zod';

import {
  leadPriorityContextSchema,
  lifecycleStageSchema,
  personIdSchema,
  primaryActionSchema,
  salesCycleIdSchema,
} from './commonContract';

export const contactMethodSchema = z.object({
  id: z.string().min(1), kind: z.enum(['phone', 'email']), value: z.string().min(1), label: z.string().nullable(), valid: z.boolean(),
}).strict();
export const cadenceSummarySchema = z.object({ name: z.string(), stepLabel: z.string(), touchIndex: z.number().int().positive(), touchLimit: z.number().int().positive() }).strict();
export const activitySummarySchema = z.object({ id: z.string(), kind: z.enum(['call', 'voicemail', 'text', 'email', 'interview', 'offer', 'note', 'job', 'system']), occurredAt: z.string().datetime({ offset: true }), summary: z.string(), outcome: z.string().nullable() }).strict();
export const conversationSummarySchema = z.object({ id: z.string(), occurredAt: z.string().datetime({ offset: true }), durationSeconds: z.number().int().nonnegative(), recordingAvailable: z.boolean(), transcriptAvailable: z.boolean(), reviewCount: z.number().int().nonnegative() }).strict();
export const propertySummarySchema = z.object({ id: z.string(), address: z.string(), doors: z.number().int().nonnegative().nullable(), ownershipEvidence: z.string().nullable(), liveVacancy: z.boolean() }).strict();
export const historyEventSchema = z.object({ id: z.string(), occurredAt: z.string().datetime({ offset: true }), label: z.string(), detail: z.string().nullable() }).strict();

export const leadDetailSchema = z.object({
  personId: personIdSchema, salesCycleId: salesCycleIdSchema, personName: z.string().min(1), phones: z.array(contactMethodSchema),
  emails: z.array(contactMethodSchema), organizationLabel: z.string().nullable(), propertySummaries: z.array(z.string()),
  stage: lifecycleStageSchema, workflowStatus: z.enum(['active', 'onboarding', 'closed']), sourceLabel: z.string().min(1),
  segment: z.enum(['hot', 'cold', 'warm']), priorityContext: leadPriorityContextSchema.nullable(),
  priorityReasons: z.array(z.string().min(1)), nextAction: primaryActionSchema.nullable(), optedOut: z.boolean(),
  cadence: cadenceSummarySchema.nullable(), activities: z.array(activitySummarySchema), conversations: z.array(conversationSummarySchema),
  properties: z.array(propertySummarySchema), history: z.array(historyEventSchema), revision: z.number().int().nonnegative(),
}).strict();

export const leadDetailRequestSchema = z.object({
  personId: personIdSchema,
}).strict();

/** Outbound commands are discriminated by exact channel. */
export const beginOutboundRequestSchema = z.discriminatedUnion('channel', [
  z.object({
    channel: z.literal('call'),
    personId: personIdSchema,
    salesCycleId: salesCycleIdSchema,
    contactMethodId: z.string().min(1),
  }).strict(),
  z.object({
    channel: z.literal('text'),
    personId: personIdSchema,
    salesCycleId: salesCycleIdSchema,
    contactMethodId: z.string().min(1),
  }).strict(),
  z.object({
    channel: z.literal('email'),
    personId: personIdSchema,
    salesCycleId: salesCycleIdSchema,
    contactMethodId: z.string().min(1),
  }).strict(),
]);

/** Stage commands are discriminated by the exact guarded transition. */
export const confirmTransitionRequestSchema = z.discriminatedUnion('transition', [
  z.object({
    transition: z.literal('review_to_ready'),
    salesCycleId: salesCycleIdSchema,
    expectedRevision: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    transition: z.literal('confirm_interviewed'),
    salesCycleId: salesCycleIdSchema,
    expectedRevision: z.number().int().nonnegative(),
    suggestionActivityId: z.string().min(1),
  }).strict(),
  z.object({
    transition: z.literal('confirm_offered'),
    salesCycleId: salesCycleIdSchema,
    expectedRevision: z.number().int().nonnegative(),
    suggestionActivityId: z.string().min(1),
  }).strict(),
]);

export type ContactMethod = z.infer<typeof contactMethodSchema>;
export type CadenceSummary = z.infer<typeof cadenceSummarySchema>;
export type ActivitySummary = z.infer<typeof activitySummarySchema>;
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;
export type PropertySummary = z.infer<typeof propertySummarySchema>;
export type HistoryEvent = z.infer<typeof historyEventSchema>;
export type LeadDetail = z.infer<typeof leadDetailSchema>;
export type LeadDetailRequest = z.infer<typeof leadDetailRequestSchema>;
export type BeginOutboundRequest = z.infer<typeof beginOutboundRequestSchema>;
export type ConfirmTransitionRequest = z.infer<typeof confirmTransitionRequestSchema>;
