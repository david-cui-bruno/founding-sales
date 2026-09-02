import { useState } from 'react';

import type {
  AddEvidenceRequest,
  CaptureLearningRequest,
  LearningStatus,
  LearningsListResponse,
  UpdateLearningStatusRequest,
} from '../../../shared/contracts/learningsContract';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { Select } from '../../components/Select';
import { CaptureLearningDialog } from './CaptureLearningDialog';
import { LearningCard } from './LearningCard';

import './learnings.css';

const STATUS_OPTIONS: { value: '' | LearningStatus; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'contradicted', label: 'Contradicted' },
  { value: 'retired', label: 'Retired' },
];

export type LearningsPageProps = {
  response: LearningsListResponse;
  statuses: LearningStatus[];
  query: string;
  onStatusesChange(statuses: LearningStatus[]): void;
  onQueryChange(query: string): void;
  onCapture(request: CaptureLearningRequest): Promise<void>;
  onAddEvidence(request: AddEvidenceRequest): Promise<void>;
  onUpdateStatus(request: UpdateLearningStatusRequest): Promise<void>;
  onOpenLead(personId: string): void;
  now(): string;
};

/**
 * The learnings workspace: founder-curated insights with their evidence.
 * A status filter, search, and a capture dialog; the body is a responsive
 * card grid. Search and the status select are enough at founder data
 * sizes; there is no category chip row.
 */
export function LearningsPage({
  response,
  statuses,
  query,
  onStatusesChange,
  onQueryChange,
  onCapture,
  onAddEvidence,
  onUpdateStatus,
  onOpenLead,
  now,
}: LearningsPageProps) {
  const [capturing, setCapturing] = useState(false);

  return (
    <div className="learnings">
      <PageHeader
        title="Learnings"
        description="What you're learning from calls, with evidence"
        primaryAction={
          <Button onClick={() => setCapturing(true)}>Capture learning</Button>
        }
      />
      <div className="learnings__toolbar">
        <div className="learnings__toolbar-controls">
          <div className="learnings__field">
            <span className="learnings__field-label" aria-hidden="true">
              Status
            </span>
            <Select
              label="Status"
              options={STATUS_OPTIONS}
              value={statuses[0] ?? ''}
              onChange={(value) => {
                onStatusesChange(value === '' ? [] : [value]);
              }}
            />
          </div>
          <label className="learnings__field">
            <span className="learnings__field-label">Search learnings</span>
            <input
              type="search"
              className="learnings__search"
              value={query}
              maxLength={200}
              placeholder="Search statements and quotes"
              onChange={(event) => onQueryChange(event.target.value)}
            />
          </label>
        </div>
      </div>

      {response.rows.length === 0 ? (
        <EmptyState
          title="No learnings yet"
          description="Capture what you learn on calls so patterns surface."
        />
      ) : (
        <div className="learnings__grid">
          {response.rows.map((row) => (
            <LearningCard
              key={row.learningId}
              row={row}
              onAddEvidence={onAddEvidence}
              onUpdateStatus={onUpdateStatus}
              onOpenLead={onOpenLead}
              now={now}
            />
          ))}
        </div>
      )}

      {capturing && (
        <CaptureLearningDialog
          onSubmit={(request) => onCapture(request).then(() => setCapturing(false))}
          onCancel={() => setCapturing(false)}
          now={now}
        />
      )}
    </div>
  );
}
