import { inspectDatabaseEncryption } from '../../../../src/main/db/databaseEncryption';
import { Kysely, SqliteDialect } from 'kysely';
import type { FoundationDatabase } from '../../../../src/main/db/schema';
import { applyWorkspaceKey, createRawDatabase } from '../../../../src/main/db/sqliteDriver';
import * as migrationBackup from '../../../../src/main/db/migrationBackup';
import { migration0030EmailTemplates } from '../../../../src/main/db/migrations/0030EmailTemplates';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase, type AppDatabase } from '../../../../src/main/db/database';
import { createMigrationRunner, migrateToLatest, productionMigrations } from '../../../../src/main/db/migrate';
import { assertDomainStorageReady, assertPreReleaseStorageReady, DOMAIN_SCHEMA_MANIFEST, SCHEMA29_MANIFEST } from '../../../../src/main/domain/startup/storageReadiness';
import { DomainStartupFatalError } from '../../../../src/main/domain/startup/domainStartupTypes';
import { REPLY_TEMPLATE_SEEDS, REPLY_TEMPLATE_SEED_HASHES, seededReplyTemplateHash } from '../../../../src/main/outreach/templates/replyTemplateSeeds';
import { replyTemplateContentHash } from '../../../../src/shared/contracts/replyTemplateContract';
import { createTempDatabase, createTestWorkspaceKey } from '../../../fixtures/tempDatabase';

type CatalogRow = { type: string; name: string; sql: string | null };
const catalogOf = (database: AppDatabase) => database.raw.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN('table','index','trigger') AND(type<>'index' OR sql IS NOT NULL) ORDER BY type,name").all() as CatalogRow[];
const manifestOf = (database: AppDatabase) => {
  const actual = database.raw.prepare("SELECT name,type,sql FROM sqlite_master WHERE type IN('table','index','trigger') AND(type<>'index' OR sql IS NOT NULL) ORDER BY name COLLATE BINARY").all() as CatalogRow[];
  return { tables: actual.filter(row => row.type === 'table').map(row => row.name).sort(), indexes: actual.filter(row => row.type === 'index').map(row => row.name).sort(), triggers: actual.filter(row => row.type === 'trigger').map(row => row.name).sort(),
    catalogSha256: createHash('sha256').update(JSON.stringify(actual.map(row => [row.type, row.name, (row.sql ?? '').replace(/\s+/g, ' ').trim()]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))).digest('hex') };
};
const readiness30 = (database: AppDatabase) => assertDomainStorageReady({ database, expectedBusyTimeoutMs: 5000, expectedSchemaVersion: 30, expectedManifest: DOMAIN_SCHEMA_MANIFEST });
const fatalCode = (run: () => unknown) => { try { run(); } catch (error) { return error instanceof DomainStartupFatalError ? error.code : error; } return undefined; };
const templateRows = (database: AppDatabase) => database.raw.prepare('SELECT id,name,purpose,subject,body,variables_json,revision,approval_state,approved_revision,approved_at,content_hash FROM email_templates ORDER BY id').all() as {
  id: string; name: string; purpose: string; subject: string; body: string; variables_json: string; revision: number;
  approval_state: string; approved_revision: number | null; approved_at: string | null; content_hash: string | null;
}[];

/** Genuine schema 29, exactly what the template rows are added beside. */
async function seedGenuine29(database: AppDatabase, options: { workspaceKey: ReturnType<typeof createTestWorkspaceKey>; backupDirectory: string }) {
  await createMigrationRunner(productionMigrations.filter(entry => entry.schemaVersion <= 29))(database, options);
  expect(assertPreReleaseStorageReady(database).schemaVersion).toBe(29);
  expect(database.raw.prepare("SELECT name FROM sqlite_master WHERE name='email_templates'").get()).toBeUndefined();
}

it('upgrades genuine29 additively with verified encrypted backup, byte-identical rows and catalog elsewhere, exact30 readiness and reopen', async () => {
  const temp = createTempDatabase(), key = createTestWorkspaceKey();
  const options = { workspaceKey: key, backupDirectory: `${temp.path}.backups` };
  const database = openDatabase({ path: temp.path, key });
  try {
    await seedGenuine29(database, options);
    const catalog = catalogOf(database);
    const tables = catalog.filter(row => row.type === 'table' && !['app_meta', 'kysely_migration'].includes(row.name)).map(row => row.name);
    const rows = () => tables.map(name => [name, database.raw.prepare(`SELECT * FROM "${name}"`).raw().all()]);
    const original = rows();
    const oldLedger = database.raw.prepare('SELECT * FROM kysely_migration ORDER BY name').all();

    expect(await migrateToLatest(database, options)).toEqual({ fromVersion: 29, toVersion: 30, appliedMigrationIds: ['0030EmailTemplates'] });

    expect(rows()).toEqual(original);
    expect(database.raw.pragma('foreign_key_check')).toEqual([]);
    // Every schema-29 object keeps its exact SQL: 0030 creates two tables and four triggers and alters nothing.
    for (const row of catalog) expect(database.raw.prepare('SELECT type,name,sql FROM sqlite_master WHERE type=? AND name=?').get(row.type, row.name)).toEqual(row);
    const added = catalogOf(database).filter(row => !catalog.some(entry => entry.type === row.type && entry.name === row.name)).map(row => [row.type, row.name]);
    expect(added).toEqual([['table', 'email_template_settings'], ['table', 'email_templates'],
      ['trigger', 'email_template_settings_no_delete'], ['trigger', 'email_template_settings_revision'],
      ['trigger', 'email_templates_no_delete'], ['trigger', 'email_templates_revision']]);
    expect(manifestOf(database)).toEqual(DOMAIN_SCHEMA_MANIFEST);
    expect(readiness30(database).schemaVersion).toBe(30);
    expect(assertPreReleaseStorageReady(database).schemaVersion).toBe(30);

    // Exactly five drafts with the exact text of the 17 September templates file, and nothing approved.
    const seeded = templateRows(database);
    expect(seeded.map(row => row.id)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
    expect(seeded.map(row => row.approval_state)).toEqual(['draft', 'draft', 'draft', 'draft', 'draft']);
    expect(seeded.map(row => row.revision)).toEqual([1, 1, 1, 1, 1]);
    expect(seeded.flatMap(row => [row.approved_revision, row.approved_at, row.content_hash])).toEqual(Array.from({ length: 15 }, () => null));
    for (const seed of REPLY_TEMPLATE_SEEDS) {
      const row = seeded.find(entry => entry.id === seed.id)!;
      expect({ subject: row.subject, body: row.body, name: row.name, purpose: row.purpose }).toEqual({ subject: seed.subject, body: seed.body, name: seed.name, purpose: seed.purpose });
      expect(JSON.parse(row.variables_json)).toEqual([...seed.variables]);
      expect(replyTemplateContentHash(row)).toBe(REPLY_TEMPLATE_SEED_HASHES[seed.id]);
      expect(seededReplyTemplateHash(seed.id)).toBe(REPLY_TEMPLATE_SEED_HASHES[seed.id]);
    }
    expect(database.raw.prepare('SELECT singleton,paused,revision FROM email_template_settings').all()).toEqual([{ singleton: 1, paused: 0, revision: 1 }]);

    // The table refuses what the contract refuses, and history is immutable.
    const insert = (id: string, extra: Partial<{ purpose: string; revision: number; state: string; approvedRevision: number | null; approvedAt: string | null; contentHash: string | null }> = {}) =>
      database.raw.prepare('INSERT INTO email_templates(id,name,purpose,subject,body,variables_json,revision,approval_state,approved_revision,approved_at,content_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, 'Name', extra.purpose ?? 'missed_you', 'Subject', 'Body', '[]', extra.revision ?? 1, extra.state ?? 'draft',
          extra.approvedRevision ?? null, extra.approvedAt ?? null, extra.contentHash ?? null, '2026-09-18T12:00:00.000Z', '2026-09-18T12:00:00.000Z');
    expect(() => insert('T6')).toThrow(/CHECK constraint failed/);
    expect(() => insert('T1')).toThrow(/UNIQUE constraint failed|PRIMARY KEY/);
    expect(() => insert('T6', { purpose: 'something_else' })).toThrow(/CHECK constraint failed/);
    // Approved without a revision, hash or instant, and approved beyond the current revision, are all refused.
    expect(() => database.raw.prepare("UPDATE email_templates SET revision=1,approval_state='approved' WHERE id='T1'").run()).toThrow(/CHECK constraint failed/);
    expect(() => database.raw.prepare("UPDATE email_templates SET revision=1,approval_state='approved',approved_revision=2,approved_at='2026-09-18T12:00:00.000Z',content_hash=? WHERE id='T1'").run('a'.repeat(64))).toThrow(/CHECK constraint failed/);
    expect(() => database.raw.prepare("UPDATE email_templates SET revision=1,approval_state='approved',approved_revision=1,approved_at='2026-09-18T12:00:00.000Z',content_hash='NOTAHASH' WHERE id='T1'").run()).toThrow(/CHECK constraint failed/);
    expect(() => database.raw.prepare("DELETE FROM email_templates WHERE id='T1'").run()).toThrow(/Email template history is immutable/);
    expect(() => database.raw.prepare("UPDATE email_templates SET revision=3 WHERE id='T1'").run()).toThrow(/Email template revision is monotonic/);
    expect(() => database.raw.prepare("UPDATE email_templates SET revision=1,purpose='last_note' WHERE id='T1'").run()).toThrow(/Email template revision is monotonic/);
    // Same revision may only change the approval, never the text.
    expect(() => database.raw.prepare("UPDATE email_templates SET revision=1,body='Other' WHERE id='T1'").run()).toThrow(/Email template revision is monotonic/);
    database.raw.prepare("UPDATE email_templates SET revision=1,approval_state='approved',approved_revision=1,approved_at='2026-09-18T12:00:00.000Z',content_hash=?,updated_at='2026-09-18T12:00:00.000Z' WHERE id='T1'").run(REPLY_TEMPLATE_SEED_HASHES.T1);
    expect(templateRows(database)[0]).toMatchObject({ id: 'T1', revision: 1, approval_state: 'approved', approved_revision: 1, content_hash: REPLY_TEMPLATE_SEED_HASHES.T1 });
    // An edit bumps the revision by exactly one and may return the row to revoked in the same statement.
    database.raw.prepare("UPDATE email_templates SET revision=2,subject='Edited, {firm}',approval_state='revoked',approved_revision=NULL,approved_at=NULL,content_hash=NULL,updated_at='2026-09-18T13:00:00.000Z' WHERE id='T1'").run();
    expect(templateRows(database)[0]).toMatchObject({ id: 'T1', revision: 2, approval_state: 'revoked', approved_revision: null, content_hash: null });
    expect(() => database.raw.prepare('DELETE FROM email_template_settings WHERE singleton=1').run()).toThrow(/Email template settings history is immutable/);
    expect(() => database.raw.prepare('UPDATE email_template_settings SET paused=1 WHERE singleton=1').run()).toThrow(/Email template settings revision is monotonic/);
    database.raw.prepare("UPDATE email_template_settings SET paused=1,revision=2,updated_at='2026-09-18T13:00:00.000Z' WHERE singleton=1").run();
    expect(database.raw.prepare('SELECT paused,revision FROM email_template_settings').get()).toEqual({ paused: 1, revision: 2 });

    const backups = readdirSync(options.backupDirectory).filter(name => name.startsWith('pre-migration-schema-29-') && name.endsWith('.sqlite3'));
    expect(backups).toHaveLength(1);
    const path = join(options.backupDirectory, backups[0]!);
    const raw = createRawDatabase(path, { readonly: true, fileMustExist: true });
    applyWorkspaceKey(raw, key.bytes); raw.pragma('foreign_keys=ON'); raw.pragma('recursive_triggers=ON'); raw.pragma('busy_timeout=5000');
    const backup = { path, raw, kysely: new Kysely<FoundationDatabase>({ dialect: new SqliteDialect({ database: raw }) }) };
    try {
      expect(inspectDatabaseEncryption(backup)).toMatchObject({ encrypted: true, integrity: 'ok' });
      expect(raw.prepare('SELECT schema_version FROM app_meta WHERE singleton=1').get()).toEqual({ schema_version: 29 });
      expect(catalogOf(backup)).toEqual(catalog);
      expect(raw.prepare('SELECT * FROM kysely_migration ORDER BY name').all()).toEqual(oldLedger);
    } finally { closeDatabase(backup); }

    closeDatabase(database);
    const reopened = openDatabase({ path: temp.path, key });
    try {
      expect(await migrateToLatest(reopened, options)).toEqual({ fromVersion: 30, toVersion: 30, appliedMigrationIds: [] });
      expect(assertPreReleaseStorageReady(reopened).schemaVersion).toBe(30);
      expect(readiness30(reopened).schemaVersion).toBe(30);
      expect(reopened.raw.prepare('SELECT id,revision,approval_state FROM email_templates ORDER BY id').all())
        .toEqual([{ id: 'T1', revision: 2, approval_state: 'revoked' }, { id: 'T2', revision: 1, approval_state: 'draft' },
          { id: 'T3', revision: 1, approval_state: 'draft' }, { id: 'T4', revision: 1, approval_state: 'draft' }, { id: 'T5', revision: 1, approval_state: 'draft' }]);
    } finally { closeDatabase(reopened); }
  } finally { closeDatabase(database); key.bytes.fill(0); temp.cleanup(); }
});

it.each(['backup', 'migration'] as const)('failed %s leaves genuine29 ledger, catalog and rows unchanged', async failure => {
  const temp = createTempDatabase(), key = createTestWorkspaceKey(), database = openDatabase({ path: temp.path, key });
  const options = { workspaceKey: key, backupDirectory: `${temp.path}.backups` };
  try {
    await seedGenuine29(database, options);
    const before = database.raw.prepare('SELECT * FROM kysely_migration ORDER BY name').all(), catalog = catalogOf(database);
    const actualUp = migration0030EmailTemplates.up;
    const spy = failure === 'backup' ? vi.spyOn(migrationBackup, 'createVerifiedMigrationBackup').mockImplementation(() => { throw new Error('Injected backup failure'); })
      : vi.spyOn(migration0030EmailTemplates, 'up').mockImplementation(async db => { await actualUp(db); throw new Error('Injected migration failure'); });
    try { await expect(migrateToLatest(database, options)).rejects.toThrow(); } finally { spy.mockRestore(); }
    expect(database.raw.prepare('SELECT * FROM kysely_migration ORDER BY name').all()).toEqual(before);
    expect(catalogOf(database)).toEqual(catalog);
    expect(assertPreReleaseStorageReady(database).schemaVersion).toBe(29);
    expect(database.raw.prepare("SELECT name FROM sqlite_master WHERE name='email_templates'").get()).toBeUndefined();
  } finally { closeDatabase(database); key.bytes.fill(0); temp.cleanup(); }
});

it('migrates a fresh encrypted database straight to 30 with the five seeded drafts', async () => {
  const temp = createTempDatabase(), key = createTestWorkspaceKey(), database = openDatabase({ path: temp.path, key });
  try {
    const result = await migrateToLatest(database, { workspaceKey: key, backupDirectory: `${temp.path}.backups` });
    expect(result).toMatchObject({ fromVersion: 0, toVersion: 30 });
    expect(result.appliedMigrationIds).toHaveLength(30);
    expect(result.appliedMigrationIds.at(-1)).toBe('0030EmailTemplates');
    expect(manifestOf(database)).toEqual(DOMAIN_SCHEMA_MANIFEST);
    expect(readiness30(database).schemaVersion).toBe(30);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM email_templates').get()).toEqual({ count: 5 });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM email_templates WHERE approval_state='draft'").get()).toEqual({ count: 5 });
    expect(database.raw.pragma('foreign_key_check')).toEqual([]);
  } finally { closeDatabase(database); key.bytes.fill(0); temp.cleanup(); }
});

it('historical29 remains independently readable by the backup host, not admitted as current domain schema', async () => {
  const temp = createTempDatabase(), key = createTestWorkspaceKey(), database = openDatabase({ path: temp.path, key });
  try {
    await createMigrationRunner(productionMigrations.filter(entry => entry.schemaVersion <= 29))(database, { workspaceKey: key, backupDirectory: `${temp.path}.backups` });
    expect(manifestOf(database)).toEqual(SCHEMA29_MANIFEST);
    expect(SCHEMA29_MANIFEST.catalogSha256).not.toBe(DOMAIN_SCHEMA_MANIFEST.catalogSha256);
    expect(DOMAIN_SCHEMA_MANIFEST.tables).toEqual([...SCHEMA29_MANIFEST.tables, 'email_templates', 'email_template_settings'].sort());
    expect(DOMAIN_SCHEMA_MANIFEST.indexes).toEqual(SCHEMA29_MANIFEST.indexes);
    expect(DOMAIN_SCHEMA_MANIFEST.triggers).toEqual([...SCHEMA29_MANIFEST.triggers, 'email_templates_no_delete', 'email_templates_revision',
      'email_template_settings_no_delete', 'email_template_settings_revision'].sort());
    expect(assertPreReleaseStorageReady(database).schemaVersion).toBe(29);
    expect(fatalCode(() => readiness30(database))).toBe('schema_not_ready');
    // Even a caller asking for 29 is refused: the current 30-entry ledger rejects the 29 ledger before any manifest comparison.
    expect(fatalCode(() => assertDomainStorageReady({ database, expectedBusyTimeoutMs: 5000, expectedSchemaVersion: 29 as never, expectedManifest: DOMAIN_SCHEMA_MANIFEST }))).toBe('schema_not_ready');
  } finally { closeDatabase(database); key.bytes.fill(0); temp.cleanup(); }
});
