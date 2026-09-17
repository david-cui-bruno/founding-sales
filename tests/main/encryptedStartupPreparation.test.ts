import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as files from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeDatabase,
  openDatabase,
  type AppDatabase,
} from '../../src/main/db/database';
import {
  createMigrationRunner,
  migrateToLatest,
  productionMigrations,
} from '../../src/main/db/migrate';
import {
  prepareEncryptedDatabase,
  plaintextUpgradePaths,
  readAndVerifyDatabaseFingerprint,
} from '../../src/main/db/plaintextDatabaseUpgrade';
import * as driver from '../../src/main/db/sqliteDriver';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import { FoundationRuntime } from '../../src/main/foundation/foundationRuntime';
import { HealthService } from '../../src/main/health/healthService';
import { createTestWorkspaceKey } from '../fixtures/tempDatabase';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

const scratch = join(
  homedir(),
  '.jcode/scratch/fss-A-composition-startup-20260909',
);
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
async function fixture(version = 27, journal = 'WAL') {
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, 'encrypted-preparation-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'workspace.sqlite3');
  const key = createTestWorkspaceKey();
  const database = openDatabase({ path, key });
  await createMigrationRunner(productionMigrations.slice(0, version))(
    database,
    {
      backupDirectory: join(directory, 'seed-backups'),
      workspaceKey: key,
    },
  );
  if (version === 27) {
    const runtime = new DomainRuntime({
      database,
      clock: { now: () => '2026-09-06T12:00:00.000Z' },
      ids: { next: randomUUID },
    });
    expect(runtime.initialize().status).toBe('ready');
    runtime.shutdown();
  }
  database.raw.pragma(`journal_mode = ${journal}`);
  closeDatabase(database);
  return { directory, path, key };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function connection(f: Fixture, readonly = false) {
  const raw = driver.createRawDatabase(f.path, {
    readonly,
    fileMustExist: true,
  });
  driver.applyWorkspaceKey(raw, f.key.bytes);
  cleanup.push(() => {
    if (raw.open) raw.close();
  });
  return raw;
}
function timezone(raw: driver.RawDatabase) {
  return raw
    .prepare<[], { timezone: string }>(
      'SELECT timezone FROM workspace_settings',
    )
    .get()!.timezone;
}
function fingerprint(raw: driver.RawDatabase) {
  try {
    return readAndVerifyDatabaseFingerprint(raw, [27]);
  } finally {
    raw.defaultSafeIntegers(false);
  }
}
function foundation(f: Fixture) {
  const keys: Buffer[] = [];
  const opened: AppDatabase[] = [];
  const stages: string[] = [];
  const runtime = new FoundationRuntime(
    {
      appVersion: 'test',
      backupDirectory: join(f.directory, 'startup-backups'),
      databasePath: f.path,
      databaseExists: true,
      keyEnvelopePath: join(f.directory, 'unused-envelope'),
    },
    {
      loadWorkspaceKey: async () => {
        const key = createTestWorkspaceKey();
        keys.push(key.bytes);
        return key;
      },
      prepareEncryptedDatabase: async (...args) => {
        stages.push('prepare');
        await prepareEncryptedDatabase(...args);
        stages.push('prepared');
      },
      openDatabase: (options) => {
        stages.push('open');
        const db = openDatabase(options);
        opened.push(db);
        return db;
      },
      migrateToLatest: async (...args) => {
        stages.push('migrate');
        const result = await migrateToLatest(...args);
        stages.push('migrated');
        return result;
      },
      createDomainRuntime: (database) => {
        stages.push('domain');
        return new DomainRuntime({
          database,
          clock: { now: () => '2026-09-06T12:00:00.000Z' },
          ids: { next: randomUUID },
        });
      },
      createHealthService: (options) => new HealthService(options),
      closeDatabase,
    },
  );
  cleanup.push(() => runtime.shutdown());
  return { runtime, keys, opened, stages };
}
async function ready(f: Fixture) {
  const boot = foundation(f);
  await boot.runtime.initialize();
  expect(await boot.runtime.getHealth()).toMatchObject({
    databaseEncrypted: true,
    schemaVersion: 27,
    domainReady: true,
  });
  expect(boot.keys.every((key) => key.equals(Buffer.alloc(32)))).toBe(true);
  await boot.runtime.withDatabase((database) => {
    expect(database.raw.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(database.raw.pragma('recursive_triggers', { simple: true })).toBe(1);
    expect(database.raw.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(database.raw.pragma('busy_timeout', { simple: true })).toBe(5000);
  });
  return boot;
}
// Spies forward every real operation. No fake SQL, admission or initialization.
function observePrepare(f: Fixture, afterInspection?: () => void) {
  const actual = driver.createRawDatabase;
  const opens: boolean[] = [];
  const pragmas: string[] = [];
  let injected = false;
  vi.spyOn(driver, 'createRawDatabase').mockImplementation(
    (path, options = {}) => {
      const raw = actual(path, options);
      if (path === f.path) {
        opens.push(options.readonly === true);
        const pragma = raw.pragma.bind(raw);
        vi.spyOn(raw, 'pragma').mockImplementation(((
          ...args: Parameters<typeof raw.pragma>
        ) => {
          pragmas.push(args[0]);
          return pragma(...args);
        }) as typeof raw.pragma);
        const close = raw.close.bind(raw);
        vi.spyOn(raw, 'close').mockImplementation(() => {
          const result = close();
          if (options.readonly && !injected) {
            injected = true;
            afterInspection?.();
          }
          return result;
        });
      }
      return raw;
    },
  );
  const syncs: string[] = [];
  const actualOpen = files.open;
  const open = vi.spyOn(files, 'open').mockImplementation(async (...args) => {
    const handle = await actualOpen(...args);
    const sync = handle.sync.bind(handle);
    vi.spyOn(handle, 'sync').mockImplementation(async () => {
      syncs.push(String(args[0]));
      await sync();
    });
    return handle;
  });
  return {
    opens,
    pragmas,
    syncs,
    remove: vi.spyOn(files, 'rm'),
    open,
    injected: () => injected,
  };
}
// Independent process with the existing ABI137 binding and real SQLite locks.
async function peer(f: Fixture, mode: 'reader' | 'writer') {
  const script = `const Database=require(process.argv[1]);const db=new Database(process.argv[2],{nativeBinding:process.argv[3]});
    db.pragma("cipher='sqlcipher'");db.pragma('legacy=4');db.pragma(${JSON.stringify(`key="x'${'2a'.repeat(32)}'"`)});
    db.exec(${JSON.stringify(mode === 'reader' ? 'BEGIN' : 'BEGIN IMMEDIATE')});
    const read=()=>db.prepare('SELECT timezone FROM workspace_settings').get().timezone;
    process.send({value:read()});process.on('message',m=>{if(m==='read')process.send({value:read()});else {db.exec('ROLLBACK');db.close();process.send({closed:true});process.disconnect();}});`;
  const child = spawn(
    process.execPath,
    [
      '-e',
      script,
      require.resolve('better-sqlite3-multiple-ciphers'),
      f.path,
      driver.resolveNativeBinding(),
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  let stderr = '';
  child.stderr!.on('data', (chunk) => {
    stderr += String(chunk);
  });
  cleanup.push(() => {
    if (child.connected) child.kill();
  });
  const initial = await message(child);
  expect(stderr).toBe('');
  return {
    initial,
    async read() {
      const next = message(child);
      child.send('read');
      return next;
    },
    async release() {
      const next = message(child);
      child.send('release');
      await next;
    },
  };
}
function message(
  child: ChildProcess,
): Promise<{ value?: string; closed?: boolean }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('SQLite peer handshake timed out')),
      10_000,
    );
    child.once('message', (value) => {
      clearTimeout(timer);
      resolve(value as { value?: string; closed?: boolean });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe('bounded encrypted startup preparation', () => {
  it.each(['WAL', 'DELETE'])(
    'inspects clean %s once without writable stabilization, cleanup or fsync',
    async (journal) => {
      const f = await fixture(27, journal);
      const before = readFileSync(f.path);
      const oracle = connection(f, true);
      const expected = fingerprint(oracle);
      oracle.close();
      const observation = observePrepare(f);
      await prepareEncryptedDatabase(f.path, f.key);
      expect(observation.opens).toEqual([true]);
      expect(
        observation.pragmas.filter((sql) => sql === 'integrity_check'),
      ).toHaveLength(1);
      expect(
        observation.pragmas.some((sql) =>
          /checkpoint|journal_mode\s*=/i.test(sql),
        ),
      ).toBe(false);
      expect(observation.remove).not.toHaveBeenCalled();
      expect(observation.syncs).toEqual([]);
      expect(
        observation.open.mock.calls.every(([, flags]) => flags === 'r'),
      ).toBe(true);
      expect(readFileSync(f.path)).toEqual(before);
      vi.restoreAllMocks();
      const boot = await ready(f);
      await boot.runtime.withDatabase((db) =>
        expect(fingerprint(db.raw)).toEqual(expected),
      );
    },
  );
  it.each(['same-process', 'child-process'])(
    'preserves pinned %s old snapshot and latest committed WAL through normal startup/reopen',
    async (mode) => {
      const f = await fixture();
      const reader = mode === 'same-process' ? connection(f, true) : undefined;
      reader?.exec('BEGIN');
      const external =
        mode === 'child-process' ? await peer(f, 'reader') : undefined;
      const old = reader ? timezone(reader) : external!.initial.value;
      const writer = connection(f);
      writer
        .prepare("UPDATE workspace_settings SET timezone='Pacific/Honolulu'")
        .run();
      expect(statSync(`${f.path}-wal`).size).toBeGreaterThan(0);
      const expected = fingerprint(writer);
      const boot = await ready(f);
      expect(reader ? timezone(reader) : (await external!.read()).value).toBe(
        old,
      );
      await boot.runtime.withDatabase((db) => {
        expect(timezone(db.raw)).toBe('Pacific/Honolulu');
        expect(fingerprint(db.raw)).toEqual(expected);
      });
      await boot.runtime.shutdown();
      if (reader) {
        reader.exec('ROLLBACK');
        reader.close();
      } else await external!.release();
      writer.close();
      const retry = await ready(f);
      await retry.runtime.withDatabase((db) =>
        expect(fingerprint(db.raw)).toEqual(expected),
      );
    },
  );
  it('admits an external writer only up to the unchanged migration busy boundary, closes and retries', async () => {
    const f = await fixture();
    const external = await peer(f, 'writer');
    const before = readFileSync(f.path);
    const boot = foundation(f);
    await expect(boot.runtime.initialize()).rejects.toThrow(/busy|locked/i);
    expect(boot.stages).toEqual(['prepare', 'prepared', 'open', 'migrate']);
    expect(boot.opened.every((db) => !db.raw.open)).toBe(true);
    expect(boot.keys.every((key) => key.equals(Buffer.alloc(32)))).toBe(true);
    expect(readFileSync(f.path)).toEqual(before);
    await external.release();
    await boot.runtime.initialize();
    expect(await boot.runtime.getHealth()).toMatchObject({ domainReady: true });
  }, 15_000);
  it('keeps older-schema pinned-reader backup refusal and retries the real pending migration', async () => {
    const f = await fixture(23);
    const reader = connection(f, true);
    reader.exec('BEGIN');
    const old = timezone(reader);
    const writer = connection(f);
    writer
      .prepare("UPDATE workspace_settings SET timezone='Pacific/Honolulu'")
      .run();
    const boot = foundation(f);
    await expect(boot.runtime.initialize()).rejects.toThrow(
      /checkpoint|busy|locked/i,
    );
    expect(boot.stages).toEqual(['prepare', 'prepared', 'open', 'migrate']);
    expect(timezone(reader)).toBe(old);
    expect(writer.prepare('SELECT schema_version FROM app_meta').get()).toEqual(
      { schema_version: 23 },
    );
    reader.exec('ROLLBACK');
    reader.close();
    writer.close();
    await boot.runtime.initialize();
    expect(await boot.runtime.getHealth()).toMatchObject({
      schemaVersion: 27,
      domainReady: true,
    });
    expect(
      readdirSync(join(f.directory, 'startup-backups')).length,
    ).toBeGreaterThan(0);
    await boot.runtime.withDatabase((db) =>
      expect(timezone(db.raw)).toBe('Pacific/Honolulu'),
    );
  }, 15_000);
  it('rolls back an injected failure in the real pending migration and retries with verified backup', async () => {
    const f = await fixture(23);
    const original = productionMigrations[23].migration.up;
    const failure = vi
      .spyOn(productionMigrations[23].migration, 'up')
      .mockImplementation(async (db) => {
        await original(db);
        throw new Error('synthetic post-migration failure');
      });
    const boot = foundation(f);
    await expect(boot.runtime.initialize()).rejects.toThrow(
      'synthetic post-migration failure',
    );
    expect(boot.stages).toEqual(['prepare', 'prepared', 'open', 'migrate']);
    expect(boot.opened.every((db) => !db.raw.open)).toBe(true);
    expect(boot.keys.every((key) => key.equals(Buffer.alloc(32)))).toBe(true);
    const retained = connection(f, true);
    expect(
      retained.prepare('SELECT schema_version FROM app_meta').get(),
    ).toEqual({ schema_version: 23 });
    expect(
      retained
        .prepare("SELECT name FROM kysely_migration WHERE name LIKE '0024%'")
        .all(),
    ).toEqual([]);
    expect(retained.pragma('journal_mode', { simple: true })).toBe('wal');
    retained.close();
    expect(
      readdirSync(join(f.directory, 'startup-backups')).length,
    ).toBeGreaterThan(0);
    failure.mockRestore();
    await boot.runtime.initialize();
    expect(await boot.runtime.getHealth()).toMatchObject({
      schemaVersion: 27,
      domainReady: true,
    });
  });
  it.each(['.encryption-state.json', '.encrypting', '.plaintext-recovery-wal'])(
    'does not delete late %s arrival after classification',
    async (suffix) => {
      const f = await fixture(27, 'DELETE');
      const actualLstat = files.lstat;
      let canonicalReads = 0;
      let injected = false;
      vi.spyOn(files, 'lstat').mockImplementation((async (
        ...args: Parameters<typeof files.lstat>
      ) => {
        const result = await actualLstat(...args);
        if (args[0] === f.path && ++canonicalReads === 2) {
          writeFileSync(
            `${f.path}${suffix}`,
            'late independently owned artifact',
          );
          injected = true;
        }
        return result;
      }) as typeof files.lstat);
      const boot = await ready(f);
      expect(injected).toBe(true);
      expect(readFileSync(`${f.path}${suffix}`, 'utf8')).toBe(
        'late independently owned artifact',
      );
      await boot.runtime.shutdown();
      // Namespace absence is an observation, not ownership of later arrivals.
      // Restart now observes the artifact and uses the existing marker/fallback path.
    },
  );
  it.each([
    'supported-write',
    'future-schema',
    'ledger-drift',
    'manifest-drift',
  ])('fresh downstream admission handles postinspection %s', async (kind) => {
    const f = await fixture(27, 'DELETE');
    const observation = observePrepare(f, () => {
      const raw = connection(f);
      if (kind === 'supported-write')
        raw
          .prepare("UPDATE workspace_settings SET timezone='Pacific/Honolulu'")
          .run();
      if (kind === 'future-schema')
        raw.exec('UPDATE app_meta SET schema_version=28');
      if (kind === 'ledger-drift')
        raw.exec(
          "DELETE FROM kysely_migration WHERE name='0026LocalCompanyDrafts'",
        );
      if (kind === 'manifest-drift')
        raw.exec('DROP INDEX jobs_state_created_idx');
      raw.close();
    });
    const boot = foundation(f);
    if (kind === 'supported-write') {
      await boot.runtime.initialize();
      await boot.runtime.withDatabase((db) =>
        expect(timezone(db.raw)).toBe('Pacific/Honolulu'),
      );
    } else {
      await expect(boot.runtime.initialize()).rejects.toThrow();
      expect(boot.stages).toContain('prepared');
      expect(boot.stages).toContain(
        kind === 'manifest-drift' ? 'domain' : 'migrate',
      );
      expect(boot.opened.every((db) => !db.raw.open)).toBe(true);
    }
    expect(observation.injected()).toBe(true);
  });
  it.each(['missing', 'directory', 'dangling-symlink'])(
    'rejects postinspection canonical %s before downstream creation',
    async (kind) => {
      const f = await fixture(27, 'DELETE');
      const before = readFileSync(f.path);
      const observation = observePrepare(f, () => {
        renameSync(f.path, `${f.path}.retained`);
        if (kind === 'directory') mkdirSync(f.path);
        if (kind === 'dangling-symlink')
          symlinkSync(join(f.directory, 'missing'), f.path);
      });
      const boot = foundation(f);
      await expect(boot.runtime.initialize()).rejects.toThrow(
        'Encrypted canonical path is no longer a regular file.',
      );
      expect(boot.stages).toEqual(['prepare']);
      expect(observation.remove).not.toHaveBeenCalled();
      expect(readFileSync(`${f.path}.retained`).equals(before)).toBe(true);
    },
  );
  it.each([
    'valid',
    'future',
    'wrong-key',
    'plaintext',
    'directory',
    'symlink',
  ])('re-admits postinspection pathname replacement: %s', async (kind) => {
    const f = await fixture(27, 'DELETE');
    const replacement = join(f.directory, 'replacement.sqlite3');
    copyFileSync(f.path, replacement);
    if (kind === 'valid' || kind === 'future') {
      const raw = driver.createRawDatabase(replacement);
      driver.applyWorkspaceKey(raw, f.key.bytes);
      raw.exec(
        kind === 'future'
          ? 'UPDATE app_meta SET schema_version=28'
          : "UPDATE workspace_settings SET timezone='Pacific/Honolulu'",
      );
      raw.close();
    }
    if (kind === 'wrong-key' || kind === 'symlink') {
      const raw = driver.createRawDatabase(replacement);
      driver.applyWorkspaceKey(raw, f.key.bytes);
      raw.pragma(`rekey="x'${'09'.repeat(32)}'"`);
      raw.close();
    }
    if (kind === 'plaintext') {
      rmSync(replacement);
      const raw = driver.createRawDatabase(replacement);
      raw.exec(
        'CREATE TABLE retained(value); INSERT INTO retained VALUES (42)',
      );
      raw.close();
    }
    const replacementBytes = readFileSync(replacement);
    const before = readFileSync(f.path);
    observePrepare(f, () => {
      renameSync(f.path, `${f.path}.retained`);
      if (kind === 'directory') mkdirSync(f.path);
      else if (kind === 'symlink') symlinkSync(replacement, f.path);
      else renameSync(replacement, f.path);
    });
    const boot = foundation(f);
    if (kind === 'valid') {
      await boot.runtime.initialize();
      await boot.runtime.withDatabase((db) =>
        expect(timezone(db.raw)).toBe('Pacific/Honolulu'),
      );
    } else {
      await expect(boot.runtime.initialize()).rejects.toThrow();
      expect(boot.stages).toContain(
        kind === 'directory' || kind === 'symlink' ? 'prepare' : 'prepared',
      );
      expect(boot.opened.every((db) => !db.raw.open)).toBe(true);
      if (kind !== 'directory' && kind !== 'future')
        expect(readFileSync(f.path).equals(replacementBytes)).toBe(true);
      if (kind === 'future') {
        const raw = connection(f, true);
        expect(
          raw.prepare('SELECT schema_version FROM app_meta').get(),
        ).toEqual({ schema_version: 28 });
        raw.close();
      }
    }
    expect(readFileSync(`${f.path}.retained`)).toEqual(before);
  });
  it.each([
    '.encrypting',
    '.plaintext-recovery',
    '.encrypting-wal',
    '.encrypting-shm',
    '.encrypting-journal',
    '.plaintext-recovery-wal',
    '.plaintext-recovery-shm',
    '.plaintext-recovery-journal',
    '-journal',
  ])('retains old stabilization for present %s', async (suffix) => {
    const f = await fixture(27, 'DELETE');
    // Empty regular journal is nonhot. Invalid alternate families still take
    // canonical stabilization and baseline artifact cleanup.
    writeFileSync(`${f.path}${suffix}`, '');
    const observation = observePrepare(f);
    await prepareEncryptedDatabase(f.path, f.key);
    expect(observation.opens).toContain(false);
    expect(observation.pragmas).toContain('journal_mode = DELETE');
    expect(
      observation.pragmas.filter((sql) => sql === 'integrity_check'),
    ).toHaveLength(3);
  });
  it.each(['.encrypting', '.plaintext-recovery'])(
    'stabilizes and cleans a valid encrypted alternate %s',
    async (suffix) => {
      const f = await fixture(27, 'DELETE');
      copyFileSync(f.path, `${f.path}${suffix}`);
      const observation = observePrepare(f);
      await prepareEncryptedDatabase(f.path, f.key);
      expect(observation.opens).toEqual([true, false, true]);
      expect(observation.syncs.length).toBeGreaterThan(0);
      await expect(files.lstat(`${f.path}${suffix}`)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );
  it.each(['.encrypting', '.plaintext-recovery'])(
    'preserves baseline alternate directory refusal for %s',
    async (suffix) => {
      const f = await fixture(27, 'DELETE');
      mkdirSync(`${f.path}${suffix}`);
      const observation = observePrepare(f);
      await expect(
        prepareEncryptedDatabase(f.path, f.key),
      ).rejects.toMatchObject({ code: 'ERR_FS_EISDIR' });
      expect(observation.opens).toEqual([true, false, true]);
      expect(statSync(`${f.path}${suffix}`).isDirectory()).toBe(true);
    },
  );
  it.each(['.encrypting', '.plaintext-recovery'])(
    'uses baseline cleanup without following alternate symlink %s',
    async (suffix) => {
      const f = await fixture(27, 'DELETE');
      const target = join(f.directory, 'retained-target');
      writeFileSync(target, 'do not touch');
      symlinkSync(target, `${f.path}${suffix}`);
      const observation = observePrepare(f);
      await prepareEncryptedDatabase(f.path, f.key);
      expect(observation.opens).toEqual([true, false, true]);
      expect(readFileSync(target, 'utf8')).toBe('do not touch');
    },
  );
  it('retains stabilization and marker cleanup for a well-formed prior upgrade marker', async () => {
    const f = await fixture(27, 'DELETE');
    const marker = plaintextUpgradePaths(f.path).marker;
    writeFileSync(
      marker,
      JSON.stringify({
        format: 'callie-plaintext-encryption-upgrade',
        version: 1,
        canonicalPath: f.path,
        schemaVersion: 1,
        rowCounts: { app_meta: 1 },
        contentDigest: 'a'.repeat(64),
      }),
    );
    const observation = observePrepare(f);
    await prepareEncryptedDatabase(f.path, f.key);
    expect(observation.opens).toEqual([true, false, true]);
    await expect(files.lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['malformed', 'path-mismatch', 'directory', 'symlink'])(
    'rejects %s marker before any database open',
    async (kind) => {
      const f = await fixture();
      const marker = plaintextUpgradePaths(f.path).marker;
      if (kind === 'directory') mkdirSync(marker);
      else if (kind === 'symlink')
        symlinkSync(join(f.directory, 'missing'), marker);
      else
        writeFileSync(
          marker,
          kind === 'malformed'
            ? '{'
            : JSON.stringify({
                format: 'callie-plaintext-encryption-upgrade',
                version: 1,
                canonicalPath: `${f.path}.other`,
                schemaVersion: 1,
                rowCounts: { app_meta: 1 },
                contentDigest: 'a'.repeat(64),
              }),
        );
      const before = readFileSync(f.path);
      const observation = observePrepare(f);
      await expect(prepareEncryptedDatabase(f.path, f.key)).rejects.toThrow(
        'state marker is invalid',
      );
      expect(observation.opens).toEqual([]);
      expect(readFileSync(f.path)).toEqual(before);
      expect(observation.remove).not.toHaveBeenCalled();
    },
  );
  it.each([
    'wrong-key',
    'truncated',
    'corrupt-page',
    'future-schema',
    'missing-meta',
    'canonical-directory',
    'canonical-symlink',
    'wal-directory',
    'shm-symlink',
    'journal-symlink',
  ])('preserves rejected initial admission: %s', async (kind) => {
    const f = await fixture(27, 'DELETE');
    if (kind === 'future-schema' || kind === 'missing-meta') {
      const raw = connection(f);
      raw.exec(
        kind === 'future-schema'
          ? 'UPDATE app_meta SET schema_version=28'
          : 'DROP TABLE app_meta',
      );
      raw.close();
    }
    if (kind === 'corrupt-page') {
      const bytes = readFileSync(f.path);
      bytes[8192 + 128] ^= 0xff;
      writeFileSync(f.path, bytes);
    }
    if (kind === 'truncated')
      writeFileSync(f.path, readFileSync(f.path).subarray(0, 500));
    if (kind.startsWith('canonical-')) {
      renameSync(f.path, `${f.path}.retained`);
      if (kind === 'canonical-directory') mkdirSync(f.path);
      else symlinkSync(`${f.path}.retained`, f.path);
    }
    if (kind === 'wal-directory') mkdirSync(`${f.path}-wal`);
    if (kind === 'shm-symlink' || kind === 'journal-symlink')
      symlinkSync(
        join(f.directory, 'missing'),
        `${f.path}${kind === 'shm-symlink' ? '-shm' : '-journal'}`,
      );
    const retained =
      kind === 'canonical-directory' ? `${f.path}.retained` : f.path;
    const before = readFileSync(retained);
    const observation = observePrepare(f);
    await expect(
      prepareEncryptedDatabase(
        f.path,
        kind === 'wrong-key' ? createTestWorkspaceKey(9) : f.key,
      ),
    ).rejects.toThrow(
      'No valid database copy is available for encryption upgrade.',
    );
    expect(observation.opens).not.toContain(false);
    expect(observation.remove).not.toHaveBeenCalled();
    expect(readFileSync(retained)).toEqual(before);
  });
});
