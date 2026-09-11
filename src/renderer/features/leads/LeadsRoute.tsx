import { useEffect, useRef, useState } from 'react';
import type { LeadsListRequest, LeadsListResponse } from '../../../shared/contracts/leadsContract';
import type { LeadsApi } from '../../../preload/apis/leadsApi';
import { useLeadInspectorIfAvailable } from '../leadInspector/useLeadInspector';
import { LeadsPage, type LeadsQueryView } from './LeadsPage';
import { useLeadGridState } from './useLeadGridState';
import { useLeadMutations } from './useLeadMutations';

const controlsKey = (request: LeadsListRequest) => JSON.stringify({
  ...request, stages: [...new Set(request.stages)].sort(), priorities: [...new Set(request.priorities)].sort(),
});
type QueryState = { owner: object; view: LeadsQueryView };
/** A cursor is opaque and belongs only to the current controls/API read generation. */
function useLeadsQuery(api: LeadsApi, request: LeadsListRequest) {
  const key = controlsKey(request);
  const ownerRef = useRef({ api, key });
  const sequence = useRef(0);
  const appending = useRef(false);
  const dirty = useRef(false);
  if (ownerRef.current.api !== api || ownerRef.current.key !== key) {
    ownerRef.current = { api, key }; sequence.current++; appending.current = false; dirty.current = false;
  }
  const owner = ownerRef.current;
  const mounted = useRef(true);
  const [state, setState] = useState<QueryState>({ owner, view: { status: 'loading' } });
  const view: LeadsQueryView = state.owner === owner ? state.view : { status: 'loading' };
  const viewRef = useRef(view); viewRef.current = view;
  const refresh = async (): Promise<boolean | null> => {
    const id = ++sequence.current;
    appending.current = false; dirty.current = false;
    viewRef.current = { status: 'loading' };
    setState({ owner, view: { status: 'loading' } });
    try {
      const response = await api.list({ ...request, cursor: null });
      if (!mounted.current || ownerRef.current !== owner || sequence.current !== id) return null;
      setState({ owner, view: ready(response) }); return true;
    } catch {
      if (!mounted.current || ownerRef.current !== owner || sequence.current !== id) return null;
      setState({ owner, view: { status: 'failed' } });
      return false;
    }
  };
  useEffect(() => {
    mounted.current = true; void refresh();
    return () => { mounted.current = false; sequence.current++; };
    // The request is completely represented by the stable canonical key.
  }, [api, key]);
  const more = async () => {
    const current = viewRef.current;
    if (current.status !== 'ready' || !current.nextCursor || appending.current || dirty.current) return;
    const id = ++sequence.current; appending.current = true;
    setState({ owner, view: { ...current, append: 'loading' } });
    try {
      const response = await api.list({ ...request, cursor: current.nextCursor });
      if (!mounted.current || ownerRef.current !== owner || sequence.current !== id || dirty.current) return;
      const ids = new Set(current.rows.map(row => row.personId));
      const rows = [...current.rows];
      for (const row of response.rows) if (!ids.has(row.personId)) { ids.add(row.personId); rows.push(row); }
      setState({ owner, view: { ...ready(response), rows } as LeadsQueryView });
    } catch {
      if (mounted.current && ownerRef.current === owner && sequence.current === id && !dirty.current) setState({ owner, view: { ...current, append: 'failed' } });
    } finally { if (sequence.current === id) appending.current = false; }
  };
  return { view, refresh, more, invalidate: () => { sequence.current++; appending.current = false; },
    markChanged: () => {
      sequence.current++; appending.current = false; dirty.current = true;
      setState(current => current.owner === owner && current.view.status === 'ready' ? { owner, view: { ...current.view, append: 'idle', requiresReload: true } } : current);
    },
  };
}
function ready(response: LeadsListResponse): Extract<LeadsQueryView, { status: 'ready' }> {
  return { status: 'ready', rows: response.rows, total: response.total, nextCursor: response.nextCursor, append: 'idle', requiresReload: false };
}
export type LeadsRouteProps = { api: LeadsApi; onOpenLead(personId: string): void; onOpenImport(): void };

type ReviewWindow = { api: LeadsApi; key: string; epoch: number };
type Boundary = { owner: ReviewWindow; message: string };
export function LeadsRoute({ api, onOpenLead, onOpenImport }: LeadsRouteProps) {
  const state = useLeadGridState();
  const query = useLeadsQuery(api, state.queryRequest);
  const key = controlsKey(state.queryRequest);
  const [browseEpoch, setBrowseEpoch] = useState(0);
  const windowRef = useRef<ReviewWindow>({ api, key, epoch: browseEpoch });
  const disposeRef = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  if (windowRef.current.api !== api || windowRef.current.key !== key) {
    disposeRef.current?.();
    windowRef.current = { api, key, epoch: browseEpoch };
  }
  const [boundary, setBoundary] = useState<Boundary | null>(null);
  const boundaryRef = useRef(boundary); boundaryRef.current = boundary;
  const refreshButtonRef = useRef<HTMLButtonElement>(null);
  const queryRef = useRef(query); queryRef.current = query;
  const stateRef = useRef(state); stateRef.current = state;
  const retireWindow = (carryNotice: boolean, invalidateRead = false) => {
    disposeRef.current?.();
    if (invalidateRead) queryRef.current.invalidate();
    const previous = windowRef.current;
    const next = { api, key, epoch: previous.epoch + 1 };
    windowRef.current = next;
    setBrowseEpoch(next.epoch);
    const notice = carryNotice && boundaryRef.current?.owner === previous ? { ...boundaryRef.current, owner: next } : null;
    boundaryRef.current = notice; setBoundary(notice);
    return next;
  };
  const refresh = async () => {
    const owner = retireWindow(true, true);
    const success = await queryRef.current.refresh();
    if (mounted.current && windowRef.current === owner && success) { boundaryRef.current = null; setBoundary(null); }
    return success;
  };
  const mutations = useLeadMutations(api, state.checkedPersonIds, state.removeChecked, refresh);
  const inspector = useLeadInspectorIfAvailable();
  const setReviewAdvance = inspector?.setReviewAdvance;
  useEffect(() => {
    mounted.current = true;
    if (!setReviewAdvance) return () => { mounted.current = false; };
    const owner = windowRef.current;
    const dispose = setReviewAdvance(personId => {
      const current = queryRef.current.view;
      if (!mounted.current || windowRef.current !== owner) return { kind: 'return_to_list', returnFocus: () => null };
      const rows = current.status === 'ready' ? current.rows : [];
      const index = rows.findIndex(row => row.personId === personId);
      queryRef.current.markChanged();
      const next = index < 0 ? undefined : rows.slice(index + 1).find(row => row.personId !== personId);
      if (next) {
        stateRef.current.setSelectedPersonId(next.personId);
        return { kind: 'next', personId: next.personId };
      }
      if (stateRef.current.selectedPersonId === personId) stateRef.current.setSelectedPersonId(null);
      const notice = { owner, message: index < 0
        ? 'Decision saved. The loaded order changed. Refresh the list to continue.'
        : 'Decision saved. No next person is loaded in this order. Refresh the list to continue.' };
      boundaryRef.current = notice; setBoundary(notice);
      return { kind: 'return_to_list', returnFocus: () => mounted.current && windowRef.current === owner && boundaryRef.current?.owner === owner ? refreshButtonRef.current : null };
    });
    disposeRef.current = dispose;
    return () => { mounted.current = false; dispose(); };
  }, [setReviewAdvance, api, key, browseEpoch]);
  const changesControls = (patch: Partial<LeadsListRequest>) =>
    controlsKey({ ...state.queryRequest, ...patch }) !== key;
  const guardedState = { ...state,
    setQuery: (value: string) => { if (changesControls({ query: value })) { retireWindow(false, true); state.setQuery(value); } },
    setSort: (value: typeof state.sort) => { if (changesControls({ sort: value })) { retireWindow(false, true); state.setSort(value); } },
    setStages: (value: typeof state.stages) => { if (changesControls({ stages: value })) { retireWindow(false, true); state.setStages(value); } },
    setPriorities: (value: typeof state.priorities) => { if (changesControls({ priorities: value })) { retireWindow(false, true); state.setPriorities(value); } },
    setSelectedPersonId: (id: string | null) => { if (mutations.canChangeSelection()) { retireWindow(false); state.setSelectedPersonId(id); } },
    toggleChecked: (id: string) => { if (mutations.canChangeSelection()) state.toggleChecked(id); },
    clearChecked: () => { if (mutations.canChangeSelection()) { state.clearChecked(); mutations.cancelBulk(); } },
  };
  return <LeadsPage view={query.view} state={guardedState} onRetry={() => { void refresh(); }} onLoadMore={() => { void query.more(); }}
    boundaryNotice={boundary?.owner === windowRef.current ? boundary.message : null} refreshButtonRef={refreshButtonRef}
    onOpenLead={id => { if (mutations.canChangeSelection()) { retireWindow(false); onOpenLead(id); } }} onOpenImport={onOpenImport}
    onUpdateField={mutations.updateField} onBulkSetOrganization={mutations.bulkSetOrganization} mutations={mutations} />;
}
