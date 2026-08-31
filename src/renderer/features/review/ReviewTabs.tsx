import type {
  ReviewItem,
  ReviewKind,
} from '../../../shared/contracts/reviewContract';
import { REVIEW_KIND_ORDER, reviewKindMeta } from './reviewKindMeta';

export type ReviewTabsProps = {
  items: readonly ReviewItem[];
  selectedKind: ReviewKind;
  onSelectKind(kind: ReviewKind): void;
};

/** One counted tab per review kind, in fixed order. Counts never hide. */
export function ReviewTabs({ items, selectedKind, onSelectKind }: ReviewTabsProps) {
  return (
    <div className="review__tabs" role="tablist" aria-label="Review queues">
      {REVIEW_KIND_ORDER.map((kind) => {
        const count = items.filter((item) => item.kind === kind).length;
        return (
          <button
            key={kind}
            type="button"
            role="tab"
            className="review__tab"
            aria-selected={kind === selectedKind}
            onClick={() => onSelectKind(kind)}
          >
            {reviewKindMeta(kind).tabLabel}{' '}
            <span className="review__tab-count">{count}</span>
          </button>
        );
      })}
    </div>
  );
}
