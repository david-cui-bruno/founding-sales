import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { RECOVERY_ERROR, restoreDrillReceiptSchema, type RestoreDrillReceipt } from '../../shared/contracts/recoveryContract';
import type { VerifiedBackup } from '../backup/verifiedBackup';
import { isRegisteredSchemaVersion } from '../db/migrate';
import { applyWorkspaceKey, createRawDatabase, type RawDatabase } from '../db/sqliteDriver';
import type { Clock } from '../domain/support/clock';
import { parseRecoveryKeyMaterial } from '../security/recoveryKey';
import type { WorkspaceKey } from '../security/workspaceKeyTypes';
import { assertIdentity, assertNoSidecars, assertPrivateFile, hashDescriptor, removeOwnedFile, sameIdentity } from './recoveryFiles';

export type RestoreDrillInput = {
  backup: VerifiedBackup;
  liveDatabasePath: string;
  material: string;
  clock: Clock;
  temporaryRoot?: string;
};

/** No checkpoint, journal mutation, migration, key-store access or live DB open. */
export function runRestoreDrill(input: RestoreDrillInput): RestoreDrillReceipt {
  let source: number | undefined;
  let destination: number | undefined;
  let directory: string | undefined;
  let directoryIdentity: fs.Stats | undefined;
  let destinationIdentity: fs.Stats | undefined;
  let raw: RawDatabase | undefined;
  let key: WorkspaceKey | undefined;
  let receipt: RestoreDrillReceipt | undefined;
  let failed = false;
  const chunk = Buffer.alloc(64 * 1024);
  try {
    key = parseRecoveryKeyMaterial(input.material);
    if (!isRegisteredSchemaVersion(input.backup.schemaVersion)) throw new Error('Unsupported schema');
    source = fs.openSync(input.backup.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const sourceStat = fs.fstatSync(source); assertPrivateFile(sourceStat);
    const parent = fs.lstatSync(dirname(input.backup.path));
    if (!parent.isDirectory() || (parent.mode & 0o777) !== 0o700) throw new Error('Unsafe source directory');
    const live = fs.lstatSync(input.liveDatabasePath);
    if (sameIdentity(sourceStat, live) || sourceStat.size !== input.backup.sizeBytes) throw new Error('Wrong source');
    const verifySource = () => {
      assertIdentity(input.backup.path, source!, sourceStat); assertNoSidecars(input.backup.path);
      const currentParent = fs.lstatSync(dirname(input.backup.path));
      if (!sameIdentity(parent, currentParent) || (currentParent.mode & 0o777) !== 0o700 || hashDescriptor(source!) !== input.backup.sha256) throw new Error('Changed source');
    };
    verifySource();
    fs.readSync(source, chunk, 0, 16, 0);
    if (chunk.subarray(0, 16).toString('utf8') === 'SQLite format 3\0') throw new Error('Plaintext source');
    directory = fs.mkdtempSync(join(input.temporaryRoot ?? tmpdir(), 'callie-restore-'));
    directoryIdentity = fs.lstatSync(directory);
    if (!directoryIdentity.isDirectory() || (directoryIdentity.mode & 0o777) !== 0o700) throw new Error('Unsafe temporary directory');
    const path = join(directory, 'drill.sqlite3');
    destination = fs.openSync(path, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    destinationIdentity = fs.fstatSync(destination);
    fs.fchmodSync(destination, 0o600);
    let position = 0;
    while (position < sourceStat.size) {
      const size = fs.readSync(source, chunk, 0, Math.min(chunk.length, sourceStat.size - position), position);
      if (size === 0) throw new Error('Truncated source');
      let written = 0;
      while (written < size) {
        const n = fs.writeSync(destination, chunk, written, size - written, position + written);
        if (n === 0) throw new Error('Short copy');
        written += n;
      }
      position += size;
    }
    fs.fsyncSync(destination);
    destinationIdentity = fs.fstatSync(destination);
    const verifyCopy = () => {
      assertIdentity(path, destination!, destinationIdentity!); assertNoSidecars(path);
      const current = fs.lstatSync(directory!);
      if (!sameIdentity(current, directoryIdentity!) || (current.mode & 0o777) !== 0o700 || hashDescriptor(destination!) !== input.backup.sha256) throw new Error('Changed temporary copy');
    };
    verifySource(); verifyCopy();
    raw = createRawDatabase(path, { readonly: true, fileMustExist: true });
    applyWorkspaceKey(raw, key.bytes);
    const integrity = raw.pragma('integrity_check') as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('Integrity failure');
    const meta = raw.prepare('SELECT schema_version FROM app_meta WHERE singleton = 1').get() as { schema_version: number } | undefined;
    if (meta?.schema_version !== input.backup.schemaVersion) throw new Error('Schema mismatch');
    for (const table of ['persons', 'prospects', 'source_events']) {
      if (!raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) throw new Error('Missing aggregate table');
    }
    const counts = raw.prepare('SELECT (SELECT COUNT(*) FROM persons) AS people, (SELECT COUNT(*) FROM prospects) AS prospects, (SELECT COUNT(*) FROM source_events) AS sourceEvents').get();
    receipt = restoreDrillReceiptSchema.parse({ backupTimestamp: input.backup.createdAt, backupSha256: input.backup.sha256, schemaVersion: meta.schema_version, verifiedAt: input.clock.now(), aggregateCounts: counts });
    raw.close(); raw = undefined;
    verifySource(); verifyCopy();
  } catch { failed = true; }
  finally {
    key?.bytes.fill(0); key = undefined; chunk.fill(0);
    // Every cleanup is attempted even if an earlier cleanup failed. No recursive deletion.
    const clean = (operation: () => void) => { try { operation(); } catch { failed = true; } };
    if (raw !== undefined) clean(() => raw!.close());
    if (destination !== undefined) clean(() => fs.closeSync(destination!));
    if (source !== undefined) clean(() => fs.closeSync(source!));
    if (directory !== undefined && directoryIdentity !== undefined) {
      clean(() => {
        if (!sameIdentity(fs.lstatSync(directory!), directoryIdentity!)) throw new Error('Changed temporary directory');
        if (destinationIdentity !== undefined) removeOwnedFile(join(directory!, 'drill.sqlite3'), destinationIdentity);
        fs.rmdirSync(directory!);
      });
    }
  }
  if (failed || receipt === undefined) throw new Error(RECOVERY_ERROR);
  return receipt;
}
