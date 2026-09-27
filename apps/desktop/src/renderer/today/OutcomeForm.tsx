import { CALL_OUTCOMES } from '@fss/contracts';
import type { JSX } from 'react';
import { useClearDrafts, useDraft } from '../app/drafts.tsx';
import { dueLabel } from '../homeView.ts';
import {
  OUTCOME_LABELS,
  OUTCOME_PROBLEM_SENTENCES,
  SUPPRESSION_WARNINGS,
  callbackNeedsTime,
  logCallCommand,
  outcomeProblem,
  outcomeSuppresses,
  resolvedCallbackInstant,
  type OutcomeDraft,
} from '../outcomeForm.ts';
import type { TodayState } from '../todayContract.ts';
import type { TodayScreenView } from '../todayView.ts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Label } from '../ui/label.tsx';
import { Select } from '../ui/select.tsx';
import { Textarea } from '../ui/textarea.tsx';
import { orDash } from './text.ts';
import type { TodayActions } from './useToday.ts';

/**
 * What happened on the call (9.1).
 *
 * Every rule is `outcomeForm.ts`'s: what a draft must carry before it can be recorded,
 * whether recording it writes a suppression and how wide, and the instant a day and a
 * time resolve to — through the domain's own calendar clock, so what is shown back is
 * what will be stored, including the hour a DST gap moves it to (C18). This file draws
 * that answer and sends the command.
 *
 * The call it is about is the last number the Call button handed to the phone app, when
 * that was this firm's; there is no ticket to name since 1.0.12, because `POST /calls/log`
 * never needed one.
 */
export function OutcomeForm({
  state,
  view,
  enabled,
  actions,
}: {
  readonly state: TodayState;
  readonly view: TodayScreenView;
  readonly enabled: boolean;
  readonly actions: TodayActions;
}): JSX.Element | null {
  const expanded = state.expanded;
  const firmId = expanded?.firmId ?? '';
  const prefix = `today:outcome:${firmId}:`;
  const [chosenTask, setChosenTask] = useDraft(`${prefix}task`);
  const [outcome, setOutcome] = useDraft(`${prefix}outcome`);
  const [note, setNote] = useDraft(`${prefix}note`);
  const [callbackDate, setCallbackDate] = useDraft(`${prefix}callbackDate`);
  const [callbackTime, setCallbackTime] = useDraft(`${prefix}callbackTime`);
  const [coversAll, setCoversAll] = useDraft(`${prefix}coversAll`);
  const clear = useClearDrafts();
  if (expanded === null) return null;

  const draft: OutcomeDraft = {
    outcome: outcome === '' ? null : (outcome as OutcomeDraft['outcome']),
    note,
    callbackLocalDate: callbackDate,
    callbackLocalTime: callbackTime,
    callbackTimeZone: state.businessTimeZone ?? '',
    callbackDueAt: '',
    doNotCallCoversAllContact: coversAll === 'yes',
  };

  // The number the last Call button handed to the phone app, when it was this firm's.
  const lastCall = state.lastCall != null && state.lastCall.firmId === expanded.firmId ? state.lastCall : null;
  const callable = view.tasks.filter(entry => entry.callable);
  // The view model's default is the task of the contact just called; a person may pick
  // another, and what they picked wins.
  const itemId = chosenTask === '' ? (view.outcomeItemId ?? '') : chosenTask === 'none' ? '' : chosenTask;
  const stopper = outcomeProblem(draft);
  const suppression = outcomeSuppresses(draft);
  const wantsCallback = draft.outcome === 'callback_requested';

  return (
    <form
      data-testid="outcome-form"
      className="mt-3 flex flex-col gap-2 border-t border-border pt-3"
      onSubmit={event => {
        event.preventDefault();
        const built = logCallCommand({
          // The main process mints the real command id; this one only proves the draft is
          // complete before the page offers to send it.
          commandId: 'draft',
          clientVersion: '0.0.0',
          firmId: expanded.firmId,
          draft,
        });
        if ('problem' in built) return;
        const task = callable.find(entry => entry.task.itemId === itemId)?.task ?? null;
        actions.recordOutcome({
            firmId: expanded.firmId,
            contactId: lastCall?.contactId ?? task?.contactId ?? null,
            routeId: lastCall?.routeId ?? null,
            itemId: itemId === '' ? null : itemId,
            outcome: built.command.outcome,
            note: built.command.note ?? '',
            callback:
              built.command.outcome !== 'callback_requested' || callbackNeedsTime(draft)
                ? null
                : {
                    localDate: draft.callbackLocalDate.trim(),
                    localTime: draft.callbackLocalTime.trim(),
                    dueAt: built.command.callback?.dueAt ?? '',
                    sourceTimeZone: draft.callbackTimeZone,
                  },
          doNotCallCoversAllContact: built.command.doNotCallCoversAllContact ?? false,
        });
        clear(prefix);
      }}
    >
      <p data-testid="outcome-call" className="text-xs text-muted-foreground">
        {lastCall === null ? 'Not after a call from Callie: this records the call as history.' : `The call to ${lastCall.e164}.`}
      </p>

      <div className="grid gap-2 sm:grid-cols-2">
        <Label className="flex-col items-start gap-1">
          Which task
          <Select
            data-testid="outcome-task"
            disabled={!enabled}
            value={itemId}
            onChange={event => {
              setChosenTask(event.target.value === '' ? 'none' : event.target.value);
            }}
          >
            <option value="">Not for a task on this card</option>
            {callable.map(entry => (
              <option key={entry.task.itemId} value={entry.task.itemId}>
                {entry.label} — {orDash(entry.task.contactName)}
              </option>
            ))}
          </Select>
        </Label>

        <Label className="flex-col items-start gap-1">
          What happened
          <Select
            data-testid="outcome-select"
            disabled={!enabled}
            value={outcome}
            onChange={event => {
              setOutcome(event.target.value);
            }}
          >
            <option value="">What happened…</option>
            {CALL_OUTCOMES.map(value => (
              <option key={value} value={value}>
                {OUTCOME_LABELS[value]}
              </option>
            ))}
          </Select>
        </Label>
      </div>

      <fieldset data-testid="outcome-callback" hidden={!wantsCallback} className="flex flex-wrap items-end gap-2 border-0 p-0">
        <legend className="mb-1 w-full text-xs font-medium text-muted-foreground">
          When did you promise to call back?
        </legend>
        <Input
          data-testid="callback-date"
          type="date"
          disabled={!enabled}
          value={callbackDate}
          onChange={event => {
            setCallbackDate(event.target.value);
          }}
          className="w-40"
        />
        <Input
          data-testid="callback-time"
          type="time"
          disabled={!enabled}
          value={callbackTime}
          onChange={event => {
            setCallbackTime(event.target.value);
          }}
          className="w-28"
        />
        <p data-testid="callback-resolved" className="w-full text-xs text-muted-foreground empty:hidden">
          {callbackNeedsTime(draft)
            ? 'No day yet? Record it anyway: “Callback — needs a time” goes on today’s list.'
            : resolvedCallbackInstant(draft) === null
              ? ''
              : `Callie will put the callback at ${dueLabel(resolvedCallbackInstant(draft) ?? '', state.businessTimeZone, state.snapshotDate)}.`}
        </p>
      </fieldset>

      {draft.outcome === 'do_not_call' ? (
        <label data-testid="do-not-call-scope" className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            data-testid="do-not-call-covers-all"
            disabled={!enabled}
            checked={coversAll === 'yes'}
            onChange={event => {
              setCoversAll(event.target.checked ? 'yes' : '');
            }}
            className="size-3.5 accent-[var(--primary)]"
          />
          <span>They asked not to be contacted at all, not just on this number</span>
        </label>
      ) : null}

      <Textarea
        data-testid="outcome-note"
        placeholder="Note"
        disabled={!enabled}
        value={note}
        onChange={event => {
          setNote(event.target.value);
        }}
      />

      <p data-testid="outcome-warning" className="text-xs text-[color-mix(in_oklch,var(--status-warn)_75%,black)] empty:hidden">
        {suppression === 'none' ? '' : SUPPRESSION_WARNINGS[suppression]}
      </p>
      <p data-testid="outcome-problem" className="text-xs text-destructive empty:hidden">
        {stopper === null || draft.outcome === null ? '' : OUTCOME_PROBLEM_SENTENCES[stopper]}
      </p>

      <div>
        <Button type="submit" data-testid="outcome-submit" disabled={!enabled || stopper !== null}>
          Record
        </Button>
      </div>
    </form>
  );
}
