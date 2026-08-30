import type { AppDatabase } from '../db/database';
import type { MigrationResult } from '../db/migrate';
import type { HealthServiceOptions } from '../health/healthService';
import type { HealthProvider } from '../health/registerHealthIpc';
import type { JobRepository } from '../jobs/jobRepository';

type FoundationJobRepository = Pick<
  JobRepository,
  'listActive' | 'recoverInterruptedJobs'
>;

export type FoundationRuntimeDependencies = {
  openDatabase(path: string): AppDatabase;
  migrateToLatest(database: AppDatabase): Promise<MigrationResult>;
  createJobRepository(database: AppDatabase): FoundationJobRepository;
  createHealthService(options: HealthServiceOptions): HealthProvider;
  closeDatabase(database: AppDatabase): void;
};

export type FoundationRuntimeOptions = {
  appVersion: string;
  databasePath: string;
};

type ReadyFoundation = {
  database: AppDatabase;
  health: HealthProvider;
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

    try {
      this.throwIfUnavailable();
      database = this.dependencies.openDatabase(this.options.databasePath);
      this.throwIfUnavailable();
      await this.dependencies.migrateToLatest(database);
      this.throwIfAttemptIsStale(id);

      const jobs = this.dependencies.createJobRepository(database);
      const interruptedJobsRecovered = jobs.recoverInterruptedJobs();
      const health = this.dependencies.createHealthService({
        appVersion: this.options.appVersion,
        databasePath: this.options.databasePath,
        database,
        jobs,
        interruptedJobsRecovered,
      });
      this.throwIfAttemptIsStale(id);

      const ready = { database, health };
      this.ready = ready;
      databaseAdopted = true;
      return ready;
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
