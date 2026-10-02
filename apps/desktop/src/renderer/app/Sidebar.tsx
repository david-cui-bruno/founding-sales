import { ChevronRight, Settings as SettingsIcon } from 'lucide-react';
import type { JSX, ReactNode } from 'react';
import { NAV_ROWS, RESTART_TO_UPDATE, SETTINGS_ROW, type HomeView, type NavRow, type StatusRow } from '../homeView.ts';
import { sidebarRowOf, type Route, type RouteName } from '../routes.ts';
import { Button } from '../ui/button.tsx';
import { cn } from '../lib/utils.ts';

/**
 * The sidebar, on every route (1.0.12).
 *
 * Mockup A2's shape, unchanged: the workspace mark, the views with their keys, the
 * system's status as a dot and a sentence, and "This Mac". What moved is Settings —
 * Administration and the Dashboard were rows five and six, and are now one entry at the
 * foot with a gear and ⌘,, opening the view that holds both as tabs.
 *
 * It decides nothing. `buildHomeView` says what the status rows are and whether a row
 * carries the Restart control; this file draws that.
 */

const TONE_DOT: Readonly<Record<StatusRow['tone'], string>> = Object.freeze({
  ok: 'bg-[var(--status-ok)]',
  warn: 'bg-[var(--status-warn)]',
  stop: 'bg-destructive',
  none: 'bg-border',
});

function NavButton({
  row,
  current,
  icon,
  onOpen,
}: {
  readonly row: NavRow;
  readonly current: RouteName;
  readonly icon?: ReactNode;
  readonly onOpen: () => void;
}): JSX.Element {
  const selected = row.route === current;
  return (
    <button
      type="button"
      data-testid={`nav-${row.route}`}
      {...(selected ? { 'aria-current': 'page' as const } : {})}
      onClick={onOpen}
      className={cn(
        'group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors',
        selected ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
      )}
    >
      {icon}
      <span className="flex-1 truncate">{row.label}</span>
      <kbd className="font-sans text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
        {row.keys}
      </kbd>
    </button>
  );
}

export function Sidebar({
  view,
  route,
  thisMac,
  thisMacOpen,
  onToggleThisMac,
  onNavigate,
  onRestartToUpdate,
}: {
  readonly view: HomeView;
  readonly route: Route;
  /** The device details, the Mailbox row and Sign out; `App` builds it. */
  readonly thisMac: ReactNode;
  readonly thisMacOpen: boolean;
  onToggleThisMac(open: boolean): void;
  onNavigate(next: Route): void;
  onRestartToUpdate(): void;
}): JSX.Element {
  const current = sidebarRowOf(route);
  const updateRows = view.status.filter(row => row.key === 'update');
  return (
    <aside
      data-region="sidebar"
      data-testid="sidebar"
      className="callie-v2 flex h-screen flex-col gap-1 overflow-y-auto border-r border-border bg-sidebar px-2 py-3 text-sm"
    >
      <div className="mb-2 flex items-center gap-2 px-2">
        <span className="grid size-5 place-items-center rounded bg-primary text-[11px] font-semibold text-primary-foreground">
          C
        </span>
        <span className="font-medium">Callie</span>
      </div>

      <nav data-testid="nav" className="flex flex-col gap-px">
        {NAV_ROWS.map(row => (
          <NavButton
            key={row.route}
            row={row}
            current={current}
            onOpen={() => {
              onNavigate(row.route === 'settings' ? { name: 'settings', tab: 'administration' } : { name: row.route });
            }}
          />
        ))}
      </nav>

      {/* Routine status — the mailbox, the number, sending, the version and whether it is
          online — lives in Settings › Status since slice 3a (C0). What stays here is the one
          row with a control: an update that is installing or ready to restart. */}
      {updateRows.length === 0 ? null : (
        <p className="mt-5 px-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Update</p>
      )}
      <ul data-testid="status" className="flex flex-col gap-px empty:hidden">
        {updateRows.map(row => (
          <li
            key={row.key}
            data-testid={`status-${row.key}`}
            data-tone={row.tone}
            className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground"
          >
            <span className={cn('size-[7px] shrink-0 rounded-full', TONE_DOT[row.tone])} />
            <span className="flex-1 leading-snug">{row.text}</span>
            {row.action === 'restart_to_update' ? (
              <Button variant="link" size="sm" data-testid="update-restart" className="h-auto px-0" onClick={onRestartToUpdate}>
                {RESTART_TO_UPDATE}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>

      <div className="flex-1" />

      <nav className="flex flex-col gap-px">
        <NavButton
          row={SETTINGS_ROW}
          current={current}
          icon={<SettingsIcon aria-hidden className="size-3.5" />}
          onOpen={() => {
            onNavigate({ name: 'settings', tab: 'administration' });
          }}
        />
      </nav>

      <details
        data-testid="this-mac"
        open={thisMacOpen}
        onToggle={event => {
          onToggleThisMac(event.currentTarget.open);
        }}
        className="group mt-1 rounded-md px-2 py-1 text-xs text-muted-foreground"
      >
        <summary
          data-testid="this-mac-summary"
          className="flex cursor-default list-none items-center gap-1.5 rounded py-0.5 hover:text-foreground [&::-webkit-details-marker]:hidden"
        >
          <ChevronRight aria-hidden className="size-3 transition-transform group-open:rotate-90" />
          This Mac
        </summary>
        {thisMac}
      </details>
    </aside>
  );
}
