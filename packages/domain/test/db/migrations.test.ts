import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, makeStepExecution, type TestDatabase } from '../../db/testing/index.ts';
import { loadMigrations, readAppliedSchemaVersion } from '../../db/migrationRunner.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from './support/fixtures.ts';
import { seedCrm } from './support/crmFixtures.ts';
import { seedMail } from './support/mailFixtures.ts';
import { seedOutbound } from './support/outboundFixtures.ts';

/** Tables the foundation migration creates, scoped and unscoped alike. */
const FOUNDATION_TABLES = [
  'active_holds',
  'administrative_pauses',
  'audit_events',
  'calling_identities',
  'canary_runs',
  'command_receipts',
  'critical_alerts',
  'daily_counters',
  'devices',
  'heartbeats',
  'hold_reason_codes',
  'jobs',
  'retention_policies',
  'suppression_events',
  'system_generations',
  'users',
  'workspace_memberships',
  'workspaces',
] as const;

/**
 * Migrations run against a real PostgreSQL 16, not a mock: every claim here is a
 * claim about what the database accepted.
 */
describe('forward-only migrations on a fresh database', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database.drop();
  });

  it('is PostgreSQL 16', async () => {
    const { rows } = await database.session.query<{ server_version: string }>('SHOW server_version');
    expect(rows[0]?.server_version.startsWith('16.')).toBe(true);
  });

  it('records every migration file in schema_versions with its checksum', async () => {
    const files = loadMigrations();
    const { rows } = await database.session.query<{ version: number; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM schema_versions ORDER BY version',
    );
    expect(rows).toEqual(files.map(file => ({ version: file.version, name: file.name, checksum: file.checksum })));
    expect(await readAppliedSchemaVersion(database.session)).toBe(files.at(-1)?.version);
  });

  it('creates every foundation table', async () => {
    const { rows } = await database.session.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
    );
    const present = rows.map(row => row.table_name);
    for (const table of FOUNDATION_TABLES) expect(present).toContain(table);
  });

  it('initialises the workspace business zone to America/New_York', async () => {
    const { rows } = await database.session.query<{ business_time_zone: string }>(
      "INSERT INTO workspaces (slug, display_name) VALUES ('callie', 'Callie') RETURNING business_time_zone",
    );
    expect(rows[0]?.business_time_zone).toBe('America/New_York');
  });

  it('seeds one system generation and the closed hold reason-code set', async () => {
    const generations = await database.session.query<{ generation: string; reason: string }>(
      'SELECT generation, reason FROM system_generations ORDER BY generation',
    );
    expect(generations.rows).toEqual([{ generation: '1', reason: 'initial' }]);

    const reasons = await database.session.query<{ count: string }>('SELECT count(*) AS count FROM hold_reason_codes');
    expect(Number(reasons.rows[0]?.count)).toBeGreaterThan(20);
  });

  it('refuses a migration file whose bytes changed after it was applied', async () => {
    const files = loadMigrations();
    const first = files[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const { applyMigrations, MigrationError } = await import('../../db/migrationRunner.ts');
    const tampered = [{ ...first, sql: `${first.sql}\n-- edited after the fact`, checksum: 'f'.repeat(64) }];
    await expect(applyMigrations(database.session, { migrations: tampered })).rejects.toBeInstanceOf(MigrationError);
  });
});

describe('the schema release contract: stop, migrate, start', () => {
  /**
   * A schema release stops both services, applies the migrations and starts the new
   * images (`release-deploy.sh --schema-change`). So the contract is not that the
   * previous images accept the new schema — they refuse it, and must — but that each
   * side refuses the other's schema and accepts its own. Checked against a real
   * database that went from the previous version to this one with rows in it.
   *
   * The previous-version database is built with `throughVersion`, which migrates an
   * empty database part of the way rather than copying the run's template: the path
   * every test of an older schema needs.
   */
  it('migrates a seeded database from the previous version; the previous images refuse the result, the new ones accept it', async () => {
    const files = loadMigrations();
    const previous = files.length - 1;
    const { API_SCHEMA_RANGE, CURRENT_SCHEMA_VERSION, WORKER_SCHEMA_RANGE, checkSchemaRange } = await import(
      '../../db/schemaRange.ts'
    );
    expect(files.at(-1)?.version).toBe(CURRENT_SCHEMA_VERSION);
    // What the previous release's images declare for both services: every range since
    // migration 0006 is a point, and production's images before this release say {18, 18}.
    const PREVIOUS_IMAGES = { minimum: previous, maximum: previous };
    for (const range of [API_SCHEMA_RANGE, WORKER_SCHEMA_RANGE]) {
      expect(range).toEqual({ minimum: CURRENT_SCHEMA_VERSION, maximum: CURRENT_SCHEMA_VERSION });
    }

    const seeded = await createTestDatabase({ throughVersion: previous });
    try {
      expect(await readAppliedSchemaVersion(seeded.session)).toBe(previous);
      await seeded.session.query("INSERT INTO workspaces (slug, display_name) VALUES ('seeded', 'Seeded')");

      // Before the migration: the previous images run, the new ones refuse to start.
      expect(await checkSchemaRange(seeded.session, PREVIOUS_IMAGES)).toMatchObject({ accepted: true });
      for (const range of [API_SCHEMA_RANGE, WORKER_SCHEMA_RANGE]) {
        expect(await checkSchemaRange(seeded.session, range)).toMatchObject({
          accepted: false,
          reason: 'database_behind_binary',
        });
      }

      const { applyMigrations } = await import('../../db/migrationRunner.ts');
      const applied = await applyMigrations(seeded.session);
      expect(applied.map(entry => entry.version)).toEqual([CURRENT_SCHEMA_VERSION]);
      expect(await readAppliedSchemaVersion(seeded.session)).toBe(CURRENT_SCHEMA_VERSION);

      // After it: the previous images refuse to start, the new ones run.
      expect(await checkSchemaRange(seeded.session, PREVIOUS_IMAGES)).toMatchObject({
        accepted: false,
        reason: 'database_ahead_of_binary',
      });
      for (const range of [API_SCHEMA_RANGE, WORKER_SCHEMA_RANGE]) {
        expect(await checkSchemaRange(seeded.session, range)).toMatchObject({ accepted: true });
      }
    } finally {
      await seeded.drop();
    }
  });
});

/** The eight tables migration 0007 created. */
const RESEARCH_TABLES = [
  'research_settings',
  'research_providers',
  'research_provider_ledger',
  'research_route_policies',
  'research_pages',
  'firm_locations',
  'research_firm_runs',
  'research_suggestions',
] as const;

async function tableExists(session: SessionQueryable, table: string): Promise<boolean> {
  const { rows } = await session.query<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [
    `public.${table}`,
  ]);
  return rows[0]?.present === true;
}

async function countOf(session: SessionQueryable, sql: string, values: readonly unknown[] = []): Promise<number> {
  const { rows } = await session.query<{ count: string }>(sql, values);
  return Number(rows[0]?.count ?? '0');
}

interface ProductionShape {
  readonly seeded: TwoWorkspaces;
  readonly reviewEnrollmentId: string;
  readonly snoozeId: string;
  readonly mergeEventId: string;
  readonly mergeSourceFirmId: string;
  readonly mergeTargetFirmId: string;
  readonly deadJobHoldId: string;
}

/**
 * A schema-18 database with rows shaped like production's: two workspaces (whose
 * inserts seeded research's configuration), CRM, a mailbox, a sending domain, a day
 * with direct sends counted, an approved template and a published sequence with live
 * enrollments, one of them in `review_required`, a snooze with W2-S's placeholder
 * reason, a historical merge event, both retired settings rows, and a hold that still
 * names `dead_job`.
 */
async function seedProductionShape(session: SessionQueryable): Promise<ProductionShape> {
  const seeded = await seedTwoWorkspaces(session);
  const crm = await seedCrm(session, seeded);
  const mail = await seedMail(session, seeded, crm);
  const outbound = await seedOutbound(session, seeded, crm, mail);
  const workspaceId = seeded.alpha.workspaceId;
  const adminId = seeded.alpha.admin.userId;
  const one = async (sql: string, values: readonly unknown[]): Promise<string> => {
    const { rows } = await session.query<{ id: string }>(sql, values);
    return rows[0]?.id ?? '';
  };

  const executionId = await makeStepExecution(session, {
    workspaceId,
    firmId: crm.alpha.firmId,
    opportunityId: crm.alpha.opportunityId,
    userId: seeded.alpha.salesperson.userId,
    templateVersionId: outbound.alpha.templateVersionId,
  });
  const reviewEnrollmentId = await one(
    `UPDATE sequence_enrollments SET state = 'review_required', review_union_milliseconds = 691200000
      WHERE workspace_id = $1 AND id = (SELECT enrollment_id FROM step_executions WHERE workspace_id = $1 AND id = $2)
      RETURNING id`,
    [workspaceId, executionId],
  );
  await session.query(
    "UPDATE step_executions SET state = 'held', hold_reason_code = 'long_hold_review' WHERE workspace_id = $1 AND id = $2",
    [workspaceId, executionId],
  );

  const snoozeId = await one(
    `INSERT INTO today_snoozes (workspace_id, firm_id, item_key, reason, return_at, created_by_user_id)
     VALUES ($1, $2, 'step-execution:one', 'snoozed', now() + interval '1 day', $3) RETURNING id`,
    [workspaceId, crm.alpha.firmId, adminId],
  );

  const mergeSourceFirmId = await one(
    "INSERT INTO firms (workspace_id, name, status) VALUES ($1, 'Merged Away Test Holdings', 'active') RETURNING id",
    [workspaceId],
  );
  const mergeEventId = await one(
    `INSERT INTO record_merge_events (workspace_id, record_kind, source_id, target_id, firm_id, performed_by_user_id, command_id, preserved)
     VALUES ($1, 'firm', $2, $3, $3, $4, 'merge-command-1', '{"contacts": 2}'::jsonb) RETURNING id`,
    [workspaceId, mergeSourceFirmId, crm.alpha.firmId, adminId],
  );

  await session.query('UPDATE mailbox_send_days SET direct_sent = 3 WHERE workspace_id = $1 AND id = $2', [
    workspaceId,
    outbound.alpha.sendDayId,
  ]);
  await session.query(
    `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, change_note, changed_by_user_id)
     VALUES ($1, 'alert_thresholds', 1, '{"heartbeatMissedChecks": 3}'::jsonb, 'old', $2),
            ($1, 'client_version_range', 1, '{"minimum": "1.0.0", "maximum": "1.4.0"}'::jsonb, 'old', $2)`,
    [workspaceId, adminId],
  );

  const deadJobHoldId = await one(
    `INSERT INTO active_holds (workspace_id, scope_kind, reason_code, blocked_action_kinds, source_event_kind)
     VALUES ($1, 'workspace', 'dead_job', ARRAY['email_send', 'research'], 'job.dead') RETURNING id`,
    [seeded.beta.workspaceId],
  );

  return { seeded, reviewEnrollmentId, snoozeId, mergeEventId, mergeSourceFirmId, mergeTargetFirmId: crm.alpha.firmId, deadJobHoldId };
}

describe('migration 0019 on a production-shaped schema-18 database', () => {
  let database: TestDatabase;
  let shape: ProductionShape;
  let researchRowsBefore: number;

  beforeAll(async () => {
    database = await createTestDatabase({ throughVersion: 18 });
    shape = await seedProductionShape(database.session);
    researchRowsBefore = 0;
    for (const table of RESEARCH_TABLES) researchRowsBefore += await countOf(database.session, `SELECT count(*) AS count FROM ${table}`);
    const { applyMigrations } = await import('../../db/migrationRunner.ts');
    await applyMigrations(database.session);
  });

  afterAll(async () => {
    await database.drop();
  });

  it('reaches schema 19', async () => {
    expect(await readAppliedSchemaVersion(database.session)).toBe(19);
  });

  it('drops research: its eight tables, the seed functions and the workspace trigger, which had seeded rows', async () => {
    // The vacuous-pass trap: the workspace trigger really had seeded configuration.
    expect(researchRowsBefore).toBeGreaterThan(0);
    for (const table of RESEARCH_TABLES) expect(await tableExists(database.session, table), table).toBe(false);
    const functions = await countOf(
      database.session,
      "SELECT count(*) AS count FROM pg_proc WHERE proname IN ('seed_research_configuration', 'seed_research_for_new_workspace')",
    );
    expect(functions).toBe(0);
    // A new workspace no longer reaches the dropped function.
    await database.session.query("INSERT INTO workspaces (slug, display_name) VALUES ('after-0019', 'After')");
  });

  it('keeps every merge event as an audit event before dropping the table', async () => {
    expect(await tableExists(database.session, 'record_merge_events')).toBe(false);
    const { rows } = await database.session.query<{
      actor_kind: string;
      actor_user_id: string;
      subject_kind: string;
      subject_id: string;
      detail: Record<string, unknown>;
    }>(
      "SELECT actor_kind, actor_user_id, subject_kind, subject_id, detail FROM audit_events WHERE action = 'record_merge.archived'",
    );
    expect(rows).toEqual([
      {
        actor_kind: 'user',
        actor_user_id: shape.seeded.alpha.admin.userId,
        subject_kind: 'firm',
        subject_id: shape.mergeTargetFirmId,
        detail: {
          recordMergeEventId: shape.mergeEventId,
          recordKind: 'firm',
          sourceId: shape.mergeSourceFirmId,
          targetId: shape.mergeTargetFirmId,
          firmId: shape.mergeTargetFirmId,
          commandId: 'merge-command-1',
          preserved: { contacts: 2 },
          archivedBy: 'migration 0019',
        },
      },
    ]);
  });

  it('drops direct_sent, the guard columns and the audited migration, and keeps the send day', async () => {
    const columns = await database.session.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name IN ('direct_sent', 'personal_gmail_guard_per_24h', 'reply_only_opt_out', 'migration_paused_at')`,
    );
    expect(columns.rows).toEqual([]);
    expect(await tableExists(database.session, 'enrollment_migrations')).toBe(false);
    expect(await tableExists(database.session, 'enrollment_migration_items')).toBe(false);
    expect(await countOf(database.session, 'SELECT count(*) AS count FROM mailbox_send_days')).toBeGreaterThan(0);
  });

  it('keeps the review_required enrollment for the scheduler to resume, and the placeholder snooze', async () => {
    const enrollment = await database.session.query<{ state: string; review_union_milliseconds: string }>(
      'SELECT state, review_union_milliseconds FROM sequence_enrollments WHERE id = $1',
      [shape.reviewEnrollmentId],
    );
    expect(enrollment.rows[0]).toEqual({ state: 'review_required', review_union_milliseconds: '691200000' });
    const snooze = await database.session.query<{ reason: string }>('SELECT reason FROM today_snoozes WHERE id = $1', [
      shape.snoozeId,
    ]);
    expect(snooze.rows[0]?.reason).toBe('snoozed');
  });

  it('deletes the retired settings rows and admits postal_address', async () => {
    expect(
      await countOf(
        database.session,
        "SELECT count(*) AS count FROM workspace_settings WHERE setting_key IN ('alert_thresholds', 'client_version_range')",
      ),
    ).toBe(0);
    await database.session.query(
      `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, change_note, changed_by_user_id)
       VALUES ($1, 'postal_address', 1, '{"address": "1 Example Way, Providence, RI 02903"}'::jsonb, 'set', $2)`,
      [shape.seeded.alpha.workspaceId, shape.seeded.alpha.admin.userId],
    );
    await expect(
      database.session.query(
        `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, change_note, changed_by_user_id)
         VALUES ($1, 'client_version_range', 1, '{}'::jsonb, 'again', $2)`,
        [shape.seeded.alpha.workspaceId, shape.seeded.alpha.admin.userId],
      ),
    ).rejects.toMatchObject({ constraint: 'workspace_settings_key_known' });
  });

  it('deletes domain_cap, which nothing references, and keeps dead_job, which a hold still names', async () => {
    const { rows } = await database.session.query<{ code: string }>(
      "SELECT code FROM hold_reason_codes WHERE code IN ('domain_cap', 'dead_job') ORDER BY code",
    );
    expect(rows.map(row => row.code)).toEqual(['dead_job']);
    expect(await countOf(database.session, 'SELECT count(*) AS count FROM active_holds WHERE id = $1', [shape.deadJobHoldId])).toBe(1);
  });

  it('lets an approved template and a published step be edited in place', async () => {
    const workspaceId = shape.seeded.alpha.workspaceId;
    const template = await database.session.query(
      `UPDATE template_versions SET body = 'Edited in place, with no stop line.' WHERE workspace_id = $1 AND approved_at IS NOT NULL`,
      [workspaceId],
    );
    expect(template.rowCount).toBeGreaterThan(0);
    const step = await database.session.query(
      `UPDATE sequence_steps s SET delay_amount = delay_amount + 1
         FROM sequence_versions v
        WHERE v.workspace_id = s.workspace_id AND v.id = s.sequence_version_id
          AND s.workspace_id = $1 AND v.state = 'published'`,
      [workspaceId],
    );
    expect(step.rowCount).toBeGreaterThan(0);
  });

  it('relaxes the snooze reason, phone evidence, attestation and posture review CHECKs', async () => {
    const workspaceId = shape.seeded.alpha.workspaceId;
    const adminId = shape.seeded.alpha.admin.userId;
    await database.session.query(
      `INSERT INTO today_snoozes (workspace_id, firm_id, item_key, reason, return_at, created_by_user_id)
       VALUES ($1, $2, 'step-execution:two', NULL, now() + interval '1 day', $3)`,
      [workspaceId, shape.mergeTargetFirmId, adminId],
    );
    await database.session.query(
      `INSERT INTO calling_identities (workspace_id, owner_user_id, e164, verification_status, enabled)
       VALUES ($1, $2, '+14015550199', 'verified', true)`,
      [workspaceId, adminId],
    );
    await database.session.query(
      `INSERT INTO phone_routes (workspace_id, firm_id, e164, source, retrieved_at, eligibility)
       VALUES ($1, $2, '+14015550198', 'import', now(), 'usable')`,
      [workspaceId, shape.mergeTargetFirmId],
    );
    const posture = await database.session.query<{ column_name: string; is_nullable: string }>(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'state_postures' AND column_name = 'review_at'",
    );
    expect(posture.rows).toEqual([{ column_name: 'review_at', is_nullable: 'YES' }]);
  });
});

describe('migration 0019 refuses (FS019) while a value it drops is stored', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase({ throughVersion: 18 });
    const seeded = await seedTwoWorkspaces(database.session);
    const sequence = await database.session.query<{ id: string }>(
      "INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, 'LinkedIn first', $2) RETURNING id",
      [seeded.alpha.workspaceId, seeded.alpha.admin.userId],
    );
    const version = await database.session.query<{ id: string }>(
      'INSERT INTO sequence_versions (workspace_id, sequence_id, version) VALUES ($1, $2, 1) RETURNING id',
      [seeded.alpha.workspaceId, sequence.rows[0]?.id],
    );
    await database.session.query(
      `INSERT INTO sequence_steps (workspace_id, sequence_version_id, ordinal, channel, delay_unit, delay_amount)
       VALUES ($1, $2, 1, 'linkedin_task', 'elapsed', 0)`,
      [seeded.alpha.workspaceId, version.rows[0]?.id],
    );
  });

  afterAll(async () => {
    await database.drop();
  });

  it('names the counts, changes nothing and leaves schema 18', async () => {
    const { applyMigrations } = await import('../../db/migrationRunner.ts');
    await expect(applyMigrations(database.session)).rejects.toMatchObject({
      code: 'FS019',
      message: expect.stringContaining('0019 refused: linkedin_steps=1 linkedin_executions=0') as unknown as string,
    });
    expect(await readAppliedSchemaVersion(database.session)).toBe(18);
    expect(await tableExists(database.session, 'research_settings')).toBe(true);
    expect(await tableExists(database.session, 'record_merge_events')).toBe(true);
  });
});
