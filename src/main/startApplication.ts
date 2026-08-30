import { join } from 'node:path';

import { closeDatabase, openDatabase } from './db/database';
import { migrateToLatest } from './db/migrate';
import {
  FoundationRuntime,
  type FoundationRuntimeDependencies,
} from './foundation/foundationRuntime';
import { HealthService } from './health/healthService';
import {
  registerHealthIpc,
  type HealthProvider,
} from './health/registerHealthIpc';
import { JobRepository } from './jobs/jobRepository';

export type ApplicationStartupDependencies = FoundationRuntimeDependencies & {
  registerHealthIpc(
    health: HealthProvider,
    isTrustedRendererUrl?: (url: string) => boolean,
  ): () => void;
};

export type ApplicationStartupOptions = {
  appVersion: string;
  userDataPath: string;
  signal?: AbortSignal;
  isTrustedRendererUrl?: (url: string) => boolean;
  createWindow(): void | Promise<void>;
};

export type RunningApplication = {
  databasePath: string;
  shutdown(): Promise<void>;
};

export class ApplicationStartupCancelledError extends Error {
  constructor() {
    super('Application startup was cancelled.');
    this.name = 'ApplicationStartupCancelledError';
  }
}

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
  const runtime = new FoundationRuntime(
    { appVersion: options.appVersion, databasePath },
    dependencies,
  );
  let unregisterHealthIpc: (() => void) | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      let unregisterError: unknown;
      let runtimeError: unknown;

      try {
        unregisterHealthIpc?.();
      } catch (error) {
        unregisterError = error;
      } finally {
        unregisterHealthIpc = undefined;
      }

      try {
        await runtime.shutdown();
      } catch (error) {
        runtimeError = error;
      }

      if (unregisterError !== undefined && runtimeError !== undefined) {
        throw new AggregateError(
          [unregisterError, runtimeError],
          'Application shutdown failed while releasing IPC and SQLite.',
        );
      }
      if (unregisterError !== undefined) {
        throw unregisterError;
      }
      if (runtimeError !== undefined) {
        throw runtimeError;
      }
    })();

    return shutdownPromise;
  };

  try {
    throwIfStartupCancelled(options.signal);
    unregisterHealthIpc = dependencies.registerHealthIpc(
      runtime,
      options.isTrustedRendererUrl,
    );
    throwIfStartupCancelled(options.signal);
    await options.createWindow();
    throwIfStartupCancelled(options.signal);

    return { databasePath, shutdown };
  } catch (startupError) {
    try {
      await shutdown();
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        'Application startup and cleanup both failed.',
      );
    }

    throw startupError;
  }
}

function throwIfStartupCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ApplicationStartupCancelledError();
  }
}
