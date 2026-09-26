import type { HoldReasonCode } from '@fss/contracts';
import type { SequenceDelay, StepChannel } from '../src/index.ts';

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

export type { SequenceDelay, StepChannel };

/**
 * The channels a step may have.
 *
 * LinkedIn was removed on 25 September 2026. Migration 0018 kept `linkedin_task` in
 * `sequence_steps_channel_known` and `step_executions_channel_known` as the stored
 * marker of a removed channel, so that a LinkedIn step and its executions stay as
 * history; a row read from either may carry it. Such a row is unknown: the worker holds
 * it and never runs it, nothing enrols into, publishes or migrates onto a version that
 * has one, and Today does not list it.
 */
export const STEP_CHANNELS = ['email', 'call_task'] as const satisfies readonly StepChannel[];

export function isStepChannel(value: string): value is StepChannel {
  return (STEP_CHANNELS as readonly string[]).includes(value);
}

/**
 * The channels removed from the product whose stored rows are still read (lane A2).
 *
 * The engine keeps reading the stored value (`linkedin_task`) and refusing it through
 * `isStepChannel`. What a person sees is mapped: a version's step by
 * `sequenceVersionForDisplay` (`definitions.ts`) and a resume review's step by
 * `previewResume` (`resume.ts`), each to channel `removed` with the channel it was and
 * none of what it carried. `@fss/contracts` spells the same list.
 */
export const REMOVED_STEP_CHANNELS = ['linkedin'] as const;
export type RemovedStepChannel = (typeof REMOVED_STEP_CHANNELS)[number];

/** The stored channel value of each removed channel: the marker migration 0018 kept in both channel CHECKs. */
const STORED_REMOVED_CHANNELS: Readonly<Record<string, RemovedStepChannel>> = Object.freeze({
  linkedin_task: 'linkedin',
});

/** The removed channel a stored channel value is, or null when it is not one. */
export function removedChannelOf(stored: string): RemovedStepChannel | null {
  return STORED_REMOVED_CHANNELS[stored] ?? null;
}

export const SEQUENCE_VERSION_STATES = ['draft', 'published', 'retired'] as const;
export type SequenceVersionState = (typeof SEQUENCE_VERSION_STATES)[number];

/**
 * 11.2's terminal conditions. A version may not opt out of any of them.
 *
 * Migration 0018 removed `linkedin_reply` from every stored array, from the column's
 * default and from both CHECKs; the reader still keeps only these four (`toVersion` in
 * `rows.ts`).
 */
export const SEQUENCE_STOP_CONDITIONS = [
  'human_reply',
  'engaged_call',
  'opt_out_or_suppression',
  'stage_closed',
] as const;
export type SequenceStopCondition = (typeof SEQUENCE_STOP_CONDITIONS)[number];

export const ENROLLMENT_STATES = ['active', 'review_required', 'completed', 'stopped'] as const;
export type EnrollmentState = (typeof ENROLLMENT_STATES)[number];

/**
 * Why an enrollment ended. The first four are 11.2's terminal conditions as the
 * enrollment sees them; the rest are the ends that are not a prospect signal.
 */
export const ENROLLMENT_END_REASONS = [
  'human_reply',
  'engaged_call',
  'opt_out',
  'firm_suppressed',
  'stage_won',
  'stage_lost',
  'direct_send',
  'send_skipped',
  'reassignment',
  'sequence_complete',
  'admin_stop',
] as const;
export type EnrollmentEndReason = (typeof ENROLLMENT_END_REASONS)[number];

export const STEP_EXECUTION_STATES = ['pending', 'held', 'dispatched', 'completed', 'cancelled'] as const;
export type StepExecutionState = (typeof STEP_EXECUTION_STATES)[number];

export const STEP_COMPLETION_SOURCES = ['call_log', 'send', 'admin', 'system'] as const;
export type StepCompletionSource = (typeof STEP_COMPLETION_SOURCES)[number];

export const STEP_RESULTS = [
  'sent',
  'skipped',
  'no_email',
  'voicemail_left',
  'no_answer',
  'busy',
  'connected',
  'not_applicable',
] as const;
export type StepResult = (typeof STEP_RESULTS)[number];

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
  'migration_unknown',
  'migration_not_approved',
  'migration_already_applied',
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

/**
 * A stored step of a removed channel, as a person is shown it (lane A2): its place and
 * its delay, the channel it was, and nothing it carried — the LinkedIn message is not
 * read at all (`STEP_COLUMNS` in `rows.ts` does not name it).
 */
export interface RemovedSequenceStep {
  readonly id: string;
  readonly sequenceVersionId: string;
  readonly ordinal: number;
  readonly channel: 'removed';
  readonly removedChannel: RemovedStepChannel;
  readonly delay: SequenceDelay;
  readonly onNoAnswer: null;
  readonly templateVersionId: null;
}

export type DisplayedSequenceStep = SequenceStepRow | RemovedSequenceStep;

/** A version as `/sequences/versions` sends it: every step, a removed one as `RemovedSequenceStep`. */
export interface DisplayedSequenceVersion extends Omit<SequenceVersionRow, 'steps'> {
  readonly steps: readonly DisplayedSequenceStep[];
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
