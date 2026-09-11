import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
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
import type { AppDatabase } from '../db/database';
import { applyWorkspaceKey, createRawDatabase } from '../db/sqliteDriver';

import type { Clock } from '../domain/support/clock';

export type BackupKind = 'daily' | 'manual' | 'pre_release';
export type VerifiedBackup = {
  path: string;
  basename: string;
  kind: BackupKind;
  schemaVersion: number;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
  verifiedAt: string;
};
export type VerifiedBackupInput = {
  database: AppDatabase;
  backupDirectory: string;
  key: WorkspaceKey;
  kind: BackupKind;
  schemaVersion: number;
  clock: Clock;
};
export type VerifiedCopyInput = Omit<VerifiedBackupInput, 'kind'> & { basename: string };
export type VerifiedCopy = Omit<VerifiedBackup, 'kind' | 'basename' | 'createdAt'>;
export type VerifiedCopyOperations = {
  fchmod(descriptor: number, mode: number): void;
  fstat(descriptor: number): Stats;
  fsyncDirectory(descriptor: number): void;
};

export function createVerifiedEncryptedBackup(input: VerifiedBackupInput): VerifiedBackup {
  if (!['daily', 'manual', 'pre_release'].includes(input.kind) || input.schemaVersion < 1) {
    throw new Error('Encrypted backup kind or schema is invalid.');
  }
  const createdAt = input.clock.now();
  if (new Date(createdAt).toISOString() !== createdAt) {
    throw new Error('Encrypted backup timestamp is invalid.');
  }
  const basename = `${input.kind}-${createdAt.replace(/[-:.]/g, '')}.sqlite3`;
  const result = createVerifiedEncryptedCopy({ ...input, basename });
  return { ...result, basename, kind: input.kind, createdAt };
}

const SQLITE_PLAINTEXT_HEADER = Buffer.from('SQLite format 3\0', 'utf8');
const COPY_BUFFER_SIZE = 1024 * 1024;

type RetainedDirectory = {
  descriptor: number;
  identity: Stats;
};

const defaultCreationOperations: VerifiedCopyOperations = {
  fchmod: fchmodSync,
  fstat: fstatSync,
  fsyncDirectory: fsyncSync,
};

/** Shared synchronous copy discipline. Schema zero is reserved for migration snapshots. */
export function createVerifiedEncryptedCopy(
  input: VerifiedCopyInput,
  creationOperations: VerifiedCopyOperations = defaultCreationOperations,
): VerifiedCopy {
  if (!/^[a-z0-9_-]+-[0-9]{8}T[0-9]{9}Z\.sqlite3$/.test(input.basename)) {
    throw new Error('Encrypted backup basename is invalid.');
  }
  assertSourceSchemaVersion(input.schemaVersion);
  const backupDirectory = validateBackupDirectory(input.backupDirectory);
  const directory = openDirectory(backupDirectory);
  let sourceDescriptor: number | undefined;
  let backupDescriptor: number | undefined;
  let backupIdentity: Stats | undefined;
  let backupPath: string | undefined;
  let backupWasCreated = false;
  let sourceRequiresWalRestore = false;

  try {
    assertDirectoryIdentity(backupDirectory, directory);
    sourceDescriptor = openRegularFile(input.database.path, constants.O_RDONLY);
    const openedSourceIdentity = fstatSync(sourceDescriptor);
    stabilizeSourceDatabase(input.database, () => { sourceRequiresWalRestore = true; });
    const sourceIdentity = fstatSync(sourceDescriptor);
    if (!sameIdentity(openedSourceIdentity, sourceIdentity)) {
      throw new Error('Encrypted backup source identity changed.');
    }
    assertPathIdentity(input.database.path, sourceIdentity);

    assertDirectoryIdentity(backupDirectory, directory);
    backupPath = join(
      backupDirectory,
      input.basename,
    );
    assertSidecarPathsAbsent(backupPath);
    backupDescriptor = openSync(
      backupPath,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_RDWR
        | noFollowFlag(),
      0o600,
    );
    backupWasCreated = true;
    creationOperations.fchmod(backupDescriptor, 0o600);
    backupIdentity = creationOperations.fstat(backupDescriptor);
    assertDirectoryIdentity(backupDirectory, directory);
    assertPathIdentity(backupPath, backupIdentity);
    copyRetainedFile(sourceDescriptor, sourceIdentity, backupDescriptor);
    backupIdentity = creationOperations.fstat(backupDescriptor);
    assertPathIdentity(input.database.path, sourceIdentity);
    restoreSourceJournal(input.database);
    sourceRequiresWalRestore = false;
    assertDirectoryIdentity(backupDirectory, directory);
    assertPathIdentity(backupPath, backupIdentity);
    assertPrivateBackup(backupDescriptor, backupIdentity);
    fsyncSync(backupDescriptor);
    creationOperations.fsyncDirectory(directory.descriptor);

    assertEncryptedHeader(backupDescriptor);
    assertSidecarPathsAbsent(backupPath);
    assertDirectoryIdentity(backupDirectory, directory);
    verifyBackupDatabase(
      backupPath,
      input.key,
      input.schemaVersion,
    );
    backupIdentity = creationOperations.fstat(backupDescriptor);
    assertDirectoryIdentity(backupDirectory, directory);
    assertPathIdentity(backupPath, backupIdentity);
    assertSidecarPathsAbsent(backupPath);
    const sha256 = hashDescriptor(backupDescriptor, backupIdentity.size);
    fsyncSync(backupDescriptor);
    creationOperations.fsyncDirectory(directory.descriptor);
    assertDirectoryIdentity(backupDirectory, directory);
    assertPathIdentity(backupPath, backupIdentity);
    assertSidecarPathsAbsent(backupPath);
    verifyBackupDatabase(
      backupPath,
      input.key,
      input.schemaVersion,
    );
    assertDirectoryIdentity(backupDirectory, directory);
    assertPathIdentity(backupPath, backupIdentity);
    assertSidecarPathsAbsent(backupPath);
    const verifiedAt = input.clock.now();
    assertPrivateBackup(backupDescriptor, backupIdentity);
    if (hashDescriptor(backupDescriptor, backupIdentity.size) !== sha256) {
      throw new Error('Encrypted backup checksum verification failed.');
    }
    assertDirectoryIdentity(backupDirectory, directory);
    assertPathIdentity(backupPath, backupIdentity);
    assertPrivateBackup(backupDescriptor, backupIdentity);
    assertSidecarPathsAbsent(backupPath);

    return {
      path: backupPath,
      schemaVersion: input.schemaVersion,
      sizeBytes: backupIdentity.size,
      sha256,
      verifiedAt,
    };
  } catch (error) {
    let failure = sanitizeVerificationError(error);
    if (sourceRequiresWalRestore) {
      try {
        restoreSourceJournal(input.database);
        sourceRequiresWalRestore = false;
      } catch (restoreError) {
        failure = combineErrors(
          failure,
          restoreError,
          'Encrypted backup failed and source journal restoration failed.',
        );
      }
    }
    if (backupDescriptor !== undefined) {
      if (backupIdentity === undefined) {
        try {
          backupIdentity = creationOperations.fstat(backupDescriptor);
        } catch {
          // The retained descriptor is still neutralized below. Without a proven
          // pathname identity, cleanup must preserve the path instead of guessing.
        }
      }
      try {
        ftruncateSync(backupDescriptor, 0);
        fsyncSync(backupDescriptor);
      } catch (cleanupError) {
        failure = combineErrors(
          failure,
          cleanupError,
          'Encrypted backup failed and untrusted file neutralization failed.',
        );
      }
      try {
        closeSync(backupDescriptor);
      } catch (cleanupError) {
        failure = combineErrors(
          failure,
          cleanupError,
          'Encrypted backup failed and file closure failed.',
        );
      }
      backupDescriptor = undefined;
    }
    try {
      if (
        backupPath !== undefined
        && backupIdentity !== undefined
        && pathHasIdentity(backupPath, backupIdentity)
      ) {
        rmSync(backupPath);
      }
    } catch (cleanupError) {
      failure = combineErrors(
        failure,
        cleanupError,
        'Encrypted backup failed and untrusted file removal failed.',
      );
    } finally {
      try {
        creationOperations.fsyncDirectory(directory.descriptor);
      } catch (cleanupError) {
        failure = combineErrors(
          failure,
          cleanupError,
          'Encrypted backup failed and cleanup durability failed.',
        );
      }
    }
    if (backupWasCreated) {
      throw new Error('Encrypted backup verification failed.');
    }
    throw failure;
  } finally {
    if (backupDescriptor !== undefined) {
      closeSync(backupDescriptor);
    }
    if (sourceDescriptor !== undefined) {
      closeSync(sourceDescriptor);
    }
    if (sourceRequiresWalRestore) {
      try {
        restoreSourceJournal(input.database);
      } catch {
        // The caught path already reports restoration failure. A second attempt
        // only preserves the normal WAL mode when the first failure was transient.
      }
    }
    closeSync(directory.descriptor);
  }
}

function validateBackupDirectory(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error('Encrypted backup directory must be an absolute normalized path.');
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Encrypted backup directory is invalid.');
  }
  chmodSync(path, 0o700);
  return path;
}

function openDirectory(path: string): RetainedDirectory {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | directoryFlag() | noFollowFlag(),
  );
  try {
    const identity = fstatSync(descriptor);
    if (!identity.isDirectory()) {
      throw new Error('Encrypted backup directory is invalid.');
    }
    assertPathIdentity(path, identity);
    fchmodSync(descriptor, 0o700);
    return { descriptor, identity };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function stabilizeSourceDatabase(database: AppDatabase, beforeJournalSwitch: () => void): void {
  if (database.raw.inTransaction) {
    throw new Error('Encrypted backup cannot run inside a transaction.');
  }
  const journalMode = database.raw.pragma('journal_mode', { simple: true });
  if (journalMode !== 'wal') {
    throw new Error('Encrypted backup requires WAL journal mode.');
  }
  assertTruncatedCheckpoint(database.raw.pragma('wal_checkpoint(TRUNCATE)'));
  // Arm cleanup before the operation: an exception can occur after SQLite has
  // already switched journal modes.
  beforeJournalSwitch();
  if (database.raw.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') {
    throw new Error('Encrypted backup source journal stabilization failed.');
  }
}

function restoreSourceJournal(database: AppDatabase): void {
  if (database.raw.pragma('journal_mode = WAL', { simple: true }) !== 'wal') {
    throw new Error('Encrypted backup source journal restoration failed.');
  }
}

function assertTruncatedCheckpoint(value: unknown): void {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error('Encrypted backup checkpoint result is invalid.');
  }
  const result = value[0] as unknown;
  if (
    result === null
    || typeof result !== 'object'
    || Array.isArray(result)
    || JSON.stringify(Object.keys(result).sort())
      !== JSON.stringify(['busy', 'checkpointed', 'log'])
  ) {
    throw new Error('Encrypted backup checkpoint result is invalid.');
  }
  const checkpoint = result as Record<string, unknown>;
  if (
    checkpoint.busy !== 0
    || checkpoint.log !== 0
    || checkpoint.checkpointed !== 0
  ) {
    throw new Error('Encrypted backup checkpoint did not reach a clean state.');
  }
}

function openRegularFile(path: string, flags: number): number {
  const descriptor = openSync(path, flags | noFollowFlag());
  try {
    const identity = fstatSync(descriptor);
    if (!identity.isFile()) {
      throw new Error('Encrypted backup source is not a regular file.');
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
      throw new Error('Encrypted backup source ended during copy.');
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
        throw new Error('Encrypted backup copy made no progress.');
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
    throw new Error('Encrypted backup source changed during copy.');
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
      throw new Error('Encrypted backup checksum read ended early.');
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
    throw new Error('Encrypted backup encryption verification failed.');
  }
}

function verifyBackupDatabase(
  path: string,
  key: WorkspaceKey,
  sourceSchemaVersion: number,
): void {
  let backup;
  try {
    backup = createRawDatabase(path, { readonly: true, fileMustExist: true });
    applyWorkspaceKey(backup, key.bytes);
    if (backup.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error('Encrypted backup integrity verification failed.');
    }
    const appMeta = backup
      .prepare<[], { found: number }>(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'app_meta'",
      )
      .get();
    if (sourceSchemaVersion === 0) {
      if (appMeta !== undefined) {
        throw new Error('Encrypted backup schema verification failed.');
      }
      return;
    }
    if (appMeta === undefined) {
      throw new Error('Encrypted backup schema verification failed.');
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
      throw new Error('Encrypted backup schema verification failed.');
    }
  } catch {
    throw new Error('Encrypted backup verification failed.');
  } finally {
    backup?.close();
  }
}

function assertSidecarPathsAbsent(path: string): void {
  // The source is copied in DELETE mode and verification is read-only, so this
  // attempt owns no sidecars. Any sidecar is therefore unrelated or raced in:
  // fail closed and preserve it instead of guessing ownership.
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecarPath = `${path}${suffix}`;
    try {
      lstatSync(sidecarPath);
      throw new Error('Encrypted backup sidecar path is occupied.');
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
  }
}

function assertDirectoryIdentity(
  path: string,
  directory: RetainedDirectory,
): void {
  const retainedIdentity = fstatSync(directory.descriptor);
  if (
    !retainedIdentity.isDirectory()
    || (retainedIdentity.mode & 0o777) !== 0o700
    || !sameIdentity(retainedIdentity, directory.identity)
  ) {
    throw new Error('Encrypted backup filesystem identity changed.');
  }
  assertPathIdentity(path, directory.identity);
}

function assertPrivateBackup(descriptor: number, expected: Stats): void {
  const actual = fstatSync(descriptor);
  if (!actual.isFile() || !sameIdentity(actual, expected) || actual.size !== expected.size
    || actual.nlink !== 1 || (actual.mode & 0o777) !== 0o600) {
    throw new Error('Encrypted backup file verification failed.');
  }
}

function assertSourceSchemaVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Encrypted backup source schema version is invalid.');
  }
}

function assertPathIdentity(path: string, expected: Stats): void {
  if (!pathHasIdentity(path, expected)) {
    throw new Error('Encrypted backup filesystem identity changed.');
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

function sanitizeVerificationError(error: unknown): unknown {
  if (error instanceof Error && /verification failed/i.test(error.message)) {
    return new Error('Encrypted backup verification failed.');
  }
  return error;
}

function combineErrors(
  primary: unknown,
  secondary: unknown,
  message: string,
): AggregateError {
  return new AggregateError([primary, secondary], message);
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
