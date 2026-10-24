import { z } from 'zod';
import { ManualProspectCustody } from './ManualProspectPending.ts';
import { QualificationCustody } from './QualificationPending.ts';
import { saveMeetingNotesSchema, qualifiedResearchSelectionSchema, uuid, type QualifiedResearchSelection, type SaveMeetingNotes } from '@fss/contracts';
import { RESEARCH_PENDING_KEY, researchPendingSchema, type PendingResearch } from './ResearchPending.ts';
import { BROWSER_CSRF_HEADER, BROWSER_PATHS, BROWSER_REVISION_HEADER, browserApiPathAllowed, browserSessionSchema, browserSignInSchema, type BrowserSession } from '../shared/browserContract.ts';

export const PENDING_KEY = 'callie.browser.pending-notes.v1';
const pendingSchema = z.strictObject({ identity: z.string(), commandId: uuid, draft: saveMeetingNotesSchema });
export type PendingNotes = z.infer<typeof pendingSchema>;
export interface InvalidationChannel {
  postMessage(value: unknown): void;
  addEventListener(type: 'message', listener: () => void): void;
  removeEventListener(type: 'message', listener: () => void): void;
  close(): void;
}
export interface BrowserClientOptions {
  fetch: typeof fetch;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  channel?: InvalidationChannel;
  navigate(url: string): void;
  randomUUID(): string;
}
const identityOf = (session: BrowserSession | null): string | null => session?.status === 'signed_in'
  ? JSON.stringify([session.workspaceId, session.userId, session.deviceId, session.role, session.revision]) : null;
export class BrowserBoundaryError extends Error {
  constructor(readonly reason: 'session_changed' | 'unavailable' | 'refused' | 'storage_unavailable' | 'invalid_response') {
    super(reason);
  }
}

/** Per mounted browser app only. No credentials, private projection cache or global bridge. */
export class BrowserClient {
  readonly manualProspects: ManualProspectCustody;
  readonly qualification: QualificationCustody;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private session: BrowserSession | null = null;
  private generation = 0;
  private listeners = new Set<() => void>();
  private readonly onBroadcast = (): void => { this.invalidate(false); };
  constructor(private readonly options: BrowserClientOptions) {
    this.manualProspects = new ManualProspectCustody(options.storage, () => {
      if (!this.isCurrent(this.generation) || this.session?.status !== 'signed_in' || this.session.role !== 'admin') return null;
      return { identity: identityOf(this.session)!, expiresAt: this.session.expiresAt };
    }, options.randomUUID);
    this.qualification = new QualificationCustody(options.storage, () => {
      if (!this.isCurrent(this.generation) || this.session?.status !== 'signed_in' || this.session.role !== 'admin') return null;
      return { identity: identityOf(this.session)!, expiresAt: this.session.expiresAt };
    }, options.randomUUID, () => { this.emit(); });
    options.channel?.addEventListener('message', this.onBroadcast);
  }
  get current(): BrowserSession | null { return this.session; }
  get epoch(): number { return this.generation; }
  isCurrent(epoch: number): boolean {
    if (this.session?.status === 'signed_in' && Date.parse(this.session.expiresAt) <= Date.now()) this.invalidate();
    return epoch === this.generation;
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(): void { for (const listener of this.listeners) listener(); }
  private removePending(): void {
    try { this.options.storage.removeItem(PENDING_KEY); } catch { /* Fail closed: no persisted value is trusted without current identity. */ }
  }
  invalidate(broadcast = true): void {
    clearTimeout(this.expiryTimer);
    this.generation += 1;
    this.session = null;
    this.manualProspects.clear(); this.qualification.clear();
    try { this.options.storage.removeItem(RESEARCH_PENDING_KEY); } catch { /* Invalid identity cannot use retained custody. */ }
    this.removePending();
    this.emit();
    if (broadcast) this.options.channel?.postMessage({ type: 'invalidate' });
  }
  dispose(): void {
    this.invalidate(false);
    this.options.channel?.removeEventListener('message', this.onBroadcast);
    this.options.channel?.close();
    this.listeners.clear();
  }
  private check(epoch: number): void {
    if (!this.isCurrent(epoch)) throw new BrowserBoundaryError('session_changed');
  }
  private async send(path: string, init: RequestInit, epoch: number): Promise<Response> {
    this.check(epoch);
    let response: Response;
    try { response = await this.options.fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error' }); }
    catch { this.check(epoch); throw new BrowserBoundaryError('unavailable'); }
    this.check(epoch);
    if ([401, 403, 409].includes(response.status)) {
      // The gateway intentionally makes revision and product conflicts generic.
      // Fail closed for either rather than retain a projection under a stale role.
      this.invalidate();
      throw new BrowserBoundaryError('refused');
    }
    if (!response.ok) throw new BrowserBoundaryError('refused');
    return response;
  }
  async refresh(): Promise<BrowserSession> {
    const epoch = this.generation;
    const response = await this.send(BROWSER_PATHS.session, { method: 'GET' }, epoch);
    let next: BrowserSession;
    try { next = browserSessionSchema.parse(await response.json()); }
    catch { this.check(epoch); this.invalidate(); throw new BrowserBoundaryError('invalid_response'); }
    this.check(epoch);
    if (next.status === 'signed_in' && Date.parse(next.expiresAt) <= Date.now()) {
      this.invalidate(); throw new BrowserBoundaryError('session_changed');
    }
    const previous = identityOf(this.session), identity = identityOf(next);
    if (previous !== identity && this.session !== null) {
      this.invalidate();
      throw new BrowserBoundaryError('session_changed');
    }
    if (next.status === 'signed_out') this.removePending();
    this.session = next;
    clearTimeout(this.expiryTimer);
    if (next.status === 'signed_in') {
      const remaining = Date.parse(next.expiresAt) - Date.now();
      if (remaining <= 0) { this.invalidate(); throw new BrowserBoundaryError('session_changed'); }
      this.expiryTimer = setTimeout(() => { this.invalidate(); }, Math.min(remaining, 2_147_483_647));
      this.pendingResearch();
      if (next.role !== 'admin') { this.manualProspects.clear(); this.qualification.clear(); }
      else { try { this.qualification.read(); } catch { /* Corrupt/unavailable custody stays fail-closed, never silently reminted. */ } }
    } else {
      this.manualProspects.clear(); this.qualification.clear();
      try { this.options.storage.removeItem(RESEARCH_PENDING_KEY); } catch { /* No signed-in custody. */ }
    }
    this.emit();
    return next;
  }
  async signIn(workspaceId: string, deviceLabel: string): Promise<void> {
    const input = browserSignInSchema.parse({ workspaceId, deviceLabel });
    const epoch = this.generation;
    const session = await this.refresh();
    this.check(epoch);
    const response = await this.send(BROWSER_PATHS.signIn, { method: 'POST', headers: { 'content-type': 'application/json', [BROWSER_CSRF_HEADER]: session.csrfToken }, body: JSON.stringify(input) }, epoch);
    const result = z.strictObject({ authorizationUrl: z.string().url() }).parse(await response.json());
    this.check(epoch);
    const url = new URL(result.authorizationUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new BrowserBoundaryError('invalid_response');
    this.options.navigate(url.href);
  }
  async signOut(): Promise<void> {
    const session = this.session;
    this.invalidate(); // Clear immediately, even when remote revocation is uncertain.
    if (session === null) throw new BrowserBoundaryError('unavailable');
    const epoch = this.generation;
    await this.send(BROWSER_PATHS.signOut, { method: 'POST', headers: {
      'content-type': 'application/json', [BROWSER_CSRF_HEADER]: session.csrfToken,
      ...(session.status === 'signed_in' ? { [BROWSER_REVISION_HEADER]: session.revision } : {}),
    }, body: '{}' }, epoch);
  }
  async request<T>(path: string, schema: z.ZodType<T>, body?: unknown, beforeDispatch?: () => void): Promise<T> {
    const method = body === undefined ? 'GET' : 'POST';
    if (!browserApiPathAllowed(method, path.split('?')[0] ?? '')) throw new BrowserBoundaryError('refused');
    const epoch = this.generation;
    const session = await this.refresh();
    this.check(epoch);
    if (session.status !== 'signed_in') throw new BrowserBoundaryError('session_changed');
    this.check(epoch);
    beforeDispatch?.();
    this.check(epoch);
    const response = await this.send(`${BROWSER_PATHS.apiPrefix}${path}`, { method, headers: {
      [BROWSER_REVISION_HEADER]: session.revision, [BROWSER_CSRF_HEADER]: session.csrfToken,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, epoch);
    const raw: unknown = await response.json();
    this.check(epoch);
    const result = schema.safeParse(raw);
    if (!result.success) throw new BrowserBoundaryError('invalid_response');
    return result.data;
  }
  pendingResearch(): PendingResearch | null {
    const epoch = this.generation;
    if (!this.isCurrent(epoch) || this.session?.status !== 'signed_in') return null;
    try {
      const raw = this.options.storage.getItem(RESEARCH_PENDING_KEY);
      if (raw === null) return null;
      const value = researchPendingSchema.parse(JSON.parse(raw));
      if (value.identity !== identityOf(this.session) || Date.parse(value.expiresAt) <= Date.now()
        || Date.parse(value.expiresAt) > Date.parse(this.session.expiresAt)) throw new Error('Expired custody');
      return value;
    } catch {
      try { this.options.storage.removeItem(RESEARCH_PENDING_KEY); } catch { /* Fail closed. */ }
      return null;
    }
  }
  prepareResearch(selection: QualifiedResearchSelection): PendingResearch {
    const parsed = qualifiedResearchSelectionSchema.parse(selection);
    this.check(this.generation);
    if (this.session?.status !== 'signed_in') throw new BrowserBoundaryError('session_changed');
    const prior = this.pendingResearch();
    if (prior !== null) {
      if (JSON.stringify(prior.selection) !== JSON.stringify(parsed)) throw new BrowserBoundaryError('refused');
      return prior;
    }
    const pending = researchPendingSchema.parse({ identity: identityOf(this.session), commandId: this.options.randomUUID(),
      selection: parsed, expiresAt: this.session.expiresAt });
    this.retainResearch(pending);
    return pending;
  }
  retainResearch(pending: PendingResearch): void {
    this.check(this.generation);
    if (this.session?.status !== 'signed_in' || pending.identity !== identityOf(this.session)
      || Date.parse(pending.expiresAt) <= Date.now() || Date.parse(pending.expiresAt) > Date.parse(this.session.expiresAt)) throw new BrowserBoundaryError('session_changed');
    try { this.options.storage.setItem(RESEARCH_PENDING_KEY, JSON.stringify(researchPendingSchema.parse(pending))); }
    catch { throw new BrowserBoundaryError('storage_unavailable'); }
  }
  pending(): PendingNotes | null {
    const identity = identityOf(this.session);
    if (identity === null) return null;
    try {
      const raw = this.options.storage.getItem(PENDING_KEY);
      if (raw === null) return null;
      const parsed = pendingSchema.safeParse(JSON.parse(raw));
      if (!parsed.success || parsed.data.identity !== identity) { this.removePending(); return null; }
      return parsed.data;
    } catch { this.removePending(); return null; }
  }
  prepareNotes(draft: SaveMeetingNotes): PendingNotes {
    const identity = identityOf(this.session);
    if (identity === null) throw new BrowserBoundaryError('session_changed');
    const previous = this.pending();
    if (previous !== null) {
      if (JSON.stringify(previous.draft) !== JSON.stringify(saveMeetingNotesSchema.parse(draft))) throw new BrowserBoundaryError('refused');
      return previous;
    }
    const pending = pendingSchema.parse({ identity, commandId: this.options.randomUUID(), draft });
    this.retainPending(pending);
    return pending;
  }
  retainPending(pending: PendingNotes): void {
    if (pending.identity !== identityOf(this.session)) throw new BrowserBoundaryError('session_changed');
    try { this.options.storage.setItem(PENDING_KEY, JSON.stringify(pending)); }
    catch { throw new BrowserBoundaryError('storage_unavailable'); }
  }
  completePending(commandId: string): void {
    if (this.pending()?.commandId === commandId) this.removePending();
  }
}
