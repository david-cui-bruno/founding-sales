import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { CURRENT_SCHEMA_VERSION } from '@fss/domain/db/schemaRange.ts';
import {
  CLUSTER_URL_ENVIRONMENT_VARIABLE,
  asSession,
  createTestDatabase,
  type TestDatabase,
} from '@fss/domain/db/testing/testDatabase.ts';
import { main } from '../src/tools/fss.ts';
import { SEND_PATH_DEVIATIONS, sendPathReportCommand } from '../src/tools/fss/admin.ts';
import { COMMAND_DEPENDENCIES, parseFssCommand } from '../src/tools/fss/commands.ts';
import { readToolConfig } from '../src/tools/fss/config.ts';

/**
 * `fss admin send-path report` on a real schema-25 database (lane RB).
 *
 * The command is the nine read-before-lift reads of
 * `docs/greenfield/send-path-verification-20260929.md`, run on the operations task
 * because production's database has no other reachable execution. It decides nothing,
 * so what is worth testing is that each section *counts the right rows* and that the
 * whole thing cannot write.
 *
 * ## The vacuous-pass traps, named
 *
 * **Counts over an empty database.** The fixture seeds one live enrollment of each of
 * the three origin kinds with a due step, an ended enrollment, a second live contact at
 * one firm, a firm suppression and a prepared fence, so every number asserted below is
 * non-zero because something is there — and `wouldLeaveOnFirstTick` is 1 rather than 0,
 * which is the number that would have made "excluded" untestable. (It was 2 until
 * send-path v2, slice S4: the due prospecting e-mail is now `heldForColdOutreach`.)
 *
 * **A read-only proof that proves nothing.** Asserting the mutation counters did not
 * move would pass against a counter that never moves. So the same test writes one row
 * through the same session afterwards and asserts the counters *do* move: the
 * measurement is shown to work in the same run in which it is trusted.
 *
 * Fictional throughout: `example.test` addresses and no real firm or person.
 */

let database: TestDatabase;
let url = '';
let workspaceId = '';
let userId = '';
let alphaFirmId = '';
let bravoFirmId = '';
let prospectingEnrollmentId = '';

const ZONE = 'America/New_York';

async function one(sql: string, values: readonly unknown[] = []): Promise<string> {
  const { rows } = await database.session.query<{ id: string }>(sql, values);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`the fixture returned no row: ${sql.slice(0, 60)}`);
  return id;
}

/** The tool as an operator runs it: its own connection, its own configuration, stdout parsed. */
async function run(argv: readonly string[]): Promise<{ readonly code: number; readonly stdout: string }> {
  const printed: string[] = [];
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    printed.push(String(chunk));
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const code = await main(argv, { DATABASE_URL: url });
    return { code, stdout: printed.join('') };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

interface ReportShape {
  readonly ok: boolean;
  readonly report: {
    readonly schemaVersion: number;
    readonly readAt: string;
    readonly workspaceId: string;
    readonly sample: number;
    readonly deviations: readonly string[];
    readonly sections: Record<string, Record<string, unknown>>;
  };
}

/** One section of the report, by name; a missing one is the test's failure, not a null. */
function section(answer: ReportShape['report'], name: string): Record<string, unknown> {
  const found = answer.sections[name];
  if (found === undefined) throw new Error(`the report has no section ${name}`);
  return found;
}

async function report(argv: readonly string[] = []): Promise<ReportShape> {
  const { code, stdout } = await run(['admin', 'send-path', 'report', ...argv]);
  expect(code, stdout).toBe(0);
  return JSON.parse(stdout) as ReportShape;
}

/** A firm, a contact of it, an e-mail route and an open opportunity. */
async function prospect(
  firmName: string,
  contactName: string,
  handle: string,
): Promise<{ readonly firmId: string; readonly contactId: string; readonly opportunityId: string }> {
  const firmId = await one(
    `INSERT INTO firms (workspace_id, name, assigned_user_id, region_code, postal_code,
                        time_zone, time_zone_confidence, time_zone_source, time_zone_rule_version)
     VALUES ($1, $2, $3, 'RI', '02903', $4, 'high', 'postal', 'firm-zone.1') RETURNING id`,
    [workspaceId, firmName, userId, ZONE],
  );
  return await contactOf(firmId, contactName, handle);
}

async function contactOf(
  firmId: string,
  contactName: string,
  handle: string,
): Promise<{ readonly firmId: string; readonly contactId: string; readonly opportunityId: string }> {
  const contactId = await one('INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, $3) RETURNING id', [
    workspaceId,
    firmId,
    contactName,
  ]);
  await database.session.query(
    `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at,
                                  association_confidence, technical_validation, eligibility,
                                  eligibility_policy_version)
     VALUES ($1, $2, $3, $4, 'salesperson', now(), 0.950, 'passed', 'usable', 'route-policy.1')`,
    [workspaceId, firmId, contactId, `${handle}@example.test`],
  );
  // `opportunities_one_open_per_firm`: a second contact at the same firm joins the
  // firm's open opportunity rather than opening a second one, which is exactly the
  // shape section 5 is about — two people, one firm, one pipeline row.
  const existing = await database.session.query<{ id: string }>(
    "SELECT id FROM opportunities WHERE workspace_id = $1 AND firm_id = $2 AND status = 'open' LIMIT 1",
    [workspaceId, firmId],
  );
  const stageId = await one('SELECT id FROM pipeline_stages WHERE workspace_id = $1 ORDER BY position LIMIT 1', [
    workspaceId,
  ]);
  const opportunityId =
    existing.rows[0]?.id ??
    (await one(
      `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
       VALUES ($1, $2, $3, now()) RETURNING id`,
      [workspaceId, firmId, stageId],
    ));
  return { firmId, contactId, opportunityId };
}

/** A live enrollment of the named origin, with one `pending` e-mail step an hour overdue. */
async function enroll(
  where: { readonly firmId: string; readonly contactId: string; readonly opportunityId: string },
  originKind: 'cold_legacy' | 'prospecting' | 'follow_up',
  permissionId: string | null,
  sequenceVersionId: string,
  stepId: string,
): Promise<{ readonly enrollmentId: string; readonly stepExecutionId: string }> {
  const enrollmentId = await one(
    `INSERT INTO sequence_enrollments
       (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
        firm_time_zone, holiday_calendar_version, origin_kind, permission_id, started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'holidays.1', $8, $9, now() - interval '2 days') RETURNING id`,
    [
      workspaceId,
      sequenceVersionId,
      where.opportunityId,
      where.firmId,
      where.contactId,
      userId,
      ZONE,
      originKind,
      permissionId,
    ],
  );
  const stepExecutionId = await one(
    `INSERT INTO step_executions
       (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal, state,
        due_at, not_before, original_due_at, source_zone, rule_version)
     VALUES ($1, $2, $3, $4, $5, 'email', 1, 'pending',
             now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour', $6, 'email-window.1')
     RETURNING id`,
    [workspaceId, enrollmentId, stepId, where.firmId, where.contactId, ZONE],
  );
  return { enrollmentId, stepExecutionId };
}

beforeAll(async () => {
  database = await createTestDatabase();
  const named = await database.session.query<{ name: string }>('SELECT current_database() AS name');
  const clusterUrl = new URL(process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '');
  clusterUrl.pathname = `/${named.rows[0]?.name ?? ''}`;
  url = clusterUrl.toString();

  workspaceId = await one(
    "INSERT INTO workspaces (slug, display_name, business_time_zone) VALUES ('sendpath', 'Send Path', 'America/New_York') RETURNING id",
  );
  userId = await one(
    "INSERT INTO users (google_sub, email, display_name) VALUES ('sendpath-sub', 'owner@example.test', 'Owner') RETURNING id",
  );
  await database.session.query("INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')", [
    workspaceId,
    userId,
  ]);

  // Section 1: the pause, as production holds it today, and a domain that is not ready.
  await database.session.query(
    `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, change_note, changed_by_user_id)
     VALUES ($1, 'sending_enabled', 1, '{"enabled": false}'::jsonb, 'paused', $2),
            ($1, 'business_time_zone', 1, '{"timeZone": "America/New_York"}'::jsonb, 'set', $2)`,
    [workspaceId, userId],
  );
  await database.session.query(
    `INSERT INTO sending_domains (workspace_id, domain, is_primary, spf_pass, dkim_pass, dmarc_pass,
                                  authentication_checked_at, authentication_checked_by_user_id)
     VALUES ($1, 'usecallie.example', true, true, true, false, now(), $2)`,
    [workspaceId, userId],
  );

  // Section 7: one mailbox, its ramp near zero, and one closed day.
  const mailboxId = await one(
    `INSERT INTO mailboxes (workspace_id, owner_user_id, email_address, status)
     VALUES ($1, $2, 'owner@example.test', 'connected') RETURNING id`,
    [workspaceId, userId],
  );
  await database.session.query(
    `INSERT INTO mailbox_send_ramp (workspace_id, mailbox_id, healthy_sending_days, admin_daily_cap,
                                    admin_changed_at, admin_changed_by_user_id)
     VALUES ($1, $2, 1, 5, now(), $3)`,
    [workspaceId, mailboxId, userId],
  );
  await database.session.query(
    `INSERT INTO mailbox_send_days (workspace_id, mailbox_id, business_date, automated_sent, cap_granted, healthy, closed_at)
     VALUES ($1, $2, current_date - 1, 2, 5, true, now())`,
    [workspaceId, mailboxId],
  );

  const templateVersionId = await one(
    `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body, content_hash,
                                    footer_sign_off, approved_at, approved_by_user_id)
     VALUES ($1, gen_random_uuid(), 1, 'First touch', 'A short note', 'Hello.', repeat('b', 64), 'Owner', now(), $2)
     RETURNING id`,
    [workspaceId, userId],
  );
  const sequenceId = await one(
    "INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, 'Outreach', $2) RETURNING id",
    [workspaceId, userId],
  );
  const sequenceVersionId = await one(
    'INSERT INTO sequence_versions (workspace_id, sequence_id, version) VALUES ($1, $2, 1) RETURNING id',
    [workspaceId, sequenceId],
  );
  const stepId = await one(
    `INSERT INTO sequence_steps (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, template_version_id)
     VALUES ($1, $2, 1, 'email', 'elapsed', 0, $3) RETURNING id`,
    [workspaceId, sequenceVersionId, templateVersionId],
  );
  const secondStepId = await one(
    `INSERT INTO sequence_steps (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount, template_version_id)
     VALUES ($1, $2, 2, 'email', 'business_days', 3, $3) RETURNING id`,
    [workspaceId, sequenceVersionId, templateVersionId],
  );
  await database.session.query(
    `UPDATE sequence_versions SET state = 'published', published_at = now(), published_by_user_id = $3
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, sequenceVersionId, userId],
  );

  // Alpha: a cold_legacy enrollment and, at the same firm, a prospecting one. Two live
  // contacts at one firm is section 5's "any origin" row, and exactly one of them is
  // prospecting, so section 5's prospecting-only list must stay empty.
  const alphaOne = await prospect('Alpha Holdings', 'Dana Example', 'dana');
  alphaFirmId = alphaOne.firmId;
  await enroll(alphaOne, 'cold_legacy', null, sequenceVersionId, stepId);
  const alphaTwo = await contactOf(alphaFirmId, 'Robin Example', 'robin');
  const prospecting = await enroll(alphaTwo, 'prospecting', null, sequenceVersionId, stepId);
  prospectingEnrollmentId = prospecting.enrollmentId;

  // Section 8: one fence already prepared on the prospecting run.
  await database.session.query(
    `INSERT INTO outbound_messages
       (workspace_id, mailbox_id, origin_kind, enrollment_id, step_execution_id, firm_id, contact_id,
        opportunity_id, recipient_address, subject, body, template_version_id, rendered_hash,
        provider_message_id_header, send_at, source_zone, placement_rule_version, state)
     VALUES ($1, $2, 'step_execution', $3, $4, $5, $6, $7, 'robin@example.test', 'A short note', 'Hello.',
             $8, repeat('c', 64), '<fss.' || gen_random_uuid() || '@example.test>', now(), $9, 'email-window.1', 'prepared')`,
    [
      workspaceId,
      mailboxId,
      prospecting.enrollmentId,
      prospecting.stepExecutionId,
      alphaTwo.firmId,
      alphaTwo.contactId,
      alphaTwo.opportunityId,
      templateVersionId,
      ZONE,
    ],
  );

  // Bravo: an evidenced follow-up — a call that agreed to one e-mail, the permission it
  // granted, and the one enrollment that permission paid for. The firm is also
  // suppressed, which is section 6's second number.
  const bravo = await prospect('Bravo Partners', 'Sam Example', 'sam');
  bravoFirmId = bravo.firmId;
  const callLogId = await one(
    `INSERT INTO call_logs (workspace_id, firm_id, contact_id, opportunity_id, outcome, step_effect,
                            occurred_at, actor_user_id, agreed_follow_up, agreed_template_version_id)
     VALUES ($1, $2, $3, $4, 'interested', 'none', now() - interval '3 days', $5, 'single_email', $6) RETURNING id`,
    [workspaceId, bravo.firmId, bravo.contactId, bravo.opportunityId, userId, templateVersionId],
  );
  const permissionId = await one(
    `INSERT INTO follow_up_permissions
       (workspace_id, firm_id, contact_id, kind, scope, call_log_id, template_version_id, max_steps,
        expires_at, granted_by_user_id)
     VALUES ($1, $2, $3, 'conversation', 'single_email', $4, $5, 1, now() + interval '30 days', $6) RETURNING id`,
    [workspaceId, bravo.firmId, bravo.contactId, callLogId, templateVersionId, userId],
  );
  const followUp = await enroll(bravo, 'follow_up', permissionId, sequenceVersionId, stepId);
  await database.session.query(
    'UPDATE follow_up_permissions SET enrollment_id = $3 WHERE workspace_id = $1 AND id = $2',
    [workspaceId, permissionId, followUp.enrollmentId],
  );
  await database.session.query(
    `INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source, actor_user_id)
     VALUES ($1, 'sendpath-suppression-1', 'firm', $2::text, 'canonical.1', 'salesperson_manual', $3)`,
    [workspaceId, bravo.firmId, userId],
  );

  // Charlie: an enrollment that ended. Section 3 and section 4 must not see it, and its
  // contact is free for a later live one — which is why the partial unique index on
  // (workspace_id, contact_id) does not refuse this fixture.
  const charlie = await prospect('Charlie Group', 'Alex Example', 'alex');
  const ended = await enroll(charlie, 'prospecting', null, sequenceVersionId, secondStepId);
  await database.session.query(
    `UPDATE sequence_enrollments SET state = 'stopped', ended_at = now(), end_reason = 'admin_stop'
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, ended.enrollmentId],
  );
}, 120_000);

afterAll(async () => {
  await database.drop();
});

describe('fss admin send-path report', () => {
  it('is a parseable database-only command', () => {
    expect(parseFssCommand(['admin', 'send-path', 'report', '--workspace', 'x', '--sample', '10'])).toMatchObject({
      ok: true,
    });
    expect(parseFssCommand(['admin', 'send-path', 'report', '--everything'])).toMatchObject({
      ok: false,
      reason: 'flag_unknown',
    });
    expect(COMMAND_DEPENDENCIES['send-path report']).toBe('database');
  });

  it('reads the nine sections of the send-path verification at the current schema', async () => {
    const { ok, report: answer } = await report();
    expect(ok).toBe(true);
    expect(answer.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(answer.workspaceId).toBe(workspaceId);
    expect(answer.sample).toBe(50);
    expect(Date.parse(answer.readAt)).toBeGreaterThan(0);
    expect(answer.deviations).toEqual([...SEND_PATH_DEVIATIONS]);
    expect(Object.keys(answer.sections)).toEqual([
      'switches',
      'dueNow',
      'liveEnrollments',
      'liveEnrollmentRows',
      'firmsWithParallelThreads',
      'suppression',
      'mailboxRamp',
      'preparedFences',
      'followUpPermissions',
    ]);

    // 1. The pause, as stored, and the domain that is not authenticated.
    expect(section(answer, 'switches')).toMatchObject({
      settings: [
        { settingKey: 'business_time_zone', value: { timeZone: 'America/New_York' } },
        { settingKey: 'sending_enabled', value: { enabled: false } },
      ],
      domains: [{ domain: 'usecallie.example', automatedSendingEnabled: false, dmarcPass: false, spfPass: true }],
    });

    // 2. Three due steps, one per origin kind. Only the follow-up would actually leave:
    // cold_legacy is never woken, and the prospecting e-mail is held for a cold-outreach
    // mailbox (send-path v2, slice S4), so wouldLeaveOnFirstTick = 3 - 1 - 1.
    expect(section(answer, 'dueNow')).toMatchObject({
      total: 3,
      email: 3,
      byOriginKind: { cold_legacy: 1, prospecting: 1, follow_up: 1 },
      heldForColdOutreach: 1,
      wouldLeaveOnFirstTick: 1,
    });
    expect(String(section(answer, 'dueNow')['note'])).toContain('cold_legacy');
    expect(String(section(answer, 'dueNow')['note'])).toContain('heldForColdOutreach');

    // 3. The live enrollments, grouped by sequence, version, started day and origin.
    const grouped = section(answer, 'liveEnrollments') as unknown as readonly Record<string, unknown>[];
    expect(grouped.map(row => [row['sequenceName'], row['version'], row['originKind'], row['enrollments']])).toEqual(
      expect.arrayContaining([
        ['Outreach', 1, 'cold_legacy', 1],
        ['Outreach', 1, 'prospecting', 1],
        ['Outreach', 1, 'follow_up', 1],
      ]),
    );
    // Charlie's enrollment ended, so nothing here counts it.
    expect(grouped.reduce((total, row) => total + Number(row['enrollments']), 0)).toBe(3);

    // 4. Per-enrollment, with 0025's columns beside the document's two proxies, and no
    // e-mail address or person's name anywhere in the section.
    const rows = section(answer, 'liveEnrollmentRows');
    expect(rows).toMatchObject({ total: 3, sample: 50, truncated: false });
    const perRow = rows['rows'] as readonly Record<string, unknown>[];
    expect(perRow).toHaveLength(3);
    expect(perRow.map(row => row['originKind'])).toEqual(['cold_legacy', 'prospecting', 'follow_up']);
    const followUpRow = perRow.find(row => row['originKind'] === 'follow_up');
    expect(followUpRow).toMatchObject({
      permissionLive: true,
      controlMode: 'automated',
      controlModeOrigin: null,
      hadConversation: true,
      hadInbound: false,
    });
    expect(perRow.find(row => row['originKind'] === 'cold_legacy')).toMatchObject({
      permissionId: null,
      permissionLive: null,
      hadConversation: false,
    });
    expect(JSON.stringify(rows)).not.toContain('@');

    // 5. Two people at Alpha, and the prospecting-only list the new firm-exclusivity
    // rule must keep empty.
    expect(section(answer, 'firmsWithParallelThreads')).toEqual({
      anyOrigin: [{ firmId: alphaFirmId, firmName: 'Alpha Holdings', liveContacts: 2 }],
      prospectingOnly: [],
    });

    // 6. The suppression on Bravo, and the one live enrollment it covers.
    expect(section(answer, 'suppression')).toEqual({
      byScope: [{ scope: 'firm', count: 1 }],
      liveEnrollmentsOfSuppressedPeople: 1,
    });

    // 7. The ramp and the last closed day.
    expect(section(answer, 'mailboxRamp')).toMatchObject({
      ramp: [{ address: 'owner@example.test', healthySendingDays: 1, adminDailyCap: 5, raisedDailyCap: null }],
      recentDays: [{ automatedSent: 2, capGranted: 5, healthy: true }],
    });

    // 8. The one prepared fence, and which origin's run it belongs to.
    expect(section(answer, 'preparedFences')).toMatchObject({
      byState: [{ state: 'prepared', count: 1 }],
      byEnrollmentOriginKind: [{ state: 'prepared', enrollmentOriginKind: 'prospecting', count: 1 }],
    });

    // 9. The permission itself, and the defect count that must be zero.
    expect(section(answer, 'followUpPermissions')).toMatchObject({
      byScope: [{ scope: 'single_email', state: 'live', count: 1 }],
      byKind: [{ kind: 'conversation', state: 'live', count: 1 }],
      liveFollowUpsWithoutLivePermission: 0,
    });
  });

  it('caps the per-row section at --sample and says it was capped', async () => {
    const { report: answer } = await report(['--sample', '1']);
    expect(answer.sample).toBe(1);
    expect(section(answer, 'liveEnrollmentRows')).toMatchObject({ total: 3, sample: 1, truncated: true });
    expect(section(answer, 'liveEnrollmentRows')['rows']).toHaveLength(1);
    // The counting sections are not sampled: a cap on the rows is not a cap on the
    // number that decides whether the pause may be lifted.
    expect(section(answer, 'dueNow')).toMatchObject({ total: 3, heldForColdOutreach: 1, wouldLeaveOnFirstTick: 1 });
  });

  it('refuses a --sample outside the bounds rather than silently clamping it', async () => {
    for (const value of ['0', '501', 'fifty']) {
      const { code } = await run(['admin', 'send-path', 'report', '--sample', value]);
      expect(code, `--sample ${value}`).toBe(20);
    }
  });

  it('refuses a workspace id this database does not have', async () => {
    const { code } = await run(['admin', 'send-path', 'report', '--workspace', '00000000-0000-4000-8000-000000000000']);
    expect(code).toBe(20);
  });

  /**
   * The proof that the transaction is read-only, and that the measurement works.
   *
   * `pg_stat_user_tables` counts every tuple inserted, updated or deleted, whether or
   * not the transaction that did it committed, so a write inside the report's own
   * rolled-back transaction would still show. The counters are per-backend until the
   * backend flushes them, so the report is run on a session this test owns and
   * `pg_stat_force_next_flush()` — **PostgreSQL 15 or later**, and the test cluster is
   * 16 (`embedded-postgres` 16.x and CI's `postgres:16` service) — is called on that
   * same session afterwards. The control write at the end is what stops the assertion
   * being a statement about a counter that never moves.
   */
  it('writes nothing: the mutation counters do not move across the call, and do move for a write', async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const reportSession: SessionQueryable = asSession(client as never);
    const counters = async (): Promise<number> => {
      await reportSession.query('SELECT pg_stat_force_next_flush()');
      const { rows } = await reportSession.query<{ total: string }>(
        'SELECT coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::text AS total FROM pg_stat_user_tables',
      );
      return Number(rows[0]?.total ?? '0');
    };
    try {
      const before = await counters();
      const outcome = await sendPathReportCommand({
        session: reportSession,
        config: readToolConfig({ DATABASE_URL: url }),
        environment: {},
        options: {},
        switches: new Set<string>(),
      });
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      const after = await counters();
      expect(after, 'the report is a READ ONLY transaction: no tuple was inserted, updated or deleted').toBe(before);

      // The same measurement, shown to move. Rolled back, because the counters count
      // the attempt and the fixture other tests read must not change.
      await reportSession.query('BEGIN');
      await reportSession.query(
        `INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source, actor_user_id)
         VALUES ($1, 'sendpath-counter-control', 'firm', $2::text, 'canonical.1', 'salesperson_manual', $3)`,
        [workspaceId, bravoFirmId, userId],
      );
      await reportSession.query('ROLLBACK');
      expect(await counters(), 'the counters move for a write, so the equality above is a fact about the report').toBeGreaterThan(
        before,
      );
    } finally {
      await client.end().catch(() => undefined);
    }
  });

  it('keeps the enrollment that ended out of every live section', async () => {
    const { report: answer } = await report();
    const rows = (section(answer, 'liveEnrollmentRows')['rows'] as readonly Record<string, unknown>[]).map(
      row => row['enrollmentId'],
    );
    expect(rows).toContain(prospectingEnrollmentId);
    expect(rows).toHaveLength(3);
  });
  it('refuses workspace_ambiguous, naming the count, when the database holds more than one workspace', async () => {
    const otherId = await one(
      "INSERT INTO workspaces (slug, display_name, business_time_zone) VALUES ('sendpath-2', 'Second', 'America/New_York') RETURNING id",
    );
    try {
      const { code } = await run(['admin', 'send-path', 'report']);
      expect(code).toBe(20);
      // Named explicitly, the same database answers for the workspace asked about.
      const { report: answer } = await report(['--workspace', workspaceId]);
      expect(section(answer, 'dueNow')).toMatchObject({ total: 3 });
      const { report: empty } = await report(['--workspace', otherId]);
      expect(section(empty, 'dueNow')).toMatchObject({ total: 0, heldForColdOutreach: 0, wouldLeaveOnFirstTick: 0 });
      expect(section(empty, 'liveEnrollmentRows')).toMatchObject({ total: 0, truncated: false });
    } finally {
      // The second workspace is left in place: this case is last, and deleting a
      // workspace means deleting the rows the schema seeds with it (retention policies,
      // pipeline stages), which is retention's job and not a fixture's.
      expect(otherId.length).toBeGreaterThan(0);
    }
  });

});
