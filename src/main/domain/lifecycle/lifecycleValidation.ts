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

export const actionSettlementSchema = z.object({
  version: z.literal(1),
  outcome: nonblankSchema,
  reason: z.string().nullable(),
  evidenceActivityId: idSchema.nullable(),
  plannerTransition: z.object({
    definitionId: idSchema.nullable(), stepId: idSchema.nullable(),
    componentId: idSchema.nullable(), outcome: nonblankSchema,
  }).strict(),
  cadence: cadenceActionBindingSchema,
  workIntent: workIntentSchema,
  inboundSla: inboundSlaSchema,
}).strict();

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
