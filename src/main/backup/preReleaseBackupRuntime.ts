import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from 'node:fs';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { userInfo } from 'node:os';
import { Kysely, SqliteDialect } from 'kysely';
import { resolveApplicationPaths, type ApplicationPaths } from '../applicationPaths';
import { closeDatabase, type AppDatabase } from '../db/database';
import { applyWorkspaceKey, createRawDatabase } from '../db/sqliteDriver';
import { assertPreReleaseStorageReady } from '../domain/startup/storageReadiness';
import { SystemClock } from '../domain/support/clock';
import { UuidGenerator } from '../domain/support/idGenerator';
import { SafeStorageKeyProtector, type AsyncSafeStorage } from '../security/safeStorageKeyProtector';
import { WorkspaceKeyStore } from '../security/workspaceKeyStore';
import type { WorkspaceKey } from '../security/workspaceKeyTypes';
import { BackupService } from './backupService';
import type { VerifiedBackup } from './verifiedBackup';

const COMMAND = '--callie-pre-release-backup';
const PRODUCT = 'Callie Founder Sales System';
const fail = (): never => { throw new Error('PRE_RELEASE_BACKUP_FAILED'); };
export function isPreReleaseBackupInvocation(args: readonly string[]): boolean {
  return args.some(arg => arg.startsWith(COMMAND));
}
export function validateBackupInvocation(args: readonly string[], env: NodeJS.ProcessEnv): void {
  if (args.length !== 1 || args[0] !== COMMAND
    || Object.keys(env).some(name => /^(?:CALLIE_|ELECTRON_|NODE_|DYLD_|XDG_)/.test(name))) fail();
}
const sameIdentity = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;
function privateDirectory(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) fail();
  let cursor = parse(path).root;
  for (const component of path.slice(cursor.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    const stat = lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || ((stat.mode & 0o022) !== 0 && !((stat.mode & 0o1000) !== 0 && stat.uid === 0))) fail();
  }
  const stat = lstatSync(path);
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) fail();
}
function existingFile(path: string, envelope = false): Stats {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
    || stat.nlink !== 1 || (stat.mode & 0o022) !== 0 || (envelope && (stat.mode & 0o777) !== 0o600)) fail();
  return stat;
}
export function validateExistingWorkspacePaths(paths: ApplicationPaths): void {
  if (JSON.stringify(paths) !== JSON.stringify(resolveApplicationPaths(paths.userDataPath))) fail();
  privateDirectory(paths.userDataPath);
  existingFile(paths.databasePath); existingFile(paths.keyEnvelopePath, true);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { existingFile(paths.databasePath + suffix); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  try { lstatSync(paths.backupDirectory); privateDirectory(paths.backupDirectory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
/** Existing-file-only opener. No provisioning, migration, journal conversion or rekey. */
export function openExistingPreReleaseDatabase(paths: ApplicationPaths, key: WorkspaceKey): AppDatabase {
  validateExistingWorkspacePaths(paths);
  const original = existingFile(paths.databasePath);
  const descriptor = openSync(paths.databasePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let database: AppDatabase | undefined;
  try {
    if (!sameIdentity(original, fstatSync(descriptor))) fail();
    const header = Buffer.alloc(16);
    if (readSync(descriptor, header, 0, 16, 0) !== 16 || header.equals(Buffer.from('SQLite format 3\0'))) fail();
    const raw = createRawDatabase(paths.databasePath, { fileMustExist: true });
    database = { raw, path: paths.databasePath, kysely: new Kysely({ dialect: new SqliteDialect({ database: raw }) }) };
    applyWorkspaceKey(raw, key.bytes);
    raw.pragma('foreign_keys = ON'); raw.pragma('recursive_triggers = ON'); raw.pragma('busy_timeout = 5000');
    if (!sameIdentity(original, existingFile(paths.databasePath))) fail();
    assertPreReleaseStorageReady(database);
    return database;
  } catch { if (database) closeDatabase(database); return fail(); }
  finally { closeSync(descriptor); }
}
export type PreReleaseReceipt = Omit<VerifiedBackup, 'path'>;
function receiptOnly(value: VerifiedBackup): PreReleaseReceipt {
  const { basename, kind, schemaVersion, sha256, sizeBytes, createdAt, verifiedAt } = value;
  if (typeof basename !== 'string' || !/^pre_release-[0-9]{8}T[0-9]{9}Z\.sqlite3$/.test(basename) || kind !== 'pre_release'
    || (schemaVersion !== 24 && schemaVersion !== 25 && schemaVersion !== 26 && schemaVersion !== 27 && schemaVersion !== 28) || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0
    || [createdAt, verifiedAt].some(time => !Number.isFinite(Date.parse(time)) || new Date(time).toISOString() !== time)) fail();
  return { basename, kind, schemaVersion, sha256, sizeBytes, createdAt, verifiedAt };
}
type OneShotService = Pick<BackupService, 'createBackup' | 'shutdown'>;
export type PreReleaseDependencies = {
  acquireLock(): boolean; releaseLock(): void; ready(): Promise<void>;
  paths(): ApplicationPaths; loadKey(paths: ApplicationPaths): Promise<WorkspaceKey>;
  validatePaths?: typeof validateExistingWorkspacePaths;
  open?: typeof openExistingPreReleaseDatabase; close?: typeof closeDatabase;
  service?(database: AppDatabase, paths: ApplicationPaths, loadKey: () => Promise<WorkspaceKey>): OneShotService;
};
/** Injectable core for synthetic hosts. Production calls this only through the sealed host below. */
export async function performPreReleaseBackup(deps: PreReleaseDependencies): Promise<PreReleaseReceipt> {
  let locked = false, failed = false;
  let key: WorkspaceKey | undefined, database: AppDatabase | undefined, service: OneShotService | undefined, receipt: PreReleaseReceipt | undefined;
  try {
    locked = deps.acquireLock(); if (!locked) fail();
    await deps.ready();
    const paths = deps.paths(); (deps.validatePaths ?? validateExistingWorkspacePaths)(paths);
    const loadKey = () => deps.loadKey(paths);
    key = await loadKey(); database = (deps.open ?? openExistingPreReleaseDatabase)(paths, key);
    service = deps.service ? deps.service(database, paths, loadKey) : new BackupService({
      databaseGate: { withDatabase: async operation => operation(database!) },
      backupDirectory: paths.backupDirectory, loadWorkspaceKey: loadKey, clock: new SystemClock(), ids: new UuidGenerator(),
    });
    receipt = receiptOnly(await service.createBackup('pre_release'));
  } catch { failed = true; }
  finally {
    try { await service?.shutdown(); } catch { failed = true; }
    try { if (database) (deps.close ?? closeDatabase)(database); } catch { failed = true; }
    key?.bytes.fill(0);
    try { if (locked) deps.releaseLock(); } catch { failed = true; }
  }
  if (failed || !receipt) return fail(); return receipt;
}
type PackagedHost = Pick<Electron.App, 'isPackaged' | 'getName' | 'getAppPath' | 'getPath' | 'requestSingleInstanceLock' | 'releaseSingleInstanceLock' | 'whenReady' | 'setActivationPolicy'>;
export async function runPreReleaseBackupHost(app: PackagedHost, safeStorage: AsyncSafeStorage): Promise<PreReleaseReceipt> {
  validateBackupInvocation(process.argv.slice(1), process.env);
  const home = userInfo().homedir;
  if (process.platform !== 'darwin' || !app.isPackaged || app.getName() !== PRODUCT
    || process.env.HOME !== home || app.getAppPath() !== join(process.resourcesPath, 'app.asar')) fail();
  app.setActivationPolicy('prohibited');
  const store = new WorkspaceKeyStore({ keyProtector: new SafeStorageKeyProtector(safeStorage) });
  return performPreReleaseBackup({
    acquireLock: () => app.requestSingleInstanceLock(), releaseLock: () => app.releaseSingleInstanceLock(),
    ready: async () => { await app.whenReady(); },
    paths: () => {
      const expected = join(home, 'Library/Application Support', PRODUCT);
      if (app.getPath('userData') !== expected) fail();
      return resolveApplicationPaths(expected);
    },
    loadKey: paths => store.loadOrCreate({ envelopePath: paths.keyEnvelopePath, databaseExists: true }),
  });
}
