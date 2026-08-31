import type {
  AppDatabase,
  DatabaseOpenOptions,
} from '../db/database';
import type { MigrationOptions, MigrationResult } from '../db/migrate';
import type { DomainRuntime } from '../domain/domainRuntime';
import {
  createFounderSalesDomain,
  type FounderSalesDomain,
} from '../domain/founderSalesDomain';
import { SystemClock } from '../domain/support/clock';
import { UuidGenerator } from '../domain/support/idGenerator';
import type { HealthServiceOptions } from '../health/healthService';
import type { HealthProvider } from '../health/registerHealthIpc';
import type {
  WorkspaceKey,
  WorkspaceKeyStoreInput,
} from '../security/workspaceKeyTypes';

export type { FounderSalesDomain } from '../domain/founderSalesDomain';

type FoundationDomainRuntime = Pick<
  DomainRuntime,
  'initialize' | 'getDiagnostics' | 'getServices' | 'shutdown'
>;

export type FoundationRuntimeDependencies = {
  loadWorkspaceKey(input: WorkspaceKeyStoreInput): Promise<WorkspaceKey>;
  prepareEncryptedDatabase(path: string, key: WorkspaceKey): Promise<void>;
  openDatabase(options: DatabaseOpenOptions): AppDatabase;
  migrateToLatest(
    database: AppDatabase,
    options: MigrationOptions,
  ): Promise<MigrationResult>;
  createDomainRuntime(database: AppDatabase): FoundationDomainRuntime;
  createHealthService(options: HealthServiceOptions): HealthProvider;
  closeDatabase(database: AppDatabase): void;
};

export type FoundationRuntimeOptions = {
  appVersion: string;
  backupDirectory: string;
  databasePath: string;
  databaseExists: boolean;
  keyEnvelopePath: string;
};

type ReadyFoundation = {
  database: AppDatabase;
  domainRuntime: FoundationDomainRuntime;
  health: HealthProvider;
  founderDomain: FounderSalesDomain | undefined;
};

type InitializationAttempt = {
  id: number;
  promise: Promise<ReadyFoundation>;
};

type RuntimeState = 'active' | 'stopping' | 'stopped';

export class FoundationInitializationCancelledError extends Error {
  constructor() {
    super('Foundation initialization was cancelled.');
    this.name = 'FoundationInitializationCancelledError';
  }
}

export class FoundationRuntime {
  private state: RuntimeState = 'active';
  private ready: ReadyFoundation | undefined;
  private initialization: InitializationAttempt | undefined;
  private nextAttemptId = 0;
  private shutdownPromise: Promise<void> | undefined;

  constructor(
    private readonly options: FoundationRuntimeOptions,
    private readonly dependencies: FoundationRuntimeDependencies,
  ) {}

  async initialize(): Promise<void> {
    this.throwIfUnavailable();
    await this.ensureInitialized();
    this.throwIfUnavailable();
  }

  async getHealth(): Promise<unknown> {
    await this.initialize();
    const foundation = this.ready;
    if (foundation === undefined) {
      throw new Error('Foundation runtime did not retain initialized state.');
    }
    return foundation.health.getHealth();
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise !== undefined) {
      return this.shutdownPromise;
    }

    this.state = 'stopping';
    this.shutdownPromise = this.finishShutdown();
    return this.shutdownPromise;
  }

  /**
   * The UI execution gate: awaits initialization, requires a ready domain,
   * lazily constructs and memoizes one FounderSalesDomain over the operational
   * service graph, and runs the operation against it.
   */
  async withDomain<TResult>(
    operation: (domain: FounderSalesDomain) => TResult | Promise<TResult>,
  ): Promise<TResult> {
    this.throwIfUnavailable();
    const foundation = await this.ensureInitialized();
    this.throwIfUnavailable();
    if (foundation.founderDomain === undefined) {
      const services = foundation.domainRuntime.getServices();
      foundation.founderDomain = createFounderSalesDomain({
        services,
        database: foundation.database,
        clock: new SystemClock(),
        ids: new UuidGenerator(),
      });
    }
    return operation(foundation.founderDomain);
  }

  private ensureInitialized(): Promise<ReadyFoundation> {
    if (this.ready !== undefined) {
      return Promise.resolve(this.ready);
    }

    if (this.initialization !== undefined) {
      return this.initialization.promise;
    }

    const id = ++this.nextAttemptId;
    const promise = this.initializeAttempt(id).finally(() => {
      if (this.initialization?.id === id) {
        this.initialization = undefined;
      }
    });
    this.initialization = { id, promise };
    return promise;
  }

  private async initializeAttempt(id: number): Promise<ReadyFoundation> {
    let database: AppDatabase | undefined;
    let databaseAdopted = false;
    let workspaceKey: WorkspaceKey | undefined;

    try {
      try {
        this.throwIfUnavailable();
        workspaceKey = await this.dependencies.loadWorkspaceKey({
          envelopePath: this.options.keyEnvelopePath,
          databaseExists: this.options.databaseExists,
        });
        this.throwIfAttemptIsStale(id);
        await this.dependencies.prepareEncryptedDatabase(
          this.options.databasePath,
          workspaceKey,
        );
        this.throwIfAttemptIsStale(id);
        database = this.dependencies.openDatabase({
          path: this.options.databasePath,
          key: workspaceKey,
        });
        this.throwIfAttemptIsStale(id);
        await this.dependencies.migrateToLatest(database, {
          backupDirectory: this.options.backupDirectory,
          workspaceKey,
        });
      } finally {
        workspaceKey?.bytes.fill(0);
      }
      this.throwIfAttemptIsStale(id);

      let domainRuntime: FoundationDomainRuntime | undefined;
      try {
        domainRuntime = this.dependencies.createDomainRuntime(database);
        const report = domainRuntime.initialize();
        const services = report.status === 'ready' ? domainRuntime.getServices() : undefined;
        const health = this.dependencies.createHealthService({
          appVersion: this.options.appVersion,
          databasePath: this.options.databasePath,
          database,
          jobs: services?.jobs ?? { listActive: () => [] },
          domainStartupReport: report,
        });
        this.throwIfAttemptIsStale(id);

        const ready = { database, domainRuntime, health, founderDomain: undefined as FounderSalesDomain | undefined };
        this.ready = ready;
        databaseAdopted = true;
        return ready;
      } catch (domainError) {
        domainRuntime?.shutdown();
        throw domainError;
      }
    } catch (initializationError) {
      if (database !== undefined && !databaseAdopted) {
        try {
          this.dependencies.closeDatabase(database);
        } catch (cleanupError) {
          throw new AggregateError(
            [initializationError, cleanupError],
            'Foundation initialization and cleanup both failed.',
          );
        }
      }

      throw initializationError;
    }
  }

  private async finishShutdown(): Promise<void> {
    try {
      await this.initialization?.promise.catch((): undefined => undefined);
      const ready = this.ready;
      this.ready = undefined;
      if (ready !== undefined) {
        ready.domainRuntime.shutdown();
        this.dependencies.closeDatabase(ready.database);
      }
    } finally {
      this.state = 'stopped';
    }
  }

  private throwIfAttemptIsStale(id: number): void {
    this.throwIfUnavailable();
    if (this.initialization?.id !== id) {
      throw new FoundationInitializationCancelledError();
    }
  }

  private throwIfUnavailable(): void {
    if (this.state === 'active') {
      return;
    }

    if (this.state === 'stopping') {
      throw new FoundationInitializationCancelledError();
    }

    throw new Error('Foundation runtime has shut down.');
  }
}
