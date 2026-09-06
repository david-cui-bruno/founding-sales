import { existsSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BackupService, type BackupTimer } from '../../src/main/backup/backupService';
import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { applyWorkspaceKey, createRawDatabase } from '../../src/main/db/sqliteDriver';
import { OperationalSafetyRepository } from '../../src/main/domain/operations/operationalSafetyRepository';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import type { WorkspaceKey } from '../../src/main/security/workspaceKeyTypes';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';

class ManualTimer implements BackupTimer {
  callback: (() => void) | undefined;
  intervalMs: number | undefined;
  schedule(callback: () => void, intervalMs: number) {
    this.callback = callback;
    this.intervalMs = intervalMs;
    return () => { this.callback = undefined; };
  }
}

describe('periodic backup service with real encrypted storage', () => {
  let temp: TempDatabase;
  let database: AppDatabase;
  let service: BackupService;
  let repository: OperationalSafetyRepository;
  let backupDirectory: string;
  let now: string;
  let loadedKeys: WorkspaceKey[];
  let keyByte: number;
  let loadKey: () => Promise<WorkspaceKey>;
  let sequence: number;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    backupDirectory = join(dirname(temp.path), 'backups');
    await migrateToLatest(database, { backupDirectory, workspaceKey: key });
    key.bytes.fill(0);
    repository = new OperationalSafetyRepository({ database, unitOfWork: new DomainUnitOfWork(database) });
    now = '2026-09-06T12:00:00.000Z';
    loadedKeys = [];
    keyByte = 0x2a;
    sequence = 0;
    loadKey = async () => {
      const loaded = createTestWorkspaceKey(keyByte);
      loadedKeys.push(loaded);
      return loaded;
    };
    service = makeService();
  });
  afterEach(async () => { await service.shutdown(); closeDatabase(database); temp.cleanup(); });

  function makeService() {
    return new BackupService({
      databaseGate: { withDatabase: async (operation) => operation(database) },
      backupDirectory, loadWorkspaceKey: () => loadKey(),
      clock: { now: () => now }, ids: { next: () => `backup-${++sequence}` },
    });
  }

  it('checks on startup and hourly, never duplicates within 24 hours including concurrent checks and restart', async () => {
    const timer = new ManualTimer();
    await service.start(timer);
    expect(timer.intervalMs).toBe(3_600_000);
    expect(repository.listBackups()).toHaveLength(1);
    expect(loadedKeys[0].bytes).toEqual(Buffer.alloc(32));
    now = '2026-09-07T11:59:59.999Z';
    timer.callback?.();
    await service.idle();
    expect(repository.listBackups()).toHaveLength(1);
    await service.shutdown();
    expect(timer.callback).toBeUndefined();
    service = makeService();
    await service.start(timer);
    expect(repository.listBackups()).toHaveLength(1);
    now = '2026-09-07T12:00:00.000Z';
    await Promise.all([service.checkDue(), service.checkDue()]);
    expect(repository.listBackups()).toHaveLength(2);
    expect(loadedKeys).toHaveLength(2);
    expect(loadedKeys.every((entry) => entry.bytes.equals(Buffer.alloc(32)))).toBe(true);
  });

  it('makes explicit manual and pre-release snapshots and records receipts only after completed verification, outside the copy transaction', async () => {
    const manual = await service.createBackup('manual');
    now = '2026-09-06T13:00:00.000Z';
    const release = await service.createBackup('pre_release');
    expect(repository.listBackups().map((receipt) => receipt.kind)).toEqual(['pre_release', 'manual']);
    expect(repository.listBackups()[0]).toMatchObject({
      backupBasename: release.basename, sha256: release.sha256, sizeBytes: readFileSync(release.path).length,
    });
    const copy = createRawDatabase(manual.path, { readonly: true, fileMustExist: true });
    try {
      applyWorkspaceKey(copy, createTestWorkspaceKey().bytes);
      // The snapshot precedes the receipt INSERT, which is its own short UOW.
      expect(copy.prepare('SELECT count(*) AS count FROM backup_receipts').get()).toEqual({ count: 0 });
    } finally { copy.close(); }
    expect(database.raw.inTransaction).toBe(false);
    expect(database.raw.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('never records failed verification, zeroes a reloaded wrong key and retries on the next hourly check', async () => {
    const before = readdirSync(backupDirectory);
    keyByte = 0x3a;
    const timer = new ManualTimer();
    await service.start(timer);
    expect(service.getLastFailureCode()).toBe('BACKUP_FAILED');
    expect(repository.listBackups()).toEqual([]);
    expect(readdirSync(backupDirectory)).toEqual(before);
    expect(loadedKeys[0].bytes).toEqual(Buffer.alloc(32));
    expect(database.raw.pragma('journal_mode', { simple: true })).toBe('wal');
    keyByte = 0x2a;
    now = '2026-09-06T13:00:00.000Z';
    timer.callback?.();
    await service.idle();
    expect(repository.listBackups()).toHaveLength(1);
    expect(service.getLastFailureCode()).toBeNull();
  });

  it('preserves a fully verified file if immutable receipt insertion fails', async () => {
    await service.createBackup('manual');
    sequence = 0; // The real primary key constraint rejects the next receipt.
    now = '2026-09-06T13:00:00.000Z';
    await expect(service.createBackup('manual')).rejects.toThrow();
    expect(repository.listBackups()).toHaveLength(1);
    expect(readdirSync(backupDirectory).filter((name) => name.startsWith('manual-'))).toHaveLength(2);
    expect(loadedKeys.every((entry) => entry.bytes.equals(Buffer.alloc(32)))).toBe(true);
  });

  it('retains receipt history while pruning only owned daily artifacts and preserving migration/manual/pre-release copies', async () => {
    const migrationNames = readdirSync(backupDirectory);
    await service.createBackup('manual');
    await service.createBackup('pre_release');
    for (let day = 1; day <= 25; day += 1) {
      now = `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`;
      await service.createBackup('daily');
    }
    const names = readdirSync(backupDirectory);
    expect(repository.listBackups()).toHaveLength(27);
    // September 12..25 are the fourteen newest. Only Sunday the 6th is an
    // additional weekly representative; Sundays the 13th/20th already overlap.
    expect(names.filter((name) => name.startsWith('daily-')).map((name) => name.slice(12, 14))).toEqual([
      '06', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24', '25',
    ]);
    for (const name of migrationNames) expect(names).toContain(name);
    expect(names).toContain('manual-20260906T120000000Z.sqlite3');
    expect(names).toContain('pre_release-20260906T120000000Z.sqlite3');
    expect((await service.listAvailableBackups()).length).toBe(17);
  });

  it('ignores missing, corrupted, symlink and sidecar-occupied artifacts despite old receipts, and makes a missing daily current again', async () => {
    const daily = await service.createBackup('daily');
    const manual = await service.createBackup('manual');
    const release = await service.createBackup('pre_release');
    rmSync(daily.path);
    writeFileSync(manual.path, 'unrelated replacement');
    rmSync(release.path);
    symlinkSync(manual.path, release.path);
    expect(await service.listAvailableBackups()).toEqual([]);
    now = '2026-09-06T13:00:00.000Z';
    const replacement = await service.checkDue();
    expect(replacement?.kind).toBe('daily');
    expect(repository.listBackups()).toHaveLength(4);
    expect(readFileSync(manual.path, 'utf8')).toBe('unrelated replacement');
    writeFileSync(`${replacement?.path}-wal`, 'unrelated sidecar');
    expect(await service.listAvailableBackups()).toEqual([]);
  });

  it('waits for owned key loading on shutdown, zeroes the late key, and performs no copy or receipt after stop', async () => {
    let resolveKey!: (key: WorkspaceKey) => void;
    let keyLoadStarted!: () => void;
    const started = new Promise<void>((resolve) => { keyLoadStarted = resolve; });
    loadKey = () => { keyLoadStarted(); return new Promise((resolve) => { resolveKey = resolve; }); };
    const checking = service.checkDue();
    const caught = checking.catch((): undefined => undefined);
    await started;
    let stopped = false;
    const shutdown = service.shutdown().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    const key = createTestWorkspaceKey();
    resolveKey(key);
    await Promise.all([shutdown, caught]);
    expect(key.bytes).toEqual(Buffer.alloc(32));
    expect(repository.listBackups()).toEqual([]);
    expect(readdirSync(backupDirectory).some((name) => name.startsWith('daily-'))).toBe(false);
    await expect(service.createBackup('manual')).rejects.toThrow();
  });

  it('does not delete a substituted artifact selected by a stale receipt during retention', async () => {
    now = '2026-09-01T12:00:00.000Z';
    const replaced = await service.createBackup('daily');
    writeFileSync(replaced.path, 'preserve unrelated replacement');
    for (let day = 2; day <= 20; day += 1) {
      now = `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`;
      await service.createBackup('daily');
    }
    expect(existsSync(replaced.path)).toBe(true);
    expect(readFileSync(replaced.path, 'utf8')).toBe('preserve unrelated replacement');
  });
});
