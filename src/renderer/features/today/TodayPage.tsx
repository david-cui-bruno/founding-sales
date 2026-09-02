import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  RefCallback,
} from 'react';

import type {
  TodayItem,
  TodayLaneId,
  TodaySnapshot,
} from '../../../shared/contracts/todayContract';
import { CapacitySummary } from './CapacitySummary';
import { TodayHeroCard } from './TodayHeroCard';
import { TODAY_LANE_ORDER, TodayLane, type TodayLaneRow } from './TodayLane';
import { UnreviewedBacklogBand } from './UnreviewedBacklogBand';

import './today.css';

export type TodayPageProps = {
  snapshot: TodaySnapshot;
  busy?: boolean;
  onOpenLead(personId: string): void;
  onComplete(item: TodayItem): void;
  onSnooze(item: TodayItem): void;
  onPin(item: TodayItem, comparedSalesCycleId: string): void;
  onReviewBacklog(): void;
};

type LaneComputed = {
  laneId: TodayLaneId;
  totalCount: number;
  rows: TodayLaneRow[];
};

type RowCommand = {
  item: TodayItem;
  pinComparedSalesCycleId: string | null;
};

const laneRowSpecs = (items: readonly TodayItem[]): TodayLaneRow[] =>
  items.map((item, index) => ({
    item,
    pinComparedSalesCycleId: index > 0 ? items[index - 1]!.salesCycleId : null,
  }));

/**
 * The promise-first Today queue. Lanes render in one fixed order and rows
 * render exactly as the main-process snapshot ordered them; the renderer
 * never re-sorts, re-buckets, or suppresses promised work. The first item
 * of the first non-empty lane is promoted into the "Next up" hero. J/K and
 * the arrow keys move a roving focus through hero+rows; Enter opens the
 * inspector; E/H/P run Done/Snooze/Pin on the focused row.
 */
export function TodayPage({
  snapshot,
  busy = false,
  onOpenLead,
  onComplete,
  onSnooze,
  onPin,
  onReviewBacklog,
}: TodayPageProps) {
  const laneItems = useMemo(
    () =>
      new Map<TodayLaneId, readonly TodayItem[]>(
        snapshot.lanes.map((lane) => [lane.id, lane.items]),
      ),
    [snapshot],
  );

  const { heroRow, lanes, focusOrder, commandByCycleId } = useMemo(() => {
    const orderedLanes: LaneComputed[] = TODAY_LANE_ORDER.map((laneId) => {
      const items = laneItems.get(laneId) ?? [];
      return { laneId, totalCount: items.length, rows: laneRowSpecs(items) };
    });
    const firstLaneWithRows = orderedLanes.find((lane) => lane.rows.length > 0);
    const hero = firstLaneWithRows === undefined
      ? null
      : firstLaneWithRows.rows[0]!;
    if (firstLaneWithRows !== undefined) {
      firstLaneWithRows.rows = firstLaneWithRows.rows.slice(1);
    }
    const order: string[] = [];
    const commands = new Map<string, RowCommand>();
    if (hero !== null) {
      order.push(hero.item.salesCycleId);
      commands.set(hero.item.salesCycleId, hero);
    }
    for (const lane of orderedLanes) {
      for (const row of lane.rows) {
        order.push(row.item.salesCycleId);
        commands.set(row.item.salesCycleId, row);
      }
    }
    return {
      heroRow: hero,
      lanes: orderedLanes,
      focusOrder: order,
      commandByCycleId: commands,
    };
  }, [laneItems]);

  const rowElements = useRef(new Map<string, HTMLElement>());
  const [focusedCycleId, setFocusedCycleId] = useState<string | null>(null);

  const tabbableCycleId =
    focusedCycleId !== null && commandByCycleId.has(focusedCycleId)
      ? focusedCycleId
      : focusOrder[0] ?? null;

  // Drop focus memory for rows that left the snapshot.
  useEffect(() => {
    if (focusedCycleId !== null && !commandByCycleId.has(focusedCycleId)) {
      setFocusedCycleId(null);
    }
  }, [commandByCycleId, focusedCycleId]);

  const registerRow = useCallback(
    (cycleId: string): RefCallback<HTMLElement> =>
      (element) => {
        if (element === null) {
          rowElements.current.delete(cycleId);
        } else {
          rowElements.current.set(cycleId, element);
        }
      },
    [],
  );

  const moveFocus = useCallback(
    (fromCycleId: string, delta: 1 | -1) => {
      const index = focusOrder.indexOf(fromCycleId);
      if (index === -1) return;
      const next = focusOrder[index + delta];
      if (next === undefined) return;
      setFocusedCycleId(next);
      rowElements.current.get(next)?.focus();
    },
    [focusOrder],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      const rowElement = target.closest<HTMLElement>('[data-cycle-id]');
      if (rowElement === null) return;
      const cycleId = rowElement.dataset.cycleId!;
      const command = commandByCycleId.get(cycleId);
      if (command === undefined) return;

      switch (event.key) {
        case 'j':
        case 'J':
        case 'ArrowDown':
          event.preventDefault();
          moveFocus(cycleId, 1);
          return;
        case 'k':
        case 'K':
        case 'ArrowUp':
          event.preventDefault();
          moveFocus(cycleId, -1);
          return;
        case 'Enter':
          // Only when the row itself is focused; buttons keep native Enter.
          if (target === rowElement) {
            event.preventDefault();
            onOpenLead(command.item.personId);
          }
          return;
        case 'e':
        case 'E':
          event.preventDefault();
          if (!busy) onComplete(command.item);
          return;
        case 'h':
        case 'H':
          event.preventDefault();
          if (!busy) {
            onSnooze(command.item);
          }
          return;
        case 'p':
        case 'P':
          event.preventDefault();
          if (!busy && command.pinComparedSalesCycleId !== null) {
            onPin(command.item, command.pinComparedSalesCycleId);
          }
          return;
        default:
      }
    },
    [busy, commandByCycleId, moveFocus, onComplete, onOpenLead, onPin, onSnooze],
  );

  const handleFocusCapture = useCallback(
    (event: ReactFocusEvent<HTMLDivElement>) => {
      const rowElement = (event.target as HTMLElement)
        .closest<HTMLElement>('[data-cycle-id]');
      if (rowElement !== null) {
        setFocusedCycleId(rowElement.dataset.cycleId!);
      }
    },
    [],
  );

  return (
    <div
      className="today"
      onKeyDown={handleKeyDown}
      onFocusCapture={handleFocusCapture}
    >
      <CapacitySummary snapshot={snapshot} />
      <UnreviewedBacklogBand
        count={snapshot.unreviewedBacklogCount}
        onReviewInLeads={onReviewBacklog}
      />
      {heroRow !== null && (
        <TodayHeroCard
          item={heroRow.item}
          busy={busy}
          tabbable={heroRow.item.salesCycleId === tabbableCycleId}
          rowRef={registerRow(heroRow.item.salesCycleId)}
          onOpenLead={onOpenLead}
          onComplete={onComplete}
        />
      )}
      <div className="today__lanes">
        {lanes.map((lane) => (
          <TodayLane
            key={lane.laneId}
            laneId={lane.laneId}
            totalCount={lane.totalCount}
            rows={lane.rows}
            busy={busy}
            tabbableCycleId={tabbableCycleId}
            registerRow={registerRow}
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
