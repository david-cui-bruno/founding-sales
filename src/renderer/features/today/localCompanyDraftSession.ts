import { localCompanyDetailSchema, type LocalWorkspaceApi } from '../../../shared/contracts/localWorkspaceContract';
import {
  companyDraftGetReply, companyDraftOpenReply, companyDraftSaveReply, openCompanyDraftSchema, saveCompanyDraftSchema,
  type CompanyDraftRead, type CompanyDraftMutationResult, type OpenCompanyDraft, type SaveCompanyDraft,
} from '../../../shared/contracts/localCompanyDraftContract';

export type CompanyDraftApi = Pick<LocalWorkspaceApi, 'getCompanyDraft' | 'openCompanyDraft' | 'saveCompanyDraft'>;
type State = { current: CompanyDraftRead | null; subject: string; body: string; visible: boolean; busy: boolean;
  checked: boolean; error: string | null; conflict: boolean; pendingSave: boolean; canReviewSaved: boolean; pendingOpen: boolean };
const binding = (read: CompanyDraftRead) => JSON.stringify({ ...read.draft, revision: 0, subject: '', body: '', updatedAt: '' });

/** A retained editor belongs to one API and one account/route selector. Never a company label.
 * Requests survive unknown outcomes unchanged. Reads cannot create drafts or acknowledge local edits. */
export class LocalCompanyDraftSession {
  private state: State = { current: null, subject: '', body: '', visible: false, busy: false, checked: false,
    error: null, conflict: false, pendingSave: false, canReviewSaved: false, pendingOpen: false };
  private listeners = new Set<() => void>();
  private pendingOpen: OpenCompanyDraft | null = null;
  private pendingSave: SaveCompanyDraft | null = null;
  private work: Promise<boolean> | null = null;
  private readSequence = 0;
  private opening = false;
  private reviewedOpening: { accountVersion: number; routeVersion: number } | null = null;
  private readonly openingHistory: { request: OpenCompanyDraft; receipt: CompanyDraftMutationResult['receipt'] | null }[] = [];
  openingRecords = () => structuredClone(this.openingHistory);
  constructor(private api: CompanyDraftApi, readonly accountId: string, readonly routeId: string) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<State>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  dirty = () => !!this.state.current && (this.state.subject !== this.state.current.draft.subject || this.state.body !== this.state.current.draft.body);
  private ingest(next: CompanyDraftRead) {
    const previous = this.state.current;
    if (previous && binding(previous) !== binding(next)) throw Error('Frozen identity changed');
    if (previous && next.draft.revision < previous.draft.revision) return;
    const dirty = this.dirty();
    this.update({ current: next, ...(!previous ? { subject: next.draft.subject, body: next.draft.body } : {}),
      ...(previous && next.draft.revision !== previous.draft.revision ? {
        conflict: true, error: 'The saved revision changed. Local text is retained. Review the saved text before saving.',
      } : {}), ...(!previous || dirty ? {} : { subject: next.draft.subject, body: next.draft.body }) });
  }
  async read() {
    const sequence = ++this.readSequence;
    const request = this.state.current ? { accountId: this.accountId, draftId: this.state.current.draft.id }
      : { accountId: this.accountId, routeId: this.routeId };
    try {
      const next = companyDraftGetReply(request).parse(await this.api.getCompanyDraft(request));
      if (sequence !== this.readSequence || this.state.busy) return;
      if (next) this.ingest(next);
      else if (this.state.current) throw Error('Saved draft unavailable');
      this.update({ checked: true, canReviewSaved: !!next && !!this.pendingSave });
    } catch {
      if (sequence === this.readSequence) this.update({ checked: false, error: 'Draft read unavailable. Local text is retained. Retry the read.' });
    }
  }
  edit(field: 'subject' | 'body', value: string) {
    if (!this.state.current?.editable) return;
    this.update({ [field]: value });
  }
  async open(expectedAccountVersion: number, expectedRouteVersion: number, newVersion = false) {
    if (this.state.busy || this.opening) return false;
    this.opening = true;
    try {
      await this.read();
      if (!this.state.checked) return false;
      if (this.state.current && !newVersion && !this.pendingOpen) { this.update({ visible: true }); return true; }
      if (newVersion && this.state.current) {
        if (!this.pendingOpen && this.state.current.draft.recipientBinding.routeVersion === expectedRouteVersion) {
          this.update({ visible: true, error: null }); return true;
        }
        if (this.state.current.draft.recipientBinding.routeVersion !== (this.pendingOpen?.expectedRouteVersion ?? expectedRouteVersion))
          this.update({ current: null, subject: '', body: '', conflict: false });
      }
      this.pendingOpen ??= Object.freeze(openCompanyDraftSchema.parse({ commandId: crypto.randomUUID(), accountId: this.accountId,
        routeId: this.routeId, expectedRouteVersion: this.reviewedOpening?.routeVersion ?? expectedRouteVersion,
        expectedAccountVersion: this.reviewedOpening?.accountVersion ?? expectedAccountVersion }));
      this.reviewedOpening = null;
      this.update({ busy: true, pendingOpen: true, error: null }); ++this.readSequence;
      const request = this.pendingOpen;
      const result = companyDraftOpenReply(request).parse(await this.api.openCompanyDraft(request));
      this.openingHistory.push({ request: structuredClone(request), receipt: structuredClone(result.receipt) });
      this.ingest(result.current);
      this.pendingOpen = null;
      this.update({ visible: true, pendingOpen: false, error: null }); return true;
    } catch {
      this.update({ error: 'Open outcome unavailable. Retry Open to recover the same command.' }); return false;
    } finally { this.opening = false; this.update({ busy: false }); }
  }
  async reviewOpening(getCompany: LocalWorkspaceApi['getCompany'], isCurrent: () => boolean) {
    if (this.state.busy || this.opening || !this.pendingOpen || !isCurrent()) return false;
    this.update({ busy: true }); const sequence = ++this.readSequence;
    const original = this.pendingOpen;
    try {
      const detail = localCompanyDetailSchema.parse(await getCompany({ accountId: this.accountId }));
      if (detail.snapshot.account.id !== this.accountId) throw Error('Account changed');
      const route = detail.snapshot.routes.find(item => item.id === this.routeId);
      if (!route || route.version !== original.expectedRouteVersion || route.personId !== null || route.channel !== 'email' || route.purpose !== 'business'
        || !['published', 'confirmed'].includes(route.verification) || !route.evidenceIds.length) throw Error('Route unavailable');
      const request = { accountId: this.accountId, routeId: this.routeId };
      const current = companyDraftGetReply(request).parse(await this.api.getCompanyDraft(request));
      if (!isCurrent() || sequence !== this.readSequence || this.pendingOpen !== original) throw Error('Review superseded');
      const recovered = current?.draft.recipientBinding.routeVersion === original.expectedRouteVersion ? current : null;
      if (recovered) this.ingest(recovered);
      this.openingHistory.push({ request: structuredClone(original), receipt: null });
      this.pendingOpen = null;
      this.reviewedOpening = recovered ? null : { accountVersion: detail.snapshot.account.version, routeVersion: route.version };
      this.update({ checked: true, pendingOpen: false, visible: !!recovered,
        error: recovered ? 'Saved draft recovered by read. The original command receipt remains unknown.' : 'Opening observation refreshed. Review and explicitly Open again. The earlier command is retained.' });
      return true;
    } catch {
      this.update({ error: 'Opening review unavailable. The original request is retained. Retry its exact command or review again.' }); return false;
    } finally { this.update({ busy: false }); }
  }
  save(): Promise<boolean> {
    if (this.work) return this.work;
    if (!this.state.current?.editable || (this.state.conflict && !this.pendingSave)) return Promise.resolve(false);
    if (!this.pendingSave && !this.dirty()) return Promise.resolve(true);
    let request: SaveCompanyDraft;
    try {
      request = this.pendingSave ?? saveCompanyDraftSchema.parse({ commandId: crypto.randomUUID(), accountId: this.accountId,
        draftId: this.state.current.draft.id, expectedRevision: this.state.current.draft.revision,
        subject: this.state.subject, body: this.state.body });
    } catch { this.update({ error: 'Subject or message is invalid. Local text is retained.' }); return Promise.resolve(false); }
    this.pendingSave = request;
    this.update({ busy: true, pendingSave: true, canReviewSaved: false, error: null }); ++this.readSequence;
    const work = (async () => {
      try {
        const result = companyDraftSaveReply(request).parse(await this.api.saveCompanyDraft(request));
        if (!this.state.current || binding(result.current) !== binding(this.state.current)) throw Error('Saved binding changed');
        this.pendingSave = null;
        // Keep every keystroke, including ones made while this exact command was in flight.
        const newer = result.current.draft.revision > result.receipt.appliedRevision;
        this.update({ current: result.current, pendingSave: false, conflict: newer,
          error: newer ? 'A newer saved revision exists. Local text is retained for review.' : null });
        return !newer;
      } catch {
        this.update({ error: 'Save outcome unavailable. Unsaved text is retained. Retry Save with the same command, or refresh the read.' });
        return false;
      }
    })();
    this.work = work;
    void work.then(() => { if (this.work === work) this.work = null; this.update({ busy: false }); });
    return work;
  }
  async close() {
    if (this.state.busy && !this.work) return false;
    if (this.dirty() || this.pendingSave) {
      if (!await this.save() || this.dirty()) return false;
    }
    this.update({ visible: false }); return true;
  }
  useSavedText() {
    if (!this.state.current || this.state.busy || (this.pendingSave && !this.state.canReviewSaved)) return;
    // Explicit local recovery after a successful read. No mutation or invented receipt.
    this.pendingSave = null;
    this.update({ subject: this.state.current.draft.subject, body: this.state.current.draft.body, conflict: false,
      pendingSave: false, canReviewSaved: false, error: null });
  }
}
const sessions = new WeakMap<CompanyDraftApi, Map<string, LocalCompanyDraftSession>>();
export function localCompanyDraftSession(api: CompanyDraftApi, accountId: string, routeId: string, versionSelection = 'saved') {
  let map = sessions.get(api);
  if (!map) { map = new Map(); sessions.set(api, map); }
  const key = JSON.stringify([accountId, routeId, versionSelection]);
  let session = map.get(key);
  if (!session) { session = new LocalCompanyDraftSession(api, accountId, routeId); map.set(key, session); }
  return session;
}

// Retained editor selection is as durable within an API lifetime as the editor itself.
const selectedSessions = new WeakMap<CompanyDraftApi, Map<string, string>>();
export function companyDraftSelection(api: CompanyDraftApi, accountId: string, routeId: string) {
  return selectedSessions.get(api)?.get(JSON.stringify([accountId, routeId])) ?? 'saved';
}
export function selectCompanyDraftSession(api: CompanyDraftApi, accountId: string, routeId: string, selection: string) {
  let map = selectedSessions.get(api); if (!map) { map = new Map(); selectedSessions.set(api, map); }
  map.set(JSON.stringify([accountId, routeId]), selection);
}
export function companyDraftSessionChoices(api: CompanyDraftApi, accountId: string, routeId: string) {
  return [...(sessions.get(api)?.entries() ?? [])].flatMap(([key, session]) => {
    const [account, route, selection] = JSON.parse(key);
    return account === accountId && route === routeId && session.snapshot().current ? [{ selection: String(selection), session }] : [];
  });
}
