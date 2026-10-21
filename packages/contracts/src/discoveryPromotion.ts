import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { uuid } from './foundationRows.ts';
import { candidateInputSchema } from './sourcing.ts';
import { discoveryProviderSchema } from './discoveryIntake.ts';

// Preparation only. An entered human seed is not a native source observation,
// qualification verdict, first-party verification or permission to contact.
export const discoveryPromotionSourceSchema = z.strictObject({
  provider: discoveryProviderSchema,
  release: z.string().min(1).max(200),
  recordId: z.string().min(1).max(500),
});
export const discoveryPromotionInputSchema = z.strictObject({
  discoveryCandidateId: uuid,
  expectedRevision: z.number().int().positive(),
  source: discoveryPromotionSourceSchema,
  candidate: candidateInputSchema,
});
export type DiscoveryPromotionInput = z.infer<typeof discoveryPromotionInputSchema>;
export const discoveryPromotionCommandSchema = discoveryPromotionInputSchema.extend({
  commandId: commandIdSchema,
  clientVersion: semanticVersionSchema,
});
export const discoveryPromotionSavedSchema = z.strictObject({
  discoveryCandidateId: uuid,
  discoveryRevision: z.number().int().positive(),
  qualificationCandidateId: uuid,
  alreadyPrepared: z.boolean(),
  nextAction: z.literal('review_source_and_request_qualification'),
  qualificationRequested: z.literal(false),
  admissionAuthorized: z.literal(false),
  runtimeCallable: z.literal(false),
});
