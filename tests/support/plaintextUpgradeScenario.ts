import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { Kysely, SqliteDialect } from 'kysely';

import {
  closeDatabase,
  openDatabase,
  type AppDatabase,
} from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import {
  prepareEncryptedDatabase,
  plaintextUpgradePaths,
} from '../../src/main/db/plaintextDatabaseUpgrade';
import { createRawDatabase } from '../../src/main/db/sqliteDriver';
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
void runScenario();

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
    } else if (scenario === 'path-mismatched-marker') {
      await assertMismatchedMarkerIsImmutable(workspace.path);
    } else {
      assert.fail(`Unknown conversion scenario: ${scenario}`);
    }
  } finally {
    workspace.cleanup();
  }
}

async function createPlaintextSchemaOne(databasePath: string): Promise<void> {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const raw = createRawDatabase(databasePath);
  const kysely = new Kysely<FoundationDatabase>({
    dialect: new SqliteDialect({ database: raw }),
  });
  const plaintext: AppDatabase = { raw, kysely, path: databasePath };
  try {
    raw.pragma('journal_mode = WAL');
    await migrateToLatest(plaintext);
    insertRetainedRow(raw);
  } finally {
    raw.close();
  }
}

async function createEncryptedSchemaOne(databasePath: string): Promise<void> {
  const encrypted = openDatabase({
    path: databasePath,
    key: createTestWorkspaceKey(),
  });
  try {
    await migrateToLatest(encrypted);
    insertRetainedRow(encrypted.raw);
  } finally {
    closeDatabase(encrypted);
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
    const rowCounts = readRowCounts(plaintextPath);
    await createEncryptedSchemaOne(encryptedPath);
    const fixtures = {
      plaintext: readFileSync(plaintextPath),
      encrypted: readFileSync(encryptedPath),
    };
    writeCandidate(databasePath, state.canonical, fixtures);
    writeCandidate(paths.encrypting, state.encrypting, fixtures);
    writeCandidate(paths.recovery, state.recovery, fixtures);
    if (state.marker) {
      writeFileSync(paths.marker, validMarker(databasePath, rowCounts));
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

function readRowCounts(databasePath: string): Record<string, number> {
  const raw = createRawDatabase(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const tables = raw.prepare<[], { name: string }>(`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
    `).all();
    const query = tables.map(({ name }) => {
      const escaped = name.replaceAll('"', '""');
      return `SELECT ? AS name, COUNT(*) AS count FROM "${escaped}"`;
    }).join(' UNION ALL ');
    const counts = raw.prepare<string[], { name: string; count: number }>(
      query,
    ).all(...tables.map(({ name }) => name));
    return Object.fromEntries(counts.map(({ name, count }) => [name, count]));
  } finally {
    raw.close();
  }
}

function assertEncryptedRetainedRow(databasePath: string): void {
  assert.notEqual(
    readFileSync(databasePath).subarray(0, 16).toString('utf8'),
    'SQLite format 3\u0000',
  );
  const reopened = openDatabase({
    path: databasePath,
    key: createTestWorkspaceKey(),
  });
  try {
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
  writeFileSync(paths.marker, validMarker(databasePath, { jobs: 1 }));
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
  await createEncryptedSchemaOne(databasePath);
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
    { jobs: 1 },
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
  rowCounts: Record<string, number>,
): string {
  return JSON.stringify({
    format: 'callie-plaintext-encryption-upgrade',
    version: 1,
    canonicalPath: databasePath,
    schemaVersion: 1,
    rowCounts,
  });
}
