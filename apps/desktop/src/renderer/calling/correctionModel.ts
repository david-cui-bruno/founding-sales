import {
  callbackInstant,
  type CallCorrectionDecision,
  type CallCorrectionEffect,
  type CallCorrectionReason,
  type CallLogCorrection,
  type CallOutcome,
  type CorrectionPreviewResponse,
} from '@fss/contracts';
import type { CorrectOutcomeInput } from '../../shared/operations.ts';
import { DO_NOT_CALL_CHOICES, OUTCOME_LABELS, type DoNotCallChoiceKey } from '../outcomeForm.ts';

/**
 * The pure half of "Change outcome" (S3X lane X2; DESIGN-S3X §3.6), so the rules are tested
 * rather than claimed:
 *
 *   * every **conflicting** effect needs David's decision, and **nothing is preselected**: a
 *     decision exists only once he clicked it (P3);
 *   * the reason ("The suggestion was wrong" / "Something new came up later") is asked exactly
 *     when §3.7's rule needs it — the outcome came from an applied suggestion, or he chose Undo
 *     or Lift stop… on an effect whose `appliedKey` is set — and appears or disappears as he
 *     decides;
 *   * the body carries only what he chose: the outcome he picked against the outcome the
 *     review was based on (`expectedOutcome`), and one decision per effect of the set he saw.
 */

/** One effect's identity in the review: what the server compares the echo by. */
export const effectKey = (effect: { readonly kind: string; readonly id: string; readonly state: string }): string =>
  `${effect.kind}:${effect.id}:${effect.state}`;

export const conflictingEffects = (preview: CorrectionPreviewResponse): readonly CallCorrectionEffect[] =>
  preview.effects.filter(effect => effect.conflicts);

export const collapsedEffects = (preview: CorrectionPreviewResponse): readonly CallCorrectionEffect[] =>
  preview.effects.filter(effect => !effect.conflicts);

/** David's decisions by effect key. A key that is absent is a decision not yet made. */
export type Decisions = Readonly<Record<string, CallCorrectionDecision>>;

/** The decisions that still belong to this review: any for an effect it no longer has are dropped. */
export function decisionsFor(preview: CorrectionPreviewResponse, decisions: Decisions): Decisions {
  const kept: Record<string, CallCorrectionDecision> = {};
  for (const effect of conflictingEffects(preview)) {
    const decision = decisions[effectKey(effect)];
    if (decision !== undefined && effect.decisions.includes(decision)) kept[effectKey(effect)] = decision;
  }
  return kept;
}

/** §3.7: the reason is required iff the outcome or an undone/lifted effect came from an applied suggestion. */
export function reasonRequired(preview: CorrectionPreviewResponse, decisions: Decisions): boolean {
  if (preview.outcomeAppliedKey !== null) return true;
  return conflictingEffects(preview).some(effect => {
    const decision = decisions[effectKey(effect)];
    return effect.appliedKey !== null && (decision === 'undo' || decision === 'lift');
  });
}

export interface CorrectionDraft {
  readonly outcome: CallOutcome;
  readonly doNotCall: DoNotCallChoiceKey;
  /** `YYYY-MM-DD` in the firm's zone; empty for none. */
  readonly callbackDate: string;
  readonly callbackTime: string;
  readonly reason: CallCorrectionReason | null;
  readonly decisions: Decisions;
}

export type SaveProblem =
  | 'decision_missing'
  | 'reason_missing'
  | 'callback_time_required'
  | 'callback_zone_missing'
  | 'callback_date_invalid'
  | 'callback_time_invalid';

export const SAVE_PROBLEM_SENTENCES: Readonly<Record<SaveProblem, string>> = Object.freeze({
  decision_missing: 'Choose what happens to each item above.',
  reason_missing: 'Say why the outcome changed.',
  callback_time_required: 'This call already had its callback: set the new callback’s day.',
  callback_zone_missing: 'A callback needs the firm’s time zone, and this firm has none.',
  callback_date_invalid: 'That is not a day: use the date field.',
  callback_time_invalid: 'That is not a time of day: use 24-hour HH:MM.',
});

const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/u;

/** What stops Save, or null. Pure. */
export function saveProblem(preview: CorrectionPreviewResponse, draft: CorrectionDraft, timeZone: string | null): SaveProblem | null {
  const decisions = decisionsFor(preview, draft.decisions);
  if (conflictingEffects(preview).some(effect => decisions[effectKey(effect)] === undefined)) return 'decision_missing';
  if (reasonRequired(preview, decisions) && draft.reason === null) return 'reason_missing';
  if (draft.outcome === 'callback_requested') {
    const date = draft.callbackDate.trim();
    const time = draft.callbackTime.trim();
    if (date === '' && time === '') return preview.callbackTimeRequired ? 'callback_time_required' : null;
    if (!DATE.test(date)) return 'callback_date_invalid';
    if (time !== '' && !TIME.test(time)) return 'callback_time_invalid';
    if (timeZone === null || timeZone === '') return 'callback_zone_missing';
    if (callbackInstant(date, time, timeZone) === null) return 'callback_date_invalid';
  }
  return null;
}

/** The one request Save sends. Null while `saveProblem` has something to say. */
export function correctionBody(input: {
  readonly callLogId: string;
  readonly preview: CorrectionPreviewResponse;
  readonly draft: CorrectionDraft;
  readonly timeZone: string | null;
  readonly commandId: string;
}): CorrectOutcomeInput | null {
  const { preview, draft } = input;
  if (saveProblem(preview, draft, input.timeZone) !== null) return null;
  const decisions = decisionsFor(preview, draft.decisions);
  const needsReason = reasonRequired(preview, decisions);
  const date = draft.callbackDate.trim();
  const time = draft.callbackTime.trim();
  const zone = input.timeZone ?? '';
  const dueAt = draft.outcome === 'callback_requested' && date !== '' ? callbackInstant(date, time, zone) : null;
  return {
    commandId: input.commandId,
    callLogId: input.callLogId,
    expectedOutcome: preview.currentOutcome,
    outcome: draft.outcome,
    ...(needsReason && draft.reason !== null ? { reason: draft.reason } : {}),
    ...(draft.outcome === 'do_not_call' ? { doNotCall: DO_NOT_CALL_CHOICES[draft.doNotCall].choice } : {}),
    ...(dueAt !== null
      ? { callback: { localDate: date, ...(time === '' ? {} : { localTime: time }), dueAt, sourceTimeZone: zone } }
      : {}),
    effects: conflictingEffects(preview).map(effect => ({
      kind: effect.kind,
      id: effect.id,
      state: effect.state,
      decision: decisions[effectKey(effect)] as CallCorrectionDecision,
    })),
  };
}

const shortDay = (value: string | undefined): string =>
  value === undefined ? '' : new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** One effect as the review row says it. Facts only; never a raw code. */
export function effectSentence(effect: CallCorrectionEffect): string {
  const facts = effect.facts;
  switch (effect.kind) {
    case 'callback':
      return effect.state === 'open'
        ? `The callback on ${shortDay(facts.dueAt)}`
        : effect.state === 'completed'
          ? `The callback on ${shortDay(facts.dueAt)} was made`
          : `The callback on ${shortDay(facts.dueAt)} was cancelled`;
    case 'task':
      return effect.state === 'open' ? `The task “${facts.text ?? ''}”` : `The task “${facts.text ?? ''}” is ${effect.state === 'done' ? 'done' : 'cancelled'}`;
    case 'stop': {
      const what = facts.channel === 'all' ? 'all contact' : facts.channel === 'email' ? 'e-mail' : 'calls';
      return facts.scope === 'firm' ? `The stop on ${what} with this firm` : `The stop on ${what} to ${facts.canonicalKey ?? 'this number'}`;
    }
    case 'permission':
      return effect.state === 'consumed'
        ? `The permission to e-mail them (already sent on ${shortDay(facts.consumedAt)})`
        : effect.state === 'revoked'
          ? 'The permission to e-mail them was revoked'
          : 'The permission to e-mail them';
    case 'agreement':
      return 'The follow-up they agreed to on this call';
    case 'park':
      return 'Calling paused after the unanswered attempts';
    case 'analysis_park':
      return 'Calling paused because they asked';
    case 'route':
      return 'The number was retired as a wrong number';
    case 'deal':
      return 'A deal was opened from this call. Manage it on the board.';
    case 'history':
      return 'What the call did when it was logged (manual mode, ended sequences)';
  }
}

/** Why an effect conflicts, in one line under it. */
export function effectWhy(effect: CallCorrectionEffect): string | null {
  switch (effect.kind) {
    case 'permission':
    case 'agreement':
      return 'Consent needs a person who was reached, so it is revoked.';
    case 'route':
      return 'A retired number cannot be brought back here; add it again in the firm’s details.';
    case 'stop':
      return 'Lifting it is a separate step you confirm after saving.';
    default:
      return null;
  }
}

export function decisionLabel(effect: CallCorrectionEffect, decision: CallCorrectionDecision): string {
  if (effect.kind === 'stop') return decision === 'lift' ? 'Lift stop…' : 'Keep stop';
  if (effect.kind === 'permission' || effect.kind === 'agreement') return 'Revoke the permission (required)';
  if (effect.kind === 'park') return decision === 'undo' ? 'Resume calling' : 'Keep paused';
  if (effect.kind === 'callback') return decision === 'undo' ? 'Cancel it' : 'Keep it';
  return decision === 'undo' ? 'Undo' : 'Keep';
}

export const ALSO_HAPPENS_SENTENCES: Readonly<Record<CorrectionPreviewResponse['alsoHappens'][number], string>> = Object.freeze({
  manual_mode: 'The deal goes to manual and running sequences at the firm stop.',
  stop_recorded: 'The stop you choose is recorded.',
  route_retired: 'The number is retired.',
  cadence_checked: 'The firm is paused if this was its last allowed try.',
  callback_scheduled: 'The callback is created.',
  callback_needs_time: 'Without a time, “Callback — needs a time” goes on Today.',
  suggest_lost: 'Lost is suggested on the board; nothing is closed.',
});

export const REASON_LABELS: Readonly<Record<CallCorrectionReason, string>> = Object.freeze({
  original_error: 'The suggestion was wrong',
  new_information: 'Something new came up later',
});

/** The refusals that mean "this call changed since you opened it": reload, keep the outcome, clear the decisions. */
export const RELOAD_REFUSALS: ReadonlySet<string> = new Set(['effects_changed', 'stale_outcome']);

const REFUSAL_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  effects_changed: 'This call changed since you opened it. Reloaded.',
  stale_outcome: 'This call changed since you opened it. Reloaded.',
  outcome_unchanged: 'That is already the outcome.',
  outcome_not_correctable: 'An incoming call was answered, so it cannot be marked unanswered.',
  route_not_named: 'This call has no number to stop or retire.',
  reason_required: 'Say why the outcome changed.',
  stop_needs_admin: 'Only an administrator can lift a stop. Keep it, or ask one.',
  callback_time_required: 'This call already had its callback: set the new callback’s day.',
  callback_instant_mismatch: 'That callback time is not what the firm’s clock says. Check the day and time.',
  not_call_actor: 'Only the person who made the call can change its outcome.',
  not_assigned: 'This firm is someone else’s.',
  call_log_unknown: 'Callie cannot find that call.',
  journal_unavailable: 'The stop could not be recorded just now. Nothing was changed; try again.',
  offline: 'Callie is offline. Nothing was changed.',
  invalid_input: 'Callie could not make that change. Nothing was changed.',
});

export function refusalSentence(reason: string | null): string {
  return REFUSAL_SENTENCES[reason ?? ''] ?? 'Callie could not change the outcome. Nothing was changed.';
}

const LIFT_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  admin_only: 'Only an administrator can lift a stop. It stays.',
  already_superseded: 'That stop was already lifted.',
  offline: 'Callie is offline. The stop stays.',
});

export function liftRefusalSentence(reason: string | null): string {
  return LIFT_REFUSALS[reason ?? ''] ?? 'The stop could not be lifted. It stays.';
}

/** "Interested · corrected from No answer, 2 Oct", from the log's corrections. */
export function correctedLine(outcome: CallOutcome, corrections: readonly CallLogCorrection[] | undefined): string {
  const last = corrections?.at(-1);
  if (last === undefined) return OUTCOME_LABELS[outcome];
  const first = corrections?.[0];
  return `${OUTCOME_LABELS[outcome]} · corrected from ${OUTCOME_LABELS[first?.from ?? last.from]}, ${shortDay(last.at)}`;
}
