import { join } from 'node:path';

import {
  closeDatabase,
  openDatabase,
  type AppDatabase,
} from './db/database';
import { migrateToLatest, type MigrationResult } from './db/migrate';
import {
  HealthService,
  type HealthServiceOptions,
} from './health/healthService';
import {
  registerHealthIpc,
  type HealthProvider,
} from './health/registerHealthIpc';
import { JobRepository } from './jobs/jobRepository';

type StartupJobRepository = Pick<
  JobRepository,
  'listActive' | 'recoverInterruptedJobs'
>;

export type ApplicationStartupDependencies = {
  openDatabase(path: string): AppDatabase;
  migrateToLatest(database: AppDatabase): Promise<MigrationResult>;
  createJobRepository(database: AppDatabase): StartupJobRepository;
  createHealthService(options: HealthServiceOptions): HealthProvider;
  registerHealthIpc(health: HealthProvider): () => void;
  closeDatabase(database: AppDatabase): void;
};

export type ApplicationStartupOptions = {
  appVersion: string;
  userDataPath: string;
  createWindow(): void;
};

export type RunningApplication = {
  databasePath: string;
  interruptedJobsRecovered: number;
  shutdown(): void;
};

const defaultDependencies: ApplicationStartupDependencies = {
  openDatabase,
  migrateToLatest,
  createJobRepository: (database) => new JobRepository(database),
  createHealthService: (options) => new HealthService(options),
  registerHealthIpc,
  closeDatabase,
};

export async function startApplication(
  options: ApplicationStartupOptions,
  dependencies: ApplicationStartupDependencies = defaultDependencies,
): Promise<RunningApplication> {
  const databasePath = join(options.userDataPath, 'callie.sqlite3');
  let database: AppDatabase | undefined;
  let unregisterHealthIpc: (() => void) | undefined;
  let shutdownComplete = false;

  const shutdown = (): void => {
    if (shutdownComplete) {
      return;
    }

    shutdownComplete = true;

    try {
      unregisterHealthIpc?.();
    } finally {
      if (database !== undefined) {
        dependencies.closeDatabase(database);
      }
    }
  };

  try {
    database = dependencies.openDatabase(databasePath);
    await dependencies.migrateToLatest(database);

    const jobs = dependencies.createJobRepository(database);
    const interruptedJobsRecovered = jobs.recoverInterruptedJobs();
    const health = dependencies.createHealthService({
      appVersion: options.appVersion,
      databasePath,
      database,
      jobs,
      interruptedJobsRecovered,
    });

    unregisterHealthIpc = dependencies.registerHealthIpc(health);
    options.createWindow();

    return {
      databasePath,
      interruptedJobsRecovered,
      shutdown,
    };
  } catch (initializationError) {
    try {
      shutdown();
    } catch (cleanupError) {
      throw new AggregateError(
        [initializationError, cleanupError],
        'Application initialization and cleanup both failed.',
      );
    }

    throw initializationError;
  }
}
