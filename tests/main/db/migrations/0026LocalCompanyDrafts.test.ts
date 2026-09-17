import { inspectDatabaseEncryption } from '../../../../src/main/db/databaseEncryption';
import { Kysely, SqliteDialect } from 'kysely';
import type { FoundationDatabase } from '../../../../src/main/db/schema';
import { applyWorkspaceKey, createRawDatabase } from '../../../../src/main/db/sqliteDriver';
import * as migrationBackup from '../../../../src/main/db/migrationBackup';
import { migration0026LocalCompanyDrafts } from '../../../../src/main/db/migrations/0026LocalCompanyDrafts';
import { EmailRepository } from '../../../../src/main/outreach/emailRepository';
import { seedProspect, insertOpenCycleWithAction } from '../../../fixtures/domainRows';
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../../../../src/main/db/database';
import { createMigrationRunner, migrateToLatest, productionMigrations } from '../../../../src/main/db/migrate';
import { assertDomainStorageReady, assertPreReleaseStorageReady, DOMAIN_SCHEMA_MANIFEST } from '../../../../src/main/domain/startup/storageReadiness';
import { AccountRepository } from '../../../../src/main/domain/accounts/accountRepository';
import { createTempDatabase, createTestWorkspaceKey } from '../../../fixtures/tempDatabase';
it('upgrades genuine25 additively with verified encrypted backup, preserves rows, exact27 readiness and reopen', async () => {
  const temp = createTempDatabase(), key = createTestWorkspaceKey();
  const options = { workspaceKey: key, backupDirectory: `${temp.path}.backups` };
  const database = openDatabase({ path: temp.path, key });
  try {
    await createMigrationRunner(productionMigrations.filter(entry => entry.schemaVersion <= 25))(database, options);
    expect(assertPreReleaseStorageReady(database).schemaVersion).toBe(25);
    const accounts = new AccountRepository({ database, clock: { now: () => '2026-09-15T18:00:00.000Z' }, ids: { next: randomUUID }, sourcePolicy: { attest: () => true } });
    const account = accounts.create({ commandId: '64762c35-f3e9-4658-82e7-57e26ad91d96', name: 'Migration PM', domain: 'migration.example' });
    accounts.admitEvidence({ commandId: '0b25fddd-d9de-409f-9e59-52b037f23724', accountId: account.id, expectedVersion: 1,
      sources: [{ id: 'source', url: 'https://migration.example/', fetchedAt: '2026-09-15T17:00:00.000Z', sha256: 'a'.repeat(64), excerpt: 'Business email: info@migration.example', permitted: true }],
      claims: [{ key: 'technology', kind: 'fact', value: 'Portal', evidenceIds: ['source'] },
        { key: 'residential_scope', kind: 'fact', value: 'Residential', evidenceIds: ['source'] },
        { key: 'operating_footprint', kind: 'fact', value: 'Rhode Island', evidenceIds: ['source'] },
        { key: 'maintenance_workflow', kind: 'fact', value: 'Coordinates maintenance', evidenceIds: ['source'] }], routes: [] });
    const prospect = seedProspect(database.raw, 'preserved');
    const cycle = insertOpenCycleWithAction({ database: database.raw, prefix: 'preserved', prospect });
    database.raw.prepare(`INSERT INTO person_contact_methods(id,person_id,kind,normalized_value,validation_state,reachability,created_at,updated_at)
      VALUES('legacy-email',?,'email','person@migration.example','valid','direct',?,?)`).run(prospect.personId, '2026-09-15T18:00:00.000Z', '2026-09-15T18:00:00.000Z');
    const legacy = new EmailRepository(database);
    legacy.create({ id: 'preserved-draft', personId: prospect.personId, salesCycleId: cycle.cycleId, contactMethodId: 'legacy-email',
      recipient: 'person@migration.example', contactSnapshot: 'b'.repeat(64), accountEmail: null, footer: '', updatedAt: '2026-09-15T18:00:00.000Z' });
    legacy.save({ draftId: 'preserved-draft', expectedRevision: 1, subject: 'Existing person draft', body: 'Preserved exact person text\n' }, '2026-09-15T18:00:00.000Z');
    const catalog = database.raw.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN('table','index','trigger') AND(type<>'index' OR sql IS NOT NULL) ORDER BY type,name").all() as { type: string; name: string; sql: string }[];
    const tables = catalog.filter(row => row.type === 'table' && !['app_meta','kysely_migration'].includes(row.name)).map(row => row.name);
    const rows = () => tables.map(name => [name, database.raw.prepare(`SELECT * FROM "${name}"`).raw().all()]);
    const original = rows();
    const oldLedger = database.raw.prepare('SELECT * FROM kysely_migration ORDER BY name').all();
    expect(await migrateToLatest(database, options)).toEqual({ fromVersion: 25, toVersion: 27, appliedMigrationIds: ['0026LocalCompanyDrafts', '0027ListedRouteVerification'] });
    expect(rows()).toEqual(original);
    // 0027 rebuilds pm_account_routes (its CHECK admits 'listed'); every other schema-25 object keeps its exact SQL.
    for (const row of catalog.filter(entry => entry.name !== 'pm_account_routes')) expect(database.raw.prepare('SELECT type,name,sql FROM sqlite_master WHERE name=?').get(row.name)).toEqual(row);
    const actual = database.raw.prepare("SELECT name,type,sql FROM sqlite_master WHERE type IN('table','index','trigger') AND(type<>'index' OR sql IS NOT NULL) ORDER BY name COLLATE BINARY").all() as { name: string; type: string; sql: string | null }[];
    const manifest = { tables: actual.filter(row => row.type === 'table').map(row => row.name).sort(), indexes: actual.filter(row => row.type === 'index').map(row => row.name).sort(), triggers: actual.filter(row => row.type === 'trigger').map(row => row.name).sort(),
      catalogSha256: createHash('sha256').update(JSON.stringify(actual.map(row => [row.type,row.name,(row.sql ?? '').replace(/\s+/g,' ').trim()]).sort((a,b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))).digest('hex') };
    expect(manifest).toEqual(DOMAIN_SCHEMA_MANIFEST);
    expect(assertDomainStorageReady({ database, expectedBusyTimeoutMs: 5000, expectedSchemaVersion: 27, expectedManifest: DOMAIN_SCHEMA_MANIFEST }).schemaVersion).toBe(27);
    const backups = readdirSync(options.backupDirectory).filter(name => name.startsWith('pre-migration-schema-25-') && name.endsWith('.sqlite3'));
    expect(backups).toHaveLength(1);
    const path = join(options.backupDirectory, backups[0]);
    const raw = createRawDatabase(path, { readonly: true, fileMustExist: true });
    applyWorkspaceKey(raw, key.bytes); raw.pragma('foreign_keys=ON'); raw.pragma('recursive_triggers=ON'); raw.pragma('busy_timeout=5000');
    const backup = { path, raw, kysely: new Kysely<FoundationDatabase>({ dialect: new SqliteDialect({ database: raw }) }) };
    try { expect(inspectDatabaseEncryption(backup)).toMatchObject({ encrypted: true, integrity: 'ok' });
      expect(raw.prepare('SELECT schema_version FROM app_meta WHERE singleton=1').get()).toEqual({ schema_version: 25 });
      expect(raw.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN('table','index','trigger') AND(type<>'index' OR sql IS NOT NULL) ORDER BY type,name").all()).toEqual(catalog);
      expect(raw.prepare('SELECT * FROM kysely_migration ORDER BY name').all()).toEqual(oldLedger); expect(backup.raw.prepare('SELECT * FROM pm_accounts').all()).toEqual(database.raw.prepare('SELECT * FROM pm_accounts').all());
      expect(backup.raw.prepare('SELECT * FROM email_drafts').all()).toEqual(database.raw.prepare('SELECT * FROM email_drafts').all());
      expect(() => backup.raw.prepare('UPDATE pm_accounts SET version=version+1').run()).toThrow(); }
    finally { closeDatabase(backup); }
    closeDatabase(database);
    const reopened = openDatabase({ path: temp.path, key });
    try {
      expect(await migrateToLatest(reopened, options)).toEqual({ fromVersion: 27, toVersion: 27, appliedMigrationIds: [] });
      expect(assertPreReleaseStorageReady(reopened).schemaVersion).toBe(27);
    } finally { closeDatabase(reopened); }
  } finally { closeDatabase(database); key.bytes.fill(0); temp.cleanup(); }
});

it.each(['backup', 'migration'] as const)('failed %s leaves genuine25 ledger, catalog and business rows unchanged', async failure => {
  const temp = createTempDatabase(), key = createTestWorkspaceKey(), database = openDatabase({ path: temp.path, key });
  const options = { workspaceKey: key, backupDirectory: `${temp.path}.backups` };
  try {
    await createMigrationRunner(productionMigrations.filter(entry => entry.schemaVersion <= 25))(database, options);
    const before = database.raw.prepare('SELECT * FROM kysely_migration ORDER BY name').all();
    const actualUp = migration0026LocalCompanyDrafts.up;
    const spy = failure === 'backup' ? vi.spyOn(migrationBackup, 'createVerifiedMigrationBackup').mockImplementation(() => { throw new Error('Injected backup failure'); })
      : vi.spyOn(migration0026LocalCompanyDrafts, 'up').mockImplementation(async db => { await actualUp(db); throw new Error('Injected migration failure'); });
    try { await expect(migrateToLatest(database, options)).rejects.toThrow(); } finally { spy.mockRestore(); }
    expect(database.raw.prepare('SELECT * FROM kysely_migration ORDER BY name').all()).toEqual(before);
    expect(assertPreReleaseStorageReady(database).schemaVersion).toBe(25);
    expect(database.raw.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'local_company_%'").all()).toEqual([]);
  } finally { closeDatabase(database); key.bytes.fill(0); temp.cleanup(); }
});
it('historical24 remains independently readable, not admitted as current domain schema', async () => {
  const temp = createTempDatabase(), key = createTestWorkspaceKey(), database = openDatabase({ path: temp.path, key });
  try {
    await createMigrationRunner(productionMigrations.slice(0,24))(database, { workspaceKey: key, backupDirectory: `${temp.path}.backups` });
    expect(assertPreReleaseStorageReady(database).schemaVersion).toBe(24);
    expect(() => assertDomainStorageReady({ database, expectedBusyTimeoutMs: 5000, expectedSchemaVersion: 27, expectedManifest: DOMAIN_SCHEMA_MANIFEST })).toThrow();
  } finally { closeDatabase(database); key.bytes.fill(0); temp.cleanup(); }
});
