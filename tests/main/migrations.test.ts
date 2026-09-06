import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { createMigrationRunner, migrateToLatest, productionMigrations } from '../../src/main/db/migrate';
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
      toVersion: 16,
      appliedMigrationIds: ['0001Foundation', '0002DomainFoundation', '0003Transcripts', '0004Learnings', '0005SourcingChannels', '0006SourcingState', '0007SourcingOutbox', '0008DedupeCloudPersons', '0009SourcingFileLedger', '0010NoDueDates', '0011ContactDncFlags', '0012UpstreamRequestState', '0013ContactComplianceEvidence', '0014OutboundJurisdictionClearance', '0015RecoveryMetadata', '0016ContactPresentationEvidence'],
    });
    expect(
      await database.kysely
        .selectFrom('app_meta')
        .select('schema_version')
        .executeTakeFirstOrThrow(),
    ).toEqual({ schema_version: 16 });

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
      fromVersion: 16,
      toVersion: 16,
      appliedMigrationIds: [],
    });
    expect(
      await database.kysely
        .selectFrom('app_meta')
        .select('schema_version')
        .executeTakeFirstOrThrow(),
    ).toEqual({ schema_version: 16 });
    expect(
      database.raw
        .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM app_meta')
        .get(),
    ).toEqual({ count: 1 });
  });

  it.each([
    { label: 'unknown', value: 'unknown' },
    { label: 'future', value: 17 },
    { label: 'negative', value: -1 },
    { label: 'noninteger', value: 15.5 },
  ])('rejects a $label schema marker before backup or migration', async ({ value }) => {
    tempDatabase = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: tempDatabase.path, key });
    const options = { backupDirectory: `${tempDatabase.path}.backups`, workspaceKey: key };
    await createMigrationRunner(productionMigrations.slice(0, 15))(database, options);
    database.raw.prepare('UPDATE app_meta SET schema_version = ? WHERE singleton = 1').run(value);
    const backupCountBefore = database.raw.prepare<[], { count: number }>(
      'SELECT COUNT(*) AS count FROM backup_receipts',
    ).get()!.count;
    const beforeLedger = database.raw.prepare(
      'SELECT name, timestamp FROM kysely_migration ORDER BY timestamp, name',
    ).all();

    await expect(migrateToLatest(database, options)).rejects.toThrow(/schema version/i);

    expect(database.raw.prepare('SELECT schema_version FROM app_meta WHERE singleton = 1').get())
      .toEqual({ schema_version: value });
    expect(database.raw.prepare(
      'SELECT name, timestamp FROM kysely_migration ORDER BY timestamp, name',
    ).all()).toEqual(beforeLedger);
    expect(database.raw.prepare<[], { count: number }>(
      'SELECT COUNT(*) AS count FROM backup_receipts',
    ).get()!.count).toBe(backupCountBefore);
  });

  it.each([
    {
      label: 'missing entry',
      schemaVersion: 15,
      corrupt: (db: AppDatabase) => db.raw.prepare(
        "DELETE FROM kysely_migration WHERE name = '0015RecoveryMetadata'",
      ).run(),
    },
    {
      label: 'extra entry',
      schemaVersion: 14,
      corrupt: (): void => undefined,
    },
    {
      label: 'unknown entry',
      schemaVersion: 15,
      corrupt: (db: AppDatabase) => db.raw.prepare(
        "UPDATE kysely_migration SET name = '0015Unknown' WHERE name = '0015RecoveryMetadata'",
      ).run(),
    },
    {
      label: 'reordered entry',
      schemaVersion: 15,
      corrupt: (db: AppDatabase) => db.raw.prepare(
        "UPDATE kysely_migration SET timestamp = '0000-01-01T00:00:00.000Z' WHERE name = '0015RecoveryMetadata'",
      ).run(),
    },
  ])('rejects a $label ledger before backup or migration', async ({ schemaVersion, corrupt }) => {
    tempDatabase = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: tempDatabase.path, key });
    const options = { backupDirectory: `${tempDatabase.path}.backups`, workspaceKey: key };
    await createMigrationRunner(productionMigrations.slice(0, 15))(database, options);
    const backupCountBefore = database.raw.prepare<[], { count: number }>(
      'SELECT COUNT(*) AS count FROM backup_receipts',
    ).get()!.count;
    database.raw.prepare('UPDATE app_meta SET schema_version = ? WHERE singleton = 1')
      .run(schemaVersion);
    corrupt(database);
    const beforeLedger = database.raw.prepare(
      'SELECT name, timestamp FROM kysely_migration ORDER BY timestamp, name',
    ).all();

    await expect(migrateToLatest(database, options)).rejects.toThrow(/migration ledger/i);

    expect(database.raw.prepare('SELECT schema_version FROM app_meta WHERE singleton = 1').get())
      .toEqual({ schema_version: schemaVersion });
    expect(database.raw.prepare(
      'SELECT name, timestamp FROM kysely_migration ORDER BY timestamp, name',
    ).all()).toEqual(beforeLedger);
    expect(database.raw.prepare<[], { count: number }>(
      'SELECT COUNT(*) AS count FROM backup_receipts',
    ).get()!.count).toBe(backupCountBefore);
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
      toVersion: 16,
      appliedMigrationIds: ['0001Foundation', '0002DomainFoundation', '0003Transcripts', '0004Learnings', '0005SourcingChannels', '0006SourcingState', '0007SourcingOutbox', '0008DedupeCloudPersons', '0009SourcingFileLedger', '0010NoDueDates', '0011ContactDncFlags', '0012UpstreamRequestState', '0013ContactComplianceEvidence', '0014OutboundJurisdictionClearance', '0015RecoveryMetadata', '0016ContactPresentationEvidence'],
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
      toVersion: 16,
      appliedMigrationIds: ['0002DomainFoundation', '0003Transcripts', '0004Learnings', '0005SourcingChannels', '0006SourcingState', '0007SourcingOutbox', '0008DedupeCloudPersons', '0009SourcingFileLedger', '0010NoDueDates', '0011ContactDncFlags', '0012UpstreamRequestState', '0013ContactComplianceEvidence', '0014OutboundJurisdictionClearance', '0015RecoveryMetadata', '0016ContactPresentationEvidence'],
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
            const receiptColumns = await sql<{ name: string }>`
              PRAGMA table_info(source_intake_receipts)
            `.execute(kysely);
            if (
              !receiptColumns.rows.some(({ name }) => name === 'person_id')
              || !receiptColumns.rows.some(({ name }) => name === 'prospect_id')
            ) {
              throw new Error('Receipt ownership missing before late failure.');
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
