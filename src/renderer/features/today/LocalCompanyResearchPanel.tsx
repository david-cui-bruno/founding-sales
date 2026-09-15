import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { companyResearchSettingsSchema, type CompanyResearchSettings, type LinkCompanyPersonRequest, type LocalCompanyDetail, type LocalWorkspaceApi, type SelectedResearch } from '../../../shared/contracts/localWorkspaceContract';
import { openSettingsSection } from '../../foundation/settingsNavigation';
import type { FirstUseContinuation, FirstUseEpoch } from './localCompanyContinuation';

type Props = {
  accountId: string;
  api: Pick<LocalWorkspaceApi, 'getCompany' | 'researchCompany' | 'getCompanyResearchStatus'> & Partial<Pick<LocalWorkspaceApi, 'getCompanyResearchSettings'>>;
  continuation: FirstUseContinuation;
  renderDetail?(detail: LocalCompanyDetail): ReactNode;
};

/** Read-only mounting. Only the two explicit execution handlers cross research IPC. */
export function LocalCompanyResearchPanel({ accountId, api, continuation, renderDetail }: Props) {
  // Selection generations are view-local. Observe each owner notification, even
  // when React batches A -> B -> A into one render, so old closures stay stale.
  const knownLinkObservation = useRef<{ owner: FirstUseContinuation; epoch: FirstUseEpoch; request: LinkCompanyPersonRequest } | null>(null);
  const selection = useRef({ accountId: continuation.snapshot().selectedAccountId, token: Symbol('selection-view') });
  const subscribe = useCallback((listener: () => void) => continuation.subscribe(() => {
    const next = continuation.snapshot();
    const selectedAccountId = next.selectedAccountId;
    if (selectedAccountId === accountId && next.link?.outcome === 'known' && next.link.request.accountId === accountId) {
      knownLinkObservation.current = { owner: continuation, epoch: continuation.captureEpoch(), request: next.link.request };
    }
    if (selection.current.accountId !== selectedAccountId) selection.current = { accountId: selectedAccountId, token: Symbol('selection-view') };
    listener();
  }), [accountId, continuation]);
  const state = useSyncExternalStore(subscribe, continuation.snapshot, continuation.snapshot);
  const selectionToken = selection.current.token;
  const epoch = continuation.captureEpoch();
  const receiptVersion = state.research?.request.accountId === accountId ? state.research.status?.receipt?.version : undefined;
  const viewKey = useMemo(() => ({}), [accountId, api, continuation, epoch, selectionToken, state.selectedAccountId]);
  // Latch only known same-account request identities. Pending/unknown transitions
  // cannot undo this latch and trigger a second read. A new view reads normally.
  const observedLink = knownLinkObservation.current;
  const knownLink = state.link?.outcome === 'known' && state.link.request.accountId === accountId ? state.link.request
    : observedLink?.owner === continuation && observedLink.epoch === epoch && observedLink.request.accountId === accountId ? observedLink.request : null;
  const linkRead = useRef({ key: viewKey, request: knownLink });
  if (linkRead.current.key !== viewKey) linkRead.current = { key: viewKey, request: knownLink };
  else if (knownLink) linkRead.current.request = knownLink;
  const linkReceiptRequest = linkRead.current.request;
  const live = useRef<{ key: object; token: symbol } | null>(null);
  const [viewToken, setViewToken] = useState<symbol | null>(null);
  const [detail, setDetail] = useState<{ key: object; value: LocalCompanyDetail | null; failed: boolean } | null>(null);
  const [settings, setSettings] = useState<{ key: object; value: CompanyResearchSettings | null } | null>(null);
  useEffect(() => {
    let attached = true; setSettings(null);
    if (api.getCompanyResearchSettings) void api.getCompanyResearchSettings().then(value => {
      if (attached) setSettings({ key: viewKey, value: companyResearchSettingsSchema.parse(value) });
    }).catch(() => { if (attached) setSettings({ key: viewKey, value: null }); });
    return () => { attached = false; };
  }, [api, viewKey]);
  const [checkError, setCheckError] = useState<{ key: object; token: symbol } | null>(null);
  const checkSequence = useRef<symbol | null>(null);
  useLayoutEffect(() => {
    const token = Symbol('local-research-view');
    live.current = { key: viewKey, token };
    setViewToken(token);
    return () => { if (live.current?.token === token) live.current = null; };
  }, [viewKey]);
  const currentView = () => live.current?.key === viewKey && live.current.token === viewToken
    && selection.current.token === selectionToken
    && continuation.isCurrent(epoch) && continuation.snapshot().selectedAccountId === accountId;

  useEffect(() => {
    if (live.current?.key !== viewKey || live.current.token !== viewToken
      || selection.current.token !== selectionToken || !continuation.isCurrent(epoch) || continuation.snapshot().selectedAccountId !== accountId) return;
    let attached = true;
    const current = () => attached && live.current?.key === viewKey && live.current.token === viewToken
      && selection.current.token === selectionToken
      && continuation.isCurrent(epoch) && continuation.snapshot().selectedAccountId === accountId;
    setDetail(null);
    void (async () => {
      try {
        const value = await api.getCompany({ accountId });
        if (current()) setDetail({ key: viewKey, value: value.snapshot.account.id === accountId ? value : null, failed: value.snapshot.account.id !== accountId });
      } catch { if (current()) setDetail({ key: viewKey, value: null, failed: true }); }
    })();
    return () => { attached = false; };
  }, [accountId, api, continuation, epoch, receiptVersion, linkReceiptRequest, selectionToken, viewKey, viewToken]);

  const execute = async (request: Readonly<SelectedResearch>) => {
    if (!currentView()) return;
    const token = continuation.beginResearch(epoch, request);
    if (!token) return;
    if (!currentView()) { continuation.settleResearch(token, { outcome: 'unknown' }); return; }
    // Settlement is owner-bound, deliberately independent of view detachment.
    try {
      const status = await api.researchCompany(request);
      continuation.settleResearch(token, { outcome: 'known', status });
    } catch { continuation.settleResearch(token, { outcome: 'unknown' }); }
  };
  const research = () => {
    if (!currentView() || setupHeld) return;
    const previous = continuation.snapshot().research;
    if (previous && (previous.outcome !== 'known' || !previous.status
      || !['completed', 'parked', 'held'].includes(previous.status.state))) return;
    void execute(Object.freeze({ accountId, commandId: crypto.randomUUID() }));
  };
  const resume = () => {
    if (!currentView()) return;
    const previous = continuation.snapshot().research;
    if (!previous || previous.request.accountId !== accountId || previous.outcome === 'pending'
      || previous.status?.state === 'parked') return;
    void execute(previous.request);
  };
  const check = async () => {
    if (!currentView()) return;
    const previous = continuation.snapshot().research;
    if (!previous || previous.request.accountId !== accountId) return;
    const token = continuation.beginResearchStatus(epoch, previous.request);
    if (!token) return;
    const sequence = Symbol('status-view');
    checkSequence.current = sequence;
    setCheckError(null);
    const unavailable = () => {
      if (currentView() && checkSequence.current === sequence && viewToken
        && continuation.snapshot().research === previous) setCheckError({ key: viewKey, token: viewToken });
    };
    if (!currentView()) return;
    try {
      const status = await api.getCompanyResearchStatus(previous.request);
      if (!continuation.acceptResearchStatus(token, status)) unavailable();
    } catch { unavailable(); }
  };
  const retained = state.research?.request.accountId === accountId ? state.research : null;
  const canResearch = (!state.link || state.link.outcome === 'known') && (!state.research || state.research.outcome === 'known' && !!state.research.status
    && ['completed', 'parked', 'held'].includes(state.research.status.state));
  const visible = detail?.key === viewKey ? detail : null;
  const account = visible?.value?.snapshot;
  const setup = settings?.key === viewKey ? settings : null;
  const config = setup?.value?.configuration;
  const sourceMatches = !!account?.account.domain && !!config?.permittedSources.some(source => {
    try { return new URL(source).hostname === account.account.domain; } catch { return false; }
  });
  const setupHeld = !!api.getCompanyResearchSettings && (!setup?.value || !!config && (!!setup.value.blockedReason || config.state === 'paused' || !sourceMatches));
  const setupMessage = !api.getCompanyResearchSettings ? 'Local setup status unavailable. Main checks research availability.'
    : !setup ? 'Checking local research setup…'
    : !setup.value ? 'Local research setup unavailable. Reopen this company to check again.'
    : setup.value.blockedReason && config ? 'Paired research is present. Local research is held. Review Settings.'
    : setup.value.blockedReason ? 'Existing paired research remains governed by its policy. Standalone local activation is unavailable.'
    : !config ? 'Local research is not configured. Set up local research in Connections. Existing paired research, if configured, remains governed by its policy.'
    : config.state === 'paused' ? 'Local research is paused. Review Settings to enable a later explicit attempt.'
    : !account?.account.domain ? 'A saved company domain is required for local research.'
    : !sourceMatches ? 'No permitted source matches this company’s exact hostname. Review source URLs in Settings.'
    : 'Local known-company setup applies to this hostname. Main checks all limits before execution.';
  return <section aria-label="Local company research">
    {account && <>
      {account.portfolio.map((p, i) => <p key={i}>{p.count} {p.scope} {p.measure}</p>)}
      {!account.portfolio.length && <p>Portfolio not recorded.</p>}
      {account.claims.map((c, i) => <div key={i}><p>{c.kind === 'hypothesis' ? 'Hypothesis' : c.kind === 'prospect_stated_problem' ? 'Prospect stated' : 'Fact'}: {typeof c.value === 'string' ? c.value : `${c.value.count} ${c.value.scope} ${c.value.measure}`}</p><small>Evidence: {c.evidenceIds.join(', ') || 'Unverified'}</small></div>)}
      {account.unknowns.map((u, i) => <p key={`u${i}`}>Unknown: {u}</p>)}
      {account.conflicts.map((c, i) => <p key={`c${i}`}>Conflict: {c}</p>)}
      {account.routes.map(route => <p key={route.id}>{route.channel}: {route.value} · {route.purpose} · {route.verification}<br /><small>Evidence: {route.evidenceIds.join(', ') || 'Unverified'}</small></p>)}
    </>}
    <h3>Company research</h3>
    <p><a href="#/settings" onClick={() => openSettingsSection('connections')}>Set up local research</a>. Setup and navigation do not start research.</p>
    <p>Research starts a new potentially paid attempt. Check status or Resume research reconciles the existing attempt instead.</p>
    <p role="status">{setupMessage}</p>
    <button type="button" disabled={!canResearch || setupHeld} onClick={research}>Research</button>
    {retained && <>
      <p role="status">Research {retained.outcome}{retained.status ? ` · ${retained.status.state}` : ''}</p>
      <button type="button" onClick={() => { void check(); }}>Check status</button>
      <button type="button" disabled={retained.outcome === 'pending' || retained.status?.state === 'parked'} onClick={resume}>Resume research</button>
      <p>May fetch permitted sources or reconcile this existing attempt.</p>
    </>}
    {checkError?.key === viewKey && checkError.token === viewToken && <p role="status">Research status unavailable. Check again explicitly.</p>}
    {!visible && <p role="status">Loading company evidence…</p>}
    {visible?.failed && <p role="status">Company evidence unavailable. Reopen this detail to check again.</p>}
    {visible?.value && <>
      {renderDetail?.(visible.value)}
      <h3>Saved sources</h3>
      {!visible.value.sources.length && <p>No saved sources.</p>}
      {visible.value.sources.map(source => <section key={source.id} aria-label={`Source ${source.id}`}>
        <p>{source.url}</p><p>{source.sha256}</p><p>{source.fetchedAt}</p>
        <pre>{source.excerpt}</pre>
      </section>)}
    </>}
  </section>;
}
