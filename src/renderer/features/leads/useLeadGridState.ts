import { useMemo, useState } from 'react';

import type {
  LifecycleStage,
  Priority,
} from '../../../shared/contracts/commonContract';
import type { LeadsListRequest } from '../../../shared/contracts/leadsContract';

export type LeadsSort = LeadsListRequest['sort'];

const PAGE_SIZE = 200;

export type LeadGridState = {
  /** The strict list request derived from the current grid controls. */
  queryRequest: LeadsListRequest;
  query: string;
  setQuery(value: string): void;
  stages: LifecycleStage[];
  setStages(value: LifecycleStage[]): void;
  priorities: Priority[];
  setPriorities(value: Priority[]): void;
  sort: LeadsSort;
  setSort(value: LeadsSort): void;
  selectedPersonId: string | null;
  setSelectedPersonId(value: string | null): void;
  checkedPersonIds: ReadonlySet<string>;
  toggleChecked(personId: string): void;
  clearChecked(): void;
};

/**
 * Pure client-side grid state: search, filters, sort, single selection, and
 * the bulk-check set. Async loading stays in LeadsRoute.
 */
export function useLeadGridState(): LeadGridState {
  const [query, setQuery] = useState('');
  const [stages, setStages] = useState<LifecycleStage[]>([]);
  const [priorities, setPriorities] = useState<Priority[]>([]);
  const [sort, setSort] = useState<LeadsSort>('priority');
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [checkedPersonIds, setCheckedPersonIds] = useState<ReadonlySet<string>>(
    new Set(),
  );

  const queryRequest = useMemo<LeadsListRequest>(
    () => ({
      query,
      stages,
      priorities,
      sort,
      cursor: null,
      limit: PAGE_SIZE,
    }),
    [query, stages, priorities, sort],
  );

  return {
    queryRequest,
    query,
    setQuery,
    stages,
    setStages,
    priorities,
    setPriorities,
    sort,
    setSort,
    selectedPersonId,
    setSelectedPersonId,
    checkedPersonIds,
    toggleChecked: (personId) =>
      setCheckedPersonIds((current) => {
        const next = new Set(current);
        if (next.has(personId)) {
          next.delete(personId);
        } else {
          next.add(personId);
        }
        return next;
      }),
    clearChecked: () => setCheckedPersonIds(new Set()),
  };
}
