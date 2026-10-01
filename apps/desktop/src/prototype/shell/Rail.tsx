import { Building2, Inbox, KanbanSquare, ListChecks, Search, Settings, Sun } from 'lucide-react';
import type { JSX, ReactNode } from 'react';
import { cn } from '../../renderer/lib/utils.ts';
import { Kbd } from '../parts.tsx';
import type { View } from '../state.ts';

/**
 * The workspace rail. 220px with labels from 1600px wide; a 52px icon rail below, where
 * every icon keeps its name as a tooltip and an accessible label.
 */

interface Item {
  readonly id: View | 'replies' | 'review' | 'firms';
  readonly label: string;
  readonly icon: ReactNode;
  readonly count?: number;
  readonly keys?: string;
}

const ITEMS: readonly Item[] = [
  { id: 'today', label: 'Today', icon: <Sun />, count: 5, keys: '⌘1' },
  { id: 'pipeline', label: 'Pipeline', icon: <KanbanSquare />, keys: '⌘2' },
  { id: 'firms', label: 'Firms', icon: <Building2 /> },
  { id: 'replies', label: 'Replies', icon: <Inbox />, count: 1 },
  { id: 'review', label: 'Needs review', icon: <ListChecks />, count: 1 },
];

export function Rail({ view, onView, onSearch }: { readonly view: View; onView(view: View): void; onSearch(): void }): JSX.Element {
  const current = view === 'firm' ? 'firms' : view;
  return (
    <aside
      data-region="rail"
      className="flex w-[52px] shrink-0 flex-col border-r border-border bg-sidebar min-[1600px]:w-[220px]"
    >
      <div className="flex h-12 items-center gap-2 px-3.5 min-[1600px]:px-4">
        <span className="flex size-6 items-center justify-center rounded-md bg-foreground text-xs font-semibold text-background">C</span>
        <span className="hidden text-sm font-semibold tracking-tight min-[1600px]:inline">Callie</span>
      </div>
      <div className="px-2 pb-2">
        <button
          type="button"
          onClick={onSearch}
          aria-label="Search firms"
          title="Search firms (/)"
          className="flex h-7 w-full items-center justify-center gap-2 rounded-md text-sm text-muted-foreground transition-colors hover:bg-pressed min-[1600px]:justify-start min-[1600px]:border min-[1600px]:border-border min-[1600px]:bg-background min-[1600px]:px-2"
        >
          <Search className="size-3.5 shrink-0" />
          <span className="hidden flex-1 text-left min-[1600px]:inline">Search</span>
          <Kbd className="hidden min-[1600px]:inline-flex">/</Kbd>
        </button>
      </div>
      <nav className="flex flex-col gap-px px-2" aria-label="Views">
        {ITEMS.map(item => {
          const selected = item.id === current;
          const target: View | null = item.id === 'today' || item.id === 'pipeline' ? item.id : item.id === 'firms' ? 'firm' : null;
          return (
            <button
              key={item.id}
              type="button"
              title={item.label}
              aria-label={item.label}
              {...(selected ? { 'aria-current': 'page' as const } : {})}
              onClick={() => {
                if (target !== null) onView(target);
              }}
              className={cn(
                'group relative flex h-7 items-center justify-center gap-2 rounded-md text-sm transition-colors min-[1600px]:justify-start min-[1600px]:px-2',
                '[&_svg]:size-4 [&_svg]:shrink-0',
                selected ? 'bg-pressed font-medium text-foreground' : 'text-muted-foreground hover:bg-pressed hover:text-foreground',
              )}
            >
              {item.icon}
              <span className="hidden flex-1 truncate text-left min-[1600px]:inline">{item.label}</span>
              {item.count === undefined ? null : (
                <>
                  <span className="hidden text-xs text-faint tabular min-[1600px]:inline">{item.count}</span>
                  <span className="absolute top-1 right-1.5 size-1.5 rounded-full bg-link min-[1600px]:hidden" aria-hidden />
                </>
              )}
            </button>
          );
        })}
      </nav>
      <div className="mt-auto flex flex-col gap-2 border-t border-border p-2">
        <div className="hidden items-center gap-2 px-2 text-xs text-muted-foreground min-[1600px]:flex">
          <span className="size-1.5 rounded-full bg-ok" aria-hidden />
          Calling ready · sending paused
        </div>
        <button
          type="button"
          aria-label="Settings"
          title="Settings"
          className="flex h-7 items-center justify-center gap-2 rounded-md text-sm text-muted-foreground hover:bg-pressed hover:text-foreground min-[1600px]:justify-start min-[1600px]:px-2 [&_svg]:size-4"
        >
          <Settings />
          <span className="hidden min-[1600px]:inline">Settings</span>
        </button>
      </div>
    </aside>
  );
}
