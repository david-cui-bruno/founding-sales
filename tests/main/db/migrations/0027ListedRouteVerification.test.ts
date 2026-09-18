import { inspectDatabaseEncryption } from '../../../../src/main/db/databaseEncryption';
import { Kysely, SqliteDialect } from 'kysely';
import type { FoundationDatabase } from '../../../../src/main/db/schema';
import { applyWorkspaceKey, createRawDatabase } from '../../../../src/main/db/sqliteDriver';
import * as migrationBackup from '../../../../src/main/db/migrationBackup';
import { migration0027ListedRouteVerification } from '../../../../src/main/db/migrations/0027ListedRouteVerification';
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase, type AppDatabase } from '../../../../src/main/db/database';
import { createMigrationRunner, migrateToLatest, productionMigrations } from '../../../../src/main/db/migrate';
import { assertDomainStorageReady, assertPreReleaseStorageReady, DOMAIN_SCHEMA_MANIFEST, SCHEMA26_MANIFEST, SCHEMA27_MANIFEST } from '../../../../src/main/domain/startup/storageReadiness';
import { DomainStartupFatalError } from '../../../../src/main/domain/startup/domainStartupTypes';
import { AccountRepository } from '../../../../src/main/domain/accounts/accountRepository';
import { createTempDatabase, createTestWorkspaceKey } from '../../../fixtures/tempDatabase';

const NOW = '2026-09-16T18:00:00.000Z';
const CHECK_ERROR = /CHECK constraint failed: verification IN/;
type CatalogRow = { type: string; name: string; sql: string | null };
const catalogOf = (database: AppDatabase) => database.raw.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN('table','index','trigger') AND(type<>'index' OR sql IS NOT NULL) ORDER BY type,name").all() as CatalogRow[];
const manifestOf = (database: AppDatabase) => {
  const actual = database.raw.prepare("SELECT name,type,sql FROM sqlite_master WHERE type IN('table','index','trigger') AND(type<>'index' OR sql IS NOT NULL) ORDER BY name COLLATE BINARY").all() as CatalogRow[];
  return { tables: actual.filter(row => row.type === 'table').map(row => row.name).sort(), indexes: actual.filter(row => row.type === 'index').map(row => row.name).sort(), triggers: actual.filter(row => row.type === 'trigger').map(row => row.name).sort(),
    catalogSha256: createHash('sha256').update(JSON.stringify(actual.map(row => [row.type,row.name,(row.sql ?? '').replace(/\s+/g,' ').trim()]).sort((a,b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))).digest('hex') };
};
const routesOf = (database: AppDatabase) => database.raw.prepare('SELECT rowid AS row_order,* FROM pm_account_routes ORDER BY rowid').all();
const insertRoute = (database: AppDatabase, accountId: string, id: string, version: number, verification: string) =>
  database.raw.prepare('INSERT INTO pm_account_routes(id,account_id,version,person_id,channel,value,purpose,verification,admitted_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, accountId, version, null, 'phone', `+1401555${String(version).padStart(4, '0')}`, 'business', verification, NOW);
const readiness28 = (database: AppDatabase) => assertDomainStorageReady({ database, expectedBusyTimeoutMs: 5000, expectedSchemaVersion: 28, expectedManifest: DOMAIN_SCHEMA_MANIFEST });
const fatalCode = (run: () => unknown) => { try { run(); } catch (error) { return error instanceof DomainStartupFatalError ? error.code : error; } return undefined; };

/** Genuine schema 26 with a real account whose routes carry every historical verification value and child evidence rows. */
async function seedGenuine26(database: AppDatabase, options: { workspaceKey: ReturnType<typeof createTestWorkspaceKey>; backupDirectory: string }) {
  await createMigrationRunner(productionMigrations.filter(entry => entry.schemaVersion <= 26))(database, options);
  expect(assertPreReleaseStorageReady(database).schemaVersion).toBe(26);
  const accounts = new AccountRepository({ database, clock: { now: () => NOW }, ids: { next: randomUUID }, sourcePolicy: { attest: () => true } });
  const account = accounts.create({ commandId: 'c4b0d9a2-4a6b-4a4a-9a1e-6c3f7a7f1a01', name: 'Migration PM', domain: 'migration.example' });
  const route = (id: string, channel: 'phone' | 'email' | 'linkedin', value: string, purpose: 'business' | 'unknown', verification: 'published' | 'confirmed' | 'unverified') =>
    ({ id, accountId: account.id, personId: null as string | null, channel, value, purpose, evidenceIds: ['source'], verification });
  accounts.admitEvidence({ commandId: 'd0e1f2a3-5b6c-4d7e-8f90-a1b2c3d4e5f6', accountId: account.id, expectedVersion: 1,
    sources: [{ id: 'source', url: 'https://migration.example/contact', fetchedAt: '2026-09-16T17:00:00.000Z', sha256: 'a'.repeat(64), excerpt: 'Office: (401) 555-0100, info@migration.example', permitted: true }],
    claims: [{ key: 'technology', kind: 'fact', value: 'Portal', evidenceIds: ['source'] }],
    routes: [route('published-route', 'phone', '+14015550100', 'business', 'published'), route('confirmed-route', 'email', 'info@migration.example', 'business', 'confirmed'),
      route('unverified-route', 'linkedin', 'https://www.linkedin.com/company/migration-pm', 'unknown', 'unverified')] });
  insertRoute(database, account.id, 'published-route', 2, 'confirmed'); // a second route version keeps the composite key exercised
  database.raw.prepare('INSERT INTO delegated_approvals(id,workspace_id,account_id,route_id,route_version,permission_evidence_id,fingerprint,snapshot_json,approved_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('approval', 'workspace', account.id, 'confirmed-route', 1, 'source', 'b'.repeat(64), '{}', NOW);
  expect(database.raw.prepare('SELECT COUNT(*) AS count FROM pm_account_route_evidence').get()).toEqual({ count: 3 });
  expect(routesOf(database)).toHaveLength(4);
  expect(() => insertRoute(database, account.id, 'listed-route', 1, 'listed')).toThrow(CHECK_ERROR);
  return account;
}

it('upgrades genuine26 by rebuilding pm_account_routes with verified encrypted backup, byte-identical rows and catalog elsewhere, exact28 readiness and reopen', async () => {
  const temp = createTempDatabase(), key = createTestWorkspaceKey();
  const options = { workspaceKey: key, backupDirectory: `${temp.path}.backups` };
  const database = openDatabase({ path: temp.path, key });
  try {
    const account = await seedGenuine26(database, options);
    const catalog = catalogOf(database);
    const tables = catalog.filter(row => row.type === 'table' && !['app_meta','kysely_migration'].includes(row.name)).map(row => row.name);
    const rows = () => tables.map(name => [name, database.raw.prepare(`SELECT * FROM "${name}"`).raw().all()]);
    const original = rows(), routes = routesOf(database);
    const children = () => ['pm_account_route_evidence', 'delegated_approvals'].map(name => database.raw.prepare(`SELECT rowid AS row_order,* FROM ${name} ORDER BY rowid`).all());
    const originalChildren = children();
    const oldLedger = database.raw.prepare('SELECT * FROM kysely_migration ORDER BY name').all();
    const oldRoutesSql = catalog.find(row => row.type === 'table' && row.name === 'pm_account_routes')!.sql!;
    expect(oldRoutesSql).toContain("CHECK(verification IN ('published','confirmed','unverified'))");

    expect(await migrateToLatest(database, options)).toEqual({ fromVersion: 26, toVersion: 28, appliedMigrationIds: ['0027ListedRouteVerification', '0028TerritoryClearances'] });

    expect(rows()).toEqual(original);
    expect(routesOf(database)).toEqual(routes);
    expect(children()).toEqual(originalChildren);
    expect(database.raw.pragma('foreign_key_check')).toEqual([]);
    expect(database.raw.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%migration_holding%'").all()).toEqual([]);
    // 0028 adds the territory clearance objects on top; everything 0027 touched is compared object for object below.
    const rebuilt = catalogOf(database).filter(row => !row.name.startsWith('territory_clearances'));
    expect(rebuilt.map(row => [row.type, row.name])).toEqual(catalog.map(row => [row.type, row.name]));
    for (const row of catalog) {
      const after = rebuilt.find(entry => entry.type === row.type && entry.name === row.name);
      if (row.type === 'table' && row.name === 'pm_account_routes') expect(after).toEqual({ ...row, sql: oldRoutesSql.replace("'confirmed','unverified'))", "'confirmed','unverified','listed'))") });
      else expect(after).toEqual(row);
    }
    expect(manifestOf(database)).toEqual(DOMAIN_SCHEMA_MANIFEST);
    expect(readiness28(database).schemaVersion).toBe(28);
    expect(assertPreReleaseStorageReady(database).schemaVersion).toBe(28);

    insertRoute(database, account.id, 'listed-route', 1, 'listed');
    expect(database.raw.prepare("SELECT verification FROM pm_account_routes WHERE id='listed-route'").get()).toEqual({ verification: 'listed' });
    expect(() => insertRoute(database, account.id, 'guessed-route', 1, 'guessed')).toThrow(CHECK_ERROR);
    expect(() => database.raw.prepare("UPDATE pm_account_routes SET value='changed' WHERE id='listed-route'").run()).toThrow(/PM account evidence is immutable/);
    expect(() => database.raw.prepare("DELETE FROM pm_account_routes WHERE id='listed-route'").run()).toThrow(/PM account evidence is immutable/);
    expect(() => insertRoute(database, account.id, 'listed-route', 1, 'listed')).toThrow(/UNIQUE constraint failed/);
    expect(() => database.raw.prepare('INSERT INTO pm_account_route_evidence(account_id,route_id,route_version,source_id) VALUES(?,?,?,?)').run(account.id, 'missing-route', 1, 'source')).toThrow(/FOREIGN KEY constraint failed/);
    database.raw.prepare('INSERT INTO pm_account_route_evidence(account_id,route_id,route_version,source_id) VALUES(?,?,?,?)').run(account.id, 'listed-route', 1, 'source');

    const backups = readdirSync(options.backupDirectory).filter(name => name.startsWith('pre-migration-schema-26-') && name.endsWith('.sqlite3'));
    expect(backups).toHaveLength(1);
    const path = join(options.backupDirectory, backups[0]);
    const raw = createRawDatabase(path, { readonly: true, fileMustExist: true });
    applyWorkspaceKey(raw, key.bytes); raw.pragma('foreign_keys=ON'); raw.pragma('recursive_triggers=ON'); raw.pragma('busy_timeout=5000');
    const backup = { path, raw, kysely: new Kysely<FoundationDatabase>({ dialect: new SqliteDialect({ database: raw }) }) };
    try { expect(inspectDatabaseEncryption(backup)).toMatchObject({ encrypted: true, integrity: 'ok' });
      expect(raw.prepare('SELECT schema_version FROM app_meta WHERE singleton=1').get()).toEqual({ schema_version: 26 });
      expect(catalogOf(backup)).toEqual(catalog);
      expect(raw.prepare('SELECT * FROM kysely_migration ORDER BY name').all()).toEqual(oldLedger);
      expect(routesOf(backup)).toEqual(routes);
      expect(() => backup.raw.prepare('UPDATE pm_accounts SET version=version+1').run()).toThrow(); }
    finally { closeDatabase(backup); }

    closeDatabase(database);
    const reopened = openDatabase({ path: temp.path, key });
    try {
      expect(await migrateToLatest(reopened, options)).toEqual({ fromVersion: 28, toVersion: 28, appliedMigrationIds: [] });
      expect(assertPreReleaseStorageReady(reopened).schemaVersion).toBe(28);
      expect(readiness28(reopened).schemaVersion).toBe(28);
      expect(reopened.raw.prepare("SELECT verification FROM pm_account_routes WHERE id='listed-route'").get()).toEqual({ verification: 'listed' });
    } finally { closeDatabase(reopened); }
  } finally { closeDatabase(database); key.bytes.fill(0); temp.cleanup(); }
});

it.each(['backup', 'migration'] as const)('failed %s leaves genuine26 ledger, catalog, route rows and the old CHECK unchanged', async failure => {
  const temp = createTempDatabase(), key = createTestWorkspaceKey(), database = openDatabase({ path: temp.path, key });
  const options = { workspaceKey: key, backupDirectory: `${temp.path}.backups` };
  try {
    const account = await seedGenuine26(database, options);
    const before = database.raw.prepare('SELECT * FROM kysely_migration ORDER BY name').all(), catalog = catalogOf(database), routes = routesOf(database);
    const actualUp = migration0027ListedRouteVerification.up;
    const spy = failure === 'backup' ? vi.spyOn(migrationBackup, 'createVerifiedMigrationBackup').mockImplementation(() => { throw new Error('Injected backup failure'); })
      : vi.spyOn(migration0027ListedRouteVerification, 'up').mockImplementation(async db => { await actualUp(db); throw new Error('Injected migration failure'); });
    try { await expect(migrateToLatest(database, options)).rejects.toThrow(); } finally { spy.mockRestore(); }
    expect(database.raw.prepare('SELECT * FROM kysely_migration ORDER BY name').all()).toEqual(before);
    expect(catalogOf(database)).toEqual(catalog);
    expect(routesOf(database)).toEqual(routes);
    expect(database.raw.pragma('foreign_key_check')).toEqual([]);
    expect(assertPreReleaseStorageReady(database).schemaVersion).toBe(26);
    expect(() => insertRoute(database, account.id, 'listed-route', 1, 'listed')).toThrow(CHECK_ERROR);
  } finally { closeDatabase(database); key.bytes.fill(0); temp.cleanup(); }
});

it('migrates a fresh encrypted database straight to 28 and admits a listed route', async () => {
  const temp = createTempDatabase(), key = createTestWorkspaceKey(), database = openDatabase({ path: temp.path, key });
  try {
    const result = await migrateToLatest(database, { workspaceKey: key, backupDirectory: `${temp.path}.backups` });
    expect(result).toMatchObject({ fromVersion: 0, toVersion: 28 });
    expect(result.appliedMigrationIds).toHaveLength(28);
    expect(result.appliedMigrationIds.at(-1)).toBe('0028TerritoryClearances');
    expect(readiness28(database).schemaVersion).toBe(28);
    expect(manifestOf(database)).toEqual(DOMAIN_SCHEMA_MANIFEST);
    const accounts = new AccountRepository({ database, clock: { now: () => NOW }, ids: { next: randomUUID }, sourcePolicy: { attest: () => true } });
    const account = accounts.create({ commandId: randomUUID(), name: 'Fresh PM', domain: null });
    insertRoute(database, account.id, 'listed-route', 1, 'listed');
    expect(database.raw.prepare('SELECT verification FROM pm_account_routes').all()).toEqual([{ verification: 'listed' }]);
    expect(database.raw.pragma('foreign_key_check')).toEqual([]);
  } finally { closeDatabase(database); key.bytes.fill(0); temp.cleanup(); }
});

it('historical26 remains independently readable by the backup host, not admitted as current domain schema', async () => {
  const temp = createTempDatabase(), key = createTestWorkspaceKey(), database = openDatabase({ path: temp.path, key });
  try {
    await createMigrationRunner(productionMigrations.filter(entry => entry.schemaVersion <= 26))(database, { workspaceKey: key, backupDirectory: `${temp.path}.backups` });
    expect(manifestOf(database)).toEqual(SCHEMA26_MANIFEST);
    expect(SCHEMA26_MANIFEST).toEqual({ ...SCHEMA27_MANIFEST, catalogSha256: SCHEMA26_MANIFEST.catalogSha256 });
    expect(SCHEMA26_MANIFEST.catalogSha256).not.toBe(DOMAIN_SCHEMA_MANIFEST.catalogSha256);
    expect(assertPreReleaseStorageReady(database).schemaVersion).toBe(26);
    expect(fatalCode(() => readiness28(database))).toBe('schema_not_ready');
    // Even a caller asking for 26 is refused: the current 28-entry ledger rejects the 26 ledger before any manifest comparison.
    expect(fatalCode(() => assertDomainStorageReady({ database, expectedBusyTimeoutMs: 5000, expectedSchemaVersion: 26 as never, expectedManifest: DOMAIN_SCHEMA_MANIFEST }))).toBe('schema_not_ready');
  } finally { closeDatabase(database); key.bytes.fill(0); temp.cleanup(); }
});
