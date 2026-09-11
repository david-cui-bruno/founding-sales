import { z } from 'zod';

import {
  leadPriorityContextSchema,
  lifecycleStageSchema,
  outboundAuthorizationReasonCodeSchema,
  personIdSchema,
  primaryActionSchema,
  salesCycleIdSchema,
} from './commonContract';
import { cloudScoreChipSchema } from './leadsContract';
import { findContactRefusalReasonSchema } from './enrichmentRequestContract';
import { outboundAttemptSummarySchema } from './outboundContract';

export const phoneComplianceStatusSchema = z.enum([
  'verified_clear',
  'federal_dnc_listed',
  'tcpa_blocked',
  'compliance_unknown',
  'scrub_expired',
  'area_code_not_covered',
  'state_clearance_required',
  'outside_recipient_window',
]);

export const contactMethodSchema = z.object({
  id: z.string().min(1),
  contactSnapshot: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(['phone', 'email']),
  value: z.string().min(1),
  label: z.string().nullable(),
  valid: z.boolean(),
  validationState: z.enum(['unverified', 'valid', 'invalid']),
  reachability: z.enum(['direct', 'indirect', 'none']),
  sourceLabel: z.string().min(1).nullable(),
  vendorRank: z.number().int().positive().nullable(),
  phoneKind: z.enum(['mobile', 'landline', 'voip', 'other']).nullable(),
  ownershipState: z.enum([
    'verified_person', 'vendor_candidate', 'conflicting_identity', 'unknown',
  ]),
  evidenceObservedAt: z.string().datetime({ offset: true }).nullable(),
  compliance: z.object({
    status: phoneComplianceStatusSchema,
    label: z.string().min(1),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    callRefusalReason: outboundAuthorizationReasonCodeSchema.nullable(),
    textRefusalReason: outboundAuthorizationReasonCodeSchema.nullable(),
  }).strict().nullable(),
}).strict();
export const cadenceSummarySchema = z.object({ name: z.string(), stepLabel: z.string(), touchIndex: z.number().int().positive(), touchLimit: z.number().int().positive() }).strict();
export const activitySummarySchema = z.object({ id: z.string(), kind: z.enum(['call', 'voicemail', 'text', 'email', 'interview', 'offer', 'note', 'job', 'system']), occurredAt: z.string().datetime({ offset: true }), summary: z.string(), outcome: z.string().nullable(), markedInError: z.boolean() }).strict();
export const conversationSummarySchema = z.object({ id: z.string(), occurredAt: z.string().datetime({ offset: true }), durationSeconds: z.number().int().nonnegative(), recordingAvailable: z.boolean(), transcriptAvailable: z.boolean(), reviewCount: z.number().int().nonnegative() }).strict();
export const propertySummarySchema = z.object({ id: z.string(), address: z.string(), doors: z.number().int().nonnegative().nullable(), ownershipEvidence: z.string().nullable(), liveVacancy: z.boolean() }).strict();
export const historyEventSchema = z.object({ id: z.string(), occurredAt: z.string().datetime({ offset: true }), label: z.string(), detail: z.string().nullable() }).strict();

/**
 * Cloud score detail (Task 5): the two separate axes plus the scorer's
 * top-3 reasons. `signal` is the scorer's stable signal id (mapped to a
 * short label renderer-side), never free prose.
 */
export const cloudScoreDetailSchema = z.object({
  scores: cloudScoreChipSchema,
  reasons: z.array(z.object({
    signal: z.string().min(1),
    contribution: z.number(),
  }).strict()).max(3),
  scoredAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

export const findContactEligibilitySchema = z.object({
  eligible: z.boolean(),
  refusalReason: findContactRefusalReasonSchema.nullable(),
}).strict();
export type FindContactEligibility = z.infer<typeof findContactEligibilitySchema>;

export const portfolioContextSchema = z.object({
  role: z.enum(['owner', 'manager', 'unknown']),
  ownedCount: z.number().int().nonnegative(),
  managedCount: z.number().int().nonnegative(),
  linkedCount: z.number().int().nonnegative(),
  knownUnits: z.number().int().nonnegative().nullable(),
  locations: z.array(z.string()),
  summary: z.string(),
  completeness: z.literal('partial'),
  facts: z.array(z.object({ id: z.string(), text: z.string() }).strict()),
}).strict();
export const contactReasonSchema = z.object({ text: z.string(), evidenceIds: z.array(z.string()).min(1) }).strict();
export type PortfolioContext = z.infer<typeof portfolioContextSchema>;
export type ContactReason = z.infer<typeof contactReasonSchema>;

export const leadDetailSchema = z.object({
  personId: personIdSchema, salesCycleId: salesCycleIdSchema, personName: z.string().min(1), phones: z.array(contactMethodSchema),
  emails: z.array(contactMethodSchema), organizationLabel: z.string().nullable(), propertySummaries: z.array(z.string()),
  stage: lifecycleStageSchema, workflowStatus: z.enum(['active', 'onboarding', 'closed']), sourceLabel: z.string().min(1),
  segment: z.enum(['hot', 'cold', 'warm']), priorityContext: leadPriorityContextSchema.nullable(),
  cloudScores: cloudScoreDetailSchema.nullable(),
  cloudLinked: z.boolean(),
  findContactEligibility: findContactEligibilitySchema,
  priorityReasons: z.array(z.string().min(1)), nextAction: primaryActionSchema.nullable(), optedOut: z.boolean(),
  cadence: cadenceSummarySchema.nullable(), activities: z.array(activitySummarySchema), conversations: z.array(conversationSummarySchema),
  outboundAttempts: z.array(outboundAttemptSummarySchema).max(20),
  properties: z.array(propertySummarySchema), history: z.array(historyEventSchema), revision: z.number().int().nonnegative(),
  portfolio: portfolioContextSchema.optional(),
  contactReason: contactReasonSchema.nullable().optional(),
}).strict();

export const leadDetailRequestSchema = z.object({
  personId: personIdSchema,
}).strict();

export { outboundRequestSchema as beginOutboundRequestSchema } from './outboundContract';
export type { OutboundRequest as BeginOutboundRequest } from './outboundContract';

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

/** Founder "wrong signal" control: log-only, no local score change. */
export const cloudScoreOverrideRequestSchema = z.object({
  personId: personIdSchema,
  direction: z.enum(['up', 'down']),
}).strict();

/**
 * Founder dismissal from the review flow: disqualifies the prospect behind
 * the exact qualification gate reason and closes the cycle into
 * Lost-Nurture through the existing guarded path.
 */
export const qualificationGateReasonSchema = z.enum([
  'out_of_area',
  'no_relevant_decision_relationship',
  'institutional_outside_icp',
  'harmful_operator',
  'non_paying_operator',
  'unresolved_duplicate',
]);

export const dismissLeadRequestSchema = z.object({
  salesCycleId: salesCycleIdSchema,
  personId: personIdSchema,
  qualificationGateReason: qualificationGateReasonSchema,
  expectedRevision: z.number().int().nonnegative(),
}).strict();

export type PhoneComplianceStatus = z.infer<typeof phoneComplianceStatusSchema>;
export type ContactMethod = z.infer<typeof contactMethodSchema>;
export type CadenceSummary = z.infer<typeof cadenceSummarySchema>;
export type ActivitySummary = z.infer<typeof activitySummarySchema>;
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;
export type PropertySummary = z.infer<typeof propertySummarySchema>;
export type HistoryEvent = z.infer<typeof historyEventSchema>;
export type LeadDetail = z.infer<typeof leadDetailSchema>;
export type LeadDetailRequest = z.infer<typeof leadDetailRequestSchema>;
export type ConfirmTransitionRequest = z.infer<typeof confirmTransitionRequestSchema>;
export type CloudScoreDetail = z.infer<typeof cloudScoreDetailSchema>;
export type CloudScoreOverrideRequest = z.infer<typeof cloudScoreOverrideRequestSchema>;
export type QualificationGateReason = z.infer<typeof qualificationGateReasonSchema>;
export type DismissLeadRequest = z.infer<typeof dismissLeadRequestSchema>;
