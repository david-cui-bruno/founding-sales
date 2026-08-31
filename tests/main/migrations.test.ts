import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
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

  it('creates the complete foundation schema at version 1', async () => {
    tempDatabase = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: tempDatabase.path, key });

    const result = await migrateToLatest(database, {
      backupDirectory: `${tempDatabase.path}.backups`,
      workspaceKey: key,
    });

    expect(result).toEqual({
      fromVersion: 0,
      toVersion: 1,
      appliedMigrationIds: ['0001Foundation'],
    });
    expect(
      await database.kysely
        .selectFrom('app_meta')
        .select('schema_version')
        .executeTakeFirstOrThrow(),
    ).toEqual({ schema_version: 1 });

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
      fromVersion: 1,
      toVersion: 1,
      appliedMigrationIds: [],
    });
    expect(
      await database.kysely
        .selectFrom('app_meta')
        .select('schema_version')
        .executeTakeFirstOrThrow(),
    ).toEqual({ schema_version: 1 });
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
      toVersion: 1,
      appliedMigrationIds: ['0001Foundation'],
    });
  });
});
