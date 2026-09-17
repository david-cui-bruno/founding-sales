import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CalliePreloadApi } from '../../../shared/preload';
import { leadDetailSchema, type LeadDetail } from '../../../shared/contracts/leadDetailContract';
import type { LeadRow, LeadsListRequest } from '../../../shared/contracts/leadsContract';
import type { LinkCompanyPersonRequest, LocalCompanyDetail, LocalWorkspaceApi } from '../../../shared/contracts/localWorkspaceContract';
import type { FirstUseContinuation, FirstUseReview } from './localCompanyContinuation';

export type LocalCompanyContactApi = Pick<CalliePreloadApi, 'leads' | 'leadDetail'> & {
  localWorkspace: Pick<LocalWorkspaceApi, 'getCompany' | 'linkCompanyPerson'>;
};
type Props = {
  detail: LocalCompanyDetail;
  api: LocalCompanyContactApi;
  continuation: FirstUseContinuation;
};
type SearchPage = { key: object; token: symbol; generation: symbol; rows: LeadRow[]; cursor: string | null; pending: boolean; failed: boolean };

/** One explicit saved identity and one quoted relationship. No importer or company reader. */
export function LocalCompanyContactLink({ detail, api, continuation }: Props) {
  const accountId = detail.snapshot.account.id;
  const selection = useRef({ accountId: continuation.snapshot().selectedAccountId, token: Symbol('contact-selection') });
  const subscribe = useCallback((listener: () => void) => continuation.subscribe(() => {
    const selected = continuation.snapshot().selectedAccountId;
    if (selection.current.accountId !== selected) selection.current = { accountId: selected, token: Symbol('contact-selection') };
    listener();
  }), [continuation]);
  const state = useSyncExternalStore(subscribe, continuation.snapshot, continuation.snapshot);
  const epoch = continuation.captureEpoch();
  const selectionToken = selection.current.token;
  const viewKey = useMemo(() => ({}), [accountId, api, continuation, epoch, selectionToken]);
  const live = useRef<{ key: object; token: symbol } | null>(null);
  const [viewToken, setViewToken] = useState<symbol | null>(null);
  const queryVersion = useRef(Symbol('search-input'));
  const [queryState, setQueryState] = useState({ value: '', token: queryVersion.current });
  const query = queryState.value;
  const [page, setPage] = useState<SearchPage | null>(null);
  const search = useRef<{ key: object; generation: symbol; request: LeadsListRequest; pending: boolean } | null>(null);
  const personSequence = useRef<symbol | null>(null);
  const [person, setPerson] = useState<{ key: object; token: symbol; value: LeadDetail | null; failed: boolean } | null>(null);
  const [confirmation, setConfirmation] = useState<{ key: object; review: FirstUseReview } | null>(null);
  useLayoutEffect(() => {
    const token = Symbol('contact-view');
    live.current = { key: viewKey, token };
    setViewToken(token);
    queryVersion.current = Symbol('search-input');
    setQueryState({ value: '', token: queryVersion.current });
    setConfirmation(null);
    return () => { if (live.current?.token === token) live.current = null; };
  }, [viewKey]);
  const currentView = useCallback(() => live.current?.key === viewKey && live.current.token === viewToken
    && selection.current.token === selectionToken && continuation.isCurrent(epoch)
    && continuation.snapshot().selectedAccountId === accountId,
  [accountId, continuation, epoch, selectionToken, viewKey, viewToken]);

  const readPerson = useCallback(async (personId: string) => {
    if (!currentView() || !viewToken) return;
    const generation = Symbol('person-detail');
    personSequence.current = generation;
    setPerson(null);
    const current = () => currentView() && personSequence.current === generation
      && continuation.snapshot().review.accountId === accountId
      && continuation.snapshot().review.personId === personId;
    try {
      if (!current()) return;
      const response = await api.leadDetail.get({ personId });
      if (!current()) return;
      const parsed = leadDetailSchema.safeParse(response);
      const value = parsed.success && parsed.data.personId === personId ? parsed.data : null;
      setPerson({ key: viewKey, token: viewToken, value, failed: value === null });
    } catch { if (current()) setPerson({ key: viewKey, token: viewToken, value: null, failed: true }); }
  }, [accountId, api, continuation, currentView, viewKey, viewToken]);
  useEffect(() => {
    // Restore only an identity explicitly selected earlier, never infer one from company data.
    const review = continuation.snapshot().review;
    if (review.accountId === accountId && review.personId) void readPerson(review.personId);
  }, [accountId, continuation, readPerson]);

  const load = async (fresh: boolean) => {
    if (!currentView() || !viewToken || queryVersion.current !== queryState.token) return;
    const previous = search.current;
    if (!fresh && (previous?.key !== viewKey || previous.pending || previous.generation !== page?.generation || !page?.cursor)) return;
    const request: LeadsListRequest = fresh
      ? { query, stages: [], priorities: [], sort: 'person_name', cursor: null, limit: 50 }
      : { ...previous!.request, cursor: page!.cursor };
    const generation = Symbol('saved-person-page');
    search.current = { key: viewKey, generation, request, pending: true };
    const rows = fresh ? [] : page!.rows;
    setPage({ key: viewKey, token: viewToken, generation, rows, cursor: fresh ? null : page!.cursor, pending: true, failed: false });
    const current = () => currentView() && search.current?.generation === generation;
    try {
      if (!current()) return;
      const result = await api.leads.list(request);
      if (!current()) return;
      search.current!.pending = false;
      const seen = new Set(rows.map(row => row.personId));
      setPage({ key: viewKey, token: viewToken, generation, rows: [...rows, ...result.rows.filter(row => !seen.has(row.personId))], cursor: result.nextCursor, pending: false, failed: false });
    } catch {
      if (!current()) return;
      search.current!.pending = false;
      // Any public page failure can be a stale cursor. Never silently restart or erase review.
      setPage({ key: viewKey, token: viewToken, generation, rows, cursor: fresh ? null : page!.cursor, pending: false, failed: true });
    }
  };
  const review = state.review;
  const foreignReview = review.accountId !== null && review.accountId !== accountId
    && (review.personId !== null || !!review.role || !!review.relationship || review.sourceQuotes.length > 0);
  const unresolved = state.link !== null && state.link.outcome !== 'known';
  const editable = !foreignReview && !unresolved;
  const retained = state.link?.request.accountId === accountId ? state.link : null;
  const ownReview = review.accountId === accountId;
  const sourceId = ownReview && review.sourceQuotes[0] ? review.sourceQuotes[0].sourceId
    : detail.sources.length === 1 ? detail.sources[0].id : '';
  const source = detail.sources.find(item => item.id === sourceId);
  const quotation = ownReview ? review.sourceQuotes[0]?.quote ?? '' : '';
  const visiblePerson = person?.key === viewKey && person.token === viewToken ? person : null;
  const selectedPerson = ownReview && visiblePerson?.value?.personId === review.personId ? visiblePerson.value : null;
  const visiblePage = page?.key === viewKey && page.token === viewToken ? page : null;
  const confirmed = confirmation?.key === viewKey && confirmation.review === review;
  const update = (patch: Partial<FirstUseReview>) => {
    if (!currentView() || !editable) return false;
    const previous = continuation.snapshot().review;
    const next: FirstUseReview = { accountId, personId: null, role: '', relationship: '', sourceQuotes: [],
      ...(previous.accountId === accountId ? previous : {}), ...patch };
    const accepted = continuation.updateReview(epoch, next);
    if (accepted) setConfirmation(null);
    return accepted;
  };
  const choose = (personId: string, generation: symbol) => {
    if (search.current?.generation !== generation || queryVersion.current !== queryState.token || !currentView() || !editable || !update({ personId })) return;
    void readPerson(personId);
  };
  const canLink = editable && ownReview && !!selectedPerson && !selectedPerson.optedOut
    && confirmed && !!review.role.trim() && review.role.trim().length <= 2000
    && !!review.relationship.trim() && review.relationship.trim().length <= 200
    && !!source?.permitted && !!quotation.trim() && quotation.length <= 12000 && source.excerpt.includes(quotation)
    && state.research?.outcome !== 'pending';
  const execute = async (input: LinkCompanyPersonRequest) => {
    if (!currentView()) return;
    const token = continuation.beginLink(epoch, input);
    if (!token) return;
    // The owner deep-copies new inputs. Dispatch and replay its exact retained object.
    const request = continuation.snapshot().link!.request;
    if (!currentView()) { continuation.settleLink(token, { outcome: 'unknown' }); return; }
    try {
      const receipt = await api.localWorkspace.linkCompanyPerson(request);
      // Owner settlement intentionally survives route departure. Its token fences owner replacement.
      continuation.settleLink(token, { outcome: 'known', receipt });
    } catch { continuation.settleLink(token, { outcome: 'unknown' }); }
  };
  const link = () => {
    if (!currentView() || !canLink || !review.personId || !source) return;
    void execute({ commandId: crypto.randomUUID(), accountId, expectedVersion: detail.snapshot.account.version,
      link: { id: crypto.randomUUID(), kind: 'person_role', personId: review.personId,
        role: review.role.trim(), relationship: review.relationship.trim(), evidenceIds: [source.id],
        validFrom: new Date().toISOString(), validTo: null, authority: 'unconfirmed', authorityEvidenceIds: [] },
      sourceQuotes: [{ sourceId: source.id, quote: quotation }] });
  };
  const savedLinks = detail.links.filter(item => item.kind === 'person_role');
  return <section aria-label="Saved company contact">
    <h3>Saved contact relationship</h3>
    {!savedLinks.length && <p>Contact not established</p>}
    {savedLinks.map(saved => <div key={saved.id}>
      <p>{saved.personId} · {saved.role} · {saved.relationship}</p>
      <p>Authority: {saved.authority}</p>
    </div>)}
    {foreignReview && <div>
      <p>A review is retained for another account. Return or explicitly discard it before editing this account.</p>
      <button type="button" onClick={() => { if (currentView()) continuation.selectAccount(epoch, review.accountId); }}>Return to reviewed account</button>
      <button type="button" disabled={unresolved} onClick={() => { if (currentView()) continuation.discardReview(epoch); }}>Discard review</button>
    </div>}
    <button type="button" disabled={!editable} onClick={() => { void load(true); }}>Find saved person</button>
    {visiblePage && <div>
      <label>Saved person search<input value={query} maxLength={200} onChange={event => {
        if (!currentView() || !editable) return;
        search.current = null;
        queryVersion.current = Symbol('search-input');
        setQueryState({ value: event.target.value, token: queryVersion.current });
        setPage(previous => previous ? { ...previous, pending: false, cursor: null } : previous);
      }} /></label>
      <button type="button" disabled={!editable} onClick={() => { void load(true); }}>Search saved people</button>
      {visiblePage.rows.map(row => <button type="button" key={row.personId} disabled={!editable || search.current?.generation !== visiblePage.generation}
        onClick={() => choose(row.personId, visiblePage.generation)}>Select {row.personName} · {row.personId}</button>)}
      {visiblePage.pending && <p role="status">Loading saved people…</p>}
      {visiblePage.failed ? <><p role="status">Saved people search unavailable. Review retained.</p>
        <button type="button" disabled={!editable} onClick={() => { void load(true); }}>Start fresh search</button></>
        : visiblePage.cursor && <button type="button" disabled={visiblePage.pending || !editable} onClick={() => { void load(false); }}>Load more</button>}
    </div>}
    {visiblePerson?.failed && <p role="status">Saved person unavailable. Choose a saved person again.</p>}
    {selectedPerson && <div>
      <p>{selectedPerson.personName} · {selectedPerson.personId}</p>
      {[...selectedPerson.phones, ...selectedPerson.emails].map(method => <div key={method.id}>
        <p>{method.value}</p><p>{method.label ?? 'No saved label'}</p><p>{method.sourceLabel ?? 'Source not recorded'}</p>
        <p>Ownership: {method.ownershipState}</p><p>Validation: {method.validationState}</p><p>Reachability: {method.reachability}</p>
      </div>)}
    </div>}
    {!foreignReview && <fieldset disabled={!editable}>
      <legend>Review the saved person and relationship evidence</legend>
      <label>Role<input value={ownReview ? review.role : ''} maxLength={2000} onChange={event => update({ role: event.target.value })} /></label>
      <label>Relationship<input value={ownReview ? review.relationship : ''} maxLength={200} onChange={event => update({ relationship: event.target.value })} /></label>
      <label>Relationship source<select value={sourceId} onChange={event => update({ sourceQuotes: event.target.value ? [{ sourceId: event.target.value, quote: '' }] : [] })}>
        <option value="">Choose a source</option>{detail.sources.map(item => <option key={item.id} value={item.id}>{item.url} · {item.id}</option>)}
      </select></label>
      {source && ownReview && review.personId && <><p>{source.url}</p><pre>Source excerpt: {source.excerpt}</pre></>}
      <label>Source quotation<input value={quotation} maxLength={12000} onChange={event => update({ sourceQuotes: sourceId ? [{ sourceId, quote: event.target.value }] : [] })} /></label>
      <label><input type="checkbox" checked={confirmed} onChange={event => {
        if (currentView() && editable) setConfirmation(event.target.checked ? { key: viewKey, review } : null);
      }} />I confirm this saved person and quoted relationship</label>
      <p>A matching quotation records your review, not verified identity, contact ownership, or decision-making authority.</p>
      <button type="button" disabled={!canLink} onClick={link}>Link saved person</button>
    </fieldset>}
    {retained && <><p role="status">Link {retained.outcome}</p>
      {retained.outcome !== 'known' && <button type="button" disabled={retained.outcome === 'pending'} onClick={() => {
        if (currentView()) void execute(retained.request);
      }}>Replay link</button>}
    </>}
  </section>;
}
