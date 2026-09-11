import { emailDraftSchema, type EmailDraft, type OutreachApi } from '../../../shared/contracts/outreachContract';

type Snapshot = { draft: EmailDraft | null; subject: string; body: string; loading: boolean; busy: boolean; saving: boolean; conflict: boolean; error: string | null };
/** One recipient-bound session outlives its view so closing/switching cannot
 * cancel persistence or allow a later open to race an earlier save. */
class EmailDraftSession {
  private state: Snapshot = { draft: null, subject: '', body: '', loading: true, busy: false, saving: false, conflict: false, error: null };
  private listeners = new Set<() => void>();
  private saving: Promise<void> | null = null;
  private opening: Promise<void> | null = null;
  private editVersion = 0;
  constructor(private api: OutreachApi, private personId: string, private contactMethodId: string) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<Snapshot>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  private validate(input: EmailDraft, opening = false) {
    const draft = emailDraftSchema.parse(input);
    if (draft.personId !== this.personId || draft.contactMethodId !== this.contactMethodId
      || !opening && this.state.draft !== null && draft.id !== this.state.draft.id) throw new Error('Draft identity changed');
    return draft;
  }
  open() {
    if (this.opening !== null || this.state.busy) return this.opening ?? Promise.resolve();
    this.update({ loading: true });
    this.opening = (async () => {
      try {
        let saveFailed = false;
        try { await this.flush(); } catch { saveFailed = true; }
        const draft = this.validate(await this.api.openDraft({ personId: this.personId, contactMethodId: this.contactMethodId }), true);
        const conflict = saveFailed && (draft.subject !== this.state.subject || draft.body !== this.state.body);
        this.update({ draft, conflict, ...(conflict ? {} : { subject: draft.subject, body: draft.body }),
          error: conflict ? 'The saved draft changed. Your local text is retained below. Review both versions before explicitly replacing the saved version with your displayed edits.' : null });
      } catch { this.update({ error: 'Draft could not load or save. Your current edits are retained here.' }); }
      finally { this.opening = null; this.update({ loading: false }); }
    })();
    return this.opening;
  }
  edit(field: 'subject' | 'body', value: string) {
    if (this.state.draft?.status !== 'draft' || this.state.busy || this.state.loading) return;
    this.editVersion++;
    this.update({ [field]: value, error: null });
  }
  private dirty() { return this.state.draft !== null && (this.state.subject !== this.state.draft.subject || this.state.body !== this.state.draft.body); }
  flush(): Promise<void> {
    if (this.state.conflict) return Promise.reject(new Error('Draft conflict needs explicit review'));
    if (this.saving !== null) return this.saving;
    if (!this.dirty() || this.state.draft?.status !== 'draft') return Promise.resolve();
    this.update({ saving: true });
    this.saving = (async () => {
      try {
        while (this.dirty() && this.state.draft?.status === 'draft') {
          const { draft, subject, body } = this.state;
          const saved = this.validate(await this.api.saveDraft({ draftId: draft.id, expectedRevision: draft.revision, subject, body }));
          // Never replace edits typed while this save was in flight.
          this.update({ draft: saved, error: null });
        }
      } catch {
        this.update({ error: 'Changes could not be saved. Your edits are retained. Reopen before sending if the record changed.' });
        throw new Error('Draft save failed');
      } finally { this.saving = null; this.update({ saving: false }); }
    })();
    return this.saving;
  }
  saveDisplayedEdits(): Promise<void> {
    this.update({ conflict: false });
    return this.flush();
  }
  async generate() {
    if (this.state.busy || this.state.conflict || this.state.draft?.status !== 'draft') return;
    this.update({ busy: true });
    const version = this.editVersion;
    try {
      await this.flush();
      const draft = this.state.draft!;
      const generated = this.validate(await this.api.generateDraft({ draftId: draft.id, expectedRevision: draft.revision }));
      this.update({ draft: generated, ...(version === this.editVersion ? { subject: generated.subject, body: generated.body } : {}), error: null });
    } catch { this.update({ error: 'AI draft unavailable. Your current text is unchanged.' }); }
    finally { this.update({ busy: false }); }
  }
  async send() {
    if (this.state.busy || this.state.conflict || this.state.draft?.status !== 'draft') return;
    this.update({ busy: true, error: null });
    let dispatched = false;
    try {
      await this.flush();
      const draft = this.state.draft!;
      dispatched = true;
      const result = this.validate(await this.api.sendDraft({ draftId: draft.id, expectedRevision: draft.revision, commandId: crypto.randomUUID() }));
      this.update({ draft: result });
      if (result.status === 'sent') window.dispatchEvent(new CustomEvent('callie:email-sent', {
        detail: { personId: result.personId, salesCycleId: result.salesCycleId },
      }));
    } catch {
      if (dispatched && this.state.draft !== null) this.update({ draft: { ...this.state.draft, status: 'unknown' }, error: null });
      // A failed save already carries its retained-edit error, and never dispatches.
    } finally { this.update({ busy: false }); }
  }
}
const sessions = new WeakMap<OutreachApi, Map<string, EmailDraftSession>>();
export function emailDraftSession(api: OutreachApi, personId: string, contactMethodId: string) {
  let byRecipient = sessions.get(api);
  if (byRecipient === undefined) { byRecipient = new Map(); sessions.set(api, byRecipient); }
  const key = JSON.stringify([personId, contactMethodId]);
  let session = byRecipient.get(key);
  if (session === undefined) { session = new EmailDraftSession(api, personId, contactMethodId); byRecipient.set(key, session); }
  return session;
}
