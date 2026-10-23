import { z } from 'zod';
import { instant, uuid, replyFactRefSchema, replyDraftContextResultSchema, replyDraftGenerateResultSchema, type ReplyDraftContext, type ReplyFactRef } from '@fss/contracts';
import { BrowserBoundaryError, type BrowserClient } from './BrowserClient.ts';

const generateReceiptSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('accepted'), replayed: z.boolean(), result: replyDraftGenerateResultSchema }),
  z.strictObject({ status: z.literal('refused'), replayed: z.boolean(), reason: z.string() }),
]);
export const REPLY_PENDING_KEY = 'callie.browser.pending-reply.v1';
export const replyAttemptSchema = z.strictObject({
  identity: z.string(), expiresAt: instant, messageId: uuid, commandId: uuid,
  sourceRevision: z.string().regex(/^[a-f0-9]{64}$/u), factRefs: z.array(replyFactRefSchema).max(20),
  envelopeSHA256: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const REPLY_ATTEMPT_LIMIT = 64;
const replyCustodySchema = z.strictObject({ version: z.literal(2), records: z.array(replyAttemptSchema).min(1).max(REPLY_ATTEMPT_LIMIT) });
export type PendingReplyAttempt = z.infer<typeof replyAttemptSchema>;
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const replyFactRefs = (context: ReplyDraftContext): ReplyFactRef[] => context.facts.map(({ id, version }) => ({ id, version }));
const identityOf = (client: BrowserClient): string | null => {
  const session = client.current;
  return session?.status === 'signed_in'
    ? JSON.stringify([session.workspaceId, session.userId, session.deviceId, session.role, session.revision]) : null;
};
async function envelopeHash(context: ReplyDraftContext): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ to: context.envelope.to, cc: context.envelope.cc }));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
}

/** Only IDs and a one-way fingerprint are durable. Prose and recipient addresses never leave mounted memory. */
export class ReplyAttempt {
  private epoch: number;
  private readonly unsubscribe: () => void;
  private storageUnavailable = false;
  constructor(readonly client: BrowserClient, private readonly storage: StoragePort = globalThis.sessionStorage,
    private readonly randomUUID: () => string = () => globalThis.crypto.randomUUID()) {
    this.epoch = client.epoch;
    this.unsubscribe = client.subscribe(() => {
      if (client.epoch !== this.epoch || client.current?.status === 'signed_out') this.clear();
      this.epoch = client.epoch;
      this.pending();
    });
    this.pending();
  }
  dispose(): void { this.unsubscribe(); }
  private clear(): void {
    try { this.storage.removeItem(REPLY_PENDING_KEY); this.storageUnavailable = false; }
    catch { this.storageUnavailable = true; }
  }
  private records(): PendingReplyAttempt[] {
    if (this.storageUnavailable) return [];
    try {
      const raw = this.storage.getItem(REPLY_PENDING_KEY);
      if (raw === null) return [];
      if (raw.length > 131072) throw new Error('Custody bounds');
      const parsed: unknown = JSON.parse(raw);
      const legacy = replyAttemptSchema.safeParse(parsed);
      const records = legacy.success ? [legacy.data] : replyCustodySchema.parse(parsed).records;
      if (new Set(records.map(value => value.messageId)).size !== records.length
        || new Set(records.map(value => value.commandId)).size !== records.length) throw new Error('Duplicate custody');
      // Discovery is not logout. Preserve even legacy bytes until authority is known.
      if (this.client.current === null) return [];
      const session = this.client.current;
      if (!this.client.isCurrent(this.client.epoch) || session.status !== 'signed_in'
        || records.some(value => value.identity !== identityOf(this.client)
          || Date.parse(value.expiresAt) <= Date.now()
          || Date.parse(value.expiresAt) > Date.parse(session.expiresAt))) {
        this.clear(); return [];
      }
      return records;
    } catch {
      // Never discard malformed or unreadable uncertainty to admit new paid work.
      this.storageUnavailable = true;
      return [];
    }
  }
  pending(messageId?: string): PendingReplyAttempt | null {
    const records = this.records();
    return records.find(value => messageId === undefined || value.messageId === messageId) ?? null;
  }
  private retain(value: PendingReplyAttempt): void {
    if (!this.client.isCurrent(this.epoch) || identityOf(this.client) !== value.identity || Date.parse(value.expiresAt) <= Date.now()) throw new BrowserBoundaryError('session_changed');
    const records = this.records();
    if (this.storageUnavailable) throw new BrowserBoundaryError('storage_unavailable');
    const prior = records.find(record => record.messageId === value.messageId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(value)) throw new BrowserBoundaryError('refused');
    if (!prior) records.push(replyAttemptSchema.parse(value));
    if (records.length > REPLY_ATTEMPT_LIMIT) throw new BrowserBoundaryError('storage_unavailable');
    try {
      // Keep legacy single-record encoding until another message needs custody.
      const serialized = JSON.stringify(records.length === 1 ? records[0] : replyCustodySchema.parse({ version: 2, records }));
      if (serialized.length > 131072) throw new Error('Custody bounds');
      this.storage.setItem(REPLY_PENDING_KEY, serialized);
      if (this.storage.getItem(REPLY_PENDING_KEY) !== serialized) throw new Error('Custody unavailable');
    } catch { this.storageUnavailable = true; throw new BrowserBoundaryError('storage_unavailable'); }
  }
  async context(messageId: string): Promise<ReplyDraftContext> {
    const result = await this.client.request('/replies/composer/context', replyDraftContextResultSchema, { messageId });
    if (!result.ok || result.value.messageId !== messageId) throw new BrowserBoundaryError('refused');
    return result.value;
  }
  async matches(value: PendingReplyAttempt, context: ReplyDraftContext): Promise<boolean> {
    return value.messageId === context.messageId && value.sourceRevision === context.sourceRevision
      && JSON.stringify(value.factRefs) === JSON.stringify(replyFactRefs(context))
      && value.envelopeSHA256 === await envelopeHash(context);
  }
  async requestSuggestion(context: ReplyDraftContext, sameAttempt: boolean, ownsOperation: () => boolean = () => true) {
    const epoch = this.client.epoch;
    const checkOwner = (): void => {
      if (!ownsOperation() || !this.client.isCurrent(epoch)) throw new BrowserBoundaryError('session_changed');
    };
    checkOwner();
    const fresh = await this.context(context.messageId);
    const envelopeSHA256 = await envelopeHash(fresh);
    checkOwner();
    if (fresh.sourceRevision !== context.sourceRevision || JSON.stringify(fresh.envelope) !== JSON.stringify(context.envelope)
      || JSON.stringify(replyFactRefs(fresh)) !== JSON.stringify(replyFactRefs(context))) throw new BrowserBoundaryError('refused');
    let held = this.pending(fresh.messageId);
    if (this.storageUnavailable) throw new BrowserBoundaryError('storage_unavailable');
    if (sameAttempt) {
      if (held === null || !await this.matches(held, fresh)) throw new BrowserBoundaryError('refused');
    } else {
      if (held !== null) throw new BrowserBoundaryError('refused');
      const session = this.client.current;
      if (session?.status !== 'signed_in') throw new BrowserBoundaryError('session_changed');
      held = replyAttemptSchema.parse({ identity: identityOf(this.client), expiresAt: session.expiresAt, messageId: fresh.messageId,
        commandId: this.randomUUID(), sourceRevision: fresh.sourceRevision, factRefs: replyFactRefs(fresh), envelopeSHA256 });
    }
    checkOwner();
    this.retain(held);
    const retained = held;
    return this.client.request('/replies/composer/generate', generateReceiptSchema, {
      messageId: fresh.messageId, commandId: held.commandId, sourceRevision: fresh.sourceRevision,
      factRefs: held.factRefs, envelope: fresh.envelope,
    }, () => {
      checkOwner();
      if (this.pending(retained.messageId)?.commandId !== retained.commandId) throw new BrowserBoundaryError('session_changed');
      this.retain(retained);
    });
  }
}
