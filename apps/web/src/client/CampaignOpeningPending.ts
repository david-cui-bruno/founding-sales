import { z } from 'zod';
import { instant, uuid, sha256Hex, campaignOpeningCommandResultSchema } from '@fss/contracts';
import type { BrowserClient } from './BrowserClient.ts';
import { privateDraftCanonicalJson, privateDraftSHA256 } from './PrivateDraftCustody.ts';
export const CAMPAIGN_OPENING_PENDING_PREFIX = 'callie.browser.pending-campaign-opening.v1:';
export const campaignOpeningPendingSchema = z.strictObject({
  identity: z.string().min(1), expiresAt: instant, commandId: uuid, payloadSHA256: sha256Hex,
  action: z.enum(['approve', 'revoke']), campaignId: uuid, expectedCampaignRevision: z.number().int().positive(),
  accepted: campaignOpeningCommandResultSchema.optional(),
});
export type CampaignOpeningPending = z.infer<typeof campaignOpeningPendingSchema>;
export type CampaignOpeningStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const browserStorage: CampaignOpeningStorage = { getItem: key => globalThis.localStorage.getItem(key),
  setItem: (key, value) => { globalThis.localStorage.setItem(key, value); }, removeItem: key => { globalThis.localStorage.removeItem(key); } };
/** One stable principal-wide slot, not per campaign/tab. Unusable custody holds
 * replacement, including after expiry, rather than silently losing UNKNOWN. */
export class CampaignOpeningCustody {
  constructor(private readonly client: BrowserClient, private readonly storage: CampaignOpeningStorage = browserStorage) {}
  binding(): { key: string; identity: string; expiresAt: string } | null {
    const s = this.client.current;
    if (s?.status !== 'signed_in' || s.role !== 'admin' || !this.client.isCurrent(this.client.epoch)) return null;
    return { key: CAMPAIGN_OPENING_PENDING_PREFIX + JSON.stringify([s.workspaceId, s.userId, s.deviceId]),
      identity: JSON.stringify([s.workspaceId, s.userId, s.deviceId, s.role, s.revision]), expiresAt: s.expiresAt };
  }
  read(): CampaignOpeningPending | null {
    const binding = this.binding();
    if (!binding) return null;
    if (!globalThis.navigator?.locks) throw Error('Opening command exclusion unavailable');
    const raw = this.storage.getItem(binding.key);
    if (raw === null) return null;
    const held = campaignOpeningPendingSchema.parse(JSON.parse(raw));
    if (held.identity !== binding.identity || Date.parse(held.expiresAt) <= Date.now() || Date.parse(held.expiresAt) > Date.parse(binding.expiresAt))
      throw Error('Original opening command binding requires reconciliation');
    return held;
  }
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const binding = this.binding();
    if (!binding || !globalThis.navigator?.locks) throw Error('Opening command exclusion unavailable');
    return navigator.locks.request(binding.key, { mode: 'exclusive' }, async () => {
      if (this.binding()?.identity !== binding.identity) throw Error('Opening command authority changed');
      return work();
    });
  }
  async prepare(action: 'approve' | 'revoke', payload: { campaignId: string; expectedCampaignRevision: number }, current: () => boolean): Promise<CampaignOpeningPending> {
    const binding = this.binding();
    if (!binding || !current() || this.read()) throw Error('Reconcile the original opening command first');
    const payloadSHA256 = await privateDraftSHA256(privateDraftCanonicalJson(payload));
    if (!current() || this.binding()?.identity !== binding.identity || this.read()) throw Error('Opening command authority changed');
    const held = campaignOpeningPendingSchema.parse({ identity: binding.identity, expiresAt: binding.expiresAt, commandId: crypto.randomUUID(),
      payloadSHA256, action, campaignId: payload.campaignId, expectedCampaignRevision: payload.expectedCampaignRevision });
    this.store(held);
    return held;
  }
  assert(held: CampaignOpeningPending): void {
    if (JSON.stringify(this.read()) !== JSON.stringify(held)) throw Error('Opening command custody changed');
  }
  private store(held: CampaignOpeningPending): void {
    const binding = this.binding();
    if (!binding || binding.identity !== held.identity) throw Error('Opening command authority changed');
    const bytes = JSON.stringify(campaignOpeningPendingSchema.parse(held));
    this.storage.setItem(binding.key, bytes);
    if (this.storage.getItem(binding.key) !== bytes) throw Error('Opening command storage unavailable');
  }
  accepted(held: CampaignOpeningPending, result: z.infer<typeof campaignOpeningCommandResultSchema>): CampaignOpeningPending {
    this.assert(held);
    if (result.campaignId !== held.campaignId) throw Error('Opening receipt target mismatch');
    const next = { ...held, accepted: result };
    this.store(next);
    return next;
  }
  complete(held: CampaignOpeningPending): void {
    this.assert(held);
    const binding = this.binding();
    if (!binding) throw Error('Opening command authority changed');
    this.storage.removeItem(binding.key);
    if (this.storage.getItem(binding.key) !== null) throw Error('Opening command storage unavailable');
  }
}
