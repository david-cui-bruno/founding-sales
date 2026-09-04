import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
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

function assertPrivateDirectory(path: string, errorCode: string): void {
  const metadata = statSync(path);
  if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0) throw new Error(errorCode);
}

function pruneExpiredFiles(directoryPath: string, today: Date): void {
  const oldest = new Date(Date.UTC(
    today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (RETENTION_DAYS - 1),
  ));
  const oldestDate = oldest.toISOString().slice(0, 10);
  for (const name of readdirSync(directoryPath)) {
    const match = DAILY_LOG.exec(name);
    if (match !== null && match[1]! < oldestDate) unlinkSync(join(directoryPath, name));
  }
}

export function createFileLogSink(input: {
  userDataPath: string;
  now?: () => Date;
  fsync?: (fileDescriptor: number) => void;
}): FileLogSink {
  assertPrivateDirectory(input.userDataPath, 'LOG_PARENT_PERMISSIONS_UNSAFE');
  const directoryPath = join(input.userDataPath, 'logs');
  if (existsSync(directoryPath)) {
    if (lstatSync(directoryPath).isSymbolicLink()) {
      throw new Error('LOG_DIRECTORY_SYMLINK_REJECTED');
    }
  } else {
    mkdirSync(directoryPath, { mode: 0o700 });
  }
  assertPrivateDirectory(directoryPath, 'LOG_DIRECTORY_PERMISSIONS_UNSAFE');
  const now = input.now ?? (() => new Date());
  const durableSync = input.fsync ?? fsyncSync;

  return {
    directoryPath,
    write(serializedEntry) {
      const current = now();
      pruneExpiredFiles(directoryPath, current);
      const path = join(directoryPath, `${current.toISOString().slice(0, 10)}.ndjson`);
      const descriptor = openSync(
        path,
        constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const metadata = statSync(path);
        if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
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
