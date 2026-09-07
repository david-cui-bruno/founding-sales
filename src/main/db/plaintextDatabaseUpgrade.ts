import { createHash, randomUUID, type Hash } from 'node:crypto';
import { lstatSync, type Stats } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import type { WorkspaceKey } from '../security/workspaceKeyTypes';
import { applyWorkspaceKey, createRawDatabase } from './sqliteDriver';

const PLAINTEXT_HEADER = Buffer.from('SQLite format 3\u0000', 'utf8');
/**
 * Every schema version a healthy encrypted workspace may legitimately hold
 * before migration runs. Extend this list with each registered migration.
 */
const KNOWN_SCHEMA_VERSIONS: readonly number[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
];
const STATE_MARKER_FORMAT = 'callie-plaintext-encryption-upgrade';
const MAX_MARKER_BYTES = 64 * 1024;
const DATABASE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

export type PlaintextUpgradePaths = {
  encrypting: string;
  recovery: string;
  marker: string;
};

export type PlaintextUpgradeHooks = {
  afterPlaintextCopy?(): Promise<void> | void;
  afterPlaintextDisplaced?(): Promise<void> | void;
};

class SourcePathIdentityChangedError extends Error {
  constructor() {
    super('Plaintext database source identity changed.');
  }
}

export type DatabaseFingerprint = {
  schemaVersion: number;
  rowCounts: Record<string, number>;
  contentDigest: string;
};

type UpgradeMarker = DatabaseFingerprint & {
  format: typeof STATE_MARKER_FORMAT;
  version: 1;
  canonicalPath: string;
};

type Candidate =
  | { kind: 'absent'; path: string }
  | { kind: 'invalid'; path: string }
  | ({ kind: 'plaintext'; path: string } & DatabaseFingerprint)
  | ({ kind: 'encrypted'; path: string } & DatabaseFingerprint);

export const plaintextUpgradePaths = (
  databasePath: string,
): PlaintextUpgradePaths => ({
  encrypting: `${databasePath}.encrypting`,
  recovery: `${databasePath}.plaintext-recovery`,
  marker: `${databasePath}.encryption-state.json`,
});

export const encryptedWorkspaceExists = (databasePath: string): boolean => {
  const paths = plaintextUpgradePaths(databasePath);
  return [
    ...databaseArtifactPaths(databasePath),
    ...databaseArtifactPaths(paths.encrypting),
    ...databaseArtifactPaths(paths.recovery),
    paths.marker,
  ]
    .some(pathExistsWithoutFollowingLinks);
};

const databaseArtifactPaths = (databasePath: string): string[] => [
  databasePath,
  ...DATABASE_SIDECAR_SUFFIXES.map((suffix) => `${databasePath}${suffix}`),
];

function pathExistsWithoutFollowingLinks(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

export async function prepareEncryptedDatabase(
  databasePath: string,
  key: WorkspaceKey,
  hooks: PlaintextUpgradeHooks = {},
): Promise<void> {
  assertUpgradeInput(databasePath, key);
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
  await chmod(dirname(databasePath), 0o700);

  const paths = plaintextUpgradePaths(databasePath);
  const marker = await readMarker(paths.marker, databasePath);
  const candidates = await inspectCandidates(databasePath, paths, key.bytes);

  if (
    marker !== undefined
    && candidates.canonical.kind === 'plaintext'
    && !fingerprintsEqual(candidates.canonical, marker)
  ) {
    await removeDatabaseArtifacts(paths.encrypting);
    await removeDatabaseArtifacts(paths.recovery);
    await removeIfPresent(paths.marker);
    return prepareEncryptedDatabase(databasePath, key, hooks);
  }

  if (candidates.canonical.kind === 'encrypted') {
    const stabilized = await stabilizeEncryptedCandidate(
      databasePath,
      key.bytes,
    );
    if (!fingerprintsEqual(candidates.canonical, stabilized)) {
      throw new Error('Encrypted canonical stabilization failed.');
    }
    await cleanAfterVerifiedPromotion(paths);
    return;
  }

  const inspectedEncrypting = candidates.encrypting.kind === 'encrypted'
    ? candidates.encrypting
    : undefined;
  const validPlaintext = selectPlaintextCandidate(candidates);

  if (inspectedEncrypting !== undefined) {
    const validEncrypting = await stabilizeEncryptedCandidate(
      paths.encrypting,
      key.bytes,
    );
    if (!fingerprintsEqual(inspectedEncrypting, validEncrypting)) {
      throw new Error('Encrypted database temp stabilization failed.');
    }
    const expected = marker ?? validPlaintext;
    if (
      expected === undefined
      || !fingerprintsEqual(validEncrypting, expected)
    ) {
      throw new Error('Encrypted database upgrade candidates do not match.');
    }

    if (marker === undefined) {
      await writeMarker(paths.marker, databasePath, validEncrypting);
    }
    await promoteValidatedEncrypting(
      databasePath,
      paths,
      candidates,
      validEncrypting,
      key.bytes,
    );
    return;
  }

  if (validPlaintext === undefined) {
    if (allCandidatesAbsent(candidates) && marker === undefined) {
      return;
    }
    throw new Error('No valid database copy is available for encryption upgrade.');
  }

  if (
    validPlaintext.path === databasePath
    && candidates.recovery.kind !== 'absent'
  ) {
    throw new Error('Plaintext recovery candidates are ambiguous.');
  }

  if (validPlaintext.path !== databasePath) {
    if (candidates.canonical.kind !== 'absent') {
      throw new Error('The canonical database cannot be restored safely.');
    }
    const stabilizedPlaintext = await checkpointAndInspectPlaintext(
      validPlaintext.path,
    );
    if (!fingerprintsEqual(validPlaintext, stabilizedPlaintext)) {
      throw new Error('Plaintext recovery stabilization failed.');
    }
    await rename(validPlaintext.path, databasePath);
    await fsyncDirectory(dirname(databasePath));
  }

  await removeDatabaseArtifacts(paths.encrypting);
  await removeIfPresent(paths.marker);
  await convertCanonicalPlaintext(databasePath, paths, key.bytes, hooks);
}

async function convertCanonicalPlaintext(
  databasePath: string,
  paths: PlaintextUpgradePaths,
  key: Buffer,
  hooks: PlaintextUpgradeHooks,
): Promise<void> {
  const source = createRawDatabase(databasePath, { fileMustExist: true });
  let copySource: FileHandle | undefined;
  try {
    const plaintext = lockAndFingerprintPlaintext(source);
    // POSIX closes release process-wide fcntl locks, so this source fd must
    // remain open until the locked SQLite connection has finished cleanup.
    copySource = await openRetainedSourceHandle(databasePath);
    await removeDatabaseSidecars(databasePath);
    assertNoDatabaseSidecars(databasePath);

    await copyRetainedSourceFile(copySource, paths.encrypting);
    await fsyncFile(paths.encrypting);
    await fsyncDirectory(dirname(databasePath));
    await hooks.afterPlaintextCopy?.();
    await assertRetainedSourcePath(copySource, databasePath);

    rekeyPlaintextCopy(paths.encrypting, key);
    await fsyncFile(paths.encrypting);
    const encrypted = await stabilizeEncryptedCandidate(paths.encrypting, key);
    if (!fingerprintsEqual(plaintext, encrypted)) {
      throw new Error('Encrypted database copy verification failed.');
    }

    const finalPlaintext = readAndVerifyDatabaseFingerprint(source);
    if (!fingerprintsEqual(plaintext, finalPlaintext)) {
      throw new Error('Plaintext database changed during encryption conversion.');
    }
    await assertRetainedSourcePath(copySource, databasePath);
    await writeMarker(paths.marker, databasePath, encrypted);
    await displaceRetainedSource(copySource, databasePath, paths.recovery);
    await hooks.afterPlaintextDisplaced?.();
    await linkEncryptedCandidate(paths.encrypting, databasePath);

    const promoted = inspectEncryptedCandidate(databasePath, key);
    if (
      promoted.kind !== 'encrypted'
      || !fingerprintsEqual(encrypted, promoted)
    ) {
      throw new Error('Promoted encrypted database verification failed.');
    }

    await cleanAfterLinkedPromotion(databasePath, paths);
  } finally {
    try {
      await copySource?.close();
    } finally {
      source.close();
    }
  }
}

async function promoteValidatedEncrypting(
  databasePath: string,
  paths: PlaintextUpgradePaths,
  candidates: Awaited<ReturnType<typeof inspectCandidates>>,
  expected: DatabaseFingerprint,
  key: Buffer,
): Promise<void> {
  if (candidates.canonical.kind === 'plaintext') {
    if (candidates.recovery.kind !== 'absent') {
      throw new Error('Plaintext recovery candidates are ambiguous.');
    }
    const source = createRawDatabase(databasePath, { fileMustExist: true });
    let retainedSource: FileHandle | undefined;
    try {
      const stabilizedPlaintext = lockAndFingerprintPlaintext(source);
      retainedSource = await openRetainedSourceHandle(databasePath);
      await removeDatabaseSidecars(databasePath);
      assertNoDatabaseSidecars(databasePath);
      if (!fingerprintsEqual(stabilizedPlaintext, expected)) {
        throw new Error('Plaintext database changed before encryption promotion.');
      }
      const finalPlaintext = readAndVerifyDatabaseFingerprint(source);
      if (!fingerprintsEqual(finalPlaintext, expected)) {
        throw new Error('Plaintext database changed before encryption promotion.');
      }
      await assertRetainedSourcePath(retainedSource, databasePath);
      await displaceRetainedSource(
        retainedSource,
        databasePath,
        paths.recovery,
      );
      await linkEncryptedCandidate(paths.encrypting, databasePath);
      const promoted = inspectEncryptedCandidate(databasePath, key);
      if (
        promoted.kind !== 'encrypted'
        || !fingerprintsEqual(promoted, expected)
      ) {
        throw new Error('Promoted encrypted database verification failed.');
      }
      await cleanAfterLinkedPromotion(databasePath, paths);
    } finally {
      try {
        await retainedSource?.close();
      } finally {
        source.close();
      }
    }
    return;
  } else if (candidates.canonical.kind !== 'absent') {
    throw new Error('The canonical database cannot be replaced safely.');
  }

  await linkEncryptedCandidate(paths.encrypting, databasePath);
  const promoted = inspectEncryptedCandidate(databasePath, key);
  if (
    promoted.kind !== 'encrypted'
    || !fingerprintsEqual(promoted, expected)
  ) {
    throw new Error('Promoted encrypted database verification failed.');
  }

  await cleanAfterLinkedPromotion(databasePath, paths);
}

async function checkpointAndInspectPlaintext(
  databasePath: string,
): Promise<DatabaseFingerprint> {
  const raw = createRawDatabase(databasePath, { fileMustExist: true });
  let fingerprint: DatabaseFingerprint;
  try {
    fingerprint = lockAndFingerprintPlaintext(raw);
  } finally {
    raw.close();
  }
  await removeDatabaseSidecars(databasePath);
  assertNoDatabaseSidecars(databasePath);
  return fingerprint;
}

function lockAndFingerprintPlaintext(
  raw: ReturnType<typeof createRawDatabase>,
): DatabaseFingerprint {
  raw.pragma('busy_timeout = 0');
  const lockingMode = raw.pragma('locking_mode = EXCLUSIVE', { simple: true });
  if (lockingMode !== 'exclusive') {
    throw new Error('Plaintext database exclusive locking failed.');
  }
  try {
    raw.exec('BEGIN EXCLUSIVE');
    raw.exec('ROLLBACK');
  } catch {
    throw new Error('Plaintext database checkpoint is busy.');
  }
  const currentJournalMode = raw.pragma('journal_mode', { simple: true });
  if (currentJournalMode === 'wal') {
    assertTruncatedCheckpoint(raw.pragma('wal_checkpoint(TRUNCATE)'));
  } else if (currentJournalMode !== 'delete') {
    throw new Error('Plaintext database journal mode is unsupported.');
  }
  const journalMode = raw.pragma('journal_mode = DELETE', { simple: true });
  if (journalMode !== 'delete') {
    throw new Error('Plaintext database journal stabilization failed.');
  }
  return readAndVerifyDatabaseFingerprint(raw);
}

async function openRetainedSourceHandle(path: string): Promise<FileHandle> {
  const source = await open(path, 'r');
  try {
    await assertRetainedSourcePath(source, path);
    return source;
  } catch (error) {
    await source.close().catch((): undefined => undefined);
    throw error;
  }
}

async function assertRetainedSourcePath(
  source: FileHandle,
  path: string,
): Promise<void> {
  let pathMetadata: Stats;
  try {
    pathMetadata = await lstat(path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      throw new SourcePathIdentityChangedError();
    }
    throw error;
  }
  const handleMetadata = await source.stat();
  if (
    !handleMetadata.isFile()
    || !pathMetadata.isFile()
    || pathMetadata.isSymbolicLink()
    || handleMetadata.dev !== pathMetadata.dev
    || handleMetadata.ino !== pathMetadata.ino
  ) {
    throw new SourcePathIdentityChangedError();
  }
}

async function displaceRetainedSource(
  source: FileHandle,
  canonicalPath: string,
  recoveryPath: string,
): Promise<void> {
  if (pathExistsWithoutFollowingLinks(recoveryPath)) {
    throw new Error('Plaintext recovery path is already occupied.');
  }
  await rename(canonicalPath, recoveryPath);
  await fsyncDirectory(dirname(canonicalPath));
  try {
    await assertRetainedSourcePath(source, recoveryPath);
  } catch (error) {
    try {
      await link(recoveryPath, canonicalPath);
      await fsyncDirectory(dirname(canonicalPath));
    } catch (restoreError) {
      if (!isNodeError(restoreError, 'EEXIST')) {
        throw restoreError;
      }
    }
    throw error;
  }
}

async function linkEncryptedCandidate(
  encryptingPath: string,
  canonicalPath: string,
): Promise<void> {
  try {
    // A hard link is an atomic no-clobber promotion. rename() would silently
    // replace a canonical path created while the source was being displaced.
    await link(encryptingPath, canonicalPath);
  } catch (error) {
    if (isNodeError(error, 'EEXIST')) {
      throw new Error('The canonical path is occupied during encryption promotion.');
    }
    throw error;
  }
  await fsyncDirectory(dirname(canonicalPath));
  await assertPathsShareIdentity(encryptingPath, canonicalPath);
}

async function assertPathsShareIdentity(
  expectedPath: string,
  actualPath: string,
): Promise<void> {
  const [expected, actual] = await Promise.all([
    lstat(expectedPath),
    lstat(actualPath),
  ]);
  if (
    !expected.isFile()
    || !actual.isFile()
    || expected.isSymbolicLink()
    || actual.isSymbolicLink()
    || expected.dev !== actual.dev
    || expected.ino !== actual.ino
  ) {
    throw new Error('Promoted encrypted database identity verification failed.');
  }
}

async function copyRetainedSourceFile(
  source: FileHandle,
  destinationPath: string,
): Promise<void> {
  const sourceMetadata = await source.stat();
  if (!sourceMetadata.isFile()) {
    throw new Error('Plaintext database source is not a regular file.');
  }

  const destination = await open(destinationPath, 'wx', 0o600);
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < sourceMetadata.size) {
      const bytesToRead = Math.min(buffer.byteLength, sourceMetadata.size - position);
      const { bytesRead } = await source.read(
        buffer,
        0,
        bytesToRead,
        position,
      );
      if (bytesRead === 0) {
        throw new Error('Plaintext database source ended during copy.');
      }
      let bytesWritten = 0;
      while (bytesWritten < bytesRead) {
        const write = await destination.write(
          buffer,
          bytesWritten,
          bytesRead - bytesWritten,
          position + bytesWritten,
        );
        if (write.bytesWritten === 0) {
          throw new Error('Encrypted database temporary copy made no progress.');
        }
        bytesWritten += write.bytesWritten;
      }
      position += bytesRead;
    }
    const finalMetadata = await source.stat();
    if (
      finalMetadata.dev !== sourceMetadata.dev
      || finalMetadata.ino !== sourceMetadata.ino
      || finalMetadata.size !== sourceMetadata.size
    ) {
      throw new Error('Plaintext database source changed during copy.');
    }
    await destination.sync();
  } finally {
    await destination.close();
  }
}

function rekeyPlaintextCopy(path: string, key: Buffer): void {
  const raw = createRawDatabase(path, { fileMustExist: true });
  try {
    const journalMode = raw.pragma('journal_mode = DELETE', { simple: true });
    if (journalMode !== 'delete') {
      throw new Error('Encrypted database temp journal stabilization failed.');
    }
    raw.pragma("cipher='sqlcipher'");
    raw.pragma('legacy=4');
    raw.pragma(`rekey="x'${key.toString('hex')}'"`);
  } finally {
    raw.close();
  }
}

async function stabilizeEncryptedCandidate(
  path: string,
  key: Buffer,
): Promise<DatabaseFingerprint> {
  const raw = createRawDatabase(path, { fileMustExist: true });
  let fingerprint: DatabaseFingerprint;
  try {
    applyWorkspaceKey(raw, key);
    raw.pragma('busy_timeout = 0');
    const currentJournalMode = raw.pragma('journal_mode', { simple: true });
    if (currentJournalMode === 'wal') {
      assertTruncatedCheckpoint(raw.pragma('wal_checkpoint(TRUNCATE)'));
    }
    const journalMode = raw.pragma('journal_mode = DELETE', { simple: true });
    if (journalMode !== 'delete') {
      throw new Error('Encrypted database journal stabilization failed.');
    }
    fingerprint = readAndVerifyDatabaseFingerprint(raw, KNOWN_SCHEMA_VERSIONS);
  } finally {
    raw.close();
  }

  await removeDatabaseSidecars(path);
  await fsyncFile(path);
  await fsyncDirectory(dirname(path));
  const reopened = inspectEncryptedCandidate(path, key);
  if (
    reopened.kind !== 'encrypted'
    || !fingerprintsEqual(fingerprint, reopened)
  ) {
    throw new Error('Encrypted database sidecar stabilization failed.');
  }
  return fingerprint;
}

function assertTruncatedCheckpoint(value: unknown): void {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error('Database checkpoint result is invalid.');
  }
  const result = value[0] as unknown;
  if (
    result === null
    || typeof result !== 'object'
    || Array.isArray(result)
    || JSON.stringify(Object.keys(result).sort())
      !== JSON.stringify(['busy', 'checkpointed', 'log'])
  ) {
    throw new Error('Database checkpoint result is invalid.');
  }
  const checkpoint = result as Record<string, unknown>;
  if (
    checkpoint.busy !== 0
    || checkpoint.log !== 0
    || checkpoint.checkpointed !== 0
  ) {
    throw new Error('Database checkpoint did not reach a non-busy truncated state.');
  }
}

function assertNoDatabaseSidecars(path: string): void {
  const persistentSuffixes = DATABASE_SIDECAR_SUFFIXES.filter((suffix) =>
    pathExistsWithoutFollowingLinks(`${path}${suffix}`));
  if (persistentSuffixes.length > 0) {
    throw new Error(
      `Database checkpoint left persistent sidecars: ${persistentSuffixes.join(', ')}.`,
    );
  }
}

async function inspectCandidates(
  databasePath: string,
  paths: PlaintextUpgradePaths,
  key: Buffer,
) {
  const [canonical, encrypting, recovery] = await Promise.all([
    inspectCandidate(databasePath, key),
    inspectCandidate(paths.encrypting, key),
    inspectCandidate(paths.recovery, key),
  ]);
  return { canonical, encrypting, recovery };
}

async function inspectCandidate(path: string, key: Buffer): Promise<Candidate> {
  const [metadata, ...sidecars] = await Promise.all(
    databaseArtifactPaths(path).map(lstatIfPresent),
  );
  if (metadata === undefined) {
    return sidecars.every((sidecar) => sidecar === undefined)
      ? { kind: 'absent', path }
      : { kind: 'invalid', path };
  }
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || sidecars.some((sidecar) =>
      sidecar !== undefined
      && (!sidecar.isFile() || sidecar.isSymbolicLink()))
  ) {
    return { kind: 'invalid', path };
  }

  const handle = await open(path, 'r');
  let header: Buffer;
  try {
    header = Buffer.alloc(PLAINTEXT_HEADER.byteLength);
    const result = await handle.read(
      header,
      0,
      PLAINTEXT_HEADER.byteLength,
      0,
    );
    if (result.bytesRead !== PLAINTEXT_HEADER.byteLength) {
      return { kind: 'invalid', path };
    }
  } finally {
    await handle.close();
  }

  if (header.equals(PLAINTEXT_HEADER)) {
    return inspectPlaintextCandidate(path);
  }
  return inspectEncryptedCandidate(path, key);
}

function inspectPlaintextCandidate(path: string): Candidate {
  let raw;
  try {
    raw = createRawDatabase(path, { readonly: true, fileMustExist: true });
    return {
      kind: 'plaintext',
      path,
      ...readAndVerifyDatabaseFingerprint(raw),
    };
  } catch {
    return { kind: 'invalid', path };
  } finally {
    raw?.close();
  }
}

function inspectEncryptedCandidate(path: string, key: Buffer): Candidate {
  let raw;
  try {
    raw = createRawDatabase(path, { readonly: true, fileMustExist: true });
    applyWorkspaceKey(raw, key);
    return {
      kind: 'encrypted',
      path,
      ...readAndVerifyDatabaseFingerprint(raw, KNOWN_SCHEMA_VERSIONS),
    };
  } catch {
    return { kind: 'invalid', path };
  } finally {
    raw?.close();
  }
}

export function readAndVerifyDatabaseFingerprint(
  raw: ReturnType<typeof createRawDatabase>,
  supportedSchemaVersions: readonly number[] = [1],
): DatabaseFingerprint {
  const integrity = raw.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') {
    throw new Error('Database integrity verification failed.');
  }

  const metadata = raw.prepare<[], { schema_version: unknown }>(
    'SELECT schema_version FROM app_meta WHERE singleton = 1',
  ).get();
  const schemaVersion = typeof metadata?.schema_version === 'bigint'
    ? Number(metadata.schema_version)
    : metadata?.schema_version;
  if (
    typeof schemaVersion !== 'number'
    || !Number.isSafeInteger(schemaVersion)
    || !supportedSchemaVersions.includes(schemaVersion)
  ) {
    throw new Error(
      supportedSchemaVersions.length === 1 && supportedSchemaVersions[0] === 1
        ? 'Only plaintext schema 1 can be encrypted in place.'
        : 'Encrypted database schema version is unsupported.',
    );
  }

  raw.defaultSafeIntegers(true);
  const schemaRows = raw.prepare<[], {
    type: unknown;
    name: unknown;
    tbl_name: unknown;
    sql: unknown;
  }>(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    ORDER BY type, name, tbl_name, COALESCE(sql, '')
  `).all();
  if (schemaRows.length === 0) {
    throw new Error('Database semantic verification failed.');
  }

  const digest = createHash('sha256');
  updateDigestValue(digest, BigInt(schemaVersion));
  updateDigestValue(digest, raw.pragma('user_version', { simple: true }));
  updateDigestValue(digest, raw.pragma('application_id', { simple: true }));
  for (const row of schemaRows) {
    if (
      typeof row.type !== 'string'
      || typeof row.name !== 'string'
      || typeof row.tbl_name !== 'string'
      || (row.sql !== null && typeof row.sql !== 'string')
    ) {
      throw new Error('Database semantic verification failed.');
    }
    updateDigestValue(digest, row.type);
    updateDigestValue(digest, row.name);
    updateDigestValue(digest, row.tbl_name);
    updateDigestValue(digest, row.sql);
  }

  const tables = schemaRows.filter((row): row is typeof row & { name: string } =>
    row.type === 'table' && typeof row.name === 'string');
  const rowCounts: Record<string, number> = {};
  for (const { name } of tables) {
    const escapedName = name.replaceAll('"', '""');
    const statement = raw.prepare<[], Record<string, unknown>>(
      `SELECT * FROM "${escapedName}"`,
    );
    const columns = statement.columns().map(({ name: columnName }) => columnName);
    updateDigestValue(digest, name);
    for (const column of columns) {
      updateDigestValue(digest, column);
    }

    const rowDigests: string[] = [];
    for (const row of statement.iterate()) {
      const rowDigest = createHash('sha256');
      for (const column of columns) {
        updateDigestValue(rowDigest, row[column]);
      }
      rowDigests.push(rowDigest.digest('hex'));
    }
    rowDigests.sort();
    rowCounts[name] = rowDigests.length;
    for (const rowDigest of rowDigests) {
      updateDigestValue(digest, rowDigest);
    }
  }

  return {
    schemaVersion,
    rowCounts,
    contentDigest: digest.digest('hex'),
  };
}

function updateDigestValue(hash: Hash, value: unknown): void {
  if (value === null) {
    hash.update('null:;');
    return;
  }
  if (Buffer.isBuffer(value)) {
    hash.update(`blob:${value.byteLength}:`);
    hash.update(value);
    hash.update(';');
    return;
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    hash.update(`text:${bytes.byteLength}:`);
    hash.update(bytes);
    hash.update(';');
    return;
  }
  if (typeof value === 'bigint') {
    hash.update(`integer:${value.toString(10)};`);
    return;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const bytes = Buffer.allocUnsafe(8);
    bytes.writeDoubleBE(value);
    hash.update('real:8:');
    hash.update(bytes);
    hash.update(';');
    return;
  }
  throw new Error('Database semantic verification failed.');
}

function selectPlaintextCandidate(
  candidates: Awaited<ReturnType<typeof inspectCandidates>>,
): Extract<Candidate, { kind: 'plaintext' }> | undefined {
  if (candidates.canonical.kind === 'plaintext') {
    return candidates.canonical;
  }
  if (candidates.recovery.kind === 'plaintext') {
    return candidates.recovery;
  }
  return undefined;
}

function allCandidatesAbsent(
  candidates: Awaited<ReturnType<typeof inspectCandidates>>,
): boolean {
  return candidates.canonical.kind === 'absent'
    && candidates.encrypting.kind === 'absent'
    && candidates.recovery.kind === 'absent';
}

function fingerprintsEqual(
  left: DatabaseFingerprint,
  right: DatabaseFingerprint,
): boolean {
  if (
    left.schemaVersion !== right.schemaVersion
    || left.contentDigest !== right.contentDigest
  ) {
    return false;
  }
  const leftEntries = Object.entries(left.rowCounts).sort(([a], [b]) =>
    a.localeCompare(b));
  const rightEntries = Object.entries(right.rowCounts).sort(([a], [b]) =>
    a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

async function readMarker(
  markerPath: string,
  databasePath: string,
): Promise<UpgradeMarker | undefined> {
  const metadata = await lstatIfPresent(markerPath);
  if (metadata === undefined) {
    return undefined;
  }
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.size < 1
    || metadata.size > MAX_MARKER_BYTES
  ) {
    throw new Error('The database encryption state marker is invalid.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(markerPath, 'utf8')) as unknown;
  } catch {
    throw new Error('The database encryption state marker is invalid.');
  }
  if (!isUpgradeMarker(parsed, databasePath)) {
    throw new Error('The database encryption state marker is invalid.');
  }
  return parsed;
}

function isUpgradeMarker(
  value: unknown,
  databasePath: string,
): value is UpgradeMarker {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const marker = value as Record<string, unknown>;
  const keys = Object.keys(marker).sort();
  if (JSON.stringify(keys) !== JSON.stringify([
    'canonicalPath',
    'contentDigest',
    'format',
    'rowCounts',
    'schemaVersion',
    'version',
  ])) {
    return false;
  }
  if (
    marker.format !== STATE_MARKER_FORMAT
    || marker.version !== 1
    || marker.canonicalPath !== databasePath
    || marker.schemaVersion !== 1
    || typeof marker.contentDigest !== 'string'
    || !/^[0-9a-f]{64}$/.test(marker.contentDigest)
    || marker.rowCounts === null
    || typeof marker.rowCounts !== 'object'
    || Array.isArray(marker.rowCounts)
  ) {
    return false;
  }
  const counts = marker.rowCounts as Record<string, unknown>;
  return Object.keys(counts).length > 0
    && Object.entries(counts).every(([name, count]) =>
      name.length > 0
      && typeof count === 'number'
      && Number.isSafeInteger(count)
      && count >= 0);
}

async function writeMarker(
  markerPath: string,
  databasePath: string,
  fingerprint: DatabaseFingerprint,
): Promise<void> {
  if (fingerprint.schemaVersion !== 1) {
    throw new Error('Only schema 1 can create an encryption upgrade marker.');
  }
  const marker: UpgradeMarker = {
    format: STATE_MARKER_FORMAT,
    version: 1,
    canonicalPath: databasePath,
    schemaVersion: 1,
    rowCounts: fingerprint.rowCounts,
    contentDigest: fingerprint.contentDigest,
  };
  const temporaryPath = join(
    dirname(markerPath),
    `.${randomUUID()}.encryption-state.tmp`,
  );
  const handle = await open(temporaryPath, 'wx', 0o600);
  let renamed = false;
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(marker)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, markerPath);
    renamed = true;
    await fsyncDirectory(dirname(markerPath));
  } finally {
    if (renamed === false) {
      await handle.close().catch((): undefined => undefined);
      await rm(temporaryPath, { force: true }).catch((): undefined => undefined);
    }
  }
}

async function cleanAfterVerifiedPromotion(
  paths: PlaintextUpgradePaths,
): Promise<void> {
  await removeIfPresent(paths.marker);
  await removeDatabaseArtifacts(paths.recovery);
  await removeDatabaseArtifacts(paths.encrypting);
}

async function cleanAfterLinkedPromotion(
  databasePath: string,
  paths: PlaintextUpgradePaths,
): Promise<void> {
  await assertPathsShareIdentity(paths.encrypting, databasePath);
  await removeIfPresent(paths.marker);
  await assertPathsShareIdentity(paths.encrypting, databasePath);
  await removeDatabaseArtifacts(paths.recovery);
  await assertPathsShareIdentity(paths.encrypting, databasePath);
  await removeDatabaseArtifacts(paths.encrypting);
}

async function removeDatabaseArtifacts(path: string): Promise<void> {
  for (const artifact of databaseArtifactPaths(path)) {
    await removeIfPresent(artifact);
  }
}

async function removeDatabaseSidecars(path: string): Promise<void> {
  for (const sidecar of databaseArtifactPaths(path).slice(1)) {
    await removeIfPresent(sidecar);
  }
}

async function removeIfPresent(path: string): Promise<void> {
  const metadata = await lstatIfPresent(path);
  if (metadata === undefined) {
    return;
  }
  await rm(path, { force: true });
  await fsyncDirectory(dirname(path));
}

async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function lstatIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
}

function assertUpgradeInput(databasePath: string, key: WorkspaceKey): void {
  if (!isAbsolute(databasePath)) {
    throw new Error('Database path must be absolute.');
  }
  if (key.version !== 1 || key.bytes.byteLength !== 32) {
    throw new RangeError('Workspace key must contain 32 bytes.');
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}
