import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { localCompanyDetailSchema, type LocalCompanyDetail, type LocalWorkspaceApi } from '../../../shared/contracts/localWorkspaceContract';
import { admitCompanyPhoneRouteSchema, companyPhoneRouteReply, normaliseCompanyPhone, type AdmitCompanyPhoneRoute, type CompanyPhoneRouteReceipt } from '../../../shared/contracts/localCompanyPhoneRouteContract';
import { phoneCandidates, type PhoneCandidate } from './phoneCandidates';

type Route = LocalCompanyDetail['snapshot']['routes'][number];
type Admit = NonNullable<LocalWorkspaceApi['admitCompanyPhoneRoute']>;
/** onEvidenceChanged fires once after a successful admission, never on failure, so the route owner can refresh its local read. */
type Props = { api: LocalWorkspaceApi; detail: LocalCompanyDetail; onEvidenceChanged?: () => void };
const card: CSSProperties = { marginTop: 'var(--space-4)', padding: 'var(--space-4)', border: '1px solid var(--line)',
  borderRadius: 'var(--radius-md)', background: 'var(--surface)', color: 'var(--text)', minWidth: 0, overflowWrap: 'anywhere' };
const field: CSSProperties = { display: 'block', width: '100%', minWidth: 0, marginTop: 'var(--space-2)',
  padding: 'var(--space-2)', border: '1px solid var(--line-interactive)', borderRadius: 'var(--radius-sm)',
  background: 'var(--surface)', color: 'var(--text)', font: 'inherit' };
const selectField: CSSProperties = { ...field, paddingBlock: 0 };
const plain: CSSProperties = { border: 0, padding: 0, minWidth: 0 };

/** A published or confirmed company business line with evidence: the same eligibility the Campaigns route dropdown applies. */
export const businessPhoneRoute = (route: Route) => route.channel === 'phone' && route.personId === null && route.purpose === 'business'
  && (route.verification === 'published' || route.verification === 'confirmed') && route.evidenceIds.length > 0;

// API identity is the workspace boundary. A replacement API synchronously replaces all view-local forms.
const apiKeys = new WeakMap<LocalWorkspaceApi, number>();
let nextApiKey = 0;
function apiKey(api: LocalWorkspaceApi) { let key = apiKeys.get(api); if (key === undefined) { key = ++nextApiKey; apiKeys.set(api, key); } return key; }
export function LocalCompanyPhoneRoute({ api, detail, onEvidenceChanged }: Props) {
  return <PhoneRoutePanel key={JSON.stringify([apiKey(api), detail.snapshot.account.id])} api={api} detail={detail} onEvidenceChanged={onEvidenceChanged} />;
}
function PhoneRoutePanel({ api, detail, onEvidenceChanged }: Props) {
  const [admitted, setAdmitted] = useState<{ basis: LocalCompanyDetail; detail: LocalCompanyDetail } | null>(null);
  const current = admitted?.basis === detail ? admitted.detail : detail;
  const saved = current.snapshot.routes.filter(businessPhoneRoute);
  const admit = api.admitCompanyPhoneRoute;
  return <section aria-label="Phone route review" style={card}>
    <h3 style={{ margin: 0 }}>Review phone route</h3>
    <p>Company business line, no named person.</p>
    <p><small>Review one saved source, without fetching new evidence. Saving a route is not a call, not a check that the number answers and not a route on a worker.</small></p>
    {saved.map(route => <p key={route.id}>Saved business phone route: {route.value} ({route.verification})</p>)}
    {admit ? <PhoneRouteReview api={api} admit={admit} detail={current} saved={saved} onAdmitted={next => { setAdmitted({ basis: detail, detail: next }); onEvidenceChanged?.(); }} />
      : <p>Phone route review is unavailable in this build.</p>}
  </section>;
}

type ReviewProps = { api: LocalWorkspaceApi; admit: Admit; detail: LocalCompanyDetail; saved: Route[]; onAdmitted(detail: LocalCompanyDetail): void };
function PhoneRouteReview(props: ReviewProps) {
  // A changed saved source/account observation invalidates the review, never silently substitutes a quotation.
  const key = JSON.stringify([props.detail.snapshot.account, props.detail.sources, props.detail.snapshot.routes]);
  // A suggestion is offered when the review opens untouched. Once the founder has touched the review, a changed observation clears the form instead.
  const review = useRef({ key, touched: false, suggest: true });
  if (review.current.key !== key) review.current = { key, touched: false, suggest: !review.current.touched };
  return <PhoneRouteForm key={key} {...props} reviewKey={key} suggest={review.current.suggest} onTouch={() => { review.current.touched = true; }} />;
}

type Retained = { request: AdmitCompanyPhoneRoute | null; receipt: CompanyPhoneRouteReceipt | null;
  history: { request: AdmitCompanyPhoneRoute; receipt: CompanyPhoneRouteReceipt | null }[];
  reviewVersion: number | null; busy: boolean; version: number; listeners: Set<() => void> };
const admissions = new WeakMap<LocalWorkspaceApi, Map<string, Retained>>();
function retainedAdmission(api: LocalWorkspaceApi, key: string) {
  let map = admissions.get(api); if (!map) { map = new Map(); admissions.set(api, map); }
  let state = map.get(key); if (!state) { state = { request: null, receipt: null, history: [], reviewVersion: null, busy: false, version: 0, listeners: new Set() }; map.set(key, state); } return state;
}
function admissionBusy(api: LocalWorkspaceApi, state: Retained, busy: boolean) {
  state.busy = busy;
  for (const retained of admissions.get(api)?.values() ?? []) { retained.version++; retained.listeners.forEach(listener => listener()); }
}
function admissionBlocked(api: LocalWorkspaceApi, accountId: string) {
  return [...(admissions.get(api)?.values() ?? [])].some(state => state.busy && state.request?.accountId === accountId);
}
/** The saved route the receipt names must be readable in the fresh detail exactly as reviewed; otherwise the admission is not shown as done. */
function receiptRoute(next: LocalCompanyDetail, receipt: CompanyPhoneRouteReceipt) {
  const route = next.snapshot.routes.find(item => item.id === receipt.route.routeId);
  const publication = next.sources.find(item => item.id === receipt.publication.sourceId);
  if (next.snapshot.account.id !== receipt.accountId || !route || route.version !== receipt.route.routeVersion || normaliseCompanyPhone(route.value) !== receipt.route.phone
    || !businessPhoneRoute(route) || next.snapshot.account.version < receipt.accountVersion || !route.evidenceIds.includes(receipt.publication.sourceId)
    || !publication || publication.sha256 !== receipt.publication.sha256 || publication.url !== receipt.publication.url
    || publication.fetchedAt !== receipt.publication.fetchedAt || !publication.excerpt.includes(receipt.publication.quote)) throw Error('Reviewed route changed');
  return route;
}
function PhoneRouteForm({ api, admit, detail, saved, onAdmitted, reviewKey, suggest, onTouch }: ReviewProps & { reviewKey: string; suggest: boolean; onTouch(): void }) {
  const retained = useMemo(() => retainedAdmission(api, reviewKey), [api, reviewKey]);
  // Deterministic text match over the saved excerpts this form already holds: never verification, never admission.
  const found = useMemo(() => phoneCandidates(detail.sources), [detail.sources]);
  const savedNumbers = new Set(saved.map(route => normaliseCompanyPhone(route.value) ?? route.value));
  const offered = found.candidates.filter(candidate => !savedNumbers.has(candidate.phone));
  const suggestion = suggest && offered.length === 1 ? offered[0] : null;
  const initial = retained.request ?? suggestion;
  const [sourceId, setSourceId] = useState(initial?.sourceId ?? '');
  const [phone, setPhone] = useState<string | null>(initial?.phone ?? null);
  const [confirmed, setConfirmed] = useState(false);
  useSyncExternalStore(listener => { retained.listeners.add(listener); return () => { retained.listeners.delete(listener); }; }, () => retained.version, () => retained.version);
  const busy = retained.busy || admissionBlocked(api, detail.snapshot.account.id);
  const [reviewVersion, setReviewVersion] = useState(retained.reviewVersion ?? detail.snapshot.account.version);
  const [error, setError] = useState<string | null>(null);
  const lifetime = useMemo(() => ({ live: false }), []);
  useEffect(() => { lifetime.live = true; return () => { lifetime.live = false; }; }, [lifetime]);
  const chosen = offered.find(candidate => candidate.sourceId === sourceId && candidate.phone === phone) ?? null;
  const source = detail.sources.find(item => item.id === sourceId);
  const ready = !!(chosen && source && confirmed);
  const submit = async () => {
    if (retained.busy || admissionBlocked(api, detail.snapshot.account.id) || (!retained.request && !(ready && chosen))) return;
    admissionBusy(api, retained, true); setError(null);
    try {
      // Exactly the displayed values: the E.164 number the route stores and the verbatim passage. The command keeps its identity across retries.
      retained.request ??= Object.freeze(admitCompanyPhoneRouteSchema.parse({ commandId: crypto.randomUUID(), accountId: detail.snapshot.account.id,
        expectedAccountVersion: reviewVersion, phone: chosen!.phone, sourceId: chosen!.sourceId, quote: chosen!.quote, selection: 'published_company_business_phone' }));
      retained.receipt ??= companyPhoneRouteReply(retained.request).parse(await admit(retained.request));
      const next = localCompanyDetailSchema.parse(await api.getCompany({ accountId: detail.snapshot.account.id }));
      if (next.snapshot.account.id !== detail.snapshot.account.id) throw Error('Account changed');
      receiptRoute(next, retained.receipt);
      if (lifetime.live) onAdmitted(next);
    } catch { if (lifetime.live) setError('Phone route review unavailable. Whether the route was saved is unknown until the same reviewed selection is retried.'); }
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
      if (retained.receipt) { receiptRoute(next, retained.receipt); onAdmitted(next); return; } // A known receipt is never erased to correct a changed source.
      const previousSource = detail.sources.find(item => item.id === original.sourceId);
      const freshSource = next.sources.find(item => item.id === original.sourceId);
      if (!previousSource || !freshSource || previousSource.url !== freshSource.url || previousSource.sha256 !== freshSource.sha256
        || previousSource.fetchedAt !== freshSource.fetchedAt || previousSource.excerpt !== freshSource.excerpt) throw Error('Source observation changed');
      const routes = next.snapshot.routes.filter(route => businessPhoneRoute(route) && normaliseCompanyPhone(route.value) === original.phone && route.evidenceIds.includes(original.sourceId));
      if (routes.length > 1) throw Error('Ambiguous saved route');
      if (routes.length === 1) { onAdmitted(next); return; } // Saved route evidence is recovered, not the missing admission command receipt.
      retained.history.push({ request: original, receipt: null });
      retained.request = null;
      retained.reviewVersion = next.snapshot.account.version;
      setReviewVersion(next.snapshot.account.version); setConfirmed(false);
      setError('Saved evidence refreshed and no phone route was saved. Review and explicitly confirm the selection again. The earlier request is retained without a receipt.');
    } catch { if (lifetime.live) setError('Phone route re-review unavailable. The original request and any known receipt are retained.'); }
    finally { admissionBusy(api, retained, false); }
  };
  const sourceUrl = (id: string) => detail.sources.find(item => item.id === id)?.url ?? id;
  const pick = (candidate: PhoneCandidate) => { setSourceId(candidate.sourceId); setPhone(candidate.phone); setConfirmed(false); onTouch(); };
  const chooseSource = (id: string) => {
    const own = offered.filter(candidate => candidate.sourceId === id);
    setSourceId(id); setPhone(own.length === 1 ? own[0].phone : null); setConfirmed(false); onTouch();
  };
  return <div>
    {offered.length === 0 && <p>{found.candidates.length > 0 ? 'Every phone number found in saved sources is already saved as the business line.'
      : found.excluded.length > 0 ? 'No business line is offered from saved sources; every number found names an excluded line.' : 'No phone number was found in saved sources.'}</p>}
    {found.excluded.length > 0 && <div>
      <p><small>Not offered: the passage around the number names a tenant, emergency, maintenance, repairs, urgent, resident or after-hours line.</small></p>
      <ul aria-label="Excluded numbers">{found.excluded.map(item => <li key={`${item.sourceId} ${item.phone}`}><span>{item.display}</span> <small>matched “{item.matchedWord}” · {sourceUrl(item.sourceId)}</small></li>)}</ul>
    </div>}
    {offered.length > 0 && <>
      <p>Found by matching saved text, not verified. Read the passage, then confirm.</p>
      <fieldset disabled={busy || !!retained.request} style={plain}>
        {offered.length > 1 && <fieldset style={plain}>
          <legend>Candidate business lines found in saved sources</legend>
          <p><small>Pick one to fill the fields below, then read the passage and confirm.</small></p>
          {offered.map(candidate => <label key={`${candidate.sourceId} ${candidate.phone}`} style={{ display: 'block' }}>
            <input type="radio" name={`phone-candidate-${detail.snapshot.account.id}`} checked={chosen === candidate} onChange={() => pick(candidate)} /> <span>{candidate.display}</span> <small>{sourceUrl(candidate.sourceId)}</small>
          </label>)}
        </fieldset>}
        <label>Saved source for the phone route<select style={selectField} value={sourceId} onChange={event => chooseSource(event.target.value)}>
          <option value="">Choose a saved source</option>{detail.sources.map(item => <option key={item.id} value={item.id}>{item.url}</option>)}
        </select></label>
        <label>Business phone number<input style={field} value={chosen?.display ?? ''} readOnly /></label>
        <label>Exact source passage<textarea style={field} value={chosen?.quote ?? ''} readOnly /></label>
        <label style={{ display: 'block', marginTop: 'var(--space-3)' }}><input type="checkbox" checked={confirmed} onChange={event => { setConfirmed(event.target.checked); onTouch(); }} /> This is the company&apos;s business line, not a tenant, emergency or maintenance line</label>
      </fieldset>
      {chosen && <p><small>Filled from saved source {sourceUrl(chosen.sourceId)} by matching its text, not verified. Saved as {chosen.phone}.</small></p>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
        <button type="button" disabled={busy || (!retained.request && !ready)} onClick={() => void submit()}>{retained.request ? 'Retry phone route admission' : 'Admit phone route'}</button>
        {retained.request && <button type="button" disabled={busy} onClick={() => void reviewAgain()}>Review phone route again</button>}
      </div>
    </>}
    {error && <p role="alert">{error}</p>}
    {source && chosen && <details style={{ marginTop: 'var(--space-3)' }}>
      <summary>Show the saved source for this number</summary>
      <p><small>{source.url} · Saved source: {source.fetchedAt}</small></p>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{source.excerpt}</pre>
    </details>}
  </div>;
}
