import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import { loadMigrations, readAppliedSchemaVersion } from '../../db/migrationRunner.ts';
import { FOUNDATION_TABLES } from '../../db/lookupKeys.ts';

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

describe('expand, migrate, contract compatibility', () => {
  it('applies every migration to a database seeded at the previous version with data', async () => {
    const files = loadMigrations();
    const previous = files.length - 1;

    // (a) A database seeded at the previous version. For the initial migration the
    // previous version is 0, an empty database, which is the same start the fresh
    // case uses; from migration 0002 onwards this branch carries real rows forward.
    const seeded = await createTestDatabase({ throughVersion: previous });
    try {
      expect(await readAppliedSchemaVersion(seeded.session)).toBe(previous);
      if (previous >= 1) {
        await seeded.session.query("INSERT INTO workspaces (slug, display_name) VALUES ('seeded', 'Seeded')");
      }
      const { applyMigrations } = await import('../../db/migrationRunner.ts');
      const applied = await applyMigrations(seeded.session);
      expect(applied.map(entry => entry.version)).toEqual(
        files.filter(file => file.version > previous).map(file => file.version),
      );
      expect(await readAppliedSchemaVersion(seeded.session)).toBe(files.at(-1)?.version);

      // The previous binary's declared range still accepts the result. Under expand,
      // migrate, contract the migration is deployed while the previous release is
      // still running, so PREVIOUS_RELEASE_SCHEMA_RANGE has to have been widened one
      // release ahead of the migration that needs it. This assertion is the gate.
      const { PREVIOUS_RELEASE_SCHEMA_RANGE, acceptsSchemaVersion } = await import('../../db/schemaRange.ts');
      const finalVersion = files.at(-1)?.version ?? 0;
      expect(acceptsSchemaVersion(PREVIOUS_RELEASE_SCHEMA_RANGE, finalVersion)).toBe(true);
    } finally {
      await seeded.drop();
    }
  });
});
