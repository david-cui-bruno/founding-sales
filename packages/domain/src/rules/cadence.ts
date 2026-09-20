import { resolveDelay, startAnchoredDueAt, type ResolvedDueInstant, type SequenceDelay, type WorkspaceHolidayCalendar } from './businessDays.ts';

/**
 * Sequence cadence and the start-anchored due rule (specification 11.1 and 11.2).
 *
 * Ported from `src/shared/contracts/territoryCallPolicyContract.ts` and
 * `cloud/lambdas/delegated-worker/src/v1/sequence.ts`, keeping the two rules the old
 * build settled on:
 *
 *   * **start-anchored timing.** A step's delay is counted from the instant the
 *     enrollment began, not from the previous step's completion, so a firm that sat in
 *     a queue does not have its whole cadence pushed out by the wait. The old module's
 *     `startAnchoredDueAt` is the same arithmetic.
 *   * **walking past a step that cannot run.** The cadence does not stop at a step it
 *     may not execute; it records the step as held with its reason and continues to the
 *     next one it can. A held step is honest state, never a silent skip.
 *
 * Revision 3 replaces the old single-firm vocabulary: an enrollment binds an immutable
 * sequence version to (workspace, opportunity, firm, contact), and `step_executions`
 * are unique by enrollment and step. This module decides only which step is next and
 * when; it dials nothing, sends nothing and writes nothing.
 */

export type StepChannel = 'email' | 'call_task' | 'linkedin_task';

export interface SequenceStep {
  readonly id: string;
  readonly ordinal: number;
  readonly channel: StepChannel;
  readonly delay: SequenceDelay;
  /** What a call step does when nobody answers: continue the cadence, or try the same step again. */
  readonly onNoAnswer?: 'advance' | 'retry_call' | undefined;
}

export interface EnrollmentPosition {
  /** The instant the enrollment began. Every delay is counted from here. */
  readonly startedAt: string;
  /** The step the enrollment stands on, or null before the first. */
  readonly currentStepId: string | null;
  /** Steps already executed, in any order. */
  readonly executedStepIds: readonly string[];
}

export interface HeldStep {
  readonly stepId: string;
  readonly channel: StepChannel;
  readonly reason: string;
}

export type CadenceAdvance =
  | {
      readonly kind: 'next_step';
      readonly stepId: string;
      readonly channel: StepChannel;
      readonly due: ResolvedDueInstant;
      /** Steps the walk passed over, each with the reason it could not run. */
      readonly heldSteps: readonly HeldStep[];
    }
  | {
      readonly kind: 'sequence_complete';
      readonly heldSteps: readonly HeldStep[];
    };

export interface AdvanceCadenceInput {
  readonly steps: readonly SequenceStep[];
  readonly enrollment: EnrollmentPosition;
  /** The firm's actual IANA zone. Business-day delays resolve in it. */
  readonly zone: string;
  readonly calendar?: WorkspaceHolidayCalendar | undefined;
  /**
   * Why a channel cannot run right now, from the closed reason-code set. A channel
   * absent from this map is runnable. Steps on a blocked channel are held and walked
   * past; the reason travels with the held step.
   */
  readonly blockedChannels?: Readonly<Partial<Record<StepChannel, string>>> | undefined;
}

/**
 * The next step the enrollment may execute, and when it is due.
 *
 * The walk starts after the current step and stops at the first step whose channel is
 * not blocked. Every step it passes is recorded as held with the reason its channel
 * gave, so the card can say why rather than showing a gap.
 */
export function advanceCadence(input: AdvanceCadenceInput): CadenceAdvance {
  const ordered = [...input.steps].sort((a, b) => a.ordinal - b.ordinal);
  const executed = new Set(input.enrollment.executedStepIds);
  const blocked = input.blockedChannels ?? {};
  const startIndex =
    input.enrollment.currentStepId === null
      ? 0
      : ordered.findIndex(step => step.id === input.enrollment.currentStepId) + 1;
  if (input.enrollment.currentStepId !== null && startIndex === 0) {
    throw new RangeError(`step ${input.enrollment.currentStepId} is not in this sequence version`);
  }

  const heldSteps: HeldStep[] = [];
  for (let index = startIndex; index < ordered.length; index += 1) {
    const step = ordered[index];
    if (step === undefined || executed.has(step.id)) continue;
    const reason = blocked[step.channel];
    if (reason !== undefined) {
      heldSteps.push({ stepId: step.id, channel: step.channel, reason });
      continue;
    }
    return {
      kind: 'next_step',
      stepId: step.id,
      channel: step.channel,
      due: resolveStepDue(step, input.enrollment.startedAt, input.zone, input.calendar),
      heldSteps,
    };
  }
  return { kind: 'sequence_complete', heldSteps };
}

/** When a step is due, counted from the enrollment's start anchor. */
export function resolveStepDue(
  step: SequenceStep,
  startedAt: string,
  zone: string,
  calendar?: WorkspaceHolidayCalendar | undefined,
): ResolvedDueInstant {
  return resolveDelay({
    from: startedAt,
    delay: step.delay,
    zone,
    ...(calendar === undefined ? {} : { calendar }),
  });
}

/** Every step of the version with its start-anchored due instant, for the rendered future the salesperson reviews. */
export function renderCadence(
  steps: readonly SequenceStep[],
  startedAt: string,
  zone: string,
  calendar?: WorkspaceHolidayCalendar | undefined,
): { readonly stepId: string; readonly channel: StepChannel; readonly due: ResolvedDueInstant }[] {
  return [...steps]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map(step => ({ stepId: step.id, channel: step.channel, due: resolveStepDue(step, startedAt, zone, calendar) }));
}

// ---------------------------------------------------------------------------
// Call outcomes (specification 9.1)
// ---------------------------------------------------------------------------

export const CALL_OUTCOMES = [
  'interested',
  'referral_or_wrong_person',
  'callback_requested',
  'not_interested',
  'do_not_call',
  'wrong_number',
  'voicemail_left',
  'no_answer',
  'busy',
  'policy_or_technical_failure',
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export interface CallOutcomeEffect {
  /** Whether the opportunity becomes manual. Automation never reverses manual mode. */
  readonly setsManual: boolean;
  /** Whether every current enrollment for the firm stops terminally. */
  readonly stopsEnrollments: boolean;
  /** Whether the step counts as completed and its successor is created. */
  readonly completesStep: boolean;
  /** Whether the dialed route is retired. */
  readonly retiresRoute: boolean;
  /** What the outcome suppresses, if anything. `firm` only when the request covers all contact. */
  readonly suppresses: 'none' | 'number' | 'firm_when_requested';
  /** Whether a person must confirm something before the effect commits. */
  readonly requiresConfirmation: boolean;
  /** Whether the step follows its configured advance-or-retry behaviour. */
  readonly followsConfiguredRetry: boolean;
}

/**
 * The effect table of specification 9.1, exactly as written. "Call logging always
 * records what occurred, even if no valid ticket exists; it never refuses history" —
 * so every outcome has an effect, including the failure that completes nothing.
 */
export const CALL_OUTCOME_EFFECTS: Readonly<Record<CallOutcome, CallOutcomeEffect>> = Object.freeze({
  interested: {
    setsManual: true, stopsEnrollments: true, completesStep: true, retiresRoute: false,
    suppresses: 'none', requiresConfirmation: false, followsConfiguredRetry: false,
  },
  referral_or_wrong_person: {
    setsManual: true, stopsEnrollments: true, completesStep: true, retiresRoute: false,
    suppresses: 'none', requiresConfirmation: false, followsConfiguredRetry: false,
  },
  callback_requested: {
    // The callback instant is committed only after the salesperson confirms it.
    setsManual: true, stopsEnrollments: true, completesStep: true, retiresRoute: false,
    suppresses: 'none', requiresConfirmation: true, followsConfiguredRetry: false,
  },
  not_interested: {
    // Lost is suggested, never committed: the salesperson confirms closure.
    setsManual: true, stopsEnrollments: true, completesStep: true, retiresRoute: false,
    suppresses: 'none', requiresConfirmation: true, followsConfiguredRetry: false,
  },
  do_not_call: {
    setsManual: true, stopsEnrollments: true, completesStep: true, retiresRoute: false,
    suppresses: 'firm_when_requested', requiresConfirmation: false, followsConfiguredRetry: false,
  },
  wrong_number: {
    // Retire the route; do not suppress the firm.
    setsManual: false, stopsEnrollments: false, completesStep: false, retiresRoute: true,
    suppresses: 'none', requiresConfirmation: false, followsConfiguredRetry: false,
  },
  voicemail_left: {
    setsManual: false, stopsEnrollments: false, completesStep: true, retiresRoute: false,
    suppresses: 'none', requiresConfirmation: false, followsConfiguredRetry: false,
  },
  no_answer: {
    setsManual: false, stopsEnrollments: false, completesStep: false, retiresRoute: false,
    suppresses: 'none', requiresConfirmation: false, followsConfiguredRetry: true,
  },
  busy: {
    setsManual: false, stopsEnrollments: false, completesStep: false, retiresRoute: false,
    suppresses: 'none', requiresConfirmation: false, followsConfiguredRetry: true,
  },
  policy_or_technical_failure: {
    setsManual: false, stopsEnrollments: false, completesStep: false, retiresRoute: false,
    suppresses: 'none', requiresConfirmation: false, followsConfiguredRetry: false,
  },
});

export function callOutcomeEffect(outcome: CallOutcome): CallOutcomeEffect {
  return CALL_OUTCOME_EFFECTS[outcome];
}

export { startAnchoredDueAt };
