import { useId, useState } from 'react';

import type {
  ResolveReviewRequest,
  ReviewItem,
} from '../../../shared/contracts/reviewContract';
import { Button } from '../../components/Button';
import { Panel } from '../../components/Panel';
import { assertNeverReviewKind, reviewItemTitle } from './reviewKindMeta';

export type ReviewDetailPanelProps = {
  item: ReviewItem;
  onResolve(input: ResolveReviewRequest): void;
  onOpenLead(personId: string): void;
};

/** Only unmatched Promote is currently supported by the production resolver.
 * Open review items use version 1 for the supported compare-and-swap command.
 */
const OPEN_REVIEW_VERSION = 1;

export function ReviewDetailPanel({
  item,
  onResolve,
  onOpenLead,
}: ReviewDetailPanelProps) {
  return (
    <Panel title={reviewItemTitle(item)}>
      <ReviewActions item={item} onResolve={onResolve} onOpenLead={onOpenLead} />
    </Panel>
  );
}

function ReviewActions({ item, onResolve, onOpenLead }: ReviewDetailPanelProps) {
  switch (item.kind) {
    case 'unmatched_communication':
      return <UnmatchedActions item={item} onResolve={onResolve} />;
    case 'ambiguous_identity':
      return (
        <div className="review-detail__actions">
          <p className="review-detail__copy">{item.summary}</p>
          <p className="review-detail__copy">
            Identity selection is unavailable in this Inbox. Open a candidate to inspect their details.
          </p>
          {item.candidatePersonIds.map((personId) => (
            <div key={personId} className="review-detail__candidate">
              <Button variant="quiet" onClick={() => onOpenLead(personId)}>
                {`Open ${personId}`}
              </Button>
            </div>
          ))}
        </div>
      );
    case 'transcript_suggestion':
      return <SuggestionEvidence item={item} />;
    case 'import_problem':
      return (
        <div className="review-detail__actions">
          <p className="review-detail__copy">{item.summary}</p>
          <p className="review-detail__copy">
            Import retry and dismissal are unavailable in this Inbox. Inspect the row evidence before planning a separate import correction.
          </p>
        </div>
      );
    case 'adapter_failure':
      return (
        <div className="review-detail__actions">
          <p className="review-detail__copy">{item.summary}</p>
          <p className="review-detail__copy">
            Adapter retry is unavailable in this Inbox. Inspect the failure evidence and check adapter settings separately.
          </p>
        </div>
      );
    case 'system_error':
      return (
        <div className="review-detail__actions">
          <p className="review-detail__copy">{`Invariant: ${item.invariant}`}</p>
          <p className="review-detail__copy">
            Invariant repair is unavailable in this Inbox. Keep this evidence for a separately reviewed repair.
          </p>
        </div>
      );
    default:
      return assertNeverReviewKind(item);
  }
}

function UnmatchedActions({ item, onResolve }: {
  item: Extract<ReviewItem, { kind: 'unmatched_communication' }>;
  onResolve(input: ResolveReviewRequest): void;
}) {
  const sourceEventFieldId = useId();
  const [sourceEventId, setSourceEventId] = useState('');
  const matchedSourceEventId = sourceEventId.trim();

  return (
    <div className="review-detail__actions">
      <p className="review-detail__copy">{item.summary}</p>
      <div className="review-detail__field">
        <label htmlFor={sourceEventFieldId}>Matched source event ID</label>
        <input
          id={sourceEventFieldId}
          className="review-detail__input"
          value={sourceEventId}
          onChange={(event) => setSourceEventId(event.target.value)}
        />
      </div>
      <Button
        disabled={matchedSourceEventId.length === 0}
        onClick={() => onResolve({
          kind: 'unmatched_communication',
          reviewId: item.reviewId,
          expectedVersion: OPEN_REVIEW_VERSION,
          action: 'promote',
          personId: null,
          sourceEventId: matchedSourceEventId,
        })}
      >
        Promote
      </Button>
      <p className="review-detail__copy">
        Mark personal is unavailable in this Inbox. Never Record has not been applied.
      </p>
    </div>
  );
}

function SuggestionEvidence({ item }: {
  item: Extract<ReviewItem, { kind: 'transcript_suggestion' }>;
}) {
  return (
    <div className="review-detail__actions">
      <ul className="review-detail__evidence" aria-label="Evidence">
        {item.evidence.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="review-detail__copy">
        Suggestion acceptance, editing, and dismissal are unavailable in this Inbox. Inspect the evidence before making any separate changes.
      </p>
    </div>
  );
}
