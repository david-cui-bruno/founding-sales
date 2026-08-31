import { useId } from 'react';

import type {
  PipelineCard,
  PipelineSnapshot,
} from '../../../shared/contracts/pipelineContract';
import { StatusPill } from '../../components/StatusPill';
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
 * A card is a plain button that opens the person. There is no drag
 * handle and no stage mutation command anywhere in the pipeline.
 */
function PipelineCardButton({ card, onOpenLead }: PipelineCardButtonProps) {
  const wonBadge = wonOutcomeLabel(card);
  const lostLabel = lostReasonLabel(card);

  return (
    <button
      type="button"
      className="pipeline-card"
      onClick={() => onOpenLead(card.personId)}
    >
      <span className="pipeline-card__name">{card.personName}</span>
      {card.contextLabel !== null && (
        <span className="pipeline-card__context">{card.contextLabel}</span>
      )}
      {card.priorityContext === null ? (
        <span className="pipeline-card__muted">No priority data</span>
      ) : (
        <span className="pipeline-card__bands">
          <StatusPill
            tone={card.priorityContext.priority === 'P0' ? 'urgent' : 'neutral'}
          >
            {card.priorityContext.priority}
          </StatusPill>
          <span className="pipeline-card__band">
            {`Fit ${card.priorityContext.fitBand} · ${card.priorityContext.fitPoints}/30`}
          </span>
          <span className="pipeline-card__band">
            {`Timing ${card.priorityContext.timingBand} · ${card.priorityContext.timingValue}/40`}
          </span>
        </span>
      )}
      {card.nextAction !== null && (
        <span className="pipeline-card__action">
          <span className="pipeline-card__action-label">
            {card.nextAction.label}
          </span>
          {card.nextAction.overdue && (
            <StatusPill tone="urgent">Overdue</StatusPill>
          )}
        </span>
      )}
      {wonBadge !== null && <StatusPill tone="positive">{wonBadge}</StatusPill>}
      {lostLabel !== null && (
        <span className="pipeline-card__muted">{lostLabel}</span>
      )}
    </button>
  );
}

export type PipelineStageColumnProps = {
  lane: PipelineStageLane;
  onOpenLead(personId: string): void;
};

/** One fixed lifecycle column. Empty stages stay visible. */
export function PipelineStageColumn({
  lane,
  onOpenLead,
}: PipelineStageColumnProps) {
  const headingId = useId();
  const meta = PIPELINE_STAGE_META[lane.stage];

  return (
    <section className="pipeline-column" aria-labelledby={headingId}>
      <header className="pipeline-column__header">
        <h2 className="pipeline-column__title" id={headingId}>
          {meta.label}
        </h2>
        <span className="pipeline-column__count" aria-hidden="true">
          {lane.cards.length}
        </span>
      </header>
      {lane.cards.length === 0 ? (
        <p className="pipeline-column__empty">No leads</p>
      ) : (
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
