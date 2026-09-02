import { MoreHorizontal } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import type { TodayItem } from '../../../shared/contracts/todayContract';

export type RowContextMenuProps = {
  item: TodayItem;
  busy: boolean;
  onCall(item: TodayItem): void;
  /** Founder-chosen date (a full ISO instant) written to resurface_at. */
  onSnoozeUntil(item: TodayItem, resurfaceAt: string): void;
  /** No dedicated skip surface exists: snooze until tomorrow, labeled honestly. */
  onSkipToday(item: TodayItem): void;
  onLogPastActivity(item: TodayItem): void;
  onOpenInLeads(item: TodayItem): void;
};

type MenuItemSpec = {
  id: string;
  label: string;
  run(): void;
};

const tomorrowLocalDate = (): string => {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/** 9am local on the chosen day, so the lead resurfaces at working time. */
const resurfaceInstantFor = (localDate: string): string =>
  new Date(`${localDate}T09:00:00`).toISOString();

/**
 * The row's "···" context menu (audit 4.4): a real popover on the overlay
 * elevation token with Call, Snooze until… (inline date input writing
 * resurface_at), Skip today, Log past activity, and Open in Leads. Arrow
 * keys move the active item; Escape closes and refocuses the trigger.
 */
export function RowContextMenu({
  item,
  busy,
  onCall,
  onSnoozeUntil,
  onSkipToday,
  onLogPastActivity,
  onOpenInLeads,
}: RowContextMenuProps) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'menu' | 'snooze'>('menu');
  const [activeIndex, setActiveIndex] = useState(0);
  const [snoozeDate, setSnoozeDate] = useState(tomorrowLocalDate);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef(new Map<number, HTMLButtonElement>());
  const dateRef = useRef<HTMLInputElement>(null);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setMode('menu');
    if (refocus) {
      triggerRef.current?.focus();
    }
  }, []);

  const items: MenuItemSpec[] = [
    { id: 'call', label: 'Call', run: () => { close(false); onCall(item); } },
    { id: 'snooze', label: 'Snooze until…', run: () => { setMode('snooze'); } },
    { id: 'skip', label: 'Skip today', run: () => { close(true); onSkipToday(item); } },
    {
      id: 'log',
      label: 'Log past activity',
      run: () => { close(false); onLogPastActivity(item); },
    },
    {
      id: 'leads',
      label: 'Open in Leads',
      run: () => { close(false); onOpenInLeads(item); },
    },
  ];

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (
        rootRef.current !== null &&
        event.target instanceof Node &&
        !rootRef.current.contains(event.target)
      ) {
        close(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  useEffect(() => {
    if (open && mode === 'menu') {
      itemRefs.current.get(activeIndex)?.focus();
    }
  }, [open, mode, activeIndex]);

  useEffect(() => {
    if (open && mode === 'snooze') {
      dateRef.current?.focus();
    }
  }, [open, mode]);

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Keep row-level shortcuts (J/K/S/X/Enter) out of the open menu.
    event.stopPropagation();
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        if (mode === 'snooze') {
          setMode('menu');
        } else {
          close(true);
        }
        return;
      case 'ArrowDown':
        if (mode === 'menu') {
          event.preventDefault();
          setActiveIndex((index) => Math.min(index + 1, items.length - 1));
        }
        return;
      case 'ArrowUp':
        if (mode === 'menu') {
          event.preventDefault();
          setActiveIndex((index) => Math.max(index - 1, 0));
        }
        return;
      default:
    }
  };

  const commitSnooze = () => {
    close(true);
    onSnoozeUntil(item, resurfaceInstantFor(snoozeDate));
  };

  return (
    <div
      ref={rootRef}
      className="today-row-menu"
      onKeyDown={open ? onMenuKeyDown : undefined}
    >
      <button
        ref={triggerRef}
        type="button"
        className="icon-button"
        aria-label={`More actions for ${item.personName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={busy}
        onClick={() => {
          setActiveIndex(0);
          setMode('menu');
          setOpen((value) => !value);
        }}
      >
        <MoreHorizontal aria-hidden="true" size={16} />
      </button>
      {open && mode === 'menu' && (
        <div
          id={menuId}
          role="menu"
          aria-label={`Actions for ${item.personName}`}
          className="today-row-menu__popover motion-menu-in"
        >
          {items.map((entry, index) => (
            <button
              key={entry.id}
              ref={(element) => {
                if (element === null) {
                  itemRefs.current.delete(index);
                } else {
                  itemRefs.current.set(index, element);
                }
              }}
              type="button"
              role="menuitem"
              className="today-row-menu__item"
              tabIndex={index === activeIndex ? 0 : -1}
              onPointerMove={() => setActiveIndex(index)}
              onClick={entry.run}
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}
      {open && mode === 'snooze' && (
        <div
          id={menuId}
          role="dialog"
          aria-label={`Snooze ${item.personName} until`}
          className="today-row-menu__popover motion-menu-in"
        >
          <label className="today-row-menu__date-label">
            Snooze until
            <input
              ref={dateRef}
              type="date"
              className="today-row-menu__date"
              value={snoozeDate}
              min={tomorrowLocalDate()}
              onChange={(event) => setSnoozeDate(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitSnooze();
                }
              }}
            />
          </label>
          <button
            type="button"
            className="today-row-menu__item today-row-menu__item--confirm"
            onClick={commitSnooze}
          >
            Snooze
          </button>
        </div>
      )}
    </div>
  );
}
