import type { CalliePreloadApi } from '../../../shared/preload';
import { accountReplyDraftSchema, assertReplyDraftLineage, boundReplyDraftResult, editReplyDraftSchema,
  type AccountReplyDraft, type EditReplyDraft, type ReplyDraftResult } from '../../../shared/contracts/mailThreadContract';
import { assertDailySessionScope, captureDailySessionScope } from './dailySessionScope';

export type OrdinaryReplyApi = Pick<CalliePreloadApi['delegation'], 'editReplyDraft' | 'reconcileReplyDraft'>;
type Pending = Readonly<{ request: Readonly<EditReplyDraft>; base: AccountReplyDraft }>;
type Record = { request: Readonly<EditReplyDraft>; outcome: 'unknown' | 'acknowledged' | 'reconciled'; result?: ReplyDraftResult };
type State = { draft: AccountReplyDraft; subject: string; body: string; visible: boolean; busy: boolean;
  stale: boolean; conflict: boolean; scopeHeld: boolean; actionHold?: string; error: string | null;
  pending: Pending | null; incoming: ReplyDraftResult | null };
const equal = (a: AccountReplyDraft, b: AccountReplyDraft) => JSON.stringify(a) === JSON.stringify(b);

export class OrdinaryReplySession {
  private state: State;
  private listeners = new Set<() => void>();
  private records: Record[] = [];
  private knownDrafts: AccountReplyDraft[] = [];
  private dailyObservation = 0;
  focus: { field: 'subject' | 'body'; start: number; end: number } | null = null;
  constructor(private api: OrdinaryReplyApi, private workspaceId: string, draft: AccountReplyDraft, stale: boolean) {
    const saved = accountReplyDraftSchema.parse(draft);
    this.knownDrafts.push(saved);
    this.state = { draft: saved, subject: saved.subject, body: saved.body, visible: false, busy: false,
      stale, conflict: false, scopeHeld: false, error: null, pending: null, incoming: null };
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<State>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  history() { return structuredClone(this.records); }
  dirty() { return this.state.subject !== this.state.draft.subject || this.state.body !== this.state.draft.body; }
  setActionHold(actionHold?: string) { if (actionHold !== this.state.actionHold) this.update({ actionHold }); }
  edit(field: 'subject' | 'body', value: string) { this.update({ [field]: value }); }
  open() { this.update({ visible: true }); }
  close() { this.update({ visible: false }); }
  ingest(draft: AccountReplyDraft, stale: boolean) {
    this.dailyObservation++;
    try {
      const incoming = accountReplyDraftSchema.parse(draft);
      // A possibly older Daily snapshot cannot clear an owner-observed stale hold.
      // Only a separately explicit successful reconciliation may do that.
      stale = stale || this.state.stale;
      if (equal(incoming, this.state.draft)) { if (this.state.stale !== stale) this.update({ stale }); return; }
      if (incoming.revision < this.state.draft.revision && this.knownDrafts.some(known => equal(known, incoming))) {
        if (stale && !this.state.stale) this.update({ stale: true });
        return;
      }
      assertReplyDraftLineage(this.state.draft, incoming);
      if (this.state.pending || this.state.busy || this.dirty()) {
        this.update({ incoming: { draft: incoming, stale, capability: 'held' }, stale, conflict: true }); return;
      }
      this.knownDrafts.push(incoming);
      this.update({ draft: incoming, subject: incoming.subject, body: incoming.body, stale, incoming: null, conflict: false });
    } catch { this.update({ conflict: true, stale: true, error: 'Saved reply identity or history changed. Displayed text is retained.' }); }
  }
  private guard() {
    if (this.state.busy || this.state.actionHold) return null;
    try { return captureDailySessionScope(this.api, this.workspaceId); }
    catch { this.update({ scopeHeld: true, error: 'Daily scope unavailable. Text and unresolved request are retained.' }); return null; }
  }
  available() {
    try { assertDailySessionScope(this.api, this.workspaceId); return !this.state.actionHold && !this.state.busy; }
    catch { return false; }
  }
  private retainedCandidate(result: ReplyDraftResult) {
    const candidate = this.state.incoming;
    return candidate && candidate.draft.revision >= result.draft.revision && !equal(candidate.draft, result.draft) ? candidate : null;
  }
  private acknowledge(result: ReplyDraftResult, pending: Pending, outcome: 'acknowledged' | 'reconciled', stale: boolean) {
    this.knownDrafts.push(result.draft);
    const record = this.records.find(entry => entry.request === pending.request);
    if (record) { record.outcome = outcome; record.result = structuredClone(result); }
    const incoming = this.retainedCandidate(result);
    this.update({ draft: result.draft, stale, pending: null, incoming, conflict: !!incoming, scopeHeld: false, error: null });
  }
  async save() {
    if (this.state.pending || this.state.stale || this.state.conflict || this.state.scopeHeld || !this.dirty()) return;
    const guard = this.guard(); if (!guard) return;
    try {
      const d = this.state.draft;
      const request = Object.freeze(editReplyDraftSchema.parse({ accountId: d.accountId, draftId: d.id,
        expectedRevision: d.revision, expectedThreadRevision: d.threadRevision, expectedContextRevision: d.contextRevision,
        subject: this.state.subject, body: this.state.body }));
      const pending = Object.freeze({ request, base: structuredClone(d) });
      this.records.push({ request, outcome: 'unknown' }); this.update({ pending });
      await this.send(pending, guard);
    } catch { this.update({ error: 'Reply text is invalid. Subject allows 240 characters and body 20,000, without prohibited controls.' }); }
  }
  async retry() {
    if (!this.state.pending || this.state.stale || this.state.scopeHeld) return;
    const guard = this.guard(); if (guard) await this.send(this.state.pending, guard);
  }
  private async send(pending: Pending, guard: () => void) {
    this.update({ busy: true, error: null });
    try {
      guard(); const result = boundReplyDraftResult(pending.request).parse(await this.api.editReplyDraft(pending.request));
      guard(); assertReplyDraftLineage(pending.base, result.draft);
      this.acknowledge(result, pending, 'acknowledged', result.stale || this.state.stale);
    } catch {
      let scopeHeld = this.state.scopeHeld; try { guard(); } catch { scopeHeld = true; }
      this.update({ scopeHeld, error: 'Save acknowledgement unavailable. Exact request and displayed text retained. Retry the same save or reconcile explicitly.' });
    } finally { this.update({ busy: false }); }
  }
  async reconcile() {
    const guard = this.guard(); if (!guard) return;
    const observation = this.dailyObservation;
    const pending = this.state.pending, base = structuredClone(pending?.base ?? this.state.draft);
    const request = { accountId: base.accountId, draftId: base.id };
    this.update({ busy: true, error: null });
    try {
      guard(); const result = boundReplyDraftResult(request).parse(await this.api.reconcileReplyDraft(request));
      guard(); assertReplyDraftLineage(base, result.draft);
      const stale = result.stale || (observation !== this.dailyObservation && this.state.stale);
      if (pending) {
        if (result.draft.revision === base.revision + 1 && result.draft.subject === pending.request.subject && result.draft.body === pending.request.body) {
          this.acknowledge(result, pending, 'reconciled', stale);
        } else {
          this.update({ incoming: this.retainedCandidate(result) ?? result, stale, scopeHeld: false,
            conflict: result.draft.revision !== base.revision,
            error: result.draft.revision === base.revision ? 'Saved predecessor found. Original save remains unresolved; only its exact retry is allowed.' : 'Different saved text found. Original request and displayed edits remain held.' });
        }
      } else {
        const dirty = this.dirty();
        this.knownDrafts.push(result.draft);
        const incoming = this.retainedCandidate(result);
        this.update({ draft: result.draft, stale, scopeHeld: false, conflict: !!incoming, incoming: incoming ?? (dirty ? result : null),
          ...(dirty ? {} : { subject: result.draft.subject, body: result.draft.body }) });
      }
    } catch {
      let scopeHeld = this.state.scopeHeld; try { guard(); } catch { scopeHeld = true; }
      this.update({ scopeHeld, error: 'Reconciliation unavailable or saved lineage differs. Text and original request are retained.' });
    } finally { this.update({ busy: false }); }
  }
  useSaved() {
    if (this.state.busy || !this.state.incoming) return;
    // Display choice is never evidence that an uncertain operation did not commit.
    const { subject, body } = this.state.incoming.draft;
    this.update({ subject, body });
  }
}
const sessions = new WeakMap<OrdinaryReplyApi, Map<string, OrdinaryReplySession>>();
export function ordinaryReplySession(api: OrdinaryReplyApi, workspaceId: string, draft: AccountReplyDraft, stale: boolean) {
  let values = sessions.get(api); if (!values) { values = new Map(); sessions.set(api, values); }
  const key = JSON.stringify([workspaceId, draft.accountId, draft.mailboxSubject, draft.threadId, draft.id]);
  let session = values.get(key); if (!session) { session = new OrdinaryReplySession(api, workspaceId, draft, stale); values.set(key, session); }
  return session;
}
