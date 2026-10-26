import { z } from 'zod';
import { instant, sha256Hex, uuid } from './foundationRows.ts';

/** Internal source-build contract, not browser input or permission to send.
 * Existing campaign/template approval never implies opening-policy approval.
 * V1 chooses among explicitly approved phrases, never accepts model-authored prose.
 */
const line = z.string().trim().min(1).max(400).refine(value => !/[\r\n]/u.test(value));
export const campaignOpeningVariantSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/u),
  // Only these source-backed placeholders may be rendered by the domain owner.
  text: line.refine(value => {
    const stripped = value.replaceAll(/\{\{(?:firm_name|firm_locality|firm_region)\}\}/gu, '');
    return !/[{}<>]/u.test(stripped);
  }),
});
export const campaignOpeningPolicySchema = z.strictObject({
  id: uuid, workspaceId: uuid, ownerUserId: uuid,
  campaignId: uuid, campaignRevision: z.number().int().positive(),
  sequenceVersionId: uuid, templateVersionId: uuid, templateContentHash: sha256Hex,
  revision: z.literal(1), mode: z.literal('approved_variant_selection_v1'),
  firstEmailOnly: z.literal(true),
  variants: z.array(campaignOpeningVariantSchema).min(1).max(8)
    .refine(values => new Set(values.map(value => value.id)).size === values.length),
  approvedAt: instant, expiresAt: instant,
}).refine(value => Date.parse(value.expiresAt) > Date.parse(value.approvedAt));
export type CampaignOpeningPolicy = z.infer<typeof campaignOpeningPolicySchema>;

/** Model/selector output is a choice, not evidence or approval. The owner must
 * resolve every reference against its current exact qualified source snapshot.
 */
export const campaignOpeningChoiceSchema = z.strictObject({
  variantId: campaignOpeningVariantSchema.shape.id,
  citationIds: z.array(z.string().min(1).max(200)).min(1).max(30)
    .refine(values => new Set(values).size === values.length),
});
export type CampaignOpeningChoice = z.infer<typeof campaignOpeningChoiceSchema>;

/** Opaque binding retained through ambiguous selection and send preparation.
 * Source selection/revision is reloaded by the owner, never trusted from a caller.
 * No prose, endpoint, credential or client-authoritative eligibility is included.
 */
export const campaignOpeningBindingSchema = z.strictObject({
  workspaceId: uuid, ownerUserId: uuid, campaignId: uuid,
  campaignRevision: z.number().int().positive(), policyId: uuid,
  sequenceVersionId: uuid, templateVersionId: uuid, templateContentHash: sha256Hex,
  enrollmentId: uuid, executionId: uuid, firmId: uuid,
  candidateId: uuid, candidateRevision: z.number().int().positive(),
  qualificationRunId: uuid, sourceFingerprint: sha256Hex, validUntil: instant,
});
export type CampaignOpeningBinding = z.infer<typeof campaignOpeningBindingSchema>;
