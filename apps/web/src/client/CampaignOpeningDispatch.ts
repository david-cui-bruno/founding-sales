import { z } from 'zod';
import { campaignOpeningApproveInputSchema, campaignOpeningRevokeInputSchema, campaignOpeningControlSchema,
  campaignOpeningCommandResultSchema, campaignOpeningReceiptSchema,
  type CampaignOpeningApproveInput, type CampaignOpeningControl, type CampaignOpeningReceipt } from '@fss/contracts';
import type { BrowserClient } from './BrowserClient.ts';
import { CampaignOpeningCustody, type CampaignOpeningStorage } from './CampaignOpeningPending.ts';
const commandResult = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('accepted'), replayed: z.boolean(), result: campaignOpeningCommandResultSchema }),
  z.strictObject({ status: z.literal('refused'), replayed: z.boolean(), reason: z.string().min(1).max(100) }),
]);
export interface CampaignOpeningReadback { receipt: CampaignOpeningReceipt; current: CampaignOpeningControl | null }
export class CampaignOpeningDispatch {
  readonly custody: CampaignOpeningCustody;
  constructor(readonly browser: BrowserClient, storage?: CampaignOpeningStorage) { this.custody = new CampaignOpeningCustody(browser, storage); }
  async control(campaignId: string): Promise<CampaignOpeningControl> {
    const value = await this.browser.request('/outreach/email-campaigns/opening/control', campaignOpeningControlSchema, { campaignId });
    if (value.campaignId !== campaignId) throw Error('Opening control target mismatch');
    return value;
  }
  async approve(raw: CampaignOpeningApproveInput, viewed: CampaignOpeningControl, current: () => boolean): Promise<CampaignOpeningReadback> {
    const payload = campaignOpeningApproveInputSchema.parse(raw);
    return this.write('approve', payload, viewed, current);
  }
  async revoke(viewed: CampaignOpeningControl, current: () => boolean): Promise<CampaignOpeningReadback> {
    if (!viewed.policy) throw Error('Read the exact configured policy first');
    const payload = campaignOpeningRevokeInputSchema.parse({ campaignId: viewed.campaignId, expectedCampaignRevision: viewed.campaignRevision,
      policyId: viewed.policy.value.id, policyRevision: viewed.policy.value.revision });
    return this.write('revoke', payload, viewed, current);
  }
  private async write(action: 'approve' | 'revoke', payload: CampaignOpeningApproveInput | z.infer<typeof campaignOpeningRevokeInputSchema>, viewed: CampaignOpeningControl, current: () => boolean): Promise<CampaignOpeningReadback> {
    return this.custody.exclusive(async () => {
      if (!current() || this.custody.read()) throw Error('Reconcile the original opening command first');
      const fresh = await this.control(payload.campaignId);
      if (!current() || JSON.stringify(fresh) !== JSON.stringify(viewed)) throw Error('Opening selection changed. Read current policy explicitly');
      if (action === 'approve' && (fresh.approvalState !== 'available' || !fresh.baseline || !('variants' in payload)
        || payload.templateVersionId !== fresh.baseline.templateVersionId || payload.templateContentHash !== fresh.baseline.templateContentHash
        || payload.expectedCampaignRevision !== fresh.campaignRevision || Date.parse(payload.expiresAt) <= Date.now()
        || Date.parse(payload.expiresAt) > Date.parse(fresh.campaignExpiresAt))) throw Error('Opening approval binding unavailable');
      const held = await this.custody.prepare(action, payload, current);
      // Persisted before dispatch. This is the ONLY write request. No retry API.
      const answer = await this.browser.request(`/outreach/email-campaigns/opening/${action}`, commandResult, { ...payload, commandId: held.commandId }, () => {
        if (!current()) throw Error('Opening selection changed');
        this.custody.assert(held);
      });
      if (!current()) throw Error('Opening selection changed');
      this.custody.assert(held);
      if (answer.status === 'refused') { this.custody.complete(held); return { receipt: { state: 'refused', reason: answer.reason }, current: null }; }
      const accepted = this.custody.accepted(held, answer.result);
      const control = await this.control(held.campaignId);
      if (!current()) throw Error('Opening selection changed');
      this.custody.complete(accepted);
      return { receipt: { state: 'accepted', result: answer.result }, current: control };
    });
  }
  /** Explicit read-only receipt recovery works after reload without copy/payload.
   * UNKNOWN never clears custody or permits another command, in any campaign. */
  async reconcile(current: () => boolean): Promise<CampaignOpeningReadback> {
    return this.custody.exclusive(async () => {
      const held = this.custody.read();
      if (!held || !current()) throw Error('Original opening command unavailable');
      const receipt = held.accepted ? { state: 'accepted' as const, result: held.accepted }
        : await this.browser.request('/outreach/email-campaigns/opening/receipt', campaignOpeningReceiptSchema,
          { commandId: held.commandId, payloadSHA256: held.payloadSHA256, action: held.action });
      if (!current()) throw Error('Opening selection changed');
      this.custody.assert(held);
      if (receipt.state === 'unknown') return { receipt, current: null };
      if (receipt.state === 'refused') { this.custody.complete(held); return { receipt, current: null }; }
      const accepted = held.accepted ? held : this.custody.accepted(held, receipt.result);
      const control = await this.control(held.campaignId);
      if (!current()) throw Error('Opening selection changed');
      this.custody.complete(accepted);
      return { receipt, current: control };
    });
  }
}
