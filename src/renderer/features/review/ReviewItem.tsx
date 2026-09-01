import {
  FileWarning,
  Lightbulb,
  MessageCircleQuestion,
  TriangleAlert,
  Unplug,
  Users,
} from 'lucide-react';

import type {
  ReviewItem as ReviewItemDto,
  ReviewKind,
} from '../../../shared/contracts/reviewContract';
import { humanizeEnumLabel } from '../../../shared/displayText';
import { StatusPill } from '../../components/StatusPill';
import { formatRelativeTime } from '../conversations/relativeTime';
import { reviewItemSummary, reviewItemTitle } from './reviewKindMeta';

const KIND_ICONS: Readonly<
  Record<ReviewKind, typeof MessageCircleQuestion>
> = Object.freeze({
  unmatched_communication: MessageCircleQuestion,
  ambiguous_identity: Users,
  transcript_suggestion: Lightbulb,
  import_problem: FileWarning,
  adapter_failure: Unplug,
  system_error: TriangleAlert,
});

export type ReviewItemProps = {
  item: ReviewItemDto;
  selected: boolean;
  onSelect(): void;
};

/**
 * One queue row: kind icon + humanized kind label, headline, summary, and
 * the occurrence time when the item carries one. Selecting it opens the
 * kind-specific resolution panel; the quiet "Resolve" affordance surfaces
 * on hover/focus. Blocking adapter failures stay visibly outbound-blocking.
 */
export function ReviewItem({ item, selected, onSelect }: ReviewItemProps) {
  const Icon = KIND_ICONS[item.kind];
  const occurredAt =
    item.kind === 'unmatched_communication' ? item.occurredAt : null;

  return (
    <li className="review-item">
      <button
        type="button"
        className="review-item__button"
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span className="review-item__top">
          <span className="review-item__kind">
            <Icon aria-hidden="true" size={14} />
            {humanizeEnumLabel(item.kind)}
          </span>
          {occurredAt !== null && (
            <span className="review-item__when numeric">
              {formatRelativeTime(occurredAt)}
            </span>
          )}
        </span>
        <span className="review-item__title">{reviewItemTitle(item)}</span>
        <span className="review-item__summary">{reviewItemSummary(item)}</span>
        {item.kind === 'adapter_failure' && item.blocking && (
          <StatusPill tone="danger">Outbound blocking</StatusPill>
        )}
        <span className="review-item__resolve" aria-hidden="true">
          Resolve
        </span>
      </button>
    </li>
  );
}
