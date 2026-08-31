import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { createMigrationRunner, migrateToLatest } from '../../src/main/db/migrate';
import { migration0001Foundation } from '../../src/main/db/migrations/0001Foundation';
import { migration0002DomainFoundation } from '../../src/main/db/migrations/0002DomainFoundation';
import { sql } from 'kysely';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';

describe('database migrations', () => {
  let database: AppDatabase | undefined;
  let tempDatabase: TempDatabase | undefined;

  afterEach(() => {
    if (database !== undefined) {
      closeDatabase(database);
    }
    tempDatabase?.cleanup();
  });

  it('creates the complete foundation and domain schema at version 2', async () => {
    tempDatabase = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: tempDatabase.path, key });

    const result = await migrateToLatest(database, {
      backupDirectory: `${tempDatabase.path}.backups`,
      workspaceKey: key,
    });

    expect(result).toEqual({
      fromVersion: 0,
      toVersion: 2,
      appliedMigrationIds: ['0001Foundation', '0002DomainFoundation'],
    });
    expect(
      await database.kysely
        .selectFrom('app_meta')
        .select('schema_version')
        .executeTakeFirstOrThrow(),
    ).toEqual({ schema_version: 2 });

    const objects = database.raw
      .prepare<[], { name: string; type: string }>(
        `SELECT name, type
         FROM sqlite_master
         WHERE name IN ('app_meta', 'jobs', 'jobs_state_created_idx', 'foundation_fts_probe')
         ORDER BY name`,
      )
      .all();

    expect(objects).toEqual([
      { name: 'app_meta', type: 'table' },
      { name: 'foundation_fts_probe', type: 'table' },
      { name: 'jobs', type: 'table' },
      { name: 'jobs_state_created_idx', type: 'index' },
    ]);
  });

  it('is idempotent when run twice against the same database', async () => {
    tempDatabase = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: tempDatabase.path, key });

    const options = {
      backupDirectory: `${tempDatabase.path}.backups`,
      workspaceKey: key,
    };
    await migrateToLatest(database, options);
    const secondResult = await migrateToLatest(database, options);

    expect(secondResult).toEqual({
      fromVersion: 2,
      toVersion: 2,
      appliedMigrationIds: [],
    });
    expect(
      await database.kysely
        .selectFrom('app_meta')
        .select('schema_version')
        .executeTakeFirstOrThrow(),
    ).toEqual({ schema_version: 2 });
    expect(
      database.raw
        .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM app_meta')
        .get(),
    ).toEqual({ count: 1 });
  });

  it('rolls back a late migration failure so the same database can retry', async () => {
    tempDatabase = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: tempDatabase.path, key });
    database.raw.exec('CREATE TABLE foundation_fts_probe (content TEXT)');
    const options = {
      backupDirectory: `${tempDatabase.path}.backups`,
      workspaceKey: key,
    };

    await expect(migrateToLatest(database, options)).rejects.toThrow();

    expect(database.raw.inTransaction).toBe(false);
    expect(
      database.raw
        .prepare<[], { name: string }>(
          `SELECT name
           FROM sqlite_master
           WHERE name IN (
             'app_meta',
             'jobs',
             'jobs_state_created_idx',
             'kysely_migration',
             'kysely_migration_lock',
             'foundation_fts_probe'
           )
           ORDER BY name`,
        )
        .all(),
    ).toEqual([{ name: 'foundation_fts_probe' }]);

    database.raw.exec('DROP TABLE foundation_fts_probe');

    await expect(migrateToLatest(database, options)).resolves.toEqual({
      fromVersion: 0,
      toVersion: 2,
      appliedMigrationIds: ['0001Foundation', '0002DomainFoundation'],
    });
  });

  it('rolls a late schema-2 failure back to exact schema 1 before a clean retry', async () => {
    tempDatabase = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: tempDatabase.path, key });
    const options = {
      backupDirectory: `${tempDatabase.path}.backups`,
      workspaceKey: key,
    };
    const migrateToSchemaOne = createMigrationRunner([
      {
        id: '0001Foundation',
        schemaVersion: 1,
        migration: migration0001Foundation,
      },
    ]);
    await migrateToSchemaOne(database, options);
    database.raw.prepare(`
      INSERT INTO jobs (id, type, state, payload_json, created_at, updated_at)
      VALUES ('schema-one-sentinel', 'test', 'queued', '{}', ?, ?)
    `).run('2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');

    const migrateWithLateFailure = createMigrationRunner([
      {
        id: '0001Foundation',
        schemaVersion: 1,
        migration: migration0001Foundation,
      },
      {
        id: '0002SyntheticLateFailure',
        schemaVersion: 2,
        migration: {
          async up(kysely) {
            await sql`CREATE TABLE synthetic_persons (id TEXT PRIMARY KEY)`.execute(kysely);
            await sql`CREATE TABLE synthetic_sources (id TEXT PRIMARY KEY)`.execute(kysely);
            await sql`CREATE TABLE synthetic_cycles (id TEXT PRIMARY KEY)`.execute(kysely);
            await sql`UPDATE app_meta SET schema_version = 2 WHERE singleton = 1`.execute(kysely);
            throw new Error('Synthetic late schema-2 failure.');
          },
        },
      },
    ]);

    await expect(migrateWithLateFailure(database, options)).rejects.toThrow(
      'Synthetic late schema-2 failure.',
    );
    expect(database.raw.inTransaction).toBe(false);
    expect(database.raw.prepare<[], { schema_version: number }>(
      'SELECT schema_version FROM app_meta WHERE singleton = 1',
    ).get()).toEqual({ schema_version: 1 });
    expect(database.raw.prepare<[], { name: string }>(`
      SELECT name FROM sqlite_master
      WHERE name IN ('synthetic_persons', 'synthetic_sources', 'synthetic_cycles')
    `).all()).toEqual([]);
    expect(database.raw.prepare<[], { id: string }>(
      "SELECT id FROM jobs WHERE id = 'schema-one-sentinel'",
    ).get()).toEqual({ id: 'schema-one-sentinel' });

    await expect(migrateToLatest(database, options)).resolves.toEqual({
      fromVersion: 1,
      toVersion: 2,
      appliedMigrationIds: ['0002DomainFoundation'],
    });
  });

  it('creates the intake receipt before a late real-schema failure and rolls it back', async () => {
    tempDatabase = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: tempDatabase.path, key });
    const options = {
      backupDirectory: `${tempDatabase.path}.backups`,
      workspaceKey: key,
    };
    const migrateToSchemaOne = createMigrationRunner([{
      id: '0001Foundation',
      schemaVersion: 1,
      migration: migration0001Foundation,
    }]);
    await migrateToSchemaOne(database, options);
    const migrateWithReceiptFailure = createMigrationRunner([
      {
        id: '0001Foundation',
        schemaVersion: 1,
        migration: migration0001Foundation,
      },
      {
        id: '0002ReceiptLateFailure',
        schemaVersion: 2,
        migration: {
          async up(kysely) {
            await migration0002DomainFoundation.up(kysely);
            const receipt = await sql<{ name: string }>`
              SELECT name FROM sqlite_master
              WHERE type = 'table' AND name = 'source_intake_receipts'
            `.execute(kysely);
            if (receipt.rows[0]?.name !== 'source_intake_receipts') {
              throw new Error('Receipt table missing before late failure.');
            }
            throw new Error('Synthetic failure after receipt creation.');
          },
        },
      },
    ]);

    await expect(migrateWithReceiptFailure(database, options)).rejects.toThrow(
      'Synthetic failure after receipt creation.',
    );
    expect(database.raw.prepare<[], { schema_version: number }>(
      'SELECT schema_version FROM app_meta WHERE singleton = 1',
    ).get()).toEqual({ schema_version: 1 });
    expect(database.raw.prepare<[], { name: string }>(`
      SELECT name FROM sqlite_master WHERE name = 'source_intake_receipts'
    `).get()).toBeUndefined();
  });
});
