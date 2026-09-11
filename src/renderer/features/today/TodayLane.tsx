import { ChevronDown, ChevronRight } from 'lucide-react';
import type { KeyboardEvent as ReactKeyboardEvent, RefCallback } from 'react';

import type { TodayItem, TodayLaneId } from '../../../shared/contracts/todayContract';
import { TodayQueueRow } from './TodayQueueRow';

export type TodayLaneMeta = {
  heading: string;
  description: string;
};

/**
 * The one frozen source of lane headings and copy, in the fixed
 * promise-first order. Rendering never reorders or renames lanes.
 */
export const TODAY_LANE_META: Readonly<Record<TodayLaneId, TodayLaneMeta>> =
  Object.freeze({
    onboarding: {
      heading: 'Onboard now',
      description: 'Won customers waiting on onboarding.',
    },
    fresh_inbound: {
      heading: 'Fresh inbound',
      description: 'Inbound replies, newest commitments first.',
    },
    due_cadence: {
      heading: 'Due cadence',
      description: 'Relationships your cadence says are next.',
    },
    new_p0: {
      heading: 'New P0',
      description: 'Top-priority prospecting within capacity.',
    },
    p1: {
      heading: 'P1',
      description: 'High-priority prospecting within capacity.',
    },
    exploration: {
      heading: 'Exploration',
      description: 'Exploration slots for lower-priority prospects.',
    },
    later: {
      heading: 'Later',
      description: 'Deferred work beyond today\u2019s capacity.',
    },
  });

/** The fixed lane render order. Only the main-process snapshot fills it. */
export const TODAY_LANE_ORDER: readonly TodayLaneId[] = Object.freeze([
  'onboarding',
  'fresh_inbound',
  'due_cadence',
  'new_p0',
  'p1',
  'exploration',
  'later',
]);

export type TodayLaneProps = {
  laneId: TodayLaneId;
  /** True lane size from the snapshot, including a row promoted to Next up. */
  totalCount: number;
  /** Rows past the whole-queue cap, reported per lane by the snapshot. */
  overflowCount: number;
  /** Rows this lane renders itself (the hero row renders above the lanes). */
  rows: readonly TodayItem[];
  busy: boolean;
  collapsed: boolean;
  onToggleCollapsed(laneId: TodayLaneId, collapsed: boolean): void;
  tabbableCycleId: string | null;
  registerRow(cycleId: string): RefCallback<HTMLLIElement>;
  onOpenLead(personId: string): void;
  onCall(item: TodayItem): void;
  onSnoozeUntil(item: TodayItem, resurfaceAt: string): void;
  onSkipToday(item: TodayItem): void;
  onLogPastActivity(item: TodayItem): void;
  onOpenInLeads(item: TodayItem): void;
};

/**
 * One collapsible lane section (audit 4.4): an 11px/600 title with a count
 * and a chevron header button. ArrowLeft collapses and ArrowRight expands
 * while the header holds focus; rows render exactly in snapshot order.
 * Lanes with nothing to render return null; the page summarizes them in one
 * "Nothing in:" line instead.
 */
export function TodayLane({
  laneId,
  totalCount,
  overflowCount,
  rows,
  busy,
  collapsed,
  onToggleCollapsed,
  tabbableCycleId,
  registerRow,
  onOpenLead,
  onCall,
  onSnoozeUntil,
  onSkipToday,
  onLogPastActivity,
  onOpenInLeads,
}: TodayLaneProps) {
  const meta = TODAY_LANE_META[laneId];
  const headingId = `today-lane-${laneId}`;
  const listId = `today-lane-${laneId}-rows`;

  if (rows.length === 0 && totalCount === 0 && overflowCount === 0) {
    return null;
  }

  const onHeaderKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowLeft' && !collapsed) {
      event.preventDefault();
      event.stopPropagation();
      onToggleCollapsed(laneId, true);
    } else if (event.key === 'ArrowRight' && collapsed) {
      event.preventDefault();
      event.stopPropagation();
      onToggleCollapsed(laneId, false);
    }
  };

  const Chevron = collapsed ? ChevronRight : ChevronDown;

  return (
    <section className="today-lane" aria-labelledby={headingId}>
      <h2 className="today-lane__heading" id={headingId}>
        <button
          type="button"
          className="today-lane__header"
          aria-expanded={!collapsed}
          aria-controls={collapsed ? undefined : listId}
          onClick={() => onToggleCollapsed(laneId, !collapsed)}
          onKeyDown={onHeaderKeyDown}
        >
          <Chevron className="today-lane__chevron" size={14} aria-hidden="true" />
          <span className="today-lane__title">{meta.heading}</span>
          <span className="today-lane__count">{totalCount}</span>
        </button>
      </h2>
      {!collapsed && (
        <>
          <ul className="today-lane__list" id={listId}>
            {rows.map((item) => (
              <TodayQueueRow
                key={item.id}
                item={item}
                busy={busy}
                tabbable={item.salesCycleId === tabbableCycleId}
                rowRef={registerRow(item.salesCycleId)}
                onOpenLead={onOpenLead}
                onCall={onCall}
                onSnoozeUntil={onSnoozeUntil}
                onSkipToday={onSkipToday}
                onLogPastActivity={onLogPastActivity}
                onOpenInLeads={onOpenInLeads}
              />
            ))}
          </ul>
          {overflowCount > 0 && (
            <p className="today-lane__overflow">
              {`${overflowCount} more beyond today\u2019s capacity`}
            </p>
          )}
        </>
      )}
    </section>
  );
}
