import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
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
