import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute } from 'node:path';

export function sameIdentity(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
export function assertPrivateFile(stat: fs.Stats): void {
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error('Unsafe file');
}
export function assertIdentity(path: string, fd: number, expected: fs.Stats): void {
  const current = fs.fstatSync(fd);
  assertPrivateFile(current);
  const named = fs.lstatSync(path);
  if (!sameIdentity(current, expected) || !sameIdentity(named, expected) || !named.isFile() || current.size !== expected.size) throw new Error('Changed file');
}
export function assertNoSidecars(path: string): void {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { fs.lstatSync(path + suffix); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    throw new Error('Occupied sidecar');
  }
}
export function hashDescriptor(fd: number): string {
  const chunk = Buffer.alloc(64 * 1024);
  try {
    const hash = createHash('sha256');
    let position = 0;
    for (;;) {
      const size = fs.readSync(fd, chunk, 0, chunk.length, position);
      if (size === 0) return hash.digest('hex');
      hash.update(chunk.subarray(0, size)); position += size;
    }
  } finally { chunk.fill(0); }
}
export function removeOwnedFile(path: string, identity: fs.Stats): void {
  let current: fs.Stats;
  try { current = fs.lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!current.isFile() || !sameIdentity(current, identity)) throw new Error('Changed cleanup target');
  fs.unlinkSync(path);
}

/** Explicit chosen-location export. Never chmod or overwrite a preexisting path. */
export function writeRecoveryExport(path: string, material: string): void {
  if (!isAbsolute(path)) throw new Error('Invalid destination');
  const parent = dirname(path);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || (parentStat.mode & 0o022) !== 0 || parentStat.uid !== process.getuid?.()) throw new Error('Unsafe parent');
  const directory = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
  let fd: number | undefined;
  let identity: fs.Stats | undefined;
  const bytes = Buffer.from(material, 'utf8');
  try {
    if (!sameIdentity(fs.fstatSync(directory), parentStat)) throw new Error('Changed parent');
    fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    identity = fs.fstatSync(fd);
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    identity = { ...identity, size: bytes.length } as fs.Stats;
    assertIdentity(path, fd, identity);
    fs.fsyncSync(directory);
    if (!sameIdentity(fs.lstatSync(parent), parentStat) || (fs.fstatSync(directory).mode & 0o022) !== 0) throw new Error('Changed parent');
    assertIdentity(path, fd, identity);
  } catch (error) {
    if (fd !== undefined) {
      // Neutralize only the retained attempt descriptor, never a replacement path.
      try { fs.ftruncateSync(fd, 0); } finally {
        if (identity !== undefined) removeOwnedFile(path, identity);
      }
    }
    throw error;
  } finally {
    bytes.fill(0);
    try { if (fd !== undefined) fs.closeSync(fd); } finally { fs.closeSync(directory); }
  }
}

export function readRecoveryMaterial(path: string): string {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const bytes = Buffer.alloc(513);
  try {
    const stat = fs.fstatSync(fd); assertPrivateFile(stat);
    if (stat.size < 1 || stat.size > 512) throw new Error('Invalid material size');
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    assertIdentity(path, fd, stat);
    if (size !== stat.size) throw new Error('Changed material');
    return bytes.subarray(0, size).toString('utf8');
  } finally { bytes.fill(0); fs.closeSync(fd); }
}
