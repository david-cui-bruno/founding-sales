import {
  closeSync,
  chmodSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

const DAILY_LOG = /^(\d{4}-\d{2}-\d{2})\.ndjson$/;
const RETENTION_DAYS = 14;

export type FileLogSink = Readonly<{
  directoryPath: string;
  write(serializedEntry: string): void;
}>;

function assertRealDirectory(path: string, errorCode: string): void {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(errorCode);
}

function pruneExpiredFiles(directoryPath: string, today: Date): void {
  const oldest = new Date(Date.UTC(
    today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (RETENTION_DAYS - 1),
  ));
  const oldestDate = oldest.toISOString().slice(0, 10);
  const todayDate = today.toISOString().slice(0, 10);
  for (const name of readdirSync(directoryPath)) {
    const match = DAILY_LOG.exec(name);
    if (match === null) continue;
    const date = match[1]!;
    let valid = false;
    try {
      valid = new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date;
    } catch {
      valid = false;
    }
    if (!valid || date < oldestDate || date > todayDate) unlinkSync(join(directoryPath, name));
  }
}

export function createFileLogSink(input: {
  userDataPath: string;
  now?: () => Date;
  fsync?: (fileDescriptor: number) => void;
  fstat?: (fileDescriptor: number) => { isFile(): boolean; mode: number };
}): FileLogSink {
  const userDataMetadata = lstatSync(input.userDataPath);
  if (userDataMetadata.isSymbolicLink()) throw new Error('LOG_PARENT_SYMLINK_REJECTED');
  if (!userDataMetadata.isDirectory() || (userDataMetadata.mode & 0o077) !== 0) {
    throw new Error('LOG_PARENT_PERMISSIONS_UNSAFE');
  }
  const directoryPath = join(input.userDataPath, 'logs');
  if (existsSync(directoryPath)) {
    if (lstatSync(directoryPath).isSymbolicLink()) {
      throw new Error('LOG_DIRECTORY_SYMLINK_REJECTED');
    }
  } else {
    mkdirSync(directoryPath, { mode: 0o700 });
  }
  assertRealDirectory(directoryPath, 'LOG_DIRECTORY_PERMISSIONS_UNSAFE');
  chmodSync(directoryPath, 0o700);
  const now = input.now ?? (() => new Date());
  const durableSync = input.fsync ?? fsyncSync;
  const descriptorStat = input.fstat ?? fstatSync;

  return {
    directoryPath,
    write(serializedEntry) {
      const current = now();
      pruneExpiredFiles(directoryPath, current);
      const path = join(directoryPath, `${current.toISOString().slice(0, 10)}.ndjson`);
      if (existsSync(path)) {
        const existing = lstatSync(path);
        if (existing.isSymbolicLink() || !existing.isFile()) {
          throw new Error('LOG_FILE_UNSAFE');
        }
        chmodSync(path, 0o600);
      }
      const descriptor = openSync(
        path,
        constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        fchmodSync(descriptor, 0o600);
        const metadata = descriptorStat(descriptor);
        if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
          throw new Error('LOG_FILE_PERMISSIONS_UNSAFE');
        }
        writeSync(descriptor, `${serializedEntry}\n`, undefined, 'utf8');
        durableSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    },
  };
}
