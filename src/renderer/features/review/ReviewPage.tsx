import { useState } from 'react';

import type {
  ResolveReviewRequest,
  ReviewKind,
  ReviewSnapshot,
} from '../../../shared/contracts/reviewContract';
import { PageHeader } from '../../components/PageHeader';
import { ReviewDetailPanel } from './ReviewDetailPanel';
import { ReviewQueue } from './ReviewQueue';
import { ReviewTabs } from './ReviewTabs';

import './review.css';

export type ReviewPageProps = {
  snapshot: ReviewSnapshot;
  selectedKind: ReviewKind;
  onSelectKind(kind: ReviewKind): void;
  onResolve(input: ResolveReviewRequest): void;
  onOpenLead(personId: string): void;
};

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

  const suggestionCount = snapshot.items.filter((item) => item.kind === 'transcript_suggestion').length;

  return (
    <div className="review">
      <PageHeader
        title="Inbox"
        count={`${snapshot.totalOpenCount} open`}
        description="Exceptions that need your judgment: unknown callers, possible duplicates, and unidentified property owners."
      />
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
      {selectedKind === 'transcript_suggestion' && suggestionCount > 1 && (
        <p className="review__batch-note">
          Batch acceptance is unavailable in this Inbox. Suggestions remain read-only evidence.
        </p>
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
