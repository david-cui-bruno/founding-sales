import { useState } from 'react';

import type {
  AddEvidenceRequest,
  CaptureLearningRequest,
  LearningCategory,
  LearningStatus,
  LearningsListResponse,
  UpdateLearningStatusRequest,
} from '../../../shared/contracts/learningsContract';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { CaptureLearningDialog } from './CaptureLearningDialog';
import { LearningCard } from './LearningCard';
import { CATEGORY_LABELS } from './learningMeta';

import './learnings.css';

const CATEGORY_ORDER: LearningCategory[] = [
  'pain', 'objection', 'alternative', 'winning_language',
  'pricing_reaction', 'product_request', 'coaching',
  'invalidated_assumption',
];

const STATUS_OPTIONS: { value: '' | LearningStatus; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'contradicted', label: 'Contradicted' },
  { value: 'retired', label: 'Retired' },
];

export type LearningsPageProps = {
  response: LearningsListResponse;
  categories: LearningCategory[];
  statuses: LearningStatus[];
  query: string;
  onCategoriesChange(categories: LearningCategory[]): void;
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
 * Multi-select category chips, a status filter, search, and a capture
 * dialog; the body is a responsive card grid.
 */
export function LearningsPage({
  response,
  categories,
  statuses,
  query,
  onCategoriesChange,
  onStatusesChange,
  onQueryChange,
  onCapture,
  onAddEvidence,
  onUpdateStatus,
  onOpenLead,
  now,
}: LearningsPageProps) {
  const [capturing, setCapturing] = useState(false);

  const toggleCategory = (category: LearningCategory) => {
    onCategoriesChange(
      categories.includes(category)
        ? categories.filter((existing) => existing !== category)
        : [...categories, category],
    );
  };

  return (
    <div className="learnings">
      <div className="learnings__toolbar">
        <div
          className="learnings__chips"
          role="group"
          aria-label="Category filters"
        >
          {CATEGORY_ORDER.map((category) => (
            <button
              key={category}
              type="button"
              className="learnings__chip"
              aria-pressed={categories.includes(category)}
              onClick={() => toggleCategory(category)}
            >
              {CATEGORY_LABELS[category]}
            </button>
          ))}
        </div>
        <div className="learnings__toolbar-controls">
          <label className="learnings__field">
            <span className="learnings__field-label">Status</span>
            <select
              className="learnings__select"
              value={statuses[0] ?? ''}
              onChange={(event) => {
                const value = event.target.value as '' | LearningStatus;
                onStatusesChange(value === '' ? [] : [value]);
              }}
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
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
          <Button onClick={() => setCapturing(true)}>Capture learning</Button>
        </div>
      </div>

      {response.rows.length === 0 ? (
        <EmptyState
          title="No learnings captured yet"
          description="Capture learning records an insight with its evidence quotes, so decisions cite what owners actually said."
          action={
            <Button onClick={() => setCapturing(true)}>Capture learning</Button>
          }
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
