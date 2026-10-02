import { CALL_OUTCOMES, type CallOutcome } from '@fss/contracts';
import { useEffect, useState, type JSX } from 'react';
import { useClearDrafts, useDraft } from '../app/drafts.tsx';
import { dueLabel } from '../homeView.ts';
import {
  OUTCOME_LABELS,
  REACHED_OUTCOMES,
  OUTCOME_PROBLEM_SENTENCES,
  SUPPRESSION_WARNINGS,
  callbackNeedsTime,
  doNotCallChoiceKeyOf,
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
import { StopChoice } from './StopChoice.tsx';
import { noDefiniteAnswer } from './afterCallModel.ts';
import { announceKept, outcomeCommandKey, useTodayKept, type OutcomeCommand } from './keptCommands.ts';
import {
  FOLLOW_UP_CHOICES,
  FOLLOW_UP_CHOICE_LABELS,
  followUpChoiceOf,
  followUpPermissionOf,
  followUpProblem,
  enrolRefusalSentence,
  previewFor,
  previewRows,
} from './followUpView.ts';
import { orDash } from './text.ts';
import { todayForm, type TodayActions } from './useToday.ts';

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
export type LogTarget =
  | {
      readonly kind: 'current';
      /**
       * The call "the call just placed" was resolved to when the form opened (X1F rule 1): its
       * number, person and, when Callie placed it, its session; null when there was none.
       * Undefined only for a form mounted without an opener (a test), which resolves it from
       * the state it is drawn with.
       */
      readonly call?: ResolvedCall | null;
      /** The call this opening last recorded (`callIdentity`), so it is never resolved to again. */
      readonly after?: string;
    }
  | { readonly kind: 'session'; readonly callSessionId: string };
const CURRENT: LogTarget = { kind: 'current' };

/** "The call just placed", resolved once: what the outcome request names for it. */
export interface ResolvedCall {
  readonly routeId: string;
  readonly contactId: string | null;
  readonly e164: string;
  readonly callSessionId: string | null;
}

/**
 * The firm's last call as the main process holds it, or null when it was another firm's or
 * there was none. `endedSession` is the session of a call that ended here, used only when the
 * last call carries none (a form drawn without the main process's session, in a test).
 */
export function currentCallOf(state: TodayState, firmId: string | null, endedSession: string | null = null): ResolvedCall | null {
  const last = state.lastCall;
  if (last == null || firmId === null || last.firmId !== firmId) return null;
  return { routeId: last.routeId, contactId: last.contactId, e164: last.e164, callSessionId: last.callSessionId ?? endedSession };
}

/** One call's identity: its session, or its number for a call handed to the phone app. */
export const callIdentity = (call: ResolvedCall): string => call.callSessionId ?? `route:${call.routeId}`;

/** The key every draft and command of a call is kept under (X1F rule 2): its session, or `none`. */
export function outcomeSessionKey(target: LogTarget, resolved: ResolvedCall | null): string {
  return target.kind === 'session' ? target.callSessionId : (resolved?.callSessionId ?? 'none');
}

/** Where a call's outcome drafts live: by firm and by call, never by firm alone. */
export const outcomeDraftPrefix = (firmId: string, sessionKey: string): string => `today:outcome:${firmId}:${sessionKey}:`;

export function OutcomeForm({
  state,
  view,
  enabled,
  actions,
  callSessionId = null,
  target = CURRENT,
  onSubmitted,
}: {
  readonly state: TodayState;
  readonly view: TodayScreenView;
  readonly enabled: boolean;
  readonly actions: TodayActions;
  /**
   * The call placed from Callie that this form records (slice C1). The main process names
   * the session on `/calls/log`; the form says so, so the person knows the outcome is
   * filed with the recording.
   */
  readonly callSessionId?: string | null;
  /**
   * Which call this opening records, set by whoever opened the form. `current` is the call
   * Callie just placed (the last call's number and person). `session` is a call named by its
   * own session (a Needs review item's Log): its session is sent, and no route, person or task
   * is borrowed from the last call; the server derives the route from the session's ticket.
   */
  readonly target?: LogTarget;
  /**
   * The outcome was recorded: the opener decides what that closes. Called on a definite
   * success only, never on a refusal or a lost answer (kept-state rules K5/K6), with the call
   * it recorded (null for a named session).
   */
  onSubmitted?(recorded: ResolvedCall | null): void;
}): JSX.Element | null {
  const named = target.kind === 'session';
  const expanded = state.expanded;
  const firmId = expanded?.firmId ?? '';
  // The call this opening records (X1F rules 1 and 2). "The call just placed" was resolved when
  // the form opened; a named session is itself. Every draft and the command on the wire are
  // kept under that call, so call B never sees call A's fields, stop or unanswered command.
  const resolved = named ? null : target.call !== undefined ? target.call : currentCallOf(state, expanded?.firmId ?? null, callSessionId);
  const sessionKey = outcomeSessionKey(target, resolved);
  const prefix = outcomeDraftPrefix(firmId, sessionKey);
  const stopKey = `${prefix}stopChoice`;
  const commandKey = outcomeCommandKey(firmId, sessionKey);
  const kept = useTodayKept();
  const [chosenTask, setChosenTask] = useDraft(`${prefix}task`);
  const [outcome, setOutcome] = useDraft(`${prefix}outcome`);
  const [note, setNote] = useDraft(`${prefix}note`);
  const [callbackDate, setCallbackDate] = useDraft(`${prefix}callbackDate`);
  const [callbackTime, setCallbackTime] = useDraft(`${prefix}callbackTime`);
  // Migration 0037: which of the four stops a "Do not call" records. Empty is the default,
  // calls to this person.
  const [stopChoice, setStopChoice] = useDraft(stopKey);
  // Migration 0025: the follow-up agreed on the call. Empty is "none", which is the
  // default, because a permission to write to somebody is not something a form should
  // grant by accident.
  const [followUp, setFollowUp] = useDraft(`${prefix}followUp`);
  // Send-path v2 (slice S3): which of the three answers — none, one approved e-mail, an
  // agreed sequence — and the sequence version chosen. `followUp` above stays the
  // template version's id, which is what it has always held.
  const [followUpKind, setFollowUpKind] = useDraft(`${prefix}followUpKind`);
  const [followUpSequence, setFollowUpSequence] = useDraft(`${prefix}followUpSequence`);
  const clear = useClearDrafts();
  // The approved templates this call may promise. The value the select holds is the
  // template version's id, which is what the permission is bound to (P0-2).
  const templates = state.followUpTemplates;
  const sequences = state.followUpSequences ?? [];

  // Who this call was with, and whether a follow-up may be offered at all. Computed
  // before the early return, because the preview below is asked for from an effect.
  const lastCallHere = resolved;
  // A named call borrows nothing: only a task David picked in this form names a person or an item.
  const pickedTask = chosenTask !== '' && chosenTask !== 'none' ? chosenTask : '';
  const chosenItemId = named ? pickedTask : chosenTask === '' ? (view.outcomeItemId ?? '') : chosenTask === 'none' ? '' : chosenTask;
  const chosenTaskRow = view.tasks.find(entry => entry.callable && entry.task.itemId === chosenItemId)?.task ?? null;
  const calledContactId = lastCallHere?.contactId ?? chosenTaskRow?.contactId ?? null;
  const pick = {
    choice: followUpChoiceOf(followUpKind),
    templateVersionId: followUp,
    sequenceVersionId: followUpSequence,
  };
  const wantsPreview =
    expanded !== null && REACHED_OUTCOMES.includes(outcome as CallOutcome) && calledContactId !== null && pick.choice === 'agreed_sequence' &&
    pick.sequenceVersionId !== '';
  const preview =
    expanded === null
      ? null
      : previewFor(state.followUpPreview, {
          firmId: expanded.firmId,
          contactId: calledContactId,
          sequenceVersionId: pick.sequenceVersionId,
        });
  // Ask the server once per firm, person and version: an answer that does not match (a
  // refusal is kept, a lost answer clears it) is not a reason to ask again in a loop. A
  // lost answer offers Retry instead, which forgets the key and asks again (review of
  // S3, P2-b).
  const [askedKey, setAskedKey] = useState<string | null>(null);
  const previewKey = wantsPreview ? `${expanded.firmId}:${calledContactId}:${pick.sequenceVersionId}` : null;
  useEffect(() => {
    if (previewKey === null || !wantsPreview || preview !== null || askedKey === previewKey) return;
    setAskedKey(previewKey);
    actions.previewFollowUp({
      firmId: expanded.firmId,
      contactId: calledContactId,
      sequenceVersionId: pick.sequenceVersionId,
    });
  }, [previewKey, wantsPreview, preview, askedKey, actions, expanded, calledContactId, pick.sequenceVersionId]);

  // This mount is the form for its call: a success of that call's command closes it, whichever
  // mount sent it.
  useEffect(() => {
    if (expanded === null) return;
    const close = (recorded: ResolvedCall | null): void => onSubmitted?.(recorded);
    kept.openForms.set(commandKey, close);
    return () => {
      if (kept.openForms.get(commandKey) === close) kept.openForms.delete(commandKey);
    };
  }, [kept, commandKey, expanded, onSubmitted]);

  if (expanded === null) return null;

  const draft: OutcomeDraft = {
    outcome: outcome === '' ? null : (outcome as OutcomeDraft['outcome']),
    note,
    callbackLocalDate: callbackDate,
    callbackLocalTime: callbackTime,
    callbackTimeZone: state.businessTimeZone ?? '',
    callbackDueAt: '',
    doNotCall: doNotCallChoiceKeyOf(stopChoice),
  };

  // The call this opening resolved to: the number handed off, and its session if Callie placed it.
  const lastCall = resolved;
  const callable = view.tasks.filter(entry => entry.callable);
  // The view model's default is the task of the contact just called; a person may pick
  // another, and what they picked wins.
  const itemId = chosenItemId;
  const stopper = outcomeProblem(draft);
  // This card's outcome form waits for its own command and for nothing else (P1-4).
  const busy = actions.busy(todayForm.outcome(expanded.firmId));
  // Rules K5/K6: an entry here is an outcome sent for this call with no definite answer yet.
  // Its fields stay as they were sent and locked; Record sends exactly that request again
  // under its id, so the server answers it from its receipt and never records it twice.
  const unanswered = kept.outcomes.get(commandKey) ?? null;
  const locked = busy || unanswered !== null;
  // The agreed sequence's preview on the wire: the form waits for it before it can be
  // recorded, because the preview is what the person agreed to.
  const previewing = actions.busy(todayForm.preview(expanded.firmId));
  const suppression = outcomeSuppresses(draft);
  const wantsCallback = draft.outcome === 'callback_requested';
  // Who this call was with. A permission is granted to *a person*, so the form offers one
  // only when it can name one: a call to a main line is evidence about a firm and not
  // somebody's consent (the third review of PR 332, where an agreement with no contact
  // rolled the engaged-call stop back).
  const task = callable.find(entry => entry.task.itemId === itemId)?.task ?? null;
  const contactId = lastCall?.contactId ?? task?.contactId ?? null;
  // Only a conversation grants a follow-up. "Call me Tuesday" is the callback below and
  // grants no e-mail permission, which is David's own distinction of 29 September 2026.
  const offersFollowUp = draft.outcome !== null && REACHED_OUTCOMES.includes(draft.outcome) && contactId !== null;
  // The last request for this pick came back and left nothing: a lost answer, not a refusal.
  const previewFailed = previewKey !== null && askedKey === previewKey && preview === null && !previewing;
  // A named call with an agreement picked and nobody to give it to: not dropped silently.
  const needsWho = named && draft.outcome !== null && REACHED_OUTCOMES.includes(draft.outcome) && contactId === null && pick.choice !== 'none';
  const followUpStopper = needsWho ? 'who' : offersFollowUp ? followUpProblem(pick, previewing ? null : preview, previewFailed) : null;

  // Review of S3, round 2 (P1-B): the call was recorded but its agreed dates had changed
  // after the preview, so nothing was granted. This call's agreement stays open here: the
  // fresh preview, and "Record the agreed dates" once the person has heard them.
  const pending = state.pendingAgreement != null && state.pendingAgreement.firmId === expanded.firmId ? state.pendingAgreement : null;
  const pendingPreview =
    pending === null
      ? null
      : previewFor(state.followUpPreview, {
          firmId: pending.firmId,
          contactId: pending.contactId,
          sequenceVersionId: pending.sequenceVersionId,
        });
  const recordingDates = pending !== null && actions.busy(todayForm.agreedDates(pending.callLogId));
  const recovery =
    pending === null ? null : (
      <section data-testid="agreed-dates" className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
        <p className="text-xs font-medium">{`The dates of “${pending.name}” changed after your preview. Read them the new dates:`}</p>
        {pendingPreview !== null && pendingPreview.refusal === null ? (
          <ol data-testid="agreed-dates-preview" className="flex flex-col gap-1 text-xs">
            {previewRows(pendingPreview).map(row => (
              <li key={row.ordinal} data-testid="agreed-dates-step" className="flex justify-between gap-3 border-b border-border py-1">
                <span>{`${String(row.ordinal)}. ${row.what}`}</span>
                <span className="shrink-0 text-muted-foreground">{row.when}</span>
              </li>
            ))}
          </ol>
        ) : (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span data-testid="agreed-dates-problem">
              {pendingPreview?.refusal == null
                ? 'Callie is reading the new dates.'
                : `Callie cannot start that sequence here: ${enrolRefusalSentence(pendingPreview.refusal)}.`}
            </span>
            {previewing ? null : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="agreed-dates-reload"
                disabled={!enabled}
                onClick={() => {
                  actions.previewFollowUp({
                    firmId: pending.firmId,
                    contactId: pending.contactId,
                    sequenceVersionId: pending.sequenceVersionId,
                  });
                }}
              >
                Preview again
              </Button>
            )}
          </div>
        )}
        <div>
          <Button
            type="button"
            data-testid="agreed-dates-record"
            disabled={!enabled || recordingDates || previewing || pendingPreview === null || pendingPreview.refusal !== null}
            onClick={() => {
              actions.recordAgreedDates({ firmId: pending.firmId, callLogId: pending.callLogId });
            }}
          >
            Record the agreed dates
          </Button>
        </div>
      </section>
    );

  return (
    <>
    {recovery}
    <form
      data-testid="outcome-form"
      className="mt-3 flex flex-col gap-2 border-t border-border pt-3"
      onSubmit={event => {
        event.preventDefault();
        if (!enabled || busy) return;
        // Rules K5/K6: the request without a definite answer is sent again exactly, under its
        // id, whatever the fields show; otherwise a new command is built from the fields.
        let command: OutcomeCommand;
        if (unanswered !== null) command = unanswered;
        else {
          if (followUpStopper !== null) return;
          const built = logCallCommand({
            // The command id below is the form's own; this one only proves the draft is
            // complete before the page offers to send it.
            commandId: 'draft',
            clientVersion: '0.0.0',
            firmId: expanded.firmId,
            draft,
          });
          if ('problem' in built) return;
          // X1F rule 1: the body names the resolved call, its session included, so the main
          // process forwards it as it is and a retry under this id is the same request.
          const sessionId = target.kind === 'session' ? target.callSessionId : (lastCall?.callSessionId ?? null);
          command = {
            id: crypto.randomUUID(),
            body: {
              firmId: expanded.firmId,
              contactId,
              routeId: lastCall?.routeId ?? null,
              itemId: itemId === '' ? null : itemId,
              ...(sessionId === null ? {} : { callSessionId: sessionId }),
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
              doNotCallCoversAllContact: false,
              ...(built.command.doNotCall === undefined ? {} : { doNotCall: built.command.doNotCall }),
              // Never without a person: the select is hidden in that case, and a draft kept
              // from a moment when it was not is not a reason to send one.
              followUpPermission: offersFollowUp && followUpStopper === null ? followUpPermissionOf(pick, preview) : null,
            },
          };
          kept.outcomes.set(commandKey, command);
          announceKept();
        }
        const sent = command;
        const sentKey = commandKey;
        const sentPrefix = prefix;
        const sentCall = lastCall;
        const settle = (answered: TodayState | null | undefined): void => {
          if (kept.outcomes.get(sentKey) !== sent) return;
          const answer = answered?.outcomeAnswer ?? null;
          // No answer, an answer to another command, or a refusal that is not one (offline, a
          // timeout, a 5xx): nothing says whether the call was recorded. Everything stays, and
          // so does the command, for Record again.
          if (answer === null || answer.commandId !== sent.id || (!answer.recorded && noDefiniteAnswer(answer.reason))) {
            announceKept();
            return;
          }
          kept.outcomes.delete(sentKey);
          if (answer.recorded) {
            // Recorded (X1F rule 3): exactly this call's drafts go, by their keys, and only this
            // call's form is told. Another call's fields are under other keys and stay. A
            // refusal keeps every field and the stop choice, for David to correct.
            clear(sentPrefix);
            kept.openForms.get(sentKey)?.(sentCall);
          }
          announceKept();
        };
        void Promise.resolve(actions.recordOutcome({ ...sent.body, commandId: sent.id })).then(settle, () => {
          settle(null);
        });
      }}
    >
      <p data-testid="outcome-call" className="text-xs text-muted-foreground">
        {named ? 'This records the call you chose from Needs review.' : lastCall === null ? 'Not after a call from Callie: this records the call as history.' : `The call to ${lastCall.e164}.`}
      </p>
      {callSessionId === null ? null : (
        <p data-testid="outcome-call-session" data-session={callSessionId} className="text-xs text-muted-foreground">
          Placed from Callie and recorded: this outcome is filed with the recording.
        </p>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <Label className="flex-col items-start gap-1">
          Which task
          <Select
            data-testid="outcome-task"
            disabled={!enabled || locked}
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
            disabled={!enabled || locked}
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

      <fieldset
        data-testid="outcome-follow-up-label"
        hidden={!offersFollowUp}
        className="flex flex-col gap-2 border-0 p-0"
      >
        <legend className="mb-1 w-full text-xs font-medium text-muted-foreground">
          What did they agree to hear from us?
        </legend>
        <Select
          data-testid="outcome-follow-up-kind"
          aria-label="What did they agree to hear from us?"
          disabled={!enabled || locked}
          value={pick.choice}
          onChange={event => {
            setFollowUpKind(event.target.value);
          }}
        >
          {FOLLOW_UP_CHOICES.map(choice => (
            <option key={choice} value={choice}>
              {FOLLOW_UP_CHOICE_LABELS[choice]}
            </option>
          ))}
        </Select>

        <Label hidden={pick.choice !== 'single_email'} className="flex-col items-start gap-1">
          Which e-mail
          <Select
            data-testid="outcome-follow-up"
            disabled={!enabled || locked}
            value={followUp}
            onChange={event => {
              setFollowUp(event.target.value);
            }}
          >
            <option value="">Choose the e-mail…</option>
            {templates.map(template => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </Select>
          <span className="text-xs text-muted-foreground">
            {templates.length === 0
              ? 'No approved template to promise yet. Approve one in Sequences first.'
              : 'One e-mail, the approved one you name, for fourteen days.'}
          </span>
        </Label>

        <Label hidden={pick.choice !== 'agreed_sequence'} className="flex-col items-start gap-1">
          Which sequence
          <Select
            data-testid="outcome-follow-up-sequence"
            disabled={!enabled || locked}
            value={followUpSequence}
            onChange={event => {
              setFollowUpSequence(event.target.value);
            }}
          >
            <option value="">Choose the sequence…</option>
            {sequences.map(sequence => (
              <option key={sequence.sequenceVersionId} value={sequence.sequenceVersionId}>
                {sequence.name}
              </option>
            ))}
          </Select>
          <span className="text-xs text-muted-foreground">
            {sequences.length === 0
              ? 'No published sequence to agree to yet. Publish one in Sequences first.'
              : 'Read them the messages and the dates below. Recording the call starts it.'}
          </span>
        </Label>

        {pick.choice === 'agreed_sequence' && preview !== null && preview.refusal === null ? (
          <ol data-testid="outcome-follow-up-preview" className="flex flex-col gap-1 text-xs">
            {previewRows(preview).map(row => (
              <li key={row.ordinal} data-testid="preview-step" className="flex justify-between gap-3 border-b border-border py-1">
                <span data-testid="preview-step-what">{`${String(row.ordinal)}. ${row.what}`}</span>
                <span data-testid="preview-step-when" className="shrink-0 text-muted-foreground">
                  {row.when}
                </span>
              </li>
            ))}
          </ol>
        ) : null}

        <p data-testid="outcome-follow-up-problem" className="text-xs text-muted-foreground empty:hidden">
          {followUpStopper ?? ''}
        </p>
        {offersFollowUp && previewFailed ? (
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="outcome-follow-up-retry"
              disabled={!enabled || locked}
              onClick={() => {
                setAskedKey(null);
              }}
            >
              Preview again
            </Button>
          </div>
        ) : null}
      </fieldset>

      <fieldset data-testid="outcome-callback" hidden={!wantsCallback} className="flex flex-wrap items-end gap-2 border-0 p-0">
        <legend className="mb-1 w-full text-xs font-medium text-muted-foreground">
          When did you promise to call back?
        </legend>
        <Input
          data-testid="callback-date"
          type="date"
          disabled={!enabled || locked}
          value={callbackDate}
          onChange={event => {
            setCallbackDate(event.target.value);
          }}
          className="w-40"
        />
        <Input
          data-testid="callback-time"
          type="time"
          disabled={!enabled || locked}
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
        <div data-testid="do-not-call-scope">
          <StopChoice
            testId="do-not-call-choice"
            value={draft.doNotCall}
            disabled={!enabled || locked}
            onChange={next => {
              setStopChoice(next);
            }}
          />
        </div>
      ) : null}

      <Textarea
        data-testid="outcome-note"
        placeholder="Note"
        disabled={!enabled || locked}
        value={note}
        onChange={event => {
          setNote(event.target.value);
        }}
      />

      <p data-testid="outcome-warning" className="text-xs text-[color-mix(in_oklch,var(--status-warn)_75%,black)] empty:hidden">
        {suppression === 'none' ? '' : SUPPRESSION_WARNINGS[suppression]}
      </p>
      {needsWho ? (
        <p data-testid="outcome-who" className="text-xs text-destructive">
          Choose who agreed: pick their task above.{' '}
          <button type="button" data-testid="outcome-who-none" className="underline underline-offset-2" onClick={() => setFollowUpKind('')}>
            No follow-up
          </button>
        </p>
      ) : null}
      <p data-testid="outcome-problem" className="text-xs text-destructive empty:hidden">
        {stopper === null || draft.outcome === null ? '' : OUTCOME_PROBLEM_SENTENCES[stopper]}
      </p>
      {unanswered !== null && !busy ? (
        <p data-testid="outcome-unanswered" role="status" className="text-xs text-destructive">
          No answer came back, so Callie cannot say whether this call was recorded. Record again sends the same outcome, and it is never recorded twice.
        </p>
      ) : null}

      <div>
        <Button
          type="submit"
          data-testid="outcome-submit"
          disabled={!enabled || busy || (unanswered === null && (stopper !== null || followUpStopper !== null))}
          {...(busy ? { 'aria-busy': true } : {})}
        >
          {unanswered === null ? 'Record' : 'Record again'}
        </Button>
      </div>
    </form>
    </>
  );
}
