import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { instant, uuid } from './foundationRows.ts';
import { discoveryPromotionSourceSchema } from './discoveryPromotion.ts';
import { todayActionV2Schema, todayActionsV2ResponseSchema, todayTargetV2Schema } from './todayActionsV2.ts';
import {nativeFirmPolicyVersionSchema} from './usBusinessGeography.ts';

/** IDs only: callers cannot submit qualification facts or manufacture source authority. */
export const qualifiedResearchSelectionSchema = z.strictObject({
  discoveryCandidateId: uuid,
  discoveryRevision: z.number().int().positive(),
  candidateId: uuid,
  candidateRevision: z.number().int().positive(),
  runId: uuid,
});
export type QualifiedResearchSelection = z.infer<typeof qualifiedResearchSelectionSchema>;
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const qualifiedResearchCitationSchema = z.strictObject({
  kind: z.enum(['firm_identity', 'service_area', 'residential_management']),
  observationId: uuid,
  blockId: z.string().min(1).max(80),
  url: z.string().url().max(2048),
  contentHash: hash,
  retrievedAt: instant,
  quote: z.string().min(1).max(8000),
});
/** Current server-evaluated fit, not email/call permission or verified unmet need. */
export const qualifiedResearchCandidateSchema = z.strictObject({
  selection: qualifiedResearchSelectionSchema,
  promotionId: uuid,
  source: discoveryPromotionSourceSchema,
  firmName: z.string().min(1).max(300),
  website: z.string().url().max(2048),
  locality: z.string().min(1).max(120),
  region: z.string().regex(/^[A-Z]{2}$/u),
  policyVersion: nativeFirmPolicyVersionSchema,
  evidenceFingerprint: hash,
  validUntil: instant,
  citations: z.array(qualifiedResearchCitationSchema).min(3).max(30),
  emailFit: z.enum(['eligible', 'unresolved']),
  channelAuthority: z.literal('not_granted'),
  maintenanceNeed: z.literal('not_established'),
});
export type QualifiedResearchCandidate = z.infer<typeof qualifiedResearchCandidateSchema>;
export const qualifiedResearchListRequestSchema = z.strictObject({ afterId: uuid.optional() });
export const qualifiedResearchListSchema = z.strictObject({
  candidates: z.array(qualifiedResearchCandidateSchema).max(25),
  nextAfterId: uuid.nullable(),
});
export const qualifiedResearchCreateCommandSchema = qualifiedResearchSelectionSchema.extend({
  commandId: commandIdSchema,
  clientVersion: semanticVersionSchema,
});
export const qualifiedResearchReadRequestSchema = z.strictObject({ firmId: uuid });
export const qualifiedResearchFirmSchema = qualifiedResearchCandidateSchema.extend({
  firmId: uuid,
  ownerUserId: uuid,
  nextStep: z.literal('prepare_discovery_conversation'),
  question: z.string().min(1).max(500),
});
export type QualifiedResearchFirm = z.infer<typeof qualifiedResearchFirmSchema>;

/** Additive queue version. Installed desktop V1/V2 readers retain their wire shapes. */
export const qualifiedResearchTargetSchema = qualifiedResearchSelectionSchema.extend({
  kind: z.literal('qualified_research'),
  firmId: uuid,
  promotionId: uuid,
  evidenceFingerprint: hash,
});
export const qualifiedResearchActionSchema = z.strictObject({
  actionId: z.string().min(1).max(200),
  kind: z.literal('research'),
  subject: z.string().min(1).max(300),
  reason: z.literal('qualified_research_ready'),
  dueAt: instant,
  state: z.literal('open'),
  target: qualifiedResearchTargetSchema,
});
export const todayActionV3Schema = z.union([todayActionV2Schema, qualifiedResearchActionSchema]);
export const todayTargetV3Schema = z.union([todayTargetV2Schema, qualifiedResearchTargetSchema]);
export const todayActionsV3ResponseSchema = todayActionsV2ResponseSchema.extend({
  version: z.literal(3),
  actions: z.array(todayActionV3Schema),
});
export const todayActionOpenV3RequestSchema = z.strictObject({
  actionId: z.string().min(1).max(200),
  target: todayTargetV3Schema,
});
export const todayActionOpenV3ResponseSchema = z.strictObject({
  version: z.literal(3),
  target: todayTargetV3Schema.nullable(),
  research: qualifiedResearchFirmSchema.nullable(),
});
export type TodayActionsV3Response = z.infer<typeof todayActionsV3ResponseSchema>;
export type TodayActionV3 = z.infer<typeof todayActionV3Schema>;
export type TodayTargetV3 = z.infer<typeof todayTargetV3Schema>;
