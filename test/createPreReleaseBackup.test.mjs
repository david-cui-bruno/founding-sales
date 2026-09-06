import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { performPreReleaseBackup, openExistingPreReleaseDatabase, validateBackupInvocation, validateExistingWorkspacePaths } from '../src/main/backup/preReleaseBackupRuntime';
import { resolveApplicationPaths } from '../src/main/applicationPaths';
import { openDatabase, closeDatabase } from '../src/main/db/database';
import { migrateToLatest } from '../src/main/db/migrate';
import { BackupService } from '../src/main/backup/backupService';
const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const receipt = { path: '/must-not-print/private.sqlite3', basename: 'pre_release-20260906T170000000Z.sqlite3', kind: 'pre_release', schemaVersion: 15, sha256: 'a'.repeat(64), sizeBytes: 1234, createdAt: '2026-09-06T17:00:00.000Z', verifiedAt: '2026-09-06T17:00:00.000Z' };
function fake({ lock = true, failure = '' } = {}) {
  const events = [], key = { bytes: Buffer.alloc(32, 42), version: 1 };
  const step = name => { events.push(name); if (name === failure) throw new Error('PRIVATE-ERROR'); };
  const deps = {
    acquireLock: () => { step('lock'); return lock; }, releaseLock: () => step('unlock'),
    ready: async () => step('ready'), paths: () => { step('paths'); return {}; },
    validatePaths: () => step('validate'), loadKey: async () => { step('key'); return key; },
    open: () => { step('open'); return {}; }, close: () => step('close'),
    service: () => ({ createBackup: async kind => { step(kind); return receipt; }, shutdown: async () => step('drain') }),
  };
  return { deps, events, key };
}
it('holds the real host lock protocol through drain/close/zero, returning only allowlisted receipt', async () => {
  const { deps, events, key } = fake(); const result = await performPreReleaseBackup(deps);
  expect(events).toEqual(['lock', 'ready', 'paths', 'validate', 'key', 'open', 'pre_release', 'drain', 'close', 'unlock']);
  expect(key.bytes).toEqual(Buffer.alloc(32)); expect(result).toEqual({ basename: receipt.basename, kind: 'pre_release', schemaVersion: 15, sha256: 'a'.repeat(64), sizeBytes: 1234, createdAt: receipt.createdAt, verifiedAt: receipt.verifiedAt });
});
it('lock refusal performs no key/path/database/copy or unlock work', async () => { const { deps, events } = fake({ lock: false }); await expect(performPreReleaseBackup(deps)).rejects.toThrow(); expect(events).toEqual(['lock']); });
it.each(['ready', 'validate', 'key', 'open', 'pre_release', 'drain', 'close'])('fails safely and releases lock after cleanup when %s fails', async failure => {
  const { deps, events, key } = fake({ failure }); await expect(performPreReleaseBackup(deps)).rejects.toThrow('PRE_RELEASE_BACKUP_FAILED');
  expect(events.at(-1)).toBe('unlock'); if (events.includes('open')) expect(key.bytes).toEqual(Buffer.alloc(32)); if (events.includes('pre_release')) expect(events).toContain('close');
});
it.each([['--database', '/x'], ['--callie-pre-release-backup', '--user-data-dir=/x'], ['--callie-pre-release-backup=1'], ['--use-mock-keychain']])('rejects unsupported main invocation %j', args => { expect(() => validateBackupInvocation(args, {})).toThrow(); });
it.each(['CALLIE_DATABASE_PATH', 'CALLIE_SOURCING_FIXTURE_DIR', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'XDG_CONFIG_HOME'])('rejects bypass environment %s', name => { expect(() => validateBackupInvocation(['--callie-pre-release-backup'], { [name]: 'x' })).toThrow(); });
it('accepts only the exact reserved flag', () => { expect(() => validateBackupInvocation(['--callie-pre-release-backup'], {})).not.toThrow(); });
async function workspace() {
  const root = realpathSync(mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), 'backup-existing-'))); roots.push(root); chmodSync(root, 0o700);
  const paths = resolveApplicationPaths(root); const key = { bytes: Buffer.alloc(32, 42), version: 1 };
  const database = openDatabase({ path: paths.databasePath, key });
  await migrateToLatest(database, { backupDirectory: paths.backupDirectory, workspaceKey: key }); closeDatabase(database);
  writeFileSync(paths.keyEnvelopePath, 'synthetic-fixture-envelope', { mode: 0o600 });
  return { root, paths, key };
}
it('backs up a real synthetic encrypted existing schema15 without provisioning, migrations or timers', async () => {
  const { paths, key } = await workspace(); const loaded = [];
  const loadKey = async () => { const copy = { bytes: Buffer.from(key.bytes), version: 1 }; loaded.push(copy); return copy; };
  const result = await performPreReleaseBackup({ acquireLock: () => true, releaseLock: () => {}, ready: async () => {}, paths: () => paths,
    loadKey, service: (database) => new BackupService({ databaseGate: { withDatabase: async fn => fn(database) }, backupDirectory: paths.backupDirectory, loadWorkspaceKey: loadKey, clock: { now: () => receipt.createdAt }, ids: { next: () => 'fixture-receipt' } }),
  });
  expect(result.kind).toBe('pre_release'); expect(JSON.stringify(result)).not.toContain(paths.databasePath);
  const copyPath = join(paths.backupDirectory, result.basename); expect(statSync(copyPath).mode & 0o777).toBe(0o600); expect(statSync(paths.backupDirectory).mode & 0o777).toBe(0o700);
  expect(readFileSync(copyPath).subarray(0, 16).toString()).not.toBe('SQLite format 3\0');
  const db = openExistingPreReleaseDatabase(paths, key);
  try { expect(db.raw.prepare('SELECT kind FROM backup_receipts').all()).toEqual([{ kind: 'pre_release' }]); expect(db.raw.prepare('SELECT schema_version FROM app_meta').get()).toEqual({ schema_version: 15 }); } finally { closeDatabase(db); key.bytes.fill(0); }
  expect(loaded.every(k => k.bytes.equals(Buffer.alloc(32)))).toBe(true);
});
it.each(['missing', 'wrong-key', 'schema14', 'schema16', 'receipt-trigger'])('refuses %s existing workspace before backup output', async failure => {
  const { paths, key } = await workspace();
  if (failure === 'missing') rmSync(paths.databasePath);
  if (failure === 'wrong-key') key.bytes.fill(41);
  if (failure.startsWith('schema') || failure === 'receipt-trigger') {
    const db = openDatabase({ path: paths.databasePath, key });
    if (failure === 'receipt-trigger') db.raw.exec('DROP TRIGGER immutable_backup_receipts'); else db.raw.prepare('UPDATE app_meta SET schema_version = ?').run(Number(failure.slice(6)));
    closeDatabase(db);
  }
  const before = existsSync(paths.backupDirectory) ? readdirSync(paths.backupDirectory) : [];
  expect(() => openExistingPreReleaseDatabase(paths, key)).toThrow();
  expect(existsSync(paths.backupDirectory) ? readdirSync(paths.backupDirectory) : []).toEqual(before); key.bytes.fill(0);
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
