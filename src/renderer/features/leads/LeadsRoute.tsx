import { useEffect, useRef, useState } from 'react';

import type {
  LeadFieldUpdateRequest,
  LeadsListRequest,
  LeadsListResponse,
} from '../../../shared/contracts/leadsContract';
import type { LeadsApi } from '../../../preload/apis/leadsApi';
import { useLeadInspectorIfAvailable } from '../leadInspector/useLeadInspector';
import { LeadsPage, type LeadsQueryView } from './LeadsPage';
import { useLeadGridState } from './useLeadGridState';

type LeadsQueryState =
  | { status: 'loading' }
  | { status: 'ready'; response: LeadsListResponse }
  | { status: 'failed' };

type LeadsQuery = {
  state: LeadsQueryState;
  refresh(): void;
};

/**
 * Owns async list loading. A per-hook generation counter ignores stale
 * responses, which also keeps React StrictMode double-effects harmless.
 */
function useLeadsQuery(api: LeadsApi, request: LeadsListRequest): LeadsQuery {
  const generation = useRef(0);
  const [state, setState] = useState<LeadsQueryState>({ status: 'loading' });
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    generation.current += 1;
    const requestGeneration = generation.current;
    let cancelled = false;
    setState((current) =>
      current.status === 'ready' ? current : { status: 'loading' },
    );
    api.list(request).then(
      (response) => {
        if (!cancelled && requestGeneration === generation.current) {
          setState({ status: 'ready', response });
        }
      },
      () => {
        if (!cancelled && requestGeneration === generation.current) {
          setState({ status: 'failed' });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, request, refreshToken]);

  return {
    state,
    refresh: () => setRefreshToken((token) => token + 1),
  };
}

export type LeadsRouteProps = {
  api: LeadsApi;
  onOpenLead(personId: string): void;
  onOpenImport(): void;
};

/** Async container for the person-first Leads workspace. */
export function LeadsRoute({ api, onOpenLead, onOpenImport }: LeadsRouteProps) {
  const state = useLeadGridState();
  const query = useLeadsQuery(api, state.queryRequest);
  const inspector = useLeadInspectorIfAvailable();

  // The review flow's auto-advance: after Mark ready / Dismiss the inspector
  // asks this route for the next person in the current list order. Refs keep
  // the registered resolver reading live rows without re-registering per row.
  const rowsRef = useRef<LeadsListResponse['rows']>([]);
  rowsRef.current =
    query.state.status === 'ready' ? query.state.response.rows : rowsRef.current;
  const refreshRef = useRef(query.refresh);
  refreshRef.current = query.refresh;
  const selectRef = useRef(state.setSelectedPersonId);
  selectRef.current = state.setSelectedPersonId;

  const setReviewAdvance = inspector?.setReviewAdvance;
  useEffect(() => {
    if (setReviewAdvance === undefined) {
      return undefined;
    }
    setReviewAdvance((personId) => {
      const rows = rowsRef.current;
      const index = rows.findIndex((row) => row.personId === personId);
      const next = index === -1 ? null : rows[index + 1] ?? null;
      // The reviewed lead changed stage (or left the list): refetch so the
      // grid reflects the decision immediately.
      refreshRef.current();
      if (next === null) {
        return null;
      }
      selectRef.current(next.personId);
      return next.personId;
    });
    return () => setReviewAdvance(null);
  }, [setReviewAdvance]);

  const view: LeadsQueryView =
    query.state.status === 'ready'
      ? {
        status: 'ready',
        rows: query.state.response.rows,
        total: query.state.response.total,
      }
      : { status: query.state.status };

  const updateField = (input: LeadFieldUpdateRequest) => {
    api.updateField(input).then(
      () => query.refresh(),
      () => query.refresh(),
    );
  };

  const bulkSetOrganization = (value: string | null) => {
    if (query.state.status !== 'ready') {
      return;
    }
    const personIds = query.state.response.rows
      .filter((row) => state.checkedPersonIds.has(row.personId))
      .map((row) => row.personId);
    if (personIds.length === 0) {
      return;
    }
    api
      .bulkUpdate({ personIds, field: 'organization_label', value })
      .then(
        () => {
          state.clearChecked();
          query.refresh();
        },
        () => query.refresh(),
      );
  };

  return (
    <LeadsPage
      view={view}
      state={state}
      onRetry={query.refresh}
      onOpenLead={onOpenLead}
      onOpenImport={onOpenImport}
      onUpdateField={updateField}
      onBulkSetOrganization={bulkSetOrganization}
    />
  );
}
