import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { discoveryIntakeCandidateSchema, discoveryProviderSchema } from './discoveryIntake.ts';
import { instant, uuid } from './foundationRows.ts';
import { candidateStatusSchema, sourcingUrlSchema } from './sourcing.ts';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
export const discoveryReviewSourceSchema = z.strictObject({
  provider: discoveryProviderSchema, release: z.string().min(1).max(200), recordId: z.string().min(1).max(500),
});
// Human-reviewed excerpts are not complete native observations or verified firm identity.
export const discoveryReviewEvidenceSchema = z.strictObject({
  source: discoveryReviewSourceSchema, url: sourcingUrlSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u), retrievedAt: instant,
  completeness: z.enum(['complete', 'partial', 'unknown']),
  association: z.enum(['unknown', 'supported', 'ambiguous']),
  basis: z.literal('retained_excerpt'),
  blocks: z.array(z.strictObject({
    blockId: z.string().min(1).max(80), kind: z.enum(['paragraph', 'heading', 'unknown']),
    text: z.string().trim().min(1).max(2000),
  })).min(1).max(20),
}).superRefine((value, ctx) => {
  if (new Set(value.blocks.map(block => block.blockId)).size !== value.blocks.length) {
    ctx.addIssue({code: 'custom', message: 'Excerpt block identities must be unique.'});
  }
});
export const discoveryReviewAssessmentSchema = z.strictObject({
  serviceSignal: z.enum(['paragraph_supported', 'tentative', 'unknown', 'contradicted']),
  websiteAssociation: z.enum(['unknown', 'supported', 'ambiguous']),
  unknowns: z.array(z.string().trim().min(1).max(120)).max(30),
});
export const discoveryReviewInputSchema = z.strictObject({
  candidateId: uuid, expectedRevision: z.number().int().positive(), reviewVersion: z.literal('discovery-review-v1'),
  evidence: z.array(discoveryReviewEvidenceSchema).max(8), assessment: discoveryReviewAssessmentSchema,
}).superRefine((value, ctx) => {
  if (bytes(value.evidence) > 32768 || bytes(value.assessment) > 8192) {
    ctx.addIssue({code: 'custom', message: 'Review excerpts exceed the bounded UTF-8 payload.'});
  }
  if (value.assessment.serviceSignal === 'paragraph_supported' &&
      !value.evidence.some(page => page.blocks.some(block => block.kind === 'paragraph'))) {
    ctx.addIssue({code: 'custom', message: 'A paragraph signal requires a reviewed paragraph, not a heading.'});
  }
  if (value.assessment.serviceSignal !== 'unknown' && value.evidence.length === 0) {
    ctx.addIssue({code: 'custom', message: 'A service interpretation requires retained supporting evidence.'});
  }
});
export type DiscoveryReviewInput = z.infer<typeof discoveryReviewInputSchema>;
export const discoveryReviewCommandSchema = discoveryReviewInputSchema.safeExtend({
  commandId: commandIdSchema, clientVersion: semanticVersionSchema,
});
export const discoveryReviewSchema = z.strictObject({
  id: uuid, candidateId: uuid, candidateRevision: z.number().int().positive(),
  reviewVersion: z.literal('discovery-review-v1'), contentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  evidence: z.array(discoveryReviewEvidenceSchema).max(8), assessment: discoveryReviewAssessmentSchema,
  reviewedAt: instant,
});
export const discoveryReviewSavedSchema = z.strictObject({review: discoveryReviewSchema, alreadyRecorded: z.boolean()});
export const discoveryPriorityBandSchema = z.enum(['review_first', 'tentative', 'unreviewed', 'contradicted']);
export const discoveryUsefulListInputSchema = z.strictObject({
  status: candidateStatusSchema, offset: z.number().int().min(0).max(1000000),
  band: discoveryPriorityBandSchema.optional(),
});
export const discoveryUsefulListSchema = z.strictObject({
  candidates: z.array(z.strictObject({
    candidate: discoveryIntakeCandidateSchema, review: discoveryReviewSchema.nullable(),
    band: discoveryPriorityBandSchema,
    admissionAuthorized: z.literal(false), runtimeCallable: z.literal(false),
  })).max(50), hasMore: z.boolean(),
});
