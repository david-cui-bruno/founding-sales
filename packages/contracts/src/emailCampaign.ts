import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { instant, uuid } from './foundationRows.ts';

/** Campaign approval is distinct from published content and never enables sending. */
export const emailCampaignPolicySchema = z.strictObject({
  mailboxId: uuid,
  sequenceVersionId: uuid,
  authorizationRevision: z.number().int().positive(),
  regions: z.array(z.enum(['TX', 'RI', 'MA'])).min(1).max(3).refine(values => new Set(values).size === values.length),
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
