import { inspectDatabaseEncryption } from '../../../../src/main/db/databaseEncryption';
import { Kysely, SqliteDialect } from 'kysely';
import type { FoundationDatabase } from '../../../../src/main/db/schema';
import { applyWorkspaceKey, createRawDatabase } from '../../../../src/main/db/sqliteDriver';
import * as migrationBackup from '../../../../src/main/db/migrationBackup';
import { migration0029AccountCallbacks } from '../../../../src/main/db/migrations/0029AccountCallbacks';
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase, type AppDatabase } from '../../../../src/main/db/database';
import { createMigrationRunner, migrateToLatest, productionMigrations } from '../../../../src/main/db/migrate';
import { assertDomainStorageReady, assertPreReleaseStorageReady, DOMAIN_SCHEMA_MANIFEST, SCHEMA28_MANIFEST, SCHEMA29_MANIFEST } from '../../../../src/main/domain/startup/storageReadiness';
import { DomainStartupFatalError } from '../../../../src/main/domain/startup/domainStartupTypes';
import { AccountRepository } from '../../../../src/main/domain/accounts/accountRepository';
import { createTempDatabase, createTestWorkspaceKey } from '../../../fixtures/tempDatabase';

const NOW = '2026-09-18T13:00:00.000Z';
type CatalogRow = { type: string; name: string; sql: string | null };
const catalogOf = (database: AppDatabase) => database.raw.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN('table','index','trigger') AND(type<>'index' OR sql IS NOT NULL) ORDER BY type,name").all() as CatalogRow[];
const manifestOf = (database: AppDatabase) => {
  const actual = database.raw.prepare("SELECT name,type,sql FROM sqlite_master WHERE type IN('table','index','trigger') AND(type<>'index' OR sql IS NOT NULL) ORDER BY name COLLATE BINARY").all() as CatalogRow[];
  return { tables: actual.filter(row => row.type === 'table').map(row => row.name).sort(), indexes: actual.filter(row => row.type === 'index').map(row => row.name).sort(), triggers: actual.filter(row => row.type === 'trigger').map(row => row.name).sort(),
    catalogSha256: createHash('sha256').update(JSON.stringify(actual.map(row => [row.type, row.name, (row.sql ?? '').replace(/\s+/g, ' ').trim()]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))).digest('hex') };
};
const readiness30 = (database: AppDatabase) => assertDomainStorageReady({ database, expectedBusyTimeoutMs: 5000, expectedSchemaVersion: 30, expectedManifest: DOMAIN_SCHEMA_MANIFEST });
const fatalCode = (run: () => unknown) => { try { run(); } catch (error) { return error instanceof DomainStartupFatalError ? error.code : error; } return undefined; };
const insertCallback = (database: AppDatabase, accountId: string, extra: Partial<{ id: string; dueOn: string; note: string | null; state: string; revision: number; commandId: string; createdAt: string; updatedAt: string }> = {}) =>
  database.raw.prepare('INSERT INTO pm_account_callbacks(id,account_id,due_on,note,state,revision,source_command_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(extra.id ?? 'callback-one', accountId, extra.dueOn ?? '2026-09-25', extra.note === undefined ? 'Call the office manager back.' : extra.note,
      extra.state ?? 'open', extra.revision ?? 1, extra.commandId ?? 'a0b1c2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d', extra.createdAt ?? NOW, extra.updatedAt ?? NOW);

/** Genuine schema 28 with a real account, exactly what the callback rows reference. */
async function seedGenuine28(database: AppDatabase, options: { workspaceKey: ReturnType<typeof createTestWorkspaceKey>; backupDirectory: string }) {
  await createMigrationRunner(productionMigrations.filter(entry => entry.schemaVersion <= 28))(database, options);
  expect(assertPreReleaseStorageReady(database).schemaVersion).toBe(28);
  const accounts = new AccountRepository({ database, clock: { now: () => NOW }, ids: { next: randomUUID }, sourcePolicy: { attest: () => true } });
  const account = accounts.create({ commandId: 'c4b0d9a2-4a6b-4a4a-9a1e-6c3f7a7f1a29', name: 'Callback PM', domain: 'callback.example' });
  expect(database.raw.prepare("SELECT name FROM sqlite_master WHERE name='pm_account_callbacks'").get()).toBeUndefined();
  return account;
}

it('upgrades genuine28 additively with verified encrypted backup, byte-identical rows and catalog elsewhere, exact30 readiness and reopen', async () => {
  const temp = createTempDatabase(), key = createTestWorkspaceKey();
  const options = { workspaceKey: key, backupDirectory: `${temp.path}.backups` };
  const database = openDatabase({ path: temp.path, key });
  try {
    const account = await seedGenuine28(database, options);
    const catalog = catalogOf(database);
    const tables = catalog.filter(row => row.type === 'table' && !['app_meta', 'kysely_migration'].includes(row.name)).map(row => row.name);
    const rows = () => tables.map(name => [name, database.raw.prepare(`SELECT * FROM "${name}"`).raw().all()]);
    const original = rows();
    const oldLedger = database.raw.prepare('SELECT * FROM kysely_migration ORDER BY name').all();

    expect(await migrateToLatest(database, options)).toEqual({ fromVersion: 28, toVersion: 30, appliedMigrationIds: ['0029AccountCallbacks', '0030EmailTemplates'] });

    expect(rows()).toEqual(original);
    expect(database.raw.pragma('foreign_key_check')).toEqual([]);
    // Every schema-28 object keeps its exact SQL except campaign_enrollments, which gains two nullable columns by ADD COLUMN.
    for (const row of catalog.filter(entry => entry.name !== 'campaign_enrollments')) expect(database.raw.prepare('SELECT type,name,sql FROM sqlite_master WHERE type=? AND name=?').get(row.type, row.name)).toEqual(row);
    const before28 = catalog.find(row => row.name === 'campaign_enrollments')!.sql!;
    const enrollments = (database.raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='campaign_enrollments'").get() as { sql: string }).sql;
    // ADD COLUMN only appends two nullable columns; every prior column, constraint and foreign key is byte-identical.
    expect(enrollments.replace(', next_due_at TEXT NULL, resting_until TEXT NULL', '')).toBe(before28);
    expect(database.raw.prepare('PRAGMA table_info(campaign_enrollments)').all().slice(-2))
      .toEqual([{ cid: 14, name: 'next_due_at', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 }, { cid: 15, name: 'resting_until', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 }]);
    const added = catalogOf(database).filter(row => !catalog.some(entry => entry.type === row.type && entry.name === row.name)).map(row => [row.type, row.name]);
    // 0030 adds its own template objects on top of the callback objects 0029 adds.
    expect(added).toEqual([['index', 'pm_account_callbacks_due'], ['table', 'email_template_settings'], ['table', 'email_templates'], ['table', 'pm_account_callbacks'],
      ['trigger', 'email_template_settings_no_delete'], ['trigger', 'email_template_settings_revision'],
      ['trigger', 'email_templates_no_delete'], ['trigger', 'email_templates_revision'],
      ['trigger', 'pm_account_callbacks_no_delete'], ['trigger', 'pm_account_callbacks_revision']]);
    expect(database.raw.prepare('SELECT next_due_at,resting_until FROM campaign_enrollments').all()).toEqual([]);
    expect(manifestOf(database)).toEqual(DOMAIN_SCHEMA_MANIFEST);
    expect(readiness30(database).schemaVersion).toBe(30);
    expect(assertPreReleaseStorageReady(database).schemaVersion).toBe(30);

    // The table admits one revisioned row per promised callback and refuses what the contract refuses.
    insertCallback(database, account.id);
    insertCallback(database, account.id, { id: 'callback-two', dueOn: '2026-10-02', note: null, commandId: 'b0b1c2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d' });
    expect(database.raw.prepare('SELECT id,due_on,state,revision FROM pm_account_callbacks ORDER BY id').all())
      .toEqual([{ id: 'callback-one', due_on: '2026-09-25', state: 'open', revision: 1 }, { id: 'callback-two', due_on: '2026-10-02', state: 'open', revision: 1 }]);
    expect(() => insertCallback(database, account.id)).toThrow(/UNIQUE constraint failed|PRIMARY KEY/);
    expect(() => insertCallback(database, 'no-such-account', { id: 'callback-three' })).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => insertCallback(database, account.id, { id: 'callback-four', dueOn: '2026-09-25T00:00:00.000Z' })).toThrow(/CHECK constraint failed/);
    expect(() => insertCallback(database, account.id, { id: 'callback-five', state: 'snoozed' })).toThrow(/CHECK constraint failed/);
    expect(() => insertCallback(database, account.id, { id: 'callback-six', revision: 0 })).toThrow(/CHECK constraint failed/);
    expect(() => insertCallback(database, account.id, { id: 'callback-seven', note: 'x'.repeat(10001) })).toThrow(/CHECK constraint failed/);
    expect(() => database.raw.prepare("DELETE FROM pm_account_callbacks WHERE id='callback-one'").run()).toThrow(/Account callback history is immutable/);
    expect(() => database.raw.prepare("UPDATE pm_account_callbacks SET state='done' WHERE id='callback-one'").run()).toThrow(/Account callback revision is monotonic/);
    expect(() => database.raw.prepare("UPDATE pm_account_callbacks SET revision=3 WHERE id='callback-one'").run()).toThrow(/Account callback revision is monotonic/);
    expect(() => database.raw.prepare("UPDATE pm_account_callbacks SET revision=2,due_on='2026-09-26' WHERE id='callback-one'").run()).toThrow(/Account callback revision is monotonic/);
    expect(() => database.raw.prepare("UPDATE pm_account_callbacks SET revision=2,source_command_id='other' WHERE id='callback-one'").run()).toThrow(/Account callback revision is monotonic/);
    database.raw.prepare("UPDATE pm_account_callbacks SET revision=2,state='done',updated_at=? WHERE id='callback-one'").run('2026-09-25T14:00:00.000Z');
    expect(database.raw.prepare("SELECT revision,state FROM pm_account_callbacks WHERE id='callback-one'").get()).toEqual({ revision: 2, state: 'done' });

    const backups = readdirSync(options.backupDirectory).filter(name => name.startsWith('pre-migration-schema-28-') && name.endsWith('.sqlite3'));
    expect(backups).toHaveLength(1);
    const path = join(options.backupDirectory, backups[0]);
    const raw = createRawDatabase(path, { readonly: true, fileMustExist: true });
    applyWorkspaceKey(raw, key.bytes); raw.pragma('foreign_keys=ON'); raw.pragma('recursive_triggers=ON'); raw.pragma('busy_timeout=5000');
    const backup = { path, raw, kysely: new Kysely<FoundationDatabase>({ dialect: new SqliteDialect({ database: raw }) }) };
    try {
      expect(inspectDatabaseEncryption(backup)).toMatchObject({ encrypted: true, integrity: 'ok' });
      expect(raw.prepare('SELECT schema_version FROM app_meta WHERE singleton=1').get()).toEqual({ schema_version: 28 });
      expect(catalogOf(backup)).toEqual(catalog);
      expect(raw.prepare('SELECT * FROM kysely_migration ORDER BY name').all()).toEqual(oldLedger);
    } finally { closeDatabase(backup); }

    closeDatabase(database);
    const reopened = openDatabase({ path: temp.path, key });
    try {
      expect(await migrateToLatest(reopened, options)).toEqual({ fromVersion: 30, toVersion: 30, appliedMigrationIds: [] });
      expect(assertPreReleaseStorageReady(reopened).schemaVersion).toBe(30);
      expect(readiness30(reopened).schemaVersion).toBe(30);
      expect(reopened.raw.prepare('SELECT id,revision FROM pm_account_callbacks ORDER BY id').all()).toEqual([{ id: 'callback-one', revision: 2 }, { id: 'callback-two', revision: 1 }]);
    } finally { closeDatabase(reopened); }
  } finally { closeDatabase(database); key.bytes.fill(0); temp.cleanup(); }
});

it.each(['backup', 'migration'] as const)('failed %s leaves genuine28 ledger, catalog and rows unchanged', async failure => {
  const temp = createTempDatabase(), key = createTestWorkspaceKey(), database = openDatabase({ path: temp.path, key });
  const options = { workspaceKey: key, backupDirectory: `${temp.path}.backups` };
  try {
    await seedGenuine28(database, options);
    const before = database.raw.prepare('SELECT * FROM kysely_migration ORDER BY name').all(), catalog = catalogOf(database);
    const accounts = database.raw.prepare('SELECT * FROM pm_accounts ORDER BY rowid').all();
    const actualUp = migration0029AccountCallbacks.up;
    const spy = failure === 'backup' ? vi.spyOn(migrationBackup, 'createVerifiedMigrationBackup').mockImplementation(() => { throw new Error('Injected backup failure'); })
      : vi.spyOn(migration0029AccountCallbacks, 'up').mockImplementation(async db => { await actualUp(db); throw new Error('Injected migration failure'); });
    try { await expect(migrateToLatest(database, options)).rejects.toThrow(); } finally { spy.mockRestore(); }
    expect(database.raw.prepare('SELECT * FROM kysely_migration ORDER BY name').all()).toEqual(before);
    expect(catalogOf(database)).toEqual(catalog);
    expect(database.raw.prepare('SELECT * FROM pm_accounts ORDER BY rowid').all()).toEqual(accounts);
    expect(assertPreReleaseStorageReady(database).schemaVersion).toBe(28);
    expect(database.raw.prepare("SELECT name FROM sqlite_master WHERE name='pm_account_callbacks'").get()).toBeUndefined();
  } finally { closeDatabase(database); key.bytes.fill(0); temp.cleanup(); }
});

it('migrates a fresh encrypted database straight to 30 with an empty callback table', async () => {
  const temp = createTempDatabase(), key = createTestWorkspaceKey(), database = openDatabase({ path: temp.path, key });
  try {
    const result = await migrateToLatest(database, { workspaceKey: key, backupDirectory: `${temp.path}.backups` });
    expect(result).toMatchObject({ fromVersion: 0, toVersion: 30 });
    expect(result.appliedMigrationIds).toHaveLength(30);
    expect(result.appliedMigrationIds.at(-1)).toBe('0030EmailTemplates');
    expect(manifestOf(database)).toEqual(DOMAIN_SCHEMA_MANIFEST);
    expect(readiness30(database).schemaVersion).toBe(30);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM pm_account_callbacks').get()).toEqual({ count: 0 });
    expect(database.raw.pragma('foreign_key_check')).toEqual([]);
  } finally { closeDatabase(database); key.bytes.fill(0); temp.cleanup(); }
});

it('historical28 remains independently readable by the backup host, not admitted as current domain schema', async () => {
  const temp = createTempDatabase(), key = createTestWorkspaceKey(), database = openDatabase({ path: temp.path, key });
  try {
    await createMigrationRunner(productionMigrations.filter(entry => entry.schemaVersion <= 28))(database, { workspaceKey: key, backupDirectory: `${temp.path}.backups` });
    expect(manifestOf(database)).toEqual(SCHEMA28_MANIFEST);
    expect(SCHEMA28_MANIFEST.catalogSha256).not.toBe(SCHEMA29_MANIFEST.catalogSha256);
    expect(SCHEMA29_MANIFEST.tables).toEqual([...SCHEMA28_MANIFEST.tables, 'pm_account_callbacks'].sort());
    expect(SCHEMA29_MANIFEST.indexes).toEqual([...SCHEMA28_MANIFEST.indexes, 'pm_account_callbacks_due'].sort());
    expect(SCHEMA29_MANIFEST.triggers).toEqual([...SCHEMA28_MANIFEST.triggers, 'pm_account_callbacks_no_delete', 'pm_account_callbacks_revision'].sort());
    expect(assertPreReleaseStorageReady(database).schemaVersion).toBe(28);
    expect(fatalCode(() => readiness30(database))).toBe('schema_not_ready');
    // Even a caller asking for 28 is refused: the current 30-entry ledger rejects the 28 ledger before any manifest comparison.
    expect(fatalCode(() => assertDomainStorageReady({ database, expectedBusyTimeoutMs: 5000, expectedSchemaVersion: 28 as never, expectedManifest: DOMAIN_SCHEMA_MANIFEST }))).toBe('schema_not_ready');
  } finally { closeDatabase(database); key.bytes.fill(0); temp.cleanup(); }
});
