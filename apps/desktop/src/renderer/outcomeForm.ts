import { CALL_OUTCOMES, type CallOutcome } from '@fss/contracts';

/**
 * The call outcome form, as a pure model (specification 9.1, 14.2).
 *
 * Ported from `client/src/renderer/today/outcomeModel.ts`, which had the right
 * shape: what the buttons say, what a draft must carry before it can be recorded,
 * and the command one draft becomes. No React and no IPC here, so every rule below
 * is a unit test rather than a screenshot.
 *
 * Three things changed in the port.
 *
 * **The outcomes are the specification's, not the old build's ten.** The old list
 * had `gatekeeper`, `requested_info` and `answered_interested`; revision 3's table
 * in 9.1 has ten rows once "no answer or busy" is split into the two words a person
 * would press, and `@fss/contracts` owns them so the button and the column cannot
 * drift.
 *
 * **A callback needs an instant, not a day.** The old form took a date and let the
 * worker decide the time. Appendix D stores "requested local date/time, source zone,
 * resolved UTC instant, all stored", and 9.1 creates the callback only "after
 * salesperson confirmation of the instant" — so the draft carries all four and the
 * form refuses to record a callback without them.
 *
 * **"Never call this firm" is a scope, not a checkbox.** 9.1 suppresses the number
 * always and the firm "only when the request covers all Callie contact", so the
 * draft says which, and the warning sentence changes with it. The old build's single
 * checkbox could only ever suppress the firm.
 */

export const OUTCOME_LABELS: Readonly<Record<CallOutcome, string>> = Object.freeze({
  interested: 'Interested',
  referral_or_wrong_person: 'Referral or wrong person',
  callback_requested: 'Callback requested',
  not_interested: 'Not interested',
  do_not_call: 'Asked not to be called',
  wrong_number: 'Wrong number',
  voicemail_left: 'Voicemail left',
  no_answer: 'No answer',
  busy: 'Busy',
  policy_or_technical_failure: 'Could not place the call',
});

/** The buttons, in the order the form shows them: the conversations first. */
export const OUTCOME_ORDER: readonly CallOutcome[] = Object.freeze([...CALL_OUTCOMES]);

export const NOTE_MAX = 2000;

export interface OutcomeDraft {
  readonly outcome: CallOutcome | null;
  readonly note: string;
  /** `YYYY-MM-DD` in the firm's own zone. Empty until a day is picked. */
  readonly callbackLocalDate: string;
  /** `HH:MM`, 24-hour, in the firm's own zone. */
  readonly callbackLocalTime: string;
  /** The firm's IANA zone, from the card. The form never guesses one. */
  readonly callbackTimeZone: string;
  /** The UTC instant the local date and time resolve to, computed and shown back. */
  readonly callbackDueAt: string;
  /** True only when the person said the request covered every kind of contact. */
  readonly doNotCallCoversAllContact: boolean;
}

export const emptyOutcomeDraft = (): OutcomeDraft => ({
  outcome: null,
  note: '',
  callbackLocalDate: '',
  callbackLocalTime: '',
  callbackTimeZone: '',
  callbackDueAt: '',
  doNotCallCoversAllContact: false,
});

export type OutcomeProblem =
  | 'outcome_missing'
  | 'note_too_long'
  | 'callback_date_missing'
  | 'callback_date_invalid'
  | 'callback_time_invalid'
  | 'callback_zone_missing'
  | 'callback_instant_unconfirmed';

export const OUTCOME_PROBLEM_SENTENCES: Readonly<Record<OutcomeProblem, string>> = Object.freeze({
  outcome_missing: 'Pick what happened on the call.',
  note_too_long: `A note is at most ${String(NOTE_MAX)} characters.`,
  callback_date_missing: 'A callback needs the day you promised.',
  callback_date_invalid: 'That is not a day: use the date field.',
  callback_time_invalid: 'That is not a time of day: use 24-hour HH:MM.',
  callback_zone_missing: 'A callback needs the firm’s time zone, and this card has none.',
  callback_instant_unconfirmed: 'Confirm the exact moment of the callback before recording it.',
});

const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/u;

/** What stops this draft from being recorded, or null. Pure. */
export function outcomeProblem(draft: OutcomeDraft): OutcomeProblem | null {
  if (draft.outcome === null) return 'outcome_missing';
  if (draft.note.length > NOTE_MAX) return 'note_too_long';
  if (draft.outcome !== 'callback_requested') return null;

  const date = draft.callbackLocalDate.trim();
  if (date.length === 0) return 'callback_date_missing';
  if (!DATE.test(date) || !Number.isFinite(Date.parse(date))) return 'callback_date_invalid';
  const time = draft.callbackLocalTime.trim();
  if (time.length > 0 && !TIME.test(time)) return 'callback_time_invalid';
  if (draft.callbackTimeZone.trim().length === 0) return 'callback_zone_missing';
  // 9.1: the callback is created "after salesperson confirmation of the instant".
  // An unresolved instant is an unconfirmed one, and the form will not record it.
  if (!Number.isFinite(Date.parse(draft.callbackDueAt))) return 'callback_instant_unconfirmed';
  return null;
}

/** Whether recording this draft writes a suppression, and how wide. */
export function outcomeSuppresses(draft: OutcomeDraft): 'none' | 'number' | 'firm' {
  if (draft.outcome !== 'do_not_call') return 'none';
  return draft.doNotCallCoversAllContact ? 'firm' : 'number';
}

export const SUPPRESSION_WARNINGS: Readonly<Record<'number' | 'firm', string>> = Object.freeze({
  number: 'Recording this stops Callie calling this number. It does not stop email or another number at the firm.',
  firm: 'Recording this stops Callie contacting this firm by any means. Only an admin can undo it, and only with a documented reason.',
});

export interface LogCallCommand {
  readonly commandId: string;
  readonly clientVersion: string;
  readonly firmId: string;
  readonly contactId?: string;
  readonly routeId?: string;
  readonly ticketId?: string;
  readonly outcome: CallOutcome;
  readonly occurredAt: string;
  readonly note?: string;
  readonly retryBehaviour?: 'advance' | 'retry_call';
  readonly callback?: {
    readonly localDate: string;
    readonly localTime?: string;
    readonly dueAt: string;
    readonly sourceTimeZone: string;
  };
  readonly doNotCallCoversAllContact?: boolean;
}

export interface LogCallCommandInput {
  readonly commandId: string;
  readonly clientVersion: string;
  readonly firmId: string;
  readonly contactId?: string | undefined;
  readonly routeId?: string | undefined;
  /** The ticket the call was placed with, when there was one. History is recorded either way. */
  readonly ticketId?: string | undefined;
  readonly occurredAt: string;
  readonly draft: OutcomeDraft;
}

/**
 * The command one draft becomes, or the problem that stops it.
 *
 * `commandId` is the caller's, minted once per attempt and reused on a retry, so a
 * lost answer never records the call twice — the same rule the old build had, and
 * now the receipt in 5.3 enforces it rather than the client's good intentions.
 */
export function logCallCommand(
  input: LogCallCommandInput,
): { readonly command: LogCallCommand } | { readonly problem: OutcomeProblem } {
  const problem = outcomeProblem(input.draft);
  if (problem !== null) return { problem };
  const outcome = input.draft.outcome;
  if (outcome === null) return { problem: 'outcome_missing' };

  const note = input.draft.note.trim();
  const time = input.draft.callbackLocalTime.trim();
  return {
    command: {
      commandId: input.commandId,
      clientVersion: input.clientVersion,
      firmId: input.firmId,
      ...(input.contactId === undefined ? {} : { contactId: input.contactId }),
      ...(input.routeId === undefined ? {} : { routeId: input.routeId }),
      ...(input.ticketId === undefined ? {} : { ticketId: input.ticketId }),
      outcome,
      occurredAt: input.occurredAt,
      ...(note.length > 0 ? { note } : {}),
      ...(outcome === 'callback_requested'
        ? {
            callback: {
              localDate: input.draft.callbackLocalDate.trim(),
              ...(time.length > 0 ? { localTime: time } : {}),
              dueAt: input.draft.callbackDueAt,
              sourceTimeZone: input.draft.callbackTimeZone.trim(),
            },
          }
        : {}),
      ...(outcome === 'do_not_call'
        ? { doNotCallCoversAllContact: input.draft.doNotCallCoversAllContact }
        : {}),
    },
  };
}
