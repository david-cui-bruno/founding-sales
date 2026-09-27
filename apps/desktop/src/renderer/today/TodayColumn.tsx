import type { JSX } from 'react';
import { navigate, type Route } from '../routes.ts';
import { UNAVAILABLE, type HomeView, type NeedsRow } from '../homeView.ts';
import type { TodayState } from '../todayContract.ts';
import { refreshFailed, updatedLine, type TodayScreenView } from '../todayView.ts';
import { Alert } from '../ui/alert.tsx';
import { Button } from '../ui/button.tsx';
import { Lanes } from './Lanes.tsx';
import type { TaskActions } from './TaskRow.tsx';

/**
 * Today, the view the window opens on (lane g65; specification 8.2, 13.4, 14.2).
 *
 * Mockup A2's shape: the business date, a line of counts, the four lanes in the server's
 * order, the last seven days in four figures, and what needs the person — dividers rather
 * than cards, grey section headers with a small count, colour only as a dot or a small
 * tag, and actions that appear on hover.
 *
 * It decides nothing. `buildHomeView` says what to show and `buildTodayView` says what
 * may be pressed; this file draws that answer.
 */

function UpdatedLine({
  state,
  now,
  refreshAnswered,
  onRefresh,
}: {
  readonly state: TodayState;
  readonly now: number;
  readonly refreshAnswered: boolean;
  onRefresh(): void;
}): JSX.Element {
  const failed = refreshAnswered && refreshFailed(state);
  return (
    <p data-testid="today-updated" className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span data-testid="today-updated-text">{updatedLine(state.asOf, now) ?? ''}</span>
      {failed ? (
        <>
          {/* Why it failed is the offline or stale line above the lanes, which the
              column already shows; this says once that it did, beside Retry. */}
          <span data-testid="today-refresh-failed">{state.asOf === null ? 'Could not refresh.' : ' · Could not refresh.'}</span>
          <Button variant="quiet" size="sm" data-testid="today-retry" onClick={onRefresh}>
            Retry
          </Button>
        </>
      ) : null}
    </p>
  );
}

function Need({ need, onConnectMailbox }: { readonly need: NeedsRow; onConnectMailbox(): void }): JSX.Element {
  const action = need.action;
  return (
    <li data-testid="needs-row" data-need={need.key} className="group/need flex items-center gap-3 border-b border-border py-1.5 last:border-b-0">
      <span className="flex min-w-0 flex-1 flex-col">
        <span data-testid="needs-label" className="truncate text-sm">
          {need.label}
        </span>
        {need.detail === null ? null : (
          <span data-testid="needs-detail" className="truncate text-xs text-muted-foreground">
            {need.detail}
          </span>
        )}
      </span>
      {action.kind === 'connect_mailbox' ? (
        <Button size="sm" data-testid="needs-connect" disabled={!action.enabled} onClick={onConnectMailbox}>
          {action.label}
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          data-testid="needs-open"
          onClick={() => {
            navigate(action.route as Route);
          }}
        >
          {action.label}
        </Button>
      )}
    </li>
  );
}

export function TodayColumn({
  home,
  today,
  todayView,
  pending,
  refreshAnswered,
  now,
  hasTodayBridge,
  actions,
  onRefresh,
  onConnectMailbox,
}: {
  readonly home: HomeView;
  readonly today: TodayState | null;
  readonly todayView: TodayScreenView | null;
  readonly pending: number;
  readonly refreshAnswered: boolean;
  readonly now: number;
  readonly hasTodayBridge: boolean;
  readonly actions: TaskActions | null;
  onRefresh(): void;
  onConnectMailbox(): void;
}): JSX.Element {
  return (
    <div data-testid="home" className="mx-auto flex w-full max-w-[860px] flex-col px-12 pt-10 pb-20">
      <header data-testid="column-head" className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-3">
          <h1 data-testid="heading" className="text-2xl font-semibold tracking-tight">
            {home.heading}
          </h1>
          <Button variant="quiet" size="sm" data-testid="refresh" onClick={onRefresh}>
            Refresh
          </Button>
        </div>
        <p data-testid="summary" className="text-sm text-muted-foreground empty:hidden">
          {home.summary ?? ''}
        </p>
        {today === null || !hasTodayBridge ? null : (
          <UpdatedLine state={today} now={now} refreshAnswered={refreshAnswered} onRefresh={onRefresh} />
        )}
      </header>

      <div data-testid="banners" className="mt-3 flex flex-col gap-2 empty:hidden">
        {home.notices.map(notice => (
          <Alert key={`${notice.tone}:${notice.text}`} tone={notice.tone} data-testid={`banner-${notice.tone}`}>
            {notice.text}
          </Alert>
        ))}
      </div>

      <div data-region="today" data-testid="today" aria-busy={pending > 0} className="mt-5">
        {home.lanes === null || !hasTodayBridge || actions === null ? (
          <p data-testid="today-unavailable" className="py-6 text-sm text-muted-foreground">
            {UNAVAILABLE}
          </p>
        ) : today === null || todayView === null ? (
          home.lanes.emptyLine === null ? null : (
            <p data-testid="today-empty" className="py-6 text-sm text-muted-foreground">
              {home.lanes.emptyLine}
            </p>
          )
        ) : (
          <Lanes state={today} view={todayView} content={home.lanes} actions={actions} />
        )}
      </div>

      <section data-testid="figures" className="mt-9">
        <h2 data-testid="figures-label" className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {home.figures.label}
        </h2>
        <div className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
          {home.figures.cells.map(cell => (
            <div key={cell.key} data-testid={`figure-${cell.key}`} className="flex flex-col gap-0.5">
              <div className="text-xs text-muted-foreground">{cell.label}</div>
              <div className="flex items-baseline gap-1.5">
                <span data-testid="figure-value" className="text-xl tabular-nums">
                  {cell.value}
                </span>
                {cell.note === null ? null : (
                  <small data-testid="figure-note" className="text-xs text-muted-foreground">
                    {cell.note}
                  </small>
                )}
              </div>
            </div>
          ))}
        </div>
        {home.figures.line === null ? null : (
          <p data-testid="figures-line" className="mt-2 text-xs text-muted-foreground">
            {home.figures.line}
          </p>
        )}
      </section>

      <section data-testid="needs" className="mt-9">
        <h2 className="mb-1 flex items-baseline gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          <span>Needs you</span>
          {home.needs.length > 0 ? (
            <small data-testid="needs-count" className="text-[11px] font-normal">
              {home.needs.length}
            </small>
          ) : null}
        </h2>
        {home.needsLine === null ? (
          <ul className="flex flex-col border-t border-border">
            {home.needs.map(need => (
              <Need key={need.key} need={need} onConnectMailbox={onConnectMailbox} />
            ))}
          </ul>
        ) : (
          <p data-testid="needs-empty" className="py-3 text-sm text-muted-foreground">
            {home.needsLine}
          </p>
        )}
      </section>
    </div>
  );
}
