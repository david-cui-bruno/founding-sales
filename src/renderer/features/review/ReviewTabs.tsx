import type { KeyboardEvent } from 'react';
import { useRef } from 'react';

import type {
  ReviewQueueCounts,
  ReviewKind,
} from '../../../shared/contracts/reviewContract';
import { REVIEW_KIND_ORDER, reviewKindMeta } from './reviewKindMeta';

export type ReviewTabsProps = {
  queues: ReviewQueueCounts | null;
  selectedKind: ReviewKind;
  onSelectKind(kind: ReviewKind): void;
};

/**
 * One counted tab per review kind, in fixed order, styled as the shared
 * segmented control (accent-soft selected fill). Counts never hide. Tab
 * semantics stay: the queue below is the tab panel this control drives.
 */
export function ReviewTabs({ queues, selectedKind, onSelectKind }: ReviewTabsProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  const moveSelection = (delta: number) => {
    const index = REVIEW_KIND_ORDER.indexOf(selectedKind);
    const nextIndex =
      (index + delta + REVIEW_KIND_ORDER.length) % REVIEW_KIND_ORDER.length;
    onSelectKind(REVIEW_KIND_ORDER[nextIndex]!);
    const tabs = rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs?.[nextIndex]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      moveSelection(-1);
    }
  };

  return (
    <div
      ref={rootRef}
      className="segmented-control review-tabs"
      role="tablist"
      aria-label="Review queues"
    >
      {REVIEW_KIND_ORDER.map((kind) => {
        const count = queues === null ? 'Checking' : queues[kind].openCount ?? 'Not available in this Inbox';
        const selected = kind === selectedKind;
        return (
          <button
            key={kind}
            type="button"
            role="tab"
            className="segmented-control__option review-tabs__tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelectKind(kind)}
            onKeyDown={onKeyDown}
          >
            {reviewKindMeta(kind).tabLabel}{' '}
            <span className="review-tabs__count numeric">{count}</span>
          </button>
        );
      })}
    </div>
  );
}
