import type { RefCallback } from 'react';

import type { TodayItem } from '../../../shared/contracts/todayContract';
import { humanizeEnumLabel, titleCaseDisplayName } from '../../../shared/displayText';
import { Button } from '../../components/Button';
import { StatusPill } from '../../components/StatusPill';
import { reasonLineFor } from './rowText';

export type TodayHeroCardProps = {
  item: TodayItem;
  busy: boolean;
  tabbable: boolean;
  rowRef: RefCallback<HTMLDivElement>;
  onOpenLead(personId: string): void;
  onComplete(item: TodayItem): void;
};

/**
 * The "Next up" hero: the single first actionable item enlarged, with the
 * person, the humanized reason line, and the one primary command. It joins
 * the same roving-focus list as the queue rows.
 */
export function TodayHeroCard({
  item,
  busy,
  tabbable,
  rowRef,
  onOpenLead,
  onComplete,
}: TodayHeroCardProps) {
  return (
    <section className="today-hero" aria-label="Next up">
      <div
        ref={rowRef}
        className="today-hero__card"
        tabIndex={tabbable ? 0 : -1}
        data-cycle-id={item.salesCycleId}
        role="group"
        aria-label={`Next up: ${titleCaseDisplayName(item.personName)}`}
      >
        <div className="today-hero__body">
          <span className="today-hero__eyebrow">Next up</span>
          <div className="today-hero__line1">
            <button
              type="button"
              className="today-hero__person"
              tabIndex={-1}
              onClick={() => onOpenLead(item.personId)}
            >
              {titleCaseDisplayName(item.personName)}
            </button>
            {item.contextLabel !== null && (
              <span className="today-hero__context">{item.contextLabel}</span>
            )}
            <span className="today-row__stage-chip">
              {humanizeEnumLabel(item.stage)}
            </span>
            {item.pinned && <StatusPill>Pinned</StatusPill>}
            {item.verifyFirst && <StatusPill tone="urgent">Verify first</StatusPill>}
          </div>
          <p className="today-hero__reason">{reasonLineFor(item)}</p>
        </div>
        <div className="today-hero__action">
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => onComplete(item)}
          >
            Done
          </Button>
        </div>
      </div>
    </section>
  );
}
