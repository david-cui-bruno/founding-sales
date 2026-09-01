import type { LifecycleStage } from '../../../shared/contracts/commonContract';
import type { LeadFieldUpdateRequest, LeadRow } from '../../../shared/contracts/leadsContract';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { PageHeader } from '../../components/PageHeader';
import { LeadsBulkBar } from './LeadsBulkBar';
import { LeadsFilterChips, type LeadStageCounts } from './LeadsFilterChips';
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

const formatCount = (total: number): string =>
  `${total} ${total === 1 ? 'person' : 'people'}`;

/**
 * Chip counts are only truthful when the whole unfiltered result set is on
 * this page: no stage filter hides rows and no next page exists. Otherwise
 * the chips stay label-only rather than showing a partial count.
 */
function stageCounts(
  view: LeadsQueryView,
  state: LeadGridState,
): LeadStageCounts | null {
  if (
    view.status !== 'ready' ||
    state.stages.length > 0 ||
    view.rows.length < view.total
  ) {
    return null;
  }
  const counts: LeadStageCounts = { all: view.total };
  for (const row of view.rows) {
    counts[row.stage] = (counts[row.stage] ?? 0) + 1;
  }
  return counts;
}

/** Presentational Leads workspace: page header plus grid plus async states. */
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
      <PageHeader
        title="Leads"
        count={view.status === 'ready' ? formatCount(view.total) : undefined}
        primaryAction={<Button onClick={onOpenImport}>Import</Button>}
      >
        <LeadsToolbar
          query={state.query}
          onQueryChange={state.setQuery}
          sort={state.sort}
          onSortChange={state.setSort}
        />
      </PageHeader>
      <LeadsFilterChips
        stages={state.stages}
        counts={stageCounts(view, state)}
        onStagesChange={(stages: LifecycleStage[]) => state.setStages(stages)}
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
          sort={state.sort}
          onSortChange={state.setSort}
        />
      )}
      {state.checkedPersonIds.size > 0 && (
        <LeadsBulkBar
          count={state.checkedPersonIds.size}
          onSetOrganization={onBulkSetOrganization}
          onClear={state.clearChecked}
        />
      )}
    </section>
  );
}
