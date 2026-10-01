import { useEffect, useRef, type JSX } from 'react';
import { navigate } from '../routes.ts';
import type { LaneSection } from '../homeView.ts';
import type { TodayState } from '../todayContract.ts';
import type { CardView, TodayScreenView } from '../todayView.ts';
import { Button } from '../ui/button.tsx';
import { Brief, CallAnnouncement } from '../research/Brief.tsx';
import { OutcomeForm } from './OutcomeForm.tsx';
import { TaskRow } from './TaskRow.tsx';
import { todayForm, type TodayActions } from './useToday.ts';
import { CallView } from '../calling/CallView.tsx';
import { LatestCallSummary } from '../calling/LatestCallSummary.tsx';
import { attemptLabel } from '../calling/callText.ts';
import { registryCallPorts, useCall, type CallControl } from '../calling/useCall.ts';
import { useCallingStatus, type CallingStatus } from '../calling/useCallingStatus.ts';

/**
 * Calling from Callie on this card (slice C1): the firm's calling status and the call.
 * Absent, or with any provider but `twilio`, the panel is the `tel:` handoff exactly as it
 * has always been.
 */
export interface DialCalling {
  readonly status: CallingStatus;
  readonly call: CallControl;
  /** After "Resume calling": read the card again, its dial advice with it. */
  readonly onResumed?: () => void;
}

/** While the Mac asks how this firm's calls are placed, and when it could not find out. */
export const CALLING_CHECKING_SENTENCE = 'Checking how to place calls…';
export const CALLING_UNAVAILABLE_SENTENCE = 'Calling is unavailable right now.';

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

interface LanesContent {
  readonly sections: readonly LaneSection[];
  /** One grey line in place of the lanes, or null when there are cards. */
  readonly emptyLine: string | null;
}

export function DialPanel({
  state,
  view,
  actions,
  calling,
}: {
  readonly state: TodayState;
  readonly view: TodayScreenView;
  readonly actions: TodayActions;
  readonly calling?: DialCalling | undefined;
}): JSX.Element {
  const firmId = state.expanded?.firmId ?? '';
  if (calling?.status.view?.provider === 'twilio') {
    return <InAppDialPanel firmId={firmId} view={view} calling={calling} cadence={calling.status.view.cadence} />;
  }
  // Only the server's "calling is off" selects the phone app. Until it has answered, or
  // when it could not, Call waits: an untracked phone-app call would bypass the session,
  // the cadence and the budget (review of C1, fold 1, finding 1).
  if (calling !== undefined && calling.status.view?.provider !== 'tel') {
    return <WaitingDialPanel view={view} status={calling.status} />;
  }
  return (
    <div data-testid="dial-panel" className="mt-3 flex flex-col gap-2">
      {/* First, before the buttons: what is said the moment they answer. Somebody who
          pressed Call from here has the sentence in front of them and has not had to
          keep the brief above in view (29 September 2026). */}
      <CallAnnouncement />
      {view.dialRoutes.map(entry => (
        <div key={entry.route.routeId} data-testid="dial-route" className="flex flex-wrap items-center gap-2">
          <Button
            data-testid="dial"
            disabled={!entry.enabled || actions.busy(todayForm.dial(entry.route.routeId))}
            {...(actions.busy(todayForm.dial(entry.route.routeId)) ? { 'aria-busy': true } : {})}
            onClick={() => {
              actions.dial({ firmId, contactId: entry.route.contactId, routeId: entry.route.routeId });
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

/** Call, disabled, while the calling status is unknown (slice C1). */
function WaitingDialPanel({ view, status }: { readonly view: TodayScreenView; readonly status: CallingStatus }): JSX.Element {
  const unavailable = status.view?.provider === 'unavailable';
  return (
    <div data-testid="dial-panel" className="mt-3 flex flex-col gap-2">
      <CallAnnouncement />
      {view.dialRoutes.map(entry => (
        <div key={entry.route.routeId} data-testid="dial-route" className="flex flex-wrap items-center gap-2">
          <Button data-testid="dial" disabled>
            Call {entry.route.e164}
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <p data-testid="calling-status" className="text-xs text-muted-foreground">
          {unavailable ? CALLING_UNAVAILABLE_SENTENCE : CALLING_CHECKING_SENTENCE}
        </p>
        {unavailable ? (
          <Button
            variant="quiet"
            size="sm"
            data-testid="calling-retry"
            onClick={() => {
              status.reload();
            }}
          >
            Try again
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** The dial panel when calls are placed from Callie (slice C1). */
function InAppDialPanel({
  firmId,
  view,
  calling,
  cadence,
}: {
  readonly firmId: string;
  readonly view: TodayScreenView;
  readonly calling: DialCalling;
  readonly cadence: NonNullable<NonNullable<CallingStatus['view']>['cadence']> | null;
}): JSX.Element {
  const call = calling.call;
  const busy = call.state.phase === 'starting' || call.state.phase === 'ringing' || call.state.phase === 'connected';
  const parked = cadence?.parked === true;
  return (
    <div data-testid="dial-panel" className="mt-3 flex flex-col gap-2">
      {/* First, as on the phone-app panel: what is said the moment they answer. */}
      <CallAnnouncement />
      {cadence === null ? null : (
        <div className="flex items-center gap-2">
          <p data-testid="call-attempt" className="text-xs text-muted-foreground">
            {attemptLabel(cadence)}
          </p>
          {parked ? (
            <Button
              variant="outline"
              size="sm"
              data-testid="call-resume"
              disabled={calling.status.resuming || !view.actionsEnabled}
              onClick={() => {
                void calling.status.resume().then(() => {
                  calling.onResumed?.();
                });
              }}
            >
              Resume calling
            </Button>
          ) : null}
        </div>
      )}
      {view.dialRoutes.map(entry => (
        <div key={entry.route.routeId} data-testid="dial-route" className="flex flex-wrap items-center gap-2">
          <Button
            data-testid="dial"
            disabled={!entry.enabled || busy || parked}
            {...(busy && 'routeId' in call.state && call.state.routeId === entry.route.routeId
              ? { 'aria-busy': true }
              : {})}
            onClick={() => {
              call.place({ firmId, contactId: entry.route.contactId, routeId: entry.route.routeId });
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
      <CallView call={call} />
      {/* Slice C3b: what the last call with this firm came to, and what was to happen next. */}
      <LatestCallSummary firmId={firmId} />
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
  readonly actions: TodayActions;
}): JSX.Element | null {
  const expanded = state.expanded;
  const firmId = expanded?.firmId ?? null;
  const status = useCallingStatus(firmId);
  const call = useCall(registryCallPorts());
  // A call that ended: read the card again (the outcome form names the call) and the
  // cadence ("Attempt N of 4" moves once the outcome is recorded).
  const endedSession = call.state.phase === 'ended' ? call.state.sessionId : null;
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (endedSession === null || seen.current === endedSession || firmId === null) return;
    seen.current = endedSession;
    actions.expand(firmId);
    status.reload();
  }, [endedSession, firmId, actions, status]);
  if (expanded === null) return null;
  const callHere = 'firmId' in call.state && call.state.firmId === expanded.firmId ? call : null;
  const callSessionId =
    callHere !== null && (call.state.phase === 'ended' || call.state.phase === 'connected' || call.state.phase === 'ringing')
      ? call.state.sessionId
      : null;
  return (
    <section data-testid="today-firm" className="mt-2 mb-4 ml-1 border-l border-border pl-4">
      {/* The row above already names the firm; the heading is for a screen reader. */}
      <h3 data-testid="firm-name" className="sr-only">
        {expanded.firmName}
      </h3>
      {/* Above the tasks: what this firm is and why, before what is owed on it. */}
      <Brief
        brief={expanded.brief ?? null}
        enabled={view.actionsEnabled}
        researching={actions.busy(todayForm.research(expanded.firmId))}
        onResearchAgain={() => {
          actions.researchAgain(expanded.firmId);
        }}
      />
      <ul data-testid="today-tasks" className="flex flex-col">
        {view.tasks.map(entry => (
          <TaskRow key={entry.task.itemId} entry={entry} state={state} actionsEnabled={view.actionsEnabled} actions={actions} />
        ))}
      </ul>
      <DialPanel
        state={state}
        view={view}
        actions={actions}
        calling={{
          status,
          call,
          onResumed: () => {
            actions.expand(expanded.firmId);
          },
        }}
      />
      <OutcomeForm state={state} view={view} enabled={view.actionsEnabled} actions={actions} callSessionId={callSessionId} />
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
  readonly actions: TodayActions;
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
            disabled={actions.busy(todayForm.card(entry.card.firmId))}
            {...(actions.busy(todayForm.card(entry.card.firmId)) ? { 'aria-busy': true } : {})}
            onClick={() => {
              if (entry.expanded) actions.collapse(entry.card.firmId);
              else actions.expand(entry.card.firmId);
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
  readonly actions: TodayActions;
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
