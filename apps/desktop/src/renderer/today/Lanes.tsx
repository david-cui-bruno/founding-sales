import type { JSX } from 'react';
import { navigate } from '../routes.ts';
import type { LaneSection } from '../homeView.ts';
import type { TodayState } from '../todayContract.ts';
import type { CardView, TodayScreenView } from '../todayView.ts';
import { Button } from '../ui/button.tsx';
import { OutcomeForm } from './OutcomeForm.tsx';
import { TaskRow, type TaskActions } from './TaskRow.tsx';

/**
 * The Today lanes (specification 8.2, 8.3, 9.1, 14.2).
 *
 * One section per run of the server's order — a section starts wherever the lane of the
 * next card changes, so the sections are the snapshot's own runs and nothing here sorts
 * anything (8.2) — a row per firm, and the expanded firm's tasks, numbers and outcome
 * form under its own row.
 *
 * Every value reaches the page as a React child, so a firm name containing a tag is a
 * firm name. Rows keep their identity across a re-render by firm and by task, which is
 * why the 1.0.11 focus-loss bug cannot come back: nothing is torn down and rebuilt when
 * an answer arrives, so nothing steals focus from what somebody is typing into.
 */

export interface LanesContent {
  readonly sections: readonly LaneSection[];
  /** One grey line in place of the lanes, or null when there are cards. */
  readonly emptyLine: string | null;
}

function DialPanel({
  state,
  view,
  actions,
}: {
  readonly state: TodayState;
  readonly view: TodayScreenView;
  readonly actions: TaskActions;
}): JSX.Element {
  const firmId = state.expanded?.firmId ?? '';
  return (
    <div data-testid="dial-panel" className="mt-3 flex flex-col gap-2">
      {view.dialRoutes.map(entry => (
        <div key={entry.route.routeId} data-testid="dial-route" className="flex flex-wrap items-center gap-2">
          <Button
            data-testid="dial"
            disabled={!entry.enabled}
            onClick={() => {
              actions.apply(
                actions.bridge.dial({ firmId, contactId: entry.route.contactId, routeId: entry.route.routeId }),
              );
            }}
          >
            Call {entry.route.e164}
          </Button>
          {entry.advice?.firmLocalTime == null ? null : (
            <span className="text-xs text-muted-foreground">It is {entry.advice.firmLocalTime} there.</span>
          )}
          {entry.reasons.length === 0 ? null : (
            <ul data-testid="dial-reasons" className="flex flex-col gap-0.5 text-xs text-muted-foreground">
              {entry.reasons.map(reason => (
                <li key={reason} data-testid="dial-reason">
                  {reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      <p data-testid="dial-limitation" className="text-xs leading-relaxed text-muted-foreground">
        {state.handoffNotice}
      </p>
    </div>
  );
}

function ExpandedFirm({
  state,
  view,
  actions,
}: {
  readonly state: TodayState;
  readonly view: TodayScreenView;
  readonly actions: TaskActions;
}): JSX.Element | null {
  const expanded = state.expanded;
  if (expanded === null) return null;
  return (
    <section data-testid="today-firm" className="mt-2 mb-4 ml-1 border-l border-border pl-4">
      {/* The row above already names the firm; the heading is for a screen reader. */}
      <h3 data-testid="firm-name" className="sr-only">
        {expanded.firmName}
      </h3>
      <ul data-testid="today-tasks" className="flex flex-col">
        {view.tasks.map(entry => (
          <TaskRow key={entry.task.itemId} entry={entry} state={state} actionsEnabled={view.actionsEnabled} actions={actions} />
        ))}
      </ul>
      <DialPanel state={state} view={view} actions={actions} />
      <OutcomeForm state={state} view={view} enabled={view.actionsEnabled} actions={actions} />
    </section>
  );
}

function Card({
  entry,
  state,
  view,
  actions,
}: {
  readonly entry: CardView;
  readonly state: TodayState;
  readonly view: TodayScreenView;
  readonly actions: TaskActions;
}): JSX.Element {
  return (
    <li data-testid="today-card" className="group/row border-b border-border last:border-b-0">
      <div className="flex items-center gap-3 py-1.5">
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span data-testid="card-firm" className="truncate text-sm">
            {entry.card.firmName}
          </span>
          <span data-testid="card-counts" className="truncate text-xs text-muted-foreground">
            {entry.countsLabel}
          </span>
        </span>
        <span
          className={
            entry.expanded
              ? 'flex items-center gap-1'
              : 'flex items-center gap-1 opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100'
          }
        >
          {/* The firm's page, in the same window: the Firms view opens it through the CRM bridge. */}
          <Button
            variant="quiet"
            size="sm"
            data-testid="card-open-firm"
            onClick={() => {
              navigate({ name: 'firm', firmId: entry.card.firmId });
            }}
          >
            Firm page
          </Button>
          <Button
            variant="outline"
            size="sm"
            data-testid="card-expand"
            onClick={() => {
              actions.apply(entry.expanded ? actions.bridge.collapse() : actions.bridge.expand({ firmId: entry.card.firmId }));
            }}
          >
            {entry.expanded ? 'Close' : 'Open'}
          </Button>
        </span>
      </div>
      {entry.expanded ? <ExpandedFirm state={state} view={view} actions={actions} /> : null}
    </li>
  );
}

export function Lanes({
  state,
  view,
  content,
  actions,
}: {
  readonly state: TodayState;
  readonly view: TodayScreenView;
  readonly content: LanesContent;
  readonly actions: TaskActions;
}): JSX.Element {
  const expandedShown = content.sections.some(section => section.cards.some(card => card.expanded));
  return (
    <>
      <div data-testid="today-cards" className="flex flex-col">
        {content.sections.map((section, index) => (
          <section key={`${section.lane}:${String(index)}`} data-testid="lane" data-lane={section.lane} className="mt-5 first:mt-0">
            <h2 className="mb-1 flex items-baseline gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              <span data-testid="lane-label">{section.label}</span>
              <small data-testid="lane-count" className="text-[11px] font-normal">
                {section.cards.length}
              </small>
            </h2>
            <ul className="flex flex-col border-t border-border">
              {section.cards.map(entry => (
                <Card key={entry.card.firmId} entry={entry} state={state} view={view} actions={actions} />
              ))}
            </ul>
          </section>
        ))}
        {/* A firm expanded and then gone from the list at the next read keeps its tasks
            on screen until it is closed, as it did in G6's window. */}
        {expandedShown ? null : <ExpandedFirm state={state} view={view} actions={actions} />}
      </div>
      {content.emptyLine === null ? null : (
        <p data-testid="today-empty" className="py-6 text-sm text-muted-foreground">
          {content.emptyLine}
        </p>
      )}
    </>
  );
}
