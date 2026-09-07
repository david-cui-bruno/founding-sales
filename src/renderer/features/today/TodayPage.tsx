import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  RefCallback,
  ReactNode,
} from 'react';

import type {
  LogPastActivityRequest,
  TodayItem,
  TodayLaneId,
  TodaySnapshot,
} from '../../../shared/contracts/todayContract';
import { BacklogCard } from './BacklogCard';
import { LogPastActivityDialog } from './LogPastActivityDialog';
import { NextUpCard } from './NextUpCard';
import { TODAY_LANE_META, TODAY_LANE_ORDER, TodayLane } from './TodayLane';

import './today.css';

export type TodayPageProps = {
  snapshot: TodaySnapshot;
  discovery?: ReactNode;
  busy?: boolean;
  onOpenLead(personId: string): void;
  /** Logs the outbound call and promotes the lead to its full page. */
  onCall(item: TodayItem): void;
  onSnoozeUntil(item: TodayItem, resurfaceAt: string): void;
  onSkipToday(item: TodayItem): void;
  onLogPastActivity(request: LogPastActivityRequest): void;
  onOpenInLeads(item: TodayItem): void;
  /** Enters triage mode (backlog Review button and the R key). */
  onStartTriage(): void;
};

type LaneComputed = {
  laneId: TodayLaneId;
  totalCount: number;
  overflowCount: number;
  rows: TodayItem[];
};

/** Tomorrow 9am local: the shared instant for Skip today and default snooze. */
export const skipTodayResurfaceAt = (): string => {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return new Date(`${year}-${month}-${day}T09:00:00`).toISOString();
};

/**
 * The promise-first Today queue (audit Part 4). Lanes render in one fixed
 * order and rows render exactly as the main-process snapshot ordered them.
 * The first item of the first non-empty lane is pulled out as "Next up".
 * J/K and the arrow keys move a roving focus through the card and rows;
 * Enter calls, S snoozes to tomorrow, X skips today, R opens triage.
 */
export function TodayPage({
  snapshot,
  discovery,
  busy = false,
  onOpenLead,
  onCall,
  onSnoozeUntil,
  onSkipToday,
  onLogPastActivity,
  onOpenInLeads,
  onStartTriage,
}: TodayPageProps) {
  const [collapsedLanes, setCollapsedLanes] = useState<ReadonlySet<TodayLaneId>>(
    () => new Set<TodayLaneId>(),
  );
  const [manualOpen, setManualOpen] = useState(false);
  const [logItem, setLogItem] = useState<TodayItem | null>(null);

  const laneById = useMemo(
    () => new Map(snapshot.lanes.map((lane) => [lane.id, lane])),
    [snapshot],
  );

  const { nextUp, lanes, emptyLaneIds, focusOrder, itemByCycleId } = useMemo(() => {
    const ordered: LaneComputed[] = TODAY_LANE_ORDER.map((laneId) => {
      const lane = laneById.get(laneId);
      const items = lane === undefined ? [] : [...lane.items];
      return {
        laneId,
        totalCount: items.length,
        overflowCount: lane?.overflowCount ?? 0,
        rows: items,
      };
    });
    const firstWithRows = ordered.find((lane) => lane.rows.length > 0);
    const hero = firstWithRows?.rows[0] ?? null;
    if (firstWithRows !== undefined) {
      firstWithRows.rows = firstWithRows.rows.slice(1);
    }
    const empties = ordered
      .filter((lane) => lane.totalCount === 0 && lane.overflowCount === 0)
      .map((lane) => lane.laneId);
    const order: string[] = [];
    const byId = new Map<string, TodayItem>();
    if (hero !== null) {
      order.push(hero.salesCycleId);
      byId.set(hero.salesCycleId, hero);
    }
    for (const lane of ordered) {
      if (collapsedLanes.has(lane.laneId)) continue;
      for (const item of lane.rows) {
        order.push(item.salesCycleId);
        byId.set(item.salesCycleId, item);
      }
    }
    return {
      nextUp: hero,
      lanes: ordered,
      emptyLaneIds: empties,
      focusOrder: order,
      itemByCycleId: byId,
    };
  }, [laneById, collapsedLanes]);

  const rowElements = useRef(new Map<string, HTMLElement>());
  const [focusedCycleId, setFocusedCycleId] = useState<string | null>(null);

  const tabbableCycleId =
    focusedCycleId !== null && itemByCycleId.has(focusedCycleId)
      ? focusedCycleId
      : focusOrder[0] ?? null;

  // Drop focus memory for rows that left the snapshot.
  useEffect(() => {
    if (focusedCycleId !== null && !itemByCycleId.has(focusedCycleId)) {
      setFocusedCycleId(null);
    }
  }, [itemByCycleId, focusedCycleId]);

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

  const handleToggleCollapsed = useCallback(
    (laneId: TodayLaneId, collapsed: boolean) => {
      setCollapsedLanes((current) => {
        const next = new Set(current);
        if (collapsed) {
          next.add(laneId);
        } else {
          next.delete(laneId);
        }
        return next;
      });
    },
    [],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      const isEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement;
      if (!isEditable && (event.key === 'r' || event.key === 'R')) {
        if (snapshot.unreviewedBacklogCount > 0) {
          event.preventDefault();
          onStartTriage();
        }
        return;
      }
      const rowElement = target.closest<HTMLElement>('[data-cycle-id]');
      if (rowElement === null) return;
      const cycleId = rowElement.dataset.cycleId!;
      const item = itemByCycleId.get(cycleId);
      if (item === undefined) return;

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
          // Only when the row itself holds focus; buttons keep native Enter.
          if (target === rowElement) {
            event.preventDefault();
            if (!busy) onCall(item);
          }
          return;
        case 's':
        case 'S':
          event.preventDefault();
          if (!busy) onSnoozeUntil(item, skipTodayResurfaceAt());
          return;
        case 'x':
        case 'X':
          event.preventDefault();
          if (!busy) onSkipToday(item);
          return;
        default:
      }
    },
    [
      busy,
      itemByCycleId,
      moveFocus,
      onCall,
      onSkipToday,
      onSnoozeUntil,
      onStartTriage,
      snapshot.unreviewedBacklogCount,
    ],
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

  const queueEmpty = lanes.every(
    (lane) => lane.totalCount === 0 && lane.overflowCount === 0,
  );

  const handleLogPastActivity = useCallback(
    (request: LogPastActivityRequest) => {
      setLogItem(null);
      onLogPastActivity(request);
    },
    [onLogPastActivity],
  );

  return (
    <div
      className="today"
      onKeyDown={handleKeyDown}
      onFocusCapture={handleFocusCapture}
    >

      {queueEmpty && discovery !== undefined ? <p>No commitments due right now.</p> : queueEmpty ? (
        <section className="today-done" aria-label="Queue done">
          <p className="today-done__headline">
            {`Queue done · ${snapshot.scheduledDials} ${
              snapshot.scheduledDials === 1 ? 'dial' : 'dials'
            } · ${snapshot.conversationsHeld} ${
              snapshot.conversationsHeld === 1 ? 'conversation' : 'conversations'
            }`}
          </p>
          <p className="today-done__tomorrow">
            A fresh queue builds itself tomorrow morning.
          </p>
        </section>
      ) : (
        <>
          {nextUp !== null && (
            <NextUpCard
              item={nextUp}
              busy={busy}
              tabbable={nextUp.salesCycleId === tabbableCycleId}
              rowRef={registerRow(nextUp.salesCycleId)}
              onOpenLead={onOpenLead}
              onCall={onCall}
            />
          )}
          <div className="today__lanes">
            {lanes.map((lane) => (
              <TodayLane
                key={lane.laneId}
                laneId={lane.laneId}
                totalCount={lane.totalCount}
                overflowCount={lane.overflowCount}
                rows={lane.rows}
                busy={busy}
                collapsed={collapsedLanes.has(lane.laneId)}
                onToggleCollapsed={handleToggleCollapsed}
                tabbableCycleId={tabbableCycleId}
                registerRow={registerRow}
                onOpenLead={onOpenLead}
                onCall={onCall}
                onSnoozeUntil={onSnoozeUntil}
                onSkipToday={onSkipToday}
                onLogPastActivity={setLogItem}
                onOpenInLeads={onOpenInLeads}
              />
            ))}
          </div>
          {emptyLaneIds.length > 0 && (
            <p className="today__empty-lanes">
              {`Nothing in: ${emptyLaneIds
                .map((laneId) => TODAY_LANE_META[laneId].heading)
                .join(' · ')}`}
            </p>
          )}
        </>
      )}
      {discovery}
      {discovery === undefined ? <BacklogCard count={snapshot.unreviewedBacklogCount}
        cloudSignalCount={snapshot.unreviewedCloudSignalCount} onReview={onStartTriage} /> : (
        <section className="today__manual-review">
          <button type="button" aria-expanded={manualOpen} onClick={() => setManualOpen(value => !value)}>Manual review (optional)</button>
          {manualOpen && <>
          <p>Existing founder review controls. Prepared conversations do not require routine review.</p>
          <BacklogCard count={snapshot.unreviewedBacklogCount}
            cloudSignalCount={snapshot.unreviewedCloudSignalCount} onReview={onStartTriage} />
          </>}
        </section>
      )}
      {logItem !== null && (
        <LogPastActivityDialog
          item={logItem}
          busy={busy}
          onSubmit={handleLogPastActivity}
          onClose={() => setLogItem(null)}
        />
      )}
    </div>
  );
}
