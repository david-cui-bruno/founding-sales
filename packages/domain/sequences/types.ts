import type { HoldReasonCode, StepChannel } from '@fss/contracts';
import type { SequenceDelay } from '../src/rules/businessDays.ts';
import {
  STEP_CHANNELS,
  type EnrollmentEndReason,
  type EnrollmentOriginKind,
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
  /**
   * Migration 0025, David's decisions of 29 September 2026. `firm_already_enrolled` is
   * "one active prospecting contact per firm" refused at the command;
   * `follow_up_not_permitted` is a follow-up enrollment whose permission does not hold
   * up when its evidence is re-read. Both are also `hold_reason_codes`, because the
   * same two questions are asked again at the step.
   */
  'firm_already_enrolled',
  'follow_up_not_permitted',
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
  /**
   * `POST /enrollments/migrate` (send-path v2, S2). `version_other_sequence`: the target
   * is a version of another sequence. `cold_legacy_never_revived`: a pre-0025 enrollment
   * never moves, because moving it would be reviving it. `enrollment_dispatching`: a step
   * of the enrollment is claimed, dispatching or has a fence not yet settled.
   * `completed_prefix_required`: the completed steps are not exactly 1..k.
   * `agreed_scope_bound`: an agreed-sequence run cannot move on its original agreement;
   * a fresh permission for the target version is required.
   */
  'version_other_sequence',
  'cold_legacy_never_revived',
  'enrollment_dispatching',
  'completed_prefix_required',
  'agreed_scope_bound',
  /** A published version's edit, refused because the sequence already has a draft (S2). */
  'draft_exists',
  /**
   * A migration's fresh permission would expire before the e-mail it pays for can be
   * sent (step k + 1 placed in the window); refused before the old run is touched.
   */
  'permission_expires_before_step',
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
  /**
   * What the enrollment was created for (migration 0025). `cold_legacy` is the
   * column's DEFAULT and therefore every row written before 0025: excluded from
   * automatic sending for ever.
   */
  readonly originKind: EnrollmentOriginKind;
  /** The permission a `follow_up` enrollment rests on. Null for the other two kinds. */
  readonly permissionId: string | null;
  readonly reviewUnionMilliseconds: null;
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
