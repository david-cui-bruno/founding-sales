import { z } from 'zod';

import { cadenceFamilySchema } from '../cadence/cadenceTypes';
import { normalizeEmail, normalizePhone } from '../source/sourceService';
import { idSchema, utcTimestampSchema } from './lifecycleValidation';

export const reactivationCadenceIdentitySchema = z.object({
  definitionId: idSchema,
  family: cadenceFamilySchema.extract(['cadence_a', 'cadence_b', 'cadence_c']),
  version: z.number().int().safe().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const commonCommand = {
  personId: idSchema,
  prospectId: idSchema,
  sourceCycleId: idSchema,
  newCycleId: idSchema,
  activatedAt: utcTimestampSchema,
  cadence: reactivationCadenceIdentitySchema,
};

const ruleCommon = {
  ...commonCommand,
  ruleId: idSchema,
  expectedRuleVersion: z.number().int().safe().positive(),
  entrySourceEventId: idSchema,
};

export const reactivationRuleCommandSchema = z.discriminatedUnion('ruleType', [
  z.object({
    ...ruleCommon,
    ruleType: z.literal('seasonal:heating-oct1'),
    trigger: z.object({ kind: z.literal('due'), dueAt: utcTimestampSchema }).strict(),
  }).strict(),
  z.object({
    ...ruleCommon,
    ruleType: z.literal('manual'),
    trigger: z.object({ kind: z.literal('due'), dueAt: utcTimestampSchema }).strict(),
  }).strict(),
  z.object({
    ...ruleCommon,
    ruleType: z.literal('new-frbo-listing'),
    trigger: z.object({
      kind: z.literal('source_event'), eventType: z.literal('new-frbo-listing'),
      sourceEventId: idSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...ruleCommon,
    ruleType: z.literal('lead-cert-expiry-window'),
    trigger: z.object({
      kind: z.literal('source_event'), eventType: z.literal('lead-cert-expiry-window'),
      sourceEventId: idSchema,
    }).strict(),
  }).strict(),
]);

export const inboundEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('source_event'), sourceEventId: idSchema,
    channel: z.enum(['inbound_demo', 'referral', 'rireig', 'community']),
  }).strict(),
  z.object({
    kind: z.literal('unknown_handle'), handleKind: z.enum(['phone', 'email']),
    normalizedValue: z.string().trim().min(1),
  }).strict().superRefine((value, context) => {
    try {
      const canonical = value.handleKind === 'phone'
        ? normalizePhone(value.normalizedValue)
        : normalizeEmail(value.normalizedValue);
      if (canonical !== value.normalizedValue) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Unknown inbound handles must already use canonical normalization.',
        });
      }
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Unknown inbound handle is not valid canonical contact evidence.',
      });
    }
  }),
]);

export const reactivationInboundCommandSchema = z.object({
  ...commonCommand,
  cadence: reactivationCadenceIdentitySchema.extend({ family: z.literal('cadence_c') }).strict(),
  evidence: inboundEvidenceSchema,
}).strict();

export const promoteUnknownInboundReviewCommandSchema = z.object({
  reviewId: idSchema,
  activationKey: z.string().trim().min(1),
  expectedReviewVersion: z.number().int().safe().positive(),
  sourceEventId: idSchema,
  channel: z.enum(['inbound_demo', 'referral', 'rireig', 'community']),
  activatedAt: utcTimestampSchema,
  cadence: reactivationCadenceIdentitySchema.extend({ family: z.literal('cadence_c') }).strict(),
}).strict();

export const reactivationCommandSchema = z.union([
  reactivationRuleCommandSchema,
  reactivationInboundCommandSchema,
]);

export const reactivationCommandEnvelopeSchema = z.object({
  version: z.literal(1), command: reactivationCommandSchema,
}).strict();

export const salesCycleReceiptSnapshotSchema = z.object({
  id: idSchema, personId: idSchema, prospectId: idSchema, entrySourceEventId: idSchema,
  stage: z.enum(['unreviewed', 'ready', 'contacted', 'interviewed', 'offered', 'won', 'lost_nurture']),
  workflowStatus: z.enum(['active', 'onboarding', 'closed']),
  currentNextActionId: idSchema.nullable(), stageEnteredAt: utcTimestampSchema,
  designPartnerFitness: z.number().int().min(0).max(5).nullable(),
  closeReason: z.enum([
    'no_response', 'not_interested', 'bad_timing', 'not_decision_maker',
    'not_qualified', 'price', 'trust', 'chose_alternative', 'product_gap',
    'cadence_exhausted', 'disqualified', 'opt_out', 'other',
  ]).nullable(),
  closeNotes: z.string().nullable(), onboardingStopReason: z.string().nullable(),
  closedAt: utcTimestampSchema.nullable(),
  version: z.number().int().safe().positive(),
  createdAt: utcTimestampSchema, updatedAt: utcTimestampSchema,
}).strict();

export type SalesCycleReceiptSnapshot = z.infer<typeof salesCycleReceiptSnapshotSchema>;

/**
 * Immutable receipts keep the pre-0010 cycle snapshot shape: resurface
 * state is founder-mutable queue control, never closure/reactivation
 * evidence, so it is stripped before receipts serialize canonically.
 */
export function toSalesCycleReceiptSnapshot(cycle: {
  id: string; personId: string; prospectId: string; entrySourceEventId: string;
  stage: SalesCycleReceiptSnapshot['stage'];
  workflowStatus: SalesCycleReceiptSnapshot['workflowStatus'];
  currentNextActionId: string | null; stageEnteredAt: string;
  designPartnerFitness: number | null;
  closeReason: SalesCycleReceiptSnapshot['closeReason'];
  closeNotes: string | null; onboardingStopReason: string | null;
  closedAt: string | null; version: number; createdAt: string; updatedAt: string;
}): SalesCycleReceiptSnapshot {
  return salesCycleReceiptSnapshotSchema.parse({
    id: cycle.id, personId: cycle.personId, prospectId: cycle.prospectId,
    entrySourceEventId: cycle.entrySourceEventId, stage: cycle.stage,
    workflowStatus: cycle.workflowStatus,
    currentNextActionId: cycle.currentNextActionId,
    stageEnteredAt: cycle.stageEnteredAt,
    designPartnerFitness: cycle.designPartnerFitness,
    closeReason: cycle.closeReason, closeNotes: cycle.closeNotes,
    onboardingStopReason: cycle.onboardingStopReason, closedAt: cycle.closedAt,
    version: cycle.version, createdAt: cycle.createdAt, updatedAt: cycle.updatedAt,
  });
}

const resultCommon = {
  kind: z.literal('reactivated'),
  cycle: salesCycleReceiptSnapshotSchema,
  cadence: reactivationCadenceIdentitySchema,
};

export const reactivationResultEnvelopeSchema = z.object({
  version: z.literal(1),
  result: z.discriminatedUnion('activationKind', [
    z.object({ ...resultCommon, activationKind: z.literal('rule') }).strict(),
    z.object({ ...resultCommon, activationKind: z.literal('inbound_response') }).strict(),
  ]),
}).strict();

export const reactivationReviewBlockerSchema = z.enum([
  'invalid_source_ownership', 'person_unavailable', 'prospect_ineligible',
  'operational_cycle_exists', 'unknown_inbound_handle',
]);

export const reactivationReviewPayloadSchema = z.object({
  version: z.literal(1),
  kind: z.literal('reactivation_blocked'),
  blocker: reactivationReviewBlockerSchema,
  command: reactivationCommandSchema,
}).strict().superRefine((value, context) => {
  const unknown = 'evidence' in value.command
    && value.command.evidence.kind === 'unknown_handle';
  if ((value.blocker === 'unknown_inbound_handle') !== unknown) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Unknown-handle Review blocker must match its command evidence.',
    });
  }
});

export const reactivationReviewResolutionSchema = z.discriminatedUnion('kind', [
  z.object({
    version: z.literal(1),
    kind: z.literal('reactivated'),
    activationKind: z.enum(['rule', 'inbound_response']),
    newCycleId: idSchema,
    cadence: reactivationCadenceIdentitySchema,
  }).strict(),
  z.object({
    version: z.literal(1),
    kind: z.literal('promoted_unknown_inbound'),
    activationKind: z.literal('inbound_response'),
    sourceEventId: idSchema,
    newCycleId: idSchema,
    cadence: reactivationCadenceIdentitySchema.extend({ family: z.literal('cadence_c') }).strict(),
  }).strict(),
]);

export type ReactivationCadenceIdentity = z.infer<typeof reactivationCadenceIdentitySchema>;
export type ReactivateFromRuleCommand = z.infer<typeof reactivationRuleCommandSchema>;
export type ReactivateFromInboundCommand = z.infer<typeof reactivationInboundCommandSchema>;
export type PromoteUnknownInboundReviewCommand = z.infer<
  typeof promoteUnknownInboundReviewCommandSchema
>;
export type ReactivationCommandEnvelope = z.infer<typeof reactivationCommandEnvelopeSchema>;
export type ReactivationResultEnvelope = z.infer<typeof reactivationResultEnvelopeSchema>;
export type ReactivationReviewPayload = z.infer<typeof reactivationReviewPayloadSchema>;
export type ReactivationReviewResolution = z.infer<typeof reactivationReviewResolutionSchema>;
