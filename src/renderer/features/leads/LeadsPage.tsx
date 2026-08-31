import type { LeadFieldUpdateRequest, LeadRow } from '../../../shared/contracts/leadsContract';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { LeadsGrid } from './LeadsGrid';
import { LeadsToolbar } from './LeadsToolbar';
import type { LeadGridState } from './useLeadGridState';
import './leads.css';

export type LeadsQueryView =
  | { status: 'loading' }
  | { status: 'ready'; rows: LeadRow[]; total: number }
  | { status: 'failed' };

export type LeadsPageProps = {
  view: LeadsQueryView;
  state: LeadGridState;
  onRetry(): void;
  onOpenLead(personId: string): void;
  onOpenImport(): void;
  onUpdateField(input: LeadFieldUpdateRequest): void;
  onBulkSetOrganization(value: string | null): void;
};

/** Presentational Leads workspace: toolbar plus grid plus async states. */
export function LeadsPage({
  view,
  state,
  onRetry,
  onOpenLead,
  onOpenImport,
  onUpdateField,
  onBulkSetOrganization,
}: LeadsPageProps) {
  const filtered =
    state.query.length > 0 ||
    state.stages.length > 0 ||
    state.priorities.length > 0;

  return (
    <section className="leads-page" aria-label="Leads">
      <LeadsToolbar
        query={state.query}
        onQueryChange={state.setQuery}
        sort={state.sort}
        onSortChange={state.setSort}
        checkedCount={state.checkedPersonIds.size}
        onBulkSetOrganization={onBulkSetOrganization}
        onClearChecked={state.clearChecked}
        onOpenImport={onOpenImport}
      />
      {view.status === 'loading' && <LoadingState label="Loading leads" />}
      {view.status === 'failed' && (
        <ErrorState
          title="Leads could not be loaded"
          description="Try again in a moment."
          onRetry={onRetry}
        />
      )}
      {view.status === 'ready' && view.rows.length === 0 && (
        <EmptyState
          title={filtered ? 'No matching leads' : 'No leads yet'}
          description={
            filtered
              ? 'Adjust the search or filters to see more people.'
              : 'Import a CSV to get started.'
          }
          action={
            filtered ? undefined : (
              <Button onClick={onOpenImport}>Import leads</Button>
            )
          }
        />
      )}
      {view.status === 'ready' && view.rows.length > 0 && (
        <LeadsGrid
          rows={view.rows}
          selectedPersonId={state.selectedPersonId}
          onSelect={state.setSelectedPersonId}
          onUpdateField={onUpdateField}
          onOpenLead={onOpenLead}
          checkedPersonIds={state.checkedPersonIds}
          onToggleChecked={state.toggleChecked}
        />
      )}
    </section>
  );
}
