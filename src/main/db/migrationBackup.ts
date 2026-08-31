import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type { WorkspaceKey } from '../security/workspaceKeyTypes';
import type { AppDatabase } from './database';
import { applyWorkspaceKey, createRawDatabase } from './sqliteDriver';

export type MigrationBackup = {
  path: string;
  sourceSchemaVersion: number;
  sha256: string;
  verifiedAt: string;
};

const SQLITE_PLAINTEXT_HEADER = Buffer.from('SQLite format 3\0', 'utf8');
const COPY_BUFFER_SIZE = 1024 * 1024;

export function createVerifiedMigrationBackup(input: {
  database: AppDatabase;
  backupDirectory: string;
  key: WorkspaceKey;
  sourceSchemaVersion: number;
}): MigrationBackup {
  assertSourceSchemaVersion(input.sourceSchemaVersion);
  const backupDirectory = validateBackupDirectory(input.backupDirectory);
  const directoryDescriptor = openDirectory(backupDirectory);
  let sourceDescriptor: number | undefined;
  let backupDescriptor: number | undefined;
  let backupIdentity: Stats | undefined;
  let backupPath: string | undefined;

  try {
    checkpointDatabase(input.database);
    sourceDescriptor = openRegularFile(input.database.path, constants.O_RDONLY);
    const sourceIdentity = fstatSync(sourceDescriptor);
    assertPathIdentity(input.database.path, sourceIdentity);

    backupPath = join(
      backupDirectory,
      `pre-migration-schema-${input.sourceSchemaVersion}-${compactUtcTimestamp()}.sqlite3`,
    );
    backupDescriptor = openSync(
      backupPath,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_RDWR
        | noFollowFlag(),
      0o600,
    );
    fchmodSync(backupDescriptor, 0o600);
    backupIdentity = fstatSync(backupDescriptor);
    copyRetainedFile(sourceDescriptor, sourceIdentity, backupDescriptor);
    backupIdentity = fstatSync(backupDescriptor);
    assertPathIdentity(input.database.path, sourceIdentity);
    assertPathIdentity(backupPath, backupIdentity);
    fsyncSync(backupDescriptor);
    fsyncSync(directoryDescriptor);

    assertEncryptedHeader(backupDescriptor);
    verifyBackupDatabase(
      backupPath,
      input.key,
      input.sourceSchemaVersion,
    );
    backupIdentity = fstatSync(backupDescriptor);
    assertPathIdentity(backupPath, backupIdentity);
    const sha256 = hashDescriptor(backupDescriptor, backupIdentity.size);
    if (hashDescriptor(backupDescriptor, backupIdentity.size) !== sha256) {
      throw new Error('Migration backup checksum verification failed.');
    }
    fsyncSync(backupDescriptor);
    fsyncSync(directoryDescriptor);

    return {
      path: backupPath,
      sourceSchemaVersion: input.sourceSchemaVersion,
      sha256,
      verifiedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (backupDescriptor !== undefined) {
      closeSync(backupDescriptor);
      backupDescriptor = undefined;
    }
    if (
      backupPath !== undefined
      && backupIdentity !== undefined
      && pathHasIdentity(backupPath, backupIdentity)
    ) {
      rmSync(backupPath);
      removeOwnedSidecars(backupPath);
      fsyncSync(directoryDescriptor);
    }
    throw sanitizeVerificationError(error);
  } finally {
    if (backupDescriptor !== undefined) {
      closeSync(backupDescriptor);
    }
    if (sourceDescriptor !== undefined) {
      closeSync(sourceDescriptor);
    }
    closeSync(directoryDescriptor);
  }
}

function validateBackupDirectory(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error('Migration backup directory must be an absolute normalized path.');
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Migration backup directory is invalid.');
  }
  chmodSync(path, 0o700);
  return path;
}

function openDirectory(path: string): number {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | directoryFlag() | noFollowFlag(),
  );
  try {
    const identity = fstatSync(descriptor);
    if (!identity.isDirectory()) {
      throw new Error('Migration backup directory is invalid.');
    }
    assertPathIdentity(path, identity);
    fchmodSync(descriptor, 0o700);
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function checkpointDatabase(database: AppDatabase): void {
  if (database.raw.inTransaction) {
    throw new Error('Migration backup cannot run inside a transaction.');
  }
  const journalMode = database.raw.pragma('journal_mode', { simple: true });
  if (journalMode !== 'wal') {
    throw new Error('Migration backup requires WAL journal mode.');
  }
  assertTruncatedCheckpoint(database.raw.pragma('wal_checkpoint(TRUNCATE)'));
}

function assertTruncatedCheckpoint(value: unknown): void {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error('Migration backup checkpoint result is invalid.');
  }
  const result = value[0] as unknown;
  if (
    result === null
    || typeof result !== 'object'
    || Array.isArray(result)
    || JSON.stringify(Object.keys(result).sort())
      !== JSON.stringify(['busy', 'checkpointed', 'log'])
  ) {
    throw new Error('Migration backup checkpoint result is invalid.');
  }
  const checkpoint = result as Record<string, unknown>;
  if (
    checkpoint.busy !== 0
    || checkpoint.log !== 0
    || checkpoint.checkpointed !== 0
  ) {
    throw new Error('Migration backup checkpoint did not reach a clean state.');
  }
}

function openRegularFile(path: string, flags: number): number {
  const descriptor = openSync(path, flags | noFollowFlag());
  try {
    const identity = fstatSync(descriptor);
    if (!identity.isFile()) {
      throw new Error('Migration backup source is not a regular file.');
    }
    assertPathIdentity(path, identity);
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function copyRetainedFile(
  sourceDescriptor: number,
  sourceIdentity: Stats,
  destinationDescriptor: number,
): void {
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_SIZE);
  let position = 0;
  while (position < sourceIdentity.size) {
    const bytesRead = readSync(
      sourceDescriptor,
      buffer,
      0,
      Math.min(buffer.byteLength, sourceIdentity.size - position),
      position,
    );
    if (bytesRead === 0) {
      throw new Error('Migration backup source ended during copy.');
    }
    let bytesWritten = 0;
    while (bytesWritten < bytesRead) {
      const writeCount = writeSync(
        destinationDescriptor,
        buffer,
        bytesWritten,
        bytesRead - bytesWritten,
        position + bytesWritten,
      );
      if (writeCount === 0) {
        throw new Error('Migration backup copy made no progress.');
      }
      bytesWritten += writeCount;
    }
    position += bytesRead;
  }

  const finalSourceIdentity = fstatSync(sourceDescriptor);
  const destinationIdentity = fstatSync(destinationDescriptor);
  if (
    !sameIdentity(sourceIdentity, finalSourceIdentity)
    || finalSourceIdentity.size !== sourceIdentity.size
    || destinationIdentity.size !== sourceIdentity.size
  ) {
    throw new Error('Migration backup source changed during copy.');
  }
}

function hashDescriptor(descriptor: number, size: number): string {
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_SIZE);
  let position = 0;
  while (position < size) {
    const bytesRead = readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.byteLength, size - position),
      position,
    );
    if (bytesRead === 0) {
      throw new Error('Migration backup checksum read ended early.');
    }
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return digest.digest('hex');
}

function assertEncryptedHeader(descriptor: number): void {
  const header = Buffer.alloc(SQLITE_PLAINTEXT_HEADER.byteLength);
  const bytesRead = readSync(descriptor, header, 0, header.byteLength, 0);
  if (bytesRead !== header.byteLength || header.equals(SQLITE_PLAINTEXT_HEADER)) {
    throw new Error('Migration backup encryption verification failed.');
  }
}

function verifyBackupDatabase(
  path: string,
  key: WorkspaceKey,
  sourceSchemaVersion: number,
): void {
  let backup;
  try {
    backup = createRawDatabase(path, { fileMustExist: true });
    applyWorkspaceKey(backup, key.bytes);
    if (backup.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') {
      throw new Error('Migration backup journal verification failed.');
    }
    if (backup.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error('Migration backup integrity verification failed.');
    }
    const appMeta = backup
      .prepare<[], { found: number }>(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'app_meta'",
      )
      .get();
    if (sourceSchemaVersion === 0) {
      if (appMeta !== undefined) {
        throw new Error('Migration backup schema verification failed.');
      }
      return;
    }
    if (appMeta === undefined) {
      throw new Error('Migration backup schema verification failed.');
    }
    const metadata = backup
      .prepare<[], { schema_version: unknown }>(
        'SELECT schema_version FROM app_meta WHERE singleton = 1',
      )
      .get();
    if (
      metadata?.schema_version !== sourceSchemaVersion
      && metadata?.schema_version !== BigInt(sourceSchemaVersion)
    ) {
      throw new Error('Migration backup schema verification failed.');
    }
  } catch {
    throw new Error('Migration backup verification failed.');
  } finally {
    backup?.close();
  }
}

function removeOwnedSidecars(path: string): void {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecarPath = `${path}${suffix}`;
    try {
      const metadata = lstatSync(sidecarPath);
      if (metadata.isFile() && !metadata.isSymbolicLink()) {
        rmSync(sidecarPath);
      }
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
  }
}

function assertSourceSchemaVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Migration backup source schema version is invalid.');
  }
}

function assertPathIdentity(path: string, expected: Stats): void {
  if (!pathHasIdentity(path, expected)) {
    throw new Error('Migration backup filesystem identity changed.');
  }
}

function pathHasIdentity(path: string, expected: Stats): boolean {
  try {
    const actual = lstatSync(path);
    return actual.isFile() === expected.isFile()
      && actual.isDirectory() === expected.isDirectory()
      && !actual.isSymbolicLink()
      && sameIdentity(actual, expected);
  } catch {
    return false;
  }
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function compactUtcTimestamp(): string {
  return new Date().toISOString().replace(/[-:.]/g, '');
}

function sanitizeVerificationError(error: unknown): unknown {
  if (error instanceof Error && /verification failed/i.test(error.message)) {
    return new Error('Migration backup verification failed.');
  }
  return error;
}

function noFollowFlag(): number {
  return constants.O_NOFOLLOW ?? 0;
}

function directoryFlag(): number {
  return constants.O_DIRECTORY ?? 0;
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && error.code === 'ENOENT';
}
