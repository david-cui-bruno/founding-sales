import { createContext, useContext, useEffect, useId, useReducer, useRef, type ReactNode } from 'react';
import {
  localCompanyInputSchema, localCompanyCreateRequestSchema, localCompanyReviewSchema,
  localCompanyCreateResultSchema, localCompanyCreateStatusSchema,
  type LocalCompanyInput, type LocalCompanyCreateRequest, type LocalCompanyReview,
} from '../../../shared/contracts/localCompanyIntakeContract';
import type { LocalWorkspaceApi, LocalWorkspaceSnapshot } from '../../../shared/contracts/localWorkspaceContract';
import type { LocalRead } from './localWorkspaceRead';

export type IntakeApi = Pick<LocalWorkspaceApi, 'reviewCompany' | 'createCompany' | 'getCompanyCreateStatus'>;
export type LocalCompanyIntakeOptions = {
  /** Pass the stable localWorkspace API itself, not a new wrapper each render. */
  api?: IntakeApi;
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
type ViewBinding = { token: symbol; options: LocalCompanyIntakeOptions };
type Owner = { api: LocalCompanyIntakeOptions['api']; scope: string | null; provider: boolean; state: FormState; sequence: number; active: boolean; busy: boolean; cancellations: Set<() => void>; listeners: Set<() => void>; view: ViewBinding | null };
const makeOwner = (api: LocalCompanyIntakeOptions['api'], scope: string | null, provider: boolean): Owner => ({ api, scope, provider, state: initial(), sequence: 0, active: true, busy: false, cancellations: new Set(), listeners: new Set(), view: null });
const notify = (owner: Owner) => { for (const listener of owner.listeners) listener(); };
const ownerContext = createContext<Owner | null>(null);

export function useLocalCompanyIntakeOwner(api?: IntakeApi) {
  const parent = useContext(ownerContext);
  const ownerRef = useRef<Owner | null>(null);
  if (parent && parent.api === api) {
    // A borrowed lifetime must never retain a disposed private owner for reuse.
    ownerRef.current = null;
    return { owner: parent, borrowed: true };
  }
  if (ownerRef.current === null || ownerRef.current.api !== api) ownerRef.current = makeOwner(api, null, true);
  return { owner: ownerRef.current, borrowed: false };
}

export const LocalCompanyIntakeOwnerContext = ownerContext;

/** Mount above fallback/ready branches. Retention is local to this hook's lifetime,
 * not a new global/session cache. No API calls happen on mount or refresh renders. */
export function useLocalCompanyIntake(options: LocalCompanyIntakeOptions) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const latest = useRef(options); latest.current = options;
  const provided = useContext(ownerContext);
  const fallbackRef = useRef<Owner | null>(null);
  const bindingToken = useRef<symbol | null>(null);
  // A rendered controller may act only for the binding generation it observed.
  const renderedToken = bindingToken.current;
  const usesProvided = !!provided && provided.api === options.api;
  if (!usesProvided && (fallbackRef.current === null || fallbackRef.current.api !== options.api || fallbackRef.current.scope !== options.scopeKey)) {
    fallbackRef.current = makeOwner(options.api, options.scopeKey, false);
  }
  const owner = usesProvided ? provided : fallbackRef.current!;
  if (!owner.provider) owner.view = { token: Symbol.for('fallback-local-company-view'), options };
  if (owner.provider && bindingToken.current !== null && owner.view?.token === bindingToken.current) owner.view = { ...owner.view, options };
  // Settlement belongs to the session even after its submitting view detaches.
  const sessionCurrent = () => owner.active && (owner.provider || latest.current.api === owner.api && latest.current.scopeKey === owner.scope);
  const settle = (sequence: number, patch: Partial<FormState>) => {
    if (sessionCurrent() && owner.sequence === sequence) { owner.state = { ...owner.state, ...patch }; notify(owner); }
  };
  const current = () => owner.active && latest.current.api === owner.api && (owner.provider || latest.current.scopeKey === owner.scope);
  const view = (token = renderedToken) => owner.provider ? owner.view?.token === token ? owner.view.options : null : latest.current;
  const eligibleView = (token = renderedToken) => {
    const bound = view(token);
    return current() && !!owner.api && !!bound && (!owner.provider || bound.scopeKey === 'local-company:accounts');
  };
  const update = (patch: Partial<FormState>, token = renderedToken) => { if (current() && (!owner.provider || owner.view?.token === token)) { owner.state = { ...owner.state, ...patch }; notify(owner); } };
  useEffect(() => {
    owner.listeners.add(redraw);
    owner.active = true;
    return () => { owner.listeners.delete(redraw); if (!owner.provider) { owner.active = false; owner.sequence++; for (const cancel of [...owner.cancellations]) cancel(); } };
  }, [owner]);
  useEffect(() => {
    if (!owner.provider || options.scopeKey !== 'local-company:accounts') return;
    const token = Symbol('local-company-view');
    bindingToken.current = token;
    owner.view = { token, options: latest.current };
    notify(owner);
    return () => { if (owner.view?.token === token) { owner.view = null; notify(owner); } if (bindingToken.current === token) bindingToken.current = null; };
  }, [owner, options.scopeKey]);
  const bounded = <T,>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); owner.cancellations.delete(cancel); reject(new Error('Local company operation unavailable')); };
    const timer = setTimeout(cancel, 15_000);
    owner.cancellations.add(cancel);
    operation.then(value => { clearTimeout(timer); owner.cancellations.delete(cancel); resolve(value); }, error => { clearTimeout(timer); owner.cancellations.delete(cancel); reject(error); });
  });
  const canAct = (token = renderedToken) => { const bound = view(token); return eligibleView(token) && !!bound?.available; };
  const reopen = (id: string, readRecovery = false) => {
    const bound = view();
    const token = renderedToken;
    if (!eligibleView(token) || !bound || !readRecovery && !bound.available) return;
    let failed = false;
    // Creation is already resolved. UI read/navigation errors cannot undo it.
    try { bound.onRefreshLocal(); } catch { failed = true; }
    try { bound.onOpenAccount(id); } catch { failed = true; }
    update({ openFailed: failed }, token);
  };
  const edit = (field: 'name' | 'domain', value: string) => {
    const token = renderedToken;
    if (!eligibleView(token) || locked(owner.state) || owner.state.phase === 'saved') return;
    owner.sequence++; owner.busy = false;
    update({ [field]: value, phase: 'editing', review: null, error: null, notice: null }, token);
  };
  const review = async () => {
    const token = renderedToken;
    if (!canAct(token) || owner.busy || locked(owner.state) || owner.state.phase === 'saved') return;
    const parsed = localCompanyInputSchema.safeParse({ name: owner.state.name, domain: owner.state.domain.trim().toLowerCase() || null });
    if (!parsed.success) { update({ error: 'Enter a company name and an optional hostname such as company.example, without a URL or path.', review: null, phase: 'editing' }); return; }
    const input = parsed.data;
    const sequence = ++owner.sequence; owner.busy = true;
    update({ phase: 'reviewing', review: null, error: null, notice: null }, token);
    try {
      const result = localCompanyReviewSchema.parse(await bounded(owner.api!.reviewCompany(input)));
      if (!sameInput(result.input, input)) throw new Error('Mismatched input');
      settle(sequence, { phase: 'reviewed', review: result, name: input.name, domain: input.domain ?? '' });
    } catch { settle(sequence, { phase: 'editing', error: 'Company review could not load. Review again before creating.', review: null }); }
    finally { if (sessionCurrent() && owner.sequence === sequence) { owner.busy = false; notify(owner); } }
  };
  const submit = async (kind: 'create' | 'retry' | 'status') => {
    const token = renderedToken;
    if (!canAct(token) || owner.busy) return;
    const submitView = token;
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
    update({ request, phase: kind === 'status' ? 'checking' : 'creating', notice: null, error: null }, token);
    const frozen = request!;
    try {
      const raw = await bounded<unknown>(kind === 'status'
        ? owner.api!.getCompanyCreateStatus({ ...frozen }) : owner.api!.createCompany({ ...frozen }));
      const result = kind === 'status' ? localCompanyCreateStatusSchema.parse(raw) : localCompanyCreateResultSchema.parse(raw);
      if (result.commandId !== frozen.commandId || result.status === 'saved' && !sameInput(result.account, frozen)
        || result.status === 'needs_review' && !sameInput(result.review.input, frozen)) throw new Error('Mismatched result');
      if (!sessionCurrent() || owner.sequence !== sequence) return;
      if (result.status === 'saved') {
        settle(sequence, { phase: 'saved', savedId: result.account.id, notice: 'Company saved.', review: null });
        if (!owner.provider || owner.view?.token === submitView) reopen(result.account.id);
      } else if (result.status === 'needs_review') {
        settle(sequence, { phase: 'reviewed', request: null, review: result.review, notice: 'The local catalog changed. Review existing companies before continuing.' });
      } else if (result.status === 'command_conflict') {
        settle(sequence, { phase: 'conflict', error: 'Command conflict. This request is held. Check local records or contact support before starting another creation.' });
      } else settle(sequence, { phase: 'unknown', notice: 'This request is not recorded yet. Its outcome may still arrive. Only an explicit retry will resubmit the same request.' });
    } catch { settle(sequence, { phase: 'unknown', notice: unknown }); }
    finally { if (sessionCurrent() && owner.sequence === sequence) { owner.busy = false; notify(owner); } }
  };
  const state = owner.state;
  const bound = view();
  const savedRead = bound?.localRead ?? options.localRead;
  const savedVisible = state.savedId !== null && savedRead.value?.accounts.state === 'available'
    && savedRead.value.accounts.snapshots.some(item => item.account.id === state.savedId);
  return {
    state, available: !!bound?.available && !!owner.api, canRead: eligibleView(), busy: owner.busy, locked: locked(state) || state.phase === 'saved',
    savedReadFailed: state.phase === 'saved' && (state.openFailed || savedRead.error || !savedRead.pending && !savedVisible),
    savedReadPending: state.phase === 'saved' && savedRead.pending,
    add: () => { const token = renderedToken; if (canAct(token) && !locked(owner.state) && !owner.busy) { owner.sequence++; owner.state = { ...initial(), open: true }; notify(owner); } },
    close: () => { const token = renderedToken; if (eligibleView(token) && !locked(owner.state)) { owner.sequence++; owner.busy = false; update({ open: false }, token); } },
    edit, review, create: () => submit('create'), retry: () => submit('retry'), checkStatus: () => submit('status'),
    openExisting: (id: string) => {
      const token = renderedToken;
      if (!canAct(token) || owner.busy || locked(owner.state) || !owner.state.review?.candidates.some(candidate => candidate.account.id === id)) return;
      reopen(id); update({ open: false }, token);
    },
    reopenSaved: () => { const token = renderedToken; if (eligibleView(token) && owner.state.phase === 'saved' && owner.state.savedId) reopen(owner.state.savedId, true); },
  };
}
export type LocalCompanyIntakeController = ReturnType<typeof useLocalCompanyIntake>;

export function LocalCompanyIntakeProvider({ api, children }: { api?: IntakeApi; children: ReactNode }) {
  const { owner, borrowed } = useLocalCompanyIntakeOwner(api);
  useEffect(() => {
    if (borrowed) return;
    owner.active = true;
    return () => { owner.active = false; owner.sequence++; for (const cancel of [...owner.cancellations]) cancel(); owner.view = null; notify(owner); };
  }, [borrowed, owner]);
  return <ownerContext.Provider value={owner}>{children}</ownerContext.Provider>;
}

export function LocalCompanyIntake({ controller: c }: { controller: LocalCompanyIntakeController }) {
  const id = useId(); const s = c.state;
  if (!s.open && !c.available) return null;
  const canCreate = c.available && !c.busy && s.phase === 'reviewed' && s.review?.complete && s.review.candidates.length === 0;
  return <section className="local-company-intake" aria-label="Add local company">
    <button type="button" disabled={!c.available || c.busy || c.locked && s.phase !== 'saved'} onClick={c.add}>Add company</button>
    {s.open && <form className="local-company-intake__form" aria-label="Local company intake" onSubmit={event => { event.preventDefault(); void c.review(); }}>
      <p>Manually entered local identity only, not verified company research or worker authority.</p>
      <label htmlFor={`${id}-name`}>Company name</label><input id={`${id}-name`} value={s.name} disabled={c.locked} readOnly={!c.available} onChange={event => c.edit('name', event.target.value)} />
      <label htmlFor={`${id}-domain`}>Company domain (optional)</label><input id={`${id}-domain`} value={s.domain} disabled={c.locked} readOnly={!c.available} onChange={event => c.edit('domain', event.target.value)} />
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
