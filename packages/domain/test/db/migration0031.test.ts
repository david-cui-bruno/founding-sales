import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { readAppliedSchemaVersion } from '../../db/migrationRunner.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from './support/fixtures.ts';

/**
 * Migration 0031 on a database at schema 30 (slice P1): every stored setting survives the
 * widened key CHECK, and the new key `monthly_cash_ceiling_cents` is admitted (it was
 * refused at 30).
 */
describe('migration 0031 on a database at schema 30', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let settingsBefore: unknown[] = [];

  const insertCeiling = async (): Promise<void> => {
    await database.session.query(
      `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, changed_by_user_id)
       VALUES ($1, 'monthly_cash_ceiling_cents', 1, '{"cents": 2500}'::jsonb, $2)`,
      [seeded.alpha.workspaceId, seeded.alpha.admin.userId],
    );
  };

  beforeAll(async () => {
    database = await createTestDatabase({ throughVersion: 30 });
    expect(await readAppliedSchemaVersion(database.session)).toBe(30);
    seeded = await seedTwoWorkspaces(database.session);
    await database.session.query(
      `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, changed_by_user_id)
       VALUES ($1, 'call_transcription', 1, '{"enabled": true, "dailyCeilingCents": 50, "unitPriceMicros": 4300}'::jsonb, $2)`,
      [seeded.alpha.workspaceId, seeded.alpha.admin.userId],
    );
    await expect(insertCeiling()).rejects.toMatchObject({ constraint: 'workspace_settings_key_known' });
    settingsBefore = (await database.session.query('SELECT * FROM workspace_settings ORDER BY workspace_id, setting_key, version')).rows;
    const { applyMigrations } = await import('../../db/migrationRunner.ts');
    await applyMigrations(database.session, { throughVersion: 31 });
  });

  afterAll(async () => {
    await database.drop();
  });

  it('is at schema 31, with every stored setting unchanged', async () => {
    expect(await readAppliedSchemaVersion(database.session)).toBe(31);
    const after = (await database.session.query('SELECT * FROM workspace_settings ORDER BY workspace_id, setting_key, version')).rows;
    expect(after).toEqual(settingsBefore);
  });

  it('admits the monthly_cash_ceiling_cents key', async () => {
    await insertCeiling();
    const { rows } = await database.session.query("SELECT 1 FROM workspace_settings WHERE setting_key = 'monthly_cash_ceiling_cents'");
    expect(rows).toHaveLength(1);
  });
});
