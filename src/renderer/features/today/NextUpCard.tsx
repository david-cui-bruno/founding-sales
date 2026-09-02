import type { RefCallback } from 'react';

import type { TodayItem } from '../../../shared/contracts/todayContract';
import { titleCaseDisplayName } from '../../../shared/displayText';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { reasonLineFor } from './rowText';

export type NextUpCardProps = {
  item: TodayItem;
  busy: boolean;
  tabbable: boolean;
  rowRef: RefCallback<HTMLDivElement>;
  onOpenLead(personId: string): void;
  onCall(item: TodayItem): void;
};

/**
 * The "Next up" card (audit 4.3): the top queue item pulled out with an
 * avatar, 16/600 name, the reason line, and one Call button. Enter on the
 * focused card calls (handled by the page keymap). A bluebonnet hairline
 * marks it as the single act-here surface.
 */
export function NextUpCard({
  item,
  busy,
  tabbable,
  rowRef,
  onOpenLead,
  onCall,
}: NextUpCardProps) {
  const name = titleCaseDisplayName(item.personName);

  return (
    <section className="today-next-up" aria-label="Next up">
      <div
        ref={rowRef}
        className="today-next-up__card"
        tabIndex={tabbable ? 0 : -1}
        data-cycle-id={item.salesCycleId}
        role="group"
        aria-label={`Next up: ${name}`}
      >
        <Avatar name={item.personName} />
        <div className="today-next-up__body">
          <span className="today-next-up__eyebrow">Next up</span>
          <div className="today-next-up__line1">
            <button
              type="button"
              className="today-next-up__person"
              tabIndex={-1}
              onClick={() => onOpenLead(item.personId)}
            >
              {name}
            </button>
            {item.contextLabel !== null && (
              <span className="today-next-up__context">{item.contextLabel}</span>
            )}
          </div>
          <p className="today-next-up__reason">{reasonLineFor(item)}</p>
        </div>
        <div className="today-next-up__action">
          <Button variant="primary" disabled={busy} onClick={() => onCall(item)}>
            Call
          </Button>
        </div>
      </div>
    </section>
  );
}
