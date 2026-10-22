import { z } from 'zod';
import { emailCampaignPolicySchema, instant, uuid } from '@fss/contracts';

export const CAMPAIGN_PENDING_KEY = 'callie.browser.pending-campaign.v1';
export const campaignPendingSchema = z.strictObject({
  identity: z.string(), commandId: uuid, expiresAt: instant,
  action: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('approve'), policy: emailCampaignPolicySchema }),
    z.strictObject({ kind: z.literal('revoke'), id: uuid, expectedRevision: z.number().int().positive() }),
  ]),
  accepted: z.strictObject({ campaignId: uuid, revision: z.number().int().positive() }).optional(),
});
export type CampaignPending = z.infer<typeof campaignPendingSchema>;
export type CampaignAction = CampaignPending['action'];
