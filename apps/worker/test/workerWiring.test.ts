import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing';
import { repositoryContext, workspaceScope, type RepositoryContext } from '@fss/domain/db';
import { HandlerRegistry } from '@fss/domain/jobs';
import { changeStage } from '@fss/domain/crm';
import { recordSuppression, recordingSuppressionJournal } from '@fss/domain/suppression';
import { SENDING_STOP_LINE, templateContentHash } from '@fss/domain';
import { runOnce } from '../src/runner/jobRunner.ts';
import { runSchedulerPass } from '../src/scheduler/schedulerPass.ts';
import { workerDueWorkSources } from '../src/bootstrap/main.ts';
import { terminalStopJobHandler } from '../src/handlers/terminalStop.ts';
import { sendDayCloseJobHandler } from '../src/handlers/sendDayClose.ts';

/**
 * The three seams lanes G3a, G4 and G7-2 built and nobody wired (lane G15).
 *
 * Every case here runs the *real* pass: `workerDueWorkSources()` — the list
 * `bootstrap/main.ts` hands the scheduler and `fss admin scheduler run-once` reruns —
 * materialises the work, and the runner claims it. A test that called the domain
 * function directly would have passed on main, which is exactly the failure this
 * lane exists to close.
 *
 * Two workspaces throughout, with colliding identifiers: the same enrollment uuid,
 * the same mailbox address local part, the same business date. Alpha is acted on and
 * beta must be untouched afterwards.
 *
 * No fixture instant is a literal. Everything is derived from the database's clock,
 * because a suite pinned to a date stops testing its subject the day the date passes
 * (COMMON-G, 21 September).
 */

/** One workspace's fixture, and the ids a test asserts against. */
interface Seeded {
  readonly workspaceId: string;
  readonly adminUserId: string;
  readonly firmId: string;
  readonly contactId: string;
  readonly contactAddress: string;
  readonly opportunityId: string;
  readonly enrollmentId: string;
  readonly executionId: string;
  readonly mailboxId: string;
}

/** The same uuid in both workspaces; `(workspace_id, id)` is what lets it be. */
const COLLIDING_ENROLLMENT_ID = '5e9f1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const COLLIDING_EXECUTION_ID = '6f0a2b3c-4d5e-4f6a-8b9c-1d2e3f4a5b6c';

describe('the worker drains what the lanes left', () => {
  let database: TestDatabase;
  let alpha: Seeded;
  let beta: Seeded;

  const ctx = (seeded: Seeded, actor: 'system' | 'admin' = 'system'): RepositoryContext =>
    repositoryContext(
      workspaceScope(
        seeded.workspaceId,
        actor === 'system'
          ? { kind: 'system', component: 'worker' }
          : { kind: 'user', userId: seeded.adminUserId, role: 'admin' },
      ),
      database.session,
    );

  const one = async (sql: string, values: readonly unknown[] = []): Promise<string> => {
    const { rows } = await database.session.query<{ id: string }>(sql, values);
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`the fixture returned no row: ${sql.slice(0, 60)}`);
    return id;
  };

  /** The instant the database believes it is. Never `Date.now()`. */
  const databaseInstant = async (): Promise<string> => {
    const { rows } = await database.session.query<{ now: Date }>('SELECT now() AS now');
    const now = rows[0]?.now;
    if (now === undefined) throw new Error('the database returned no clock');
    return now.toISOString();
  };

  /** One workspace's business date, offset by whole days, computed by PostgreSQL. */
  const businessDate = async (workspaceId: string, dayOffset = 0): Promise<string> => {
    const { rows } = await database.session.query<{ date: string }>(
      `SELECT (((now() AT TIME ZONE w.business_time_zone)::date) + $2::integer)::text AS date
         FROM workspaces w WHERE w.id = $1`,
      [workspaceId, dayOffset],
    );
    const date = rows[0]?.date;
    if (date === undefined) throw new Error('the workspace has no business zone');
    return date;
  };

  /** How many enrollments of this firm are still live. */
  const activeEnrollments = async (seeded: Seeded): Promise<number> => {
    const { rows } = await database.session.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sequence_enrollments
        WHERE workspace_id = $1 AND firm_id = $2 AND ended_at IS NULL`,
      [seeded.workspaceId, seeded.firmId],
    );
    return Number(rows[0]?.count ?? '0');
  };

  const auditCount = async (seeded: Seeded, action: string): Promise<number> => {
    const { rows } = await database.session.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM audit_events WHERE workspace_id = $1 AND action = $2',
      [seeded.workspaceId, action],
    );
    return Number(rows[0]?.count ?? '0');
  };

  /**
   * One scheduler pass over the registered sources, then one runner pass.
   *
   * The registry holds this lane's two handlers only: the others need a Gmail
   * deployment and would leave their kinds unclaimed, which is what a laptop's
   * worker does anyway.
   */
  const passAndRun = async (): Promise<{ inserted: number; completed: number; failed: number }> => {
    const now = await databaseInstant();
    const report = await runSchedulerPass(database.session, {
      sources: workerDueWorkSources(),
      now,
    });
    expect(report.outcome).toBe('ran');
    expect(report.externalActions).toBe(0);
    const registry = new HandlerRegistry()
      .register(terminalStopJobHandler())
      .register(sendDayCloseJobHandler());
    const run = await runOnce(database.session, { registry, owner: 'g15-test', limit: 50 });
    return { inserted: report.inserted, completed: run.completed, failed: run.failed };
  };

  const seed = async (slug: string): Promise<Seeded> => {
    const workspaceId = await one(
      'INSERT INTO workspaces (slug, display_name) VALUES ($1, $2) RETURNING id',
      [slug, slug],
    );
    const adminUserId = await one(
      `INSERT INTO users (google_sub, email, display_name)
       VALUES ($1, $2, 'Wiring Admin') RETURNING id`,
      [`sub-g15-${slug}`, `admin.${slug}@example.test`],
    );
    await database.session.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')",
      [workspaceId, adminUserId],
    );
    const firmId = await one(
      `INSERT INTO firms (workspace_id, name, assigned_user_id, region_code, postal_code,
                          time_zone, time_zone_confidence, time_zone_source, time_zone_rule_version)
       VALUES ($1, 'Northwind Test Holdings', $2, 'RI', '02903',
               'America/New_York', 'high', 'postal', 'firm-zone.1')
       RETURNING id`,
      [workspaceId, adminUserId],
    );
    const contactId = await one(
      "INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, 'Dana Example') RETURNING id",
      [workspaceId, firmId],
    );
    // The same local part in both workspaces: a handle suppression is workspace-wide
    // (10.2) and must not reach across one.
    const contactAddress = `dana@${slug}.example.test`;
    await database.session.query(
      `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at,
                                    association_confidence, technical_validation, eligibility,
                                    eligibility_policy_version)
       VALUES ($1, $2, $3, $4, 'salesperson', now(), 0.950, 'passed', 'usable', 'route-policy.1')`,
      [workspaceId, firmId, contactId, contactAddress],
    );
    const stageId = await one(
      "SELECT id FROM pipeline_stages WHERE workspace_id = $1 AND key = 'new'",
      [workspaceId],
    );
    const opportunityId = await one(
      `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
       VALUES ($1, $2, $3, now()) RETURNING id`,
      [workspaceId, firmId, stageId],
    );

    const templateId = await one('SELECT gen_random_uuid() AS id');
    const subject = 'A question about {firm_name}';
    const body = `Hello,\n\nA note.\n\nSam Example\n1 Example Way\n${SENDING_STOP_LINE}`;
    const templateVersionId = await one(
      `INSERT INTO template_versions
         (workspace_id, template_id, version, name, subject, body, content_hash,
          footer_sign_off, footer_postal_address, required_variables, approved_at, approved_by_user_id)
       VALUES ($1, $2, 1, 'First touch', $3, $4, $5, 'Sam Example', '1 Example Way',
               ARRAY['firm_name'], now(), $6)
       RETURNING id`,
      [
        workspaceId,
        templateId,
        subject,
        body,
        templateContentHash({ templateId, version: 1, subject, body }),
        adminUserId,
      ],
    );
    const sequenceId = await one(
      "INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, 'Outreach', $2) RETURNING id",
      [workspaceId, adminUserId],
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
      [workspaceId, versionId, adminUserId],
    );
    const enrollmentId = await one(
      `INSERT INTO sequence_enrollments
         (workspace_id, id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
          firm_time_zone, holiday_calendar_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'America/New_York', 'none.1') RETURNING id`,
      [
        workspaceId,
        COLLIDING_ENROLLMENT_ID,
        versionId,
        opportunityId,
        firmId,
        contactId,
        adminUserId,
      ],
    );
    // Due an hour ago in the database's own clock, so nothing here depends on the
    // day this suite happens to run.
    const executionId = await one(
      `INSERT INTO step_executions
         (workspace_id, id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal,
          due_at, not_before, original_due_at, source_zone, rule_version)
       VALUES ($1, $2, $3, $4, $5, $6, 'email', 1,
               now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour',
               'America/New_York', 'elapsed.1')
       RETURNING id`,
      [workspaceId, COLLIDING_EXECUTION_ID, enrollmentId, stepId, firmId, contactId],
    );

    const mailboxId = await one(
      `INSERT INTO mailboxes (workspace_id, owner_user_id, email_address, provider_account_id,
                              sync_state, history_id, history_id_updated_at, coverage_watermark_at,
                              baseline_from_at, baseline_completed_at)
       VALUES ($1, $2, $3, $3, 'ready', '100', now(), now(), now() - interval '7 days', now())
       RETURNING id`,
      [workspaceId, adminUserId, `sender@${slug}.example.test`],
    );
    await database.session.query(
      `INSERT INTO sending_domains (workspace_id, domain, spf_pass, dkim_pass, dmarc_pass,
                                    authentication_checked_at, authentication_checked_by_user_id,
                                    postmaster_reviewed_at, automated_sending_enabled,
                                    automated_sending_enabled_at)
       VALUES ($1, $2, true, true, true, now(), $3, now(), true, now())`,
      [workspaceId, `${slug}.example.test`, adminUserId],
    );

    return {
      workspaceId,
      adminUserId,
      firmId,
      contactId,
      contactAddress,
      opportunityId,
      enrollmentId,
      executionId,
      mailboxId,
    };
  };

  beforeAll(async () => {
    database = await createTestDatabase();
    alpha = await seed('alpha');
    beta = await seed('beta');
  });

  afterAll(async () => {
    await database.drop();
  });

  // -----------------------------------------------------------------------
  // 1. Closing an opportunity Won stops its enrollments (8.1)
  // -----------------------------------------------------------------------
  it('stops every active enrollment of a firm whose opportunity was closed Won', async () => {
    expect(await activeEnrollments(alpha)).toBe(1);
    expect(await activeEnrollments(beta)).toBe(1);

    const closed = await changeStage(ctx(alpha, 'admin'), {
      opportunityId: alpha.opportunityId,
      toStageKey: 'won',
    });
    expect(closed.ok).toBe(true);
    // The signal is committed and the effect is not, until the worker runs.
    expect(await activeEnrollments(alpha)).toBe(1);

    const first = await passAndRun();
    expect(first.failed).toBe(0);
    expect(first.inserted).toBeGreaterThanOrEqual(1);

    expect(await activeEnrollments(alpha)).toBe(0);
    // Two workspaces, one closed opportunity: beta's enrollment is untouched.
    expect(await activeEnrollments(beta)).toBe(1);

    const { rows } = await database.session.query<{ end_reason: string; state: string }>(
      'SELECT end_reason, state FROM sequence_enrollments WHERE workspace_id = $1 AND id = $2',
      [alpha.workspaceId, alpha.enrollmentId],
    );
    expect(rows[0]?.end_reason).toBe('stage_won');
    expect(rows[0]?.state).toBe('stopped');

    // One audit event per stopped enrollment, and none in the other workspace.
    expect(await auditCount(alpha, 'enrollment.terminally_stopped')).toBe(1);
    expect(await auditCount(beta, 'enrollment.terminally_stopped')).toBe(0);

    // A second pass is a no-op: the cursor advanced with the stops.
    const second = await passAndRun();
    expect(second.failed).toBe(0);
    expect(await auditCount(alpha, 'enrollment.terminally_stopped')).toBe(1);
    expect(await activeEnrollments(beta)).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 2. The finalization marker (10.2, docs/decisions/g4-finalization-is-the-lock.md)
  // -----------------------------------------------------------------------
  it('stops the enrollments a finalized suppression covers', async () => {
    expect(await activeEnrollments(beta)).toBe(1);

    const journal = recordingSuppressionJournal();
    const recorded = await recordSuppression(ctx(beta, 'admin'), {
      scope: 'firm',
      firmId: beta.firmId,
      source: 'prospect_opt_out',
      journal,
    });
    expect(recorded.ok).toBe(true);
    // 10.2: a prospect-originated suppression is terminal at once, so the marker is
    // written in the recording transaction. The enrollment is still live until the
    // worker reads it, which is the gap this lane closes.
    expect(await activeEnrollments(beta)).toBe(1);

    const first = await passAndRun();
    expect(first.failed).toBe(0);
    expect(await activeEnrollments(beta)).toBe(0);

    const { rows } = await database.session.query<{ end_reason: string }>(
      'SELECT end_reason FROM sequence_enrollments WHERE workspace_id = $1 AND id = $2',
      [beta.workspaceId, beta.enrollmentId],
    );
    expect(rows[0]?.end_reason).toBe('firm_suppressed');
    expect(await auditCount(beta, 'enrollment.terminally_stopped')).toBe(1);
    // Alpha's marker count is unchanged: nothing crossed the workspace boundary.
    expect(await auditCount(alpha, 'enrollment.terminally_stopped')).toBe(1);

    const second = await passAndRun();
    expect(second.failed).toBe(0);
    expect(await auditCount(beta, 'enrollment.terminally_stopped')).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 3. The send day closes and the ramp advances (12.7)
  // -----------------------------------------------------------------------
  it('advances healthy_sending_days once per healthy closed day, per mailbox', async () => {
    const yesterday = await businessDate(alpha.workspaceId, -1);
    for (const seeded of [alpha, beta]) {
      await database.session.query(
        `INSERT INTO mailbox_send_days (workspace_id, mailbox_id, business_date, automated_sent, cap_granted)
         VALUES ($1, $2, $3::date, 4, 5)`,
        [seeded.workspaceId, seeded.mailboxId, yesterday],
      );
    }

    const first = await passAndRun();
    expect(first.failed).toBe(0);

    const ramps = await database.session.query<{ healthy_sending_days: number; workspace_id: string }>(
      `SELECT workspace_id, healthy_sending_days FROM mailbox_send_ramp
        WHERE mailbox_id = ANY($1::uuid[]) ORDER BY workspace_id`,
      [[alpha.mailboxId, beta.mailboxId]],
    );
    expect(ramps.rows).toHaveLength(2);
    for (const row of ramps.rows) expect(row.healthy_sending_days).toBe(1);

    const days = await database.session.query<{ healthy: boolean | null; closed_at: Date | null }>(
      `SELECT healthy, closed_at FROM mailbox_send_days
        WHERE business_date = $1::date ORDER BY workspace_id`,
      [yesterday],
    );
    for (const row of days.rows) {
      expect(row.healthy).toBe(true);
      expect(row.closed_at).not.toBeNull();
    }

    // Twice is once. A ramp that could be advanced twice by a repeated job would
    // reach fifty a day in half the time 12.7 allows.
    const second = await passAndRun();
    expect(second.failed).toBe(0);
    const again = await database.session.query<{ healthy_sending_days: number }>(
      'SELECT healthy_sending_days FROM mailbox_send_ramp WHERE workspace_id = $1 AND mailbox_id = $2',
      [alpha.workspaceId, alpha.mailboxId],
    );
    expect(again.rows[0]?.healthy_sending_days).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 4. A day the signals condemn does not advance the ramp
  // -----------------------------------------------------------------------
  it('records the failure rather than the day when the signals are bad', async () => {
    // Two days back, so it is strictly before the workspace's current business date
    // whatever hour this suite runs at.
    const earlier = await businessDate(alpha.workspaceId, -2);
    await database.session.query(
      `INSERT INTO mailbox_send_days (workspace_id, mailbox_id, business_date, automated_sent, bounces, cap_granted)
       VALUES ($1, $2, $3::date, 4, 2, 5)`,
      [alpha.workspaceId, alpha.mailboxId, earlier],
    );
    const first = await passAndRun();
    expect(first.failed).toBe(0);
    const { rows } = await database.session.query<{
      healthy: boolean | null;
      last_health_failure: string | null;
    }>(
      `SELECT d.healthy, r.last_health_failure
         FROM mailbox_send_days d
         JOIN mailbox_send_ramp r
           ON r.workspace_id = d.workspace_id AND r.mailbox_id = d.mailbox_id
        WHERE d.workspace_id = $1 AND d.mailbox_id = $2 AND d.business_date = $3::date`,
      [alpha.workspaceId, alpha.mailboxId, earlier],
    );
    expect(rows[0]?.healthy).toBe(false);
    expect(rows[0]?.last_health_failure).toBe('bounce_rate');
    // A bad day does not un-earn the good one; it only stops the count.
    const ramp = await database.session.query<{ healthy_sending_days: number }>(
      'SELECT healthy_sending_days FROM mailbox_send_ramp WHERE workspace_id = $1 AND mailbox_id = $2',
      [alpha.workspaceId, alpha.mailboxId],
    );
    expect(ramp.rows[0]?.healthy_sending_days).toBe(1);
  });
});
