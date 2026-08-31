import { randomUUID } from 'node:crypto';
import {
  constants,
  lstatSync,
  type Stats,
} from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import type { WorkspaceKey } from '../security/workspaceKeyTypes';
import { applyWorkspaceKey, createRawDatabase } from './sqliteDriver';

const PLAINTEXT_HEADER = Buffer.from('SQLite format 3\u0000', 'utf8');
const STATE_MARKER_FORMAT = 'callie-plaintext-encryption-upgrade';
const MAX_MARKER_BYTES = 64 * 1024;

export type PlaintextUpgradePaths = {
  encrypting: string;
  recovery: string;
  marker: string;
};

type DatabaseFingerprint = {
  schemaVersion: 1;
  rowCounts: Record<string, number>;
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
  return [databasePath, paths.encrypting, paths.recovery, paths.marker]
    .some(pathExistsWithoutFollowingLinks);
};

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
): Promise<void> {
  assertUpgradeInput(databasePath, key);
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
  await chmod(dirname(databasePath), 0o700);

  const paths = plaintextUpgradePaths(databasePath);
  const marker = await readMarker(paths.marker, databasePath);
  const candidates = await inspectCandidates(databasePath, paths, key.bytes);

  if (candidates.canonical.kind === 'encrypted') {
    await cleanAfterVerifiedPromotion(paths);
    return;
  }

  const validEncrypting = candidates.encrypting.kind === 'encrypted'
    ? candidates.encrypting
    : undefined;
  const validPlaintext = selectPlaintextCandidate(candidates);

  if (validEncrypting !== undefined) {
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

  if (validPlaintext.path !== databasePath) {
    if (candidates.canonical.kind !== 'absent') {
      throw new Error('The canonical database cannot be restored safely.');
    }
    await rename(validPlaintext.path, databasePath);
    await fsyncDirectory(dirname(databasePath));
  }

  await removeIfPresent(paths.encrypting);
  await removeIfPresent(paths.marker);
  await convertCanonicalPlaintext(databasePath, paths, key.bytes);
}

async function convertCanonicalPlaintext(
  databasePath: string,
  paths: PlaintextUpgradePaths,
  key: Buffer,
): Promise<void> {
  const plaintext = checkpointAndInspectPlaintext(databasePath);

  await copyFile(databasePath, paths.encrypting, constants.COPYFILE_EXCL);
  await fsyncFile(paths.encrypting);
  await fsyncDirectory(dirname(databasePath));

  rekeyPlaintextCopy(paths.encrypting, key);
  await fsyncFile(paths.encrypting);
  const encrypted = inspectEncryptedCandidate(paths.encrypting, key);
  if (
    encrypted.kind !== 'encrypted'
    || !fingerprintsEqual(plaintext, encrypted)
  ) {
    throw new Error('Encrypted database copy verification failed.');
  }

  await writeMarker(paths.marker, databasePath, encrypted);
  await rename(databasePath, paths.recovery);
  await fsyncDirectory(dirname(databasePath));
  await rename(paths.encrypting, databasePath);
  await fsyncDirectory(dirname(databasePath));

  const promoted = inspectEncryptedCandidate(databasePath, key);
  if (
    promoted.kind !== 'encrypted'
    || !fingerprintsEqual(encrypted, promoted)
  ) {
    throw new Error('Promoted encrypted database verification failed.');
  }

  await cleanAfterVerifiedPromotion(paths);
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
    await rename(databasePath, paths.recovery);
    await fsyncDirectory(dirname(databasePath));
  } else if (candidates.canonical.kind !== 'absent') {
    throw new Error('The canonical database cannot be replaced safely.');
  }

  await rename(paths.encrypting, databasePath);
  await fsyncDirectory(dirname(databasePath));
  const promoted = inspectEncryptedCandidate(databasePath, key);
  if (
    promoted.kind !== 'encrypted'
    || !fingerprintsEqual(promoted, expected)
  ) {
    throw new Error('Promoted encrypted database verification failed.');
  }

  await cleanAfterVerifiedPromotion(paths);
}

function checkpointAndInspectPlaintext(
  databasePath: string,
): DatabaseFingerprint {
  const raw = createRawDatabase(databasePath, { fileMustExist: true });
  try {
    raw.pragma('wal_checkpoint(TRUNCATE)');
    return readAndVerifyFingerprint(raw);
  } finally {
    raw.close();
  }
}

function rekeyPlaintextCopy(path: string, key: Buffer): void {
  const raw = createRawDatabase(path, { fileMustExist: true });
  try {
    raw.pragma("cipher='sqlcipher'");
    raw.pragma('legacy=4');
    raw.pragma(`rekey="x'${key.toString('hex')}'"`);
  } finally {
    raw.close();
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
  const metadata = await lstatIfPresent(path);
  if (metadata === undefined) {
    return { kind: 'absent', path };
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
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
    return { kind: 'plaintext', path, ...readAndVerifyFingerprint(raw) };
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
    return { kind: 'encrypted', path, ...readAndVerifyFingerprint(raw) };
  } catch {
    return { kind: 'invalid', path };
  } finally {
    raw?.close();
  }
}

function readAndVerifyFingerprint(
  raw: ReturnType<typeof createRawDatabase>,
): DatabaseFingerprint {
  const integrity = raw.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') {
    throw new Error('Database integrity verification failed.');
  }

  const metadata = raw.prepare<[], { schema_version: unknown }>(
    'SELECT schema_version FROM app_meta WHERE singleton = 1',
  ).get();
  if (metadata?.schema_version !== 1) {
    throw new Error('Only plaintext schema 1 can be encrypted in place.');
  }

  const tables = raw.prepare<[], { name: string }>(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
    ORDER BY name
  `).all();
  if (tables.length === 0) {
    throw new Error('Database row-count verification failed.');
  }
  const countQuery = tables.map(({ name }) => {
    const escapedName = name.replaceAll('"', '""');
    return `SELECT ? AS name, COUNT(*) AS count FROM "${escapedName}"`;
  }).join(' UNION ALL ');
  const counts = raw.prepare<string[], { name: unknown; count: unknown }>(
    countQuery,
  ).all(...tables.map(({ name }) => name));
  const rowCounts: Record<string, number> = {};
  for (const { name, count } of counts) {
    if (
      typeof name !== 'string'
      || typeof count !== 'number'
      || !Number.isSafeInteger(count)
      || count < 0
    ) {
      throw new Error('Database row-count verification failed.');
    }
    rowCounts[name] = count;
  }

  return { schemaVersion: 1, rowCounts };
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
  if (left.schemaVersion !== right.schemaVersion) {
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
  const marker: UpgradeMarker = {
    format: STATE_MARKER_FORMAT,
    version: 1,
    canonicalPath: databasePath,
    schemaVersion: 1,
    rowCounts: fingerprint.rowCounts,
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
  await removeIfPresent(paths.recovery);
  await removeIfPresent(paths.encrypting);
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
