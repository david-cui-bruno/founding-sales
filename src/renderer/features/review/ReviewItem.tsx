import type { ReviewItem as ReviewItemDto } from '../../../shared/contracts/reviewContract';
import { StatusPill } from '../../components/StatusPill';
import { reviewItemSummary, reviewItemTitle } from './reviewKindMeta';

export type ReviewItemProps = {
  item: ReviewItemDto;
  selected: boolean;
  onSelect(): void;
};

/**
 * One queue row. Selecting it opens the kind-specific resolution panel.
 * Blocking adapter failures stay visibly outbound-blocking until resolved.
 */
export function ReviewItem({ item, selected, onSelect }: ReviewItemProps) {
  return (
    <li className="review-item">
      <button
        type="button"
        className="review-item__button"
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span className="review-item__title">{reviewItemTitle(item)}</span>
        <span className="review-item__summary">{reviewItemSummary(item)}</span>
        {item.kind === 'adapter_failure' && item.blocking && (
          <StatusPill tone="danger">Outbound blocking</StatusPill>
        )}
      </button>
    </li>
  );
}
