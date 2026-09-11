import type {
  ReviewItem as ReviewItemDto,
  ReviewKind,
  ReviewQueueAvailability,
} from '../../../shared/contracts/reviewContract';
import { StatusBadge } from '../../components/StatusBadge';
import { ReviewItem } from './ReviewItem';
import { reviewKindMeta } from './reviewKindMeta';

export type ReviewQueueProps = {
  kind: ReviewKind;
  availability: ReviewQueueAvailability;
  items: readonly ReviewItemDto[];
  selectedReviewId: string | null;
  onSelect(reviewId: string): void;
};

/** The open items of exactly one review kind. */
export function ReviewQueue({
  kind,
  availability,
  items,
  selectedReviewId,
  onSelect,
}: ReviewQueueProps) {
  const meta = reviewKindMeta(kind);

  if (availability.source === 'not_integrated') {
    return <div className="review-queue__clear">
      <StatusBadge tone="neutral" label="Not available in this Inbox" />
      <p>This source is not integrated into this local Inbox. No count or health conclusion is available.</p>
    </div>;
  }
  if (items.length === 0) {
    return (
      <div className="review-queue__clear">
        <StatusBadge tone="neutral" label="No items in this view" />
        <p className="review-queue__clear-copy">{meta.emptyCopy}</p>
      </div>
    );
  }

  return (
    <ul className="review-queue" aria-label={meta.tabLabel}>
      {items.map((item) => (
        <ReviewItem
          key={item.reviewId}
          item={item}
          selected={item.reviewId === selectedReviewId}
          onSelect={() => onSelect(item.reviewId)}
        />
      ))}
    </ul>
  );
}
