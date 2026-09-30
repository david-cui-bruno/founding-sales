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
 *
 * ## The origin, since migration 0025
 *
 * Every enrollment now says what it is for, and the default is `cold_legacy` — which
 * never sends. So this fixture has to choose, and it chooses **`follow_up` on a real
 * permission with real evidence**: a `call_logs` row with outcome `interested` for this
 * contact, and a `follow_up_permissions` row of scope `agreed_sequence` naming the
 * fixture sequence, granted by the fixture's own user and expiring in a year.
 *
 * Two reasons, and neither is convenience. First, it is the only origin that matches
 * what these fixtures *are*: several of them make more than one contact at one firm, and
 * David's rule of 29 September 2026 is that a firm has one active *prospecting* contact
 * while follow-up permissions to several people at a customer firm are explicitly
 * permitted — so `prospecting` would make the fixture refuse itself with
 * `firm_already_enrolled`, which is a true refusal about the wrong thing. Second, the
 * evidence is real rather than stubbed, so `followUpPermissionSource` does the whole of
 * its work — it re-reads the call log, matches the firm and the recipient, checks the
 * expiry and the scope — on every send test in the repository, rather than being
 * exercised only by its own file.
 *
 * `originKind` overrides it, and `'cold_legacy'` is how a test asks for a pre-0025 row.
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
  /**
   * Migration 0025's origin. Defaults to `follow_up` with a granted permission and its
   * evidence (see the header). `cold_legacy` is a pre-0025 row; `prospecting` is a cold
   * first touch, and is refused for a second contact at one firm, which is the point.
   */
  readonly originKind?: 'cold_legacy' | 'prospecting' | 'follow_up' | undefined;
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

  // The contact's own usable address. Since the review of PR 332 (P0-2) the dispatch
  // requires the fence's frozen route to **belong to the enrollment's contact** and its
  // address to be the one the fence will send to, so a fixture whose enrollment is for
  // one person and whose route is another's is a fixture that can no longer send — and
  // that is the check working, not a limitation. RFC 6761 reserves `example.test`.
  await session.query(
    `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at,
                                  association_confidence, technical_validation, eligibility,
                                  eligibility_policy_version)
     VALUES ($1, $2, $3, $4, 'research_provider', now(), 0.900, 'passed', 'usable', 'route-policy.1')`,
    [
      input.workspaceId,
      input.firmId,
      contactId,
      `fence.fixture.${String(counter).padStart(4, '0')}@example.test`,
    ],
  );

  const opportunityId = input.opportunityId ?? (await fixtureOpportunity(session, input));

  // `test/db/migrations.test.ts` seeds this fixture into a database stopped at an
  // earlier schema, to prove a later migration is correct on production-shaped data. At
  // schema 24 and below there is no origin column and no permissions table, so the
  // fixture writes the pre-0025 shape — which is exactly the row that migration turns
  // into a `cold_legacy` one.
  const hasOrigin = await tableExists(session, 'follow_up_permissions');
  const originKind = input.originKind ?? 'follow_up';
  const permissionId =
    hasOrigin && originKind === 'follow_up'
      ? await fixturePermission(session, { ...input, contactId, opportunityId, stepId })
      : null;

  const enrollment = await session.query<{ id: string }>(
    hasOrigin
      ? `INSERT INTO sequence_enrollments
           (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id,
            assigned_user_id, firm_time_zone, holiday_calendar_version, origin_kind, permission_id)
         VALUES ($1, (SELECT sequence_version_id FROM sequence_steps
                       WHERE workspace_id = $1 AND id = $2), $3, $4, $5, $6, $7, 'none.1', $8, $9)
         RETURNING id`
      : `INSERT INTO sequence_enrollments
           (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id,
            assigned_user_id, firm_time_zone, holiday_calendar_version)
         VALUES ($1, (SELECT sequence_version_id FROM sequence_steps
                       WHERE workspace_id = $1 AND id = $2), $3, $4, $5, $6, $7, 'none.1')
         RETURNING id`,
    hasOrigin
      ? [
          input.workspaceId,
          stepId,
          opportunityId,
          input.firmId,
          contactId,
          input.userId,
          zone,
          originKind,
          permissionId,
        ]
      : [input.workspaceId, stepId, opportunityId, input.firmId, contactId, input.userId, zone],
  );
  const enrollmentId = enrollment.rows[0]?.id ?? '';
  if (permissionId !== null) {
    // The permission buys **this** run, which is what `enrollContact` records with
    // `bindFollowUpPermission`. The fixture used to leave the binding null, so every
    // send test ran against a permission that had bought nothing in particular
    // (P0-3 of the second review of PR 332).
    await session.query(
      `UPDATE follow_up_permissions SET enrollment_id = $3
        WHERE workspace_id = $1 AND id = $2 AND enrollment_id IS NULL`,
      [input.workspaceId, permissionId, enrollmentId],
    );
  }

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

/** Whether this database has reached the migration that creates `name`. */
async function tableExists(session: SessionQueryable, name: string): Promise<boolean> {
  const { rows } = await session.query<{ present: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS present',
    [name],
  );
  return rows[0]?.present === true;
}

/**
 * The permission a `follow_up` fixture enrollment rests on, and the call it rests on.
 *
 * The call log is the evidence `verifyFollowUpPermission` re-reads: same firm, same
 * person, outcome `interested`. `step_effect` is `none` because no step was applied by
 * it; `occurred_at` is a second in the past so `call_logs_recorded_not_before_occurred`
 * holds however fast the clock is read.
 */
async function fixturePermission(
  session: SessionQueryable,
  input: StepExecutionFixtureInput & {
    readonly contactId: string;
    readonly opportunityId: string;
    readonly stepId: string;
  },
): Promise<string> {
  const call = await session.query<{ id: string }>(
    `INSERT INTO call_logs
       (workspace_id, firm_id, contact_id, opportunity_id, outcome, step_effect, occurred_at,
        actor_user_id, agreed_follow_up, agreed_sequence_version_id)
     VALUES ($1, $2, $3, $4, 'interested', 'none', now() - interval '1 second', $5,
             'agreed_sequence',
             (SELECT s.sequence_version_id FROM sequence_steps s
               WHERE s.workspace_id = $1 AND s.id = $6))
     RETURNING id`,
    [
      input.workspaceId,
      input.firmId,
      input.contactId,
      input.opportunityId,
      input.userId,
      input.stepId,
    ],
  );
  const granted = await session.query<{ id: string }>(
    `INSERT INTO follow_up_permissions
       (workspace_id, firm_id, contact_id, kind, scope, call_log_id, sequence_version_id, max_steps,
        expires_at, granted_by_user_id, note)
     VALUES ($1, $2, $3, 'agreed_sequence', 'agreed_sequence', $4,
             (SELECT s.sequence_version_id FROM sequence_steps s
               WHERE s.workspace_id = $1 AND s.id = $5),
             (SELECT count(*) FROM sequence_steps s2
               WHERE s2.workspace_id = $1
                 AND s2.sequence_version_id = (SELECT s3.sequence_version_id FROM sequence_steps s3
                                                WHERE s3.workspace_id = $1 AND s3.id = $5)),
             now() + interval '365 days', $6, 'a fixture follow-up agreed on the call')
     RETURNING id`,
    [input.workspaceId, input.firmId, input.contactId, call.rows[0]?.id ?? '', input.stepId, input.userId],
  );
  return granted.rows[0]?.id ?? '';
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
/**
 * The published one-step version this fixture enrols against, created if it is not there.
 *
 * Exported for the end-to-end case (P2-2 of the GPT-6 review of PR 332), which enrols a
 * prospecting contact through `enrollContact` rather than by insert and therefore needs
 * the version id the command takes.
 */
export async function fixtureSequenceVersionId(
  session: SessionQueryable,
  input: StepExecutionFixtureInput,
): Promise<string> {
  const stepId = await fixtureStep(session, input);
  const { rows } = await session.query<{ sequence_version_id: string }>(
    'SELECT sequence_version_id FROM sequence_steps WHERE workspace_id = $1 AND id = $2',
    [input.workspaceId, stepId],
  );
  return rows[0]?.sequence_version_id ?? '';
}

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
