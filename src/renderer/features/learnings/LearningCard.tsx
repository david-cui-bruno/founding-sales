import { useState } from 'react';

import type {
  AddEvidenceRequest,
  LearningRow,
  UpdateLearningStatusRequest,
} from '../../../shared/contracts/learningsContract';
import { Button } from '../../components/Button';
import { StatusPill } from '../../components/StatusPill';
import { CATEGORY_LABELS } from './learningMeta';

const COLLAPSED_QUOTE_COUNT = 2;

const observed = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
});

const confidenceLabel: Record<LearningRow['confidence'], string> = {
  low: 'Low confidence',
  medium: 'Medium confidence',
  high: 'High confidence',
};

const confidenceTone: Record<LearningRow['confidence'], 'neutral' | 'positive'> = {
  low: 'neutral',
  medium: 'neutral',
  high: 'positive',
};

export type LearningCardProps = {
  row: LearningRow;
  onAddEvidence(request: AddEvidenceRequest): Promise<void>;
  onUpdateStatus(request: UpdateLearningStatusRequest): Promise<void>;
  onOpenLead(personId: string): void;
  now(): string;
};

/**
 * One curated learning: the claim, its confidence, its evidence trail, and
 * the founder's status controls. Contradicted learnings stay visible,
 * struck through with the recorded reason.
 */
export function LearningCard({
  row,
  onAddEvidence,
  onUpdateStatus,
  onOpenLead,
  now,
}: LearningCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [addingEvidence, setAddingEvidence] = useState(false);
  const [newQuote, setNewQuote] = useState('');
  const [contradicting, setContradicting] = useState(false);
  const [contradictionReason, setContradictionReason] = useState('');

  const visibleEvidence = expanded
    ? row.evidence
    : row.evidence.slice(0, COLLAPSED_QUOTE_COUNT);

  const submitEvidence = () => {
    const quote = newQuote.trim();
    if (quote.length === 0) {
      return;
    }
    void onAddEvidence({
      learningId: row.learningId,
      expectedVersion: row.version,
      evidence: { personId: null, activityId: null, quote, notedAt: now() },
    }).then(
      (): void => {
        setAddingEvidence(false);
        setNewQuote('');
      },
      (): void => undefined,
    );
  };

  const submitContradiction = () => {
    const reason = contradictionReason.trim();
    if (reason.length === 0) {
      return;
    }
    void onUpdateStatus({
      learningId: row.learningId,
      expectedVersion: row.version,
      status: 'contradicted',
      reason,
    }).then(
      (): void => {
        setContradicting(false);
        setContradictionReason('');
      },
      (): void => undefined,
    );
  };

  const updateStatus = (status: 'active' | 'retired') => {
    void onUpdateStatus({
      learningId: row.learningId,
      expectedVersion: row.version,
      status,
      reason: null,
    }).catch((): void => undefined);
  };

  return (
    <article
      className={`learning-card learning-card--${row.status}`}
      aria-label={row.statement}
    >
      <header className="learning-card__header">
        <span className="learning-card__category">
          {CATEGORY_LABELS[row.category]}
        </span>
        <StatusPill tone={confidenceTone[row.confidence]}>
          {confidenceLabel[row.confidence]}
        </StatusPill>
        {row.status !== 'active' && (
          <StatusPill tone={row.status === 'contradicted' ? 'danger' : 'neutral'}>
            {row.status === 'contradicted' ? 'Contradicted' : 'Retired'}
          </StatusPill>
        )}
      </header>

      {row.status === 'contradicted' ? (
        <>
          <s className="learning-card__statement learning-card__statement--struck">
            <span>{row.statement}</span>
          </s>
          {row.statusReason !== null && (
            <p className="learning-card__status-reason">{row.statusReason}</p>
          )}
        </>
      ) : (
        <p className="learning-card__statement">{row.statement}</p>
      )}

      <p className="learning-card__observations">
        <span className="learning-card__sample">{`n = ${row.sampleSize}`}</span>
        <span className="learning-card__dates">
          {`${observed.format(new Date(row.firstObservedAt))} – ${observed.format(new Date(row.latestObservedAt))}`}
        </span>
      </p>

      <ul className="learning-card__evidence" aria-label="Evidence quotes">
        {visibleEvidence.map((evidence) => (
          <li key={evidence.id} className="learning-card__quote">
            <blockquote className="learning-card__quote-text">
              {evidence.quote}
            </blockquote>
            {evidence.personId !== null && evidence.personName !== null && (
              <button
                type="button"
                className="learning-card__person"
                onClick={() => onOpenLead(evidence.personId!)}
              >
                {evidence.personName}
              </button>
            )}
          </li>
        ))}
      </ul>
      {row.evidence.length > COLLAPSED_QUOTE_COUNT && !expanded && (
        <button
          type="button"
          className="learning-card__show-all"
          onClick={() => setExpanded(true)}
        >
          {`Show all ${row.evidence.length}`}
        </button>
      )}

      {addingEvidence ? (
        <div className="learning-card__evidence-form">
          <label className="learning-card__field">
            <span className="learning-card__field-label">New evidence quote</span>
            <textarea
              className="learning-card__textarea"
              value={newQuote}
              maxLength={2000}
              onChange={(event) => setNewQuote(event.target.value)}
            />
          </label>
          <div className="learning-card__form-actions">
            <Button onClick={submitEvidence}>Save evidence</Button>
            <Button
              variant="quiet"
              onClick={() => {
                setAddingEvidence(false);
                setNewQuote('');
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <footer className="learning-card__actions">
          <Button variant="quiet" onClick={() => setAddingEvidence(true)}>
            Add evidence
          </Button>
          {row.status === 'active' ? (
            <>
              <Button variant="quiet" onClick={() => updateStatus('retired')}>
                Retire
              </Button>
              {!contradicting && (
                <Button variant="quiet" onClick={() => setContradicting(true)}>
                  Mark contradicted
                </Button>
              )}
            </>
          ) : (
            <Button variant="quiet" onClick={() => updateStatus('active')}>
              Reactivate
            </Button>
          )}
        </footer>
      )}

      {contradicting && row.status === 'active' && (
        <div className="learning-card__contradiction-form">
          <label className="learning-card__field">
            <span className="learning-card__field-label">Contradiction reason</span>
            <textarea
              className="learning-card__textarea"
              value={contradictionReason}
              maxLength={500}
              onChange={(event) => setContradictionReason(event.target.value)}
            />
          </label>
          <div className="learning-card__form-actions">
            <Button
              variant="danger"
              disabled={contradictionReason.trim().length === 0}
              onClick={submitContradiction}
            >
              Confirm contradiction
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                setContradicting(false);
                setContradictionReason('');
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}
