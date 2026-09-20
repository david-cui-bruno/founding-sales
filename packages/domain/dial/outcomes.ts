import type { CallOutcome, CallStepEffect } from '@fss/contracts';

/**
 * The outcome table of specification 9.1, as a pure rule.
 *
 * | Outcome | Effect |
 * |---|---|
 * | Interested or meaningful conversation | Set opportunity manual; stop all current enrollments |
 * | Referral or wrong person | Set manual so the next contact is tailored |
 * | Callback requested | Set manual and create a callback after salesperson confirmation of the instant |
 * | Not interested | Set manual and suggest Lost; salesperson confirms closure |
 * | Do not call | Suppress the number immediately; suppress the firm only when the request covers all Callie contact |
 * | Wrong number | Retire the route; do not suppress the firm |
 * | Voicemail left | Complete the call step and create its configured successor |
 * | No answer or busy | Record the attempt and follow the step's configured `advance | retry_call` behavior |
 * | Policy or technical failure | Do not complete the step |
 *
 * It is a table rather than a switch in the command because every row of it is a
 * product decision somebody may want to change, and because a pure function of one
 * outcome is a test that needs no database. The command applies what this returns;
 * it decides nothing itself.
 */

export interface CallOutcomeEffects {
  /** Set `control_mode = manual`, ending current enrollments (7.3). */
  readonly setsManual: boolean;
  /** Suggest Lost to the salesperson. Never closes the opportunity itself (9.1, 8.1). */
  readonly suggestsLost: boolean;
  /** Suppress the dialed number. The firm too, only when the request covered all contact. */
  readonly suppressesNumber: boolean;
  /** Retire the route, which says the number does not reach the firm — not that the firm is off limits. */
  readonly retiresRoute: boolean;
  /** Create a callback, but only once the salesperson has confirmed the instant. */
  readonly createsCallbackOnConfirmation: boolean;
  /** What happens to the sequence step. The sequences lane reads the recorded value. */
  readonly stepEffect: CallStepEffect;
}

const NOTHING = Object.freeze({
  setsManual: false,
  suggestsLost: false,
  suppressesNumber: false,
  retiresRoute: false,
  createsCallbackOnConfirmation: false,
  stepEffect: 'none',
} satisfies CallOutcomeEffects);

const EFFECTS: Readonly<Record<CallOutcome, CallOutcomeEffects>> = Object.freeze({
  interested: Object.freeze({ ...NOTHING, setsManual: true, stepEffect: 'complete_and_advance' }),
  referral_or_wrong_person: Object.freeze({ ...NOTHING, setsManual: true, stepEffect: 'complete_and_advance' }),
  callback_requested: Object.freeze({
    ...NOTHING,
    setsManual: true,
    createsCallbackOnConfirmation: true,
    stepEffect: 'complete_and_advance',
  }),
  not_interested: Object.freeze({ ...NOTHING, setsManual: true, suggestsLost: true, stepEffect: 'complete_and_advance' }),
  // Manual as well: a firm that has asked not to be called is not a firm automation
  // should keep a plan for, whatever the suppression later turns out to cover.
  do_not_call: Object.freeze({ ...NOTHING, setsManual: true, suppressesNumber: true, stepEffect: 'complete_and_advance' }),
  // "Retire the route; do not suppress the firm." And not manual either: a wrong
  // number says nothing about the prospect's interest.
  wrong_number: Object.freeze({ ...NOTHING, retiresRoute: true, stepEffect: 'none' }),
  voicemail_left: Object.freeze({ ...NOTHING, stepEffect: 'complete_and_advance' }),
  no_answer: Object.freeze({ ...NOTHING, stepEffect: 'advance' }),
  busy: Object.freeze({ ...NOTHING, stepEffect: 'advance' }),
  policy_or_technical_failure: Object.freeze({ ...NOTHING, stepEffect: 'none' }),
});

/** The outcomes whose step effect the sequence's own configuration decides (9.1). */
const CONFIGURABLE: ReadonlySet<CallOutcome> = new Set<CallOutcome>(['no_answer', 'busy']);

/**
 * What one outcome does.
 *
 * `retryBehaviour` is the step's configured `advance | retry_call`, and it is
 * consulted for exactly the two outcomes 9.1 gives it to. Supplying it for any other
 * outcome changes nothing, which is deliberate: a caller cannot turn "interested"
 * into a retry by passing an extra field.
 */
export function callOutcomeEffects(
  outcome: CallOutcome,
  retryBehaviour: 'advance' | 'retry_call' = 'advance',
): CallOutcomeEffects {
  const base = EFFECTS[outcome];
  if (!CONFIGURABLE.has(outcome)) return base;
  return { ...base, stepEffect: retryBehaviour };
}

/** The control-mode reason recorded on the opportunity, so history says which call did it. */
export function manualReasonFor(outcome: CallOutcome): string {
  return `call outcome: ${outcome}`;
}
