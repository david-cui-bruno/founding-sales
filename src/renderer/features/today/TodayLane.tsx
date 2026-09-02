import type { RefCallback } from 'react';

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

/** One row plus its lane-local pin/snooze comparison neighbors. */
export type TodayLaneRow = {
  item: TodayItem;
  pinComparedSalesCycleId: string | null;
};

export type TodayLaneProps = {
  laneId: TodayLaneId;
  /** True lane size from the snapshot, including a row promoted to the hero. */
  totalCount: number;
  /** Rows this lane renders itself (the hero row is rendered above the lanes). */
  rows: readonly TodayLaneRow[];
  busy: boolean;
  tabbableCycleId: string | null;
  registerRow(cycleId: string): RefCallback<HTMLLIElement>;
  onOpenLead(personId: string): void;
  onComplete(item: TodayItem): void;
  onSnooze(item: TodayItem): void;
  onPin(item: TodayItem, comparedSalesCycleId: string): void;
};

/**
 * One fixed lane. Rows render exactly in snapshot order; pin compares only
 * against the lane-local row above and snooze against the row below, so a
 * pin or snooze can never move a row across lanes. A lane with nothing to
 * render collapses to one quiet line instead of an empty placeholder box.
 */
export function TodayLane({
  laneId,
  totalCount,
  rows,
  busy,
  tabbableCycleId,
  registerRow,
  onOpenLead,
  onComplete,
  onSnooze,
  onPin,
}: TodayLaneProps) {
  const meta = TODAY_LANE_META[laneId];
  const headingId = `today-lane-${laneId}`;

  if (rows.length === 0) {
    return (
      <section
        className="today-lane today-lane--collapsed"
        aria-labelledby={headingId}
      >
        <h2 className="today-lane__collapsed-line" id={headingId}>
          {`${meta.heading} — ${totalCount}`}
        </h2>
      </section>
    );
  }

  return (
    <section className="today-lane" aria-labelledby={headingId}>
      <header className="today-lane__header">
        <h2 className="today-lane__heading" id={headingId}>
          {meta.heading}
        </h2>
        <span className="today-lane__count">{totalCount}</span>
      </header>
      <ul className="today-lane__list">
        {rows.map((row) => (
          <TodayQueueRow
            key={row.item.id}
            item={row.item}
            busy={busy}
            tabbable={row.item.salesCycleId === tabbableCycleId}
            rowRef={registerRow(row.item.salesCycleId)}
            pinComparedSalesCycleId={row.pinComparedSalesCycleId}
            onOpenLead={onOpenLead}
            onComplete={onComplete}
            onSnooze={onSnooze}
            onPin={onPin}
          />
        ))}
      </ul>
    </section>
  );
}
