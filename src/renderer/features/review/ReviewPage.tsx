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
  snapshot: ReviewSnapshot | null;
  selectedKind: ReviewKind;
  onSelectKind(kind: ReviewKind): void;
  onResolve(input: ResolveReviewRequest): void;
  onOpenLead(personId: string): void;
  resolutionPending?: boolean;
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
  resolutionPending = false,
}: ReviewPageProps) {
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null);

  const systemCount = snapshot?.queues.system_error.openCount ?? 0;
  const queueItems = snapshot === null || snapshot.queues[selectedKind].source === 'not_integrated'
    ? [] : snapshot.items.filter((item) => item.kind === selectedKind);
  const selectedItem = queueItems.find((item) => item.reviewId === selectedReviewId) ?? null;


  return (
    <div className="review">
      <PageHeader
        title="Inbox"
        count={snapshot === null ? undefined : `${snapshot.totalOpenCount} open local reviews`}
        description="Open local lifecycle reviews. Other review sources are not integrated into this Inbox."
      />
      {snapshot !== null && <p>Observed <time dateTime={snapshot.observedAt}>{snapshot.observedAt}</time>.</p>}
      {systemCount > 0 && (
        <div className="review__system-alert" role="alert">
          <strong>{systemCount} system errors need attention.</strong>
          <button type="button" onClick={() => onSelectKind('system_error')}>View system errors</button>
        </div>
      )}
      <ReviewTabs
        queues={snapshot?.queues ?? null}
        selectedKind={selectedKind}
        onSelectKind={(kind) => {
          setSelectedReviewId(null);
          onSelectKind(kind);
        }}
      />
      {snapshot !== null && <div className="review__body">
        <ReviewQueue
          kind={selectedKind}
          availability={snapshot.queues[selectedKind]}
          items={queueItems}
          selectedReviewId={selectedReviewId}
          onSelect={setSelectedReviewId}
        />
        {selectedItem !== null && (
          <fieldset disabled={resolutionPending} aria-busy={resolutionPending} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
          <ReviewDetailPanel
            key={selectedItem.reviewId}
            item={selectedItem}
            onResolve={onResolve}
            onOpenLead={onOpenLead}
          />
          </fieldset>
        )}
      </div>}
    </div>
  );
}
