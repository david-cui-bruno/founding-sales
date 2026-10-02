import { CALL_OUTCOMES, DEFAULT_DO_NOT_CALL_CHOICE, callbackInstant, type CallOutcome, type DoNotCallChoice } from '@fss/contracts';

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
 * salesperson confirmation of the instant" — so the draft carries all four, resolved
 * through the domain's own calendar clock (`callbackInstant`, lane g79), and the form
 * shows the instant back before it is recorded.
 *
 * **"Call me back" with no day is still a call (lane g79, audit C13).** 9.1 also says
 * call logging "never refuses history". A callback request with no day is recorded;
 * the server puts "Callback — needs a time" on Today, where the time is set later. A
 * *time* with no day, or a day that is not one, is still a mistake the form stops.
 *
 * **"Never call this firm" is a scope, not a checkbox.** 9.1 suppresses the number
 * always and the firm "only when the request covers all Callie contact", so the
 * draft says which, and the warning sentence changes with it. The old build's single
 * checkbox could only ever suppress the firm.
 *
 * **There is no ticket on the command since 1.0.12.** `POST /dial/authorize` and
 * `POST /dial/consume` are no longer called: the Mac reads `POST /dial/check`, opens the
 * URI the advice carried and logs the call afterwards, and `POST /calls/log` never
 * needed a ticket or a calling identity to record history.
 */

export const OUTCOME_LABELS: Readonly<Record<CallOutcome, string>> = Object.freeze({
  // Slice 3a: "Interested" claimed more than a conversation proved. Opening a deal is the
  // buying-signal suggestion's own tick, not this outcome.
  interested: 'Conversation',
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

/**
 * The outcomes of a call that reached a named person, the ones an e-mail follow-up may be
 * agreed on (B2, migration 0036). Never `do_not_call`, never a voicemail or a miss.
 */
export const REACHED_OUTCOMES: readonly CallOutcome[] = Object.freeze([
  'interested',
  'callback_requested',
  'referral_or_wrong_person',
  'not_interested',
]);

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
  /**
   * Unused since lane g79 and kept so a draft built by older code still type-checks:
   * the instant is `resolvedCallbackInstant(draft)`, the domain's own resolution.
   */
  readonly callbackDueAt: string;
  /**
   * What a "Do not call" stops (migration 0037, David's P1): one of the four choices in
   * `DO_NOT_CALL_CHOICES`. The default is calls to this person; never inferred.
   */
  readonly doNotCall: DoNotCallChoiceKey;
}

export const emptyOutcomeDraft = (): OutcomeDraft => ({
  outcome: null,
  note: '',
  callbackLocalDate: '',
  callbackLocalTime: '',
  callbackTimeZone: '',
  callbackDueAt: '',
  doNotCall: 'contact_phone',
});

/**
 * The four answers to "what did they ask Callie to stop?" for a "Do not call" (P1). Calls to
 * this person is the default: an explicit "don't contact me again" is a different choice,
 * and keeping e-mail open grants no permission to send any (consent is unchanged).
 */
export const DO_NOT_CALL_CHOICE_KEYS = ['contact_phone', 'contact_all', 'firm_phone', 'firm_all'] as const;
export type DoNotCallChoiceKey = (typeof DO_NOT_CALL_CHOICE_KEYS)[number];

export const DO_NOT_CALL_CHOICES: Readonly<Record<DoNotCallChoiceKey, { readonly label: string; readonly choice: DoNotCallChoice }>> =
  Object.freeze({
    contact_phone: { label: 'Calls to this person', choice: { scope: 'contact', channel: 'phone' } },
    contact_all: { label: 'All contact with this person', choice: { scope: 'contact', channel: 'all' } },
    firm_phone: { label: 'Calls to anyone at this firm', choice: { scope: 'firm', channel: 'phone' } },
    firm_all: { label: 'All contact with this firm', choice: { scope: 'firm', channel: 'all' } },
  });

/** A kept draft value read back as a choice: anything unknown is the default, calls to this person. */
export function doNotCallChoiceKeyOf(value: string): DoNotCallChoiceKey {
  return (DO_NOT_CALL_CHOICE_KEYS as readonly string[]).includes(value) ? (value as DoNotCallChoiceKey) : 'contact_phone';
}

/** Whether a choice is the default one, which a client need not send. */
export function isDefaultDoNotCall(key: DoNotCallChoiceKey): boolean {
  const choice = DO_NOT_CALL_CHOICES[key].choice;
  return choice.scope === DEFAULT_DO_NOT_CALL_CHOICE.scope && choice.channel === DEFAULT_DO_NOT_CALL_CHOICE.channel;
}

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
  callback_date_missing: 'A callback time needs the day you promised.',
  callback_date_invalid: 'That is not a day: use the date field.',
  callback_time_invalid: 'That is not a time of day: use 24-hour HH:MM.',
  callback_zone_missing: 'A callback needs the firm’s time zone, and this card has none.',
  callback_instant_unconfirmed: 'Confirm the exact moment of the callback before recording it.',
});

const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/u;

/**
 * The UTC instant a callback draft's day, time and zone resolve to, or null. The same
 * function the server checks the instant with, so what the form shows is what is
 * stored (C18).
 */
export function resolvedCallbackInstant(draft: OutcomeDraft): string | null {
  const date = draft.callbackLocalDate.trim();
  const zone = draft.callbackTimeZone.trim();
  if (date.length === 0 || zone.length === 0) return null;
  return callbackInstant(date, draft.callbackLocalTime.trim(), zone);
}

/** A callback request with no day: recorded, with "Callback — needs a time" on Today. */
export function callbackNeedsTime(draft: OutcomeDraft): boolean {
  return (
    draft.outcome === 'callback_requested' &&
    draft.callbackLocalDate.trim().length === 0 &&
    draft.callbackLocalTime.trim().length === 0
  );
}

/** What stops this draft from being recorded, or null. Pure. */
export function outcomeProblem(draft: OutcomeDraft): OutcomeProblem | null {
  if (draft.outcome === null) return 'outcome_missing';
  if (draft.note.length > NOTE_MAX) return 'note_too_long';
  if (draft.outcome !== 'callback_requested') return null;

  const date = draft.callbackLocalDate.trim();
  const time = draft.callbackLocalTime.trim();
  // Nothing at all is "needs a time", and is recorded (C13). A time with no day is not.
  if (date.length === 0) return time.length === 0 ? null : 'callback_date_missing';
  if (!DATE.test(date) || !Number.isFinite(Date.parse(date))) return 'callback_date_invalid';
  if (time.length > 0 && !TIME.test(time)) return 'callback_time_invalid';
  if (draft.callbackTimeZone.trim().length === 0) return 'callback_zone_missing';
  // 9.1: the callback is created "after salesperson confirmation of the instant". An
  // unresolvable instant is an unconfirmed one, and the form will not record it.
  if (resolvedCallbackInstant(draft) === null) return 'callback_instant_unconfirmed';
  return null;
}

/** Whether recording this draft writes a stop, and which of the four. */
export function outcomeSuppresses(draft: OutcomeDraft): 'none' | DoNotCallChoiceKey {
  if (draft.outcome !== 'do_not_call') return 'none';
  return draft.doNotCall;
}

/** What each of the four stops does, said before it is recorded. */
export const SUPPRESSION_WARNINGS: Readonly<Record<DoNotCallChoiceKey, string>> = Object.freeze({
  contact_phone: 'Recording this stops Callie calling this person. It does not stop e-mail, and it gives no permission to send any.',
  contact_all: 'Recording this stops Callie calling or e-mailing this person. Only an admin can undo it.',
  firm_phone: 'Recording this stops Callie calling anyone at this firm. It does not stop e-mail, and it gives no permission to send any.',
  firm_all:
    'Recording this stops Callie contacting this firm by any means. Only an admin can undo it, and only with a documented reason.',
});

export interface LogCallCommand {
  readonly commandId: string;
  readonly clientVersion: string;
  readonly firmId: string;
  readonly contactId?: string;
  readonly routeId?: string;
  /** The Today task the call was for (lane g79). */
  readonly itemId?: string;
  readonly outcome: CallOutcome;
  /** Only an entered past time. Absent is "just now", on the server's clock (C15). */
  readonly occurredAt?: string;
  readonly note?: string;
  readonly callback?: {
    readonly localDate: string;
    readonly localTime?: string;
    readonly dueAt: string;
    readonly sourceTimeZone: string;
  };
  /** Only for `do_not_call`: the four-way choice (migration 0037). */
  readonly doNotCall?: DoNotCallChoice;
}

export interface LogCallCommandInput {
  readonly commandId: string;
  readonly clientVersion: string;
  readonly firmId: string;
  readonly contactId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly itemId?: string | undefined;
  /** An entered past time. Leave it out for a call that has just ended. */
  readonly occurredAt?: string | undefined;
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
  const dueAt = resolvedCallbackInstant(input.draft);
  return {
    command: {
      commandId: input.commandId,
      clientVersion: input.clientVersion,
      firmId: input.firmId,
      ...(input.contactId === undefined ? {} : { contactId: input.contactId }),
      ...(input.routeId === undefined ? {} : { routeId: input.routeId }),
      ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
      outcome,
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
      ...(note.length > 0 ? { note } : {}),
      // A callback with no day travels without one, and the server records the call
      // with "Callback — needs a time" on Today (C13).
      ...(outcome === 'callback_requested' && dueAt !== null
        ? {
            callback: {
              localDate: input.draft.callbackLocalDate.trim(),
              ...(time.length > 0 ? { localTime: time } : {}),
              dueAt,
              sourceTimeZone: input.draft.callbackTimeZone.trim(),
            },
          }
        : {}),
      ...(outcome === 'do_not_call' ? { doNotCall: DO_NOT_CALL_CHOICES[input.draft.doNotCall].choice } : {}),
    },
  };
}
