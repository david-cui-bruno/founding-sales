import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { sql } from 'kysely';

import {
  closeDatabase,
  openDatabase,
  type AppDatabase,
} from '../../src/main/db/database';
import {
  createVerifiedMigrationBackup,
  type MigrationBackup,
} from '../../src/main/db/migrationBackup';
import {
  createMigrationRunner,
  migrateToLatest,
} from '../../src/main/db/migrate';
import { migration0001Foundation } from '../../src/main/db/migrations/0001Foundation';
import {
  applyWorkspaceKey,
  createRawDatabase,
} from '../../src/main/db/sqliteDriver';
import {
  createTempDatabase,
  createTestWorkspaceKey,
} from '../fixtures/tempDatabase';

const scenario = process.argv[2];
assert.ok(scenario, 'A migration-backup scenario is required.');

void runScenario();

async function runScenario(): Promise<void> {
  const workspace = createTempDatabase();
  const backupDirectory = join(dirname(workspace.path), 'backups');
  const key = createTestWorkspaceKey();
  let database: AppDatabase | undefined;

  try {
    database = openDatabase({ path: workspace.path, key });

    if (scenario === 'verified-schema-one') {
      await migrateToLatest(database, { backupDirectory, workspaceKey: key });
      const directBackupDirectory = join(dirname(workspace.path), 'direct-backups');
      const backup = createVerifiedMigrationBackup({
        database,
        backupDirectory: directBackupDirectory,
        key,
        sourceSchemaVersion: 1,
      });
      assertVerifiedBackup(backup, directBackupDirectory, key.bytes, 1);
    } else if (scenario === 'pending-only') {
      const first = await migrateToLatest(database, {
        backupDirectory,
        workspaceKey: key,
      });
      assert.deepEqual(first, {
        fromVersion: 0,
        toVersion: 1,
        appliedMigrationIds: ['0001Foundation'],
      });
      const afterFirst = listBackups(backupDirectory);
      assert.equal(afterFirst.length, 1);
      assertBackupFile(afterFirst[0], key.bytes, 0);

      const second = await migrateToLatest(database, {
        backupDirectory,
        workspaceKey: key,
      });
      assert.deepEqual(second, {
        fromVersion: 1,
        toVersion: 1,
        appliedMigrationIds: [],
      });
      assert.deepEqual(listBackups(backupDirectory), afterFirst);
    } else if (scenario === 'migration-failure') {
      database.raw.exec('CREATE TABLE foundation_fts_probe (content TEXT)');
      await assert.rejects(
        migrateToLatest(database, { backupDirectory, workspaceKey: key }),
      );
      assert.equal(readSchemaVersion(database), 0);
      assert.deepEqual(
        database.raw
          .prepare<[], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
          )
          .all(),
        [{ name: 'foundation_fts_probe' }],
      );
      const backups = listBackups(backupDirectory);
      assert.equal(backups.length, 1);
      assertBackupFile(backups[0], key.bytes, 0);
    } else if (scenario === 'schema-one-migration-failure') {
      await migrateToLatest(database, {
        backupDirectory,
        workspaceKey: key,
      });
      database.raw.prepare(`
        INSERT INTO jobs (
          id, type, state, payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        'schema-one-sentinel',
        'test',
        'queued',
        '{}',
        '2026-08-30T00:00:00.000Z',
        '2026-08-30T00:00:00.000Z',
      );
      const schemaOneBackupDirectory = join(
        dirname(workspace.path),
        'schema-one-failure-backups',
      );
      const migrateWithSyntheticFailure = createMigrationRunner([
        {
          id: '0001Foundation',
          schemaVersion: 1,
          migration: migration0001Foundation,
        },
        {
          id: '0002SyntheticFailure',
          schemaVersion: 2,
          migration: {
            async up(kysely) {
              await sql`CREATE TABLE synthetic_partial_write (id TEXT PRIMARY KEY)`.execute(kysely);
              await sql`UPDATE app_meta SET schema_version = 2 WHERE singleton = 1`.execute(kysely);
              throw new Error('Synthetic late migration failure.');
            },
          },
        },
      ]);

      await assert.rejects(
        migrateWithSyntheticFailure(database, {
          backupDirectory: schemaOneBackupDirectory,
          workspaceKey: key,
        }),
        /Synthetic late migration failure/,
      );
      assert.equal(readSchemaVersion(database), 1);
      assert.deepEqual(
        database.raw.prepare<[], { id: string }>(
          "SELECT id FROM jobs WHERE id = 'schema-one-sentinel'",
        ).get(),
        { id: 'schema-one-sentinel' },
      );
      assert.equal(
        database.raw.prepare<[], { found: number }>(
          "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'synthetic_partial_write'",
        ).get(),
        undefined,
      );
      const backups = listBackups(schemaOneBackupDirectory);
      assert.equal(backups.length, 1);
      assertBackupFile(backups[0], key.bytes, 1);
      const reopened = createRawDatabase(backups[0], {
        readonly: true,
        fileMustExist: true,
      });
      try {
        applyWorkspaceKey(reopened, key.bytes);
        assert.deepEqual(
          reopened.prepare<[], { id: string }>(
            "SELECT id FROM jobs WHERE id = 'schema-one-sentinel'",
          ).get(),
          { id: 'schema-one-sentinel' },
        );
      } finally {
        reopened.close();
      }
    } else if (scenario === 'verification-failure') {
      await migrateToLatest(database, { backupDirectory, workspaceKey: key });
      const rejectedDirectory = join(dirname(workspace.path), 'rejected-backups');
      await assert.rejects(async () => createVerifiedMigrationBackup({
        database,
        backupDirectory: rejectedDirectory,
        key: createTestWorkspaceKey(0x7b),
        sourceSchemaVersion: 1,
      }));
      assert.deepEqual(listBackups(rejectedDirectory), []);
      assert.equal(readSchemaVersion(database), 1);
    } else if (scenario === 'verification-blocks-migration') {
      const rejectedDirectory = join(dirname(workspace.path), 'rejected-migration');
      await assert.rejects(migrateToLatest(database, {
        backupDirectory: rejectedDirectory,
        workspaceKey: createTestWorkspaceKey(0x7b),
      }));
      assert.deepEqual(listBackups(rejectedDirectory), []);
      assert.equal(readSchemaVersion(database), 0);
      assert.deepEqual(
        database.raw
          .prepare<[], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
          )
          .all(),
        [],
      );
    } else if (scenario === 'busy-checkpoint') {
      await migrateToLatest(database, { backupDirectory, workspaceKey: key });
      database.raw.exec("INSERT INTO foundation_fts_probe (content) VALUES ('old')");
      const reader = createRawDatabase(workspace.path, { fileMustExist: true });
      try {
        applyWorkspaceKey(reader, key.bytes);
        reader.pragma('journal_mode = WAL');
        reader.exec('BEGIN');
        assert.deepEqual(
          reader.prepare<[], { content: string }>(
            'SELECT content FROM foundation_fts_probe',
          ).all(),
          [{ content: 'old' }],
        );
        database.raw.exec(
          "UPDATE foundation_fts_probe SET content = 'new'",
        );

        const rejectedDirectory = join(dirname(workspace.path), 'busy-backups');
        assert.throws(() => createVerifiedMigrationBackup({
          database,
          backupDirectory: rejectedDirectory,
          key,
          sourceSchemaVersion: 1,
        }), /checkpoint did not reach a clean state/);
        assert.deepEqual(listBackups(rejectedDirectory), []);
      } finally {
        if (reader.inTransaction) {
          reader.exec('ROLLBACK');
        }
        reader.close();
      }
      assert.deepEqual(
        database.raw.prepare<[], { content: string }>(
          'SELECT content FROM foundation_fts_probe',
        ).all(),
        [{ content: 'new' }],
      );
    } else if (scenario === 'directory-replaced') {
      await migrateToLatest(database, { backupDirectory, workspaceKey: key });
      const raceDirectory = join(dirname(workspace.path), 'race-backups');
      const displacedDirectory = `${raceDirectory}.displaced`;
      const originalPragma = database.raw.pragma.bind(database.raw);
      let directoryReplaced = false;
      database.raw.pragma = ((source: string, options?: unknown) => {
        const result = originalPragma(source, options as never);
        if (source === 'wal_checkpoint(TRUNCATE)') {
          renameSync(raceDirectory, displacedDirectory);
          mkdirSync(raceDirectory, { mode: 0o700 });
          directoryReplaced = true;
        }
        return result;
      }) as typeof database.raw.pragma;
      try {
        assert.throws(() => createVerifiedMigrationBackup({
          database,
          backupDirectory: raceDirectory,
          key,
          sourceSchemaVersion: 1,
        }), /filesystem identity changed/);
      } finally {
        database.raw.pragma = originalPragma;
      }
      assert.equal(directoryReplaced, true);
      assert.deepEqual(listBackups(raceDirectory), []);
      assert.deepEqual(listBackups(displacedDirectory), []);
    } else if (scenario === 'unrelated-sidecar') {
      await migrateToLatest(database, { backupDirectory, workspaceKey: key });
      const sidecarDirectory = join(dirname(workspace.path), 'sidecar-backups');
      mkdirSync(sidecarDirectory, { mode: 0o700 });
      const originalDate = Date;
      const fixedTimestamp = '2026-08-30T12:34:56.789Z';
      const fixedBackupPath = join(
        sidecarDirectory,
        'pre-migration-schema-1-20260830T123456789Z.sqlite3',
      );
      const sidecarPath = `${fixedBackupPath}-wal`;
      const unrelated = Buffer.from('unrelated sidecar');
      writeFileSync(sidecarPath, unrelated, { mode: 0o600 });
      globalThis.Date = class FixedDate extends originalDate {
        constructor(value?: string | number) {
          super(value ?? fixedTimestamp);
        }
      } as DateConstructor;
      try {
        assert.throws(() => createVerifiedMigrationBackup({
          database,
          backupDirectory: sidecarDirectory,
          key: createTestWorkspaceKey(0x7b),
          sourceSchemaVersion: 1,
        }));
      } finally {
        globalThis.Date = originalDate;
      }
      assert.equal(existsSync(fixedBackupPath), false);
      assert.deepEqual(readFileSync(sidecarPath), unrelated);
    } else if (scenario === 'path-replaced') {
      await migrateToLatest(database, { backupDirectory, workspaceKey: key });
      seedLargePayload(database);
      const raceDirectory = join(dirname(workspace.path), 'path-race-backups');
      mkdirSync(raceDirectory, { mode: 0o700 });
      const fixedBackupPath = join(
        raceDirectory,
        'pre-migration-schema-1-20260830T123456789Z.sqlite3',
      );
      const displacedPath = `${fixedBackupPath}.displaced`;
      const unrelated = Buffer.from('unrelated replacement');
      const watcher = spawnWatcher(
        fixedBackupPath,
        `fs.renameSync(watched, extra); fs.writeFileSync(watched, Buffer.from('unrelated replacement'), { mode: 0o600 });`,
        displacedPath,
      );
      const originalDate = installFixedDate();
      try {
        assert.throws(() => createVerifiedMigrationBackup({
          database,
          backupDirectory: raceDirectory,
          key,
          sourceSchemaVersion: 1,
        }), /Migration backup verification failed/);
      } finally {
        globalThis.Date = originalDate;
      }
      await assertWatcherSucceeded(watcher);
      assert.deepEqual(readFileSync(fixedBackupPath), unrelated);
      assert.equal(statSync(displacedPath).size, 0);
    } else if (scenario === 'sidecar-race') {
      await migrateToLatest(database, { backupDirectory, workspaceKey: key });
      seedLargePayload(database);
      const raceDirectory = join(dirname(workspace.path), 'sidecar-race-backups');
      mkdirSync(raceDirectory, { mode: 0o700 });
      const fixedBackupPath = join(
        raceDirectory,
        'pre-migration-schema-1-20260830T123456789Z.sqlite3',
      );
      const sidecarPath = `${fixedBackupPath}-wal`;
      const watcher = spawnWatcher(
        fixedBackupPath,
        `fs.writeFileSync(extra, Buffer.from('unrelated raced sidecar'), { flag: 'wx', mode: 0o600 });`,
        sidecarPath,
      );
      const originalDate = installFixedDate();
      try {
        assert.throws(() => createVerifiedMigrationBackup({
          database,
          backupDirectory: raceDirectory,
          key,
          sourceSchemaVersion: 1,
        }), /Migration backup verification failed/);
      } finally {
        globalThis.Date = originalDate;
      }
      await assertWatcherSucceeded(watcher);
      assert.equal(existsSync(fixedBackupPath), false);
      assert.deepEqual(
        readFileSync(sidecarPath),
        Buffer.from('unrelated raced sidecar'),
      );
    } else if (scenario === 'unlink-failure') {
      await migrateToLatest(database, { backupDirectory, workspaceKey: key });
      seedLargePayload(database);
      const raceDirectory = join(dirname(workspace.path), 'unlink-failure-backups');
      mkdirSync(raceDirectory, { mode: 0o700 });
      const fixedBackupPath = join(
        raceDirectory,
        'pre-migration-schema-1-20260830T123456789Z.sqlite3',
      );
      const watcher = spawnWatcher(
        fixedBackupPath,
        'fs.chmodSync(extra, 0o500);',
        raceDirectory,
      );
      const originalDate = installFixedDate();
      try {
        assert.throws(() => createVerifiedMigrationBackup({
          database,
          backupDirectory: raceDirectory,
          key: createTestWorkspaceKey(0x7b),
          sourceSchemaVersion: 1,
        }), /Migration backup verification failed/);
      } finally {
        globalThis.Date = originalDate;
        chmodSync(raceDirectory, 0o700);
      }
      await assertWatcherSucceeded(watcher);
      assert.equal(statSync(fixedBackupPath).size, 0);
    } else {
      assert.fail(`Unknown migration-backup scenario: ${scenario}`);
    }
  } finally {
    if (database !== undefined) {
      closeDatabase(database);
    }
    key.bytes.fill(0);
    workspace.cleanup();
  }
}

function installFixedDate(): DateConstructor {
  const originalDate = Date;
  const fixedTimestamp = '2026-08-30T12:34:56.789Z';
  globalThis.Date = class FixedDate extends originalDate {
    constructor(value?: string | number) {
      super(value ?? fixedTimestamp);
    }
  } as DateConstructor;
  return originalDate;
}

function seedLargePayload(database: AppDatabase): void {
  database.raw.prepare(
    'UPDATE jobs SET payload_json = zeroblob(?) WHERE id = ?',
  ).run(64 * 1024 * 1024, 'schema-one-sentinel');
  if (database.raw.prepare<[], { count: number }>(
    'SELECT COUNT(*) AS count FROM jobs',
  ).get()?.count === 0) {
    database.raw.prepare(`
      INSERT INTO jobs (
        id, type, state, payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, zeroblob(?), ?, ?)
    `).run(
      'large-backup-row',
      'test',
      'queued',
      64 * 1024 * 1024,
      '2026-08-30T00:00:00.000Z',
      '2026-08-30T00:00:00.000Z',
    );
  }
}

function spawnWatcher(
  watchedPath: string,
  action: string,
  extraPath: string,
): ChildProcess {
  const script = `
    const fs = require('node:fs');
    const [watched, extra] = process.argv.slice(1);
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(watched)) {
      if (Date.now() > deadline) process.exit(2);
    }
    ${action}
  `;
  return spawn(process.execPath, ['-e', script, watchedPath, extraPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function assertWatcherSucceeded(child: ChildProcess): Promise<void> {
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    },
  );
  assert.deepEqual({ ...result, stderr }, { code: 0, signal: null, stderr: '' });
}

function assertVerifiedBackup(
  backup: MigrationBackup,
  backupDirectory: string,
  key: Buffer,
  sourceSchemaVersion: number,
): void {
  assert.equal(dirname(backup.path), backupDirectory);
  assert.equal(backup.sourceSchemaVersion, sourceSchemaVersion);
  assert.match(
    basename(backup.path),
    /^pre-migration-schema-1-\d{8}T\d{9}Z\.sqlite3$/,
  );
  assert.match(backup.sha256, /^[a-f0-9]{64}$/);
  assert.equal(new Date(backup.verifiedAt).toISOString(), backup.verifiedAt);
  assert.equal(statSync(backupDirectory).mode & 0o777, 0o700);
  assert.equal(statSync(backup.path).mode & 0o777, 0o600);
  assert.notEqual(
    readFileSync(backup.path).subarray(0, 16).toString('utf8'),
    'SQLite format 3\0',
  );
  assert.equal(
    createHash('sha256').update(readFileSync(backup.path)).digest('hex'),
    backup.sha256,
  );
  assertBackupFile(backup.path, key, sourceSchemaVersion);
}

function assertBackupFile(
  path: string,
  key: Buffer,
  sourceSchemaVersion: number,
): void {
  assert.equal(existsSync(path), true);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.notEqual(
    readFileSync(path).subarray(0, 16).toString('utf8'),
    'SQLite format 3\0',
  );

  const raw = createRawDatabase(path, { readonly: true, fileMustExist: true });
  try {
    applyWorkspaceKey(raw, key);
    assert.equal(raw.pragma('integrity_check', { simple: true }), 'ok');
    if (sourceSchemaVersion === 0) {
      assert.equal(
        raw.prepare<[], { found: number }>(
          "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'app_meta'",
        ).get(),
        undefined,
      );
    } else {
      assert.deepEqual(
        raw.prepare<[], { schema_version: number }>(
          'SELECT schema_version FROM app_meta WHERE singleton = 1',
        ).get(),
        { schema_version: sourceSchemaVersion },
      );
    }
  } finally {
    raw.close();
  }
}

function listBackups(backupDirectory: string): string[] {
  if (!existsSync(backupDirectory)) {
    return [];
  }
  return readdirSync(backupDirectory)
    .sort()
    .map((entry) => join(backupDirectory, entry));
}

function readSchemaVersion(database: AppDatabase): number {
  const appMeta = database.raw
    .prepare<[], { found: number }>(
      "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'app_meta'",
    )
    .get();
  if (appMeta === undefined) {
    return 0;
  }
  return database.raw
    .prepare<[], { schema_version: number }>(
      'SELECT schema_version FROM app_meta WHERE singleton = 1',
    )
    .get()?.schema_version ?? -1;
}
