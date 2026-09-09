import { z } from 'zod';
import { accountIdSchema as id, accountInstantSchema as instant } from './accountContract';

export const campaignRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision = campaignRevisionSchema;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const campaignChannelSchema = z.enum(['call', 'email', 'linkedin']);
export const campaignStepSchema = z.strictObject({ id, channel: campaignChannelSchema,
  condition: z.enum(['initial', 'requested_info', 'no_reply']), delayHours: z.number().finite().nonnegative().max(8760) });
export const campaignVersionSchema = z.strictObject({ id, campaignId: id, version: revision.positive(), audienceHash: hash,
  offer: z.string().trim().min(1).max(4000), objective: z.literal('meeting'),
  cohortAccountIds: z.array(id).min(1).max(1000).refine(ids => new Set(ids).size === ids.length), approvedAt: instant.nullable(),
  steps: z.array(campaignStepSchema).min(1).max(100).refine(steps => new Set(steps.map(step => step.id)).size === steps.length)
    .refine(steps => steps[0]?.condition === 'initial' && steps.slice(1).every(step => step.condition !== 'initial')),
  capScope: z.literal('campaign_version_lifetime'), channelCaps: z.strictObject({ call: revision, email: revision, linkedin: revision }), contentPolicyHash: hash });
export type CampaignVersion = z.infer<typeof campaignVersionSchema>;
export const enrollmentStateSchema = z.enum(['active', 'held', 'paused', 'conversation', 'completed', 'stopped']);
export const enrollmentSchema = z.strictObject({ id, accountId: id, selectedRouteId: id, selectedRouteVersion: revision.positive(), personId: id.nullable(), campaignVersionId: id,
  currentStepId: id.nullable(), version: revision.positive(), state: enrollmentStateSchema, executionContextId: id, contextRevision: revision, startedAt: instant });
export type Enrollment = z.infer<typeof enrollmentSchema>;
export const stepEvidenceSchema = z.strictObject({ enrollmentId: id, accountId: id, campaignVersionId: id, stepId: id, routeId: id, routeVersion: revision.positive(), outcome: z.string().min(1).max(200), observedAt: instant,
  observation: z.enum(['unknown', 'no_reply', 'replied']), source: z.enum(['provider', 'human']), executionContextId: id, contextRevision: revision,
  state: z.enum(['prepared', 'queued', 'dispatching', 'unknown', 'human_reported_sent', 'provider_accepted', 'cancelled']), actionId: id, channel: campaignChannelSchema });
export type StepEvidence = z.infer<typeof stepEvidenceSchema>;
export type CampaignDecision = { kind: 'wait' | 'prepare' | 'stop'; stepId: string | null; reason: string };
/** Payloads are embedded in C1's authenticated command envelope, not standalone execution authority. */
export const campaignCommandPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('campaign.version'), version: campaignVersionSchema }),
  z.strictObject({ kind: z.literal('campaign.approve'), campaignVersionId: id, snapshotHash: hash, approvedAt: instant }),
  z.strictObject({ kind: z.literal('campaign.enroll'), enrollmentId: id, campaignVersionId: id, selectedRouteId: id, executionContextId: id, contextRevision: revision }),
  z.strictObject({ kind: z.literal('campaign.state'), enrollmentId: id, expectedEnrollmentVersion: revision.positive(), state: enrollmentStateSchema, reason: z.string().min(1).max(2000) }),
  z.strictObject({ kind: z.literal('campaign.route'), enrollmentId: id, expectedEnrollmentVersion: revision.positive(), selectedRouteId: id, executionContextId: id, contextRevision: revision }),
  z.strictObject({ kind: z.literal('campaign.outcome'), enrollmentId: id, expectedEnrollmentVersion: revision.positive(), evidence: stepEvidenceSchema }),
]);
export type CampaignCommandPayload = z.infer<typeof campaignCommandPayloadSchema>;
export const campaignEventPayloadSchema = z.strictObject({ commandId: z.uuid(), version: campaignVersionSchema.nullable(),
  enrollment: enrollmentSchema.nullable(), evidence: stepEvidenceSchema.nullable() });
export type CampaignEventPayload = z.infer<typeof campaignEventPayloadSchema>;
