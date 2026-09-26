import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { runTwiceUnderStolenLease } from '@fss/domain/jobs/atLeastOnce.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { SENDING_STOP_LINE, templateContentHash } from '@fss/domain/src/rules/templates.ts';
import { allowAllEligibility } from '@fss/domain/sequences/eligibility.ts';
import { listStepExecutions } from '@fss/domain/sequences/rows.ts';
import { recordingSendHandoff, type RecordingSendHandoff } from '@fss/domain/sequences/sendHandoff.ts';
import { runClaimedJob } from '../src/runner/jobRunner.ts';
import { runSchedulerPass } from '../src/scheduler/schedulerPass.ts';
import { sequenceActionJobHandler, sequenceActionSource } from '../src/handlers/sequenceAction.ts';

/**
 * The `sequence.action` job (Appendix C, specification 11.2, 13.1, Appendix G 1
 * and 2).
 *
 * Three things are proved here and nowhere else.
 *
 * **The registry accepts it under Appendix C's protection and no other.** The table
 * says `outbound_fence` for this kind, and that is not cosmetic: the runner runs an
 * `outbound_fence` handler *outside* the completion transaction, because
 * `prepared → dispatching` cannot be rolled back.
 *
 * **One job per due execution, whatever the pass does.** Appendix G 1, for this
 * source: two passes, one row, because the key is `step-execution:{id}` and
 * `UNIQUE(workspace_id, kind, idempotency_key)` refuses the second.
 *
 * **One send under a real stolen lease.** `docs/greenfield/jobs.md` makes that probe
 * mandatory for every lane that registers a handler, and here the business effect
 * counted is the number of requests the send hand-off received — which is the thing
 * invariant 1 is about.
 *
 * No real business name, address or number appears.
 */
describe('the sequence action as a job', () => {
  let database: TestDatabase;
  let workspaceId = '';
  let userId = '';
  let firmId = '';
  let contactId = '';
  let enrollmentId = '';
  let executionId = '';
  let handoff: RecordingSendHandoff;

  const worker = () =>
    repositoryContext(
      workspaceScope(workspaceId, { kind: 'system', component: 'worker' }),
      database.session,
    );

  /**
   * Put the enrollment back to live.
   *
   * A test that lets the cadence run to its end completes the enrollment, and the
   * source deliberately ignores work belonging to one that has ended.
   */
  const reopen = async (): Promise<void> => {
    await database.session.query(
      `UPDATE sequence_enrollments
          SET state = 'active', ended_at = NULL, end_reason = NULL
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, enrollmentId],
    );
  };

  /**
   * How many jobs the scheduler has materialized for one execution — every wake of it
   * (the key is `step-execution:{id}:{wake}`).
   */
  const jobsFor = async (id: string): Promise<number> => {
    const { rows } = await database.session.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM jobs
        WHERE kind = 'sequence.action' AND payload ->> 'stepExecutionId' = $1`,
      [id],
    );
    return Number(rows[0]?.count ?? '0');
  };

  const one = async (sql: string, values: readonly unknown[] = []): Promise<string> => {
    const { rows } = await database.session.query<{ id: string }>(sql, values);
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`the fixture returned no row: ${sql.slice(0, 50)}`);
    return id;
  };

  beforeAll(async () => {
    database = await createTestDatabase();
    workspaceId = await one(
      "INSERT INTO workspaces (slug, display_name) VALUES ('alpha', 'Alpha') RETURNING id",
    );
    userId = await one(
      "INSERT INTO users (google_sub, email, display_name) VALUES ('sub-seq', 'seq@example.test', 'Seq') RETURNING id",
    );
    await database.session.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'salesperson')",
      [workspaceId, userId],
    );
    firmId = await one(
      `INSERT INTO firms (workspace_id, name, assigned_user_id, region_code, postal_code,
                          time_zone, time_zone_confidence, time_zone_source, time_zone_rule_version)
       VALUES ($1, 'Northwind Test Holdings', $2, 'RI', '02903',
               'America/New_York', 'high', 'postal', 'firm-zone.1')
       RETURNING id`,
      [workspaceId, userId],
    );
    contactId = await one(
      "INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, 'Dana Example') RETURNING id",
      [workspaceId, firmId],
    );
    await database.session.query(
      `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at,
                                    association_confidence, technical_validation, eligibility,
                                    eligibility_policy_version)
       VALUES ($1, $2, $3, 'dana@northwind.example.test', 'salesperson', now(),
               0.950, 'passed', 'usable', 'route-policy.1')`,
      [workspaceId, firmId, contactId],
    );
    const stageId = await one(
      'SELECT id FROM pipeline_stages WHERE workspace_id = $1 ORDER BY position LIMIT 1',
      [workspaceId],
    );
    const opportunityId = await one(
      `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
       VALUES ($1, $2, $3, now()) RETURNING id`,
      [workspaceId, firmId, stageId],
    );

    const templateId = await one('SELECT gen_random_uuid() AS id');
    const subject = 'A question about {firm_name}';
    const body = `Hello,\n\nA note.\n\nSam Example\n${SENDING_STOP_LINE}`;
    const templateVersionId = await one(
      `INSERT INTO template_versions
         (workspace_id, template_id, version, name, subject, body, content_hash,
          footer_sign_off, required_variables, approved_at, approved_by_user_id)
       VALUES ($1, $2, 1, 'First touch', $3, $4, $5, 'Sam Example',
               ARRAY['firm_name'], now(), $6)
       RETURNING id`,
      [
        workspaceId,
        templateId,
        subject,
        body,
        templateContentHash({ templateId, version: 1, subject, body }),
        userId,
      ],
    );

    const sequenceId = await one(
      "INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, 'Outreach', $2) RETURNING id",
      [workspaceId, userId],
    );
    const versionId = await one(
      'INSERT INTO sequence_versions (workspace_id, sequence_id, version) VALUES ($1, $2, 1) RETURNING id',
      [workspaceId, sequenceId],
    );
    const stepId = await one(
      `INSERT INTO sequence_steps
         (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, template_version_id)
       VALUES ($1, $2, 1, 'email', 'elapsed', 0, $3) RETURNING id`,
      [workspaceId, versionId, templateVersionId],
    );
    await database.session.query(
      `UPDATE sequence_versions SET state = 'published', published_at = now(), published_by_user_id = $3
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, versionId, userId],
    );

    enrollmentId = await one(
      `INSERT INTO sequence_enrollments
         (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
          firm_time_zone, holiday_calendar_version)
       VALUES ($1, $2, $3, $4, $5, $6, 'America/New_York', 'none.1') RETURNING id`,
      [workspaceId, versionId, opportunityId, firmId, contactId, userId],
    );
    // Friday 18 September 2026 at 09:00 New York: a weekday inside the sending
    // window, and in the past, so the scheduler sees it as due and the window rule
    // leaves it where it is rather than moving it.
    executionId = await one(
      `INSERT INTO step_executions
         (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal,
          due_at, not_before, original_due_at, source_zone, rule_version)
       VALUES ($1, $2, $3, $4, $5, 'email', 1,
               TIMESTAMPTZ '2026-09-18T13:00:00Z', TIMESTAMPTZ '2026-09-18T13:00:00Z',
               TIMESTAMPTZ '2026-09-18T13:00:00Z', 'America/New_York', 'elapsed.1')
       RETURNING id`,
      [workspaceId, enrollmentId, stepId, firmId, contactId],
    );
    handoff = recordingSendHandoff();
  });

  afterAll(async () => {
    await database.drop();
  });

  it('registers under the protection Appendix C names, and refuses any other', () => {
    const registry = new HandlerRegistry().register(sequenceActionJobHandler());
    expect(registry.kinds()).toContain('sequence.action');
    expect(registry.get('sequence.action')?.protection).toBe('outbound_fence');
    expect(() =>
      new HandlerRegistry().register({
        ...sequenceActionJobHandler(),
        protection: 'business_uniqueness',
      }),
    ).toThrow();
  });

  it('materializes one job per due execution however many passes run (G 1)', async () => {
    const report = await runSchedulerPass(database.session, {
      sources: [sequenceActionSource()],
      now: '2026-09-18T14:00:00Z',
    });
    expect(report.inserted).toBeGreaterThanOrEqual(1);
    expect(report.externalActions).toBe(0);

    await runSchedulerPass(database.session, {
      sources: [sequenceActionSource()],
      now: '2026-09-18T14:01:00Z',
    });
    const { rows } = await database.session.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM jobs WHERE kind = 'sequence.action'",
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('hands one send to the fence under a real stolen lease (G 2)', async () => {
    await database.session.query("DELETE FROM jobs WHERE kind = 'sequence.action'");
    await database.session.query(
      `UPDATE step_executions SET state = 'pending' WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, executionId],
    );

    const registry = new HandlerRegistry().register(
      sequenceActionJobHandler({ sendHandoff: handoff, eligibility: allowAllEligibility() }),
    );
    const report = await runTwiceUnderStolenLease({
      session: database.session,
      registry,
      run: runClaimedJob,
      workspaceId,
      kind: 'sequence.action',
      idempotencyKey: `step-execution:${executionId}`,
      payload: { stepExecutionId: executionId },
      countEffects: async () => await Promise.resolve(handoff.prepared.length),
    });

    expect(report.freshOutcome).toBe('completed');
    expect(report.staleOutcome).not.toBe('completed');
    expect(report.effectsAfter - report.effectsBefore).toBe(1);
    // One fence prepared, and one dispatch: the stolen lease sends nothing twice.
    expect(handoff.dispatched).toHaveLength(1);

    const executions = await listStepExecutions(worker(), { enrollmentId });
    const first = executions.find(execution => execution.ordinal === 1);
    expect(first?.state).toBe('completed');
    expect(first?.result).toBe('sent');
  });

  it('asks again about a capped step once its interval passes, and about a paused one only after the release', async () => {
    await database.session.query("DELETE FROM jobs WHERE kind = 'sequence.action'");
    await reopen();
    // A cap clears with the business date, so the step is runnable again once its
    // `not_before` passes.
    await database.session.query(
      `UPDATE step_executions
          SET state = 'held', hold_reason_code = 'daily_cap', not_before = due_at,
              completed_at = NULL, completion_source = NULL, result = NULL, updated_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, executionId],
    );
    await runSchedulerPass(database.session, {
      sources: [sequenceActionSource()],
      now: '2026-09-18T14:00:00Z',
    });
    expect(await jobsFor(executionId)).toBe(1);

    // An administrator's pause of the firm: while its hold is open the step is not
    // asked at all (C10), and the pass after the release asks (C05).
    await database.session.query("DELETE FROM jobs WHERE kind = 'sequence.action'");
    const { rows } = await database.session.query<{ id: string }>(
      `INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds,
                                 source_event_kind)
       VALUES ($1, 'firm', $2, 'scoped_pause', ARRAY['email_send', 'enrollment_advance'], 'administrative_pause')
       RETURNING id`,
      [workspaceId, firmId],
    );
    await database.session.query(
      `UPDATE step_executions SET hold_reason_code = 'scoped_pause', updated_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, executionId],
    );
    await runSchedulerPass(database.session, {
      sources: [sequenceActionSource()],
      now: '2026-09-18T14:00:00Z',
    });
    expect(await jobsFor(executionId)).toBe(0);

    await database.session.query('UPDATE active_holds SET released_at = now() WHERE workspace_id = $1 AND id = $2', [
      workspaceId,
      rows[0]?.id,
    ]);
    await runSchedulerPass(database.session, {
      sources: [sequenceActionSource()],
      now: '2026-09-18T14:00:00Z',
    });
    expect(await jobsFor(executionId)).toBe(1);

    // A reason no hold row stands behind waits out its recheck, then is asked again.
    await database.session.query("DELETE FROM jobs WHERE kind = 'sequence.action'");
    await database.session.query(
      `UPDATE step_executions
          SET hold_reason_code = 'template_unapproved', not_before = TIMESTAMPTZ '2026-09-18T15:00:00Z',
              updated_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, executionId],
    );
    await runSchedulerPass(database.session, {
      sources: [sequenceActionSource()],
      now: '2026-09-18T14:00:00Z',
    });
    expect(await jobsFor(executionId)).toBe(0);
    await runSchedulerPass(database.session, {
      sources: [sequenceActionSource()],
      now: '2026-09-18T15:00:00Z',
    });
    expect(await jobsFor(executionId)).toBe(1);
    await database.session.query("DELETE FROM jobs WHERE kind = 'sequence.action'");
  });

  it('holds a due email step when no send is wired, rather than failing the job', async () => {
    await database.session.query("DELETE FROM jobs WHERE kind = 'sequence.action'");
    await reopen();
    await database.session.query(
      `UPDATE step_executions
          SET state = 'pending', hold_reason_code = NULL,
              completed_at = NULL, completion_source = NULL, result = NULL
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, executionId],
    );
    const registry = new HandlerRegistry().register(
      sequenceActionJobHandler({ eligibility: allowAllEligibility() }),
    );
    const report = await runTwiceUnderStolenLease({
      session: database.session,
      registry,
      run: runClaimedJob,
      workspaceId,
      kind: 'sequence.action',
      idempotencyKey: `step-execution:${executionId}:unwired`,
      payload: { stepExecutionId: executionId },
      countEffects: async () => await Promise.resolve(0),
    });
    expect(report.freshOutcome).toBe('completed');

    const executions = await listStepExecutions(worker(), { enrollmentId });
    expect(executions[0]?.state).toBe('held');
    expect(executions[0]?.holdReasonCode).toBe('scoped_pause');
  });
});
