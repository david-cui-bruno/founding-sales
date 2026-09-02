import { Phone } from 'lucide-react';
import { useState, type FocusEvent, type RefCallback } from 'react';

import type { TodayItem } from '../../../shared/contracts/todayContract';
import { titleCaseDisplayName } from '../../../shared/displayText';
import { IconButton } from '../../components/IconButton';
import { formatCloudChip } from '../leads/cloudSignalLabels';
import { RowContextMenu } from './RowContextMenu';
import { reasonLineFor } from './rowText';

export type TodayQueueRowProps = {
  item: TodayItem;
  busy: boolean;
  /** Roving tabindex: exactly one row in the queue is tab-reachable. */
  tabbable: boolean;
  rowRef: RefCallback<HTMLLIElement>;
  onOpenLead(personId: string): void;
  onCall(item: TodayItem): void;
  onSnoozeUntil(item: TodayItem, resurfaceAt: string): void;
  onSkipToday(item: TodayItem): void;
  onLogPastActivity(item: TodayItem): void;
  onOpenInLeads(item: TodayItem): void;
};

/**
 * One dense two-line queue row (audit 4.4). Line 1: who (Title Case,
 * semibold) plus at most one cloud chip; line 2: the humanized reason.
 * Hover and keyboard focus reveal exactly two commands: Call and the "···"
 * context menu. Enter calls; S snoozes; X skips (handled by the page).
 */
export function TodayQueueRow({
  item,
  busy,
  tabbable,
  rowRef,
  onOpenLead,
  onCall,
  onSnoozeUntil,
  onSkipToday,
  onLogPastActivity,
  onOpenInLeads,
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
          {item.cloudScores !== null && (
            <span className="today-row__cloud-chip">
              {formatCloudChip(item.cloudScores)}
            </span>
          )}
        </div>
        <p className="today-row__reason">{reasonLineFor(item)}</p>
      </div>
      <div className="today-row__actions">
        <IconButton
          label={`Call ${titleCaseDisplayName(item.personName)}`}
          icon={Phone}
          disabled={busy}
          onClick={() => onCall(item)}
        />
        <RowContextMenu
          item={item}
          busy={busy}
          onCall={onCall}
          onSnoozeUntil={onSnoozeUntil}
          onSkipToday={onSkipToday}
          onLogPastActivity={onLogPastActivity}
          onOpenInLeads={onOpenInLeads}
        />
      </div>
    </li>
  );
}
