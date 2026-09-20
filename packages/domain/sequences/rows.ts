import type { HoldReasonCode } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import type {
  EnrollmentEndReason,
  EnrollmentRow,
  EnrollmentState,
  SequenceStepRow,
  SequenceStopCondition,
  SequenceVersionRow,
  SequenceVersionState,
  StepChannel,
  StepCompletionSource,
  StepExecutionRow,
  StepExecutionState,
  StepResult,
} from './types.ts';

/**
 * Reading the sequence tables, and nothing else.
 *
 * Every `SELECT` in this lane lives here, so that the column lists and the row
 * mappers exist once. A command file that wanted its own would be a second place a
 * column name could be spelled wrongly, and a lane whose tables carry a frozen
 * template version and a frozen zone has a lot of column names.
 */

export const STEP_COLUMNS = `id, sequence_version_id, ordinal, channel, delay_unit, delay_amount,
  on_no_answer, template_version_id, linkedin_message`;

interface StepDbRow {
  readonly id: string;
  readonly sequence_version_id: string;
  readonly ordinal: number;
  readonly channel: StepChannel;
  readonly delay_unit: 'elapsed' | 'business_days';
  readonly delay_amount: number;
  readonly on_no_answer: 'advance' | 'retry_call' | null;
  readonly template_version_id: string | null;
  readonly linkedin_message: string | null;
  readonly [column: string]: unknown;
}

export function toStep(row: StepDbRow): SequenceStepRow {
  return {
    id: row.id,
    sequenceVersionId: row.sequence_version_id,
    ordinal: Number(row.ordinal),
    channel: row.channel,
    delay:
      row.delay_unit === 'elapsed'
        ? { unit: 'elapsed', hours: Number(row.delay_amount) }
        : { unit: 'business_days', days: Number(row.delay_amount) },
    onNoAnswer: row.on_no_answer,
    templateVersionId: row.template_version_id,
    linkedInMessage: row.linkedin_message,
  };
}

interface VersionDbRow {
  readonly id: string;
  readonly sequence_id: string;
  readonly version: number;
  readonly state: SequenceVersionState;
  readonly stop_conditions: string[];
  readonly published_at: Date | null;
  readonly retired_at: Date | null;
  readonly [column: string]: unknown;
}

const VERSION_COLUMNS = 'id, sequence_id, version, state, stop_conditions, published_at, retired_at';

/** One version with its steps in ordinal order, or null. */
export async function readSequenceVersion(
  context: RepositoryContext,
  sequenceVersionId: string,
): Promise<SequenceVersionRow | null> {
  const { rows } = await context.db.query<VersionDbRow>(
    `SELECT ${VERSION_COLUMNS} FROM sequence_versions WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, sequenceVersionId],
  );
  const version = rows[0];
  if (version === undefined) return null;
  return { ...toVersion(version), steps: await readSequenceSteps(context, sequenceVersionId) };
}

function toVersion(row: VersionDbRow): Omit<SequenceVersionRow, 'steps'> {
  return {
    id: row.id,
    sequenceId: row.sequence_id,
    version: Number(row.version),
    state: row.state,
    stopConditions: row.stop_conditions as SequenceStopCondition[],
    publishedAt: row.published_at === null ? null : row.published_at.toISOString(),
    retiredAt: row.retired_at === null ? null : row.retired_at.toISOString(),
  };
}

export async function readSequenceSteps(
  context: RepositoryContext,
  sequenceVersionId: string,
): Promise<readonly SequenceStepRow[]> {
  const { rows } = await context.db.query<StepDbRow>(
    `SELECT ${STEP_COLUMNS} FROM sequence_steps
      WHERE workspace_id = $1 AND sequence_version_id = $2
      ORDER BY ordinal`,
    [context.scope.workspaceId, sequenceVersionId],
  );
  return rows.map(toStep);
}

/** Every version of a sequence, newest first, with its steps. */
export async function listSequenceVersions(
  context: RepositoryContext,
  sequenceId: string,
): Promise<readonly SequenceVersionRow[]> {
  const { rows } = await context.db.query<VersionDbRow>(
    `SELECT ${VERSION_COLUMNS} FROM sequence_versions
      WHERE workspace_id = $1 AND sequence_id = $2
      ORDER BY version DESC`,
    [context.scope.workspaceId, sequenceId],
  );
  const versions: SequenceVersionRow[] = [];
  for (const row of rows) {
    versions.push({ ...toVersion(row), steps: await readSequenceSteps(context, row.id) });
  }
  return versions;
}

const ENROLLMENT_COLUMNS = `id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
  state, started_at, ended_at, end_reason, firm_time_zone, holiday_calendar_version,
  review_union_milliseconds`;

interface EnrollmentDbRow {
  readonly id: string;
  readonly sequence_version_id: string;
  readonly opportunity_id: string;
  readonly firm_id: string;
  readonly contact_id: string;
  readonly assigned_user_id: string;
  readonly state: EnrollmentState;
  readonly started_at: Date;
  readonly ended_at: Date | null;
  readonly end_reason: EnrollmentEndReason | null;
  readonly firm_time_zone: string;
  readonly holiday_calendar_version: string;
  readonly review_union_milliseconds: string | number | null;
  readonly [column: string]: unknown;
}

export function toEnrollment(row: EnrollmentDbRow): EnrollmentRow {
  return {
    id: row.id,
    sequenceVersionId: row.sequence_version_id,
    opportunityId: row.opportunity_id,
    firmId: row.firm_id,
    contactId: row.contact_id,
    assignedUserId: row.assigned_user_id,
    state: row.state,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at === null ? null : row.ended_at.toISOString(),
    endReason: row.end_reason,
    firmTimeZone: row.firm_time_zone,
    holidayCalendarVersion: row.holiday_calendar_version,
    reviewUnionMilliseconds:
      row.review_union_milliseconds === null ? null : Number(row.review_union_milliseconds),
  };
}

export async function readEnrollment(
  context: RepositoryContext,
  input: { readonly enrollmentId: string },
): Promise<EnrollmentRow | null> {
  const { rows } = await context.db.query<EnrollmentDbRow>(
    `SELECT ${ENROLLMENT_COLUMNS} FROM sequence_enrollments WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, input.enrollmentId],
  );
  const row = rows[0];
  return row === undefined ? null : toEnrollment(row);
}

/**
 * The enrollment, locked for update.
 *
 * Every command that ends, holds or reschedules an enrollment takes this first, so
 * the terminal stop and the ten-minute LinkedIn undo cannot interleave halfway
 * through each other's work.
 */
export async function loadEnrollmentForUpdate(
  context: RepositoryContext,
  enrollmentId: string,
): Promise<EnrollmentRow | null> {
  const { rows } = await context.db.query<EnrollmentDbRow>(
    `SELECT ${ENROLLMENT_COLUMNS} FROM sequence_enrollments
      WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [context.scope.workspaceId, enrollmentId],
  );
  const row = rows[0];
  return row === undefined ? null : toEnrollment(row);
}

export interface ListEnrollmentsInput {
  readonly firmId?: string | undefined;
  readonly opportunityId?: string | undefined;
  readonly contactId?: string | undefined;
  /** Default true: an ended enrollment is history, and most callers want the live ones. */
  readonly liveOnly?: boolean | undefined;
}

export async function listEnrollments(
  context: RepositoryContext,
  input: ListEnrollmentsInput = {},
): Promise<readonly EnrollmentRow[]> {
  const { rows } = await context.db.query<EnrollmentDbRow>(
    `SELECT ${ENROLLMENT_COLUMNS} FROM sequence_enrollments
      WHERE workspace_id = $1
        AND ($2::uuid IS NULL OR firm_id = $2)
        AND ($3::uuid IS NULL OR opportunity_id = $3)
        AND ($4::uuid IS NULL OR contact_id = $4)
        AND ($5::boolean IS FALSE OR ended_at IS NULL)
      ORDER BY started_at, id`,
    [
      context.scope.workspaceId,
      input.firmId ?? null,
      input.opportunityId ?? null,
      input.contactId ?? null,
      input.liveOnly ?? true,
    ],
  );
  return rows.map(toEnrollment);
}

const EXECUTION_COLUMNS = `id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal, state,
  due_at, not_before, original_due_at, source_zone, rule_version, attempt_count, hold_reason_code,
  completion_source, result, completed_at`;

interface ExecutionDbRow {
  readonly id: string;
  readonly enrollment_id: string;
  readonly step_id: string;
  readonly firm_id: string;
  readonly contact_id: string;
  readonly channel: StepChannel;
  readonly ordinal: number;
  readonly state: StepExecutionState;
  readonly due_at: Date;
  readonly not_before: Date;
  readonly original_due_at: Date;
  readonly source_zone: string;
  readonly rule_version: string;
  readonly attempt_count: number;
  readonly hold_reason_code: HoldReasonCode | null;
  readonly completion_source: StepCompletionSource | null;
  readonly result: StepResult | null;
  readonly completed_at: Date | null;
  readonly [column: string]: unknown;
}

export function toExecution(row: ExecutionDbRow): StepExecutionRow {
  return {
    id: row.id,
    enrollmentId: row.enrollment_id,
    stepId: row.step_id,
    firmId: row.firm_id,
    contactId: row.contact_id,
    channel: row.channel,
    ordinal: Number(row.ordinal),
    state: row.state,
    dueAt: row.due_at.toISOString(),
    notBefore: row.not_before.toISOString(),
    originalDueAt: row.original_due_at.toISOString(),
    sourceZone: row.source_zone,
    ruleVersion: row.rule_version,
    attemptCount: Number(row.attempt_count),
    holdReasonCode: row.hold_reason_code,
    completionSource: row.completion_source,
    result: row.result,
    completedAt: row.completed_at === null ? null : row.completed_at.toISOString(),
  };
}

export async function listStepExecutions(
  context: RepositoryContext,
  input: { readonly enrollmentId: string },
): Promise<readonly StepExecutionRow[]> {
  const { rows } = await context.db.query<ExecutionDbRow>(
    `SELECT ${EXECUTION_COLUMNS} FROM step_executions
      WHERE workspace_id = $1 AND enrollment_id = $2
      ORDER BY ordinal, id`,
    [context.scope.workspaceId, input.enrollmentId],
  );
  return rows.map(toExecution);
}

export async function readStepExecution(
  context: RepositoryContext,
  stepExecutionId: string,
): Promise<StepExecutionRow | null> {
  const { rows } = await context.db.query<ExecutionDbRow>(
    `SELECT ${EXECUTION_COLUMNS} FROM step_executions WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, stepExecutionId],
  );
  const row = rows[0];
  return row === undefined ? null : toExecution(row);
}

/** The execution, locked. Every completion, undo and cancellation takes this first. */
export async function loadStepExecutionForUpdate(
  context: RepositoryContext,
  stepExecutionId: string,
): Promise<StepExecutionRow | null> {
  const { rows } = await context.db.query<ExecutionDbRow>(
    `SELECT ${EXECUTION_COLUMNS} FROM step_executions
      WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [context.scope.workspaceId, stepExecutionId],
  );
  const row = rows[0];
  return row === undefined ? null : toExecution(row);
}

/**
 * The next unfinished execution of an enrollment, by ordinal.
 *
 * A held step is still the next one: 11.2 holds a step rather than skipping it, and a
 * reader that walked past a held step would show the salesperson a cadence that has
 * quietly moved on.
 */
export async function nextUnfinishedExecution(
  context: RepositoryContext,
  enrollmentId: string,
): Promise<StepExecutionRow | null> {
  const { rows } = await context.db.query<ExecutionDbRow>(
    `SELECT ${EXECUTION_COLUMNS} FROM step_executions
      WHERE workspace_id = $1 AND enrollment_id = $2 AND state IN ('pending', 'held')
      ORDER BY ordinal, id LIMIT 1`,
    [context.scope.workspaceId, enrollmentId],
  );
  const row = rows[0];
  return row === undefined ? null : toExecution(row);
}

/** Every execution of an enrollment that has not run yet. What a shift and a stop touch. */
export async function unexecutedExecutions(
  context: RepositoryContext,
  enrollmentId: string,
): Promise<readonly StepExecutionRow[]> {
  const { rows } = await context.db.query<ExecutionDbRow>(
    `SELECT ${EXECUTION_COLUMNS} FROM step_executions
      WHERE workspace_id = $1 AND enrollment_id = $2 AND state IN ('pending', 'held')
      ORDER BY ordinal, id
      FOR UPDATE`,
    [context.scope.workspaceId, enrollmentId],
  );
  return rows.map(toExecution);
}
