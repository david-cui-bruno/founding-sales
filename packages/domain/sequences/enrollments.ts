import type { RepositoryContext } from '../db/workspaceScope.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import type { WorkspaceHolidayCalendar } from '../src/rules/businessDays.ts';
import { resolveStepDue } from '../src/rules/cadence.ts';
import { currentHolidayCalendar, holidayCalendarByVersion } from './calendars.ts';
import { listEnrollments, readEnrollment, readSequenceVersion, toEnrollment } from './rows.ts';
import {
  acceptSequence,
  isStepChannel,
  refuseSequence,
  type EnrollmentRow,
  type SequenceResult,
  type SequenceStepRow,
  type SequenceVersionRow,
} from './types.ts';
import type { EnrollmentEndReason } from '@fss/contracts';

/**
 * Enrollment, and the terminal stop (specification 11.2, 7.3, 8.1, Appendix A).
 *
 * Appendix A's "Enroll" row: locks the opportunity and the contact, and commits "the
 * enrollment and first execution" together. That is one statement here — two writable
 * CTEs — rather than two statements inside a transaction, so it is atomic whether or
 * not the caller opened one. An enrollment with no first execution is a contact the
 * salesperson believes is being contacted and who never will be, and it is worth a
 * slightly longer statement to make it unrepresentable.
 *
 * Three things are frozen at the moment of enrolling, and each has a reason:
 *
 *   * **the sequence version**, because 11.2 says so and because a published version
 *     is immutable, so the freeze costs nothing;
 *   * **the firm's zone**, because a firm that moves mid-cadence should not re-time
 *     the steps a salesperson has already seen rendered;
 *   * **the holiday calendar version**, for the same reason, and because the stored
 *     `rule_version` on every due instant names it.
 */

export interface EnrollContactInput {
  readonly sequenceVersionId: string;
  readonly opportunityId: string;
  readonly firmId: string;
  readonly contactId: string;
  /**
   * Whose enrollment it is. Defaults to the firm's assignee, which is the only
   * correct answer in version one (2's "at most one assigned salesperson per firm").
   */
  readonly assignedUserId?: string | undefined;
  readonly commandId?: string | undefined;
}

export interface EnrolledOutcome {
  readonly enrollmentId: string;
  readonly firstExecutionId: string;
  readonly firstDueAt: string;
}

interface FirmForEnrollment {
  readonly assigned_user_id: string | null;
  readonly time_zone: string | null;
  readonly status: string;
  readonly [column: string]: unknown;
}

/**
 * Enrol one contact in one published version.
 *
 * The refusals are values, and every one of them is a sentence somebody can read:
 * the version is a draft, the contact already has a live enrollment, the firm's zone
 * has never been established. The last is 9.2's rule applied to email — a due instant
 * this system cannot place in a real local day is a due instant it must not invent.
 */
export async function enrollContact(
  context: RepositoryContext,
  input: EnrollContactInput,
): Promise<SequenceResult<EnrolledOutcome>> {
  const version = await readSequenceVersion(context, input.sequenceVersionId);
  if (version === null) return refuseSequence('version_unknown');
  if (version.state === 'retired') return refuseSequence('version_retired');
  if (version.state !== 'published') return refuseSequence('version_not_published');
  const firstStep = version.steps[0];
  if (firstStep === undefined) return refuseSequence('version_has_no_steps');
  // A guard: since migration 0019 no stored step has a channel `isStepChannel` refuses.
  if (!version.steps.every(step => isStepChannel(step.channel))) return refuseSequence('step_unknown');

  const { rows: firms } = await context.db.query<FirmForEnrollment>(
    'SELECT assigned_user_id, time_zone, status FROM firms WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
    [context.scope.workspaceId, input.firmId],
  );
  const firm = firms[0];
  if (firm === undefined || firm.status !== 'active') return refuseSequence('firm_unknown');
  if (firm.time_zone === null) return refuseSequence('firm_zone_unknown');

  const assignedUserId = input.assignedUserId ?? firm.assigned_user_id;
  if (assignedUserId === null || assignedUserId === undefined) return refuseSequence('not_assigned');
  if (
    context.scope.actor.kind === 'user' &&
    context.scope.actor.role === 'salesperson' &&
    firm.assigned_user_id !== context.scope.actor.userId
  ) {
    return refuseSequence('not_assigned');
  }

  const { rows: opportunities } = await context.db.query<{ status: string; firm_id: string }>(
    'SELECT status, firm_id FROM opportunities WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
    [context.scope.workspaceId, input.opportunityId],
  );
  const opportunity = opportunities[0];
  if (opportunity === undefined || opportunity.firm_id !== input.firmId) {
    return refuseSequence('opportunity_unknown');
  }
  if (opportunity.status !== 'open') return refuseSequence('opportunity_not_open');

  const { rows: contacts } = await context.db.query<{ status: string }>(
    'SELECT status FROM contacts WHERE workspace_id = $1 AND id = $2 AND firm_id = $3 FOR UPDATE',
    [context.scope.workspaceId, input.contactId, input.firmId],
  );
  if (contacts[0] === undefined || contacts[0].status !== 'active') {
    return refuseSequence('contact_unknown');
  }

  const live = await listEnrollments(context, { contactId: input.contactId, liveOnly: true });
  if (live.length > 0) return refuseSequence('contact_already_enrolled');

  const calendar = await currentHolidayCalendar(context);
  const { rows: clock } = await context.db.query<{ now: Date }>('SELECT now() AS now');
  const startedAt = (clock[0]?.now ?? new Date()).toISOString();
  const due = resolveStepDue(
    stepForCadence(firstStep),
    startedAt,
    firm.time_zone,
    calendar,
  );

  // Appendix A: "Enrollment and first execution" commit together. One statement, so
  // there is no interleaving in which one exists without the other.
  const { rows } = await context.db.query<{ enrollment_id: string; execution_id: string }>(
    `WITH enrolled AS (
       INSERT INTO sequence_enrollments
         (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
          started_at, firm_time_zone, holiday_calendar_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9)
       RETURNING id
     ), executed AS (
       INSERT INTO step_executions
         (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal,
          due_at, not_before, original_due_at, source_zone, rule_version)
       SELECT $1, enrolled.id, $10, $4, $5, $11, $12,
              $13::timestamptz, $13::timestamptz, $13::timestamptz, $14, $15
         FROM enrolled
       RETURNING id, enrollment_id
     )
     SELECT executed.enrollment_id, executed.id AS execution_id FROM executed`,
    [
      context.scope.workspaceId,
      input.sequenceVersionId,
      input.opportunityId,
      input.firmId,
      input.contactId,
      assignedUserId,
      startedAt,
      firm.time_zone,
      calendar.version,
      firstStep.id,
      firstStep.channel,
      firstStep.ordinal,
      due.dueAt,
      due.sourceZone,
      due.ruleVersion,
    ],
  );
  const created = rows[0];
  if (created === undefined) return refuseSequence('invalid_input');
  return acceptSequence({
    enrollmentId: created.enrollment_id,
    firstExecutionId: created.execution_id,
    firstDueAt: due.dueAt,
  });
}

/** G0's `SequenceStep`, from this lane's row. The two shapes differ only in naming. */
export function stepForCadence(step: SequenceStepRow): {
  readonly id: string;
  readonly ordinal: number;
  readonly channel: SequenceStepRow['channel'];
  readonly delay: SequenceStepRow['delay'];
  readonly onNoAnswer?: 'advance' | 'retry_call' | undefined;
} {
  return {
    id: step.id,
    ordinal: step.ordinal,
    channel: step.channel,
    delay: step.delay,
    ...(step.onNoAnswer === null ? {} : { onNoAnswer: step.onNoAnswer }),
  };
}

/** The calendar an enrollment was started under, whatever the current one is now. */
export async function calendarOfEnrollment(
  context: RepositoryContext,
  enrollment: EnrollmentRow,
): Promise<WorkspaceHolidayCalendar> {
  return await holidayCalendarByVersion(context, enrollment.holidayCalendarVersion);
}

export interface StopEnrollmentsInput {
  /** One of these three. A firm stop covers every contact, which is 7.3's firm-wide rule. */
  readonly firmId?: string | undefined;
  readonly opportunityId?: string | undefined;
  readonly enrollmentId?: string | undefined;
  readonly reason: EnrollmentEndReason;
  /** What a cancelled execution records. Defaults to the reason. */
  readonly cancelReason?: string | undefined;
}

export interface StopReport {
  readonly enrollmentsStopped: number;
  readonly executionsCancelled: number;
  readonly enrollmentIds: readonly string[];
}

/**
 * End enrollments terminally and cancel everything they had not done yet.
 *
 * 7.3: a confirmed human reply "terminally stop[s] every active enrollment for the
 * firm across contacts; cancel[s] unclaimed executions". Both halves are one
 * statement pair here, and the caller commits them with whatever caused them.
 *
 * What this deliberately does *not* do is touch a dispatching outbound fence.
 * Appendix B's `dispatching` is irreversible: bytes may already have left, and the
 * only honest thing to do with such a step is leave it to reconcile. The cancellation
 * touches `pending` and `held` rows, which is exactly "unclaimed executions".
 *
 * It also does not set the opportunity manual. That is the caller's, because the
 * reasons differ: a Won stage is not manual mode, a confirmed reply is.
 */
export async function stopEnrollments(
  context: RepositoryContext,
  input: StopEnrollmentsInput,
): Promise<StopReport> {
  if (
    input.firmId === undefined &&
    input.opportunityId === undefined &&
    input.enrollmentId === undefined
  ) {
    throw new TypeError('a terminal stop names a firm, an opportunity or an enrollment');
  }

  // An ended enrollment is a stop fact: the send gate before the enrollment rows
  // (`policy/sendGate.ts`). The dispatch claim also locks the enrollment
  // `FOR UPDATE`, so the two serialize on the row as well as on the gate.
  await lockSendGateForStopFact(context);

  const { rows: locked } = await context.db.query<{ id: string }>(
    `SELECT id FROM sequence_enrollments
      WHERE workspace_id = $1
        AND ended_at IS NULL
        AND ($2::uuid IS NULL OR firm_id = $2)
        AND ($3::uuid IS NULL OR opportunity_id = $3)
        AND ($4::uuid IS NULL OR id = $4)
      ORDER BY id
      FOR UPDATE`,
    [
      context.scope.workspaceId,
      input.firmId ?? null,
      input.opportunityId ?? null,
      input.enrollmentId ?? null,
    ],
  );
  const enrollmentIds = locked.map(row => row.id);
  if (enrollmentIds.length === 0) {
    return { enrollmentsStopped: 0, executionsCancelled: 0, enrollmentIds: [] };
  }

  const cancelled = await context.db.query(
    `UPDATE step_executions
        SET state = 'cancelled', cancelled_at = now(), cancel_reason = $3,
            hold_reason_code = NULL, updated_at = now()
      WHERE workspace_id = $1
        AND enrollment_id = ANY($2::uuid[])
        AND state IN ('pending', 'held')`,
    [context.scope.workspaceId, enrollmentIds, input.cancelReason ?? input.reason],
  );

  const stopped = await context.db.query(
    `UPDATE sequence_enrollments
        SET state = 'stopped', ended_at = now(), end_reason = $3,
            review_union_milliseconds = NULL, updated_at = now()
      WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND ended_at IS NULL`,
    [context.scope.workspaceId, enrollmentIds, input.reason],
  );

  return {
    enrollmentsStopped: stopped.rowCount ?? 0,
    executionsCancelled: cancelled.rowCount ?? 0,
    enrollmentIds,
  };
}

/** The enrollment ran out of steps. Not a terminal stop; the plan simply finished. */
export async function completeEnrollment(
  context: RepositoryContext,
  enrollmentId: string,
): Promise<void> {
  await context.db.query(
    `UPDATE sequence_enrollments
        SET state = 'completed', ended_at = now(), end_reason = 'sequence_complete', updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND ended_at IS NULL`,
    [context.scope.workspaceId, enrollmentId],
  );
}

export { listEnrollments, readEnrollment, toEnrollment };
export type { SequenceVersionRow };
