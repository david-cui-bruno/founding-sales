import { z } from 'zod';
import { instant, uuid, callingFollowUpSaveInputSchema, type CallingFollowUpSaveInput } from '@fss/contracts';
import { type BrowserClient } from './BrowserClient.ts';
import { privateDraftCanonicalJson, privateDraftSHA256 } from './PrivateDraftCustody.ts';

export const CALLING_FOLLOW_UP_PENDING_KEY = 'callie.browser.pending-calling-follow-up.v1';
export const callingFollowUpPendingSchema = z.strictObject({
  identity: z.string(), expiresAt: instant, commandId: uuid, draftId: uuid,
  expectedRevision: z.number().int().positive(), operation: z.enum(['update', 'withdraw']),
  payloadSHA256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const recordsSchema = z.array(callingFollowUpPendingSchema).min(1).max(64);
export type CallingFollowUpAttempt = z.infer<typeof callingFollowUpPendingSchema>;
export type CallingFollowUpStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Per-tab opaque save custody. Private content never enters these records. */
export class CallingFollowUpPending {
  private readonly unsubscribe: () => void;
  private failed = false;
  constructor(readonly client: BrowserClient, private readonly storage: CallingFollowUpStorage = globalThis.sessionStorage,
    private readonly randomUUID: () => string = () => crypto.randomUUID()) {
    let epoch = client.epoch;
    this.unsubscribe = client.subscribe(() => {
      if (client.epoch !== epoch || client.current?.status === 'signed_out') this.clear();
      epoch = client.epoch;
    });
  }
  dispose(): void { this.unsubscribe(); }
  binding(): { identity: string; expiresAt: string } | null {
    const session = this.client.current;
    return session?.status === 'signed_in' && this.client.isCurrent(this.client.epoch) ? {
      identity: JSON.stringify([session.workspaceId, session.userId, session.deviceId, session.role, session.revision]), expiresAt: session.expiresAt,
    } : null;
  }
  all(): CallingFollowUpAttempt[] {
    if (this.failed) throw Error('Follow-up custody unavailable');
    const binding = this.binding();
    if (!binding) return [];
    const bytes = this.storage.getItem(CALLING_FOLLOW_UP_PENDING_KEY);
    if (bytes === null) return [];
    if (bytes.length > 65536) throw Error('Follow-up custody exceeds bounds');
    const records = recordsSchema.parse(JSON.parse(bytes));
    if (new Set(records.map(value => value.draftId)).size !== records.length || new Set(records.map(value => value.commandId)).size !== records.length) throw Error('Ambiguous follow-up custody');
    if (records.some(value => value.identity !== binding.identity || Date.parse(value.expiresAt) <= Date.now() || Date.parse(value.expiresAt) > Date.parse(binding.expiresAt))) {
      this.clear();
      if (this.failed) throw Error('Follow-up custody unavailable');
      return [];
    }
    return records;
  }
  read(draftId: string): CallingFollowUpAttempt | null { return this.all().find(value => value.draftId === draftId) ?? null; }
  private write(records: CallingFollowUpAttempt[]): void {
    if (records.length === 0) {
      this.storage.removeItem(CALLING_FOLLOW_UP_PENDING_KEY);
      if (this.storage.getItem(CALLING_FOLLOW_UP_PENDING_KEY) !== null) throw Error('Follow-up custody removal failed');
      return;
    }
    const bytes = JSON.stringify(recordsSchema.parse(records));
    this.storage.setItem(CALLING_FOLLOW_UP_PENDING_KEY, bytes);
    if (this.storage.getItem(CALLING_FOLLOW_UP_PENDING_KEY) !== bytes) throw Error('Follow-up custody write failed');
  }
  async exclusive<T>(draftId: string, current: () => boolean, work: () => Promise<T>): Promise<T> {
    const binding = this.binding();
    if (!binding || !current() || !globalThis.navigator?.locks) throw Error('Follow-up save lock unavailable');
    return navigator.locks.request(`callie.calling:${binding.identity}:draft:${draftId}`, { mode: 'exclusive' }, async () => {
      if (!current() || this.binding()?.identity !== binding.identity) throw Error('Follow-up authority changed');
      return work();
    });
  }
  async prepare(raw: CallingFollowUpSaveInput, current: () => boolean): Promise<{ held: CallingFollowUpAttempt; payload: CallingFollowUpSaveInput }> {
    const payload = callingFollowUpSaveInputSchema.parse(raw), binding = this.binding();
    if (!binding || !current() || this.read(payload.draftId)) throw Error('Reconcile exact pending follow-up');
    const payloadSHA256 = await privateDraftSHA256(privateDraftCanonicalJson(payload));
    if (!current() || this.binding()?.identity !== binding.identity || this.read(payload.draftId)) throw Error('Follow-up authority changed');
    const held = callingFollowUpPendingSchema.parse({ ...binding, commandId: this.randomUUID(), draftId: payload.draftId,
      expectedRevision: payload.expectedRevision, operation: payload.operation, payloadSHA256 });
    this.write([...this.all(), held]);
    return { held, payload };
  }
  assert(held: CallingFollowUpAttempt): void {
    if (JSON.stringify(this.read(held.draftId)) !== JSON.stringify(held)) throw Error('Follow-up attempt changed');
  }
  complete(held: CallingFollowUpAttempt): void {
    this.assert(held);
    this.write(this.all().filter(value => value.commandId !== held.commandId));
  }
  clear(): void {
    try { this.storage.removeItem(CALLING_FOLLOW_UP_PENDING_KEY); this.failed = this.storage.getItem(CALLING_FOLLOW_UP_PENDING_KEY) !== null; }
    catch { this.failed = true; }
  }
}

/** Root installs this for app lifetime so offscreen auth invalidation also clears custody. */
export function installCallingFollowUpCustody(client: BrowserClient): () => void {
  const custody = new CallingFollowUpPending(client);
  return () => { custody.dispose(); };
}
