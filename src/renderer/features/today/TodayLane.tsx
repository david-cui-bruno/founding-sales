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
      description: 'Inbound replies still inside their SLA.',
    },
    overdue: {
      heading: 'Overdue',
      description: 'Promised work past its due time.',
    },
    post_interview_offer: {
      heading: 'Post-interview & offers',
      description: 'Follow-ups promised after interviews and offers.',
    },
    due_cadence: {
      heading: 'Due cadence',
      description: 'Non-discretionary work due today.',
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
      description: 'Deferred work; nothing here is due today.',
    },
  });

/** The fixed lane render order. Only the main-process snapshot fills it. */
export const TODAY_LANE_ORDER: readonly TodayLaneId[] = Object.freeze([
  'onboarding',
  'fresh_inbound',
  'overdue',
  'post_interview_offer',
  'due_cadence',
  'new_p0',
  'p1',
  'exploration',
  'later',
]);

export type TodayLaneProps = {
  laneId: TodayLaneId;
  items: readonly TodayItem[];
  busy: boolean;
  onOpenLead(personId: string): void;
  onComplete(item: TodayItem): void;
  onSnooze(item: TodayItem, comparedSalesCycleId: string): void;
  onPin(item: TodayItem, comparedSalesCycleId: string): void;
};

/**
 * One fixed lane. Rows render exactly in snapshot order; pin compares only
 * against the lane-local row above and snooze against the row below, so a
 * pin or snooze can never move a row across lanes.
 */
export function TodayLane({
  laneId,
  items,
  busy,
  onOpenLead,
  onComplete,
  onSnooze,
  onPin,
}: TodayLaneProps) {
  const meta = TODAY_LANE_META[laneId];
  const headingId = `today-lane-${laneId}`;

  return (
    <section className="today-lane" aria-labelledby={headingId}>
      <header className="today-lane__header">
        <h2 className="today-lane__heading" id={headingId}>
          {meta.heading}
        </h2>
        <span className="today-lane__count">{items.length}</span>
      </header>
      {items.length === 0 ? (
        <p className="today-lane__empty">{meta.description}</p>
      ) : (
        <ul className="today-lane__list">
          {items.map((item, index) => (
            <TodayQueueRow
              key={item.id}
              item={item}
              busy={busy}
              pinComparedSalesCycleId={
                index > 0 ? items[index - 1]!.salesCycleId : null
              }
              snoozeComparedSalesCycleId={
                index < items.length - 1 ? items[index + 1]!.salesCycleId : null
              }
              onOpenLead={onOpenLead}
              onComplete={onComplete}
              onSnooze={onSnooze}
              onPin={onPin}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
