import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { instant, sha256Hex, uuid } from './foundationRows.ts';
import { campaignOpeningPolicySchema } from './campaignOpening.ts';

const revision = z.number().int().positive();
const target = { campaignId: uuid, expectedCampaignRevision: revision };
const envelope = { commandId: commandIdSchema, clientVersion: semanticVersionSchema };

/** Explicit copy approval, never campaign admission or sending authority.
 * Identity, policy ID/revision, sequence, approval time and mode are server-owned. */
export const campaignOpeningApproveInputSchema = z.strictObject({
  ...target, templateVersionId: uuid, templateContentHash: sha256Hex,
  variants: campaignOpeningPolicySchema.shape.variants, expiresAt: instant,
});
export const campaignOpeningRevokeInputSchema = z.strictObject({
  ...target, policyId: uuid, policyRevision: z.literal(1),
});
export const campaignOpeningApproveCommandSchema = campaignOpeningApproveInputSchema.extend(envelope);
export const campaignOpeningRevokeCommandSchema = campaignOpeningRevokeInputSchema.extend(envelope);
export const campaignOpeningControlRequestSchema = z.strictObject({ campaignId: uuid });

/** Exact, unrendered baseline bytes. Oversized/unavailable content is refused,
 * never truncated and presented as sufficient informed-approval evidence. */
export const campaignOpeningBaselineSchema = z.strictObject({
  sequenceVersionId: uuid, templateVersionId: uuid, templateVersion: revision,
  templateContentHash: sha256Hex, subject: z.string().max(100_000),
  body: z.string().max(100_000), approvedAt: instant,
});
export const campaignOpeningControlSchema = z.strictObject({
  campaignId: uuid, campaignRevision: revision, campaignExpiresAt: instant,
  baseline: campaignOpeningBaselineSchema.nullable(),
  policy: z.strictObject({
    value: campaignOpeningPolicySchema, revokedAt: instant.nullable(),
    state: z.enum(['active', 'expired', 'revoked', 'held']),
  }).nullable(),
  approvalState: z.enum(['available', 'unavailable', 'already_configured']),
  // This control does not inspect/install a worker selector or certify readiness.
  selectorReadiness: z.literal('not_established'),
  sendingAuthority: z.literal('unchanged'),
});
export const campaignOpeningCommandResultSchema = z.strictObject({
  campaignId: uuid, policyId: uuid, policyRevision: z.literal(1),
});
export const campaignOpeningReceiptInputSchema = z.strictObject({
  commandId: commandIdSchema, payloadSHA256: sha256Hex, action: z.enum(['approve', 'revoke']),
});
/** A historical result never grants current policy access or another dispatch. */
export const campaignOpeningReceiptSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('accepted'), result: campaignOpeningCommandResultSchema }),
  z.strictObject({ state: z.literal('refused'), reason: z.string().min(1).max(100) }),
  z.strictObject({ state: z.literal('unknown') }),
]);
export type CampaignOpeningApproveInput = z.infer<typeof campaignOpeningApproveInputSchema>;
export type CampaignOpeningRevokeInput = z.infer<typeof campaignOpeningRevokeInputSchema>;
export type CampaignOpeningControl = z.infer<typeof campaignOpeningControlSchema>;
export type CampaignOpeningCommandResult = z.infer<typeof campaignOpeningCommandResultSchema>;
export type CampaignOpeningReceipt = z.infer<typeof campaignOpeningReceiptSchema>;
