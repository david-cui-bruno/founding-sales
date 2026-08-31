import { useEffect, useRef, useState } from 'react';

import type {
  LeadFieldUpdateRequest,
  LeadsListRequest,
  LeadsListResponse,
} from '../../../shared/contracts/leadsContract';
import type { LeadsApi } from '../../../preload/apis/leadsApi';
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
