import { z } from 'zod';

import {
  fitBandSchema, mutationReceiptSchema, personIdSchema, reachabilitySchema,
  salesCycleIdSchema, timingBandSchema,
} from './commonContract';
import type { MutationReceipt } from './commonContract';

// Reject rather than normalize boundary values. No runtime dependency on main.
const canonicalText = (max: number) => z.string().min(1).max(max)
  .refine(value => value.trim() === value
    && [...value].every(char => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127), 'Expected canonical text');
const idSchema = canonicalText(256);
const personSchema = personIdSchema.and(idSchema);
const cycleSchema = salesCycleIdSchema.and(idSchema);
const uuidSchema = z.string().uuid().refine(value => value === value.toLowerCase(), 'Expected canonical UUID');
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const utcSchema = z.string().datetime({ precision: 3, offset: false }).refine(value => {
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}, 'Expected canonical UTC milliseconds');
const localDateSchema = z.string().date();
const textSchema = canonicalText(2_000);
const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const discoveryDispositionSchema = z.enum(['candidate', 'research', 'judgment', 'watch', 'excluded']);
export const discoveryEvidenceRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('source'), sourceEventId: idSchema, field: canonicalText(256), observedAt: utcSchema }).strict(),
  z.object({ kind: z.literal('activity'), activityId: idSchema, field: canonicalText(256), observedAt: utcSchema }).strict(),
  z.object({
    kind: z.literal('utterance'), activityId: idSchema, transcriptId: idSchema,
    utteranceId: idSchema, quote: z.string().min(1).max(8_000).refine(value => value.trim().length > 0), observedAt: utcSchema,
  }).strict(),
]);
export const discoveryClaimSchema = z.object({
  id: idSchema, label: canonicalText(512),
  value: z.union([z.string().max(8_000), z.number().finite(), z.boolean(), z.null()]),
  certainty: z.enum(['fact', 'inference', 'unknown']),
  refs: z.array(discoveryEvidenceRefSchema).max(20),
}).strict().refine(claim => claim.certainty !== 'fact' || claim.refs.length > 0, {
  path: ['refs'], message: 'A fact requires at least one evidence reference',
});

export const discoveryAxesSchema = z.object({
  fit: z.object({
    points: z.number().int().min(0).max(30), band: fitBandSchema,
    completeness: z.enum(['complete', 'partial']),
  }).strict().refine(fit => fit.band === (fit.points <= 9 ? 'low' : fit.points <= 19 ? 'medium' : 'high'), {
    path: ['band'], message: 'Fit band must match local 0-30 points',
  }).nullable(),
  timing: z.object({
    milliPoints: z.number().int().min(0).max(40_000), band: timingBandSchema,
    hasSupportedTrigger: z.boolean(),
  }).strict().superRefine((timing, ctx) => {
    const band = timing.milliPoints <= 7_999 ? 'cold' : timing.milliPoints <= 19_999 ? 'warm' : 'hot';
    if (timing.band !== band) ctx.addIssue({ code: 'custom', path: ['band'], message: 'Timing band must match local millipoints' });
    if (timing.hasSupportedTrigger !== (timing.milliPoints >= 1_000)
      || (timing.milliPoints > 0 && timing.milliPoints < 1_000)) {
      ctx.addIssue({ code: 'custom', path: ['hasSupportedTrigger'], message: 'Timing requires an active supported contributor above threshold' });
    }
  }),
  reachability: reachabilitySchema,
}).strict();

export const discoveryAssessmentSchema = z.object({
  id: uuidSchema, personId: personSchema, prospectId: idSchema, salesCycleId: cycleSchema,
  fingerprint: fingerprintSchema, policyVersion: z.literal('discovery-v1'), ruleVersionId: idSchema,
  modelVersion: canonicalText(256).nullable(), evaluatedAt: utcSchema, expiresAt: utcSchema,
  localDate: localDateSchema, overrideId: uuidSchema.nullable(),
  disposition: discoveryDispositionSchema, reasonCodes: z.array(canonicalText(256)).max(50),
  axes: discoveryAxesSchema, claims: z.array(discoveryClaimSchema).max(100),
  unknowns: z.array(textSchema).max(50), questions: z.array(textSchema).max(3),
  identitySupported: z.boolean(), needsResearch: z.boolean(),
  ranking: z.object({
    priority: z.enum(['p0', 'p1', 'p2', 'p3']).nullable(),
    earliestTriggerExpiresAt: utcSchema.nullable(), dataConfidence: z.number().int().min(0).max(10),
    lastContactAt: utcSchema.nullable(), latestSourceObservedAt: utcSchema.nullable(),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  if (value.expiresAt <= value.evaluatedAt) issue(['expiresAt'], 'Expiry must follow evaluation');
  for (const key of ['lastContactAt', 'latestSourceObservedAt'] as const) {
    const instant = value.ranking[key];
    if (instant !== null && instant > value.evaluatedAt) issue(['ranking', key], 'Evidence cannot be in the future');
  }
  const expiry = value.ranking.earliestTriggerExpiresAt;
  if (expiry !== null && (expiry <= value.evaluatedAt || !value.axes.timing.hasSupportedTrigger)) {
    issue(['ranking', 'earliestTriggerExpiresAt'], 'Only a current supported trigger can expire');
  }
  value.claims.forEach((claim, i) => claim.refs.forEach((ref, j) => {
    if (ref.observedAt > value.evaluatedAt) issue(['claims', i, 'refs', j, 'observedAt'], 'Evidence cannot be in the future');
  }));
  const { fit, timing, reachability } = value.axes;
  const priority = value.ranking.priority;
  if (value.disposition === 'candidate' && !value.identitySupported) {
    issue(['identitySupported'], 'Candidates require supported identity');
  }
  if (priority !== null) {
    if (value.disposition !== 'candidate' || fit === null || fit.band === 'low') {
      issue(['ranking', 'priority'], 'Only primary candidates have provisional priority');
    } else {
      const expected = timing.band === 'cold' ? 'p3'
        : timing.band === 'warm' ? (fit.band === 'high' ? 'p1' : 'p2')
          : fit.band === 'high' && reachability === 'direct' ? 'p0' : 'p1';
      // High/hot/direct may be capped at P1 by the canonical nurture-only rule.
      if (priority !== expected && !(expected === 'p0' && priority === 'p1')) {
        issue(['ranking', 'priority'], 'Priority contradicts the local matrix');
      }
    }
  } else if (value.disposition === 'candidate' && fit !== null
    && (fit.band !== 'low' || fit.completeness !== 'partial')) {
    issue(['ranking', 'priority'], 'Only incomplete non-primary Fit belongs to exploration');
  }
});

export const discoveryOverrideSchema = z.object({
  id: uuidSchema, assessmentId: uuidSchema, decision: z.enum(['watch', 'exclude', 'reconsider']),
  reason: textSchema, createdAt: utcSchema, evidenceChanged: z.boolean(),
}).strict();
export const discoveryBriefSchema = z.object({
  personId: personSchema, salesCycleId: cycleSchema, personName: canonicalText(512),
  assessment: discoveryAssessmentSchema.nullable(), stale: z.boolean(),
  latestOverride: discoveryOverrideSchema.nullable(),
  pilotNextStep: z.object({ label: textSchema, activityIds: z.array(idSchema).min(1).max(100) }).strict().nullable(),
}).strict().superRefine((brief, ctx) => {
  if (brief.assessment === null) return; // Renderer labels this Not assessed.
  for (const key of ['personId', 'salesCycleId'] as const) {
    if (brief[key] !== brief.assessment[key]) ctx.addIssue({ code: 'custom', path: ['assessment', key], message: 'Assessment belongs to a different owner/cycle' });
  }
});
export const discoverySnapshotSchema = z.object({
  prepared: z.array(discoveryBriefSchema).max(10), judgment: z.array(discoveryBriefSchema).max(20),
  counts: z.object({ unassessed: countSchema, research: countSchema, watch: countSchema, excluded: countSchema }).strict(),
  processing: z.enum(['idle', 'running', 'paused', 'error']),
  researchCapability: z.enum(['not_configured', 'available']),
  generatedAt: utcSchema, revision: countSchema,
}).strict().superRefine((snapshot, ctx) => {
  for (const bucket of ['prepared', 'judgment'] as const) {
    snapshot[bucket].forEach((brief, index) => {
      if (brief.assessment !== null && brief.assessment.evaluatedAt > snapshot.generatedAt) {
        ctx.addIssue({ code: 'custom', path: [bucket, index, 'assessment', 'evaluatedAt'], message: 'Assessment cannot postdate the snapshot' });
      }
      if (brief.latestOverride !== null && brief.latestOverride.createdAt > snapshot.generatedAt) {
        ctx.addIssue({ code: 'custom', path: [bucket, index, 'latestOverride', 'createdAt'], message: 'Override cannot postdate the snapshot' });
      }
    });
  }
});
export const discoveryBriefRequestSchema = z.object({ personId: personSchema }).strict();
export const beginDiscoveryRequestSchema = z.object({
  commandId: uuidSchema, personId: personSchema, salesCycleId: cycleSchema,
  assessmentId: uuidSchema, expectedFingerprint: fingerprintSchema,
}).strict();
export const beginDiscoveryReceiptSchema = z.object({
  mutation: mutationReceiptSchema.extend({
    revision: countSchema, affectedPersonIds: z.array(personSchema).max(100),
    affectedSalesCycleIds: z.array(cycleSchema).max(100),
  }).strict(),
  personId: personSchema, salesCycleId: cycleSchema, assessmentId: uuidSchema, actionId: idSchema,
}).strict().superRefine((receipt, ctx) => {
  if (!receipt.mutation.affectedPersonIds.includes(receipt.personId)) {
    ctx.addIssue({ code: 'custom', path: ['personId'], message: 'Receipt must identify the affected Person' });
  }
  if (!receipt.mutation.affectedSalesCycleIds.includes(receipt.salesCycleId)) {
    ctx.addIssue({ code: 'custom', path: ['salesCycleId'], message: 'Receipt must identify the affected cycle' });
  }
});
export const overrideDiscoveryRequestSchema = z.object({
  commandId: uuidSchema, personId: personSchema, assessmentId: uuidSchema,
  expectedFingerprint: fingerprintSchema, decision: z.enum(['watch', 'exclude', 'reconsider']), reason: textSchema,
}).strict();

export type DiscoveryDisposition = z.infer<typeof discoveryDispositionSchema>;
export type DiscoveryEvidenceRef = z.infer<typeof discoveryEvidenceRefSchema>;
export type DiscoveryClaim = z.infer<typeof discoveryClaimSchema>;
export type DiscoveryAxes = z.infer<typeof discoveryAxesSchema>;
export type DiscoveryAssessment = z.infer<typeof discoveryAssessmentSchema>;
export type DiscoveryOverride = z.infer<typeof discoveryOverrideSchema>;
export type DiscoveryBrief = z.infer<typeof discoveryBriefSchema>;
export type DiscoverySnapshot = z.infer<typeof discoverySnapshotSchema>;
export type DiscoveryBriefRequest = z.infer<typeof discoveryBriefRequestSchema>;
export type BeginDiscoveryRequest = z.infer<typeof beginDiscoveryRequestSchema>;
export type BeginDiscoveryReceipt = z.infer<typeof beginDiscoveryReceiptSchema>;
export type OverrideDiscoveryRequest = z.infer<typeof overrideDiscoveryRequestSchema>;
export type DiscoveryApi = {
  get(): Promise<DiscoverySnapshot>;
  getBrief(input: DiscoveryBriefRequest): Promise<DiscoveryBrief>;
  begin(input: BeginDiscoveryRequest): Promise<BeginDiscoveryReceipt>;
  override(input: OverrideDiscoveryRequest): Promise<MutationReceipt>;
};
