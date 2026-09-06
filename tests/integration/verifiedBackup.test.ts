import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, fchmodSync, fstatSync, fsyncSync, mkdirSync, readFileSync,
  readdirSync, renameSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createVerifiedEncryptedBackup, createVerifiedEncryptedCopy,
  type VerifiedCopyOperations,
} from '../../src/main/backup/verifiedBackup';
import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { applyWorkspaceKey, createRawDatabase } from '../../src/main/db/sqliteDriver';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';

const NOW = '2026-09-06T12:34:56.789Z';
const clock = { now: () => NOW };
const operations: VerifiedCopyOperations = {
  fchmod: fchmodSync, fstat: fstatSync, fsyncDirectory: fsyncSync,
};

describe('verified encrypted backups', () => {
  let temp: TempDatabase;
  let database: AppDatabase;
  let backupDirectory: string;
  const key = createTestWorkspaceKey();

  beforeEach(() => {
    temp = createTempDatabase();
    database = openDatabase({ path: temp.path, key });
    database.raw.exec(`CREATE TABLE app_meta (singleton INTEGER PRIMARY KEY, schema_version INTEGER);
      INSERT INTO app_meta VALUES (1, 15);
      CREATE TABLE sentinel (value TEXT);
      INSERT INTO sentinel VALUES ('disposable encrypted WAL sentinel');`);
    backupDirectory = join(dirname(temp.path), 'backups');
  });
  afterEach(() => { closeDatabase(database); temp.cleanup(); });

  function backup(kind: 'daily' | 'manual' | 'pre_release' = 'daily', schemaVersion = 15) {
    return createVerifiedEncryptedBackup({ database, backupDirectory, key, kind, schemaVersion, clock });
  }
  function copy(overrides: Partial<VerifiedCopyOperations> = {}, copyKey = key, schemaVersion = 15) {
    return createVerifiedEncryptedCopy({
      database, backupDirectory, key: copyKey, schemaVersion,
      basename: 'daily-20260906T123456789Z.sqlite3', clock,
    }, { ...operations, ...overrides });
  }
  function assertLiveDatabase() {
    expect(database.raw.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(database.raw.pragma('integrity_check', { simple: true })).toBe('ok');
    database.raw.exec("INSERT INTO sentinel VALUES ('still writable')");
    expect(database.raw.prepare('SELECT count(*) AS count FROM sentinel').get()).toEqual({ count: 2 });
  }

  it.each(['daily', 'manual', 'pre_release'] as const)('creates an immutable verified %s encrypted snapshot including committed WAL data', (kind) => {
    const result = backup(kind);
    expect(result).toMatchObject({
      basename: `${kind}-20260906T123456789Z.sqlite3`, kind, schemaVersion: 15,
      createdAt: NOW, verifiedAt: NOW,
    });
    const bytes = readFileSync(result.path);
    expect(bytes.subarray(0, 16).toString()).not.toBe('SQLite format 3\0');
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(result.sizeBytes).toBe(bytes.length);
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    expect(statSync(backupDirectory).mode & 0o777).toBe(0o700);
    const restored = createRawDatabase(result.path, { readonly: true, fileMustExist: true });
    try {
      applyWorkspaceKey(restored, key.bytes);
      expect(restored.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(restored.prepare('SELECT value FROM sentinel').all()).toEqual([{ value: 'disposable encrypted WAL sentinel' }]);
    } finally { restored.close(); }
    expect(() => backup(kind)).toThrow();
    expect(readFileSync(result.path)).toEqual(bytes);
    expect(readdirSync(backupDirectory)).toEqual([result.basename]);
    assertLiveDatabase();
  });

  it.each([1, 16])('verifies the caller-supplied schema %s without imposing a current-schema ceiling', (version) => {
    database.raw.prepare('UPDATE app_meta SET schema_version = ?').run(version);
    expect(backup('manual', version).schemaVersion).toBe(version);
  });

  it('fsyncs the private directory before and after verification', () => {
    let syncs = 0;
    const result = copy({ fsyncDirectory(descriptor) {
      expect(fstatSync(descriptor).isDirectory()).toBe(true);
      expect(fstatSync(descriptor).mode & 0o777).toBe(0o700);
      fsyncSync(descriptor);
      syncs += 1;
    } });
    expect(syncs).toBeGreaterThanOrEqual(2);
    expect(statSync(result.path).size).toBe(result.sizeBytes);
    assertLiveDatabase();
  });

  it.each(['wrong-key', 'schema', 'directory-fsync', 'plaintext-header', 'corruption', 'chmod'] as const)(
    'rejects %s, removes only its incomplete destination and restores writable WAL', (failure) => {
      mkdirSync(backupDirectory, { mode: 0o700 });
      const unrelated = join(backupDirectory, 'pre-migration-schema-1-protected.sqlite3');
      writeFileSync(unrelated, 'preserve migration backup');
      let injected = false;
      expect(() => copy({
        fchmod: failure === 'chmod' ? () => { throw new Error('injected chmod failure'); } : fchmodSync,
        fsyncDirectory(descriptor) {
          fsyncSync(descriptor);
          if (failure === 'directory-fsync') throw new Error('injected fsync failure');
          if (!injected && (failure === 'plaintext-header' || failure === 'corruption')) {
            injected = true;
            const path = join(backupDirectory, 'daily-20260906T123456789Z.sqlite3');
            const contents = readFileSync(path);
            if (failure === 'plaintext-header') Buffer.from('SQLite format 3\0').copy(contents);
            else contents.fill(0, 4096);
            writeFileSync(path, contents);
          }
        },
      }, failure === 'wrong-key' ? createTestWorkspaceKey(0x7a) : key, failure === 'schema' ? 14 : 15)).toThrow();
      expect(readdirSync(backupDirectory)).toEqual(['pre-migration-schema-1-protected.sqlite3']);
      expect(readFileSync(unrelated, 'utf8')).toBe('preserve migration backup');
      assertLiveDatabase();
    },
  );

  it('detects content changed at the final fsync before returning a receipt', () => {
    let syncs = 0;
    expect(() => copy({ fsyncDirectory(descriptor) {
      fsyncSync(descriptor);
      syncs += 1;
      if (syncs === 2) {
        const path = join(backupDirectory, 'daily-20260906T123456789Z.sqlite3');
        const contents = readFileSync(path);
        contents[contents.length - 1] ^= 0xff;
        writeFileSync(path, contents);
      }
    } })).toThrow();
    expect(readdirSync(backupDirectory)).toEqual([]);
    assertLiveDatabase();
  });

  it.each(['file', 'directory'] as const)('fails closed when %s permissions drift during verification', (target) => {
    expect(() => copy({ fsyncDirectory(descriptor) {
      fsyncSync(descriptor);
      chmodSync(target === 'directory' ? backupDirectory : join(backupDirectory, 'daily-20260906T123456789Z.sqlite3'), 0o777);
    } })).toThrow();
    expect(readdirSync(backupDirectory)).toEqual([]);
    assertLiveDatabase();
  });

  it('checks bytes again after obtaining the verification timestamp', () => {
    const path = join(backupDirectory, 'daily-20260906T123456789Z.sqlite3');
    expect(() => createVerifiedEncryptedCopy({
      database, backupDirectory, key, schemaVersion: 15,
      basename: 'daily-20260906T123456789Z.sqlite3',
      clock: { now() {
        const contents = readFileSync(path);
        contents[contents.length - 1] ^= 0xff;
        writeFileSync(path, contents);
        return NOW;
      } },
    })).toThrow();
    expect(readdirSync(backupDirectory)).toEqual([]);
    assertLiveDatabase();
  });

  it('restores WAL even when journal stabilization throws after switching to DELETE', () => {
    const pragma = database.raw.pragma.bind(database.raw);
    database.raw.pragma = ((source: string, options?: never) => {
      const result = pragma(source, options);
      if (source === 'journal_mode = DELETE') throw new Error('injected post-switch failure');
      return result;
    }) as typeof database.raw.pragma;
    try { expect(() => backup()).toThrow(); }
    finally { database.raw.pragma = pragma; }
    assertLiveDatabase();
  });

  it('retains source identity across stabilization rather than copying a replacement pathname', () => {
    const displaced = `${database.path}.original`;
    const pragma = database.raw.pragma.bind(database.raw);
    database.raw.pragma = ((source: string, options?: never) => {
      const result = pragma(source, options);
      if (source === 'journal_mode = DELETE') {
        renameSync(database.path, displaced);
        writeFileSync(database.path, readFileSync(displaced));
      }
      return result;
    }) as typeof database.raw.pragma;
    try { expect(() => backup()).toThrow(); }
    finally { database.raw.pragma = pragma; }
    expect(readdirSync(backupDirectory)).toEqual([]);
  });

  it('does not unlink or truncate a raced replacement destination', () => {
    const path = join(backupDirectory, 'daily-20260906T123456789Z.sqlite3');
    let replaced = false;
    expect(() => copy({ fsyncDirectory(descriptor) {
      fsyncSync(descriptor);
      if (!replaced) {
        replaced = true;
        renameSync(path, `${path}.displaced`);
        writeFileSync(path, 'unrelated replacement');
      }
    } })).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('unrelated replacement');
    expect(statSync(`${path}.displaced`).size).toBe(0);
    assertLiveDatabase();
  });

  it('refuses symlink destinations and occupied sidecars without touching them', () => {
    mkdirSync(backupDirectory, { mode: 0o700 });
    const sentinel = join(backupDirectory, 'unrelated');
    writeFileSync(sentinel, 'unrelated');
    symlinkSync(sentinel, join(backupDirectory, 'daily-20260906T123456789Z.sqlite3'));
    expect(() => backup()).toThrow();
    writeFileSync(join(backupDirectory, 'manual-20260906T123456789Z.sqlite3-wal'), 'sidecar');
    expect(() => backup('manual')).toThrow();
    expect(readFileSync(sentinel, 'utf8')).toBe('unrelated');
    expect(readFileSync(join(backupDirectory, 'manual-20260906T123456789Z.sqlite3-wal'), 'utf8')).toBe('sidecar');
    expect(existsSync(join(backupDirectory, 'manual-20260906T123456789Z.sqlite3'))).toBe(false);
    assertLiveDatabase();
  });
});
