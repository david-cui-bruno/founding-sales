import { Check, Clock, Pin } from 'lucide-react';
import { useState, type FocusEvent, type RefCallback } from 'react';

import type { TodayItem } from '../../../shared/contracts/todayContract';
import { humanizeEnumLabel, titleCaseDisplayName } from '../../../shared/displayText';
import { IconButton } from '../../components/IconButton';
import { StatusPill } from '../../components/StatusPill';
import { reasonLineFor } from './rowText';

export type TodayQueueRowProps = {
  item: TodayItem;
  busy: boolean;
  /** Roving tabindex: exactly one row in the queue is tab-reachable. */
  tabbable: boolean;
  rowRef: RefCallback<HTMLLIElement>;
  /** Lane-local row above, or null when this row is already first. */
  pinComparedSalesCycleId: string | null;
  /** Lane-local row below, or null when this row is already last. */
  snoozeComparedSalesCycleId: string | null;
  onOpenLead(personId: string): void;
  onComplete(item: TodayItem): void;
  onSnooze(item: TodayItem, comparedSalesCycleId: string): void;
  onPin(item: TodayItem, comparedSalesCycleId: string): void;
};

/**
 * One dense two-line queue row. Line 1: who (Title Case) plus a quiet stage
 * chip; line 2: the humanized reason with a relative due time. Done/Snooze/
 * Pin are icon commands revealed on hover and focus-within; E/H/P work while
 * the row holds focus (handled by the lane container). Pin and snooze stay
 * lane-local pairwise commands.
 */
export function TodayQueueRow({
  item,
  busy,
  tabbable,
  rowRef,
  pinComparedSalesCycleId,
  snoozeComparedSalesCycleId,
  onOpenLead,
  onComplete,
  onSnooze,
  onPin,
}: TodayQueueRowProps) {
  const [focusWithin, setFocusWithin] = useState(false);

  const handleBlur = (event: FocusEvent<HTMLLIElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setFocusWithin(false);
    }
  };

  return (
    <li
      ref={rowRef}
      className="today-row"
      tabIndex={tabbable ? 0 : -1}
      data-cycle-id={item.salesCycleId}
      data-focus-within={focusWithin ? 'true' : undefined}
      aria-label={titleCaseDisplayName(item.personName)}
      onFocus={() => setFocusWithin(true)}
      onBlur={handleBlur}
    >
      <div className="today-row__body">
        <div className="today-row__line1">
          <button
            type="button"
            className="today-row__person"
            tabIndex={-1}
            onClick={() => onOpenLead(item.personId)}
          >
            {titleCaseDisplayName(item.personName)}
          </button>
          {item.contextLabel !== null && (
            <span className="today-row__context">{item.contextLabel}</span>
          )}
          <span className="today-row__stage-chip">
            {humanizeEnumLabel(item.stage)}
          </span>
          {item.pinned && <StatusPill>Pinned</StatusPill>}
          {item.verifyFirst && <StatusPill tone="urgent">Verify first</StatusPill>}
        </div>
        <p className="today-row__reason">{reasonLineFor(item)}</p>
      </div>
      <div className="today-row__actions">
        <IconButton
          label="Complete · E"
          icon={Check}
          disabled={busy}
          onClick={() => onComplete(item)}
        />
        <IconButton
          label="Snooze · H"
          icon={Clock}
          disabled={busy || snoozeComparedSalesCycleId === null}
          onClick={() => {
            if (snoozeComparedSalesCycleId !== null) {
              onSnooze(item, snoozeComparedSalesCycleId);
            }
          }}
        />
        <IconButton
          label="Pin · P"
          icon={Pin}
          disabled={busy || pinComparedSalesCycleId === null}
          onClick={() => {
            if (pinComparedSalesCycleId !== null) {
              onPin(item, pinComparedSalesCycleId);
            }
          }}
        />
      </div>
    </li>
  );
}
