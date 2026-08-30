import { join } from 'node:path';

import {
  AppleBridgeSupervisor,
  type AppleBridgeSupervisorApi,
  type AppleBridgeSupervisorOptions,
} from './appleBridge/appleBridgeSupervisor';
import type { AppleBridgeService } from './appleBridge/appleBridgeService';
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
  createAppleBridgeSupervisor(
    options: AppleBridgeSupervisorOptions,
  ): AppleBridgeSupervisorApi;
  registerAppleBridgeIpc?(
    bridge: AppleBridgeService,
    isTrustedRendererUrl?: (url: string) => boolean,
  ): () => void;
};

export type ApplicationStartupOptions = {
  appVersion: string;
  userDataPath: string;
  signal?: AbortSignal;
  isTrustedRendererUrl?: (url: string) => boolean;
  appleBridge?: AppleBridgeSupervisorOptions;
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
  createAppleBridgeSupervisor: (options) => new AppleBridgeSupervisor(options),
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
  let unregisterAppleBridgeIpc: (() => void) | undefined;
  let appleBridgeSupervisor: AppleBridgeSupervisorApi | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      const cleanupErrors: unknown[] = [];

      try {
        unregisterHealthIpc?.();
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        unregisterHealthIpc = undefined;
      }

      try {
        unregisterAppleBridgeIpc?.();
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        unregisterAppleBridgeIpc = undefined;
      }

      try {
        await appleBridgeSupervisor?.stop();
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        appleBridgeSupervisor = undefined;
      }

      try {
        await runtime.shutdown();
      } catch (error) {
        cleanupErrors.push(error);
      }

      if (cleanupErrors.length > 1) {
        throw new AggregateError(
          cleanupErrors,
          'Application shutdown failed while releasing IPC and SQLite.',
        );
      }
      if (cleanupErrors.length === 1) {
        throw cleanupErrors[0];
      }
    })();

    return shutdownPromise;
  };

  try {
    throwIfStartupCancelled(options.signal);
    await runtime.initialize();
    throwIfStartupCancelled(options.signal);
    unregisterHealthIpc = dependencies.registerHealthIpc(
      runtime,
      options.isTrustedRendererUrl,
    );
    throwIfStartupCancelled(options.signal);
    if (options.appleBridge !== undefined) {
      appleBridgeSupervisor = dependencies.createAppleBridgeSupervisor(
        options.appleBridge,
      );
      try {
        const helperStartup = appleBridgeSupervisor.start();
        void helperStartup.catch((): undefined => undefined);
      } catch {
        // Apple integration is optional; supervisor status remains the safe diagnostic.
      }
      unregisterAppleBridgeIpc = dependencies.registerAppleBridgeIpc?.(
        appleBridgeSupervisor,
        options.isTrustedRendererUrl,
      );
      throwIfStartupCancelled(options.signal);
    }
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
