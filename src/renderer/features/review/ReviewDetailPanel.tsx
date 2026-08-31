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

/**
 * Kind-specific resolution actions. Every command is built from the strict
 * discriminated contract, so a wrong-kind payload cannot be constructed.
 * Open review items are version 1 until resolved, which resolution bumps,
 * so the compare-and-swap `expectedVersion` is the V1 open version.
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
          {item.candidatePersonIds.map((personId) => (
            <div key={personId} className="review-detail__candidate">
              <Button variant="quiet" onClick={() => onOpenLead(personId)}>
                {`Open ${personId}`}
              </Button>
              <Button
                onClick={() => onResolve({
                  kind: 'ambiguous_identity',
                  reviewId: item.reviewId,
                  expectedVersion: OPEN_REVIEW_VERSION,
                  action: 'choose_identity',
                  personId,
                })}
              >
                {`Choose ${personId}`}
              </Button>
            </div>
          ))}
        </div>
      );
    case 'transcript_suggestion':
      return <SuggestionActions item={item} onResolve={onResolve} />;
    case 'import_problem':
      return (
        <div className="review-detail__actions">
          <p className="review-detail__copy">{item.summary}</p>
          <Button
            onClick={() => onResolve({
              kind: 'import_problem',
              reviewId: item.reviewId,
              expectedVersion: OPEN_REVIEW_VERSION,
              action: 'retry',
            })}
          >
            Retry
          </Button>
          <Button
            variant="quiet"
            onClick={() => onResolve({
              kind: 'import_problem',
              reviewId: item.reviewId,
              expectedVersion: OPEN_REVIEW_VERSION,
              action: 'dismiss',
            })}
          >
            Dismiss
          </Button>
        </div>
      );
    case 'adapter_failure':
      return (
        <div className="review-detail__actions">
          <p className="review-detail__copy">{item.summary}</p>
          <Button
            onClick={() => onResolve({
              kind: 'adapter_failure',
              reviewId: item.reviewId,
              expectedVersion: OPEN_REVIEW_VERSION,
              action: 'retry',
            })}
          >
            Retry adapter
          </Button>
        </div>
      );
    case 'system_error':
      return <SystemErrorActions item={item} onResolve={onResolve} />;
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
      <Button
        variant="danger"
        onClick={() => onResolve({
          kind: 'unmatched_communication',
          reviewId: item.reviewId,
          expectedVersion: OPEN_REVIEW_VERSION,
          action: 'mark_personal',
          personId: null,
          sourceEventId: null,
        })}
      >
        Mark personal (Never Record)
      </Button>
    </div>
  );
}

function SuggestionActions({ item, onResolve }: {
  item: Extract<ReviewItem, { kind: 'transcript_suggestion' }>;
  onResolve(input: ResolveReviewRequest): void;
}) {
  const editedFieldId = useId();
  const [editedValue, setEditedValue] = useState('');
  const trimmedEdit = editedValue.trim();

  return (
    <div className="review-detail__actions">
      <ul className="review-detail__evidence" aria-label="Evidence">
        {item.evidence.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <Button
        onClick={() => onResolve({
          kind: 'transcript_suggestion',
          reviewId: item.reviewId,
          expectedVersion: OPEN_REVIEW_VERSION,
          action: 'accept',
          editedValue: null,
        })}
      >
        Accept
      </Button>
      <div className="review-detail__field">
        <label htmlFor={editedFieldId}>Edited value</label>
        <input
          id={editedFieldId}
          className="review-detail__input"
          value={editedValue}
          onChange={(event) => setEditedValue(event.target.value)}
        />
      </div>
      <Button
        disabled={trimmedEdit.length === 0}
        onClick={() => onResolve({
          kind: 'transcript_suggestion',
          reviewId: item.reviewId,
          expectedVersion: OPEN_REVIEW_VERSION,
          action: 'edit',
          editedValue: trimmedEdit,
        })}
      >
        Save edit
      </Button>
      <Button
        variant="quiet"
        onClick={() => onResolve({
          kind: 'transcript_suggestion',
          reviewId: item.reviewId,
          expectedVersion: OPEN_REVIEW_VERSION,
          action: 'dismiss',
          editedValue: null,
        })}
      >
        Dismiss
      </Button>
    </div>
  );
}

function SystemErrorActions({ item, onResolve }: {
  item: Extract<ReviewItem, { kind: 'system_error' }>;
  onResolve(input: ResolveReviewRequest): void;
}) {
  const repairFieldId = useId();
  const [repairCommand, setRepairCommand] = useState('');
  const trimmedCommand = repairCommand.trim();

  return (
    <div className="review-detail__actions">
      <p className="review-detail__copy">{`Invariant: ${item.invariant}`}</p>
      <div className="review-detail__field">
        <label htmlFor={repairFieldId}>Repair command</label>
        <input
          id={repairFieldId}
          className="review-detail__input"
          value={repairCommand}
          onChange={(event) => setRepairCommand(event.target.value)}
        />
      </div>
      <Button
        disabled={trimmedCommand.length === 0}
        onClick={() => onResolve({
          kind: 'system_error',
          reviewId: item.reviewId,
          expectedVersion: OPEN_REVIEW_VERSION,
          action: 'repair_invariant',
          repairCommand: trimmedCommand,
        })}
      >
        Repair invariant
      </Button>
    </div>
  );
}
