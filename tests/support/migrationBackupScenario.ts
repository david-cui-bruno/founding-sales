import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  closeDatabase,
  openDatabase,
  type AppDatabase,
} from '../../src/main/db/database';
import {
  createVerifiedMigrationBackup,
  type MigrationBackup,
} from '../../src/main/db/migrationBackup';
import { migrateToLatest } from '../../src/main/db/migrate';
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
