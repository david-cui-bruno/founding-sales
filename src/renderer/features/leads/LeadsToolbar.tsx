import { Select } from '../../components/Select';
import type { LeadsSort } from './useLeadGridState';

export type LeadsToolbarProps = {
  query: string;
  onQueryChange(value: string): void;
  sort: LeadsSort;
  onSortChange(value: LeadsSort): void;
};

const SORT_OPTIONS: readonly { value: LeadsSort; label: string }[] = [
  { value: 'priority', label: 'Priority' },
  { value: 'person_name', label: 'Name' },
  { value: 'last_contact', label: 'Last contact' },
];

/**
 * Search plus the composite sort Select, rendered inside the Leads page
 * header. Single-column sorts are also reachable from the grid headers; this
 * Select stays for the composite Priority default. Bulk actions live in the
 * floating LeadsBulkBar.
 */
export function LeadsToolbar({
  query,
  onQueryChange,
  sort,
  onSortChange,
}: LeadsToolbarProps) {
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
    </div>
  );
}
