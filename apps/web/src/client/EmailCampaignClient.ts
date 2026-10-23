import { z } from 'zod';
import { emailCampaignControlSchema, emailCampaignCommandResultSchema, type EmailCampaignControl } from '@fss/contracts';
import { BrowserBoundaryError, type BrowserClient } from './BrowserClient.ts';
import { CAMPAIGN_PENDING_KEY, campaignPendingSchema, type CampaignAction, type CampaignPending } from './CampaignPending.ts';

const receipt = z.strictObject({ status: z.literal('accepted'), replayed: z.boolean(), result: emailCampaignCommandResultSchema });
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
/** Uses the existing browser request boundary, never a separate authenticated transport. */
export class EmailCampaignClient {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly unsubscribe: () => void;
  private generation: number;
  private storageUnavailable = false;
  constructor(readonly browser: BrowserClient, private readonly storage: StoragePort = globalThis.sessionStorage,
    private readonly randomUUID: () => string = () => globalThis.crypto.randomUUID()) {
    this.generation = browser.epoch;
    this.unsubscribe = browser.subscribe(() => {
      if (this.generation !== browser.epoch || browser.current?.status === 'signed_out') this.clear();
      this.generation = browser.epoch;
      this.pending();
    });
    this.pending();
  }
  private identity(): string | null {
    const session = this.browser.current;
    if (!this.browser.isCurrent(this.browser.epoch) || session?.status !== 'signed_in' || session.role !== 'admin') return null;
    return JSON.stringify([session.workspaceId, session.userId, session.deviceId, session.role, session.revision]);
  }
  private clear(): void {
    clearTimeout(this.timer);
    try { this.storage.removeItem(CAMPAIGN_PENDING_KEY); } catch { /* Identity and expiry checks still fence retained storage. */ }
  }
  dispose(): void { clearTimeout(this.timer); this.unsubscribe(); }
  pending(): CampaignPending | null {
    let raw: string | null;
    try { raw = this.storage.getItem(CAMPAIGN_PENDING_KEY); this.storageUnavailable = false; }
    catch { this.storageUnavailable = true; return null; }
    try {
      if (raw === null) return null;
      // Initial session discovery is not authentication loss. Never dispatch before refresh.
      if (this.browser.current === null && this.browser.epoch === this.generation) return null;
      const value = campaignPendingSchema.parse(JSON.parse(raw));
      const session = this.browser.current;
      if (value.identity !== this.identity() || session?.status !== 'signed_in'
        || Date.parse(value.expiresAt) <= Date.now() || Date.parse(value.expiresAt) > Date.parse(session.expiresAt)) {
        this.clear(); return null;
      }
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.clear(); }, Math.min(Date.parse(value.expiresAt) - Date.now(), 2_147_483_647));
      return value;
    } catch { try { this.clear(); } catch { /* No usable custody. */ } return null; }
  }
  private retain(value: CampaignPending): void {
    if (this.identity() !== value.identity || Date.parse(value.expiresAt) <= Date.now()) throw new BrowserBoundaryError('session_changed');
    try {
      const serialized = JSON.stringify(campaignPendingSchema.parse(value));
      this.storage.setItem(CAMPAIGN_PENDING_KEY, serialized);
      if (this.storage.getItem(CAMPAIGN_PENDING_KEY) !== serialized) throw new Error('Custody not durable');
    }
    catch { throw new BrowserBoundaryError('storage_unavailable'); }
    this.pending();
  }
  prepare(action: CampaignAction): CampaignPending {
    const identity = this.identity(), session = this.browser.current;
    if (identity === null || session?.status !== 'signed_in') throw new BrowserBoundaryError('session_changed');
    const prior = this.pending();
    if (this.storageUnavailable) throw new BrowserBoundaryError('storage_unavailable');
    if (prior !== null) throw new BrowserBoundaryError('refused');
    const expiresAt = action.kind === 'approve'
      ? new Date(Math.min(Date.parse(session.expiresAt), Date.parse(action.policy.expiresAt))).toISOString() : session.expiresAt;
    const value = campaignPendingSchema.parse({ identity, commandId: this.randomUUID(), expiresAt, action });
    this.retain(value);
    return value;
  }
  async control(): Promise<EmailCampaignControl> {
    const epoch = this.browser.epoch;
    const value = await this.browser.request('/outreach/email-campaigns/control', emailCampaignControlSchema, {});
    if (!this.browser.isCurrent(epoch) || this.identity() === null) throw new BrowserBoundaryError('session_changed');
    return value;
  }
  async retry(): Promise<EmailCampaignControl> {
    const epoch = this.browser.epoch, held = this.pending();
    if (held === null) throw new BrowserBoundaryError('refused');
    if (held.accepted === undefined) {
      const { kind } = held.action;
      const payload = held.action.kind === 'approve' ? held.action.policy : { id: held.action.id, expectedRevision: held.action.expectedRevision };
      const body = { ...payload, commandId: held.commandId };
      const result = await this.browser.request(`/outreach/email-campaigns/${kind}`, receipt, body, () => {
        if (this.pending()?.commandId !== held.commandId) throw new BrowserBoundaryError('session_changed');
        this.retain(held);
      });
      if (!this.browser.isCurrent(epoch) || this.pending()?.commandId !== held.commandId) throw new BrowserBoundaryError('session_changed');
      this.retain({ ...held, accepted: result.result });
    }
    const current = await this.control();
    if (!this.browser.isCurrent(epoch) || this.pending()?.commandId !== held.commandId) throw new BrowserBoundaryError('session_changed');
    this.clear();
    return current;
  }
}
