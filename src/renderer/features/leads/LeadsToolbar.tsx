import { useState } from 'react';

import { Button } from '../../components/Button';
import { Select } from '../../components/Select';
import type { LeadsSort } from './useLeadGridState';

export type LeadsToolbarProps = {
  query: string;
  onQueryChange(value: string): void;
  sort: LeadsSort;
  onSortChange(value: LeadsSort): void;
  checkedCount: number;
  onBulkSetOrganization(value: string | null): void;
  onClearChecked(): void;
};

const SORT_OPTIONS: readonly { value: LeadsSort; label: string }[] = [
  { value: 'priority', label: 'Priority' },
  { value: 'due_at', label: 'Due' },
  { value: 'person_name', label: 'Name' },
  { value: 'last_contact', label: 'Last contact' },
];

/**
 * Search, sort, and the bulk action bar; rendered inside the Leads page
 * header. Bulk edits stay limited to the same allowed fields as inline edits.
 */
export function LeadsToolbar({
  query,
  onQueryChange,
  sort,
  onSortChange,
  checkedCount,
  onBulkSetOrganization,
  onClearChecked,
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
      <div className="leads-toolbar__sort">
        <span aria-hidden="true">Sort</span>
        <Select
          label="Sort leads"
          options={SORT_OPTIONS}
          value={sort}
          onChange={onSortChange}
        />
      </div>
      {checkedCount > 0 && (
        <div className="leads-toolbar__bulk">
          <span className="leads-toolbar__bulk-count numeric">
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
