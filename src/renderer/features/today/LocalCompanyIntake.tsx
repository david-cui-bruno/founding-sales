import { useEffect, useId, useReducer, useRef } from 'react';
import {
  localCompanyInputSchema, localCompanyCreateRequestSchema, localCompanyReviewSchema,
  localCompanyCreateResultSchema, localCompanyCreateStatusSchema,
  type LocalCompanyInput, type LocalCompanyCreateRequest, type LocalCompanyReview,
} from '../../../shared/contracts/localCompanyIntakeContract';
import type { LocalWorkspaceApi, LocalWorkspaceSnapshot } from '../../../shared/contracts/localWorkspaceContract';
import type { LocalRead } from './localWorkspaceRead';

export type LocalCompanyIntakeOptions = {
  /** Pass the stable localWorkspace API itself, not a new wrapper each render. */
  api?: Pick<LocalWorkspaceApi, 'reviewCompany' | 'createCompany' | 'getCompanyCreateStatus'>;
  /** Semantic local Accounts scope. Never a snapshot revision or worker scope. */
  scopeKey: string;
  available: boolean;
  localRead: LocalRead<LocalWorkspaceSnapshot>;
  onOpenAccount(id: string): void;
  onRefreshLocal(): void;
};
type Phase = 'editing' | 'reviewing' | 'reviewed' | 'creating' | 'unknown' | 'checking' | 'saved' | 'conflict';
type FormState = {
  open: boolean; name: string; domain: string; phase: Phase;
  review: LocalCompanyReview | null; request: Readonly<LocalCompanyCreateRequest> | null;
  savedId: string | null; notice: string | null; error: string | null; openFailed: boolean;
};
const initial = (): FormState => ({ open: false, name: '', domain: '', phase: 'editing', review: null, request: null, savedId: null, notice: null, error: null, openFailed: false });
const sameInput = (a: LocalCompanyInput, b: LocalCompanyInput) => a.name === b.name && a.domain === b.domain;
const locked = (state: FormState) => state.request !== null && state.phase !== 'saved';
const unknown = 'Save outcome unknown. The original request is retained. Check save status or explicitly retry the same request.';
type Owner = { api: LocalCompanyIntakeOptions['api']; scope: string; state: FormState; sequence: number; active: boolean; busy: boolean; cancellations: Set<() => void> };

/** Mount above fallback/ready branches. Retention is local to this hook's lifetime,
 * not a new global/session cache. No API calls happen on mount or refresh renders. */
export function useLocalCompanyIntake(options: LocalCompanyIntakeOptions) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const latest = useRef(options); latest.current = options;
  const ownerRef = useRef<Owner | null>(null);
  if (ownerRef.current === null || ownerRef.current.api !== options.api || ownerRef.current.scope !== options.scopeKey) {
    ownerRef.current = { api: options.api, scope: options.scopeKey, state: initial(), sequence: 0, active: true, busy: false, cancellations: new Set() };
  }
  const owner = ownerRef.current;
  const current = () => ownerRef.current === owner && owner.active
    && latest.current.api === owner.api && latest.current.scopeKey === owner.scope;
  const update = (patch: Partial<FormState>) => { if (current()) { owner.state = { ...owner.state, ...patch }; redraw(); } };
  useEffect(() => {
    owner.active = true;
    return () => { owner.active = false; owner.sequence++; for (const cancel of [...owner.cancellations]) cancel(); };
  }, [owner]);
  const bounded = <T,>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); owner.cancellations.delete(cancel); reject(new Error('Local company operation unavailable')); };
    const timer = setTimeout(cancel, 15_000);
    owner.cancellations.add(cancel);
    operation.then(value => { clearTimeout(timer); owner.cancellations.delete(cancel); resolve(value); }, error => { clearTimeout(timer); owner.cancellations.delete(cancel); reject(error); });
  });
  const canAct = () => current() && !!owner.api && latest.current.available;
  const reopen = (id: string, readRecovery = false) => {
    if (!current() || !owner.api || !readRecovery && !latest.current.available) return;
    let failed = false;
    // Creation is already resolved. UI read/navigation errors cannot undo it.
    try { latest.current.onRefreshLocal(); } catch { failed = true; }
    try { latest.current.onOpenAccount(id); } catch { failed = true; }
    update({ openFailed: failed });
  };
  const edit = (field: 'name' | 'domain', value: string) => {
    if (!current() || locked(owner.state) || owner.state.phase === 'saved') return;
    owner.sequence++; owner.busy = false;
    update({ [field]: value, phase: 'editing', review: null, error: null, notice: null });
  };
  const review = async () => {
    if (!canAct() || owner.busy || locked(owner.state) || owner.state.phase === 'saved') return;
    const parsed = localCompanyInputSchema.safeParse({ name: owner.state.name, domain: owner.state.domain.trim().toLowerCase() || null });
    if (!parsed.success) { update({ error: 'Enter a company name and an optional hostname such as company.example, without a URL or path.', review: null, phase: 'editing' }); return; }
    const input = parsed.data;
    const sequence = ++owner.sequence; owner.busy = true;
    update({ phase: 'reviewing', review: null, error: null, notice: null });
    try {
      const result = localCompanyReviewSchema.parse(await bounded(owner.api!.reviewCompany(input)));
      if (!sameInput(result.input, input)) throw new Error('Mismatched input');
      if (current() && owner.sequence === sequence) update({ phase: 'reviewed', review: result, name: input.name, domain: input.domain ?? '' });
    } catch { if (current() && owner.sequence === sequence) update({ phase: 'editing', error: 'Company review could not load. Review again before creating.', review: null }); }
    finally { if (current() && owner.sequence === sequence) { owner.busy = false; redraw(); } }
  };
  const submit = async (kind: 'create' | 'retry' | 'status') => {
    if (!canAct() || owner.busy) return;
    let request = owner.state.request;
    if (kind === 'create') {
      const state = owner.state;
      if (state.phase !== 'reviewed' || !state.review?.complete || state.review.candidates.length || request !== null) return;
      const input = localCompanyInputSchema.parse({ name: state.name, domain: state.domain || null });
      if (!sameInput(input, state.review.input)) return;
      request = Object.freeze(localCompanyCreateRequestSchema.parse({ ...input, commandId: crypto.randomUUID() }));
    } else if (owner.state.phase !== 'unknown' || request === null) return;
    // Synchronous fence before transport or render: double-clicks share one request.
    owner.busy = true;
    const sequence = ++owner.sequence;
    update({ request, phase: kind === 'status' ? 'checking' : 'creating', notice: null, error: null });
    const frozen = request!;
    try {
      const raw = await bounded<unknown>(kind === 'status'
        ? owner.api!.getCompanyCreateStatus({ ...frozen }) : owner.api!.createCompany({ ...frozen }));
      const result = kind === 'status' ? localCompanyCreateStatusSchema.parse(raw) : localCompanyCreateResultSchema.parse(raw);
      if (result.commandId !== frozen.commandId || result.status === 'saved' && !sameInput(result.account, frozen)
        || result.status === 'needs_review' && !sameInput(result.review.input, frozen)) throw new Error('Mismatched result');
      if (!current() || owner.sequence !== sequence) return;
      if (result.status === 'saved') {
        update({ phase: 'saved', savedId: result.account.id, notice: 'Company saved.', review: null });
        reopen(result.account.id);
      } else if (result.status === 'needs_review') {
        update({ phase: 'reviewed', request: null, review: result.review, notice: 'The local catalog changed. Review existing companies before continuing.' });
      } else if (result.status === 'command_conflict') {
        update({ phase: 'conflict', error: 'Command conflict. This request is held. Check local records or contact support before starting another creation.' });
      } else update({ phase: 'unknown', notice: 'This request is not recorded yet. Its outcome may still arrive. Only an explicit retry will resubmit the same request.' });
    } catch { if (current() && owner.sequence === sequence) update({ phase: 'unknown', notice: unknown }); }
    finally { if (current() && owner.sequence === sequence) { owner.busy = false; redraw(); } }
  };
  const state = owner.state;
  const savedRead = options.localRead;
  const savedVisible = state.savedId !== null && savedRead.value?.accounts.state === 'available'
    && savedRead.value.accounts.snapshots.some(item => item.account.id === state.savedId);
  return {
    state, available: options.available && !!options.api, canRead: !!options.api, busy: owner.busy, locked: locked(state) || state.phase === 'saved',
    savedReadFailed: state.phase === 'saved' && (state.openFailed || savedRead.error || !savedRead.pending && !savedVisible),
    savedReadPending: state.phase === 'saved' && savedRead.pending,
    add: () => { if (canAct() && !locked(owner.state) && !owner.busy) { owner.sequence++; owner.state = { ...initial(), open: true }; redraw(); } },
    close: () => { if (current() && !locked(owner.state)) { owner.sequence++; owner.busy = false; update({ open: false }); } },
    edit, review, create: () => submit('create'), retry: () => submit('retry'), checkStatus: () => submit('status'),
    openExisting: (id: string) => {
      if (!canAct() || owner.busy || locked(owner.state) || !owner.state.review?.candidates.some(candidate => candidate.account.id === id)) return;
      reopen(id); update({ open: false });
    },
    reopenSaved: () => { if (current() && owner.state.phase === 'saved' && owner.state.savedId) reopen(owner.state.savedId, true); },
  };
}
export type LocalCompanyIntakeController = ReturnType<typeof useLocalCompanyIntake>;

export function LocalCompanyIntake({ controller: c }: { controller: LocalCompanyIntakeController }) {
  const id = useId(); const s = c.state;
  if (!s.open && !c.available) return null;
  const canCreate = c.available && !c.busy && s.phase === 'reviewed' && s.review?.complete && s.review.candidates.length === 0;
  return <section className="local-company-intake" aria-label="Add local company">
    <button type="button" disabled={!c.available || c.busy || c.locked && s.phase !== 'saved'} onClick={c.add}>Add company</button>
    {s.open && <form className="local-company-intake__form" aria-label="Local company intake" onSubmit={event => { event.preventDefault(); void c.review(); }}>
      <p>Manually entered local identity only, not verified company research or worker authority.</p>
      <label htmlFor={`${id}-name`}>Company name</label><input id={`${id}-name`} value={s.name} disabled={c.locked || !c.available} onChange={event => c.edit('name', event.target.value)} />
      <label htmlFor={`${id}-domain`}>Company domain (optional)</label><input id={`${id}-domain`} value={s.domain} disabled={c.locked || !c.available} onChange={event => c.edit('domain', event.target.value)} />
      {!c.available && <p role="status">Local company intake is unavailable. Any unresolved request is retained.</p>}
      {s.error && <p role="alert">{s.error}</p>}
      {s.notice && <p role="status">{s.notice}</p>}
      {c.busy && <p role="status">{s.phase === 'reviewing' ? 'Reviewing local companies…' : s.phase === 'checking' ? 'Checking save status…' : 'Saving company…'}</p>}
      {s.review && <div>
        <p>Reviewed company: {s.review.input.name} · {s.review.input.domain ?? 'No domain entered'}</p>
        {!s.review.complete && <p role="status">Review is incomplete. Creating a company is held. Refine the input or review again.</p>}
        {s.review.complete && s.review.candidates.length === 0 && <p>No matching companies in the current local review.</p>}
        {s.review.candidates.map(candidate => <section key={candidate.account.id} aria-label={`Existing company ${candidate.account.name}`}>
          <h3>{candidate.account.name}</h3><p>{candidate.account.domain ?? 'Company domain not recorded'}</p>
          <p>{candidate.signals.map(signal => signal === 'same_name' ? 'Same company name' : 'Same company domain').join(' · ')}</p>
          <button type="button" disabled={!c.available || c.busy} onClick={() => c.openExisting(candidate.account.id)}>Open existing company</button>
        </section>)}
      </div>}
      <button type="submit" disabled={!c.available || c.busy || c.locked}>Review company</button>
      <button type="button" disabled={!canCreate} onClick={() => { void c.create(); }}>Create company</button>
      {s.phase === 'unknown' && <>
        <button type="button" disabled={!c.available || c.busy} onClick={() => { void c.checkStatus(); }}>Check save status</button>
        <button type="button" disabled={!c.available || c.busy} onClick={() => { void c.retry(); }}>Retry create</button>
      </>}
      {s.phase === 'saved' && <>
        {c.savedReadFailed && <p role="status">Current local evidence could not load. The company remains saved.</p>}
        {c.savedReadPending && <p role="status">Refreshing saved company evidence…</p>}
        <button type="button" disabled={!c.canRead} onClick={c.reopenSaved}>Refresh saved company</button>
      </>}
      <button type="button" disabled={c.locked && s.phase !== 'saved'} onClick={c.close}>Close company form</button>
    </form>}
  </section>;
}
