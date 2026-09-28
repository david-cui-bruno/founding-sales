import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { readAppliedSchemaVersion } from '../../db/migrationRunner.ts';
import { REQUIRED_SCHEMA } from '../../db/schemaRange.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from './support/fixtures.ts';

/**
 * Migration 0020 on a database at 19, and on a fresh one (lane W3-F).
 *
 * The migration is one statement: `workspace_settings_key_known` gains `postal_address`.
 * So the test is about what the CHECK admits before and after, and about what the
 * migration leaves alone — it drops nothing and rewrites nothing.
 *
 * ## The vacuous-pass traps, named
 *
 * **A CHECK that was never exercised.** The schema-19 database inserts a `postal_address`
 * row *before* the migration and is refused by name, and the same insert after it is
 * accepted: the test fails if 0020 does nothing.
 *
 * **A migration that quietly took something with it.** The settings rows written at 19 —
 * their versions, values and history — are read back after the apply and compared, and
 * the keys 0019 retired are still refused.
 */
describe('migration 0020 on a database at schema 19', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  const address = { address: '1 Example Way, Suite 2\nProvidence, RI 02903' };

  const insertSetting = async (key: string, value: unknown, version = 1): Promise<void> => {
    await database.session.query(
      `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, change_note, changed_by_user_id)
       VALUES ($1, $2, $3, $4::jsonb, 'a note', $5)`,
      [seeded.alpha.workspaceId, key, version, JSON.stringify(value), seeded.alpha.admin.userId],
    );
  };

  beforeAll(async () => {
    database = await createTestDatabase({ throughVersion: 19 });
    seeded = await seedTwoWorkspaces(database.session);
    await insertSetting('business_time_zone', { timeZone: 'America/New_York' });
    await insertSetting('sending_enabled', { enabled: false, releaseGateReference: null });
  });

  afterAll(async () => {
    await database.drop();
  });

  it('refuses the address at 19, admits it at 20, and reaches the schema both images declare', async () => {
    await expect(insertSetting('postal_address', address)).rejects.toMatchObject({
      constraint: 'workspace_settings_key_known',
    });

    const { applyMigrations } = await import('../../db/migrationRunner.ts');
    // Every unapplied migration, so 0021 runs too; 0020 is the one this file is about.
    const applied = await applyMigrations(database.session);
    expect(applied.map(entry => entry.version)).toContain(20);
    expect(applied.find(entry => entry.version === 20)?.name).toBe('postal_address');
    expect(await readAppliedSchemaVersion(database.session)).toBe(REQUIRED_SCHEMA);

    await insertSetting('postal_address', address);
    const { rows } = await database.session.query<{ value: unknown }>(
      "SELECT value FROM workspace_settings WHERE workspace_id = $1 AND setting_key = 'postal_address'",
      [seeded.alpha.workspaceId],
    );
    expect(rows).toEqual([{ value: address }]);
  });

  it('drops nothing: the rows written at 19 are the rows at 20, and the retired keys are still refused', async () => {
    const { rows } = await database.session.query<{ setting_key: string; version: number }>(
      `SELECT setting_key, version FROM workspace_settings
        WHERE workspace_id = $1 AND setting_key <> 'postal_address' ORDER BY setting_key`,
      [seeded.alpha.workspaceId],
    );
    expect(rows).toEqual([
      { setting_key: 'business_time_zone', version: 1 },
      { setting_key: 'sending_enabled', version: 1 },
    ]);
    for (const key of ['alert_thresholds', 'client_version_range', 'postal_footer']) {
      await expect(insertSetting(key, {}), key).rejects.toMatchObject({
        constraint: 'workspace_settings_key_known',
      });
    }
  });

  it('clears the address with a null, which is a version like any other', async () => {
    await database.session.query(
      `UPDATE workspace_settings SET superseded_at = now(), superseded_by_version = 2
        WHERE workspace_id = $1 AND setting_key = 'postal_address' AND version = 1`,
      [seeded.alpha.workspaceId],
    );
    await insertSetting('postal_address', { address: null }, 2);
    const { rows } = await database.session.query<{ value: { address: string | null } }>(
      `SELECT value FROM workspace_settings
        WHERE workspace_id = $1 AND setting_key = 'postal_address' AND superseded_at IS NULL`,
      [seeded.alpha.workspaceId],
    );
    expect(rows).toEqual([{ value: { address: null } }]);
  });
});

describe('migration 0020 on a fresh database', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database.drop();
  });

  it('admits the three active keys and nothing else', async () => {
    expect(await readAppliedSchemaVersion(database.session)).toBe(REQUIRED_SCHEMA);
    const seeded = await seedTwoWorkspaces(database.session);
    const insert = async (key: string, value: unknown): Promise<unknown> =>
      await database.session.query(
        `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, change_note, changed_by_user_id)
         VALUES ($1, $2, 1, $3::jsonb, 'a note', $4)`,
        [seeded.beta.workspaceId, key, JSON.stringify(value), seeded.beta.admin.userId],
      );
    for (const key of ['business_time_zone', 'postal_address', 'sending_enabled']) {
      await expect(insert(key, {}), key).resolves.toBeDefined();
    }
    await expect(insert('anything_else', {})).rejects.toMatchObject({
      constraint: 'workspace_settings_key_known',
    });
  });
});
