import { useId } from 'react';

import type {
  PipelineCard,
  PipelineSnapshot,
} from '../../../shared/contracts/pipelineContract';
import { titleCaseDisplayName } from '../../../shared/displayText';
import { Avatar } from '../../components/Avatar';
import {
  lostReasonLabel,
  PIPELINE_STAGE_META,
  wonOutcomeLabel,
} from './pipelineStageMeta';

type PipelineStageLane = PipelineSnapshot['stages'][number];

type PipelineCardButtonProps = {
  card: PipelineCard;
  onOpenLead(personId: string): void;
};

/**
 * The single muted status line under the chip: won outcome, lost reason,
 * or the real next action. The auto-generated "Review lead" filler carries
 * no information on an unreviewed card, so it stays off the board.
 */
function cardStatusLine(card: PipelineCard): {
  text: string;
} | null {
  const wonBadge = wonOutcomeLabel(card);
  if (wonBadge !== null) {
    return { text: wonBadge };
  }
  const lostLabel = lostReasonLabel(card);
  if (lostLabel !== null) {
    return { text: lostLabel };
  }
  if (card.nextAction !== null && card.nextAction.channel !== 'review') {
    return { text: card.nextAction.label };
  }
  return null;
}

/**
 * A compact card: avatar + Title-Case name, at most one score chip, and a
 * single muted status line. It is a plain button that opens the person;
 * there is no drag handle and no stage mutation command anywhere.
 */
function PipelineCardButton({ card, onOpenLead }: PipelineCardButtonProps) {
  const status = cardStatusLine(card);
  const scores = card.priorityContext;
  const zeroSignal =
    scores !== null && scores.fitPoints === 0 && scores.timingValue === 0;

  return (
    <button
      type="button"
      className="pipeline-card"
      onClick={() => onOpenLead(card.personId)}
    >
      <span className="pipeline-card__identity">
        <span aria-hidden="true">
          <Avatar name={titleCaseDisplayName(card.personName)} />
        </span>
        <span className="pipeline-card__name">
          {titleCaseDisplayName(card.personName)}
        </span>
      </span>
      {scores !== null && (
        <span
          className={
            zeroSignal
              ? 'pipeline-card__chip pipeline-card__chip--zero'
              : 'pipeline-card__chip'
          }
        >
          {`Fit ${scores.fitPoints} · Timing ${scores.timingValue}`}
        </span>
      )}
      {status !== null && (
        <span className="pipeline-card__status">
          {status.text}
        </span>
      )}
    </button>
  );
}

export type PipelineStageColumnProps = {
  lane: PipelineStageLane;
  onOpenLead(personId: string): void;
};

/**
 * One fixed lifecycle column. Empty stages stay visible but collapse to a
 * slim rail: just the header with a faint zero, no tall placeholder box.
 */
export function PipelineStageColumn({
  lane,
  onOpenLead,
}: PipelineStageColumnProps) {
  const headingId = useId();
  const meta = PIPELINE_STAGE_META[lane.stage];
  const empty = lane.cards.length === 0;

  return (
    <section
      className={
        empty ? 'pipeline-column pipeline-column--empty' : 'pipeline-column'
      }
      aria-labelledby={headingId}
    >
      <header className="pipeline-column__header">
        <h2 className="pipeline-column__title" id={headingId}>
          {meta.label}
        </h2>
        <span className="pipeline-column__count" aria-hidden="true">
          {lane.cards.length}
        </span>
      </header>
      {!empty && (
        <ul className="pipeline-column__cards">
          {lane.cards.map((card) => (
            <li key={card.salesCycleId} className="pipeline-column__card-item">
              <PipelineCardButton card={card} onOpenLead={onOpenLead} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
