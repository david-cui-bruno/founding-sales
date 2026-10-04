import { MeetingTaskControls } from '../meetings/MeetingTaskControls.tsx';
import { outcomesPorts } from '../meetings/MeetingOutcomes.tsx';
import { navigate } from '../routes.ts';
import { callbackInstant } from '@fss/contracts';
import type { JSX } from 'react';
import { useDraft } from '../app/drafts.tsx';
import { dueLabel } from '../homeView.ts';
import type { TodayState } from '../todayContract.ts';
import type { TaskView } from '../todayView.ts';
import { Badge } from '../ui/badge.tsx';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { orDash } from './text.ts';
import { todayForm, type TodayActions } from './useToday.ts';

/**
 * One task under an expanded card, and the one control it offers.
 *
 * Which control is the view model's answer, not this file's: a paused automated send
 * shows Resume, a callback with no time shows a day and a time, and everything else
 * shows the delay control whose label the view model already worded — "Pause sending"
 * for automated work, "Snooze" for a person's task (8.2; lane g79, C13 and C22).
 *
 * Every field's text lives in the shell's draft store, so navigating away and back keeps
 * a half-written reason, and a quiet refresh that redraws the lanes cannot take it.
 */

/** What a callback's day and time resolve to, in the firm's own clock. */
function callbackLine(instant: string | null, state: TodayState): string {
  if (instant === null) return '';
  return `Callie will put the callback at ${dueLabel(instant, state.businessTimeZone, state.snapshotDate)}.`;
}

function Snooze({ entry, actions }: { readonly entry: TaskView; readonly actions: TodayActions }): JSX.Element {
  const itemId = entry.task.itemId;
  // An automated send is paused until Resume, so it asks why and not until when
  // (8.2; lane g79, C22). A manual task's snooze needs both.
  const asksReturn = !entry.task.automated;
  const [reason, setReason] = useDraft(`today:snooze:${itemId}:reason`);
  const [returnAt, setReturnAt] = useDraft(`today:snooze:${itemId}:return`);
  const ready = reason.trim().length > 0 && (!asksReturn || returnAt.length > 0);
  // This task's own snooze, not any command anywhere (P1-4).
  const busy = actions.busy(todayForm.task(itemId));

  return (
    <form
      data-testid="snooze-form"
      className="flex items-center gap-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/task:opacity-100"
      onSubmit={event => {
        event.preventDefault();
        // `datetime-local` has no zone. The main process resolves it against the
        // workspace's business zone, which is the only zone this page is told about.
        actions.snooze({ itemId, reason: reason.trim(), returnAt: asksReturn ? returnAt : '' });
      }}
    >
      <Input
        data-testid="snooze-reason"
        type="text"
        required
        placeholder="Why"
        disabled={!entry.enabled || busy}
        value={reason}
        onChange={event => {
          setReason(event.target.value);
        }}
        className="h-7 w-28 text-xs"
      />
      <Input
        data-testid="snooze-return"
        type="datetime-local"
        required={asksReturn}
        hidden={!asksReturn}
        disabled={!entry.enabled || busy}
        value={returnAt}
        onChange={event => {
          setReturnAt(event.target.value);
        }}
        className="h-7 w-44 text-xs"
      />
      <Button
        type="submit"
        variant="outline"
        size="sm"
        data-testid="snooze-submit"
        disabled={!entry.enabled || !ready || busy}
        {...(busy ? { 'aria-busy': true } : {})}
      >
        {entry.delayLabel}
      </Button>
    </form>
  );
}

/** "Callback — needs a time": the day and time the person now confirms (C13). */
function Schedule({
  callLogId,
  state,
  enabled,
  actions,
}: {
  readonly callLogId: string;
  readonly state: TodayState;
  readonly enabled: boolean;
  readonly actions: TodayActions;
}): JSX.Element {
  const [date, setDate] = useDraft(`today:schedule:${callLogId}:date`);
  const [time, setTime] = useDraft(`today:schedule:${callLogId}:time`);
  const busy = actions.busy(todayForm.callback(callLogId));
  const instant = state.businessTimeZone === null || date === '' ? null : callbackInstant(date, time, state.businessTimeZone);

  return (
    <form
      data-testid="schedule-form"
      className="flex flex-wrap items-center gap-1.5"
      onSubmit={event => {
        event.preventDefault();
        actions.scheduleCallback({ callLogId, localDate: date, localTime: time });
      }}
    >
      <Input
        data-testid="schedule-date"
        type="date"
        disabled={!enabled || busy}
        value={date}
        onChange={event => {
          setDate(event.target.value);
        }}
        className="h-7 w-36 text-xs"
      />
      <Input
        data-testid="schedule-time"
        type="time"
        disabled={!enabled || busy}
        value={time}
        onChange={event => {
          setTime(event.target.value);
        }}
        className="h-7 w-24 text-xs"
      />
      <Button
        type="submit"
        variant="outline"
        size="sm"
        data-testid="schedule-submit"
        disabled={!enabled || instant === null || busy}
        {...(busy ? { 'aria-busy': true } : {})}
      >
        Set time
      </Button>
      <p data-testid="schedule-resolved" className="w-full text-xs text-muted-foreground empty:hidden">
        {callbackLine(instant, state)}
      </p>
    </form>
  );
}

export function TaskRow({
  entry,
  state,
  actionsEnabled,
  actions,
}: {
  readonly entry: TaskView;
  readonly state: TodayState;
  readonly actionsEnabled: boolean;
  readonly actions: TodayActions;
}): JSX.Element {
  if (entry.task.meetingTask != null) return <li data-testid="today-meeting-task" className="border-b border-border py-2"><MeetingTaskControls task={entry.task.meetingTask} change={outcomesPorts.changeTask} enabled={actionsEnabled} onChanged={changed => { actions.expand(changed.firmId); }} /></li>;
  if (entry.task.meetingReviewId != null) return <li data-testid="today-meeting-review" className="flex items-center justify-between border-b border-border py-2 text-sm"><span>Review meeting notes</span><Button size="sm" variant="quiet" onClick={() => { if (state.expanded !== null) navigate({ name: 'firm', firmId: state.expanded.firmId }); }}>Open meeting</Button></li>;
  const holdId = entry.task.pauseHoldId;
  const callLogId = entry.task.callLogId;
  const until = entry.task.snoozeUntil === null ? null : dueLabel(entry.task.snoozeUntil, state.businessTimeZone, state.snapshotDate);

  // A promise made on a call (slice 3a): quiet, one line of its own words, and Complete.
  const callTaskId = entry.task.callTaskId;
  if (entry.task.kind === 'task' && typeof callTaskId === 'string') {
    const busy = actions.busy(todayForm.callTask(callTaskId));
    return (
      <li data-testid="today-task" data-kind="task" className="group/task flex items-center gap-x-3 border-b border-border py-1.5 last:border-b-0">
        <time data-testid="task-due" dateTime={entry.task.dueAt} className="w-24 shrink-0 text-xs tabular-nums text-muted-foreground">
          {dueLabel(entry.task.dueAt, state.businessTimeZone, state.snapshotDate)}
        </time>
        <span data-testid="task-text" className="min-w-0 flex-1 truncate text-sm" title={entry.task.taskText ?? undefined}>
          {entry.task.taskText ?? entry.label}
        </span>
        <Button
          variant="outline"
          size="sm"
          data-testid="task-complete"
          className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover/task:opacity-100"
          disabled={!actionsEnabled || busy}
          {...(busy ? { 'aria-busy': true } : {})}
          onClick={() => {
            actions.completeTask({ taskId: callTaskId });
          }}
        >
          Complete
        </Button>
      </li>
    );
  }
  return (
    <li
      data-testid="today-task"
      className="group/task flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border py-1.5 last:border-b-0"
    >
      <time data-testid="task-due" dateTime={entry.task.dueAt} className="w-24 shrink-0 text-xs tabular-nums text-muted-foreground">
        {dueLabel(entry.task.dueAt, state.businessTimeZone, state.snapshotDate)}
      </time>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm">
        <span data-testid="task-kind">{entry.label}</span>
        <span data-testid="task-contact" className="truncate text-muted-foreground">
          {orDash(entry.task.contactName)}
        </span>
        {entry.task.status === 'snoozed' ? <Badge data-testid="task-snoozed">Asleep until {orDash(until)}</Badge> : null}
        {entry.paused ? <Badge data-testid="task-paused">Paused</Badge> : null}
      </span>
      {typeof holdId === 'string' ? (
        <Button
          variant="outline"
          size="sm"
          data-testid="pause-release"
          disabled={!actionsEnabled || actions.busy(todayForm.hold(holdId))}
          {...(actions.busy(todayForm.hold(holdId)) ? { 'aria-busy': true } : {})}
          onClick={() => {
            actions.releasePause({ holdId });
          }}
        >
          Resume
        </Button>
      ) : typeof callLogId === 'string' ? (
        <Schedule callLogId={callLogId} state={state} enabled={entry.enabled} actions={actions} />
      ) : (
        <Snooze entry={entry} actions={actions} />
      )}
    </li>
  );
}
