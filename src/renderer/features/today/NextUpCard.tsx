import type { RefCallback } from 'react';

import type { TodayItem } from '../../../shared/contracts/todayContract';
import { titleCaseDisplayName } from '../../../shared/displayText';
import { RowContextMenu } from './RowContextMenu';
import type { TodayQueueRowProps } from './TodayQueueRow';
import { Button } from '../../components/Button';
import { reasonLineFor } from './rowText';

export type NextUpCardProps = Pick<TodayQueueRowProps, 'onSnoozeUntil' | 'onSkipToday' | 'onLogPastActivity' | 'onOpenInLeads'> & {
  item: TodayItem;
  busy: boolean;
  tabbable: boolean;
  rowRef: RefCallback<HTMLDivElement>;
  onOpenLead(personId: string): void;
  onCall(item: TodayItem): void;
};

/** The first real queue item, with a read-only brief and explicit workflow actions.
 * Enter on the focused card retains the existing Call route shortcut.
 */
export function NextUpCard({
  item,
  busy,
  tabbable,
  rowRef,
  onOpenLead,
  onCall,
  onSnoozeUntil, onSkipToday, onLogPastActivity, onOpenInLeads,
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
        <div className="today-next-up__body">
          <span className="today-next-up__eyebrow">A good place to start</span>
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
          <Button variant="primary" onClick={() => onOpenLead(item.personId)}>Open brief</Button>
          <Button variant="quiet" disabled={busy} onClick={() => onCall(item)}>
            Call
          </Button>
          <RowContextMenu item={item} busy={busy} onCall={onCall} onSnoozeUntil={onSnoozeUntil}
            onSkipToday={onSkipToday} onLogPastActivity={onLogPastActivity} onOpenInLeads={onOpenInLeads} />
        </div>
      </div>
    </section>
  );
}
