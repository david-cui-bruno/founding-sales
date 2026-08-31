import { useState } from 'react';

import type {
  ResolveReviewRequest,
  ReviewKind,
  ReviewSnapshot,
} from '../../../shared/contracts/reviewContract';
import { Button } from '../../components/Button';
import { ReviewDetailPanel } from './ReviewDetailPanel';
import { ReviewQueue } from './ReviewQueue';
import { ReviewTabs } from './ReviewTabs';

export type ReviewPageProps = {
  snapshot: ReviewSnapshot;
  selectedKind: ReviewKind;
  onSelectKind(kind: ReviewKind): void;
  onResolve(input: ResolveReviewRequest): void;
  onOpenLead(personId: string): void;
};

type TranscriptSuggestion = Extract<
  ReviewSnapshot['items'][number],
  { kind: 'transcript_suggestion' }
>;

/**
 * Batch acceptance is allowed only when no two open suggestions compete for
 * the same person and suggestion type; conflicts must be resolved one by one.
 */
function suggestionsConflict(suggestions: readonly TranscriptSuggestion[]): boolean {
  const seen = new Set<string>();
  for (const suggestion of suggestions) {
    const key = `${suggestion.personId}\u0000${suggestion.suggestionType}`;
    if (seen.has(key)) {
      return true;
    }
    seen.add(key);
  }
  return false;
}

/**
 * The review workspace: counted queue tabs, the selected queue, and the
 * kind-specific resolution panel. System errors render inside a persistent
 * `role="alert"` region that stays visible whichever queue is selected.
 */
export function ReviewPage({
  snapshot,
  selectedKind,
  onSelectKind,
  onResolve,
  onOpenLead,
}: ReviewPageProps) {
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null);

  const systemErrors = snapshot.items.filter((item) => item.kind === 'system_error');
  const queueItems = snapshot.items.filter((item) => item.kind === selectedKind);
  const selectedItem = queueItems.find((item) => item.reviewId === selectedReviewId) ?? null;

  const suggestions = snapshot.items.filter(
    (item): item is TranscriptSuggestion => item.kind === 'transcript_suggestion',
  );
  const conflicted = suggestionsConflict(suggestions);

  return (
    <div className="review">
      {systemErrors.length > 0 && (
        <div className="review__system-alert" role="alert">
          <strong>System errors need attention.</strong>
          <ul className="review__system-alert-list">
            {systemErrors.map((item) => (
              <li key={item.reviewId}>{item.summary}</li>
            ))}
          </ul>
        </div>
      )}
      <ReviewTabs
        items={snapshot.items}
        selectedKind={selectedKind}
        onSelectKind={(kind) => {
          setSelectedReviewId(null);
          onSelectKind(kind);
        }}
      />
      {selectedKind === 'transcript_suggestion' && suggestions.length > 1 && (
        conflicted ? (
          <p className="review__batch-note">
            Conflicting suggestions for the same person must be resolved one by one.
          </p>
        ) : (
          <div className="review__batch">
            <Button
              onClick={() => {
                for (const suggestion of suggestions) {
                  onResolve({
                    kind: 'transcript_suggestion',
                    reviewId: suggestion.reviewId,
                    expectedVersion: 1,
                    action: 'accept',
                    editedValue: null,
                  });
                }
              }}
            >
              {`Accept all ${suggestions.length}`}
            </Button>
          </div>
        )
      )}
      <div className="review__body">
        <ReviewQueue
          kind={selectedKind}
          items={queueItems}
          selectedReviewId={selectedReviewId}
          onSelect={setSelectedReviewId}
        />
        {selectedItem !== null && (
          <ReviewDetailPanel
            item={selectedItem}
            onResolve={onResolve}
            onOpenLead={onOpenLead}
          />
        )}
      </div>
    </div>
  );
}
