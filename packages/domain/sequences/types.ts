import type { HoldReasonCode, StepChannel } from '@fss/contracts';
import type { SequenceDelay } from '../src/rules/businessDays.ts';
import {
  STEP_CHANNELS,
  type EnrollmentEndReason,
  type EnrollmentState,
  type SequenceStopCondition,
  type SequenceVersionState,
  type StepCompletionSource,
  type StepExecutionState,
  type StepResult,
} from '@fss/contracts';

/**
 * The sequences vocabulary (specification 11.1, 11.2, 11.3).
 *
 * The same result shape as `CrmResult`, `PolicyResult` and `TodayResult`, and for the
 * same reason: a refusal is a value a command receipt can record, never an exception
 * that would roll the receipt back with the mutation.
 *
 * `StepChannel` and `SequenceDelay` are G0's, from
 * `packages/domain/src/rules/cadence.ts`. They are re-exported rather than redefined
 * so that the pure rule and the table agree by construction.
 */

export type { SequenceDelay };

export function isStepChannel(value: string): value is StepChannel {
  return (STEP_CHANNELS as readonly string[]).includes(value);
}

/**
 * Every refusal this lane can return. Closed, because a route turns one into a stable
 * reason code the Mac renders, and an open set would mean an unrenderable answer.
 */
export const SEQUENCE_REFUSAL_CODES = [
  'admin_only',
  'not_assigned',
  'invalid_input',
  'sequence_unknown',
  'version_unknown',
  'version_not_draft',
  'version_not_published',
  'version_retired',
  'version_has_no_steps',
  'step_unknown',
  'template_unknown',
  'template_unapproved',
  'template_retired',
  'contact_unknown',
  'contact_already_enrolled',
  'firm_unknown',
  'firm_zone_unknown',
  'opportunity_unknown',
  'opportunity_not_open',
  'opportunity_manual',
  'enrollment_unknown',
  'enrollment_not_live',
  'execution_unknown',
  'execution_not_pending',
  'execution_wrong_channel',
  'still_held',
  'step_in_use',
  'calendar_version_taken',
] as const;
export type SequenceRefusalCode = (typeof SEQUENCE_REFUSAL_CODES)[number];

export type SequenceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: SequenceRefusalCode };

export function acceptSequence<T>(value: T): SequenceResult<T> {
  return { ok: true, value };
}

export function refuseSequence<T>(reason: SequenceRefusalCode): SequenceResult<T> {
  return { ok: false, reason };
}

/** One step of a version, as the repository reads it. */
export interface SequenceStepRow {
  readonly id: string;
  readonly sequenceVersionId: string;
  readonly ordinal: number;
  readonly channel: StepChannel;
  readonly delay: SequenceDelay;
  readonly onNoAnswer: 'advance' | 'retry_call' | null;
  readonly templateVersionId: string | null;
}

export interface SequenceVersionRow {
  readonly id: string;
  readonly sequenceId: string;
  readonly version: number;
  readonly state: SequenceVersionState;
  readonly stopConditions: readonly SequenceStopCondition[];
  readonly publishedAt: string | null;
  readonly retiredAt: string | null;
  readonly steps: readonly SequenceStepRow[];
}

export interface SequenceRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly archivedAt: string | null;
}

export interface EnrollmentRow {
  readonly id: string;
  readonly sequenceVersionId: string;
  readonly opportunityId: string;
  readonly firmId: string;
  readonly contactId: string;
  readonly assignedUserId: string;
  readonly state: EnrollmentState;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly endReason: EnrollmentEndReason | null;
  readonly firmTimeZone: string;
  readonly holidayCalendarVersion: string;
  readonly reviewUnionMilliseconds: number | null;
}

export interface StepExecutionRow {
  readonly id: string;
  readonly enrollmentId: string;
  readonly stepId: string;
  readonly firmId: string;
  readonly contactId: string;
  readonly channel: StepChannel;
  readonly ordinal: number;
  readonly state: StepExecutionState;
  readonly dueAt: string;
  readonly notBefore: string;
  readonly originalDueAt: string;
  readonly sourceZone: string;
  readonly ruleVersion: string;
  readonly attemptCount: number;
  readonly holdReasonCode: HoldReasonCode | null;
  readonly completionSource: StepCompletionSource | null;
  readonly result: StepResult | null;
  readonly completedAt: string | null;
}
