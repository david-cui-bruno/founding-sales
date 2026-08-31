import { useState } from 'react';

import { Button } from '../../components/Button';
import type { LeadsSort } from './useLeadGridState';

export type LeadsToolbarProps = {
  query: string;
  onQueryChange(value: string): void;
  sort: LeadsSort;
  onSortChange(value: LeadsSort): void;
  checkedCount: number;
  onBulkSetOrganization(value: string | null): void;
  onClearChecked(): void;
  onOpenImport(): void;
};

const SORT_LABELS: Readonly<Record<LeadsSort, string>> = Object.freeze({
  priority: 'Priority',
  due_at: 'Due',
  person_name: 'Name',
  last_contact: 'Last contact',
});

/**
 * Search, sort, import, and the bulk action bar. Bulk edits stay limited to
 * the same allowed fields as inline edits.
 */
export function LeadsToolbar({
  query,
  onQueryChange,
  sort,
  onSortChange,
  checkedCount,
  onBulkSetOrganization,
  onClearChecked,
  onOpenImport,
}: LeadsToolbarProps) {
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [bulkValue, setBulkValue] = useState('');

  return (
    <div className="leads-toolbar" role="toolbar" aria-label="Lead actions">
      <input
        className="leads-toolbar__search"
        type="search"
        role="searchbox"
        aria-label="Search leads"
        placeholder="Search people"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
      />
      <label className="leads-toolbar__sort">
        Sort
        <select
          aria-label="Sort leads"
          value={sort}
          onChange={(event) => onSortChange(event.target.value as LeadsSort)}
        >
          {(Object.keys(SORT_LABELS) as LeadsSort[]).map((value) => (
            <option key={value} value={value}>
              {SORT_LABELS[value]}
            </option>
          ))}
        </select>
      </label>
      <Button variant="quiet" onClick={onOpenImport}>
        Import
      </Button>
      {checkedCount > 0 && (
        <div className="leads-toolbar__bulk">
          <span className="leads-toolbar__bulk-count">
            {checkedCount} selected
          </span>
          {bulkEditOpen ? (
            <input
              className="leads-toolbar__bulk-input"
              type="text"
              aria-label={`Organization for ${checkedCount} selected`}
              value={bulkValue}
              autoFocus
              onChange={(event) => setBulkValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  const trimmed = bulkValue.trim();
                  onBulkSetOrganization(trimmed === '' ? null : trimmed);
                  setBulkEditOpen(false);
                  setBulkValue('');
                } else if (event.key === 'Escape') {
                  setBulkEditOpen(false);
                  setBulkValue('');
                }
              }}
            />
          ) : (
            <Button variant="quiet" onClick={() => setBulkEditOpen(true)}>
              Set organization
            </Button>
          )}
          <Button variant="quiet" onClick={onClearChecked}>
            Clear selection
          </Button>
        </div>
      )}
    </div>
  );
}
