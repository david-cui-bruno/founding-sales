import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { applyMigrations, readAppliedSchemaVersion } from '../../db/migrationRunner.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from './support/fixtures.ts';
import { seedCrm, type SeededCrm } from './support/crmFixtures.ts';

/**
 * Migration 0038 on a database at schema 37 (lane PB): `firm_prepared_briefs` exists, empty,
 * granted to the runtime role, every stored firm is untouched, and the sources CHECK refuses
 * every shape but an array of `{url, label}` with an https URL.
 */
describe('migration 0038 on a database at schema 37', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;
  let firmsBefore: unknown[] = [];

  beforeAll(async () => {
    database = await createTestDatabase({ throughVersion: 37 });
    expect(await readAppliedSchemaVersion(database.session)).toBe(37);
    seeded = await seedTwoWorkspaces(database.session);
    crm = await seedCrm(database.session, seeded);
    firmsBefore = (await database.session.query('SELECT * FROM firms ORDER BY id')).rows;
    await applyMigrations(database.session, { throughVersion: 38 });
  });

  afterAll(async () => {
    await database.drop();
  });

  it('is at schema 38, with every stored firm unchanged', async () => {
    expect(await readAppliedSchemaVersion(database.session)).toBe(38);
    expect((await database.session.query('SELECT * FROM firms ORDER BY id')).rows).toEqual(firmsBefore);
  });

  it('creates firm_prepared_briefs, empty, readable and writable by the runtime role', async () => {
    expect((await database.session.query('SELECT count(*)::int AS n FROM firm_prepared_briefs')).rows).toEqual([{ n: 0 }]);
    const { rows } = await database.session.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'firm_prepared_briefs' AND grantee = 'app_runtime' ORDER BY privilege_type`,
    );
    expect(rows.map(row => row.privilege_type)).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });

  it('admits an array of {url, label} and refuses every other sources shape', async () => {
    const insert = async (sources: string): Promise<unknown> => {
      await database.session.query('BEGIN');
      try {
        return await database.session.query(
          `INSERT INTO firm_prepared_briefs (workspace_id, firm_id, brief, sources, observed_on, prepared_by)
           VALUES ($1, $2, 'Brief', $3::jsonb, '2026-10-02', 'Agent')`,
          [seeded.alpha.workspaceId, crm.alpha.firmId, sources],
        );
      } finally {
        await database.session.query('ROLLBACK');
      }
    };
    await expect(insert('[]')).resolves.toBeDefined();
    await expect(insert('[{"url":"https://a.example.test/x","label":"Source"}]')).resolves.toBeDefined();
    for (const bad of [
      '{}',
      '"https://a.example.test"',
      '[1]',
      '[{"url":"https://a.example.test/x"}]',
      '[{"url":"https://a.example.test/x","label":"Source","extra":true}]',
      '[{"url":"http://a.example.test/x","label":"Source"}]',
      '[{"url":"https://a.example.test/x y","label":"Source"}]',
      '[{"url":"https://a.example.test/x","label":" "}]',
      '[{"url":7,"label":"Source"}]',
      JSON.stringify(Array.from({ length: 31 }, () => ({ url: 'https://a.example.test/x', label: 'S' }))),
    ]) {
      await expect(insert(bad), bad).rejects.toMatchObject({ constraint: 'firm_prepared_briefs_sources_shape' });
    }
  });
});
