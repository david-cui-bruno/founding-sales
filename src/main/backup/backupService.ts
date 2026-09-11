import { join } from 'node:path';

import type { AppDatabase } from '../db/database';
import { OperationalSafetyRepository, type BackupReceipt } from '../domain/operations/operationalSafetyRepository';
import type { Clock } from '../domain/support/clock';
import { DomainUnitOfWork } from '../domain/support/domainUnitOfWork';
import type { IdGenerator } from '../domain/support/idGenerator';
import type { WorkspaceKey } from '../security/workspaceKeyTypes';
import { listPresentBackupReceipts, pruneDailyBackupFiles } from './backupRetention';
import { createVerifiedEncryptedBackup, type BackupKind, type VerifiedBackup } from './verifiedBackup';

export type BackupDatabaseGate = {
  withDatabase<T>(operation: (database: AppDatabase) => T | Promise<T>): Promise<T>;
};
export type BackupTimer = {
  schedule(callback: () => void, intervalMs: number): () => void;
};
export type BackupServiceOptions = {
  databaseGate: BackupDatabaseGate;
  backupDirectory: string;
  loadWorkspaceKey(): Promise<WorkspaceKey>;
  clock: Clock;
  ids: IdGenerator;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const hourlyTimer: BackupTimer = {
  schedule(callback, intervalMs) {
    const timer = setInterval(callback, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  },
};

/** Main-process owner. Serializes copies, never retains key bytes between attempts. */
export class BackupService {
  private stopped = false;
  private cancelTimer: (() => void) | undefined;
  private pending: Promise<void> = Promise.resolve();
  private lastFailureCode: 'BACKUP_FAILED' | null = null;

  constructor(private readonly options: BackupServiceOptions) {}

  async start(timer: BackupTimer = hourlyTimer): Promise<void> {
    this.assertActive();
    if (this.cancelTimer !== undefined) return this.idle();
    this.cancelTimer = timer.schedule(() => { void this.runScheduledCheck(); }, 60 * 60 * 1000);
    await this.runScheduledCheck();
  }

  checkDue(): Promise<VerifiedBackup | null> {
    return this.enqueue(() => this.options.databaseGate.withDatabase(async (database) => {
      this.assertActive();
      const { repository, unitOfWork } = this.repositories(database);
      const now = Date.parse(this.options.clock.now());
      if (!Number.isFinite(now)) throw new Error('Backup clock is invalid.');
      const recent = repository.listBackups().filter((receipt) =>
        receipt.kind === 'daily' && now - Date.parse(receipt.createdAt) < DAY_MS);
      if (this.present(recent).length > 0) return null;
      return this.create(database, repository, unitOfWork, 'daily');
    }));
  }

  /** Explicit manual/pre-release entry point, also used by the release workflow. */
  createBackup(kind: BackupKind): Promise<VerifiedBackup> {
    return this.enqueue(() => this.options.databaseGate.withDatabase((database) => {
      const { repository, unitOfWork } = this.repositories(database);
      return this.create(database, repository, unitOfWork, kind);
    }));
  }

  listAvailableBackups(): Promise<VerifiedBackup[]> {
    return this.enqueue(() => this.options.databaseGate.withDatabase((database) => {
      const { repository } = this.repositories(database);
      return this.present(repository.listBackups()).map((receipt) => ({
        path: join(this.options.backupDirectory, receipt.backupBasename),
        basename: receipt.backupBasename,
        kind: receipt.kind,
        schemaVersion: receipt.schemaVersion,
        sha256: receipt.sha256,
        sizeBytes: receipt.sizeBytes,
        createdAt: receipt.createdAt,
        verifiedAt: receipt.verifiedAt,
      }));
    }));
  }

  getLastFailureCode(): 'BACKUP_FAILED' | null { return this.lastFailureCode; }

  idle(): Promise<void> { return this.pending; }

  async shutdown(): Promise<void> {
    this.stopped = true;
    try { this.cancelTimer?.(); }
    finally { this.cancelTimer = undefined; await this.idle(); }
  }

  private async runScheduledCheck(): Promise<void> {
    try { await this.checkDue(); }
    catch { /* The allowlisted failure code is retained, never raw errors or paths. */ }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(() => {
      this.assertActive();
      return operation();
    });
    this.pending = result.then(
      () => { this.lastFailureCode = null; },
      () => { if (!this.stopped) this.lastFailureCode = 'BACKUP_FAILED'; },
    );
    return result;
  }

  private async create(
    database: AppDatabase,
    repository: OperationalSafetyRepository,
    unitOfWork: DomainUnitOfWork,
    kind: BackupKind,
  ): Promise<VerifiedBackup> {
    this.assertActive();
    let key: WorkspaceKey | undefined;
    try {
      key = await this.options.loadWorkspaceKey();
      this.assertActive();
      const metadata = database.raw.prepare<[], { schema_version: number }>(
        'SELECT schema_version FROM app_meta WHERE singleton = 1',
      ).get();
      if (!Number.isSafeInteger(metadata?.schema_version) || metadata.schema_version < 1) {
        throw new Error('Backup source schema is invalid.');
      }
      // This synchronous copy must be outside any active transaction. Its own
      // verification checks the exact caller-supplied schema, not a fixed ceiling.
      const backup = createVerifiedEncryptedBackup({
        database, backupDirectory: this.options.backupDirectory,
        key, kind, schemaVersion: metadata.schema_version, clock: this.options.clock,
      });
      unitOfWork.immediate(() => repository.recordBackup({
        id: this.options.ids.next(), backupBasename: backup.basename, kind: backup.kind,
        schemaVersion: backup.schemaVersion, sha256: backup.sha256, sizeBytes: backup.sizeBytes,
        createdAt: backup.createdAt, verifiedAt: backup.verifiedAt,
      }));
      // A verified copy is never rolled back/unlinked if recording or pruning fails.
      pruneDailyBackupFiles(this.options.backupDirectory, repository.listBackups());
      return backup;
    } finally { key?.bytes.fill(0); }
  }

  private repositories(database: AppDatabase) {
    const unitOfWork = new DomainUnitOfWork(database);
    return { unitOfWork, repository: new OperationalSafetyRepository({ database, unitOfWork }) };
  }

  private present(receipts: readonly BackupReceipt[]): BackupReceipt[] {
    return listPresentBackupReceipts(this.options.backupDirectory, receipts);
  }

  private assertActive(): void {
    if (this.stopped) throw new Error('Backup service has shut down.');
  }
}
