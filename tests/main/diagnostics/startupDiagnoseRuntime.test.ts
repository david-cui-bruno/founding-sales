import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveApplicationPaths, type ApplicationPaths } from '../../../src/main/applicationPaths';
import { closeDatabase, openDatabase } from '../../../src/main/db/database';
import { migrateToLatest } from '../../../src/main/db/migrate';
import {
  StartupDiagnoseRefusedError, isStartupDiagnoseInvocation, performStartupDiagnose, sanitizeDiagnoseMessage,
  validateDiagnoseInvocation, type DiagnoseStageResult, type StartupDiagnoseDependencies,
} from '../../../src/main/diagnostics/startupDiagnoseRuntime';
import { createTestWorkspaceKey } from '../../fixtures/tempDatabase';

const key = createTestWorkspaceKey();
let root: string; let paths: ApplicationPaths; let scratchRoot: string;

const dependencies = (overrides: Partial<StartupDiagnoseDependencies> = {}): StartupDiagnoseDependencies & { events: string[] } => {
  const events: string[] = [];
  return {
    events,
    acquireLock: () => { events.push('lock'); return true; },
    releaseLock: () => { events.push('release'); },
    ready: async () => { events.push('ready'); },
    paths: () => paths,
    loadKey: async () => ({ bytes: Buffer.from(key.bytes), version: 1 }),
    validatePaths: () => undefined,
    scratchRoot,
    ...overrides,
  };
};

const snapshot = () => Object.fromEntries(readdirSync(root).sort().map(name => [name, statSync(join(root, name)).size]));

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'callie-diagnose-live-')); chmodSync(root, 0o700);
  scratchRoot = mkdtempSync(join(tmpdir(), 'callie-diagnose-scratch-'));
  paths = resolveApplicationPaths(root);
  const database = openDatabase({ path: paths.databasePath, key });
  try { await migrateToLatest(database, { backupDirectory: paths.backupDirectory, workspaceKey: key }); }
  finally { closeDatabase(database); }
  writeFileSync(paths.keyEnvelopePath, '{}', { mode: 0o600 });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(scratchRoot, { recursive: true, force: true }); });

describe('performStartupDiagnose', () => {
  it('runs open, readiness, migrate and domain bootstrap on a private copy and leaves the live files untouched', async () => {
    const before = snapshot();
    const deps = dependencies();
    const report = await performStartupDiagnose(deps);
    expect(report.kind).toBe('diagnose_startup');
    expect(report.verdict).toBe('database_ready');
    expect(report.copied).toEqual(['database']);
    expect(report.files.database).toBeGreaterThan(0);
    expect(report.files.journal).toBeNull();
    expect(report.stages.map(stage => [stage.stage, stage.ok])).toEqual([['open', true], ['readiness', true], ['migrate', true], ['domain', true]]);
    const readiness = report.stages[1]!; const migrate = report.stages[2]!; const domain = report.stages[3]!;
    if (!readiness.ok || !migrate.ok || !domain.ok) throw new Error('unreachable');
    expect(readiness.detail.schemaVersion).toBe(28);
    expect(migrate.detail).toEqual({ fromVersion: 28, toVersion: 28, applied: 0 });
    expect(domain.detail.status).toBe('ready');
    expect(snapshot()).toEqual(before);
    expect(readdirSync(scratchRoot)).toEqual([]);
    expect(deps.events).toEqual(['lock', 'ready', 'release']);
    expect(JSON.stringify(report)).not.toContain(root);
  });

  it('copies a present write-ahead log and reports sidecar sizes', async () => {
    writeFileSync(`${paths.databasePath}-wal`, ''); writeFileSync(`${paths.databasePath}-shm`, Buffer.alloc(32768));
    const report = await performStartupDiagnose(dependencies());
    expect(report.files.wal).toBe(0); expect(report.files.shm).toBe(32768);
    expect(report.copied).toEqual(['database', 'wal']);
    expect(report.verdict).toBe('database_ready');
  });

  it('reports a wrong key as an open-stage SqliteError with the closed code and a path-free message', async () => {
    const report = await performStartupDiagnose(dependencies({ loadKey: async () => createTestWorkspaceKey(0x11) }));
    expect(report.verdict).toMatch(/^database_failed_(open|readiness)$/);
    const failed = report.stages.find((stage): stage is Extract<DiagnoseStageResult, { ok: false }> => !stage.ok);
    if (!failed) throw new Error('unreachable');
    expect(failed.failure.errorClass).toBe('SqliteError');
    expect(failed.failure.code).toBe('SQLITE_NOTADB');
    expect(failed.message).not.toContain('/');
    expect(readdirSync(scratchRoot)).toEqual([]);
  });

  it('refuses with one closed reason and still releases the lock', async () => {
    await expect(performStartupDiagnose(dependencies({ acquireLock: () => false }))).rejects.toMatchObject({ reason: 'lock' });
    await expect(performStartupDiagnose(dependencies({ validatePaths: () => { throw new Error('/Users/founder/private'); } }))).rejects.toMatchObject({ reason: 'paths' });
    await expect(performStartupDiagnose(dependencies({ loadKey: async () => { throw new Error('keychain'); } }))).rejects.toMatchObject({ reason: 'key' });
    const deps = dependencies({ scratchRoot: join(scratchRoot, 'missing-parent') });
    await expect(performStartupDiagnose(deps)).rejects.toMatchObject({ reason: 'copy' });
    expect(deps.events).toEqual(['lock', 'ready', 'release']);
    expect(new StartupDiagnoseRefusedError('host').message).toBe('STARTUP_DIAGNOSE_FAILED host');
  });

  it('validates the invocation and sanitizes messages', () => {
    expect(isStartupDiagnoseInvocation(['--callie-diagnose-startup'])).toBe(true);
    expect(isStartupDiagnoseInvocation(['--callie-pre-release-backup'])).toBe(false);
    expect(() => validateDiagnoseInvocation(['--callie-diagnose-startup'], { HOME: '/Users/founder' })).not.toThrow();
    expect(() => validateDiagnoseInvocation(['--callie-diagnose-startup', 'extra'], {})).toThrow('invocation');
    expect(() => validateDiagnoseInvocation(['--callie-diagnose-startup'], { NODE_REPL_TRUSTED_CODE_PATHS: '/x' })).toThrow('invocation');
    expect(sanitizeDiagnoseMessage(new Error('unable to open /Users/founder/Library/Application Support/callie.sqlite3 for reading')))
      .toBe('unable to open <path> for reading');
    expect(sanitizeDiagnoseMessage('text')).toBe('non-error thrown');
    expect(sanitizeDiagnoseMessage(new Error('copy /Users/founder/Callie Backups/pre_release.sqlite3 failed'))).toBe('copy <path> failed');
    expect(sanitizeDiagnoseMessage(new Error('odd relative/segment here'))).toBe('odd <path> here');
    expect(sanitizeDiagnoseMessage(new Error('x'.repeat(500)))).toHaveLength(240);
  });
});

describe('scratch privacy', () => {
  it('creates the scratch directory under the requested root with owner-only permissions', async () => {
    const created: string[] = [];
    const observing = dependencies({ ready: async () => { mkdirSync(join(scratchRoot, 'marker')); } });
    await performStartupDiagnose(observing);
    created.push(...readdirSync(scratchRoot));
    expect(created).toEqual(['marker']);
    expect(existsSync(join(scratchRoot, 'marker'))).toBe(true);
  });
});
