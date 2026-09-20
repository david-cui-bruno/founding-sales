import type { SessionQueryable } from '../queryable.ts';

/**
 * A real `step_executions` row for a fixture that needs one to point at.
 *
 * Migration 0012 adds `outbound_messages_step_execution_fkey`, which 0010 asked for
 * in the comment beside the column: "Neither table exists yet; G8's 0012 adds the
 * foreign keys." Once it exists, a fence can no longer name an invented uuid, and the
 * outbound fixtures that did have to mint the row they were pretending existed.
 *
 * This is the one place that knows how. It is here rather than in either lane's
 * support file because both need it — `db/support/outboundFixtures.ts` for the seeded
 * fences and `outbound/support/outboundWorld.ts` for the scenarios — and two copies
 * of a five-table insert is two things to fix when the schema moves.
 *
 * ## What one call makes
 *
 * A contact, an enrollment and one step execution, against a published one-step
 * sequence version that is created once per workspace and reused. A *new contact*
 * each time rather than a new sequence, because `sequence_enrollments_one_active_per_contact`
 * permits one live enrollment per contact and a published version is immutable and
 * therefore safe to share. The result is the shape the real thing has: one contact,
 * one live enrollment, one pending step.
 *
 * No real person, firm or address appears; the names are fixture names and the
 * addresses are in `example.test`, which RFC 6761 reserves.
 */

export interface StepExecutionFixtureInput {
  readonly workspaceId: string;
  readonly firmId: string;
  /** An open opportunity for the firm. One is made against the first stage if absent. */
  readonly opportunityId?: string | undefined;
  /** Whose mailbox the enrollment belongs to, and who published the fixture sequence. */
  readonly userId: string;
  /** An approved template version in this workspace; an email step needs one. */
  readonly templateVersionId: string;
  /** Force the execution's id, for the fixtures that assert on a known uuid. */
  readonly id?: string | undefined;
  readonly zone?: string | undefined;
}

let counter = 0;

/** Insert one step execution and everything it needs, and return its id. */
export async function makeStepExecution(
  session: SessionQueryable,
  input: StepExecutionFixtureInput,
): Promise<string> {
  // Idempotent on an explicit id, because a caller proving that two prepares reuse
  // one fence asks for the same step execution twice and means the same row.
  if (input.id !== undefined) {
    const existing = await session.query<{ id: string }>(
      'SELECT id FROM step_executions WHERE workspace_id = $1 AND id = $2',
      [input.workspaceId, input.id],
    );
    const found = existing.rows[0]?.id;
    if (found !== undefined) return found;
  }

  counter += 1;
  const zone = input.zone ?? 'America/New_York';
  const stepId = await fixtureStep(session, input);

  const contact = await session.query<{ id: string }>(
    `INSERT INTO contacts (workspace_id, firm_id, full_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [input.workspaceId, input.firmId, `Fence Fixture ${String(counter).padStart(4, '0')}`],
  );
  const contactId = contact.rows[0]?.id ?? '';

  const opportunityId = input.opportunityId ?? (await fixtureOpportunity(session, input));

  const enrollment = await session.query<{ id: string }>(
    `INSERT INTO sequence_enrollments
       (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id,
        assigned_user_id, firm_time_zone, holiday_calendar_version)
     VALUES ($1, (SELECT sequence_version_id FROM sequence_steps
                   WHERE workspace_id = $1 AND id = $2), $3, $4, $5, $6, $7, 'none.1')
     RETURNING id`,
    [input.workspaceId, stepId, opportunityId, input.firmId, contactId, input.userId, zone],
  );
  const enrollmentId = enrollment.rows[0]?.id ?? '';

  const execution = await session.query<{ id: string }>(
    `INSERT INTO step_executions
       (workspace_id, id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal,
        due_at, not_before, original_due_at, source_zone, rule_version)
     VALUES ($1, coalesce($2::uuid, gen_random_uuid()), $3, $4, $5, $6, 'email', 1,
             now(), now(), now(), $7, 'elapsed.1')
     RETURNING id`,
    [input.workspaceId, input.id ?? null, enrollmentId, stepId, input.firmId, contactId, zone],
  );
  return execution.rows[0]?.id ?? '';
}

/** An open opportunity on the workspace's first pipeline stage, for a firm without one. */
async function fixtureOpportunity(
  session: SessionQueryable,
  input: StepExecutionFixtureInput,
): Promise<string> {
  const created = await session.query<{ id: string }>(
    `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
     VALUES ($1, $2, (SELECT id FROM pipeline_stages WHERE workspace_id = $1
                       ORDER BY position LIMIT 1), now())
     RETURNING id`,
    [input.workspaceId, input.firmId],
  );
  return created.rows[0]?.id ?? '';
}

const FIXTURE_SEQUENCE_NAME = 'Fence fixture sequence';

/**
 * The one published email step every fixture execution belongs to, made on demand.
 *
 * Memoized in the database rather than in a module variable: each test file gets its
 * own database, and a cache that outlived one of them would hand back an id from
 * somebody else's schema.
 */
async function fixtureStep(
  session: SessionQueryable,
  input: StepExecutionFixtureInput,
): Promise<string> {
  const existing = await session.query<{ id: string }>(
    `SELECT step.id
       FROM sequence_steps step
       JOIN sequence_versions version
         ON version.workspace_id = step.workspace_id AND version.id = step.sequence_version_id
       JOIN sequences sequence
         ON sequence.workspace_id = version.workspace_id AND sequence.id = version.sequence_id
      WHERE sequence.workspace_id = $1 AND sequence.name = $2
      LIMIT 1`,
    [input.workspaceId, FIXTURE_SEQUENCE_NAME],
  );
  const found = existing.rows[0]?.id;
  if (found !== undefined) return found;

  const sequence = await session.query<{ id: string }>(
    `INSERT INTO sequences (workspace_id, name, created_by_user_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [input.workspaceId, FIXTURE_SEQUENCE_NAME, input.userId],
  );
  const version = await session.query<{ id: string }>(
    `INSERT INTO sequence_versions (workspace_id, sequence_id, version)
     VALUES ($1, $2, 1) RETURNING id`,
    [input.workspaceId, sequence.rows[0]?.id ?? ''],
  );
  const versionId = version.rows[0]?.id ?? '';
  const step = await session.query<{ id: string }>(
    `INSERT INTO sequence_steps
       (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount,
        template_version_id)
     VALUES ($1, $2, 1, 'email', 'elapsed', 0, $3) RETURNING id`,
    [input.workspaceId, versionId, input.templateVersionId],
  );
  // Published after the step, because the steps of a published version are immutable.
  await session.query(
    `UPDATE sequence_versions
        SET state = 'published', published_at = now(), published_by_user_id = $3
      WHERE workspace_id = $1 AND id = $2`,
    [input.workspaceId, versionId, input.userId],
  );
  return step.rows[0]?.id ?? '';
}
