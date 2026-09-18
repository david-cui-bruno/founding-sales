import { inspectDatabaseEncryption } from '../../../../src/main/db/databaseEncryption';
import { Kysely, SqliteDialect } from 'kysely';
import type { FoundationDatabase } from '../../../../src/main/db/schema';
import { applyWorkspaceKey, createRawDatabase } from '../../../../src/main/db/sqliteDriver';
import * as migrationBackup from '../../../../src/main/db/migrationBackup';
import { migration0028TerritoryClearances } from '../../../../src/main/db/migrations/0028TerritoryClearances';
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase, type AppDatabase } from '../../../../src/main/db/database';
import { createMigrationRunner, migrateToLatest, productionMigrations } from '../../../../src/main/db/migrate';
import { assertDomainStorageReady, assertPreReleaseStorageReady, DOMAIN_SCHEMA_MANIFEST, SCHEMA27_MANIFEST, SCHEMA28_MANIFEST } from '../../../../src/main/domain/startup/storageReadiness';
import { DomainStartupFatalError } from '../../../../src/main/domain/startup/domainStartupTypes';
import { AccountRepository } from '../../../../src/main/domain/accounts/accountRepository';
import { createTempDatabase, createTestWorkspaceKey } from '../../../fixtures/tempDatabase';

const NOW = '2026-09-18T13:00:00.000Z';
const REVIEW = '2027-09-18T13:00:00.000Z';
type CatalogRow = { type: string; name: string; sql: string | null };
const catalogOf = (database: AppDatabase) => database.raw.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN('table','index','trigger') AND(type<>'index' OR sql IS NOT NULL) ORDER BY type,name").all() as CatalogRow[];
const manifestOf = (database: AppDatabase) => {
  const actual = database.raw.prepare("SELECT name,type,sql FROM sqlite_master WHERE type IN('table','index','trigger') AND(type<>'index' OR sql IS NOT NULL) ORDER BY name COLLATE BINARY").all() as CatalogRow[];
  return { tables: actual.filter(row => row.type === 'table').map(row => row.name).sort(), indexes: actual.filter(row => row.type === 'index').map(row => row.name).sort(), triggers: actual.filter(row => row.type === 'trigger').map(row => row.name).sort(),
    catalogSha256: createHash('sha256').update(JSON.stringify(actual.map(row => [row.type,row.name,(row.sql ?? '').replace(/\s+/g,' ').trim()]).sort((a,b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))).digest('hex') };
};
const readiness29 = (database: AppDatabase) => assertDomainStorageReady({ database, expectedBusyTimeoutMs: 5000, expectedSchemaVersion: 29, expectedManifest: DOMAIN_SCHEMA_MANIFEST });
const fatalCode = (run: () => unknown) => { try { run(); } catch (error) { return error instanceof DomainStartupFatalError ? error.code : error; } return undefined; };
const insertClearance = (database: AppDatabase, state: string, revision = 1, extra: Partial<{ timezone: string; confirmedAt: string; reviewAt: string; revokedAt: string | null; clearance: string; citation: string }> = {}) =>
  database.raw.prepare('INSERT INTO territory_clearances(state,revision,timezone,clearance_json,citation_json,confirmed_at,review_at,revoked_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(state, revision, extra.timezone ?? 'America/New_York', extra.clearance ?? '{"businessToBusiness":true}', extra.citation ?? '{"title":"t","url":"https://example.invalid/","quote":"q"}',
      extra.confirmedAt ?? NOW, extra.reviewAt ?? REVIEW, extra.revokedAt ?? null);

/** Genuine schema 27 with a real account, a listed route and its Places source, exactly what the fallback later reads. */
async function seedGenuine27(database: AppDatabase, options: { workspaceKey: ReturnType<typeof createTestWorkspaceKey>; backupDirectory: string }) {
  await createMigrationRunner(productionMigrations.filter(entry => entry.schemaVersion <= 27))(database, options);
  expect(assertPreReleaseStorageReady(database).schemaVersion).toBe(27);
  const accounts = new AccountRepository({ database, clock: { now: () => NOW }, ids: { next: randomUUID }, sourcePolicy: { attest: () => true } });
  const account = accounts.create({ commandId: 'c4b0d9a2-4a6b-4a4a-9a1e-6c3f7a7f1a28', name: 'Migration PM', domain: 'migration.example' });
  accounts.admitEvidence({ commandId: 'd0e1f2a3-5b6c-4d7e-8f90-a1b2c3d4e528', accountId: account.id, expectedVersion: 1,
    sources: [{ id: 'place-fictional', url: 'https://places.googleapis.com/v1/places:searchText', fetchedAt: '2026-09-18T12:00:00.000Z', sha256: 'a'.repeat(64),
      excerpt: JSON.stringify({ id: 'fictional', displayName: 'Migration PM', formattedAddress: '380 Broadway, Providence, RI 02909, USA', nationalPhoneNumber: '(401) 555-0100' }), permitted: true }],
    claims: [], routes: [{ id: 'listed-route', accountId: account.id, personId: null, channel: 'phone', value: '+14015550100', purpose: 'business', evidenceIds: ['place-fictional'], verification: 'listed' }] });
  expect(database.raw.prepare("SELECT name FROM sqlite_master WHERE name='territory_clearances'").get()).toBeUndefined();
  return account;
}

it('upgrades genuine27 additively with verified encrypted backup, byte-identical rows and catalog elsewhere, exact29 readiness and reopen', async () => {
  const temp = createTempDatabase(), key = createTestWorkspaceKey();
  const options = { workspaceKey: key, backupDirectory: `${temp.path}.backups` };
  const database = openDatabase({ path: temp.path, key });
  try {
    await seedGenuine27(database, options);
    const catalog = catalogOf(database);
    const tables = catalog.filter(row => row.type === 'table' && !['app_meta','kysely_migration'].includes(row.name)).map(row => row.name);
    const rows = () => tables.map(name => [name, database.raw.prepare(`SELECT * FROM "${name}"`).raw().all()]);
    const original = rows();
    const oldLedger = database.raw.prepare('SELECT * FROM kysely_migration ORDER BY name').all();

    expect(await migrateToLatest(database, options)).toEqual({ fromVersion: 27, toVersion: 29, appliedMigrationIds: ['0028TerritoryClearances', '0029AccountCallbacks'] });

    expect(rows()).toEqual(original);
    expect(database.raw.pragma('foreign_key_check')).toEqual([]);
    // Every schema-27 object keeps its exact SQL; 0028 only adds the clearance table and its two triggers.
    for (const row of catalog) expect(database.raw.prepare('SELECT type,name,sql FROM sqlite_master WHERE type=? AND name=?').get(row.type, row.name)).toEqual(row);
    const added = catalogOf(database).filter(row => !catalog.some(entry => entry.type === row.type && entry.name === row.name)).map(row => [row.type, row.name]);
    // 0029 adds its own callback objects on top of the clearance objects 0028 adds.
    expect(added).toEqual([['index', 'pm_account_callbacks_due'], ['table', 'pm_account_callbacks'], ['table', 'territory_clearances'],
      ['trigger', 'pm_account_callbacks_no_delete'], ['trigger', 'pm_account_callbacks_revision'], ['trigger', 'territory_clearances_no_delete'], ['trigger', 'territory_clearances_revision']]);
    expect(manifestOf(database)).toEqual(DOMAIN_SCHEMA_MANIFEST);
    expect(readiness29(database).schemaVersion).toBe(29);
    expect(assertPreReleaseStorageReady(database).schemaVersion).toBe(29);

    // The table admits one revisioned row per state and refuses what the contract refuses.
    insertClearance(database, 'RI');
    insertClearance(database, 'TX', 1, { timezone: 'America/Chicago' });
    expect(database.raw.prepare('SELECT state,revision,timezone,revoked_at FROM territory_clearances ORDER BY state').all())
      .toEqual([{ state: 'RI', revision: 1, timezone: 'America/New_York', revoked_at: null }, { state: 'TX', revision: 1, timezone: 'America/Chicago', revoked_at: null }]);
    expect(() => insertClearance(database, 'RI', 2)).toThrow(/UNIQUE constraint failed|PRIMARY KEY/);
    expect(() => insertClearance(database, 'ri')).toThrow(/CHECK constraint failed/);
    expect(() => insertClearance(database, 'MA', 0)).toThrow(/CHECK constraint failed/);
    expect(() => insertClearance(database, 'MA', 1, { clearance: 'not json' })).toThrow(/CHECK constraint failed/);
    expect(() => insertClearance(database, 'MA', 1, { reviewAt: NOW })).toThrow(/CHECK constraint failed/);
    expect(() => database.raw.prepare("DELETE FROM territory_clearances WHERE state='RI'").run()).toThrow(/Territory clearance history is immutable/);
    expect(() => database.raw.prepare("UPDATE territory_clearances SET revoked_at=? WHERE state='RI'").run(NOW)).toThrow(/Territory clearance revision is monotonic/);
    expect(() => database.raw.prepare("UPDATE territory_clearances SET revision=3 WHERE state='RI'").run()).toThrow(/Territory clearance revision is monotonic/);
    expect(() => database.raw.prepare("UPDATE territory_clearances SET revision=2,state='MA' WHERE state='RI'").run()).toThrow(/Territory clearance revision is monotonic/);
    database.raw.prepare("UPDATE territory_clearances SET revision=2,revoked_at=? WHERE state='RI'").run(NOW);
    expect(database.raw.prepare("SELECT revision,revoked_at FROM territory_clearances WHERE state='RI'").get()).toEqual({ revision: 2, revoked_at: NOW });

    const backups = readdirSync(options.backupDirectory).filter(name => name.startsWith('pre-migration-schema-27-') && name.endsWith('.sqlite3'));
    expect(backups).toHaveLength(1);
    const path = join(options.backupDirectory, backups[0]);
    const raw = createRawDatabase(path, { readonly: true, fileMustExist: true });
    applyWorkspaceKey(raw, key.bytes); raw.pragma('foreign_keys=ON'); raw.pragma('recursive_triggers=ON'); raw.pragma('busy_timeout=5000');
    const backup = { path, raw, kysely: new Kysely<FoundationDatabase>({ dialect: new SqliteDialect({ database: raw }) }) };
    try { expect(inspectDatabaseEncryption(backup)).toMatchObject({ encrypted: true, integrity: 'ok' });
      expect(raw.prepare('SELECT schema_version FROM app_meta WHERE singleton=1').get()).toEqual({ schema_version: 27 });
      expect(catalogOf(backup)).toEqual(catalog);
      expect(raw.prepare('SELECT * FROM kysely_migration ORDER BY name').all()).toEqual(oldLedger);
      expect(() => backup.raw.prepare('UPDATE pm_accounts SET version=version+1').run()).toThrow(); }
    finally { closeDatabase(backup); }

    closeDatabase(database);
    const reopened = openDatabase({ path: temp.path, key });
    try {
      expect(await migrateToLatest(reopened, options)).toEqual({ fromVersion: 29, toVersion: 29, appliedMigrationIds: [] });
      expect(assertPreReleaseStorageReady(reopened).schemaVersion).toBe(29);
      expect(readiness29(reopened).schemaVersion).toBe(29);
      expect(reopened.raw.prepare('SELECT state,revision FROM territory_clearances ORDER BY state').all()).toEqual([{ state: 'RI', revision: 2 }, { state: 'TX', revision: 1 }]);
    } finally { closeDatabase(reopened); }
  } finally { closeDatabase(database); key.bytes.fill(0); temp.cleanup(); }
});

it.each(['backup', 'migration'] as const)('failed %s leaves genuine27 ledger, catalog and rows unchanged', async failure => {
  const temp = createTempDatabase(), key = createTestWorkspaceKey(), database = openDatabase({ path: temp.path, key });
  const options = { workspaceKey: key, backupDirectory: `${temp.path}.backups` };
  try {
    await seedGenuine27(database, options);
    const before = database.raw.prepare('SELECT * FROM kysely_migration ORDER BY name').all(), catalog = catalogOf(database);
    const routes = database.raw.prepare('SELECT * FROM pm_account_routes ORDER BY rowid').all();
    const actualUp = migration0028TerritoryClearances.up;
    const spy = failure === 'backup' ? vi.spyOn(migrationBackup, 'createVerifiedMigrationBackup').mockImplementation(() => { throw new Error('Injected backup failure'); })
      : vi.spyOn(migration0028TerritoryClearances, 'up').mockImplementation(async db => { await actualUp(db); throw new Error('Injected migration failure'); });
    try { await expect(migrateToLatest(database, options)).rejects.toThrow(); } finally { spy.mockRestore(); }
    expect(database.raw.prepare('SELECT * FROM kysely_migration ORDER BY name').all()).toEqual(before);
    expect(catalogOf(database)).toEqual(catalog);
    expect(database.raw.prepare('SELECT * FROM pm_account_routes ORDER BY rowid').all()).toEqual(routes);
    expect(assertPreReleaseStorageReady(database).schemaVersion).toBe(27);
    expect(database.raw.prepare("SELECT name FROM sqlite_master WHERE name='territory_clearances'").get()).toBeUndefined();
  } finally { closeDatabase(database); key.bytes.fill(0); temp.cleanup(); }
});

it('migrates a fresh encrypted database straight to 29 with an empty clearance table', async () => {
  const temp = createTempDatabase(), key = createTestWorkspaceKey(), database = openDatabase({ path: temp.path, key });
  try {
    const result = await migrateToLatest(database, { workspaceKey: key, backupDirectory: `${temp.path}.backups` });
    expect(result).toMatchObject({ fromVersion: 0, toVersion: 29 });
    expect(result.appliedMigrationIds).toHaveLength(29);
    expect(result.appliedMigrationIds.at(-1)).toBe('0029AccountCallbacks');
    expect(readiness29(database).schemaVersion).toBe(29);
    expect(manifestOf(database)).toEqual(DOMAIN_SCHEMA_MANIFEST);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM territory_clearances').get()).toEqual({ count: 0 });
    expect(database.raw.pragma('foreign_key_check')).toEqual([]);
  } finally { closeDatabase(database); key.bytes.fill(0); temp.cleanup(); }
});

it('historical27 remains independently readable by the backup host, not admitted as current domain schema', async () => {
  const temp = createTempDatabase(), key = createTestWorkspaceKey(), database = openDatabase({ path: temp.path, key });
  try {
    await createMigrationRunner(productionMigrations.filter(entry => entry.schemaVersion <= 27))(database, { workspaceKey: key, backupDirectory: `${temp.path}.backups` });
    expect(manifestOf(database)).toEqual(SCHEMA27_MANIFEST);
    expect(SCHEMA27_MANIFEST.catalogSha256).not.toBe(SCHEMA28_MANIFEST.catalogSha256);
    expect(SCHEMA28_MANIFEST.tables).toEqual([...SCHEMA27_MANIFEST.tables, 'territory_clearances'].sort());
    expect(SCHEMA28_MANIFEST.indexes).toEqual(SCHEMA27_MANIFEST.indexes);
    expect(SCHEMA28_MANIFEST.triggers).toEqual([...SCHEMA27_MANIFEST.triggers, 'territory_clearances_no_delete', 'territory_clearances_revision'].sort());
    expect(assertPreReleaseStorageReady(database).schemaVersion).toBe(27);
    expect(fatalCode(() => readiness29(database))).toBe('schema_not_ready');
    // Even a caller asking for 27 is refused: the current 29-entry ledger rejects the 27 ledger before any manifest comparison.
    expect(fatalCode(() => assertDomainStorageReady({ database, expectedBusyTimeoutMs: 5000, expectedSchemaVersion: 27 as never, expectedManifest: DOMAIN_SCHEMA_MANIFEST }))).toBe('schema_not_ready');
  } finally { closeDatabase(database); key.bytes.fill(0); temp.cleanup(); }
});
