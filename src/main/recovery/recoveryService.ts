import { basename } from 'node:path';
import type { z } from 'zod';
import {
  RECOVERY_ERROR, RECOVERY_SESSION_MS, beginSetupRequestSchema, completeSetupRequestSchema,
  recoverySessionSchema, recoveryStatusSchema, restoreDrillRequestSchema, restoreDrillResultSchema,
  saveSetupRequestSchema, saveSetupResultSchema, type RecoveryProvider, type RecoveryReadinessStatus,
  type RecoverySetupSession,
} from '../../shared/contracts/recoveryContract';
import type { BackupDatabaseGate } from '../backup/backupService';
import type { VerifiedBackup } from '../backup/verifiedBackup';
import { OperationalSafetyRepository } from '../domain/operations/operationalSafetyRepository';
import { DomainUnitOfWork } from '../domain/support/domainUnitOfWork';
import type { Clock } from '../domain/support/clock';
import type { IdGenerator } from '../domain/support/idGenerator';
import { createRecoveryKeyMaterial } from '../security/recoveryKey';
import type { WorkspaceKey } from '../security/workspaceKeyTypes';
import { readRecoveryMaterial, writeRecoveryExport } from './recoveryFiles';
import { runRestoreDrill } from './restoreDrill';

/** Main-owned dialogs. Paths never cross the preload boundary. */
export type RecoveryDialogs = {
  saveMaterial(): Promise<string | null>;
  selectBackup(): Promise<string | null>;
  selectMaterial(): Promise<string | null>;
};
export type RecoveryServiceOptions = {
  databaseGate: BackupDatabaseGate;
  backups: { listAvailableBackups(): Promise<VerifiedBackup[]> };
  liveDatabasePath: string;
  loadWorkspaceKey(): Promise<WorkspaceKey>;
  clock: Clock;
  ids: IdGenerator;
  dialogs: RecoveryDialogs;
  temporaryRoot?: string;
};

export class RecoveryService implements RecoveryProvider {
  private session: RecoverySetupSession | undefined;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly stop = new AbortController();
  constructor(private readonly options: RecoveryServiceOptions) {}

  status(...args: []): Promise<RecoveryReadinessStatus> {
    return this.enqueue(async () => {
      if (args.length !== 0) throw new Error(RECOVERY_ERROR);
      return this.readStatus();
    });
  }
  beginSetup(input: z.infer<typeof beginSetupRequestSchema>): Promise<RecoverySetupSession> {
    return this.enqueue(async () => {
      beginSetupRequestSchema.parse(input);
      this.clearSession();
      const key = await this.options.loadWorkspaceKey();
      try {
        this.assertActive();
        const session = recoverySessionSchema.parse({ sessionId: this.options.ids.next(), material: createRecoveryKeyMaterial(key), generatedAt: this.options.clock.now() });
        this.session = session;
        this.expiry = setTimeout(() => this.clearSession(), RECOVERY_SESSION_MS);
        this.expiry.unref();
        return { ...session };
      } finally { key.bytes.fill(0); }
    });
  }
  saveSetupMaterial(input: z.infer<typeof saveSetupRequestSchema>) {
    return this.enqueue(async () => {
      const { sessionId } = saveSetupRequestSchema.parse(input);
      this.requireSession(sessionId);
      const path = await this.dialog(() => this.options.dialogs.saveMaterial());
      const session = this.requireSession(sessionId);
      if (path === null) return saveSetupResultSchema.parse({ kind: 'cancelled' });
      // Validate the public basename before any write.
      const result = saveSetupResultSchema.parse({ kind: 'saved', backupBasename: basename(path) });
      writeRecoveryExport(path, session.material);
      return result;
    });
  }
  completeSetup(input: z.infer<typeof completeSetupRequestSchema>) {
    return this.enqueue(async () => {
      const { sessionId } = completeSetupRequestSchema.parse(input);
      this.requireSession(sessionId);
      await this.options.databaseGate.withDatabase((database) => {
        this.requireSession(sessionId);
        const unitOfWork = new DomainUnitOfWork(database);
        const repository = new OperationalSafetyRepository({ database, unitOfWork });
        unitOfWork.immediate(() => repository.recordRecoverySetupCompleted({ completedAt: this.options.clock.now() }));
      });
      this.clearSession();
      return this.readStatus();
    });
  }
  selectAndRunRestoreDrill(input: z.infer<typeof restoreDrillRequestSchema>) {
    return this.enqueue(async () => {
      let request: z.infer<typeof restoreDrillRequestSchema> | undefined = restoreDrillRequestSchema.parse(input);
      input = undefined;
      let material: string | undefined;
      try {
        const selectedPath = await this.dialog(() => this.options.dialogs.selectBackup());
        if (selectedPath === null) return restoreDrillResultSchema.parse({ kind: 'cancelled' });
        const selected = (await this.options.backups.listAvailableBackups()).find((backup) => backup.path === selectedPath);
        this.assertActive();
        if (selected === undefined) throw new Error(RECOVERY_ERROR);
        if (request.materialSource === 'file') {
          const materialPath = await this.dialog(() => this.options.dialogs.selectMaterial());
          if (materialPath === null) return restoreDrillResultSchema.parse({ kind: 'cancelled' });
          material = readRecoveryMaterial(materialPath);
        } else { material = request.recoveryMaterial; }
        request = undefined;
        this.assertActive();
        const receipt = runRestoreDrill({ backup: selected, liveDatabasePath: this.options.liveDatabasePath, material, clock: this.options.clock, temporaryRoot: this.options.temporaryRoot });
        material = undefined;
        // The drill has closed SQLite, zeroed key buffers and removed its copy.
        await this.options.databaseGate.withDatabase((database) => {
          this.assertActive();
          const unitOfWork = new DomainUnitOfWork(database);
          const repository = new OperationalSafetyRepository({ database, unitOfWork });
          unitOfWork.immediate(() => repository.recordRestoreDrill({ performedAt: receipt.verifiedAt, backupSha256: receipt.backupSha256 }));
        });
        return restoreDrillResultSchema.parse({ kind: 'completed', receipt });
      } finally { material = undefined; request = undefined; }
    });
  }
  shutdown(): Promise<void> {
    this.stop.abort(); this.clearSession();
    return this.tail.then((): void => undefined);
  }
  private async readStatus(): Promise<RecoveryReadinessStatus> {
    const readiness = await this.options.databaseGate.withDatabase((database) => {
      const unitOfWork = new DomainUnitOfWork(database);
      return new OperationalSafetyRepository({ database, unitOfWork }).getRecoveryReadiness();
    });
    let backup: RecoveryReadinessStatus['backup'];
    try {
      const latest = (await this.options.backups.listAvailableBackups()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      backup = latest === undefined ? { status: 'missing', createdAt: null, verifiedAt: null } : { status: 'available', createdAt: latest.createdAt, verifiedAt: latest.verifiedAt };
    } catch { backup = { status: 'unavailable', createdAt: null, verifiedAt: null }; }
    this.assertActive();
    return recoveryStatusSchema.parse({ setupCompletedAt: readiness.recoverySetupCompletedAt, lastRestoreDrillAt: readiness.lastRestoreDrillAt,
      outreachReady: readiness.recoverySetupCompletedAt !== null && readiness.lastRestoreDrillAt !== null, backup });
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => { this.assertActive(); return operation(); }).catch(() => { throw new Error(RECOVERY_ERROR); });
    this.tail = result.catch((): void => undefined);
    return result;
  }
  private assertActive(): void { if (this.stop.signal.aborted) throw new Error(RECOVERY_ERROR); }
  private requireSession(id: string): RecoverySetupSession {
    this.assertActive();
    if (this.session && Date.parse(this.options.clock.now()) >= Date.parse(this.session.generatedAt) + RECOVERY_SESSION_MS) this.clearSession();
    if (this.session?.sessionId !== id) throw new Error(RECOVERY_ERROR);
    return this.session;
  }
  private clearSession(): void {
    if (this.expiry !== undefined) clearTimeout(this.expiry);
    this.expiry = undefined; this.session = undefined;
  }
  private dialog(open: () => Promise<string | null>): Promise<string | null> {
    this.assertActive();
    // Native dialogs cannot be programmatically dismissed by Electron. Detach
    // their pending result on shutdown, and never process a late selection.
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error(RECOVERY_ERROR));
      this.stop.signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => { this.assertActive(); return open(); }).then((value) => {
        this.assertActive(); resolve(value);
      }).catch(reject).finally(() => this.stop.signal.removeEventListener('abort', abort));
    });
  }
}
