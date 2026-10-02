import { CALL_OUTCOMES, type CallCorrectionDecision, type CallCorrectionReason, type CallLogCorrection, type CallOutcome } from '@fss/contracts';
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { CorrectedView, CorrectionPreviewView, OperationInput } from '../../shared/operations.ts';
import { useClearDrafts, useClearUnchangedDrafts, useDraft, useDrafts } from '../app/drafts.tsx';
import { cn } from '../lib/utils.ts';
import { OUTCOME_LABELS, doNotCallChoiceKeyOf } from '../outcomeForm.ts';
import { noDefiniteAnswer } from '../today/afterCallModel.ts';
import { useCorrectionMemory, type CorrectionCommand, type LiftEntry } from './correctionMemory.ts';
import { StopChoice } from '../today/StopChoice.tsx';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Select } from '../ui/select.tsx';
import { dense } from '../v2/parts.tsx';
import { shortcutFor } from '../v2/shortcuts.ts';
import {
  ALSO_HAPPENS_SENTENCES,
  REASON_LABELS,
  RELOAD_REFUSALS,
  SAVE_PROBLEM_SENTENCES,
  collapsedEffects,
  conflictingEffects,
  correctedLine,
  correctionBody,
  decisionLabel,
  decisionsFor,
  effectKey,
  effectSentence,
  effectWhy,
  liftRefusalSentence,
  reasonRequired,
  refusalSentence,
  saveProblem,
  type CorrectionDraft,
  type Decisions,
} from './correctionModel.ts';

/**
 * "Change outcome" (slice S3X, lane X2; DESIGN-S3X §3.6): one component, used by the firm page's
 * call history, Today's previous interactions and the after-call "Logged:" line.
 *
 * **One compact review step (P3).** Pick the new outcome (the current one is marked); the
 * preview loads; each conflicting effect is a row with Keep / Undo — a stop's are Keep stop /
 * Lift stop… — and **nothing is preselected**; everything else is one collapsed line with the
 * "Also happens" lines; the reason appears exactly when §3.7's rule needs it. Save sends one
 * request and the correction is atomic. Then one confirm opens per stop marked "Lift stop…",
 * which is the existing single-stop lift (`suppressions.supersede`); cancelling it leaves the
 * stop in place.
 *
 * **Kept state (K1–K7).** The draft — the chosen outcome, the stop choice, the callback time,
 * the decisions and the reason — is in the shell's drafts under `correct:<logId>:…`, which the
 * shell empties on every new session (K1), and remembers the outcome it was based on — the one
 * David saw when he opened Change. When that has moved, whether the history read again or a
 * preview reports another current outcome, the draft is dropped, "Changed elsewhere" says so
 * and the caller reads again; Save always sends that base as `expectedOutcome`, never the
 * preview's, so the server's stale-outcome check stands (K2). The
 * command on the wire, its answer, the open toggle and the pending lifts live in the session's
 * correction memory by log id (`calling/correctionMemory.ts`), so a late answer lands even after the control
 * unmounted and only updates feedback; it never reopens a review David closed (K3). J and K
 * never leave focus on a command button here (K4). The lift confirms open only after a
 * definite success, and a refused lift keeps its confirm open with the reason (K5); each
 * confirm is consumed by its own answer or by Cancel, never by comparing lists (K6). A preview
 * answer for an outcome no longer chosen is dropped (K7).
 */

export interface CorrectionPorts {
  preview(input: OperationInput<'calling.correctionPreview'>): Promise<CorrectionPreviewView>;
  correct(input: OperationInput<'calling.correctOutcome'>): Promise<CorrectedView>;
  supersede(input: OperationInput<'suppressions.supersede'>): Promise<{ readonly lifted: boolean; readonly reason: string | null }>;
}

/**
 * The registry's ports, one object per bridge: the default prop is the same object on every
 * render, so nothing keyed on it re-runs (review of X2, finding 3).
 */
let registryPorts: { readonly api: object; readonly ports: CorrectionPorts } | null = null;
export function registryCorrectionPorts(): CorrectionPorts | null {
  const api = globalThis.callieApi;
  if (api === undefined) return null;
  if (registryPorts !== null && registryPorts.api === api) return registryPorts.ports;
  const ports: CorrectionPorts = {
    preview: async input => await api.read('calling.correctionPreview', input),
    correct: async input => await api.command('calling.correctOutcome', input),
    supersede: async input => await api.command('suppressions.supersede', input),
  };
  registryPorts = { api, ports };
  return ports;
}

/** The draft keys of one log's correction. */
export const correctionDraftPrefix = (callLogId: string): string => `correct:${callLogId}:`;

function parseDecisions(text: string): Decisions {
  if (text === '') return {};
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null) return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, CallCorrectionDecision] => entry[1] === 'keep' || entry[1] === 'undo' || entry[1] === 'lift'),
    );
  } catch {
    return {};
  }
}

function liftSentence(entry: LiftEntry): string {
  if (entry.scope === 'firm') {
    return entry.channel === 'phone'
      ? 'Lift the stop on calls to this firm? It will no longer block calls.'
      : 'Lift the stop on all contact with this firm? It will no longer block calls or e-mail.';
  }
  const number = entry.canonicalKey ?? 'this number';
  return entry.channel === 'all'
    ? `Lift the stop on ${number}? It will no longer block calls or e-mail.`
    : `Lift the do-not-call stop on ${number}? It will no longer block calls.`;
}

export interface ChangeOutcomeProps {
  readonly callLogId: string;
  readonly currentOutcome: CallOutcome;
  readonly corrections?: readonly CallLogCorrection[] | undefined;
  /** The firm's zone, for a callback's day and time. */
  readonly timeZone: string | null;
  /** What the line says before the outcome ("Logged: " on the after-call panel). */
  readonly prefix?: string;
  readonly enabled?: boolean;
  /** A correction or a lift succeeded: the caller reads its history and cards again. */
  onChanged(): void;
  readonly ports?: CorrectionPorts | null;
}

export function ChangeOutcome({
  callLogId,
  currentOutcome,
  corrections,
  timeZone,
  prefix = '',
  enabled = true,
  onChanged,
  ports = registryCorrectionPorts(),
}: ChangeOutcomeProps): JSX.Element {
  const { memory, touch } = useCorrectionMemory();
  const draftPrefix = correctionDraftPrefix(callLogId);
  const [outcomeText, setOutcomeText] = useDraft(`${draftPrefix}outcome`);
  const [base, setBase] = useDraft(`${draftPrefix}base`);
  const [stopChoice, setStopChoice] = useDraft(`${draftPrefix}stop`);
  const [callbackDate, setCallbackDate] = useDraft(`${draftPrefix}cbDate`);
  const [callbackTime, setCallbackTime] = useDraft(`${draftPrefix}cbTime`);
  const [reasonText, setReasonText] = useDraft(`${draftPrefix}reason`);
  const [decisionsText, setDecisionsText] = useDraft(`${draftPrefix}decisions`);
  const draftValues = useDrafts().values;
  const clearDrafts = useClearDrafts();
  const clearUnchanged = useClearUnchangedDrafts();
  const root = useRef<HTMLDivElement>(null);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const portsRef = useRef(ports);
  portsRef.current = ports;

  const open = memory.open.has(callLogId);
  const unanswered = memory.corrections.get(callLogId) ?? null;
  const busy = memory.inFlight.has(callLogId);
  const note = memory.notes.get(callLogId) ?? null;
  const lifts = memory.lifts.get(callLogId) ?? [];

  // K2: the draft remembers the outcome David saw when he opened Change (`base`). When the
  // history's outcome has moved from it — corrected elsewhere, or by a late answer — the draft is
  // dropped rather than sent over the change. The value is the outcome it moved to.
  const [changedElsewhere, setChangedElsewhere] = useState<CallOutcome | null>(null);
  useEffect(() => {
    if (base !== '' && base !== currentOutcome && unanswered === null) {
      clearDrafts(draftPrefix);
      setChangedElsewhere(currentOutcome);
    }
  }, [base, currentOutcome, unanswered, clearDrafts, draftPrefix]);

  const chosen = (CALL_OUTCOMES as readonly string[]).includes(outcomeText) && outcomeText !== currentOutcome ? (outcomeText as CallOutcome) : null;
  const baseOutcome = (CALL_OUTCOMES as readonly string[]).includes(base) ? (base as CallOutcome) : null;

  // The preview, one request per (log, chosen outcome, base David saw, reload, opening), asked only
  // while the review is open. K7: an answer qualifies only for the very request that asked it, so
  // an answer from before the base changed, from an older reload or from an earlier opening never
  // stands in for the current one (review of X2F). The ports are read through a ref, so a caller's
  // new ports object never asks again (review of X2, finding 3).
  interface PreviewRequest {
    readonly callLogId: string;
    readonly outcome: CallOutcome;
    readonly base: CallOutcome;
    readonly reload: number;
  }
  const [preview, setPreview] = useState<{ readonly request: PreviewRequest; readonly view: CorrectionPreviewView } | null>(null);
  const reloadTick = note?.reload ?? 0;
  const canAsk = ports !== null;
  const request = useMemo<PreviewRequest | null>(
    () => (!open || !canAsk || chosen === null || baseOutcome === null ? null : { callLogId, outcome: chosen, base: baseOutcome, reload: reloadTick }),
    [open, canAsk, callLogId, chosen, baseOutcome, reloadTick],
  );
  useEffect(() => {
    const read = portsRef.current;
    if (request === null || read === null) return;
    let current = true;
    void read.preview({ callLogId: request.callLogId, outcome: request.outcome }).then(
      view => {
        if (current) setPreview({ request, view });
      },
      () => {
        if (current) setPreview({ request, view: { preview: null, reason: 'offline' } });
      },
    );
    return () => {
      current = false;
    };
  }, [request]);
  const shown = request !== null && preview !== null && preview.request === request ? preview.view : null;
  const fresh = shown?.preview ?? null;
  // K2 (review of X2, finding 2): a preview that reports another current outcome than the one
  // David saw never rebases the edit. The edit is dropped, "Changed elsewhere" says so, and the
  // caller reads the call again.
  const movedUnder = fresh !== null && baseOutcome !== null && fresh.currentOutcome !== baseOutcome && unanswered === null;
  useEffect(() => {
    if (!movedUnder || fresh === null) return;
    // The mismatched answer is spent: it never qualifies for a later request.
    setPreview(null);
    clearDrafts(draftPrefix);
    setChangedElsewhere(fresh.currentOutcome);
    onChangedRef.current();
  }, [movedUnder, fresh, clearDrafts, draftPrefix]);
  const review = movedUnder ? null : fresh;

  // K4: a navigation key never leaves focus on one of this review's command buttons.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const action = shortcutFor({ key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, target: null });
      if (action !== 'next' && action !== 'previous') return;
      const active = document.activeElement;
      if (active instanceof HTMLButtonElement && root.current?.contains(active) === true) active.blur();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  const decisions = useMemo(() => parseDecisions(decisionsText), [decisionsText]);
  const draft: CorrectionDraft = {
    outcome: chosen ?? currentOutcome,
    doNotCall: doNotCallChoiceKeyOf(stopChoice),
    callbackDate,
    callbackTime,
    reason: reasonText === 'original_error' || reasonText === 'new_information' ? reasonText : null,
    decisions,
  };
  const live = review === null ? {} : decisionsFor(review, decisions);
  const needsReason = review !== null && reasonRequired(review, live);
  const problem = review === null || baseOutcome === null ? null : saveProblem(review, draft, timeZone);
  const locked = busy || unanswered !== null || !enabled;

  const setOpen = (next: boolean): void => {
    if (next) memory.open.add(callLogId);
    else memory.open.delete(callLogId);
    touch();
  };

  const decide = (key: string, decision: CallCorrectionDecision): void => {
    setDecisionsText(JSON.stringify({ ...decisions, [key]: decision }));
  };

  const send = (): void => {
    if (ports === null || busy) return;
    let command: CorrectionCommand;
    const canonicalKeys = new Map((review?.effects ?? []).map(effect => [effect.id, effect.facts.canonicalKey ?? null] as const));
    if (unanswered !== null) command = unanswered;
    else {
      if (review === null || chosen === null || baseOutcome === null) return;
      const body = correctionBody({ callLogId, preview: review, draft, base: baseOutcome, timeZone, commandId: 'draft' });
      if (body === null) return;
      const { commandId: _draftId, ...rest } = body;
      void _draftId;
      command = {
        id: crypto.randomUUID(),
        body: rest,
        drafts: Object.fromEntries(Object.entries(draftValues).filter(([key]) => key.startsWith(draftPrefix))),
      };
      memory.corrections.set(callLogId, command);
    }
    const sent = command;
    memory.inFlight.add(callLogId);
    memory.notes.delete(callLogId);
    touch();
    const settle = (view: CorrectedView | null): void => {
      memory.inFlight.delete(callLogId);
      if (memory.corrections.get(callLogId) !== sent) {
        touch();
        return;
      }
      const reason = view?.reason ?? 'offline';
      if (view === null || (view.corrected === null && noDefiniteAnswer(reason))) {
        // No definite answer: everything stays, and so does the command, for Retry.
        memory.notes.set(callLogId, { text: 'The answer was lost. Retry sends the same request again.', alert: true });
        touch();
        return;
      }
      memory.corrections.delete(callLogId);
      if (view.corrected !== null) {
        const corrected = view.corrected;
        clearUnchanged(sent.drafts);
        memory.open.delete(callLogId);
        memory.notes.set(callLogId, { text: `Changed to ${OUTCOME_LABELS[corrected.outcome]}.`, alert: false });
        if (corrected.liftNext.length > 0) {
          memory.lifts.set(
            callLogId,
            corrected.liftNext.map(lift => ({ eventId: lift.eventId, scope: lift.scope, channel: lift.channel, canonicalKey: canonicalKeys.get(lift.eventId) ?? null })),
          );
        }
        touch();
        onChangedRef.current();
        return;
      }
      // A refusal wrote nothing. A review that went stale is read again: the decisions are
      // cleared (never carried to a different set). The base stays the outcome David saw, so a
      // stale outcome drops the edit as "Changed elsewhere" once the new outcome is read (K2),
      // while changed effects keep the chosen outcome.
      const reload = view.reason !== null && RELOAD_REFUSALS.has(view.reason);
      if (reload) {
        clearUnchanged({
          [`${draftPrefix}decisions`]: sent.drafts[`${draftPrefix}decisions`] ?? '',
          [`${draftPrefix}reason`]: sent.drafts[`${draftPrefix}reason`] ?? '',
        });
      }
      memory.notes.set(callLogId, { text: refusalSentence(view.reason), alert: true, ...(reload ? { reload: Date.now() } : {}) });
      touch();
      if (reload) onChangedRef.current();
    };
    void ports.correct({ ...sent.body, commandId: sent.id }).then(settle, () => {
      settle(null);
    });
  };

  const lift = lifts[0];
  const liftBusy = lift !== undefined && memory.inFlight.has(`lift:${lift.eventId}`);
  const confirmLift = (entry: LiftEntry): void => {
    if (ports === null || memory.inFlight.has(`lift:${entry.eventId}`)) return;
    const commandId = memory.liftCommands.get(entry.eventId) ?? crypto.randomUUID();
    memory.liftCommands.set(entry.eventId, commandId);
    memory.liftNotes.delete(entry.eventId);
    memory.inFlight.add(`lift:${entry.eventId}`);
    touch();
    const settle = (answer: { readonly lifted: boolean; readonly reason: string | null } | null): void => {
      memory.inFlight.delete(`lift:${entry.eventId}`);
      if (memory.liftCommands.get(entry.eventId) !== commandId) {
        touch();
        return;
      }
      if (answer === null || (!answer.lifted && noDefiniteAnswer(answer.reason))) {
        memory.liftNotes.set(entry.eventId, 'The answer was lost. Lift again sends the same request.');
        touch();
        return;
      }
      memory.liftCommands.delete(entry.eventId);
      if (answer.lifted) {
        // K6: this confirm is consumed by its own success answer.
        memory.lifts.set(callLogId, (memory.lifts.get(callLogId) ?? []).filter(other => other.eventId !== entry.eventId));
        memory.notes.set(callLogId, { text: 'Stop lifted.', alert: false });
        touch();
        onChangedRef.current();
        return;
      }
      // K5: a refusal keeps the same confirm open, with the reason. The stop stays.
      memory.liftNotes.set(entry.eventId, liftRefusalSentence(answer.reason));
      touch();
    };
    void ports.supersede({ eventId: entry.eventId, commandId }).then(settle, () => {
      settle(null);
    });
  };
  const cancelLift = (entry: LiftEntry): void => {
    memory.lifts.set(callLogId, (memory.lifts.get(callLogId) ?? []).filter(other => other.eventId !== entry.eventId));
    memory.liftNotes.delete(entry.eventId);
    memory.liftCommands.delete(entry.eventId);
    memory.notes.set(callLogId, { text: 'The stop stays.', alert: false });
    touch();
  };

  const conflicting = review === null ? [] : conflictingEffects(review);
  const collapsed = review === null ? [] : collapsedEffects(review);

  return (
    <div ref={root} data-testid="change-outcome" data-log={callLogId} className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span data-testid="change-outcome-current" className="text-sm">
          {prefix}
          {correctedLine(currentOutcome, corrections)}
        </span>
        {ports === null ? null : (
          <Button
            variant="ghost"
            data-testid="change-outcome-toggle"
            aria-expanded={open}
            className={cn(dense.sm, 'text-muted-foreground')}
            disabled={!enabled}
            onClick={() => {
              setChangedElsewhere(null);
              // K2: the edit's base is the outcome shown when Change opens.
              if (!open && base === '') setBase(currentOutcome);
              setOpen(!open);
            }}
          >
            Change
          </Button>
        )}
      </div>

      {changedElsewhere !== null && open ? (
        <p data-testid="change-outcome-changed-elsewhere" role="status" className="text-xs text-muted-foreground">
          Changed elsewhere. The outcome is now {OUTCOME_LABELS[changedElsewhere]}. Reloaded; choose again.
        </p>
      ) : null}

      {open ? (
        <div
          data-testid="change-outcome-review"
          className="flex flex-col gap-2 rounded-md border border-border p-2"
          onKeyDown={event => {
            // C0: Escape closes the review and keeps the draft.
            if (event.key === 'Escape') {
              event.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">What actually happened</span>
            <Select
              data-testid="change-outcome-select"
              disabled={locked}
              value={chosen ?? ''}
              onChange={event => {
                if (base === '') setBase(currentOutcome);
                setOutcomeText(event.target.value);
              }}
            >
              <option value="">Choose…</option>
              {CALL_OUTCOMES.map(value => (
                <option key={value} value={value} disabled={value === currentOutcome}>
                  {OUTCOME_LABELS[value]}
                  {value === currentOutcome ? ' (current)' : ''}
                </option>
              ))}
            </Select>
          </label>

          {chosen === 'do_not_call' ? (
            <StopChoice testId="change-outcome-stop" value={doNotCallChoiceKeyOf(stopChoice)} disabled={locked} onChange={next => setStopChoice(next)} />
          ) : null}

          {chosen === 'callback_requested' ? (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">{review?.callbackTimeRequired === true ? 'Callback (required)' : 'Callback (optional)'}</span>
              <Input aria-label="Callback day" data-testid="change-outcome-cb-date" type="date" className="h-7 w-36 text-xs" disabled={locked} value={callbackDate} onChange={event => setCallbackDate(event.target.value)} />
              <Input aria-label="Callback time" data-testid="change-outcome-cb-time" type="time" className="h-7 w-24 text-xs" disabled={locked} value={callbackTime} onChange={event => setCallbackTime(event.target.value)} />
              <span className="text-muted-foreground">{timeZone ?? ''}</span>
            </div>
          ) : null}

          {chosen !== null && shown === null ? (
            <p data-testid="change-outcome-loading" className="text-xs text-muted-foreground">
              Checking what this call changed…
            </p>
          ) : null}
          {shown !== null && review === null ? (
            <p data-testid="change-outcome-preview-problem" role="alert" className="text-xs text-danger-ink">
              {refusalSentence(shown.reason)}
            </p>
          ) : null}

          {review === null ? null : (
            <>
              {conflicting.length === 0 ? null : (
                <ul data-testid="change-outcome-conflicts" className="flex flex-col">
                  {conflicting.map(effect => {
                    const key = effectKey(effect);
                    const why = effectWhy(effect);
                    return (
                      <li key={key} data-testid="change-outcome-effect" data-kind={effect.kind} className="flex flex-col gap-1 border-b border-border py-1.5 last:border-b-0">
                        <span className="text-sm">{effectSentence(effect)}</span>
                        {why === null ? null : <span className="text-xs text-muted-foreground">{why}</span>}
                        <div role="radiogroup" aria-label={effectSentence(effect)} className="flex gap-1.5">
                          {effect.decisions.map(decision => (
                            <Button
                              key={decision}
                              variant={live[key] === decision ? 'default' : 'outline'}
                              role="radio"
                              aria-checked={live[key] === decision}
                              data-testid={`change-outcome-decide-${decision}`}
                              className={dense.sm}
                              disabled={locked}
                              onClick={() => decide(key, decision)}
                            >
                              {decisionLabel(effect, decision)}
                            </Button>
                          ))}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {collapsed.length === 0 && review.alsoHappens.length === 0 ? null : (
                <details data-testid="change-outcome-collapsed" className="text-xs text-muted-foreground">
                  <summary className="cursor-default">
                    {collapsed.length === 1 ? '1 other thing stays as it is' : `${String(collapsed.length)} other things stay as they are`}
                    {review.alsoHappens.length === 0 ? '' : ' · also happens'}
                  </summary>
                  <ul className="flex flex-col gap-0.5 pt-1">
                    {collapsed.map(effect => (
                      <li key={effectKey(effect)}>{effectSentence(effect)}</li>
                    ))}
                    {review.alsoHappens.map(code => (
                      <li key={code} data-testid="change-outcome-also">
                        Also happens: {ALSO_HAPPENS_SENTENCES[code]}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {needsReason ? (
                <div role="radiogroup" aria-label="Why did the outcome change?" data-testid="change-outcome-reason" className="flex flex-wrap gap-1.5">
                  {(['original_error', 'new_information'] as const satisfies readonly CallCorrectionReason[]).map(reason => (
                    <Button
                      key={reason}
                      variant={draft.reason === reason ? 'default' : 'outline'}
                      role="radio"
                      aria-checked={draft.reason === reason}
                      data-testid={`change-outcome-reason-${reason}`}
                      className={dense.sm}
                      disabled={locked}
                      onClick={() => setReasonText(reason)}
                    >
                      {REASON_LABELS[reason]}
                    </Button>
                  ))}
                </div>
              ) : null}
            </>
          )}

          <div className="flex items-center gap-2">
            <Button
              data-testid="change-outcome-save"
              className={dense.md}
              disabled={busy || !enabled || (unanswered === null && (review === null || baseOutcome === null || problem !== null))}
              {...(busy ? { 'aria-busy': true } : {})}
              onClick={send}
            >
              {unanswered === null ? 'Save' : 'Retry'}
            </Button>
            <span className="text-xs text-faint">Esc to close</span>
          </div>
          {unanswered === null && review !== null && problem !== null ? (
            <p data-testid="change-outcome-problem" className="text-xs text-muted-foreground">
              {SAVE_PROBLEM_SENTENCES[problem]}
            </p>
          ) : null}
        </div>
      ) : null}

      {note === null ? null : (
        <p data-testid="change-outcome-note" role={note.alert ? 'alert' : 'status'} className={cn('text-xs', note.alert ? 'text-danger-ink' : 'text-muted-foreground')}>
          {note.text}
        </p>
      )}

      {lift === undefined ? null : (
        <div data-testid="lift-confirm" data-event={lift.eventId} role="alertdialog" aria-label="Lift the stop" className="flex flex-col gap-1.5 rounded-md border border-border p-2">
          <p className="text-sm">{liftSentence(lift)}</p>
          <div className="flex gap-2">
            <Button data-testid="lift-confirm-yes" className={dense.md} disabled={liftBusy} {...(liftBusy ? { 'aria-busy': true } : {})} onClick={() => confirmLift(lift)}>
              {memory.liftCommands.has(lift.eventId) && !liftBusy ? 'Lift again' : 'Lift stop'}
            </Button>
            <Button variant="ghost" data-testid="lift-confirm-no" className={dense.md} disabled={liftBusy} onClick={() => cancelLift(lift)}>
              Keep the stop
            </Button>
          </div>
          {memory.liftNotes.get(lift.eventId) === undefined ? null : (
            <p data-testid="lift-note" role="alert" className="text-xs text-danger-ink">
              {memory.liftNotes.get(lift.eventId)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
