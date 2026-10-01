import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { readAppliedSchemaVersion } from '../../db/migrationRunner.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from './support/fixtures.ts';

/**
 * Migration 0030 on a database at schema 29 (slice C2): every stored setting survives
 * the widened key CHECK, the new key `call_transcription` is admitted (it was refused at
 * 29), and `call_transcripts` exists, granted to the runtime role.
 */
describe('migration 0030 on a database at schema 29', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let settingsBefore: unknown[] = [];

  const insertTranscriptionSetting = async (): Promise<void> => {
    await database.session.query(
      `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, changed_by_user_id)
       VALUES ($1, 'call_transcription', 1, '{"enabled": false, "dailyCeilingCents": 0, "unitPriceMicros": 4300}'::jsonb, $2)`,
      [seeded.alpha.workspaceId, seeded.alpha.admin.userId],
    );
  };

  beforeAll(async () => {
    database = await createTestDatabase({ throughVersion: 29 });
    expect(await readAppliedSchemaVersion(database.session)).toBe(29);
    seeded = await seedTwoWorkspaces(database.session);
    await database.session.query(
      `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, changed_by_user_id)
       VALUES ($1, 'voicemail_script', 1, '{"template": "Hi."}'::jsonb, $2)`,
      [seeded.alpha.workspaceId, seeded.alpha.admin.userId],
    );
    await expect(insertTranscriptionSetting()).rejects.toMatchObject({ constraint: 'workspace_settings_key_known' });
    settingsBefore = (await database.session.query('SELECT * FROM workspace_settings ORDER BY workspace_id, setting_key, version')).rows;
    const { applyMigrations } = await import('../../db/migrationRunner.ts');
    await applyMigrations(database.session, { throughVersion: 30 });
  });

  afterAll(async () => {
    await database.drop();
  });

  it('is at schema 30, with every stored setting unchanged', async () => {
    expect(await readAppliedSchemaVersion(database.session)).toBe(30);
    const after = (await database.session.query('SELECT * FROM workspace_settings ORDER BY workspace_id, setting_key, version')).rows;
    expect(after).toEqual(settingsBefore);
  });

  it('admits the call_transcription key', async () => {
    await insertTranscriptionSetting();
    const { rows } = await database.session.query("SELECT 1 FROM workspace_settings WHERE setting_key = 'call_transcription'");
    expect(rows).toHaveLength(1);
  });

  it('creates call_transcripts, empty, readable and writable by the runtime role', async () => {
    expect((await database.session.query('SELECT count(*)::int AS n FROM call_transcripts')).rows).toEqual([{ n: 0 }]);
    const { rows } = await database.session.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'call_transcripts' AND grantee = 'app_runtime' ORDER BY privilege_type`,
    );
    expect(rows.map(row => row.privilege_type)).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });
});
