import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from './support/fixtures.ts';

/**
 * Append-only is a privilege, not a convention (specification 5.2 and 10.2).
 *
 * These run as `app_runtime`, not as the database owner: `SET ROLE` drops the
 * superuser's bypass, so a refusal here is the refusal production would give.
 */
describe('append-only privileges', () => {
  let database: TestDatabase;
  let runtime: SessionQueryable;
  let seeded: TwoWorkspaces;

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    runtime = await database.appRuntimeSession();
    await database.session.query(
      "INSERT INTO audit_events (workspace_id, actor_kind, actor_user_id, action, subject_kind, subject_id) VALUES ($1, 'user', $2, 'firm.reassigned', 'firm', 'firm-1')",
      [seeded.alpha.workspaceId, seeded.alpha.admin.userId],
    );
    await database.session.query(
      "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source) VALUES ($1, 'event-1', 'handle', 'someone@example.test', 'v1', 'prospect_opt_out')",
      [seeded.alpha.workspaceId],
    );
  });

  afterAll(async () => {
    await database.drop();
  });

  it('runs as app_runtime, not as the owner', async () => {
    const { rows } = await runtime.query<{ current_user: string }>('SELECT current_user');
    expect(rows[0]?.current_user).toBe('app_runtime');
  });

  it('lets app_runtime read and insert audit events', async () => {
    await runtime.query(
      "INSERT INTO audit_events (workspace_id, actor_kind, action, subject_kind) VALUES ($1, 'system', 'today.built', 'workspace')",
      [seeded.alpha.workspaceId],
    );
    const { rows } = await runtime.query<{ count: string }>(
      'SELECT count(*) AS count FROM audit_events WHERE workspace_id = $1',
      [seeded.alpha.workspaceId],
    );
    expect(Number(rows[0]?.count)).toBe(2);
  });

  it('refuses UPDATE on suppression_events as app_runtime', async () => {
    await expect(
      runtime.query("UPDATE suppression_events SET source = 'import' WHERE event_id = 'event-1'"),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses DELETE on audit_events as app_runtime', async () => {
    await expect(runtime.query('DELETE FROM audit_events')).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses DELETE on suppression_events and UPDATE on audit_events as app_runtime', async () => {
    await expect(runtime.query('DELETE FROM suppression_events')).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.query("UPDATE audit_events SET action = 'tampered'")).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses TRUNCATE on both append-only tables as app_runtime', async () => {
    await expect(runtime.query('TRUNCATE audit_events')).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.query('TRUNCATE suppression_events')).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses the same writes for the migration role', async () => {
    const migration = await database.appRuntimeSession();
    await migration.query('SET ROLE migration');
    await expect(migration.query('DELETE FROM audit_events')).rejects.toMatchObject({ code: '42501' });
    await expect(
      migration.query("UPDATE suppression_events SET scope = 'firm'"),
    ).rejects.toMatchObject({ code: '42501' });
  });

  /**
   * The funnel (migration 0022). Its grant is `SELECT, INSERT` plus `UPDATE
   * (detail)` and nothing else, so "append-only but for the redaction" is a
   * privilege rather than a promise: `app_runtime` can clear a fact's `detail` and
   * cannot touch what the fact says happened.
   */
  it('lets app_runtime clear a funnel fact’s detail and nothing else about it', async () => {
    await database.session.query(
      `INSERT INTO funnel_facts (workspace_id, kind, dedupe_key, source, actor_kind, detail)
       VALUES ($1, 'demo.started', 'privilege-case-1', 'demo', 'system', '{"step": "one"}'::jsonb)`,
      [seeded.alpha.workspaceId],
    );

    await runtime.query("UPDATE funnel_facts SET detail = '{}'::jsonb WHERE dedupe_key = 'privilege-case-1'");
    const { rows } = await runtime.query<{ detail: unknown }>(
      "SELECT detail FROM funnel_facts WHERE dedupe_key = 'privilege-case-1'",
    );
    expect(rows[0]?.detail).toEqual({});

    // What the fact says happened is not the application's to rewrite.
    for (const statement of [
      "UPDATE funnel_facts SET kind = 'demo.completed' WHERE dedupe_key = 'privilege-case-1'",
      "UPDATE funnel_facts SET firm_id = NULL WHERE dedupe_key = 'privilege-case-1'",
      "UPDATE funnel_facts SET dedupe_key = 'rewritten' WHERE dedupe_key = 'privilege-case-1'",
      "UPDATE funnel_facts SET occurred_at = now() WHERE dedupe_key = 'privilege-case-1'",
    ]) {
      await expect(runtime.query(statement), statement).rejects.toMatchObject({ code: '42501' });
    }

    await expect(runtime.query('DELETE FROM funnel_facts')).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.query('TRUNCATE funnel_facts')).rejects.toMatchObject({ code: '42501' });
  });

  it('gives the migration role the same funnel matrix and no more', async () => {
    // The same grant went to both roles, so the same matrix is asserted of both: a
    // migration that could rewrite a fact would be a migration that could rewrite
    // history, and `migration` is the role a release runs as.
    const migration = await database.appRuntimeSession();
    await migration.query('SET ROLE migration');

    await migration.query(
      `INSERT INTO funnel_facts (workspace_id, kind, dedupe_key, source, actor_kind, detail)
       VALUES ($1, 'demo.started', 'privilege-case-2', 'demo', 'system', '{"step": "one"}'::jsonb)`,
      [seeded.alpha.workspaceId],
    );
    await migration.query("UPDATE funnel_facts SET detail = '{}'::jsonb WHERE dedupe_key = 'privilege-case-2'");
    const { rows } = await migration.query<{ detail: unknown }>(
      "SELECT detail FROM funnel_facts WHERE dedupe_key = 'privilege-case-2'",
    );
    expect(rows[0]?.detail).toEqual({});

    for (const statement of [
      "UPDATE funnel_facts SET kind = 'demo.completed' WHERE dedupe_key = 'privilege-case-2'",
      "UPDATE funnel_facts SET firm_id = NULL WHERE dedupe_key = 'privilege-case-2'",
      "UPDATE funnel_facts SET dedupe_key = 'rewritten' WHERE dedupe_key = 'privilege-case-2'",
      "UPDATE funnel_facts SET occurred_at = now() WHERE dedupe_key = 'privilege-case-2'",
    ]) {
      await expect(migration.query(statement), statement).rejects.toMatchObject({ code: '42501' });
    }
    await expect(migration.query('DELETE FROM funnel_facts')).rejects.toMatchObject({ code: '42501' });
    await expect(migration.query('TRUNCATE funnel_facts')).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses writes to the hold reason-code reference table as app_runtime', async () => {
    await expect(
      runtime.query("INSERT INTO hold_reason_codes (code, description, recoverable) VALUES ('invented', 'x', true)"),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('holds the privilege after a failed transaction, not just on the first statement', async () => {
    await runtime.query('BEGIN');
    await expect(runtime.query('DELETE FROM audit_events')).rejects.toMatchObject({ code: '42501' });
    await runtime.query('ROLLBACK');
    await expect(runtime.query('DELETE FROM audit_events')).rejects.toMatchObject({ code: '42501' });
  });
});
