import { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { BackupService } from '../../src/main/backup/backupService';
import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { createMigrationRunner, productionMigrations } from '../../src/main/db/migrate';
import { assertPrivateDirectory, type RetainedPrivateInput } from '../../src/main/db/readOnlyEncryptedDatabase';
import { applyWorkspaceKey, createRawDatabase, type RawDatabase } from '../../src/main/db/sqliteDriver';
import { assertDomainStorageReady, DOMAIN_MIGRATION_LEDGER, DOMAIN_SCHEMA_MANIFEST } from '../../src/main/domain/startup/storageReadiness';
import { parseRecoveryKeyMaterial } from '../../src/main/security/recoveryKey';
import type { WorkspaceKey } from '../../src/main/security/workspaceKeyTypes';

export type FixtureProfile = 'bootstrap' | 'current' | 'historical';
type FixtureSchema = 15 | 16;
type BackupRow = { id: string; backup_basename: string; kind: string; schema_version: number; sha256: string; size_bytes: number; created_at: string; verified_at: string };
type DrillRow = { performed_at: string; backup_receipt_id: string; backup_sha256: string };
export type FixtureInspection = {
  schemaVersion: FixtureSchema; ledger: string[]; catalogSha256: string;
  sourceSha256: string; businessSha256: string;
  aggregateCounts: { people: number; prospects: number; sourceEvents: number };
  backupReceipts: BackupRow[]; drillReceipts: DrillRow[];
};
const fail = (): never => { throw new Error('PACKAGED_FIXTURE_DATABASE_FAILED'); };
const same = (a: fs.Stats, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const absent = (path: string) => {
  try { fs.lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  fail();
};
const noSidecars = (path: string) => { for (const suffix of ['-wal', '-shm', '-journal']) absent(path + suffix); };
const SCHEMA15_CATALOG = 'd888ea664cf61ff8e5404f3542f1d615d1c9b08ecf77612690236fd192e535a8';
const metadataTables = new Set(['app_meta', 'kysely_migration', 'kysely_migration_lock', 'backup_receipts', 'restore_drill_receipts', 'recovery_readiness']);

function inspectRows(raw: RawDatabase, expected: FixtureSchema, sourceSha256: string): FixtureInspection {
  if (expected !== 15 && expected !== 16) fail();
  if (raw.pragma('integrity_check', { simple: true }) !== 'ok' || (raw.pragma('foreign_key_check') as unknown[]).length) fail();
  const meta = raw.prepare('SELECT singleton, schema_version FROM app_meta').all() as { singleton: number; schema_version: number }[];
  if (meta.length !== 1 || meta[0].singleton !== 1 || meta[0].schema_version !== expected) fail();
  const ledger = raw.prepare('SELECT name FROM kysely_migration ORDER BY timestamp, name').all() as { name: string }[];
  if (JSON.stringify(ledger.map(row => row.name)) !== JSON.stringify(DOMAIN_MIGRATION_LEDGER.slice(0, expected))) fail();
  const catalog = raw.prepare(`SELECT name, type, sql FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger') AND (type <> 'index' OR sql IS NOT NULL)
    ORDER BY name COLLATE BINARY`).all() as { name: string; type: string; sql: string | null }[];
  const fingerprint = catalog.map(row => [row.type, row.name, (row.sql ?? '').replace(/\s+/g, ' ').trim()])
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  const catalogSha256 = hash(JSON.stringify(fingerprint));
  if (catalogSha256 !== (expected === 15 ? SCHEMA15_CATALOG : DOMAIN_SCHEMA_MANIFEST.catalogSha256)) fail();
  // Catalog-validated, fixed tables only. Canonical row multisets, no business rows
  // escape. This is a same-schema digest, not a cross-migration equivalence claim.
  const business = createHash('sha256');
  for (const table of DOMAIN_SCHEMA_MANIFEST.tables) {
    if (metadataTables.has(table) || table.startsWith('foundation_fts_probe')) continue;
    const rows = raw.prepare(`SELECT * FROM "${table}"`).raw().all().map(row => JSON.stringify(row)).sort();
    business.update(JSON.stringify([table, rows]));
  }
  return {
    schemaVersion: expected, ledger: ledger.map(row => row.name), catalogSha256, sourceSha256,
    businessSha256: business.digest('hex'),
    aggregateCounts: raw.prepare('SELECT (SELECT COUNT(*) FROM persons) AS people, (SELECT COUNT(*) FROM prospects) AS prospects, (SELECT COUNT(*) FROM source_events) AS sourceEvents').get() as FixtureInspection['aggregateCounts'],
    backupReceipts: raw.prepare('SELECT id, backup_basename, kind, schema_version, sha256, size_bytes, created_at, verified_at FROM backup_receipts ORDER BY created_at, id').all() as BackupRow[],
    drillReceipts: raw.prepare('SELECT performed_at, backup_receipt_id, backup_sha256 FROM restore_drill_receipts ORDER BY performed_at, backup_sha256').all() as DrillRow[],
  };
}

/**
 * Test-runner only. No launcher, real-home discovery, key-store access, SQL API or
 * production bypass. Capture EVERY GUI child immediately after spawn and observe
 * its exit before offline work. Caller still proves descendant/graceful-Quit exit.
 * Existing current/bootstrap DBs may be 0600/0644 under owned 0700 ancestors.
 * All other inputs/artifacts stay 0600. Normal-close files need NO sidecars (64 MiB maximum).
 * The approved synthetic-only copy precedes cryptographic validation. SQLite opens
 * only that ciphertext copy for inspection. A leftover source sidecar is a hold.
 */
export function allocatePackagedFixtureDatabase(...unexpected: never[]) {
  if (unexpected.length) fail();
  let root: string;
  try {
    const parent = fs.realpathSync(tmpdir());
    const fromRepository = relative(process.cwd(), parent);
    if (!fromRepository.startsWith('..') && fromRepository !== '') fail();
    if (parent === fs.realpathSync(process.cwd())) fail();
    root = fs.mkdtempSync(join(parent, 'callie-packaged-fixture-'));
  } catch { return fail(); }
  const paths = Object.freeze({ root, bootstrap: join(root, 'bootstrap'), current: join(root, 'current'), historical: join(root, 'historical'), exports: join(root, 'exports'), inspection: join(root, 'inspection') });
  const directories = new Map<string, fs.Stats>();
  const makeDirectory = (path: string) => {
    fs.mkdirSync(path, { mode: 0o700 }); assertPrivateDirectory(path); directories.set(path, fs.lstatSync(path));
  };
  try {
    directories.set(root, fs.lstatSync(root));
    assertPrivateDirectory(root);
    for (const path of [paths.bootstrap, paths.current, paths.exports, paths.inspection, join(paths.bootstrap, 'backups'), join(paths.current, 'backups')]) makeDirectory(path);
  } catch {
    try { fs.rmSync(root, { recursive: true, force: true }); } finally { fail(); }
  }
  let removed = false; let busy = false; let exited = true;
  let captured: ChildProcess | undefined;
  let envelopeCapture: { identity: fs.Stats; sha256: string } | undefined;
  const assertDirectory = (path: string) => {
    if (removed || !directories.has(path)) fail();
    assertPrivateDirectory(path);
    for (const [parent, identity] of directories) {
      if (path === parent || path.startsWith(parent + sep)) {
        if (!same(identity, fs.lstatSync(parent))) fail();
      }
    }
  };
  const profilePath = (profile: FixtureProfile) => {
    if (!['bootstrap', 'current', 'historical'].includes(profile)) return fail();
    const path = paths[profile]; assertDirectory(path); return path;
  };
  const databasePath = (profile: FixtureProfile) => join(profilePath(profile), 'callie.sqlite3');
  const envelopePath = (profile: FixtureProfile) => join(profilePath(profile), 'callie.key-envelope.json');
  const retain = (path: string, maxSize = 64 * 1024 * 1024): RetainedPrivateInput => {
    // openDatabase only fixes its parent mode. This source-only exception is
    // derived from exact captured paths, never a public mode/role override.
    const ordinarySource = path === join(paths.current, 'callie.sqlite3')
      || path === join(paths.bootstrap, 'callie.sqlite3');
    const validate = (stat: fs.Stats) => {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
        || stat.nlink !== 1 || ((stat.mode & 0o777) !== 0o600 && (!ordinarySource || (stat.mode & 0o777) !== 0o644))
        || stat.size < 1 || stat.size > maxSize) fail();
      return stat;
    };
    assertDirectory(dirname(path));
    const original = validate(fs.lstatSync(path));
    const descriptor = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let bytes: Buffer | undefined;
    try {
      const identity = validate(fs.fstatSync(descriptor));
      if (!same(original, identity)) fail();
      const read = () => {
        const value = Buffer.alloc(identity.size);
        try {
          let offset = 0;
          while (offset < value.length) {
            const count = fs.readSync(descriptor, value, offset, value.length - offset, offset);
            if (!count) fail();
            offset += count;
          }
          return value;
        } catch (error) { value.fill(0); throw error; }
      };
      bytes = read(); const sha256 = hash(bytes); let closed = false;
      const input: RetainedPrivateInput = {
        path, descriptor, bytes, sha256,
        assertUnchanged() {
          assertDirectory(dirname(path));
          for (const now of [validate(fs.lstatSync(path)), validate(fs.fstatSync(descriptor))]) {
            if (!same(identity, now) || now.size !== identity.size || now.mtimeMs !== identity.mtimeMs || now.ctimeMs !== identity.ctimeMs) fail();
          }
          const current = read();
          try { if (hash(current) !== sha256) fail(); } finally { current.fill(0); }
        },
        close() { if (!closed) { closed = true; bytes!.fill(0); fs.closeSync(descriptor); } },
      };
      input.assertUnchanged(); return input;
    } catch (error) { bytes?.fill(0); fs.closeSync(descriptor); throw error; }
  };
  const run = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    if (removed || busy || !exited) return fail();
    busy = true;
    try { assertDirectory(root); return await operation(); }
    catch { return fail(); } finally { busy = false; }
  };
  const withMaterial = <T>(material: string, operation: (key: WorkspaceKey) => T | Promise<T>) => run(async () => {
    let key: WorkspaceKey | undefined;
    try { key = parseRecoveryKeyMaterial(material); return await operation(key); }
    finally { key?.bytes.fill(0); }
  });
  const inspect = (profile: FixtureProfile, path: string, key: WorkspaceKey, expected: FixtureSchema) => {
    const sources: RetainedPrivateInput[] = [];
    let raw: RawDatabase | undefined; let temporary: string | undefined; let temporaryIdentity: fs.Stats | undefined;
    let failed = false; let result: FixtureInspection | undefined;
    const checkSources = () => {
      assertDirectory(dirname(path)); assertDirectory(paths.inspection);
      noSidecars(path); for (const source of sources) source.assertUnchanged();
    };
    try {
      noSidecars(path);
      sources.push(retain(path)); sources.push(retain(envelopePath(profile), 64 * 1024));
      checkSources();
      if (sources[0].bytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) fail();
      temporary = fs.mkdtempSync(join(paths.inspection, 'read-'));
      assertPrivateDirectory(temporary); temporaryIdentity = fs.lstatSync(temporary);
      const copy = join(temporary, 'fixture.sqlite3');
      fs.writeFileSync(copy, sources[0].bytes, { flag: 'wx', mode: 0o600 });
      checkSources();
      if (hash(fs.readFileSync(copy)) !== sources[0].sha256) fail();
      raw = createRawDatabase(copy, { readonly: true, fileMustExist: true });
      raw.pragma('query_only = ON'); raw.pragma('temp_store = MEMORY');
      applyWorkspaceKey(raw, key.bytes);
      if (!raw.readonly || raw.pragma('query_only', { simple: true }) !== 1) fail();
      result = inspectRows(raw, expected, sources[0].sha256);
    } catch { failed = true; }
    finally {
      const attempt = (operation: () => void) => { try { operation(); } catch { failed = true; } };
      if (raw?.open) attempt(() => { raw!.close(); });
      if (raw?.open) attempt(() => { raw!.close(); });
      attempt(checkSources);
      for (const source of sources) attempt(() => source.close());
      if (temporary !== undefined && temporaryIdentity !== undefined && !raw?.open) attempt(() => {
        assertDirectory(paths.inspection);
        if (!same(fs.lstatSync(temporary!), temporaryIdentity!) || fs.lstatSync(temporary!).isSymbolicLink()) fail();
        // Includes only this copy's SQLite-created WAL/SHM, never source siblings.
        fs.rmSync(temporary!, { recursive: true });
      });
    }
    if (failed || result === undefined) return fail();
    return result;
  };
  const backupPath = (profile: FixtureProfile, basename: string) => {
    if (!/^(?:daily|manual|pre_release|pre-migration-schema-(?:15|16))-[0-9]{8}T[0-9]{9}Z\.sqlite3$/.test(basename)) return fail();
    const directory = join(profilePath(profile), 'backups'); assertDirectory(directory); return join(directory, basename);
  };
  return {
    paths,
    captureChild(child: ChildProcess): ChildProcess {
      if (!(child instanceof ChildProcess) || removed || busy || !exited || child === captured) return fail();
      captured = child; exited = false;
      // Same captured-instance exit/failed-spawn-close convention as the existing
      // environment helper. No PID polling, caller boolean, termination or launch.
      const onError = (): void => undefined;
      const onExit = () => {
        exited = true; child.removeListener('exit', onExit); child.removeListener('close', onExit); child.removeListener('error', onError);
      };
      child.once('exit', onExit); child.once('close', onExit); child.once('error', onError);
      if (child.pid !== undefined && (child.exitCode !== null || child.signalCode !== null)) onExit();
      return child;
    },
    inspectStoppedProfile(profile: FixtureProfile, material: string, expected: FixtureSchema) {
      return withMaterial(material, key => inspect(profile, databasePath(profile), key, expected));
    },
    inspectStoppedBackup(profile: FixtureProfile, basename: string, material: string, expected: FixtureSchema) {
      return withMaterial(material, key => inspect(profile, backupPath(profile, basename), key, expected));
    },
    captureBootstrapEnvelope() {
      return run(() => {
        const envelope = retain(envelopePath('bootstrap'), 64 * 1024);
        try { envelopeCapture = { identity: fs.fstatSync(envelope.descriptor), sha256: envelope.sha256 }; }
        finally { envelope.close(); }
      });
    },
    createHistoricalProfile(material: string) {
      return withMaterial(material, async key => {
        if (!envelopeCapture) fail();
        absent(paths.historical);
        const envelope = retain(envelopePath('bootstrap'), 64 * 1024);
        let database: AppDatabase | undefined;
        try {
          if (!same(envelopeCapture.identity, fs.fstatSync(envelope.descriptor)) || envelopeCapture.sha256 !== envelope.sha256) fail();
          inspect('bootstrap', databasePath('bootstrap'), key, 16); // Proves supplied key matches bootstrap DB, NOT safeStorage.
          envelope.assertUnchanged();
          makeDirectory(paths.historical); makeDirectory(join(paths.historical, 'backups'));
          fs.writeFileSync(envelopePath('historical'), envelope.bytes, { flag: 'wx', mode: 0o600 });
          fs.writeFileSync(databasePath('historical'), '', { flag: 'wx', mode: 0o600 });
          database = openDatabase({ path: databasePath('historical'), key });
          const migration = await createMigrationRunner(productionMigrations.filter(entry => entry.schemaVersion <= 15))(database, {
            workspaceKey: key, backupDirectory: join(paths.historical, 'backups'),
          });
          if (migration.fromVersion !== 0 || migration.toVersion !== 15) fail();
          closeDatabase(database); database = undefined;
          return inspect('historical', databasePath('historical'), key, 15);
        } finally {
          try { if (database) closeDatabase(database); }
          finally { try { envelope.assertUnchanged(); } finally { envelope.close(); } }
        }
      });
    },
    createManualBackup(material: string) {
      return withMaterial(material, async key => {
        const path = databasePath('current');
        const before = inspect('current', path, key, 16);
        if (before.aggregateCounts.people < 1) fail();
        const envelope = retain(envelopePath('current'), 64 * 1024);
        let database: AppDatabase | undefined; let service: BackupService | undefined;
        try {
          assertDirectory(join(paths.current, 'backups'));
          database = openDatabase({ path, key });
          assertDomainStorageReady({ database, expectedBusyTimeoutMs: 5000, expectedSchemaVersion: 16, expectedManifest: DOMAIN_SCHEMA_MANIFEST });
          const current = database;
          service = new BackupService({ databaseGate: { withDatabase: async operation => operation(current) },
            backupDirectory: join(paths.current, 'backups'), loadWorkspaceKey: async () => parseRecoveryKeyMaterial(material),
            clock: { now: () => new Date().toISOString() }, ids: { next: () => randomUUID() } });
          const backup = await service.createBackup('manual');
          await service.shutdown(); service = undefined;
          closeDatabase(database); database = undefined;
          const inspection = inspect('current', backupPath('current', backup.basename), key, 16);
          const after = inspect('current', path, key, 16);
          if (inspection.sourceSha256 !== backup.sha256 || inspection.businessSha256 !== before.businessSha256
            || after.businessSha256 !== before.businessSha256
            || !after.backupReceipts.some(row => row.backup_basename === backup.basename && row.sha256 === backup.sha256 && row.size_bytes === backup.sizeBytes)) fail();
          return { backup, inspection };
        } finally {
          try { await service?.shutdown(); }
          finally { try { if (database) closeDatabase(database); } finally { try { envelope.assertUnchanged(); } finally { envelope.close(); } } }
        }
      });
    },
    async cleanup() {
      if (removed) return;
      return run(() => {
        assertDirectory(root);
        // Node recursive rm unlinks child symlinks, never traverses their targets.
        fs.rmSync(root, { recursive: true }); removed = true;
      });
    },
  };
}
