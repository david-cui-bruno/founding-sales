import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { localCompanyDetailSchema, type LocalCompanyDetail, type LocalWorkspaceApi } from '../../../shared/contracts/localWorkspaceContract';
import { admitCompanyDraftEmailSchema, companyDraftAdmissionReply, companyDraftGetReply, companyDraftEmailSchema, companyDraftMailboxOccurrences,
  type AdmitCompanyDraftEmail, type CompanyDraftAdmissionReceipt } from '../../../shared/contracts/localCompanyDraftContract';
import { localCompanyDraftSession, companyDraftSelection, selectCompanyDraftSession, companyDraftSessionChoices, type LocalCompanyDraftSession } from './localCompanyDraftSession';
import { inboxCandidates, type InboxCandidate } from './inboxCandidates';

type Props = { api: LocalWorkspaceApi; detail: LocalCompanyDetail };
/** onEvidenceChanged fires after a successful inbox admission and after a draft is opened, never on failure, so the route owner can refresh its local read. */
type PanelProps = Props & { onEvidenceChanged?: () => void };
const card: CSSProperties = { marginTop: 'var(--space-4)', padding: 'var(--space-4)', border: '1px solid var(--line)',
  borderRadius: 'var(--radius-md)', background: 'var(--surface)', color: 'var(--text)', minWidth: 0, overflowWrap: 'anywhere' };
const field: CSSProperties = { display: 'block', width: '100%', minWidth: 0, marginTop: 'var(--space-2)',
  padding: 'var(--space-2)', border: '1px solid var(--line-interactive)', borderRadius: 'var(--radius-sm)',
  background: 'var(--surface)', color: 'var(--text)', font: 'inherit' };
const selectField: CSSProperties = { ...field, paddingBlock: 0 };
const actions: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', marginTop: 'var(--space-3)' };
const warning: CSSProperties = { padding: 'var(--space-3)', border: '1px solid var(--warning)', color: 'var(--warning)', background: 'var(--warning-soft)' };

// API identity is the workspace boundary. A replacement API synchronously replaces all view-local forms.
const apiKeys = new WeakMap<LocalWorkspaceApi, number>();
let nextApiKey = 0;
function apiKey(api: LocalWorkspaceApi) { let key = apiKeys.get(api); if (key === undefined) { key = ++nextApiKey; apiKeys.set(api, key); } return key; }
export function LocalCompanyDraft({ api, detail, onEvidenceChanged }: PanelProps) {
  return <CompanyDraftPanel key={JSON.stringify([apiKey(api), detail.snapshot.account.id])} api={api} detail={detail} onEvidenceChanged={onEvidenceChanged} />;
}
function CompanyDraftPanel({ api, detail, onEvidenceChanged }: PanelProps) {
  const [admitted, setAdmitted] = useState<{ basis: LocalCompanyDetail; detail: LocalCompanyDetail } | null>(null);
  const current = admitted?.basis === detail ? admitted.detail : detail;
  const routes = current.snapshot.routes.filter(route => route.channel === 'email' && route.personId === null
    && route.purpose === 'business' && (route.verification === 'published' || route.verification === 'confirmed') && route.evidenceIds.length > 0);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRoute = routes.find(route => route.id === selected) ?? routes[0];
  return <section aria-label="Company draft" style={card}>
    <header style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 'var(--space-2)' }}>
      <h3 style={{ margin: 0 }}>Company draft</h3><span style={{ color: 'var(--accent)', background: 'var(--accent-soft)', padding: 'var(--space-1) var(--space-2)' }}>Unsent</span>
    </header>
    <p>Company inbox, no named person verified.</p>
    <p><small>Prepare from saved company evidence, then review and save locally. Publication is not consent or send authority.</small></p>
    {routes.length > 1 && <label>Published business inbox<select style={selectField} value={selectedRoute.id} onChange={event => { setSelected(event.target.value); }}>
      {routes.map(route => <option key={route.id} value={route.id}>{route.value}</option>)}
    </select></label>}
    {selectedRoute ? <RetainedRouteDraft key={selectedRoute.id} api={api} accountId={current.snapshot.account.id} onEvidenceChanged={onEvidenceChanged}
      accountVersion={current.snapshot.account.version} routeId={selectedRoute.id} routeVersion={selectedRoute.version} routeValue={selectedRoute.value} eligible />
      : <InboxAdmission api={api} detail={current} onAdmitted={(next, routeId) => { setSelected(routeId); setAdmitted({ basis: detail, detail: next }); onEvidenceChanged?.(); }} />}
    {current.snapshot.routes.filter(route => !routes.some(eligible => eligible.id === route.id)).map(route =>
      <RetainedRouteDraft key={route.id} api={api} accountId={current.snapshot.account.id} accountVersion={current.snapshot.account.version}
        routeId={route.id} routeVersion={route.version} routeValue={route.value} eligible={false} onEvidenceChanged={onEvidenceChanged} />)}
  </section>;
}
function RetainedRouteDraft({ api, accountId, accountVersion, routeId, routeVersion, routeValue, eligible, onEvidenceChanged }: {
  api: LocalWorkspaceApi; accountId: string; accountVersion: number; routeId: string; routeVersion: number; routeValue: string; eligible: boolean; onEvidenceChanged?: () => void;
}) {
  const [selection, setSelection] = useState(() => companyDraftSelection(api, accountId, routeId));
  const session = localCompanyDraftSession(api, accountId, routeId, selection);
  const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const lifetime = useMemo(() => ({ live: false }), [session, accountVersion, routeVersion]);
  useEffect(() => { lifetime.live = true; void session.read(); return () => { lifetime.live = false; session.cancelPreparation(); }; }, [session, lifetime]);
  const choose = (value: string) => { selectCompanyDraftSession(api, accountId, routeId, value); setSelection(value); };
  const choices = companyDraftSessionChoices(api, accountId, routeId);
  if (!eligible && !state.current) return null;
  // A draft became visible through Open, or was recovered by an explicit re-review read. Failures never report a change.
  const opened = () => { if (lifetime.live) onEvidenceChanged?.(); };
  return <>
    {!eligible && <p>Previously saved company draft. This route is no longer eligible for new opening.</p>}
    {choices.length > 1 && <label>Retained company draft<select style={selectField} value={selection} onChange={event => choose(event.target.value)}>
      {choices.map(choice => <option key={choice.selection} value={choice.selection}>Version {choice.session.snapshot().current?.draft.recipientBinding.routeVersion} · {choice.session.snapshot().current?.draft.id}</option>)}
    </select></label>}
    <DraftEditor session={session} accountVersion={accountVersion} routeVersion={routeVersion} routeValue={routeValue}
      newVersion={selection === `${routeId}:${routeVersion}`} allowNewVersion={eligible} onOpened={opened}
      onNewVersion={() => choose(`${routeId}:${routeVersion}`)} onReviewOpening={() => session.reviewOpening(request => api.getCompany(request), () => lifetime.live)
        .then(reviewed => { if (reviewed && session.snapshot().visible) opened(); return reviewed; })}
      onPrepare={() => session.prepare(request => api.prepareCompanyDraft(request), accountVersion, () => lifetime.live)} />
    {selection !== 'saved' && <button type="button" onClick={() => choose('saved')}>Return to earlier draft</button>}
  </>;
}
function DraftEditor({ session, accountVersion, routeVersion, routeValue, newVersion, onNewVersion, onReviewOpening, onPrepare, onOpened, allowNewVersion = true }: {
  session: LocalCompanyDraftSession; accountVersion: number; routeVersion: number; routeValue: string; newVersion: boolean; onNewVersion(): void; onReviewOpening(): Promise<boolean>; onPrepare(): Promise<boolean>; onOpened?(): void; allowNewVersion?: boolean;
}) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const read = state.current, draft = read?.draft;
  return <>
    <p>{draft?.recipientBinding.email ?? routeValue}</p>
    <p><small>Published business inbox · Recipient fixed to this draft</small></p>
    {draft && <div style={{ borderLeft: '2px solid var(--line)', paddingLeft: 'var(--space-3)' }}>
      <blockquote style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{draft.publication.quote}</blockquote>
      <p><small>{draft.publication.url}<br />Saved source: {draft.publication.fetchedAt}</small></p>
    </div>}
    {read?.stale && <p role="status" style={warning}>{read.reason === 'suppressed'
      ? 'This company or inbox is suppressed. Saved text is read-only. Any local unsaved text is retained for copying.'
      : 'Saved recipient or evidence changed. This draft keeps its original recipient. Unsuppressed text remains editable.'}</p>}
    {newVersion && (!draft || draft.recipientBinding.routeVersion !== routeVersion) && <p style={warning}>New draft selected for {routeValue}. Earlier text will not be copied. Open explicitly to create the new frozen binding.</p>}
    {state.visible && draft ? <>
      {draft.subject === '' && draft.body === '' && <div style={actions}>
        <button type="button" disabled={!session.canPrepare()} onClick={() => void onPrepare()}>Prepare company draft</button>
        <small>{state.preparing ? 'Preparing from saved evidence…' : 'Uses your configured model once. No new research, approval or sending.'}</small>
      </div>}
      {state.preparation && <section aria-label="Preparation inputs" style={{ marginTop: 'var(--space-3)' }}>
        <h4>Company facts used for preparation</h4>
        <p><small>Saved evidence supplied to the model, not verification of every sentence or later edit. Review the wording before saving.</small></p>
        <ul>{state.preparation.grounding.facts.map(fact => <li key={fact.id}>
          <p>{preparationBrief(fact.text)}</p>
          <details><summary>Saved evidence and attribution</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{fact.text}</pre></details>
        </li>)}</ul>
        <p><small>Approved Callie playbook: {state.preparation.grounding.playbookVersion}. Preparation inputs are retained in this session, not a saved generation history.</small></p>
      </section>}
      <label style={{ display: 'block', marginTop: 'var(--space-3)' }}>Subject<input style={{ ...field, paddingBlock: 0 }} maxLength={240} value={state.subject} readOnly={!read.editable}
        onChange={event => session.edit('subject', event.target.value)} /></label>
      <label style={{ display: 'block', marginTop: 'var(--space-3)' }}>Message<textarea style={{ ...field, minHeight: 180, resize: 'vertical' }} rows={8} maxLength={20000}
        value={state.body} readOnly={!read.editable} onChange={event => session.edit('body', event.target.value)} /></label>
      <div style={actions}>
        <button type="button" disabled={state.busy || !read.editable || (state.conflict && !state.pendingSave) || (!session.dirty() && !state.pendingSave)} onClick={() => void session.save()}>Save</button>
        <button type="button" disabled={state.busy} onClick={() => void session.close()}>Close</button>
      </div>
      <p role="status">{state.busy ? 'Saving or recovering draft…' : state.pendingSave ? 'Save receipt unknown. Exact command retained for retry.' : session.dirty() ? 'Unsaved local text' : `Saved locally · revision ${draft.revision}`}</p>
      {(state.conflict || state.canReviewSaved || !read.editable && session.dirty()) && <details><summary>Last saved text</summary><p>{draft.subject}</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{draft.body}</pre></details>}
      {((state.conflict && !state.pendingSave) || state.canReviewSaved) && <button type="button" disabled={state.busy} onClick={() => session.useSavedText()}>Discard local edits and use saved text</button>}
    </> : <button type="button" style={{ marginTop: 'var(--space-3)' }} disabled={state.busy}
      onClick={() => void session.open(accountVersion, routeVersion, newVersion).then(opened => { if (opened) onOpened?.(); })}>{newVersion && (!draft || draft.recipientBinding.routeVersion !== routeVersion) ? 'Open new company draft' : draft ? 'Reopen company draft' : 'Open company draft'}</button>}
    {allowNewVersion && draft && draft.recipientBinding.routeVersion !== routeVersion && !newVersion && <button type="button" disabled={state.busy} onClick={onNewVersion}>Select current inbox for a new draft</button>}
    {state.pendingOpen && <button type="button" disabled={state.busy} onClick={() => void onReviewOpening()}>Review opening again</button>}
    {state.error && <p role="alert">{state.error}</p>}
    {(state.error || read?.stale) && <button type="button" disabled={state.busy} onClick={() => void session.read()}>Refresh draft read</button>}
  </>;
}

/** Presentation of main-selected facts only. Never interpret their content as HTML or instructions. */
function preparationBrief(text: string): string {
  try {
    const value: unknown = JSON.parse(text.slice(text.indexOf('{')));
    if (typeof value !== 'object' || value === null || !('claim' in value)) return text;
    const claim = value.claim;
    if (typeof claim !== 'object' || claim === null || !('key' in claim) || !('value' in claim) || typeof claim.key !== 'string') return text;
    return `${claim.key.replaceAll('_', ' ')}: ${typeof claim.value === 'string' ? claim.value : JSON.stringify(claim.value)}`;
  } catch { return text; }
}

type AdmissionState = { request: AdmitCompanyDraftEmail | null; receipt: CompanyDraftAdmissionReceipt | null;
  history: { request: AdmitCompanyDraftEmail; receipt: CompanyDraftAdmissionReceipt | null }[];
  reviewVersion: number | null; busy: boolean; version: number; listeners: Set<() => void> };
function admissionBusy(api: LocalWorkspaceApi, state: AdmissionState, busy: boolean) {
  state.busy = busy;
  for (const retained of admissions.get(api)?.values() ?? []) { retained.version++; retained.listeners.forEach(listener => listener()); }
}
function admissionBlocked(api: LocalWorkspaceApi, accountId: string) {
  return [...(admissions.get(api)?.values() ?? [])].some(state => state.busy && state.request?.accountId === accountId);
}
function receiptRoute(next: LocalCompanyDetail, receipt: CompanyDraftAdmissionReceipt) {
  const route = next.snapshot.routes.find(item => item.id === receipt.recipientBinding.routeId);
  const publication = next.sources.find(item => item.id === receipt.publication.sourceId);
  if (next.snapshot.account.id !== receipt.accountId || !route || route.version !== receipt.recipientBinding.routeVersion || route.value !== receipt.recipientBinding.email
    || route.personId !== null || route.channel !== 'email' || route.purpose !== 'business'
    || (route.verification !== 'published' && route.verification !== 'confirmed') || next.snapshot.account.version < receipt.accountVersion
    || !route.evidenceIds.includes(receipt.publication.sourceId) || !publication || publication.sha256 !== receipt.publication.sha256
    || publication.url !== receipt.publication.url || publication.fetchedAt !== receipt.publication.fetchedAt
    || !publication.excerpt.includes(receipt.publication.quote)) throw Error('Reviewed binding changed');
  return route;
}
const admissions = new WeakMap<LocalWorkspaceApi, Map<string, AdmissionState>>();
function admissionState(api: LocalWorkspaceApi, key: string) {
  let map = admissions.get(api); if (!map) { map = new Map(); admissions.set(api, map); }
  let state = map.get(key); if (!state) { state = { request: null, receipt: null, history: [], reviewVersion: null, busy: false, version: 0, listeners: new Set() }; map.set(key, state); } return state;
}
function InboxAdmission(props: Props & { onAdmitted(detail: LocalCompanyDetail, routeId: string): void }) {
  // A changed saved source/account observation invalidates the review, never silently substitutes a quotation.
  const key = JSON.stringify([props.detail.snapshot.account, props.detail.sources, props.detail.snapshot.routes]);
  // A suggestion is offered when the review opens untouched. Once the founder has touched the review, a changed observation clears the form instead.
  const review = useRef({ key, touched: false, suggest: true });
  if (review.current.key !== key) review.current = { key, touched: false, suggest: !review.current.touched };
  return <InboxAdmissionForm key={key} {...props} reviewKey={key} suggest={review.current.suggest} onTouch={() => { review.current.touched = true; }} />;
}
function InboxAdmissionForm({ api, detail, onAdmitted, reviewKey, suggest, onTouch }: Props & {
  onAdmitted(detail: LocalCompanyDetail, routeId: string): void; reviewKey: string; suggest: boolean; onTouch(): void;
}) {
  const retained = useMemo(() => admissionState(api, reviewKey), [api, reviewKey]);
  // Deterministic text match over the saved excerpts this form already holds: never verification, never admission.
  const found = useMemo(() => inboxCandidates(detail.sources), [detail.sources]);
  const suggestion = suggest && found.candidates.length === 1 ? found.candidates[0] : null;
  const [sourceId, setSourceId] = useState(retained.request?.sourceId ?? suggestion?.sourceId ?? '');
  const [email, setEmail] = useState(retained.request?.email ?? suggestion?.email ?? '');
  const [quote, setQuote] = useState(retained.request?.quote ?? suggestion?.quote ?? '');
  const [confirmed, setConfirmed] = useState(false);
  useSyncExternalStore(listener => { retained.listeners.add(listener); return () => { retained.listeners.delete(listener); }; }, () => retained.version, () => retained.version);
  const busy = retained.busy || admissionBlocked(api, detail.snapshot.account.id);
  const [reviewVersion, setReviewVersion] = useState(retained.reviewVersion ?? detail.snapshot.account.version);
  const [error, setError] = useState<string | null>(null);
  const lifetime = useMemo(() => ({ live: false }), []);
  useEffect(() => { lifetime.live = true; return () => { lifetime.live = false; }; }, [lifetime]);
  const source = detail.sources.find(item => item.id === sourceId);
  const parsedEmail = companyDraftEmailSchema.safeParse(email);
  const occurrence = source && parsedEmail.success && companyDraftMailboxOccurrences(source.excerpt, parsedEmail.data).some(token => {
    let start = source.excerpt.indexOf(quote);
    while (quote && start !== -1) { if (token.start >= start && token.end <= start + quote.length) return true; start = source.excerpt.indexOf(quote, start + 1); }
    return false;
  });
  const ready = !!(source && quote && confirmed && occurrence && parsedEmail.success);
  const submit = async () => {
    if (retained.busy || admissionBlocked(api, detail.snapshot.account.id) || (!retained.request && !ready)) return;
    admissionBusy(api, retained, true); setError(null);
    try {
      retained.request ??= Object.freeze(admitCompanyDraftEmailSchema.parse({ commandId: crypto.randomUUID(), accountId: detail.snapshot.account.id,
        expectedAccountVersion: reviewVersion, sourceId, email, quote, selection: 'published_company_business_inbox' }));
      retained.receipt ??= companyDraftAdmissionReply(retained.request).parse(await api.admitCompanyDraftEmail(retained.request));
      const next = localCompanyDetailSchema.parse(await api.getCompany({ accountId: detail.snapshot.account.id }));
      if (next.snapshot.account.id !== detail.snapshot.account.id) throw Error('Account changed');
      const route = receiptRoute(next, retained.receipt);
      if (lifetime.live) onAdmitted(next, route.id);
    } catch { if (lifetime.live) setError('Inbox review unavailable. No draft was opened. Retry the same reviewed selection.'); }
    finally { admissionBusy(api, retained, false); }
  };
  const reviewAgain = async () => {
    if (retained.busy || admissionBlocked(api, detail.snapshot.account.id) || !retained.request) return;
    const original = retained.request;
    admissionBusy(api, retained, true); setError(null);
    try {
      const next = localCompanyDetailSchema.parse(await api.getCompany({ accountId: original.accountId }));
      if (!lifetime.live || retained.request !== original || next.snapshot.account.id !== original.accountId
        || next.snapshot.account.version < original.expectedAccountVersion) throw Error('Review superseded');
      if (retained.receipt) {
        const route = receiptRoute(next, retained.receipt);
        onAdmitted(next, route.id); return; // A known receipt is never erased to correct a changed source.
      }
      const previousSource = detail.sources.find(item => item.id === original.sourceId);
      const freshSource = next.sources.find(item => item.id === original.sourceId);
      if (!previousSource || !freshSource || previousSource.url !== freshSource.url || previousSource.sha256 !== freshSource.sha256
        || previousSource.fetchedAt !== freshSource.fetchedAt || previousSource.excerpt !== freshSource.excerpt
        || previousSource.permitted !== freshSource.permitted) throw Error('Source observation changed');
      const routes = next.snapshot.routes.filter(route => route.personId === null && route.channel === 'email' && route.purpose === 'business'
        && ['published', 'confirmed'].includes(route.verification) && route.value === original.email && route.evidenceIds.includes(original.sourceId));
      if (routes.length > 1) throw Error('Ambiguous saved route');
      if (routes.length === 1) {
        const selector = { accountId: original.accountId, routeId: routes[0].id };
        companyDraftGetReply(selector).parse(await api.getCompanyDraft(selector));
        if (!lifetime.live || retained.request !== original) throw Error('Review superseded');
        // Saved route evidence is recovered, not the missing admission command receipt.
        onAdmitted(next, routes[0].id); return;
      }
      retained.history.push({ request: structuredClone(original), receipt: null });
      retained.request = null;
      retained.reviewVersion = next.snapshot.account.version;
      setReviewVersion(next.snapshot.account.version); setConfirmed(false);
      setError('Saved source refreshed. Review and explicitly submit a corrected selection. The earlier request is retained without a receipt.');
    } catch { if (lifetime.live) setError('Inbox re-review unavailable. The original request and any known receipt are retained.'); }
    finally { admissionBusy(api, retained, false); }
  };
  const chosen = found.candidates.find(candidate => candidate.sourceId === sourceId && candidate.email === email && candidate.quote === quote);
  const sourceUrl = (id: string) => detail.sources.find(item => item.id === id)?.url ?? id;
  const pick = (candidate: InboxCandidate) => { setSourceId(candidate.sourceId); setEmail(candidate.email); setQuote(candidate.quote); setConfirmed(false); onTouch(); };
  const chooseSource = (id: string) => {
    const own = found.candidates.filter(candidate => candidate.sourceId === id);
    setSourceId(id); setConfirmed(false); onTouch();
    if (own.length === 1) { setEmail(own[0].email); setQuote(own[0].quote); } else setQuote('');
  };
  return <div>
    <p>No published company business inbox route is selected. Review one saved source, without fetching new evidence.</p>
    <fieldset disabled={busy || !!retained.request} style={{ border: 0, padding: 0, minWidth: 0 }}>
      {found.candidates.length > 1 && <fieldset style={{ border: 0, padding: 0, minWidth: 0 }}>
        <legend>Candidate business inboxes found in saved sources</legend>
        <p><small>Found by matching saved text, not verified. Pick one to fill the fields below, then read the passage and confirm.</small></p>
        {found.candidates.map(candidate => <label key={`${candidate.sourceId} ${candidate.email}`} style={{ display: 'block' }}>
          <input type="radio" name={`inbox-candidate-${detail.snapshot.account.id}`} checked={chosen === candidate} onChange={() => pick(candidate)} /> <span>{candidate.email}</span> <small>{sourceUrl(candidate.sourceId)}</small>
        </label>)}
      </fieldset>}
      {found.excluded.length > 0 && <div>
        <p><small>Not offered: the address or its passage names a tenant, emergency, maintenance, repairs, urgent, resident or after-hours line.</small></p>
        <ul aria-label="Excluded addresses">{found.excluded.map(item => <li key={`${item.sourceId} ${item.email}`}><span>{item.email}</span> <small>matched “{item.matchedWord}” · {sourceUrl(item.sourceId)}</small></li>)}</ul>
      </div>}
      <label>Saved source<select style={selectField} value={sourceId} onChange={event => chooseSource(event.target.value)}>
        <option value="">Choose a saved source</option>{detail.sources.map(item => <option key={item.id} value={item.id}>{item.url}</option>)}
      </select></label>
      <label>Business inbox email<input style={field} value={email} maxLength={254} onChange={event => { setEmail(event.target.value); setConfirmed(false); onTouch(); }} /></label>
      <label>Exact publication quote<textarea style={field} value={quote} maxLength={12000} onChange={event => { setQuote(event.target.value); setConfirmed(false); onTouch(); }} /></label>
      <label style={{ display: 'block', marginTop: 'var(--space-3)' }}><input type="checkbox" checked={confirmed} onChange={event => { setConfirmed(event.target.checked); onTouch(); }} /> I reviewed the complete saved source and selected the company business inbox, not a tenant, emergency or after-hours-only address.</label>
    </fieldset>
    {chosen && <p><small>Filled from saved source {sourceUrl(chosen.sourceId)} by matching its text, not verified. Read the quoted passage before confirming.</small></p>}
    <button type="button" style={{ marginTop: 'var(--space-3)' }} disabled={busy || (!retained.request && !ready)} onClick={() => void submit()}>{retained.request ? 'Retry reviewed inbox admission' : 'Admit reviewed company inbox'}</button>
    {retained.request && <button type="button" disabled={busy} onClick={() => void reviewAgain()}>Review inbox selection again</button>}
    {error && <p role="alert">{error}</p>}
    {source && <details style={{ marginTop: 'var(--space-3)' }}>
      <summary>Show saved source text</summary>
      <p><small>{source.url} · Saved source: {source.fetchedAt}</small></p>
      {quote && quote !== source.excerpt && source.excerpt.includes(quote) && <>
        <p><small>Quoted passage</small></p>
        <blockquote style={{ margin: 0, borderLeft: '2px solid var(--line)', paddingLeft: 'var(--space-3)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{quote}</blockquote>
        <p><small>Complete saved source text</small></p>
      </>}
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{source.excerpt}</pre>
    </details>}
  </div>;
}
