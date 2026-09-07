import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { sql } from 'kysely';
import { performPreReleaseBackup, openExistingPreReleaseDatabase, validateBackupInvocation, validateExistingWorkspacePaths } from '../src/main/backup/preReleaseBackupRuntime';
import { resolveApplicationPaths } from '../src/main/applicationPaths';
import { openDatabase, closeDatabase } from '../src/main/db/database';
import { applyWorkspaceKey, createRawDatabase } from '../src/main/db/sqliteDriver';
import { createMigrationRunner, migrateToLatest, productionMigrations } from '../src/main/db/migrate';
import { BackupService } from '../src/main/backup/backupService';
const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const receipt = { path: '/must-not-print/private.sqlite3', basename: 'pre_release-20260906T170000000Z.sqlite3', kind: 'pre_release', schemaVersion: 17, sha256: 'a'.repeat(64), sizeBytes: 1234, createdAt: '2026-09-06T17:00:00.000Z', verifiedAt: '2026-09-06T17:00:00.000Z' };
function fake({ lock = true, failure = '', output = receipt } = {}) {
  const events = [], key = { bytes: Buffer.alloc(32, 42), version: 1 };
  const step = name => { events.push(name); if (name === failure) throw new Error('PRIVATE-ERROR'); };
  const deps = {
    acquireLock: () => { step('lock'); return lock; }, releaseLock: () => step('unlock'),
    ready: async () => step('ready'), paths: () => { step('paths'); return {}; },
    validatePaths: () => step('validate'), loadKey: async () => { step('key'); return key; },
    open: () => { step('open'); return {}; }, close: () => step('close'),
    service: () => ({ createBackup: async kind => { step(kind); return output; }, shutdown: async () => step('drain') }),
  };
  return { deps, events, key };
}
it('holds the real host lock protocol through drain/close/zero, returning only allowlisted receipt', async () => {
  const { deps, events, key } = fake(); const result = await performPreReleaseBackup(deps);
  expect(events).toEqual(['lock', 'ready', 'paths', 'validate', 'key', 'open', 'pre_release', 'drain', 'close', 'unlock']);
  expect(key.bytes).toEqual(Buffer.alloc(32)); expect(result).toEqual({ basename: receipt.basename, kind: 'pre_release', schemaVersion: 17, sha256: 'a'.repeat(64), sizeBytes: 1234, createdAt: receipt.createdAt, verifiedAt: receipt.verifiedAt });
});
it.each([
  ['schemaVersion', 14], ['schemaVersion', 15], ['schemaVersion', 16], ['schemaVersion', 18], ['schemaVersion', '17'], ['schemaVersion', null], ['schemaVersion', true],
  ['basename', [receipt.basename]], ['basename', 'private/path.sqlite3'], ['kind', 'manual'],
  ['sha256', [receipt.sha256]], ['sha256', 'A'.repeat(64)], ['sizeBytes', '1234'], ['sizeBytes', 0], ['sizeBytes', 1.5],
  ['createdAt', [receipt.createdAt]], ['createdAt', '2026-09-06'], ['verifiedAt', null], ['verifiedAt', 'invalid'],
])('refuses malformed host receipt field %s=%j and still drains, closes, zeroes and unlocks', async (field, value) => {
  const { deps, events, key } = fake({ output: { ...receipt, [field]: value } });
  await expect(performPreReleaseBackup(deps)).rejects.toThrow('PRE_RELEASE_BACKUP_FAILED');
  expect(events.slice(-3)).toEqual(['drain', 'close', 'unlock']); expect(key.bytes).toEqual(Buffer.alloc(32));
});
it('lock refusal performs no key/path/database/copy or unlock work', async () => { const { deps, events } = fake({ lock: false }); await expect(performPreReleaseBackup(deps)).rejects.toThrow(); expect(events).toEqual(['lock']); });
it.each(['ready', 'validate', 'key', 'open', 'pre_release', 'drain', 'close'])('fails safely and releases lock after cleanup when %s fails', async failure => {
  const { deps, events, key } = fake({ failure }); await expect(performPreReleaseBackup(deps)).rejects.toThrow('PRE_RELEASE_BACKUP_FAILED');
  expect(events.at(-1)).toBe('unlock'); if (events.includes('open')) expect(key.bytes).toEqual(Buffer.alloc(32)); if (events.includes('pre_release')) expect(events).toContain('close');
});
it.each([['--database', '/x'], ['--callie-pre-release-backup', '--user-data-dir=/x'], ['--callie-pre-release-backup=1'], ['--use-mock-keychain']])('rejects unsupported main invocation %j', args => { expect(() => validateBackupInvocation(args, {})).toThrow(); });
it.each(['CALLIE_DATABASE_PATH', 'CALLIE_SOURCING_FIXTURE_DIR', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'XDG_CONFIG_HOME'])('rejects bypass environment %s', name => { expect(() => validateBackupInvocation(['--callie-pre-release-backup'], { [name]: 'x' })).toThrow(); });
it('accepts only the exact reserved flag', () => { expect(() => validateBackupInvocation(['--callie-pre-release-backup'], {})).not.toThrow(); });
async function workspace(version = 17) {
  const root = realpathSync(mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), 'backup-existing-'))); roots.push(root); chmodSync(root, 0o700);
  const paths = resolveApplicationPaths(root); const key = { bytes: Buffer.alloc(32, 42), version: 1 };
  const database = openDatabase({ path: paths.databasePath, key });
  try {
    const registry = version === 18 ? [...productionMigrations, { id: '0018SyntheticFuture', schemaVersion: 18,
      migration: { async up(db) { await sql.raw('CREATE TABLE synthetic_future18 (id TEXT PRIMARY KEY)').execute(db);
        await sql.raw('UPDATE app_meta SET schema_version = 18').execute(db); } } }] : productionMigrations.filter(x => x.schemaVersion <= version);
    const migrate = version === 17 ? migrateToLatest : createMigrationRunner(registry);
    await migrate(database, { backupDirectory: paths.backupDirectory, workspaceKey: key });
    expect(database.raw.prepare('SELECT schema_version FROM app_meta').get()).toEqual({ schema_version: version });
    expect(database.raw.prepare('SELECT name FROM kysely_migration ORDER BY timestamp, name').all()).toEqual(registry.map(x => ({ name: x.id })));
    expect(database.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'discovery_assessments'").get() !== undefined).toBe(version >= 17);
    expect(database.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'synthetic_future18'").get() !== undefined).toBe(version === 18);
    expect(database.raw.prepare('PRAGMA table_info(person_contact_methods)').all().some(column => column.name === 'source_label')).toBe(version >= 16);
  } finally { closeDatabase(database); }
  writeFileSync(paths.keyEnvelopePath, 'synthetic-fixture-envelope', { mode: 0o600 });
  return { root, paths, key };
}
it('backs up genuine production17 with one verified copy and same-database linked receipt without migrations or timers', async () => {
  const { paths, key } = await workspace(); const loaded = [];
  const loadKey = async () => { const copy = { bytes: Buffer.from(key.bytes), version: 1 }; loaded.push(copy); return copy; };
  const result = await performPreReleaseBackup({ acquireLock: () => true, releaseLock: () => {}, ready: async () => {}, paths: () => paths,
    loadKey, service: (database) => new BackupService({ databaseGate: { withDatabase: async fn => fn(database) }, backupDirectory: paths.backupDirectory, loadWorkspaceKey: loadKey, clock: { now: () => receipt.createdAt }, ids: { next: () => 'fixture-receipt' } }),
  });
  expect(result.kind).toBe('pre_release'); expect(result.schemaVersion).toBe(17); expect(JSON.stringify(result)).not.toContain(paths.databasePath);
  expect(Object.keys(result).sort()).toEqual(['basename', 'createdAt', 'kind', 'schemaVersion', 'sha256', 'sizeBytes', 'verifiedAt']);
  const copyPath = join(paths.backupDirectory, result.basename); expect(statSync(copyPath).mode & 0o777).toBe(0o600); expect(statSync(paths.backupDirectory).mode & 0o777).toBe(0o700);
  expect(readFileSync(copyPath).subarray(0, 16).toString()).not.toBe('SQLite format 3\0');
  expect(readdirSync(paths.backupDirectory).filter(name => name.startsWith('pre_release-'))).toEqual([result.basename]);
  expect(result.sha256).toBe(createHash('sha256').update(readFileSync(copyPath)).digest('hex')); expect(result.sizeBytes).toBe(statSync(copyPath).size);
  const copy = createRawDatabase(copyPath, { readonly: true, fileMustExist: true });
  try {
    applyWorkspaceKey(copy, key.bytes); copy.pragma('query_only = ON');
    expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(copy.prepare('SELECT schema_version FROM app_meta').get()).toEqual({ schema_version: 17 });
    expect(copy.prepare('SELECT count(*) AS count FROM backup_receipts').get()).toEqual({ count: 0 });
  } finally { copy.close(); }
  expect(createHash('sha256').update(readFileSync(copyPath)).digest('hex')).toBe(result.sha256);
  const db = openExistingPreReleaseDatabase(paths, key);
  try {
    expect(db.raw.prepare('SELECT id, backup_basename, kind, schema_version, sha256, size_bytes, created_at, verified_at FROM backup_receipts').all()).toEqual([
      { id: 'fixture-receipt', backup_basename: result.basename, kind: 'pre_release', schema_version: 17, sha256: result.sha256, size_bytes: result.sizeBytes, created_at: result.createdAt, verified_at: result.verifiedAt },
    ]);
    expect(db.raw.prepare('SELECT schema_version FROM app_meta').get()).toEqual({ schema_version: 17 });
  } finally { closeDatabase(db); key.bytes.fill(0); }
  expect(loaded.every(k => k.bytes.equals(Buffer.alloc(32)))).toBe(true);
});
it.each(['missing', 'wrong-key', 'schema14', 'schema15', 'schema16', 'future18', 'schema16-marker17', 'schema16-marker-ledger17', 'schema15-marker16', 'schema15-marker-ledger16',
  'ledger-missing', 'ledger-extra', 'ledger-wrong', 'ledger-order', 'catalog-column', 'catalog-extra', 'receipt-trigger', 'receipt-trigger-altered', 'recovery-trigger',
])('refuses %s before backup/receipt writes without migration or provisioning', async failure => {
  const version = failure === 'schema14' ? 14 : failure.startsWith('schema15') ? 15 : failure.startsWith('schema16') ? 16 : failure === 'future18' ? 18 : 17;
  const { paths, key } = await workspace(version); const loaded = []; let unlocks = 0;
  try {
    const db = openDatabase({ path: paths.databasePath, key });
    try {
      if (failure.startsWith('schema16-marker')) db.raw.exec('UPDATE app_meta SET schema_version = 17');
      if (failure === 'schema16-marker-ledger17') db.raw.exec("INSERT INTO kysely_migration VALUES ('0017DiscoveryAssessments', '2099-01-01T00:00:00.000Z')");
      if (failure.startsWith('schema15-marker')) db.raw.exec('UPDATE app_meta SET schema_version = 16');
      if (failure === 'schema15-marker-ledger16') db.raw.exec("INSERT INTO kysely_migration VALUES ('0016ContactPresentationEvidence', '2099-01-01T00:00:00.000Z')");
      if (failure === 'ledger-missing') db.raw.exec("DELETE FROM kysely_migration WHERE name = '0017DiscoveryAssessments'");
      if (failure === 'ledger-extra') db.raw.exec("INSERT INTO kysely_migration VALUES ('0018Unknown', '2099-01-01T00:00:00.000Z')");
      if (failure === 'ledger-wrong') db.raw.exec("UPDATE kysely_migration SET name = '0017Wrong' WHERE name = '0017DiscoveryAssessments'");
      if (failure === 'ledger-order') db.raw.exec("UPDATE kysely_migration SET timestamp = '1900-01-01T00:00:00.000Z' WHERE name = '0017DiscoveryAssessments'");
      if (failure === 'catalog-column') db.raw.exec('ALTER TABLE person_contact_methods DROP COLUMN source_label');
      if (failure === 'catalog-extra') db.raw.exec('CREATE TABLE unexpected_catalog (id INTEGER)');
      if (failure.startsWith('receipt-trigger')) db.raw.exec('DROP TRIGGER immutable_backup_receipts');
      if (failure === 'receipt-trigger-altered') db.raw.exec('CREATE TRIGGER immutable_backup_receipts BEFORE UPDATE ON backup_receipts BEGIN SELECT 1; END');
      if (failure === 'recovery-trigger') db.raw.exec('DROP TRIGGER protect_restore_drill_backup_receipt');
    } finally { closeDatabase(db); }
    if (failure === 'missing') rmSync(paths.databasePath);
    const before = existsSync(paths.databasePath) ? readFileSync(paths.databasePath) : null;
    const backups = readdirSync(paths.backupDirectory).sort().map(name => [name, createHash('sha256').update(readFileSync(join(paths.backupDirectory, name))).digest('hex')]);
    await expect(performPreReleaseBackup({ acquireLock: () => true, releaseLock: () => { unlocks++; }, ready: async () => {}, paths: () => paths,
      loadKey: async () => { const copy = { bytes: failure === 'wrong-key' ? Buffer.alloc(32, 41) : Buffer.from(key.bytes), version: 1 }; loaded.push(copy); return copy; },
    })).rejects.toThrow('PRE_RELEASE_BACKUP_FAILED');
    expect(existsSync(paths.databasePath) ? readFileSync(paths.databasePath) : null).toEqual(before);
    expect(readdirSync(paths.backupDirectory).sort().map(name => [name, createHash('sha256').update(readFileSync(join(paths.backupDirectory, name))).digest('hex')])).toEqual(backups);
    expect(unlocks).toBe(1); expect(loaded.every(value => value.bytes.equals(Buffer.alloc(32)))).toBe(true);
    if (before) {
      const checked = openDatabase({ path: paths.databasePath, key });
      try {
        if (version >= 15) expect(checked.raw.prepare('SELECT count(*) AS count FROM backup_receipts').get()).toEqual({ count: 0 });
        else expect(checked.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'backup_receipts'").all()).toEqual([]);
      } finally { closeDatabase(checked); }
    }
  } finally { key.bytes.fill(0); }
});
it.each(['dangling-backups', 'envelope-symlink', 'envelope-mode', 'database-hardlink', 'parent-mode'])('rejects unsafe %s before loading a key', async failure => {
  const { root, paths, key } = await workspace();
  try {
    if (failure === 'dangling-backups') { rmSync(paths.backupDirectory, { recursive: true }); symlinkSync(join(root, 'absent'), paths.backupDirectory); }
    if (failure === 'envelope-symlink') { rmSync(paths.keyEnvelopePath); symlinkSync(join(root, 'absent'), paths.keyEnvelopePath); }
    if (failure === 'envelope-mode') chmodSync(paths.keyEnvelopePath, 0o644);
    if (failure === 'database-hardlink') linkSync(paths.databasePath, join(root, 'alias'));
    if (failure === 'parent-mode') chmodSync(root, 0o755);
    expect(() => validateExistingWorkspacePaths(paths)).toThrow();
  } finally { key.bytes.fill(0); }
});
it('retains a verified synthetic copy when receipt insertion fails and still closes and zeroes keys', async () => {
  const { paths, key } = await workspace(); const loaded = []; let unlocks = 0;
  const loadKey = async () => { const value = { bytes: Buffer.from(key.bytes), version: 1 }; loaded.push(value); return value; };
  let now = '2026-09-06T17:00:00.000Z';
  const deps = { acquireLock: () => true, releaseLock: () => { unlocks++; }, ready: async () => {}, paths: () => paths, loadKey,
    service: database => new BackupService({ databaseGate: { withDatabase: async fn => fn(database) }, backupDirectory: paths.backupDirectory, loadWorkspaceKey: loadKey, clock: { now: () => now }, ids: { next: () => 'duplicate-synthetic-receipt' } }) };
  try {
    await performPreReleaseBackup(deps); now = '2026-09-06T17:00:01.000Z';
    await expect(performPreReleaseBackup(deps)).rejects.toThrow('PRE_RELEASE_BACKUP_FAILED');
    expect(unlocks).toBe(2); expect(loaded.every(value => value.bytes.equals(Buffer.alloc(32)))).toBe(true);
    expect(readdirSync(paths.backupDirectory).filter(name => name.startsWith('pre_release-') && name.endsWith('.sqlite3'))).toHaveLength(2);
    const checked = openExistingPreReleaseDatabase(paths, key);
    try { expect(checked.raw.prepare('SELECT count(*) AS count FROM backup_receipts').get()).toEqual({ count: 1 }); } finally { closeDatabase(checked); }
  } finally { key.bytes.fill(0); }
});
