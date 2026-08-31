import { useState } from 'react';

import type { PipelineSnapshot } from '../../../shared/contracts/pipelineContract';
import { PipelineBoard } from './PipelineBoard';
import { PipelineTable } from './PipelineTable';

import './pipeline.css';

export type PipelineView = 'board' | 'table';

export type PipelinePageProps = {
  snapshot: PipelineSnapshot;
  onOpenLead(personId: string): void;
};

const VIEWS: ReadonlyArray<{ id: PipelineView; label: string }> = [
  { id: 'board', label: 'Board' },
  { id: 'table', label: 'Table' },
];

/**
 * Board and table render the exact same snapshot DTO; a local segmented
 * control switches between them. The page exposes no stage commands.
 */
export function PipelinePage({ snapshot, onOpenLead }: PipelinePageProps) {
  const [view, setView] = useState<PipelineView>('board');

  return (
    <div className="pipeline">
      <div className="pipeline__toolbar">
        <div
          className="pipeline__view-toggle"
          role="group"
          aria-label="Pipeline view"
        >
          {VIEWS.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              className="pipeline__view-button"
              aria-pressed={view === candidate.id}
              onClick={() => setView(candidate.id)}
            >
              {candidate.label}
            </button>
          ))}
        </div>
      </div>
      {view === 'board' ? (
        <PipelineBoard snapshot={snapshot} onOpenLead={onOpenLead} />
      ) : (
        <PipelineTable snapshot={snapshot} onOpenLead={onOpenLead} />
      )}
    </div>
  );
}
