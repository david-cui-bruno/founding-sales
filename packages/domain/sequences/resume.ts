import type { BlockedActionKind, HoldReasonCode } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import {
  composeHolds,
  decideResume,
  shiftDueInstant,
  type HoldRecord,
  type ResumeDecision,
} from '../src/index.ts';
import { rescheduleExecution } from './executions.ts';
import { loadEnrollmentForUpdate, unexecutedExecutions } from './rows.ts';
import { acceptSequence, refuseSequence, type SequenceResult } from './types.ts';

/**
 * Releasing holds and resuming an enrollment (specification 4.3, 11.2, Appendix G 28
 * and 31).
 *
 * "When all applicable holds clear, unexecuted work shifts by the union of blocking
 * intervals. A union longer than seven days requires the salesperson to review the
 * rendered future steps and explicitly resume. Every resume performs a fresh
 * eligibility check."
 *
 * The arithmetic is G0's, in `packages/domain/src/rules/holds.ts`, and it is a union
 * rather than a sum for the reason that file states: two holds that ran side by side
 * for a day delayed the work by a day. This file is the database half — which holds
 * are *applicable*, and what happens to the rows once the decision is made.
 *
 * ## Why this reads released holds too
 *
 * `listApplicableHolds` answers "is anything blocking right now", which is what an
 * eligibility check wants. The union wants something different: every interval that
 * blocked this enrollment since it started, open or closed. A hold that opened and
 * closed while the enrollment sat still is exactly the thing whose length has to be
 * added, and it is invisible to a query that filters on `released_at IS NULL`.
 *
 * The window starts at the enrollment's own `started_at`, so a hold that closed
 * before this contact was ever enrolled does not push their first email out.
 */

/** The action kinds an enrollment's work can be blocked under. */
const ENROLLMENT_ACTION_KINDS: readonly BlockedActionKind[] = Object.freeze([
  'email_send',
  'call_task',
  'linkedin_task',
  'enrollment_advance',
]);

interface HoldDbRow {
  readonly id: string;
  readonly reason_code: HoldReasonCode;
  readonly blocked_action_kinds: string[];
  readonly started_at: Date;
  readonly released_at: Date | null;
  readonly [column: string]: unknown;
}

/** Every hold, open or closed, that blocked this enrollment's work since it started. */
export async function holdsAffectingEnrollment(
  context: RepositoryContext,
  input: {
    readonly enrollmentId: string;
    readonly firmId: string;
    readonly opportunityId: string;
    readonly ownerUserId: string;
    readonly since: string;
  },
): Promise<readonly HoldRecord[]> {
  const { rows } = await context.db.query<HoldDbRow>(
    `SELECT id, reason_code, blocked_action_kinds, started_at, released_at
       FROM active_holds
      WHERE workspace_id = $1
        AND blocked_action_kinds && $2::text[]
        AND (released_at IS NULL OR released_at >= $3::timestamptz)
        AND (
          scope_kind = 'workspace'
          OR (scope_kind = 'firm' AND scope_key = $4)
          OR (scope_kind = 'opportunity' AND scope_key = $5)
          OR (scope_kind = 'owner' AND scope_key = $6)
          OR (scope_kind = 'enrollment' AND scope_key = $7)
        )
      ORDER BY started_at, id`,
    [
      context.scope.workspaceId,
      [...ENROLLMENT_ACTION_KINDS],
      input.since,
      input.firmId,
      input.opportunityId,
      input.ownerUserId,
      input.enrollmentId,
    ],
  );
  return rows.map(row => ({
    id: row.id,
    reasonCode: row.reason_code,
    blockedActionKinds: row.blocked_action_kinds as BlockedActionKind[],
    // A hold that opened before this enrollment counts only from the enrollment's
    // start: it did not delay work that did not exist.
    startedAt: (row.started_at.getTime() < Date.parse(input.since)
      ? new Date(Date.parse(input.since))
      : row.started_at
    ).toISOString(),
    releasedAt: row.released_at === null ? null : row.released_at.toISOString(),
  }));
}

export interface ResumeOutcome {
  readonly kind: ResumeDecision['kind'];
  readonly shiftMilliseconds: number;
  readonly unionMilliseconds: number;
  readonly openHoldIds: readonly string[];
  readonly executionsShifted: number;
}

/**
 * Reconsider an enrollment's holds and do what the decision says.
 *
 * Three answers and no fourth, straight from `decideResume`:
 *
 *   * `still_held` — something is open; nothing moves.
 *   * `review_required` — the union exceeded seven days. The enrollment goes to
 *     `review_required`, which `runDueStepExecution` treats as a hold with the
 *     `long_hold_review` reason, and only an explicit `resumeAfterReview` gets it out.
 *   * `resume` — every unexecuted step moves forward by the union, each move
 *     recorded as a shift, and the enrollment is active again.
 *
 * The fresh eligibility check 4.3 asks for is the one `runDueStepExecution` performs
 * on the next pass, inside its own claiming transaction. Doing it here as well would
 * be a second answer at a different instant, which is the thing eligibility
 * composition exists to avoid.
 */
export async function resumeEnrollment(
  context: RepositoryContext,
  input: { readonly enrollmentId: string; readonly afterReview?: boolean | undefined },
): Promise<SequenceResult<ResumeOutcome>> {
  const enrollment = await loadEnrollmentForUpdate(context, input.enrollmentId);
  if (enrollment === null) return refuseSequence('enrollment_unknown');
  if (enrollment.endedAt !== null) return refuseSequence('enrollment_not_live');

  const { rows: clock } = await context.db.query<{ now: Date }>('SELECT now() AS now');
  const now = (clock[0]?.now ?? new Date()).toISOString();

  const holds = await holdsAffectingEnrollment(context, {
    enrollmentId: enrollment.id,
    firmId: enrollment.firmId,
    opportunityId: enrollment.opportunityId,
    ownerUserId: enrollment.assignedUserId,
    since: enrollment.startedAt,
  });
  const composition = composeHolds({ holds, now, actionKinds: ENROLLMENT_ACTION_KINDS });
  const decision = decideResume(composition);

  if (decision.kind === 'still_held') {
    return acceptSequence({
      kind: 'still_held',
      shiftMilliseconds: 0,
      unionMilliseconds: composition.unionMilliseconds,
      openHoldIds: decision.openHoldIds,
      executionsShifted: 0,
    });
  }

  // A salesperson who has reviewed the rendered future steps may resume a long hold;
  // nothing else may. `afterReview` is the explicit act 4.3 requires, and it is the
  // only path that turns a `review_required` enrollment back into an active one.
  if (decision.kind === 'review_required' && input.afterReview !== true) {
    await context.db.query(
      `UPDATE sequence_enrollments
          SET state = 'review_required', review_union_milliseconds = $3, updated_at = now()
        WHERE workspace_id = $1 AND id = $2 AND ended_at IS NULL`,
      [context.scope.workspaceId, enrollment.id, decision.unionMilliseconds],
    );
    return acceptSequence({
      kind: 'review_required',
      shiftMilliseconds: 0,
      unionMilliseconds: decision.unionMilliseconds,
      openHoldIds: [],
      executionsShifted: 0,
    });
  }

  const shiftMilliseconds =
    decision.kind === 'resume' ? decision.shiftMilliseconds : composition.unionMilliseconds;
  const pending = await unexecutedExecutions(context, enrollment.id);
  let shifted = 0;
  for (const execution of pending) {
    if (shiftMilliseconds <= 0) continue;
    await rescheduleExecution(context, {
      execution,
      toDueAt: shiftDueInstant(execution.dueAt, shiftMilliseconds),
      reason: 'hold_union',
      holdUnionMilliseconds: composition.unionMilliseconds,
    });
    shifted += 1;
  }

  await context.db.query(
    `UPDATE sequence_enrollments
        SET state = 'active', review_union_milliseconds = NULL, updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND ended_at IS NULL`,
    [context.scope.workspaceId, enrollment.id],
  );
  // A step held for a reason that has now cleared goes back to pending; a step held
  // for `missing_variables`, whose hold this lane opened and nobody released, stays.
  await context.db.query(
    `UPDATE step_executions
        SET state = 'pending', hold_reason_code = NULL, updated_at = now()
      WHERE workspace_id = $1 AND enrollment_id = $2 AND state = 'held'
        AND hold_reason_code <> 'missing_variables'`,
    [context.scope.workspaceId, enrollment.id],
  );

  return acceptSequence({
    kind: 'resume',
    shiftMilliseconds,
    unionMilliseconds: composition.unionMilliseconds,
    openHoldIds: [],
    executionsShifted: shifted,
  });
}

/**
 * The salesperson's explicit resume after reviewing a long hold (4.3, Appendix G 31).
 *
 * Deliberately a second function rather than a flag on the first, so that the
 * endpoint that a control is wired to cannot be the one an automatic pass calls.
 */
export async function resumeAfterReview(
  context: RepositoryContext,
  input: { readonly enrollmentId: string },
): Promise<SequenceResult<ResumeOutcome>> {
  return await resumeEnrollment(context, { enrollmentId: input.enrollmentId, afterReview: true });
}
