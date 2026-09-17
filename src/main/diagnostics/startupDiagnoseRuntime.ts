import { chmodSync, constants, copyFileSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { resolveApplicationPaths, type ApplicationPaths } from '../applicationPaths';
import { validateExistingWorkspacePaths } from '../backup/preReleaseBackupRuntime';
import { closeDatabase, openDatabase, type AppDatabase } from '../db/database';
import { migrateToLatest } from '../db/migrate';
import { DomainRuntime } from '../domain/domainRuntime';
import { assertPreReleaseStorageReady } from '../domain/startup/storageReadiness';
import { SystemClock } from '../domain/support/clock';
import { UuidGenerator } from '../domain/support/idGenerator';
import { SafeStorageKeyProtector, type AsyncSafeStorage } from '../security/safeStorageKeyProtector';
import { WorkspaceKeyStore } from '../security/workspaceKeyStore';
import type { WorkspaceKey } from '../security/workspaceKeyTypes';
import { classifyStartupFailure, type StartupFailureRecord } from '../startup/startupFailure';

/**
 * Headless diagnose mode. Answers one question without another blind launch:
 * does the workspace database pass the same open, readiness, migration and
 * domain bootstrap the app runs at startup? Everything runs on a private
 * temporary copy. The live database is read for the copy and never opened.
 * Output is a closed-shape report: sizes, stage names, error classes, codes
 * and our own fixed messages with any path replaced.
 */
const COMMAND = '--callie-diagnose-startup';
const PRODUCT = 'Callie Founder Sales System';
const FORBIDDEN_ENV = /^(?:CALLIE_|ELECTRON_|NODE_|DYLD_|XDG_)/;
// A rooted path, including macOS segments with a space before a capitalised word ("Application Support").
const PATH_LIKE = /(?:\/[^\s'"`]+)+(?:\s+[A-Z][^\s'"`/]*(?:\/[^\s'"`]+)+)*/g;
const SLASH_TOKEN = /\S*\/\S*/g;

export type DiagnoseStage = 'open' | 'readiness' | 'migrate' | 'domain';
export const DIAGNOSE_STAGES: readonly DiagnoseStage[] = ['open', 'readiness', 'migrate', 'domain'];
export type DiagnoseStageResult =
  | { stage: DiagnoseStage; ok: true; detail: Readonly<Record<string, number | string>> }
  | { stage: DiagnoseStage; ok: false; failure: StartupFailureRecord; message: string };
export type StartupDiagnoseReport = Readonly<{
  kind: 'diagnose_startup';
  /** Byte sizes of the live files; null when a sidecar is absent. */
  files: Readonly<{ database: number; wal: number | null; shm: number | null; journal: number | null }>;
  copied: readonly ('database' | 'wal')[];
  stages: readonly DiagnoseStageResult[];
  verdict: 'database_ready' | `database_failed_${DiagnoseStage}`;
}>;

export class StartupDiagnoseRefusedError extends Error {
  constructor(readonly reason: 'invocation' | 'host' | 'lock' | 'paths' | 'key' | 'copy') {
    super(`STARTUP_DIAGNOSE_FAILED ${reason}`);
    this.name = 'StartupDiagnoseRefusedError';
  }
}
const refuse = (reason: StartupDiagnoseRefusedError['reason']): never => { throw new StartupDiagnoseRefusedError(reason); };

export function isStartupDiagnoseInvocation(args: readonly string[]): boolean {
  return args.some(arg => arg.startsWith(COMMAND));
}
export function validateDiagnoseInvocation(args: readonly string[], env: NodeJS.ProcessEnv): void {
  if (args.length !== 1 || args[0] !== COMMAND || Object.keys(env).some(name => FORBIDDEN_ENV.test(name))) refuse('invocation');
}

/** Our own fixed messages and SQLite's. Anything path-shaped is replaced; length is capped. */
export function sanitizeDiagnoseMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'non-error thrown';
  return message.replace(PATH_LIKE, '<path>').replace(SLASH_TOKEN, '<path>').replace(/\S*<path>\S*/g, '<path>')
    .replace(/\s+/g, ' ').trim().slice(0, 240);
}

function sizeOrNull(path: string): number | null {
  try { const stat = lstatSync(path); return stat.isFile() ? stat.size : null; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export type StartupDiagnoseDependencies = {
  acquireLock(): boolean; releaseLock(): void; ready(): Promise<void>;
  paths(): ApplicationPaths; loadKey(paths: ApplicationPaths): Promise<WorkspaceKey>;
  validatePaths?: typeof validateExistingWorkspacePaths;
  /** Parent for the private scratch directory. Defaults to the OS temp root. */
  scratchRoot?: string;
};

/** Injectable core. Production reaches it only through the sealed host below. */
export async function performStartupDiagnose(deps: StartupDiagnoseDependencies): Promise<StartupDiagnoseReport> {
  let locked = false; let key: WorkspaceKey | undefined; let scratch: string | undefined;
  try {
    locked = deps.acquireLock(); if (!locked) refuse('lock');
    await deps.ready();
    const paths = deps.paths();
    try { (deps.validatePaths ?? validateExistingWorkspacePaths)(paths); } catch { refuse('paths'); }
    try { key = await deps.loadKey(paths); } catch { refuse('key'); }
    const files = {
      database: sizeOrNull(paths.databasePath) ?? refuse('paths'),
      wal: sizeOrNull(`${paths.databasePath}-wal`), shm: sizeOrNull(`${paths.databasePath}-shm`),
      journal: sizeOrNull(`${paths.databasePath}-journal`),
    };
    let copyPath: string; const copied: ('database' | 'wal')[] = [];
    try {
      scratch = mkdtempSync(join(deps.scratchRoot ?? tmpdir(), 'callie-diagnose-'));
      chmodSync(scratch, 0o700);
      copyPath = join(scratch, 'callie.sqlite3');
      copyFileSync(paths.databasePath, copyPath, constants.COPYFILE_EXCL); copied.push('database');
      // The write-ahead log is part of the database state; the shared-memory index is rebuilt by SQLite.
      if (files.wal !== null) { copyFileSync(`${paths.databasePath}-wal`, `${copyPath}-wal`, constants.COPYFILE_EXCL); copied.push('wal'); }
    } catch { refuse('copy'); }
    const stages = await runStages(copyPath, key!, join(scratch, 'backups'));
    const failed = stages.find((result): result is Extract<DiagnoseStageResult, { ok: false }> => !result.ok);
    return { kind: 'diagnose_startup', files, copied, stages, verdict: failed ? `database_failed_${failed.stage}` : 'database_ready' };
  } finally {
    key?.bytes.fill(0);
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    if (locked) deps.releaseLock();
  }
}

async function runStages(copyPath: string, key: WorkspaceKey, backupDirectory: string): Promise<DiagnoseStageResult[]> {
  const results: DiagnoseStageResult[] = [];
  let database: AppDatabase | undefined; let runtime: DomainRuntime | undefined;
  const attempt = async (stage: DiagnoseStage, run: () => Promise<Record<string, number | string>> | Record<string, number | string>): Promise<boolean> => {
    try { results.push({ stage, ok: true, detail: await run() }); return true; }
    catch (error) {
      results.push({ stage, ok: false, failure: classifyStartupFailure(stage === 'domain' ? 'domain' : stage === 'migrate' ? 'migrate' : 'open', error),
        message: sanitizeDiagnoseMessage(error) });
      return false;
    }
  };
  try {
    if (!await attempt('open', () => { database = openDatabase({ path: copyPath, key }); return {}; })) return results;
    if (!await attempt('readiness', () => {
      const readiness = assertPreReleaseStorageReady(database!);
      return { schemaVersion: readiness.schemaVersion };
    })) return results;
    if (!await attempt('migrate', async () => {
      const result = await migrateToLatest(database!, { backupDirectory, workspaceKey: key });
      return { fromVersion: result.fromVersion, toVersion: result.toVersion, applied: result.appliedMigrationIds.length };
    })) return results;
    await attempt('domain', () => {
      runtime = new DomainRuntime({ database: database!, clock: new SystemClock(), ids: new UuidGenerator() });
      const report = runtime.initialize();
      return { status: report.status, blockingViolationCount: report.blockingViolationCount,
        repairableIssueCount: report.repairableIssueCount, interruptedJobsRecovered: report.interruptedJobsRecovered };
    });
    return results;
  } finally {
    try { runtime?.shutdown(); } catch { /* the copy is discarded either way */ }
    try { if (database) closeDatabase(database); } catch { /* the copy is discarded either way */ }
  }
}

type PackagedHost = Pick<Electron.App, 'isPackaged' | 'getName' | 'getAppPath' | 'getPath' | 'requestSingleInstanceLock' | 'releaseSingleInstanceLock' | 'whenReady' | 'setActivationPolicy'>;
export async function runStartupDiagnoseHost(app: PackagedHost, safeStorage: AsyncSafeStorage): Promise<StartupDiagnoseReport> {
  validateDiagnoseInvocation(process.argv.slice(1), process.env);
  const home = userInfo().homedir;
  if (process.platform !== 'darwin' || !app.isPackaged || app.getName() !== PRODUCT
    || process.env.HOME !== home || app.getAppPath() !== join(process.resourcesPath, 'app.asar')) refuse('host');
  app.setActivationPolicy('prohibited');
  const store = new WorkspaceKeyStore({ keyProtector: new SafeStorageKeyProtector(safeStorage) });
  return performStartupDiagnose({
    acquireLock: () => app.requestSingleInstanceLock(), releaseLock: () => app.releaseSingleInstanceLock(),
    ready: async () => { await app.whenReady(); },
    paths: () => {
      const expected = join(home, 'Library/Application Support', PRODUCT);
      if (app.getPath('userData') !== expected) refuse('paths');
      return resolveApplicationPaths(expected);
    },
    loadKey: paths => store.loadOrCreate({ envelopePath: paths.keyEnvelopePath, databaseExists: true }),
  });
}
