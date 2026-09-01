import { useState } from 'react';

import type { PipelineSnapshot } from '../../../shared/contracts/pipelineContract';
import { PageHeader } from '../../components/PageHeader';
import { SegmentedControl } from '../../components/SegmentedControl';
import { PipelineBoard } from './PipelineBoard';
import { PipelineTable } from './PipelineTable';

import './pipeline.css';

export type PipelineView = 'board' | 'table';

export type PipelinePageProps = {
  snapshot: PipelineSnapshot;
  onOpenLead(personId: string): void;
};

const VIEW_OPTIONS: ReadonlyArray<{ value: PipelineView; label: string }> = [
  { value: 'board', label: 'Board' },
  { value: 'table', label: 'Table' },
];

/**
 * Board and table render the exact same snapshot DTO; the shared
 * SegmentedControl in the page header switches between them. The page
 * exposes no stage commands.
 */
export function PipelinePage({ snapshot, onOpenLead }: PipelinePageProps) {
  const [view, setView] = useState<PipelineView>('board');

  return (
    <div className="pipeline">
      <PageHeader
        title="Pipeline"
        trailing={
          <SegmentedControl<PipelineView>
            label="Pipeline view"
            options={VIEW_OPTIONS}
            value={view}
            onChange={setView}
          />
        }
      />
      {view === 'board' ? (
        <PipelineBoard snapshot={snapshot} onOpenLead={onOpenLead} />
      ) : (
        <PipelineTable snapshot={snapshot} onOpenLead={onOpenLead} />
      )}
    </div>
  );
}
