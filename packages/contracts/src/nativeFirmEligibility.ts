import { z } from 'zod';
import { instant, uuid } from './foundationRows.ts';
import {nativeFirmPolicyVersionSchema} from './usBusinessGeography.ts';

// A current online read, never a stored grant, cached Today badge or channel permission.
export const nativeFirmEligibilityReasonSchema = z.enum([
  'evidence_pending', 'evidence_unavailable', 'evidence_invalid', 'evidence_expired',
  'identity_unresolved', 'residential_fit_unresolved', 'service_area_unresolved',
  'geography_unsupported', 'source_unavailable', 'lineage_changed',
  'identity_ambiguous', 'owner_changed', 'latest_run_pending', 'latest_run_unavailable',
]);
const citationSchema = z.strictObject({
  kind: z.enum(['firm_identity', 'service_area', 'residential_management']),
  observationId: uuid,
  blockId: z.string().min(1).max(80),
});
const verifiedSchema = z.strictObject({
  status: z.literal('verified'),
  policyVersion: nativeFirmPolicyVersionSchema,
  promotionId: uuid, discoveryCandidateId: uuid,
  discoveryRevision: z.number().int().positive(),
  candidateId: uuid, candidateRevision: z.number().int().positive(),
  runId: uuid, firmId: uuid, ownerUserId: uuid,
  checkedAt: instant, validUntil: instant,
  citations: z.array(citationSchema).min(3).max(30),
  channelAuthority: z.literal('not_granted'),
}).superRefine((value, ctx) => {
  if (Date.parse(value.validUntil) <= Date.parse(value.checkedAt))
    ctx.addIssue({ code: 'custom', message: 'Current evidence must expire after this check.' });
  for (const kind of ['firm_identity', 'service_area', 'residential_management'] as const) {
    if (!value.citations.some(citation => citation.kind === kind))
      ctx.addIssue({ code: 'custom', message: 'Each native evidence role requires a citation.' });
  }
  const keys = value.citations.map(citation => `${citation.kind}:${citation.observationId}:${citation.blockId}`);
  if (new Set(keys).size !== keys.length)
    ctx.addIssue({ code: 'custom', message: 'Native citations must be unique.' });
});
export const nativeFirmEligibilitySchema = z.discriminatedUnion('status', [
  verifiedSchema,
  z.strictObject({ status: z.literal('pending'), reason: nativeFirmEligibilityReasonSchema,
    channelAuthority: z.literal('not_granted') }),
  z.strictObject({ status: z.literal('unavailable'), reason: nativeFirmEligibilityReasonSchema,
    channelAuthority: z.literal('not_granted') }),
]);
export type NativeFirmEligibility = z.infer<typeof nativeFirmEligibilitySchema>;
