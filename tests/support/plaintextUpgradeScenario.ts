import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

import { Kysely, SqliteDialect } from 'kysely';
// The project intentionally uses TypeScript's legacy Node resolver, which cannot
// type-resolve Kysely's package-exported migration entrypoint.
// @ts-expect-error -- The runtime subpath is exported by Kysely and exercised here.
import { Migrator } from 'kysely/migration'; // eslint-disable-line import/no-unresolved -- Kysely exports this runtime subpath.

import {
  closeDatabase,
  openDatabase,
} from '../../src/main/db/database';
import { createMigrationRunner, migrateToLatest, productionMigrations } from '../../src/main/db/migrate';
import { migration0001Foundation } from '../../src/main/db/migrations/0001Foundation';
import {
  encryptedWorkspaceExists,
  prepareEncryptedDatabase,
  plaintextUpgradePaths,
  readAndVerifyDatabaseFingerprint,
} from '../../src/main/db/plaintextDatabaseUpgrade';
import { applyWorkspaceKey, createRawDatabase } from '../../src/main/db/sqliteDriver';
import type { FoundationDatabase } from '../../src/main/db/schema';
import {
  createTempDatabase,
  createTestWorkspaceKey,
} from '../fixtures/tempDatabase';

type CandidateKind = 'absent' | 'plaintext' | 'encrypted' | 'invalid';
type CandidateState = {
  canonical: CandidateKind;
  encrypting: CandidateKind;
  recovery: Exclude<CandidateKind, 'encrypted'>;
  marker: boolean;
};

const states: Record<string, CandidateState> = {
  'temp-before-marker': {
    canonical: 'plaintext', encrypting: 'encrypted', recovery: 'absent', marker: false,
  },
  'marker-before-rename': {
    canonical: 'plaintext', encrypting: 'encrypted', recovery: 'absent', marker: true,
  },
  'recovery-before-promotion': {
    canonical: 'absent', encrypting: 'encrypted', recovery: 'plaintext', marker: true,
  },
  'promotion-before-marker-cleanup': {
    canonical: 'encrypted', encrypting: 'absent', recovery: 'plaintext', marker: true,
  },
  'marker-before-recovery-cleanup': {
    canonical: 'encrypted', encrypting: 'absent', recovery: 'plaintext', marker: false,
  },
  'only-encrypting': {
    canonical: 'absent', encrypting: 'encrypted', recovery: 'absent', marker: true,
  },
  'only-recovery': {
    canonical: 'absent', encrypting: 'absent', recovery: 'plaintext', marker: true,
  },
  'partial-copy': {
    canonical: 'plaintext', encrypting: 'plaintext', recovery: 'absent', marker: false,
  },
  'invalid-temp-with-recovery': {
    canonical: 'absent', encrypting: 'invalid', recovery: 'plaintext', marker: true,
  },
};

const scenario = process.argv[2];
assert.ok(scenario, 'A conversion scenario is required.');
if (scenario === 'crash-rekey-child') {
  crashDuringRekey(process.argv[3]);
} else if (scenario === 'writer-after-copy-child') {
  writeAfterCopy(process.argv[3]);
} else {
  void runScenario();
}

async function runScenario(): Promise<void> {
  const workspace = createTempDatabase();
  try {
    if (scenario === 'conversion') {
      await createPlaintextSchemaOne(workspace.path);
      await prepareEncryptedDatabase(workspace.path, createTestWorkspaceKey());
      assertEncryptedRetainedRow(workspace.path);
      assertArtifactsAbsent(workspace.path);
    } else if (scenario in states) {
      await arrangeCandidateState(workspace.path, states[scenario]);
      await prepareEncryptedDatabase(workspace.path, createTestWorkspaceKey());
      assertEncryptedRetainedRow(workspace.path);
      assertArtifactsAbsent(workspace.path);
    } else if (scenario === 'all-invalid') {
      await assertAllInvalidCopiesArePreserved(workspace.path);
    } else if (scenario === 'wrong-key') {
      await assertWrongKeyIsImmutable(workspace.path);
    } else if (scenario === 'encrypted-current-schema-reopen') {
      await createEncryptedLatestSchema(workspace.path);
      const before = readEncryptedFingerprint(workspace.path, 21);
      await prepareEncryptedDatabase(workspace.path, createTestWorkspaceKey());
      // WAL stabilization intentionally changes physical pages/journal mode,
      // but must preserve the exact schema and logical content fingerprint.
      assert.deepEqual(readEncryptedFingerprint(workspace.path, 21), before);
      assertEncryptedRetainedRow(workspace.path, 21);
      assertArtifactsAbsent(workspace.path);
    } else if (scenario === 'encrypted-schema-13-reopen') {
      await assertEncryptedSchemaVersionAccepted(workspace.path, 13);
    } else if (scenario === 'encrypted-schema-14-reopen') {
      await assertEncryptedSchemaVersionAccepted(workspace.path, 14);
    } else if (scenario === 'encrypted-schema-15-reopen') {
      await assertEncryptedSchemaVersionAccepted(workspace.path, 15);
    } else if (scenario === 'encrypted-schema-16-reopen') {
      await assertEncryptedSchemaVersionAccepted(workspace.path, 16);
    } else if (scenario === 'encrypted-schema-17-reopen') {
      await assertEncryptedSchemaVersionAccepted(workspace.path, 17);
    } else if (scenario === 'encrypted-schema-18-reopen') {
      await assertEncryptedSchemaVersionAccepted(workspace.path, 18);
    } else if (scenario === 'encrypted-schema-19-reopen') {
      await assertEncryptedSchemaVersionAccepted(workspace.path, 19);
    } else if (scenario === 'encrypted-schema-20-reopen') {
      await assertEncryptedSchemaVersionAccepted(workspace.path, 20);
    } else if (scenario === 'encrypted-schema-21-reopen') {
      await assertEncryptedSchemaVersionAccepted(workspace.path, 21);
    } else if (scenario === 'encrypted-schema-22-rejected') {
      await assertEncryptedSchemaVersionRejected(workspace.path, 22);
    } else if (scenario === 'encrypted-schema-future-rejected') {
      await assertEncryptedSchemaVersionRejected(workspace.path, 99);
    } else if (scenario === 'path-mismatched-marker') {
      await assertMismatchedMarkerIsImmutable(workspace.path);
    } else if (scenario === 'busy-wal') {
      await assertBusyWalAbortsWithoutPromotion(workspace.path);
    } else if (scenario === 'semantic-content-mismatch') {
      await assertSemanticMismatchIsRejected(workspace.path, 'content');
    } else if (scenario === 'semantic-schema-mismatch') {
      await assertSemanticMismatchIsRejected(workspace.path, 'schema');
    } else if (scenario === 'kill-after-rekey') {
      await assertKillAfterRekeyRecovers(workspace.path);
    } else if (scenario === 'sidecar-only-exists') {
      assertSidecarOnlyWorkspaceExists(workspace.path);
    } else if (scenario === 'writer-after-copy') {
      await assertWriterAfterCopyCannotBeLost(workspace.path);
    } else if (scenario === 'pathname-replaced-after-copy') {
      await assertPathnameReplacementCannotBeLost(workspace.path);
    } else if (scenario === 'pathname-created-during-promotion') {
      await assertPromotionPathOccupantCannotBeLost(workspace.path);
    } else {
      assert.fail(`Unknown conversion scenario: ${scenario}`);
    }
  } finally {
    workspace.cleanup();
  }
}

async function assertPromotionPathOccupantCannotBeLost(
  databasePath: string,
): Promise<void> {
  await createPlaintextSchemaOne(databasePath);
  const replacementPath = `${databasePath}.replacement`;
  await createPlaintextSchemaOne(replacementPath);
  setRetainedPayload(replacementPath, '{"promotion":"new"}');

  let hookRan = false;
  await assert.rejects(prepareEncryptedDatabase(
    databasePath,
    createTestWorkspaceKey(),
    {
      afterPlaintextDisplaced: () => {
        renameSync(replacementPath, databasePath);
        hookRan = true;
      },
    },
  ), /canonical path is occupied/);
  assert.equal(hookRan, true);
  assertPlaintextPayload(databasePath, '{"promotion":"new"}');

  await prepareEncryptedDatabase(databasePath, createTestWorkspaceKey());
  assertEncryptedPayload(databasePath, '{"promotion":"new"}');
  assertArtifactsAbsent(databasePath);
}

async function assertPathnameReplacementCannotBeLost(
  databasePath: string,
): Promise<void> {
  await createPlaintextSchemaOne(databasePath);
  const replacementPath = `${databasePath}.replacement`;
  await createPlaintextSchemaOne(replacementPath);
  setRetainedPayload(replacementPath, '{"pathname":"new"}');

  let hookRan = false;
  await assert.rejects(prepareEncryptedDatabase(
    databasePath,
    createTestWorkspaceKey(),
    {
      afterPlaintextCopy: () => {
        renameSync(replacementPath, databasePath);
        hookRan = true;
      },
    },
  ), /source identity changed/);
  assert.equal(hookRan, true);
  assertPlaintextPayload(databasePath, '{"pathname":"new"}');

  await prepareEncryptedDatabase(databasePath, createTestWorkspaceKey());
  assertEncryptedPayload(databasePath, '{"pathname":"new"}');
  assertArtifactsAbsent(databasePath);
}

function setRetainedPayload(databasePath: string, payload: string): void {
  const raw = createRawDatabase(databasePath, { fileMustExist: true });
  try {
    raw.prepare('UPDATE jobs SET payload_json = ? WHERE id = ?')
      .run(payload, 'kept');
    raw.pragma('wal_checkpoint(TRUNCATE)');
    const journalMode = raw.pragma('journal_mode = DELETE', { simple: true });
    assert.equal(journalMode, 'delete');
  } finally {
    raw.close();
  }
}

function assertPlaintextPayload(databasePath: string, payload: string): void {
  assert.equal(
    readFileSync(databasePath).subarray(0, 16).toString('utf8'),
    'SQLite format 3\u0000',
  );
  const raw = createRawDatabase(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    assert.deepEqual(
      raw.prepare('SELECT payload_json FROM jobs WHERE id = ?').get('kept'),
      { payload_json: payload },
    );
  } finally {
    raw.close();
  }
}

function assertEncryptedPayload(databasePath: string, payload: string): void {
  const encrypted = openDatabase({
    path: databasePath,
    key: createTestWorkspaceKey(),
  });
  try {
    assert.deepEqual(
      encrypted.raw.prepare('SELECT payload_json FROM jobs WHERE id = ?').get('kept'),
      { payload_json: payload },
    );
  } finally {
    closeDatabase(encrypted);
  }
}

async function assertWriterAfterCopyCannotBeLost(
  databasePath: string,
): Promise<void> {
  await createPlaintextSchemaOne(databasePath);
  const seed = createRawDatabase(databasePath, { fileMustExist: true });
  try {
    seed.exec('CREATE TABLE conversion_lock_probe (payload BLOB NOT NULL)');
    seed.prepare('INSERT INTO conversion_lock_probe (payload) VALUES (?)')
      .run(Buffer.alloc(16 * 1024 * 1024, 0x5a));
    seed.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    seed.close();
  }
  const paths = plaintextUpgradePaths(databasePath);
  let writerResult: ReturnType<typeof spawnSync> | undefined;
  await prepareEncryptedDatabase(
    databasePath,
    createTestWorkspaceKey(),
    {
      afterPlaintextCopy: () => {
        writerResult = spawnSync(process.execPath, [
          process.argv[1],
          'writer-after-copy-child',
          databasePath,
        ], {
          cwd: process.cwd(),
          encoding: 'utf8',
          timeout: 10_000,
        });
      },
    },
  );
  assert.ok(writerResult, 'The plaintext-copy fault hook did not run.');
  assert.equal(writerResult.status, 0);
  assert.equal(writerResult.signal, null);
  assert.equal(writerResult.stdout, 'BLOCKED\n');
  assert.equal(writerResult.stderr, '');

  assert.notEqual(
    readFileSync(databasePath).subarray(0, 16).toString('utf8'),
    'SQLite format 3\u0000',
  );
  const encrypted = openDatabase({
    path: databasePath,
    key: createTestWorkspaceKey(),
  });
  try {
    assert.deepEqual(
      encrypted.raw.prepare('SELECT payload_json FROM jobs WHERE id = ?').get('kept'),
      { payload_json: '{}' },
    );
  } finally {
    closeDatabase(encrypted);
  }
  assert.equal(existsSync(paths.encrypting), false);
  assert.equal(existsSync(paths.marker), false);
  assert.equal(existsSync(paths.recovery), false);
}

function writeAfterCopy(
  databasePath: string | undefined,
): never {
  assert.ok(databasePath, 'Writer database path is required.');
  const raw = createRawDatabase(databasePath, { fileMustExist: true });
  try {
    raw.pragma('busy_timeout = 0');
    try {
      raw.prepare('UPDATE jobs SET payload_json = ? WHERE id = ?')
        .run('{"writer":"new"}', 'kept');
    } catch (error) {
      if (
        error instanceof Error
        && 'code' in error
        && (error as NodeJS.ErrnoException).code === 'SQLITE_BUSY'
      ) {
        process.stdout.write('BLOCKED\n');
        process.exit(0);
      }
      throw error;
    }
  } finally {
    raw.close();
  }
  process.stdout.write('COMMITTED\n');
  process.exit(0);
}

async function assertBusyWalAbortsWithoutPromotion(
  databasePath: string,
): Promise<void> {
  await createPlaintextSchemaOne(databasePath);
  const writer = createRawDatabase(databasePath, { fileMustExist: true });
  const reader = createRawDatabase(databasePath, { fileMustExist: true });
  try {
    reader.exec('BEGIN');
    assert.deepEqual(
      reader.prepare('SELECT payload_json FROM jobs WHERE id = ?').get('kept'),
      { payload_json: '{}' },
    );
    writer.prepare('UPDATE jobs SET payload_json = ? WHERE id = ?')
      .run('{"current":true}', 'kept');
    const paths = plaintextUpgradePaths(databasePath);
    const before = snapshotExisting([
      databasePath,
      `${databasePath}-wal`,
    ]);
    const shmExisted = existsSync(`${databasePath}-shm`);

    await assert.rejects(
      prepareEncryptedDatabase(databasePath, createTestWorkspaceKey()),
      /checkpoint|locked|busy/i,
    );

    assertSnapshotUnchanged(before);
    assert.equal(existsSync(`${databasePath}-shm`), shmExisted);
    assert.equal(existsSync(paths.encrypting), false);
    assert.equal(existsSync(paths.marker), false);
    assert.equal(existsSync(paths.recovery), false);
  } finally {
    reader.exec('ROLLBACK');
    reader.close();
    writer.close();
  }

  await prepareEncryptedDatabase(databasePath, createTestWorkspaceKey());
  const reopened = openDatabase({
    path: databasePath,
    key: createTestWorkspaceKey(),
  });
  try {
    assert.deepEqual(
      reopened.raw.prepare('SELECT payload_json FROM jobs WHERE id = ?').get('kept'),
      { payload_json: '{"current":true}' },
    );
  } finally {
    closeDatabase(reopened);
  }
}

async function assertSemanticMismatchIsRejected(
  databasePath: string,
  mismatch: 'content' | 'schema',
): Promise<void> {
  await createPlaintextSchemaOne(databasePath);
  addSemanticProbe(databasePath, 'canonical', 'nullable_index');
  const seed = createTempDatabase();
  const paths = plaintextUpgradePaths(databasePath);
  try {
    await createPlaintextSchemaOne(seed.path);
    addSemanticProbe(
      seed.path,
      mismatch === 'content' ? 'candidate' : 'canonical',
      mismatch === 'schema' ? 'blob_index' : 'nullable_index',
    );
    await prepareEncryptedDatabase(seed.path, createTestWorkspaceKey());
    copyFileSync(seed.path, paths.encrypting);

    const before = snapshotExisting([databasePath, paths.encrypting]);
    await assert.rejects(
      prepareEncryptedDatabase(databasePath, createTestWorkspaceKey()),
      /do not match/,
    );
    assertSnapshotUnchanged(before);
  } finally {
    seed.cleanup();
  }
}

function addSemanticProbe(
  databasePath: string,
  value: 'canonical' | 'candidate',
  index: 'nullable_index' | 'blob_index',
): void {
  const raw = createRawDatabase(databasePath, { fileMustExist: true });
  try {
    raw.exec(`
      CREATE TABLE semantic_probe (
        id INTEGER PRIMARY KEY,
        nullable_value TEXT,
        blob_value BLOB NOT NULL
      );
      CREATE VIRTUAL TABLE semantic_probe_fts USING fts5(body);
      CREATE INDEX ${index} ON semantic_probe(
        ${index === 'nullable_index' ? 'nullable_value' : 'blob_value'}
      );
    `);
    raw.prepare(`
      INSERT INTO semantic_probe (id, nullable_value, blob_value)
      VALUES (?, ?, ?)
    `).run(
      1,
      value === 'canonical' ? null : 'not-null',
      Buffer.from(value === 'canonical' ? [0x00, 0xff] : [0xff, 0x00]),
    );
    raw.prepare('INSERT INTO semantic_probe_fts (body) VALUES (?)')
      .run(value === 'canonical' ? 'current visible text' : 'stale visible text');
    raw.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    raw.close();
  }
}

async function assertKillAfterRekeyRecovers(databasePath: string): Promise<void> {
  await createPlaintextSchemaOne(databasePath);
  const paths = plaintextUpgradePaths(databasePath);
  const raw = createRawDatabase(databasePath, { fileMustExist: true });
  try {
    const result = raw.pragma('wal_checkpoint(TRUNCATE)');
    assert.deepEqual(result, [{ busy: 0, log: 0, checkpointed: 0 }]);
  } finally {
    raw.close();
  }
  copyFileSync(databasePath, paths.encrypting);

  const crash = spawnSync(process.execPath, [
    process.argv[1],
    'crash-rekey-child',
    paths.encrypting,
  ], { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 });
  assert.equal(crash.status, null);
  assert.equal(crash.signal, 'SIGKILL');
  assert.equal(
    [`${paths.encrypting}-wal`, `${paths.encrypting}-shm`, `${paths.encrypting}-journal`]
      .some(existsSync),
    true,
  );

  await prepareEncryptedDatabase(databasePath, createTestWorkspaceKey());
  assertEncryptedRetainedRow(databasePath);
  assertArtifactsAbsent(databasePath);
  assertNoDatabaseSidecars(databasePath);
  assertNoDatabaseSidecars(paths.encrypting);
  assertNoDatabaseSidecars(paths.recovery);
}

function crashDuringRekey(path: string | undefined): never {
  assert.ok(path, 'Crash-rekey path is required.');
  const raw = createRawDatabase(path, { fileMustExist: true });
  raw.pragma("cipher='sqlcipher'");
  raw.pragma('legacy=4');
  raw.pragma(`rekey="x'${createTestWorkspaceKey().bytes.toString('hex')}'"`);
  process.kill(process.pid, 'SIGKILL');
  throw new Error('SIGKILL did not terminate the rekey child.');
}

function assertSidecarOnlyWorkspaceExists(databasePath: string): void {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  writeFileSync(`${databasePath}.encrypting-wal`, 'synthetic interrupted sidecar');
  assert.equal(encryptedWorkspaceExists(databasePath), true);
}

function databaseSidecars(path: string): string[] {
  return [`${path}-wal`, `${path}-shm`, `${path}-journal`];
}

function assertNoDatabaseSidecars(path: string): void {
  for (const sidecar of databaseSidecars(path)) {
    assert.equal(existsSync(sidecar), false, `orphan sidecar: ${sidecar}`);
  }
}

function snapshotExisting(paths: string[]): Map<string, Buffer> {
  return new Map(paths.filter(existsSync).map((path) => [path, readFileSync(path)]));
}

function assertSnapshotUnchanged(snapshot: Map<string, Buffer>): void {
  for (const [path, contents] of snapshot) {
    assert.deepEqual(readFileSync(path), contents, `changed unexpectedly: ${path}`);
  }
}

async function createPlaintextSchemaOne(databasePath: string): Promise<void> {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const raw = createRawDatabase(databasePath);
  const kysely = new Kysely<FoundationDatabase>({
    dialect: new SqliteDialect({ database: raw }),
  });
  try {
    raw.pragma('journal_mode = WAL');
    const migrator = new Migrator({
      db: kysely,
      provider: {
        async getMigrations() {
          return { '0001Foundation': migration0001Foundation };
        },
      },
    });
    const result = await migrator.migrateToLatest();
    assert.equal(result.error, undefined);
    insertRetainedRow(raw);
  } finally {
    raw.close();
  }
}

async function createEncryptedLatestSchema(databasePath: string): Promise<void> {
  const key = createTestWorkspaceKey();
  const encrypted = openDatabase({
    path: databasePath,
    key,
  });
  try {
    await migrateToLatest(encrypted, {
      backupDirectory: `${databasePath}.backups`,
      workspaceKey: key,
    });
    insertRetainedRow(encrypted.raw);
  } finally {
    closeDatabase(encrypted);
  }
}

async function createEncryptedSchemaVersion(
  databasePath: string,
  schemaVersion: number,
): Promise<void> {
  const key = createTestWorkspaceKey();
  const encrypted = openDatabase({ path: databasePath, key });
  try {
    const supported = productionMigrations.some(entry => entry.schemaVersion === schemaVersion);
    await createMigrationRunner(productionMigrations.filter(entry => !supported || entry.schemaVersion <= schemaVersion))(
      encrypted, { backupDirectory: `${databasePath}.backups`, workspaceKey: key },
    );
    insertRetainedRow(encrypted.raw);
    if (supported) {
      assert.deepEqual(encrypted.raw.prepare('SELECT schema_version FROM app_meta WHERE singleton = 1').get(),
        { schema_version: schemaVersion });
    } else {
      // Only the deliberately unsupported-version corruption fixture rewrites metadata.
      encrypted.raw.prepare('UPDATE app_meta SET schema_version = ? WHERE singleton = 1').run(schemaVersion);
    }
    encrypted.raw.pragma('wal_checkpoint(TRUNCATE)');
    const journalMode = encrypted.raw.pragma(
      'journal_mode = DELETE',
      { simple: true },
    );
    assert.equal(journalMode, 'delete');
  } finally {
    closeDatabase(encrypted);
    key.bytes.fill(0);
  }
}

async function assertEncryptedSchemaVersionAccepted(
  databasePath: string,
  schemaVersion: 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21,
): Promise<void> {
  await createEncryptedSchemaVersion(databasePath, schemaVersion);
  const before = readFileSync(databasePath);
  await prepareEncryptedDatabase(databasePath, createTestWorkspaceKey());
  assert.deepEqual(readFileSync(databasePath), before);
  assertEncryptedRetainedRow(databasePath, schemaVersion);
  assertArtifactsAbsent(databasePath);
}

async function assertEncryptedSchemaVersionRejected(
  databasePath: string,
  schemaVersion: number,
): Promise<void> {
  await createEncryptedSchemaVersion(databasePath, schemaVersion);
  const paths = plaintextUpgradePaths(databasePath);
  const artifactBytes = new Map([
    [paths.encrypting, Buffer.from('existing-encrypting-artifact')],
    [paths.recovery, Buffer.from('existing-recovery-artifact')],
  ]);
  for (const [path, bytes] of artifactBytes) writeFileSync(path, bytes);
  const before = readFileSync(databasePath);
  await assert.rejects(
    prepareEncryptedDatabase(databasePath, createTestWorkspaceKey()),
    /No valid database copy is available/,
  );
  assert.deepEqual(readFileSync(databasePath), before);
  for (const [path, bytes] of artifactBytes) {
    assert.deepEqual(readFileSync(path), bytes);
  }
}

function insertRetainedRow(raw: ReturnType<typeof createRawDatabase>): void {
  raw.prepare(`
    INSERT INTO jobs (
      id, type, state, payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    'kept',
    'test',
    'queued',
    '{}',
    '2026-08-30T12:00:00.000Z',
    '2026-08-30T12:00:00.000Z',
  );
}

async function arrangeCandidateState(
  databasePath: string,
  state: CandidateState,
): Promise<void> {
  const paths = plaintextUpgradePaths(databasePath);
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const seed = createTempDatabase();
  const plaintextPath = `${seed.path}.plaintext`;
  const encryptedPath = `${seed.path}.encrypted`;
  try {
    await createPlaintextSchemaOne(plaintextPath);
    const fingerprint = readFingerprint(plaintextPath);
    copyFileSync(plaintextPath, encryptedPath);
    await prepareEncryptedDatabase(encryptedPath, createTestWorkspaceKey());
    const fixtures = {
      plaintext: readFileSync(plaintextPath),
      encrypted: readFileSync(encryptedPath),
    };
    writeCandidate(databasePath, state.canonical, fixtures);
    writeCandidate(paths.encrypting, state.encrypting, fixtures);
    writeCandidate(paths.recovery, state.recovery, fixtures);
    if (state.marker) {
      writeFileSync(paths.marker, validMarker(databasePath, fingerprint));
      chmodSync(paths.marker, 0o600);
    }
  } finally {
    seed.cleanup();
  }
}

function writeCandidate(
  path: string,
  kind: CandidateKind,
  fixtures: { plaintext: Buffer; encrypted: Buffer },
): void {
  rmSync(path, { force: true });
  if (kind === 'plaintext') writeFileSync(path, fixtures.plaintext);
  if (kind === 'encrypted') writeFileSync(path, fixtures.encrypted);
  if (kind === 'invalid') writeFileSync(path, `invalid:${path}`);
}

function readFingerprint(databasePath: string) {
  const raw = createRawDatabase(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return readAndVerifyDatabaseFingerprint(raw);
  } finally {
    raw.close();
  }
}

function readEncryptedFingerprint(databasePath: string, schemaVersion: number) {
  const raw = createRawDatabase(databasePath, { readonly: true, fileMustExist: true });
  const key = createTestWorkspaceKey();
  try {
    applyWorkspaceKey(raw, key.bytes);
    return readAndVerifyDatabaseFingerprint(raw, [schemaVersion]);
  } finally {
    raw.close();
    key.bytes.fill(0);
  }
}

function assertEncryptedRetainedRow(databasePath: string, schemaVersion = 1): void {
  assert.notEqual(
    readFileSync(databasePath).subarray(0, 16).toString('utf8'),
    'SQLite format 3\u0000',
  );
  const reopened = openDatabase({
    path: databasePath,
    key: createTestWorkspaceKey(),
  });
  try {
    assert.deepEqual(reopened.raw.prepare('SELECT schema_version FROM app_meta WHERE singleton = 1').get(),
      { schema_version: schemaVersion });
    assert.deepEqual(
      reopened.raw.prepare('SELECT id FROM jobs WHERE id = ?').get('kept'),
      { id: 'kept' },
    );
  } finally {
    closeDatabase(reopened);
  }
}

function assertArtifactsAbsent(databasePath: string): void {
  const paths = plaintextUpgradePaths(databasePath);
  assert.equal(existsSync(paths.encrypting), false);
  assert.equal(existsSync(paths.recovery), false);
  assert.equal(existsSync(paths.marker), false);
}

async function assertAllInvalidCopiesArePreserved(
  databasePath: string,
): Promise<void> {
  const paths = plaintextUpgradePaths(databasePath);
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  writeFileSync(databasePath, 'invalid canonical');
  writeFileSync(paths.encrypting, 'invalid encrypting');
  writeFileSync(paths.recovery, 'invalid recovery');
  writeFileSync(paths.marker, JSON.stringify({
    format: 'callie-plaintext-encryption-upgrade',
    version: 1,
    canonicalPath: databasePath,
    schemaVersion: 1,
    rowCounts: { jobs: 1 },
    contentDigest: '0'.repeat(64),
  }));
  chmodSync(paths.marker, 0o600);
  const before = new Map([
    [databasePath, readFileSync(databasePath)],
    [paths.encrypting, readFileSync(paths.encrypting)],
    [paths.recovery, readFileSync(paths.recovery)],
    [paths.marker, readFileSync(paths.marker)],
  ]);
  await assert.rejects(
    prepareEncryptedDatabase(databasePath, createTestWorkspaceKey()),
  );
  for (const [path, contents] of before) {
    assert.deepEqual(readFileSync(path), contents);
  }
}

async function assertWrongKeyIsImmutable(databasePath: string): Promise<void> {
  await createEncryptedLatestSchema(databasePath);
  const before = readFileSync(databasePath);
  await assert.rejects(prepareEncryptedDatabase(
    databasePath,
    createTestWorkspaceKey(0x7b),
  ));
  assert.deepEqual(readFileSync(databasePath), before);
  assertArtifactsAbsent(databasePath);
}

async function assertMismatchedMarkerIsImmutable(
  databasePath: string,
): Promise<void> {
  await createPlaintextSchemaOne(databasePath);
  const paths = plaintextUpgradePaths(databasePath);
  writeFileSync(paths.marker, validMarker(
    '/tmp/not-this-workspace.sqlite3',
    readFingerprint(databasePath),
  ));
  chmodSync(paths.marker, 0o600);
  const before = readFileSync(databasePath);
  await assert.rejects(
    prepareEncryptedDatabase(databasePath, createTestWorkspaceKey()),
    /encryption state marker/,
  );
  assert.deepEqual(readFileSync(databasePath), before);
  assert.equal(existsSync(paths.marker), true);
}

function validMarker(
  databasePath: string,
  fingerprint: ReturnType<typeof readFingerprint>,
): string {
  return JSON.stringify({
    format: 'callie-plaintext-encryption-upgrade',
    version: 1,
    canonicalPath: databasePath,
    schemaVersion: 1,
    rowCounts: fingerprint.rowCounts,
    contentDigest: fingerprint.contentDigest,
  });
}
