import type {
  TodayItem,
  TodayLaneId,
  TodaySnapshot,
} from '../../../shared/contracts/todayContract';
import { CapacitySummary } from './CapacitySummary';
import { TODAY_LANE_ORDER, TodayLane } from './TodayLane';

export type TodayPageProps = {
  snapshot: TodaySnapshot;
  busy?: boolean;
  onOpenLead(personId: string): void;
  onComplete(item: TodayItem): void;
  onSnooze(item: TodayItem, comparedSalesCycleId: string): void;
  onPin(item: TodayItem, comparedSalesCycleId: string): void;
};

/**
 * The promise-first Today queue. Lanes render in one fixed order and rows
 * render exactly as the main-process snapshot ordered them; the renderer
 * never re-sorts, re-buckets, or suppresses promised work.
 */
export function TodayPage({
  snapshot,
  busy = false,
  onOpenLead,
  onComplete,
  onSnooze,
  onPin,
}: TodayPageProps) {
  const laneItems = new Map<TodayLaneId, readonly TodayItem[]>(
    snapshot.lanes.map((lane) => [lane.id, lane.items]),
  );

  return (
    <div className="today">
      <CapacitySummary snapshot={snapshot} />
      <div className="today__lanes">
        {TODAY_LANE_ORDER.map((laneId) => (
          <TodayLane
            key={laneId}
            laneId={laneId}
            items={laneItems.get(laneId) ?? []}
            busy={busy}
            onOpenLead={onOpenLead}
            onComplete={onComplete}
            onSnooze={onSnooze}
            onPin={onPin}
          />
        ))}
      </div>
    </div>
  );
}
