import { createHash } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, unlinkSync,
  type Stats,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type { BackupReceipt } from '../domain/operations/operationalSafetyRepository';

/** Receipt history is immutable. This selector governs artifact files only. */
export function selectDailyBackupsForDeletion(receipts: readonly BackupReceipt[]): BackupReceipt[] {
  const daily = receipts.filter((receipt) => receipt.kind === 'daily' && hasOwnedName(receipt))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt)
      || right.backupBasename.localeCompare(left.backupBasename));
  const keep = new Set(daily.slice(0, 14));
  const weeks = new Set<string>();
  for (const receipt of daily) {
    const monday = new Date(receipt.createdAt);
    monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
    const week = monday.toISOString().slice(0, 10);
    if (!weeks.has(week) && weeks.size < 8) {
      weeks.add(week);
      keep.add(receipt);
    }
  }
  return daily.filter((receipt) => !keep.has(receipt));
}

/** Presence is not inferred from receipts. Recheck private files, identity and hash. */
export function listPresentBackupReceipts(
  directory: string,
  receipts: readonly BackupReceipt[],
): BackupReceipt[] {
  return withDirectory(directory, (identity) => receipts.filter((receipt) =>
    inspectArtifact(directory, identity, receipt) !== undefined));
}

/** Never removes receipt rows, migration snapshots, unknown files or sidecars. */
export function pruneDailyBackupFiles(directory: string, receipts: readonly BackupReceipt[]): void {
  withDirectory(directory, (directoryIdentity, descriptor): BackupReceipt[] => {
    const present = receipts.filter((receipt) => inspectArtifact(directory, directoryIdentity, receipt) !== undefined);
    for (const receipt of selectDailyBackupsForDeletion(present)) {
      const identity = inspectArtifact(directory, directoryIdentity, receipt);
      if (identity === undefined) continue;
      const path = join(directory, receipt.backupBasename);
      if (!matchesPath(directory, directoryIdentity) || !matchesPath(path, identity)) {
        throw new Error('Backup retention filesystem identity changed.');
      }
      unlinkSync(path);
      fsyncSync(descriptor);
    }
    return [];
  });
}

function hasOwnedName(receipt: BackupReceipt): boolean {
  if (!['daily', 'manual', 'pre_release'].includes(receipt.kind)) return false;
  const date = new Date(receipt.createdAt);
  return Number.isFinite(date.getTime()) && date.toISOString() === receipt.createdAt
    && receipt.backupBasename === `${receipt.kind}-${receipt.createdAt.replace(/[-:.]/g, '')}.sqlite3`
    && /^(daily|manual|pre_release)-\d{8}T\d{9}Z\.sqlite3$/.test(receipt.backupBasename);
}

function withDirectory(
  path: string,
  operation: (identity: Stats, descriptor: number) => BackupReceipt[],
): BackupReceipt[] {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('Backup directory is invalid.');
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw new Error('Backup directory is unavailable.');
  }
  try {
    const identity = fstatSync(descriptor);
    if (!identity.isDirectory() || (identity.mode & 0o777) !== 0o700 || !matchesPath(path, identity)) {
      throw new Error('Backup directory is not private.');
    }
    const result = operation(identity, descriptor);
    if (!matchesPath(path, identity)) throw new Error('Backup directory identity changed.');
    return result;
  } finally { closeSync(descriptor); }
}

function inspectArtifact(directory: string, directoryIdentity: Stats, receipt: BackupReceipt): Stats | undefined {
  if (!hasOwnedName(receipt)) return undefined;
  const path = join(directory, receipt.backupBasename);
  let descriptor: number | undefined;
  try {
    if (!matchesPath(directory, directoryIdentity) || hasSidecars(path)) return undefined;
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const identity = fstatSync(descriptor);
    if (!identity.isFile() || identity.nlink !== 1 || (identity.mode & 0o777) !== 0o600
      || identity.size !== receipt.sizeBytes || !matchesPath(path, identity)) return undefined;
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < identity.size) {
      const read = readSync(descriptor, buffer, 0, Math.min(buffer.length, identity.size - position), position);
      if (read === 0) return undefined;
      digest.update(buffer.subarray(0, read));
      position += read;
    }
    const final = fstatSync(descriptor);
    if (digest.digest('hex') !== receipt.sha256 || final.size !== identity.size
      || final.mtimeMs !== identity.mtimeMs || final.ctimeMs !== identity.ctimeMs
      || !matchesPath(path, identity) || !matchesPath(directory, directoryIdentity)
      || hasSidecars(path)) return undefined;
    return identity;
  } catch {
    // Unknown/unreadable files are not owned artifacts and are never deleted.
    return undefined;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function matchesPath(path: string, identity: Stats): boolean {
  try {
    const actual = lstatSync(path);
    return !actual.isSymbolicLink() && actual.dev === identity.dev && actual.ino === identity.ino
      && actual.isDirectory() === identity.isDirectory() && actual.isFile() === identity.isFile();
  } catch { return false; }
}

function hasSidecars(path: string): boolean {
  return ['-wal', '-shm', '-journal'].some((suffix) => {
    try { lstatSync(`${path}${suffix}`); return true; }
    catch (error) { return !(error instanceof Error && 'code' in error && error.code === 'ENOENT'); }
  });
}
