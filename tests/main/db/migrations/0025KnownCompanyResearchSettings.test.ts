import { expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../../../../src/main/db/database';
import { createMigrationRunner, migrateToLatest, productionMigrations } from '../../../../src/main/db/migrate';
import { assertDomainStorageReady, DOMAIN_SCHEMA_MANIFEST } from '../../../../src/main/domain/startup/storageReadiness';
import { createTempDatabase, createTestWorkspaceKey } from '../../../fixtures/tempDatabase';

it('adds only nullable local research and revision0 while preserving genuine24 settings and all other rows', async () => {
  const temp = createTempDatabase(); const key = createTestWorkspaceKey();
  const database = openDatabase({ path: temp.path, key });
  const options = { workspaceKey: key, backupDirectory: `${temp.path}.backups` };
  try {
    await createMigrationRunner(productionMigrations.filter(entry => entry.schemaVersion <= 24))(database, options);
    database.raw.prepare('UPDATE workspace_settings SET timezone=?,daily_dial_capacity=? WHERE singleton=1').run('America/New_York', 17);
    const priorSettings = database.raw.prepare('SELECT * FROM workspace_settings').get();
    const priorLedger = database.raw.prepare('SELECT * FROM kysely_migration ORDER BY name').all();
    const catalog = database.raw.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN('table','index','trigger') AND(type<>'index' OR sql IS NOT NULL) ORDER BY type,name").all() as { type: string; name: string; sql: string }[];
    const tables = catalog.filter(row => row.type === 'table' && !['workspace_settings', 'app_meta', 'kysely_migration'].includes(row.name)).map(row => row.name);
    const rows = () => tables.map(name => [name, database.raw.prepare(`SELECT * FROM "${name}"`).raw().all()]);
    const before = rows();
    expect(await migrateToLatest(database, options)).toEqual({ fromVersion: 24, toVersion: 25, appliedMigrationIds: ['0025KnownCompanyResearchSettings'] });
    expect(database.raw.prepare('SELECT * FROM workspace_settings').get()).toEqual({ ...priorSettings as object, known_company_research_json: null, known_company_research_revision: 0 });
    expect(rows()).toEqual(before);
    expect(database.raw.prepare("SELECT * FROM kysely_migration WHERE name <> '0025KnownCompanyResearchSettings' ORDER BY name").all()).toEqual(priorLedger);
    for (const original of catalog.filter(row => row.name !== 'workspace_settings')) expect(database.raw.prepare('SELECT type,name,sql FROM sqlite_master WHERE name=?').get(original.name)).toEqual(original);
    expect(assertDomainStorageReady({ database, expectedBusyTimeoutMs: 5000, expectedSchemaVersion: 25, expectedManifest: DOMAIN_SCHEMA_MANIFEST }).schemaVersion).toBe(25);
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => database.raw.prepare('UPDATE workspace_settings SET known_company_research_revision=?').run(value)).toThrow();
    for (const value of ['bad', '[]', 'null', '1']) expect(() => database.raw.prepare('UPDATE workspace_settings SET known_company_research_json=?').run(value)).toThrow();
    closeDatabase(database);
    const reopened = openDatabase({ path: temp.path, key });
    try {
      expect(await migrateToLatest(reopened, options)).toEqual({ fromVersion: 25, toVersion: 25, appliedMigrationIds: [] });
      expect(reopened.raw.prepare('SELECT * FROM workspace_settings').get()).toEqual({ ...priorSettings as object, known_company_research_json: null, known_company_research_revision: 0 });
      expect(reopened.raw.pragma('foreign_key_check')).toEqual([]);
    } finally { closeDatabase(reopened); }
  } finally { closeDatabase(database); key.bytes.fill(0); temp.cleanup(); }
});
