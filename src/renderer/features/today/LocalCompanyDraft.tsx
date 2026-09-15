import { useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { localCompanyDetailSchema, type LocalCompanyDetail, type LocalWorkspaceApi } from '../../../shared/contracts/localWorkspaceContract';
import { admitCompanyDraftEmailSchema, companyDraftAdmissionReply, companyDraftGetReply, companyDraftEmailSchema, companyDraftMailboxOccurrences,
  type AdmitCompanyDraftEmail, type CompanyDraftAdmissionReceipt } from '../../../shared/contracts/localCompanyDraftContract';
import { localCompanyDraftSession, companyDraftSelection, selectCompanyDraftSession, companyDraftSessionChoices, type LocalCompanyDraftSession } from './localCompanyDraftSession';

type Props = { api: LocalWorkspaceApi; detail: LocalCompanyDetail };
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
export function LocalCompanyDraft({ api, detail }: Props) {
  return <CompanyDraftPanel key={JSON.stringify([apiKey(api), detail.snapshot.account.id])} api={api} detail={detail} />;
}
function CompanyDraftPanel({ api, detail }: Props) {
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
    <p><small>Manual local text only. Publication is not consent or send authority.</small></p>
    {routes.length > 1 && <label>Published business inbox<select style={selectField} value={selectedRoute.id} onChange={event => { setSelected(event.target.value); }}>
      {routes.map(route => <option key={route.id} value={route.id}>{route.value}</option>)}
    </select></label>}
    {selectedRoute ? <RetainedRouteDraft key={selectedRoute.id} api={api} accountId={current.snapshot.account.id}
      accountVersion={current.snapshot.account.version} routeId={selectedRoute.id} routeVersion={selectedRoute.version} routeValue={selectedRoute.value} eligible />
      : <InboxAdmission api={api} detail={current} onAdmitted={(next, routeId) => { setSelected(routeId); setAdmitted({ basis: detail, detail: next }); }} />}
    {current.snapshot.routes.filter(route => !routes.some(eligible => eligible.id === route.id)).map(route =>
      <RetainedRouteDraft key={route.id} api={api} accountId={current.snapshot.account.id} accountVersion={current.snapshot.account.version}
        routeId={route.id} routeVersion={route.version} routeValue={route.value} eligible={false} />)}
  </section>;
}
function RetainedRouteDraft({ api, accountId, accountVersion, routeId, routeVersion, routeValue, eligible }: {
  api: LocalWorkspaceApi; accountId: string; accountVersion: number; routeId: string; routeVersion: number; routeValue: string; eligible: boolean;
}) {
  const [selection, setSelection] = useState(() => companyDraftSelection(api, accountId, routeId));
  const session = localCompanyDraftSession(api, accountId, routeId, selection);
  const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const lifetime = useMemo(() => ({ live: false }), [session, accountVersion, routeVersion]);
  useEffect(() => { lifetime.live = true; void session.read(); return () => { lifetime.live = false; }; }, [session, lifetime]);
  const choose = (value: string) => { selectCompanyDraftSession(api, accountId, routeId, value); setSelection(value); };
  const choices = companyDraftSessionChoices(api, accountId, routeId);
  if (!eligible && !state.current) return null;
  return <>
    {!eligible && <p>Previously saved company draft. This route is no longer eligible for new opening.</p>}
    {choices.length > 1 && <label>Retained company draft<select style={selectField} value={selection} onChange={event => choose(event.target.value)}>
      {choices.map(choice => <option key={choice.selection} value={choice.selection}>Version {choice.session.snapshot().current?.draft.recipientBinding.routeVersion} · {choice.session.snapshot().current?.draft.id}</option>)}
    </select></label>}
    <DraftEditor session={session} accountVersion={accountVersion} routeVersion={routeVersion} routeValue={routeValue}
      newVersion={selection === `${routeId}:${routeVersion}`} allowNewVersion={eligible}
      onNewVersion={() => choose(`${routeId}:${routeVersion}`)} onReviewOpening={() => session.reviewOpening(request => api.getCompany(request), () => lifetime.live)} />
    {selection !== 'saved' && <button type="button" onClick={() => choose('saved')}>Return to earlier draft</button>}
  </>;
}
function DraftEditor({ session, accountVersion, routeVersion, routeValue, newVersion, onNewVersion, onReviewOpening, allowNewVersion = true }: {
  session: LocalCompanyDraftSession; accountVersion: number; routeVersion: number; routeValue: string; newVersion: boolean; onNewVersion(): void; onReviewOpening(): Promise<boolean>; allowNewVersion?: boolean;
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
      <label style={{ display: 'block', marginTop: 'var(--space-3)' }}>Subject<input style={field} maxLength={240} value={state.subject} readOnly={!read.editable}
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
      onClick={() => void session.open(accountVersion, routeVersion, newVersion)}>{newVersion && (!draft || draft.recipientBinding.routeVersion !== routeVersion) ? 'Open new company draft' : draft ? 'Reopen company draft' : 'Open company draft'}</button>}
    {allowNewVersion && draft && draft.recipientBinding.routeVersion !== routeVersion && !newVersion && <button type="button" disabled={state.busy} onClick={onNewVersion}>Select current inbox for a new draft</button>}
    {state.pendingOpen && <button type="button" disabled={state.busy} onClick={() => void onReviewOpening()}>Review opening again</button>}
    {state.error && <p role="alert">{state.error}</p>}
    {(state.error || read?.stale) && <button type="button" disabled={state.busy} onClick={() => void session.read()}>Refresh draft read</button>}
  </>;
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
  return <InboxAdmissionForm key={key} {...props} reviewKey={key} />;
}
function InboxAdmissionForm({ api, detail, onAdmitted, reviewKey }: Props & { onAdmitted(detail: LocalCompanyDetail, routeId: string): void; reviewKey: string }) {
  const retained = useMemo(() => admissionState(api, reviewKey), [api, reviewKey]);
  const [sourceId, setSourceId] = useState(retained.request?.sourceId ?? '');
  const [email, setEmail] = useState(retained.request?.email ?? '');
  const [quote, setQuote] = useState(retained.request?.quote ?? '');
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
  return <div>
    <p>No published company business inbox route is selected. Review one saved source, without fetching new evidence.</p>
    <fieldset disabled={busy || !!retained.request} style={{ border: 0, padding: 0, minWidth: 0 }}>
      <label>Saved source<select style={selectField} value={sourceId} onChange={event => { setSourceId(event.target.value); setConfirmed(false); setQuote(''); }}>
        <option value="">Choose a saved source</option>{detail.sources.map(item => <option key={item.id} value={item.id}>{item.url}</option>)}
      </select></label>
      {source && <div><p>{source.url}</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{source.excerpt}</pre></div>}
      <label>Business inbox email<input style={field} value={email} maxLength={254} onChange={event => { setEmail(event.target.value); setConfirmed(false); }} /></label>
      <label>Exact publication quote<textarea style={field} value={quote} maxLength={12000} onChange={event => { setQuote(event.target.value); setConfirmed(false); }} /></label>
      <label style={{ display: 'block', marginTop: 'var(--space-3)' }}><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> I reviewed the complete saved source and selected the company business inbox, not a tenant, emergency or after-hours-only address.</label>
    </fieldset>
    <button type="button" style={{ marginTop: 'var(--space-3)' }} disabled={busy || (!retained.request && !ready)} onClick={() => void submit()}>{retained.request ? 'Retry reviewed inbox admission' : 'Admit reviewed company inbox'}</button>
    {retained.request && <button type="button" disabled={busy} onClick={() => void reviewAgain()}>Review inbox selection again</button>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
