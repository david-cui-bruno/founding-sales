import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { instant, uuid } from './foundationRows.ts';
import { US_BUSINESS_REGIONS, usBusinessRegionSchema } from './usBusinessGeography.ts';

/** Campaign approval is distinct from published content and never enables sending. */
export const emailCampaignPolicySchema = z.strictObject({
  mailboxId: uuid,
  sequenceVersionId: uuid,
  authorizationRevision: z.number().int().positive(),
  regions: z.array(usBusinessRegionSchema).min(1).max(US_BUSINESS_REGIONS.length).refine(values => new Set(values).size === values.length),
  maxEnrollments: z.number().int().min(1).max(25),
  dailyAdmissionLimit: z.number().int().min(1).max(5),
  expiresAt: instant,
});
export type EmailCampaignPolicy = z.infer<typeof emailCampaignPolicySchema>;
const command = { commandId: commandIdSchema, clientVersion: semanticVersionSchema };
export const emailCampaignApproveCommandSchema = emailCampaignPolicySchema.extend(command);
export const emailCampaignRevokeCommandSchema = z.strictObject({
  id: uuid, expectedRevision: z.number().int().positive(), ...command,
});
export const emailCampaignSchema = emailCampaignPolicySchema.extend({
  id: uuid, revision: z.number().int().positive(), ownerUserId: uuid,
  approvedAt: instant, revokedAt: instant.nullable(),
  state: z.enum(['active', 'expired', 'revoked']),
  admittedCount: z.number().int().nonnegative(),
});
export type EmailCampaign = z.infer<typeof emailCampaignSchema>;
export const emailCampaignAdmissionSchema = z.strictObject({
  campaignId: uuid, firmId: uuid, contactId: uuid, routeId: uuid,
  planId: uuid, enrollmentId: uuid, candidateId: uuid, qualificationRunId: uuid,
  admittedAt: instant,
});
export type EmailCampaignAdmission = z.infer<typeof emailCampaignAdmissionSchema>;
export const emailCampaignControlRequestSchema = z.strictObject({});
export const emailCampaignControlSchema = z.strictObject({
  campaigns: z.array(emailCampaignSchema).max(25),
  admissions: z.array(emailCampaignAdmissionSchema).max(25),
  senders: z.array(z.strictObject({ id: uuid, label: z.string().max(320), authorizationRevision: z.number().int().positive() })).max(20),
  sequences: z.array(z.strictObject({ id: uuid, label: z.string().max(400) })).max(100),
  sendingAuthority: z.literal('unchanged'),
});
export type EmailCampaignControl = z.infer<typeof emailCampaignControlSchema>;
/** Receipts are public IDs only. Current policy/approval is read separately. */
export const emailCampaignCommandResultSchema = z.strictObject({
  campaignId: uuid, revision: z.number().int().positive(),
});
export type EmailCampaignCommandResult = z.infer<typeof emailCampaignCommandResultSchema>;
/** Admin-only read of who the next prepared admission pass would take (ADR0035/0036): each prepared company with its provider-found named
 * decision-maker, and how many companies still await enrichment. Never calls the provider, verifies, records or admits. */
export const emailCampaignPreparedPreviewRequestSchema = z.strictObject({
  limit: z.number().int().min(1).max(50).default(25),
  regions: z.array(usBusinessRegionSchema).min(1).max(US_BUSINESS_REGIONS.length).refine(values => new Set(values).size === values.length).default([...US_BUSINESS_REGIONS]),
});
export const emailCampaignPreparedPreviewSchema = z.strictObject({
  candidates: z.array(z.strictObject({
    candidateId: uuid, host: z.string().max(253), companyName: z.string().max(400), website: z.string().max(2000),
    locality: z.string().max(120), region: usBusinessRegionSchema,
    person: z.strictObject({
      firstName: z.string().max(100), lastName: z.string().max(100), title: z.string().max(200), email: z.string().max(320),
      /** `verified_guess` (ADR0038): not a published address: the company's host with the person's first name, kept only because a paid single-address check answered ok. */
      emailStatus: z.enum(['verified', 'published', 'verified_guess']), matchConfidence: z.enum(['high', 'medium']), provider: z.string().max(32), observedAt: instant, creditsSpent: z.number().int().min(0).max(9),
      /** An own-site person's citation (ADR0037): the company page and the words the name, title and address were read from. Null for a provider's person. */
      source: z.strictObject({ url: z.string().max(2048), blockId: z.string().max(64), quote: z.string().max(600) }).nullable(),
    }),
    verification: z.strictObject({ result: z.enum(['valid', 'invalid']), outcome: z.enum(['ok', 'drop']), checkedAt: instant }).nullable(),
  })).max(50),
  /** Prepared companies in the scan that no people source has been asked about yet (the next passes enrich them; a paid source within the daily credit cap). */
  awaitingEnrichment: z.number().int().nonnegative(),
  /** Companies with a current named decision-maker and no published address (ADR0037): shown to Calling, never admitted for email. */
  namedWithoutEmail: z.number().int().nonnegative(),
});
export type EmailCampaignPreparedPreview = z.infer<typeof emailCampaignPreparedPreviewSchema>;
