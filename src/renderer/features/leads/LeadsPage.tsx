import type { RefObject } from 'react';
import { InlineEditPanel } from './leadColumns';
import type { LeadSaveResult, useLeadMutations } from './useLeadMutations';
import type { LifecycleStage } from '../../../shared/contracts/commonContract';
import type { LeadFieldUpdateRequest, LeadRow } from '../../../shared/contracts/leadsContract';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { PageHeader } from '../../components/PageHeader';
import { ProgressBarThin } from '../../components/ProgressBarThin';
import { LeadsBulkBar } from './LeadsBulkBar';
import { LeadsFilterChips, type LeadStageCounts } from './LeadsFilterChips';
import { LeadsGrid } from './LeadsGrid';
import { LeadsToolbar } from './LeadsToolbar';
import type { LeadGridState } from './useLeadGridState';
import './leads.css';

export type LeadsQueryView =
  | { status: 'loading' }
  | { status: 'ready'; rows: LeadRow[]; total: number; nextCursor: string | null; append: 'idle' | 'loading' | 'failed'; requiresReload: boolean }
  | { status: 'failed' };

export type LeadsPageProps = {
  view: LeadsQueryView;
  state: LeadGridState;
  onRetry(): void;
  onLoadMore(): void;
  mutations: ReturnType<typeof useLeadMutations>;
  boundaryNotice?: string | null;
  refreshButtonRef?: RefObject<HTMLButtonElement | null>;
  onOpenLead(personId: string): void;
  onOpenImport(): void;
  onUpdateField(input: LeadFieldUpdateRequest): Promise<LeadSaveResult>;
  onBulkSetOrganization(value: string | null): Promise<LeadSaveResult>;
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
  onLoadMore, mutations, boundaryNotice, refreshButtonRef,
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
        primaryAction={<Button id="leads-import-trigger" onClick={onOpenImport}>Import</Button>}
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
      <section aria-label="List status">
        {boundaryNotice && <p role="status">{boundaryNotice}</p>}
        {mutations.notice && <p role="status">{mutations.notice}</p>}
        {view.status === 'ready' && <>
          <p>{view.requiresReload ? `Last loaded: ${view.rows.length} of ${view.total}` : `Showing ${view.rows.length} of ${view.total}`}</p>
          {view.requiresReload && <p>List changed after a review decision. Loaded rows are from the previous read. Refresh list to update.</p>}
          {view.append === 'failed' && <p role="alert">More leads could not be loaded. Your loaded rows are kept.</p>}
          {!view.requiresReload && view.nextCursor && <Button disabled={view.append === 'loading'} onClick={onLoadMore}>{view.append === 'failed' ? 'Retry more' : 'Load more'}</Button>}
        </>}
        <button className="button button--quiet" id="leads-refresh-list" type="button" ref={refreshButtonRef} disabled={view.status === 'loading'} onClick={onRetry}>Refresh list</button>
      </section>
      {view.status === 'loading' && <ProgressBarThin label="Loading leads" />}
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
          editor={mutations.editor}
          onUpdateField={onUpdateField}
          onOpenLead={onOpenLead}
          checkedPersonIds={state.checkedPersonIds}
          onToggleChecked={state.toggleChecked}
          sort={state.sort}
          onSortChange={state.setSort}
        />
      )}
      {(view.status !== 'ready' || view.rows.length === 0) && mutations.editor.session &&
        <InlineEditPanel recovery editor={mutations.editor} onUpdateField={onUpdateField} />}
      {(state.checkedPersonIds.size > 0 || mutations.bulk !== null) && (
        <LeadsBulkBar
          count={state.checkedPersonIds.size}
          outsideCount={[...state.checkedPersonIds].filter(id => view.status !== 'ready' || !view.rows.some(row => row.personId === id)).length}
          editor={mutations.bulk} pending={mutations.pending}
          onStart={mutations.startBulk} onChange={mutations.changeBulk} onCancel={mutations.cancelBulk}
          onSetOrganization={onBulkSetOrganization}
          onClear={state.clearChecked}
        />
      )}
    </section>
  );
}
