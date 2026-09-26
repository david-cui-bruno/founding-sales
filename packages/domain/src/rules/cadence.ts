import {
  resolveDelay,
  startAnchoredDueAt,
  type ResolvedDueInstant,
  type SequenceDelay,
  type WorkspaceHolidayCalendar,
} from './businessDays.ts';
import type { StepChannel } from '@fss/contracts';

/**
 * The start-anchored due rule (specification 11.1 and 11.2): a step's delay is counted
 * from the instant the enrollment began, not from the previous step's completion, so a
 * firm that sat in a queue does not have its whole cadence pushed out by the wait.
 * This module decides only when a step is due; it dials nothing, sends nothing and
 * writes nothing.
 */

export interface SequenceStep {
  readonly id: string;
  readonly ordinal: number;
  readonly channel: StepChannel;
  readonly delay: SequenceDelay;
  /** What a call step does when nobody answers: continue the cadence, or try the same step again. */
  readonly onNoAnswer?: 'advance' | 'retry_call' | undefined;
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

export { startAnchoredDueAt };
