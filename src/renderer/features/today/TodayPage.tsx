import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { LogPastActivityRequest, TodayItem, TodaySnapshot } from '../../../shared/contracts/todayContract';
import { LogPastActivityDialog } from './LogPastActivityDialog';
import { TodayQueueRow } from './TodayQueueRow';
import './today.css';

export type TodayPageProps = {
  snapshot: TodaySnapshot; discovery?: ReactNode; busy?: boolean;
  selectedPersonId?: string | null;
  onOpenLead(personId: string): void; onCall(item: TodayItem): void;
  onSnoozeUntil(item: TodayItem, resurfaceAt: string): void; onSkipToday(item: TodayItem): void;
  onLogPastActivity(request: LogPastActivityRequest): Promise<void>; onOpenInLeads(item: TodayItem): void;
};
export const skipTodayResurfaceAt = (): string => {
  const date = new Date(); date.setDate(date.getDate() + 1); date.setHours(9, 0, 0, 0); return date.toISOString();
};
/** Display only: membership and order come from main, not a second queue policy. */
export function TodayPage({ snapshot, busy = false, selectedPersonId, onOpenLead, onCall, onSnoozeUntil, onSkipToday, onLogPastActivity, onOpenInLeads }: TodayPageProps) {
  const items = useMemo(() => snapshot.lanes.flatMap(lane => lane.items), [snapshot]);
  const [focused, setFocused] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [logItem, setLogItem] = useState<TodayItem | null>(null);
  const generation = useRef(0);
  const currentLogItem = useRef(logItem);
  currentLogItem.current = logItem;
  useEffect(() => () => { generation.current++; }, []);
  const refs = useRef(new Map<string, HTMLLIElement>());
  const tabbable = items.some(item => item.salesCycleId === focused) ? focused : items[0]?.salesCycleId;
  const open = (personId: string) => { setSelected(personId); onOpenLead(personId); };
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement;
    if (target.closest('input,textarea,select,[contenteditable="true"],[role="menu"],[role="dialog"],dialog')) return;
    const row = target.closest<HTMLElement>('[data-cycle-id]');
    const index = items.findIndex(item => item.salesCycleId === row?.dataset.cycleId);
    const item = items[index];
    if (!item) return;
    if (['j', 'J', 'ArrowDown', 'k', 'K', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      const next = items[index + (['j', 'J', 'ArrowDown'].includes(event.key) ? 1 : -1)];
      if (next) { setFocused(next.salesCycleId); refs.current.get(next.salesCycleId)?.focus(); }
    } else if (event.key === 'Enter' && target === row) { event.preventDefault(); open(item.personId); }
    else if (!busy && ['s', 'S'].includes(event.key)) { event.preventDefault(); onSnoozeUntil(item, skipTodayResurfaceAt()); }
    else if (!busy && ['x', 'X'].includes(event.key)) { event.preventDefault(); onSkipToday(item); }
  };
  return <div className="today today--compact" onKeyDown={keyboard} onFocusCapture={event => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-cycle-id]');
    if (row) setFocused(row.dataset.cycleId!);
  }}>
    <div className="today-work-heading"><h2>Contacts due</h2><span>{items.length}</span></div>
    {items.length === 0 ? <p>No contacts due right now.</p> : <ul className="today-work-list" aria-label="Work queue">
      {items.map(item => <TodayQueueRow key={item.salesCycleId} item={item} busy={busy} selected={item.personId === (selectedPersonId === undefined ? selected : selectedPersonId)}
        tabbable={tabbable === item.salesCycleId} rowRef={element => { if (element) refs.current.set(item.salesCycleId, element); else refs.current.delete(item.salesCycleId); }}
        onOpenLead={open} onCall={item => { setSelected(item.personId); onCall(item); }} onSnoozeUntil={onSnoozeUntil} onSkipToday={onSkipToday}
        onLogPastActivity={item => { generation.current++; setLogItem(item); }} onOpenInLeads={onOpenInLeads} />)}
    </ul>}
    {snapshot.lanes.some(lane => lane.overflowCount > 0) && <p>Additional work remains outside this queue’s capacity.</p>}
    {logItem !== null && <LogPastActivityDialog item={logItem} busy={busy} onClose={() => { generation.current++; setLogItem(null); }}
      onSubmit={request => {
        const current = generation.current;
        return onLogPastActivity(request).then(() => {
          if (current === generation.current && currentLogItem.current === logItem) setLogItem(null);
        });
      }} />}
  </div>;
}
