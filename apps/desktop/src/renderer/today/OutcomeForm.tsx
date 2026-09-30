import { CALL_OUTCOMES } from '@fss/contracts';
import { useEffect, useState, type JSX } from 'react';
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
  const lastCallHere =
    expanded !== null && state.lastCall != null && state.lastCall.firmId === expanded.firmId ? state.lastCall : null;
  const chosenItemId =
    chosenTask === '' ? (view.outcomeItemId ?? '') : chosenTask === 'none' ? '' : chosenTask;
  const chosenTaskRow = view.tasks.find(entry => entry.callable && entry.task.itemId === chosenItemId)?.task ?? null;
  const calledContactId = lastCallHere?.contactId ?? chosenTaskRow?.contactId ?? null;
  const pick = {
    choice: followUpChoiceOf(followUpKind),
    templateVersionId: followUp,
    sequenceVersionId: followUpSequence,
  };
  const wantsPreview =
    expanded !== null && outcome === 'interested' && calledContactId !== null && pick.choice === 'agreed_sequence' &&
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
  // This card's outcome form waits for its own command and for nothing else (P1-4).
  const busy = actions.busy(todayForm.outcome(expanded.firmId));
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
  const offersFollowUp = draft.outcome === 'interested' && contactId !== null;
  // The last request for this pick came back and left nothing: a lost answer, not a refusal.
  const previewFailed = previewKey !== null && askedKey === previewKey && preview === null && !previewing;
  const followUpStopper = offersFollowUp ? followUpProblem(pick, previewing ? null : preview, previewFailed) : null;

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
        const built = logCallCommand({
          // The main process mints the real command id; this one only proves the draft is
          // complete before the page offers to send it.
          commandId: 'draft',
          clientVersion: '0.0.0',
          firmId: expanded.firmId,
          draft,
        });
        if ('problem' in built) return;
        actions.recordOutcome({
            firmId: expanded.firmId,
            contactId,
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
          // Never without a person: the select is hidden in that case, and a draft kept
          // from a moment when it was not is not a reason to send one.
          followUpPermission: offersFollowUp && followUpStopper === null ? followUpPermissionOf(pick, preview) : null,
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
            disabled={!enabled || busy}
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
            disabled={!enabled || busy}
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
          disabled={!enabled || busy}
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
            disabled={!enabled || busy}
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
            disabled={!enabled || busy}
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
              disabled={!enabled || busy}
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
          disabled={!enabled || busy}
          value={callbackDate}
          onChange={event => {
            setCallbackDate(event.target.value);
          }}
          className="w-40"
        />
        <Input
          data-testid="callback-time"
          type="time"
          disabled={!enabled || busy}
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
            disabled={!enabled || busy}
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
        disabled={!enabled || busy}
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
        <Button
          type="submit"
          data-testid="outcome-submit"
          disabled={!enabled || stopper !== null || followUpStopper !== null || busy}
          {...(busy ? { 'aria-busy': true } : {})}
        >
          Record
        </Button>
      </div>
    </form>
    </>
  );
}
