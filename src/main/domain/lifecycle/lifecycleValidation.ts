import { z } from 'zod';

import { canonicalJson } from '../cadence/cadenceTypes';

export const idSchema = z.string().trim().min(1);
export const nonblankSchema = z.string().trim().min(1);
export const utcTimestampSchema = z.string().datetime({ offset: true }).refine(
  (value) => {
    const parsed = new Date(value);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
  },
  'Timestamp must use canonical UTC ISO format.',
);
export const lifecycleStageSchema = z.enum([
  'unreviewed', 'ready', 'contacted', 'interviewed', 'offered', 'won', 'lost_nurture',
]);
export const workflowStatusSchema = z.enum(['active', 'onboarding', 'closed']);
export const workIntentSchema = z.enum([
  'internal_review', 'inbound_response', 'promised_follow_up', 'discretionary_prospecting',
]);
export const actionStatusSchema = z.enum(['pending', 'completed', 'cancelled', 'impossible']);
export const cadenceActionBindingSchema = z.union([
  z.object({
    cadenceEnrollmentId: z.null(), cadenceDefinitionId: z.null(),
    cadenceStepId: z.null(), cadenceComponentId: z.null(),
  }).strict(),
  z.object({
    cadenceEnrollmentId: idSchema, cadenceDefinitionId: idSchema,
    cadenceStepId: idSchema, cadenceComponentId: idSchema,
  }).strict(),
]);

const noInboundSlaSchema = z.object({
  kind: z.literal('none'), dueAt: z.null(), sourceEventId: z.null(), provenance: z.null(),
}).strict();
const demoProvenanceSchema = z.object({
  version: z.literal(1), sourceEventId: idSchema, sourceObservedAt: utcTimestampSchema,
  calculation: z.literal('permitted_minutes'), minutes: z.literal(15),
  policyId: nonblankSchema, computedDueAt: utcTimestampSchema,
}).strict();
const referralProvenanceSchema = z.object({
  version: z.literal(1), sourceEventId: idSchema, sourceObservedAt: utcTimestampSchema,
  calculation: z.literal('elapsed_hours'), hours: z.literal(48),
  policyId: z.null(), computedDueAt: utcTimestampSchema,
}).strict();
export const inboundSlaSchema = z.discriminatedUnion('kind', [
  noInboundSlaSchema,
  z.object({
    kind: z.literal('inbound_demo_permitted_minutes'), dueAt: utcTimestampSchema,
    sourceEventId: idSchema, provenance: demoProvenanceSchema,
  }).strict(),
  z.object({
    kind: z.literal('direct_referral_elapsed'), dueAt: utcTimestampSchema,
    sourceEventId: idSchema, provenance: referralProvenanceSchema,
  }).strict(),
]).superRefine((value, context) => {
  if (value.kind === 'none') return;
  if (
    value.sourceEventId !== value.provenance.sourceEventId
    || value.dueAt !== value.provenance.computedDueAt
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Inbound SLA relational fields must match canonical provenance.',
    });
  }
});

export const actionSettlementOutcomeSchema = z.enum([
  'answered', 'no_answer', 'voicemail_left', 'accepted', 'replied',
  'opted_out', 'channel_unavailable', 'marked_impossible', 'resolved',
  'reviewed_ready', 'lost_nurture', 'upgraded', 'interviewed_confirmed',
  'offered_confirmed', 'won_confirmed', 'onboarding_waived', 'phase_completed',
]);

const settlementEvidenceRequired = new Set<z.infer<typeof actionSettlementOutcomeSchema>>([
  'answered', 'no_answer', 'voicemail_left', 'accepted', 'replied',
  'opted_out', 'channel_unavailable', 'marked_impossible',
  'interviewed_confirmed', 'offered_confirmed',
]);

export const actionSettlementSchema = z.object({
  version: z.literal(1),
  outcome: actionSettlementOutcomeSchema,
  reason: z.string().nullable(),
  evidenceActivityId: idSchema.nullable(),
  plannerTransition: z.object({
    definitionId: idSchema.nullable(), stepId: idSchema.nullable(),
    componentId: idSchema.nullable(), attempt: z.number().int().safe().positive().nullable(),
    outcome: actionSettlementOutcomeSchema,
  }).strict(),
  cadence: cadenceActionBindingSchema,
  workIntent: workIntentSchema,
  inboundSla: inboundSlaSchema,
}).strict().superRefine((value, context) => {
  const evidenceRequired = settlementEvidenceRequired.has(value.outcome);
  if (evidenceRequired !== (value.evidenceActivityId !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: evidenceRequired
        ? 'This settlement outcome requires immutable Activity evidence.'
        : 'This internal or terminal outcome does not accept Activity evidence.',
    });
  }
  const exactReason = value.outcome === 'opted_out' ? value.reason === 'person_wide_opt_out'
    : value.outcome === 'marked_impossible' || value.outcome === 'onboarding_waived'
      ? (value.reason?.trim().length ?? 0) > 0
      : value.outcome === 'lost_nurture'
        ? [
            'no_response', 'not_interested', 'bad_timing', 'not_decision_maker',
            'not_qualified', 'price', 'trust', 'chose_alternative', 'product_gap',
            'cadence_exhausted', 'disqualified', 'other',
          ].includes(value.reason ?? '')
        : value.outcome === 'upgraded'
          ? ['live_vacancy', 'inbound_demo', 'direct_referral'].includes(value.reason ?? '')
          : value.reason === null;
  if (!exactReason) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Settlement reason does not match its exact outcome discriminant.',
    });
  }
  const cadenceAttemptPresent = value.cadence.cadenceEnrollmentId !== null;
  if (cadenceAttemptPresent !== (value.plannerTransition.attempt !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Cadence settlements require an exact positive scheduled-step attempt.',
    });
  }
});

export function serializeCanonical(value: unknown): string {
  return canonicalJson(value);
}

export function parseCanonicalJson<T>(text: string, schema: z.ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new z.ZodError([{ code: 'custom', path: [], message: 'Stored JSON is malformed.' }]);
  }
  const parsed = schema.parse(value);
  if (canonicalJson(parsed) !== text) {
    throw new z.ZodError([{ code: 'custom', path: [], message: 'Stored JSON is not canonical.' }]);
  }
  return parsed;
}
