import { join } from 'node:path';
import { homedir } from 'node:os';

import {
  AppleBridgeSupervisor,
  type AppleBridgeSupervisorApi,
  type AppleBridgeSupervisorOptions,
} from './appleBridge/appleBridgeSupervisor';
import {
  AppleSpikeService,
  type AppleSpikeServiceApi,
} from './appleBridge/appleSpikeService';
import { registerAppleSpikeIpc } from './appleBridge/registerAppleSpikeIpc';
import { closeDatabase, openDatabase } from './db/database';
import { migrateToLatest } from './db/migrate';
import { DomainRuntime } from './domain/domainRuntime';
import { SystemClock } from './domain/support/clock';
import { UuidGenerator } from './domain/support/idGenerator';
import {
  encryptedWorkspaceExists,
  prepareEncryptedDatabase,
} from './db/plaintextDatabaseUpgrade';
import {
  FoundationRuntime,
  type FoundationRuntimeDependencies,
} from './foundation/foundationRuntime';
import { HealthService } from './health/healthService';
import { registerApplicationIpc } from './ipc/registerApplicationIpc';
import type { SourcingProvider } from './sourcing/registerSourcingIpc';
import {
  createS3InboxObjectStore,
  InboxClient,
} from './sourcing/inboxClient';
import { SourcingCredentialStore } from './sourcing/sourcingCredentialStore';
import { SourcingPoller, type PollTimer } from './sourcing/sourcingPoller';
import { safeStorage } from 'electron';
import { SafeStorageKeyProtector } from './security/safeStorageKeyProtector';
import { WorkspaceKeyStore } from './security/workspaceKeyStore';

export type ApplicationStartupDependencies = FoundationRuntimeDependencies & {
  registerApplicationIpc(
    runtime: FoundationRuntime,
    isTrustedRendererUrl?: (url: string) => boolean,
    registrars?: undefined,
    sourcingProvider?: SourcingProvider,
  ): () => void;
  createSourcingPoller?(runtime: FoundationRuntime, userDataPath: string): SourcingPoller;
  createAppleBridgeSupervisor(
    options: AppleBridgeSupervisorOptions,
  ): AppleBridgeSupervisorApi;
  registerAppleSpikeIpc?(
    service: AppleSpikeServiceApi,
    isTrustedRendererUrl?: (url: string) => boolean,
  ): () => void;
};

export type ApplicationStartupOptions = {
  appVersion: string;
  userDataPath: string;
  signal?: AbortSignal;
  isTrustedRendererUrl?: (url: string) => boolean;
  appleBridge?: AppleBridgeSupervisorOptions;
  appleSpikeEnabled?: boolean;
  /**
   * Auto-polls the sourcing inbox on startup plus every 15 minutes. Off by
   * default so tests and packaged E2E runs never touch the network; main.ts
   * enables it for real launches.
   */
  sourcingPollingEnabled?: boolean;
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

const workspaceKeyStore = new WorkspaceKeyStore({
  keyProtector: new SafeStorageKeyProtector(safeStorage),
});

// Exactly one Clock and one ID generator for the application; the production
// factory closes over these same objects.
const domainClock = new SystemClock();
const domainIds = new UuidGenerator();

const SOURCING_POLL_INTERVAL_MS = 15 * 60 * 1000;

function createProductionSourcingPoller(
  runtime: FoundationRuntime,
  userDataPath: string,
): SourcingPoller {
  const credentialStore = new SourcingCredentialStore({
    safeStorage,
    envelopePath: join(userDataPath, 'callie.sourcing-inbox-credentials.json'),
    fallbackKeyFilePath: join(homedir(), '.callie-sourcing-app-inbox-key.json'),
    clock: domainClock,
    log: (message) => console.info(`[sourcing] ${message}`),
  });
  return new SourcingPoller({
    domainGate: runtime,
    loadCredentials: () => credentialStore.load(),
    createInboxClient: async (loaded) => {
      const store = await createS3InboxObjectStore({
        credentialProvider: async () => loaded.credentials,
      });
      return new InboxClient({ store, clock: domainClock });
    },
    clock: domainClock,
    log: (message) => console.info(`[sourcing] ${message}`),
  });
}

const defaultDependencies: ApplicationStartupDependencies = {
  loadWorkspaceKey: (input) => workspaceKeyStore.loadOrCreate(input),
  prepareEncryptedDatabase,
  openDatabase,
  migrateToLatest,
  createDomainRuntime: (database) => new DomainRuntime({
    database,
    clock: domainClock,
    ids: domainIds,
  }),
  createHealthService: (options) => new HealthService(options),
  registerApplicationIpc,
  createSourcingPoller: createProductionSourcingPoller,
  createAppleBridgeSupervisor: (options) => new AppleBridgeSupervisor(options),
  registerAppleSpikeIpc,
  closeDatabase,
};

export async function startApplication(
  options: ApplicationStartupOptions,
  dependencies: ApplicationStartupDependencies = defaultDependencies,
): Promise<RunningApplication> {
  const databasePath = join(options.userDataPath, 'callie.sqlite3');
  const keyEnvelopePath = join(options.userDataPath, 'callie.key-envelope.json');
  const runtime = new FoundationRuntime(
    {
      appVersion: options.appVersion,
      backupDirectory: join(options.userDataPath, 'backups'),
      databasePath,
      databaseExists: encryptedWorkspaceExists(databasePath),
      keyEnvelopePath,
    },
    dependencies,
  );
  let unregisterApplicationIpc: (() => void) | undefined;
  let unregisterAppleSpikeIpc: (() => void) | undefined;
  let appleBridgeSupervisor: AppleBridgeSupervisorApi | undefined;
  let sourcingPoller: SourcingPoller | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      const cleanupErrors: unknown[] = [];

      try {
        sourcingPoller?.stop();
        await sourcingPoller?.idle();
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        sourcingPoller = undefined;
      }

      try {
        unregisterApplicationIpc?.();
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        unregisterApplicationIpc = undefined;
      }

      try {
        unregisterAppleSpikeIpc?.();
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        unregisterAppleSpikeIpc = undefined;
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
    sourcingPoller = dependencies.createSourcingPoller?.(
      runtime,
      options.userDataPath,
    );
    const startedPoller = sourcingPoller;
    unregisterApplicationIpc = dependencies.registerApplicationIpc(
      runtime,
      options.isTrustedRendererUrl,
      undefined,
      startedPoller === undefined ? undefined : {
        pollNow: async () => {
          await startedPoller.pollNow();
          return startedPoller.getStatus();
        },
        status: () => startedPoller.getStatus(),
      },
    );
    throwIfStartupCancelled(options.signal);
    if (options.sourcingPollingEnabled === true && sourcingPoller !== undefined) {
      const timer: PollTimer = {
        schedule: (callback) => {
          const interval = setInterval(callback, SOURCING_POLL_INTERVAL_MS);
          interval.unref();
          return () => clearInterval(interval);
        },
      };
      // Startup never blocks on the network: the initial poll runs detached.
      void sourcingPoller.start(timer);
    }
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
      unregisterAppleSpikeIpc = dependencies.registerAppleSpikeIpc?.(
        new AppleSpikeService({
          enabled: options.appleSpikeEnabled === true,
          bridge: appleBridgeSupervisor,
        }),
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
