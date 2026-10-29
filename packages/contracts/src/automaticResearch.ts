import { z } from 'zod';
import { instant, uuid } from './foundationRows.ts';
import { qualifiedResearchCitationSchema, qualifiedResearchFirmSchema, todayActionV3Schema, todayActionsV3ResponseSchema, todayTargetV3Schema } from './qualifiedResearch.ts';
import {nativeFirmPolicyVersionSchema,usBusinessRegionSchema} from './usBusinessGeography.ts';

/** Automatic publication is worker-owned. This contract exposes current proof, not an activation command. */
export const automaticResearchSourceSchema = z.strictObject({
  kind: z.enum(['search_hit', 'apollo_organization']),
  attemptId: uuid,
  sourceUrl: z.string().url().max(2048),
});
export const automaticResearchTargetSchema = z.strictObject({
  kind: z.literal('automatic_research'),
  publicationId: uuid,
  publicationRevision: z.number().int().positive(),
  firmId: uuid,
  candidateId: uuid,
  candidateRevision: z.number().int().positive(),
  runId: uuid,
  evidenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type AutomaticResearchTarget = z.infer<typeof automaticResearchTargetSchema>;
export const automaticResearchFirmSchema = z.strictObject({
  target: automaticResearchTargetSchema,
  source: automaticResearchSourceSchema,
  ownerUserId: uuid,
  firmName: z.string().min(1).max(300),
  website: z.string().url().max(2048),
  locality: z.string().min(1).max(120),
  region: usBusinessRegionSchema,
  policyVersion: z.literal('automatic-research-v1'),
  nativePolicyVersion: nativeFirmPolicyVersionSchema,
  checkedAt: instant,
  validUntil: instant,
  citations: z.array(qualifiedResearchCitationSchema).min(3).max(30),
  emailFit: z.literal('eligible'),
  channelAuthority: z.literal('not_granted'),
  maintenanceNeed: z.literal('not_established'),
  nextStep: z.literal('prepare_discovery_conversation'),
  question: z.string().min(1).max(500),
});
export type AutomaticResearchFirm = z.infer<typeof automaticResearchFirmSchema>;
export const automaticResearchActionSchema = z.strictObject({
  actionId: z.string().min(1).max(200),
  kind: z.literal('research'),
  subject: z.string().min(1).max(300),
  reason: z.literal('automatic_research_ready'),
  dueAt: instant,
  state: z.literal('open'),
  target: automaticResearchTargetSchema,
});
/** Additive version. No invented discovery promotion IDs and no V1/V2/V3 wire changes. */
export const todayActionV4Schema = z.union([todayActionV3Schema, automaticResearchActionSchema]);
export const todayTargetV4Schema = z.union([todayTargetV3Schema, automaticResearchTargetSchema]);
export const todayActionsV4ResponseSchema = todayActionsV3ResponseSchema.extend({ version: z.literal(4), actions: z.array(todayActionV4Schema) });
export const todayActionOpenV4RequestSchema = z.strictObject({ actionId: z.string().min(1).max(200), target: todayTargetV4Schema });
export const todayActionOpenV4ResponseSchema = z.strictObject({
  version: z.literal(4), target: todayTargetV4Schema.nullable(),
  research: qualifiedResearchFirmSchema.nullable(), automaticResearch: automaticResearchFirmSchema.nullable(),
});
export type TodayActionsV4Response = z.infer<typeof todayActionsV4ResponseSchema>;
export type TodayActionV4 = z.infer<typeof todayActionV4Schema>;
export type TodayTargetV4 = z.infer<typeof todayTargetV4Schema>;
