import {
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

const DAILY_LOG = /^(\d{4}-\d{2}-\d{2})\.ndjson$/;
const RETENTION_DAYS = 14;

type NativeLogDirectory = Readonly<{
  listDailyNames(): string[];
  openDaily(basename: string): number;
  unlinkDaily(basename: string): void;
  close(): void;
}>;

type NativeSafeLogFs = Readonly<{
  openLogDirectory(path: string): NativeLogDirectory;
}>;

let loadedNative: NativeSafeLogFs | undefined;

function loadNativeSafeLogFs(): NativeSafeLogFs {
  if (loadedNative !== undefined) return loadedNative;
  const candidates = [
    join(__dirname, 'safe_log_fs.node'),
    join(process.cwd(), 'native/safe-log-fs/build/Release/safe_log_fs.node'),
  ];
  const artifact = candidates.find((candidate) => existsSync(candidate));
  if (artifact === undefined) throw new Error('SAFE_LOG_FS_NATIVE_UNAVAILABLE');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Native addons require runtime path loading.
  loadedNative = require(artifact) as NativeSafeLogFs;
  return loadedNative;
}

export type FileLogSink = Readonly<{
  directoryPath: string;
  write(serializedEntry: string): void;
}>;

function isCanonicalUtcDate(date: string): boolean {
  try {
    return new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date;
  } catch {
    return false;
  }
}

function pruneExpiredFiles(directory: NativeLogDirectory, today: Date): void {
  const oldest = new Date(Date.UTC(
    today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (RETENTION_DAYS - 1),
  ));
  const oldestDate = oldest.toISOString().slice(0, 10);
  const todayDate = today.toISOString().slice(0, 10);
  for (const name of directory.listDailyNames()) {
    const match = DAILY_LOG.exec(name);
    if (match === null) continue;
    const date = match[1]!;
    if (!isCanonicalUtcDate(date) || date < oldestDate || date > todayDate) {
      directory.unlinkDaily(name);
    }
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
    const metadata = lstatSync(directoryPath);
    if (metadata.isSymbolicLink()) throw new Error('LOG_DIRECTORY_SYMLINK_REJECTED');
    if (!metadata.isDirectory() || (metadata.mode & 0o777) !== 0o700) {
      throw new Error('LOG_DIRECTORY_PERMISSIONS_UNSAFE');
    }
  } else {
    mkdirSync(directoryPath, { mode: 0o700 });
  }
  const directory = loadNativeSafeLogFs().openLogDirectory(directoryPath);
  const now = input.now ?? (() => new Date());
  const durableSync = input.fsync ?? fsyncSync;
  const descriptorStat = input.fstat ?? fstatSync;

  return {
    directoryPath,
    write(serializedEntry) {
      const current = now();
      pruneExpiredFiles(directory, current);
      const basename = `${current.toISOString().slice(0, 10)}.ndjson`;
      const descriptor = directory.openDaily(basename);
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
