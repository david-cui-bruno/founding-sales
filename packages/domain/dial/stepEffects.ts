import type { CallOutcome, CallStepApplication, CallStepEffect } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { addBusinessDays } from '../src/rules/businessDays.ts';
import { localDate, localInstant, localParts } from '../src/rules/localClock.ts';
import { calendarOfEnrollment } from '../sequences/enrollments.ts';
import { completeStepExecution, rescheduleExecution } from '../sequences/executions.ts';
import { loadEnrollmentForUpdate, loadStepExecutionForUpdate, readSequenceVersion } from '../sequences/rows.ts';
import type { EnrollmentRow, StepExecutionRow, StepResult } from '../sequences/types.ts';
import { completeTodayItemsByKey } from '../today/snapshots.ts';
import { callOutcomeEffects, type CallOutcomeEffects } from './outcomes.ts';

/**
 * What a logged call does to the sequence step it was placed for (specification 9.1,
 * 11.2, Appendix A "Log call outcome", Appendix G 26; lane g79, audit item C04).
 *
 * G4 recorded a `step_effect` on the call log and applied nothing: "no enrollment
 * table exists yet, so the decided effect is recorded here rather than applied", with
 * `step_execution_id` left for the sequences lane to fill in, and the no-answer
 * behaviour taken from the request. The sequences lane arrived and nobody came back,
 * so a logged voicemail left its call task on Today for ever and the cadence stalled
 * behind it. This file is the coming back.
 *
 * ## Bound, not inferred
 *
 * A call applies to a step only when the Today task it was placed from names one
 * (`itemId` → `step-execution:<id>`). A call logged from anywhere else is history and
 * nothing more: guessing which step a free-standing call "was for" would complete a
 * step on the strength of a coincidence.
 *
 * ## From the frozen step, never from the client
 *
 * `no_answer` and `busy` follow the step's configured `advance | retry_call` (9.1).
 * The configuration is read here from the published — and therefore immutable —
 * version the enrollment is bound to, under the execution's and the enrollment's row
 * locks. The request's `retryBehaviour` is accepted for old clients and ignored.
 *
 * ## What each outcome does
 *
 *  * an **engaged** outcome (anything that sets manual) completes the step as
 *    `connected` and creates **no** successor; the caller then stops every live
 *    enrollment at the firm in the same transaction — Appendix G 26, "prevents every
 *    successor", made true at the source rather than by the next outbox drain;
 *  * `voicemail_left`, and `no_answer`/`busy` on an `advance` step, complete the step
 *    and create its configured successor through `completeStepExecution`, the one
 *    function that knows how a successor is timed (start-anchored, 11.2);
 *  * `no_answer`/`busy` on a `retry_call` step re-arm the same execution (G8's
 *    decision: one row per step) on the next business day at the step's own local
 *    time, recorded as a `retry_call` shift, with `attempt_count` incremented. At the
 *    database's bound of 20 attempts the step advances instead of retrying;
 *  * `wrong_number` and `policy_or_technical_failure` complete nothing (9.1: "do not
 *    complete the step"), and the task stays on Today.
 *
 * Whatever completed or re-armed the step also finishes its Today task, in the same
 * transaction: the call was the work, and a task that stayed on screen after it would
 * invite a second call.
 */

/** `attempt_count`'s CHECK bound (G8). Retrying past it is refused by the database. */
export const CALL_ATTEMPT_LIMIT = 20;

export interface BoundStep {
  readonly execution: StepExecutionRow;
  readonly enrollment: EnrollmentRow;
  /** The frozen step's configuration. Null only for a step that is not a call step. */
  readonly onNoAnswer: 'advance' | 'retry_call' | null;
  /** Whether the step can still be completed: unfinished, and its enrollment live. */
  readonly open: boolean;
}

/**
 * Lock the execution and its enrollment and read the frozen step, or null when the
 * execution is not this firm's call step. Called before anything is written, so a
 * wrong binding is a refusal with nothing behind it.
 */
export async function loadBoundCallStep(
  context: RepositoryContext,
  input: { readonly stepExecutionId: string; readonly firmId: string },
): Promise<BoundStep | null> {
  const execution = await loadStepExecutionForUpdate(context, input.stepExecutionId);
  if (execution === null || execution.firmId !== input.firmId || execution.channel !== 'call_task') return null;
  const enrollment = await loadEnrollmentForUpdate(context, execution.enrollmentId);
  if (enrollment === null) return null;
  const version = await readSequenceVersion(context, enrollment.sequenceVersionId);
  const step = version?.steps.find(candidate => candidate.id === execution.stepId);
  if (step === undefined) return null;
  return {
    execution,
    enrollment,
    onNoAnswer: step.onNoAnswer,
    open: (execution.state === 'pending' || execution.state === 'held') && enrollment.endedAt === null,
  };
}

/** The effects of one outcome, with the step's frozen configuration when there is one. */
export function effectsForBoundStep(outcome: CallOutcome, bound: BoundStep | null): CallOutcomeEffects {
  return callOutcomeEffects(outcome, bound?.onNoAnswer ?? 'advance');
}

const RESULT_OF: Readonly<Partial<Record<CallOutcome, StepResult>>> = Object.freeze({
  voicemail_left: 'voicemail_left',
  no_answer: 'no_answer',
  busy: 'busy',
});

export interface AppliedStep {
  readonly application: CallStepApplication;
  readonly successorExecutionId: string | null;
  /** For a retry: the instant the same step is due again. */
  readonly retryDueAt: string | null;
}

/**
 * The next business day after `now` in the step's own zone, at the step's own local
 * time — "try again tomorrow at the same time", on the enrollment's frozen holiday
 * calendar so a retry never lands on a day the cadence itself would have skipped.
 */
async function retryInstant(context: RepositoryContext, bound: BoundStep, now: string): Promise<string> {
  const zone = bound.execution.sourceZone;
  const calendar = await calendarOfEnrollment(context, bound.enrollment);
  const nextDay = addBusinessDays(localDate(now, zone), 1, calendar);
  const at = localParts(bound.execution.dueAt, zone);
  return localInstant(nextDay, { hour: at.hour, minute: at.minute }, zone);
}

/**
 * Apply one outcome's step effect to the bound step. Runs inside the caller's
 * savepoint, after the call log is written.
 */
export async function applyCallToStep(
  context: RepositoryContext,
  input: {
    readonly bound: BoundStep;
    readonly outcome: CallOutcome;
    readonly stepEffect: CallStepEffect;
    readonly engaged: boolean;
    /** The call's own instant, recorded as the step's completion. */
    readonly occurredAt: string;
    /** Database time. */
    readonly now: string;
  },
): Promise<AppliedStep> {
  const { bound } = input;
  if (!bound.open) return { application: 'not_open', successorExecutionId: null, retryDueAt: null };
  const taskKey = `step-execution:${bound.execution.id}`;

  if (input.engaged) {
    // Completed as `connected`, and no successor: the enrollment is about to stop.
    await context.db.query(
      `UPDATE step_executions
          SET state = 'completed', completed_at = $3::timestamptz, completion_source = 'call_log',
              result = 'connected', hold_reason_code = NULL, updated_at = now()
        WHERE workspace_id = $1 AND id = $2 AND state IN ('pending', 'held')`,
      [context.scope.workspaceId, bound.execution.id, input.occurredAt],
    );
    await completeTodayItemsByKey(context, { firmId: bound.execution.firmId, itemKey: taskKey });
    return { application: 'completed_and_stopped', successorExecutionId: null, retryDueAt: null };
  }

  if (input.stepEffect === 'none') {
    return { application: 'not_completed', successorExecutionId: null, retryDueAt: null };
  }

  if (input.stepEffect === 'retry_call' && bound.execution.attemptCount < CALL_ATTEMPT_LIMIT) {
    await context.db.query(
      `UPDATE step_executions SET attempt_count = attempt_count + 1, updated_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [context.scope.workspaceId, bound.execution.id],
    );
    const toDueAt = await retryInstant(context, bound, input.now);
    await rescheduleExecution(context, { execution: bound.execution, toDueAt, reason: 'retry_call' });
    await completeTodayItemsByKey(context, { firmId: bound.execution.firmId, itemKey: taskKey });
    return { application: 'retry_scheduled', successorExecutionId: null, retryDueAt: toDueAt };
  }

  // `complete_and_advance`, `advance`, and a retry that has reached the bound.
  const completed = await completeStepExecution(context, {
    stepExecutionId: bound.execution.id,
    completionSource: 'call_log',
    result: RESULT_OF[input.outcome] ?? 'connected',
    completedAt: input.occurredAt,
  });
  if (!completed.ok) return { application: 'not_open', successorExecutionId: null, retryDueAt: null };
  await completeTodayItemsByKey(context, { firmId: bound.execution.firmId, itemKey: taskKey });
  return {
    application: 'completed',
    successorExecutionId: completed.value.successorExecutionId,
    retryDueAt: null,
  };
}
