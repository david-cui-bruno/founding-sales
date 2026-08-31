import { z } from 'zod';

import { salesCycleReceiptSnapshotSchema } from '../lifecycle/reactivationContracts';
import type { ApplyOptOutInput, ApplyOptOutResult, PropagateOptOutInput } from './optOutTypes';
import {
  optOutHandleKindSchema,
  optOutIdSchema,
  optOutObservedChannelSchema,
  optOutUtcTimestampSchema,
} from './optOutTypes';

const nonblankSchema = z.string().trim().min(1);
const activityKindSchema = z.enum([
  'call', 'voicemail', 'text', 'email', 'interview', 'offer', 'note', 'job', 'system',
]);

export const optOutAppendActivitySchema = z.object({
  id: optOutIdSchema,
  personId: optOutIdSchema,
  prospectId: optOutIdSchema.nullable().optional(),
  salesCycleId: optOutIdSchema.nullable().optional(),
  cadenceEnrollmentId: optOutIdSchema.nullable().optional(),
  cadenceStepId: optOutIdSchema.nullable().optional(),
  cadenceComponentId: optOutIdSchema.nullable().optional(),
  kind: activityKindSchema,
  direction: z.enum(['inbound', 'outbound', 'internal']),
  channel: nonblankSchema,
  occurredAt: optOutUtcTimestampSchema,
  durationSeconds: z.number().int().safe().nonnegative().nullable().optional(),
  observedOutcome: z.string().nullable().optional(),
  adapter: nonblankSchema.nullable().optional(),
  providerIdempotencyKey: nonblankSchema.nullable().optional(),
  providerReference: z.string().nullable().optional(),
  consentPolicyRecordId: optOutIdSchema.nullable().optional(),
  recordingStorageRef: nonblankSchema.nullable().optional(),
  transcriptStorageRef: nonblankSchema.nullable().optional(),
  metadata: z.unknown().optional(),
}).strict().superRefine((value, context) => {
  if (value.providerIdempotencyKey != null && value.adapter == null) {
    context.addIssue({
      code: z.ZodIssueCode.custom, path: ['providerIdempotencyKey'],
      message: 'Provider idempotency requires an adapter.',
    });
  }
  const cadence = [value.cadenceEnrollmentId, value.cadenceStepId, value.cadenceComponentId];
  const present = cadence.filter((candidate) => candidate != null).length;
  if (present !== 0 && (present !== 3 || value.salesCycleId == null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom, path: ['cadenceEnrollmentId'],
      message: 'Cadence evidence must be complete.',
    });
  }
});

const optOutEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existing_activity'), activityId: optOutIdSchema }).strict(),
  z.object({ kind: z.literal('append_activity'), activity: optOutAppendActivitySchema }).strict(),
]);

export const applyOptOutInputSchema = z.object({
  personId: optOutIdSchema,
  tombstoneId: optOutIdSchema,
  requestedAt: optOutUtcTimestampSchema,
  policyVersion: z.literal('founder_opt_out_v1'),
  decision: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('structured_written'), channel: z.enum(['imessage', 'gmail']),
    }).strict(),
    z.object({
      kind: z.literal('founder_confirmed'), channel: z.enum(['manual', 'call']),
    }).strict(),
  ]),
  evidence: optOutEvidenceSchema,
  terminalStageEventId: optOutIdSchema.nullable(),
}).strict();

export const propagateOptOutInputSchema = z.object({
  sourceTombstoneId: optOutIdSchema,
  targetPersonId: optOutIdSchema,
  targetTombstoneId: optOutIdSchema,
  evidenceActivity: optOutAppendActivitySchema,
  terminalStageEventId: optOutIdSchema.nullable(),
}).strict();

export const retrospectiveOptOutInputSchema = z.object({
  personId: optOutIdSchema,
  reportedAt: optOutUtcTimestampSchema,
  activity: optOutAppendActivitySchema,
}).strict().superRefine((value, context) => {
  if (value.activity.direction !== 'outbound') {
    context.addIssue({
      code: z.ZodIssueCode.custom, path: ['activity', 'direction'],
      message: 'Retrospective touch evidence must be outbound.',
    });
  }
});

export const optOutTombstoneValueSchema = z.object({
  id: optOutIdSchema,
  personId: optOutIdSchema,
  requestedAt: optOutUtcTimestampSchema,
  observedChannel: optOutObservedChannelSchema,
  sourceActivityId: optOutIdSchema,
  evidenceRef: z.string().nullable(),
  policyVersion: z.literal('founder_opt_out_v1'),
  createdAt: optOutUtcTimestampSchema,
}).strict();

export const optOutHandleValueSchema = z.object({
  id: optOutIdSchema,
  tombstoneId: optOutIdSchema,
  kind: optOutHandleKindSchema,
  normalizedValue: nonblankSchema,
  createdAt: optOutUtcTimestampSchema,
}).strict();

export const applyOptOutResultSchema = z.object({
  tombstone: optOutTombstoneValueSchema,
  handles: z.array(optOutHandleValueSchema),
  cycle: salesCycleReceiptSnapshotSchema.nullable(),
  alreadyApplied: z.boolean(),
}).strict();

export const optOutClosureCommandSchema = z.discriminatedUnion('kind', [
  z.object({
    version: z.literal(1), kind: z.literal('apply'), input: applyOptOutInputSchema,
  }).strict(),
  z.object({
    version: z.literal(1), kind: z.literal('propagate'), input: propagateOptOutInputSchema,
  }).strict(),
]);

export const optOutClosureReceiptValueSchema = z.object({
  sourceActivityId: optOutIdSchema,
  operationKind: z.enum(['apply', 'propagate']),
  personId: optOutIdSchema,
  tombstoneId: optOutIdSchema,
  sourceTombstoneId: optOutIdSchema.nullable(),
  closedCycleId: optOutIdSchema.nullable(),
  terminalStageEventId: optOutIdSchema.nullable(),
  command: optOutClosureCommandSchema,
  result: applyOptOutResultSchema,
  createdAt: optOutUtcTimestampSchema,
}).strict().superRefine((value, context) => {
  const command = value.command;
  const applyInput = command.kind === 'apply' ? command.input as ApplyOptOutInput : null;
  const propagateInput = command.kind === 'propagate' ? command.input as PropagateOptOutInput : null;
  const sourceActivityId = applyInput !== null
    ? (applyInput.evidence.kind === 'existing_activity'
      ? applyInput.evidence.activityId : applyInput.evidence.activity.id)
    : propagateInput!.evidenceActivity.id;
  const personId = applyInput?.personId ?? propagateInput!.targetPersonId;
  const requestedTombstoneId = applyInput?.tombstoneId ?? propagateInput!.targetTombstoneId;
  const sourceTombstoneId = propagateInput?.sourceTombstoneId ?? null;
  const terminalStageEventId = (applyInput ?? propagateInput!).terminalStageEventId;
  if (value.operationKind !== value.command.kind
    || value.sourceActivityId !== sourceActivityId
    || value.personId !== personId
    || value.sourceTombstoneId !== sourceTombstoneId
    || value.terminalStageEventId !== terminalStageEventId
    || value.result.tombstone.id !== value.tombstoneId
    || value.result.tombstone.personId !== value.personId
    || (value.result.cycle?.id ?? null) !== value.closedCycleId
    || (value.result.cycle?.personId ?? value.personId) !== value.personId
    || (value.result.cycle === null && value.closedCycleId !== null)
    || (value.result.cycle !== null && value.closedCycleId === null)
    || (value.result.tombstone.id !== requestedTombstoneId && !value.result.alreadyApplied)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Opt-out closure receipt command and result ownership must match.',
    });
  }
  if (value.result.handles.some((handle) => handle.tombstoneId !== value.tombstoneId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['result', 'handles'],
      message: 'Receipt handles must belong to the retained tombstone.',
    });
  }
});

export type OptOutClosureCommand =
  | Readonly<{ version: 1; kind: 'apply'; input: ApplyOptOutInput }>
  | Readonly<{ version: 1; kind: 'propagate'; input: PropagateOptOutInput }>;

export type OptOutClosureReceipt = Readonly<{
  sourceActivityId: string;
  operationKind: 'apply' | 'propagate';
  personId: string;
  tombstoneId: string;
  sourceTombstoneId: string | null;
  closedCycleId: string | null;
  terminalStageEventId: string | null;
  command: OptOutClosureCommand;
  result: ApplyOptOutResult;
  createdAt: string;
}>;
