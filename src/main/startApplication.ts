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
import { BackupService, type BackupServiceOptions } from './backup/backupService';
import type { VerifiedBackup } from './backup/verifiedBackup';
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
import { EnrichmentRequestWriter } from './sourcing/enrichmentRequestWriter';
import type { EnrichmentRequester } from './leads/leadDetailService';
import {
  createFileSystemInboxObjectStore,
  createS3InboxObjectStore,
  InboxClient,
} from './sourcing/inboxClient';
import { SourcingCredentialStore } from './sourcing/sourcingCredentialStore';
import { SourcingHmacSaltStore } from './sourcing/sourcingHmacSaltStore';
import { SourcingPoller, type PollTimer } from './sourcing/sourcingPoller';
import {
  createS3UpstreamObjectStore,
  UpstreamSync,
  type UpstreamObjectStore,
} from './sourcing/upstreamSync';
import { safeStorage } from 'electron';
import { SafeStorageKeyProtector } from './security/safeStorageKeyProtector';
import { WorkspaceKeyStore } from './security/workspaceKeyStore';
import type { SafeLogger } from './logging/safeLogger';

export type ApplicationStartupDependencies = FoundationRuntimeDependencies & {
  createBackupService?(options: BackupServiceOptions): Pick<BackupService, 'start' | 'shutdown' | 'createBackup'>;
  registerApplicationIpc(
    runtime: FoundationRuntime,
    isTrustedRendererUrl: ((url: string) => boolean) | undefined,
    registrars: undefined,
    sourcingProvider: SourcingProvider,
    shellProvider?: undefined,
    enrichmentRequester?: EnrichmentRequester,
    logDirectoryPath?: string,
  ): () => void;
  createEnrichmentRequester?(
    runtime: FoundationRuntime,
    userDataPath: string,
    logger?: SafeLogger,
  ): EnrichmentRequester;
  createSourcingPoller(
    runtime: FoundationRuntime,
    userDataPath: string,
    logger?: SafeLogger,
  ): SourcingPoller;
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
  logger?: SafeLogger;
  logDirectoryPath?: string;
  createWindow(): void | Promise<void>;
};

export type RunningApplication = {
  databasePath: string;
  createPreReleaseBackup(): Promise<VerifiedBackup>;
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

/**
 * Production enrichment requester over the same scoped key as the poller:
 * the founder's "Find contact info" click writes exactly one request line
 * to upstream/enrichment-requests/. Missing credentials surface as a
 * validated 'credentials_unavailable' refusal, never a throw.
 */
function createProductionEnrichmentRequester(
  runtime: FoundationRuntime,
  userDataPath: string,
  logger?: SafeLogger,
): EnrichmentRequester {
  const credentialStore = new SourcingCredentialStore({
    safeStorage,
    envelopePath: join(userDataPath, 'callie.sourcing-inbox-credentials.json'),
    fallbackKeyFilePath: join(homedir(), '.callie-sourcing-app-inbox-key.json'),
    clock: domainClock,
    logger,
  });
  const writer = new EnrichmentRequestWriter({
    domainGate: runtime,
    createStore: () => createS3UpstreamObjectStore({
      credentialProvider: async () => (await credentialStore.load())?.credentials ?? null,
    }),
    clock: domainClock,
  });
  return { request: (input) => writer.request(input) };
}

function createProductionSourcingPoller(
  runtime: FoundationRuntime,
  userDataPath: string,
  logger?: SafeLogger,
): SourcingPoller {
  const credentialStore = new SourcingCredentialStore({
    safeStorage,
    envelopePath: join(userDataPath, 'callie.sourcing-inbox-credentials.json'),
    fallbackKeyFilePath: join(homedir(), '.callie-sourcing-app-inbox-key.json'),
    clock: domainClock,
    logger,
  });
  const hmacSaltStore = new SourcingHmacSaltStore({
    safeStorage,
    envelopePath: join(userDataPath, 'callie.sourcing-hmac-salt.json'),
    clock: domainClock,
  });
  const upstreamSync = new UpstreamSync({
    domainGate: runtime,
    loadHmacSalt: () => hmacSaltStore.load(),
    clock: domainClock,
    batchIds: domainIds,
  });
  // TEST-ONLY escape hatch for the packaged E2E: when
  // CALLIE_SOURCING_FIXTURE_DIR points at a local directory, the poller
  // reads `events/**.ndjson` fixture files from that directory instead of
  // S3 and discards upstream uploads. Real launches never set this variable;
  // it exists so the fixture-driven spec can exercise the full poll ->
  // intake -> score pipeline without credentials or network.
  const fixtureDirectory = process.env.CALLIE_SOURCING_FIXTURE_DIR ?? null;
  const fixtureEvidence = fixtureDirectory !== null
    && process.env.CALLIE_SOURCING_FIXTURE_HANG_ONCE === '1'
    ? {
      cleanupStarted: false,
      cleanupCompleted: false,
      replacementStartedAfterCleanup: false,
      maxConcurrentExecutions: 0,
    }
    : undefined;
  let fixtureHangOnce = fixtureEvidence !== undefined;
  let fixtureActiveExecutions = 0;
  let fixtureClockAdvanced = false;
  const pollClock = fixtureEvidence === undefined ? domainClock : {
    now: () => new Date(
      Date.now() + (fixtureClockAdvanced ? 15 * 60_000 : 0),
    ).toISOString(),
  };
  return new SourcingPoller({
    domainGate: runtime,
    loadCredentials: fixtureDirectory === null
      ? () => credentialStore.load()
      : async () => ({
        credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
        source: 'file',
      }),
    createInboxClient: async (loaded) => {
      const store = fixtureDirectory !== null
        ? createFileSystemInboxObjectStore(fixtureDirectory)
        : await createS3InboxObjectStore({
          credentialProvider: async () => loaded.credentials,
        });
      const client = new InboxClient({ store, clock: domainClock });
      if (fixtureEvidence === undefined) return client;
      return {
        listNewObjects: async (sinceKey, signal) => {
          fixtureActiveExecutions += 1;
          fixtureEvidence.maxConcurrentExecutions = Math.max(
            fixtureEvidence.maxConcurrentExecutions,
            fixtureActiveExecutions,
          );
          if (fixtureHangOnce) {
            fixtureHangOnce = false;
            fixtureClockAdvanced = true;
            return new Promise<string[]>((_resolve, reject) => {
              signal.addEventListener('abort', () => {
                fixtureEvidence.cleanupStarted = true;
                setTimeout(() => {
                  fixtureActiveExecutions -= 1;
                  fixtureEvidence.cleanupCompleted = true;
                  reject(signal.reason);
                }, 100);
              }, { once: true });
            });
          }
          fixtureEvidence.replacementStartedAfterCleanup = fixtureEvidence.cleanupCompleted;
          try {
            return await client.listNewObjects(sinceKey, signal);
          } finally {
            fixtureActiveExecutions -= 1;
          }
        },
        fetchNdjson: (key, signal) => client.fetchNdjson(key, signal),
      };
    },
    upstream: {
      sync: upstreamSync,
      createStore: async (loaded): Promise<UpstreamObjectStore> => (
        fixtureDirectory !== null
          ? { putObjectText: async () => undefined }
          : createS3UpstreamObjectStore({
            credentialProvider: async () => loaded.credentials,
          })
      ),
      saltState: () => hmacSaltStore.state(),
      setSalt: (salt) => hmacSaltStore.set(salt),
    },
    clock: pollClock,
    fixtureExecutionEvidence: fixtureEvidence === undefined
      ? undefined
      : () => ({ ...fixtureEvidence }),
    logger,
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
  createEnrichmentRequester: createProductionEnrichmentRequester,
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
  let backupService: Pick<BackupService, 'start' | 'shutdown' | 'createBackup'> | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      const cleanupErrors: unknown[] = [];
      // Stop both periodic owners before awaiting either one's asynchronous work.
      let backupCleanup: Promise<void> | undefined;
      try {
        backupCleanup = backupService?.shutdown();
        void backupCleanup?.catch((): undefined => undefined);
      } catch (error) {
        cleanupErrors.push(error);
      }

      try {
        sourcingPoller?.stop();
        await sourcingPoller?.idle();
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        sourcingPoller = undefined;
      }

      try {
        await backupCleanup;
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        backupService = undefined;
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
    if (typeof dependencies.createSourcingPoller !== 'function') {
      throw new Error('Sourcing poller dependency is required.');
    }
    sourcingPoller = dependencies.createSourcingPoller(
      runtime,
      options.userDataPath,
      options.logger,
    );
    if (sourcingPoller === undefined) {
      throw new Error('Sourcing poller dependency is required.');
    }
    const startedPoller = sourcingPoller;
    runtime.setSourcingHealthProvider(() => startedPoller.getHealth());
    unregisterApplicationIpc = dependencies.registerApplicationIpc(
      runtime,
      options.isTrustedRendererUrl,
      undefined,
      {
        pollNow: async () => {
          await startedPoller.pollNow();
          return startedPoller.getStatus();
        },
        status: () => startedPoller.getStatus(),
        retry: async () => {
          await startedPoller.retry();
          return startedPoller.getStatus();
        },
        setHmacSalt: async ({ salt }) => {
          await startedPoller.setHmacSalt(salt);
          return startedPoller.getStatus();
        },
      },
      undefined,
      dependencies.createEnrichmentRequester?.(
        runtime,
        options.userDataPath,
        options.logger,
      ),
      options.logDirectoryPath,
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
    const backupOptions: BackupServiceOptions = {
      databaseGate: runtime,
      backupDirectory: join(options.userDataPath, 'backups'),
      // Initialization has created/migrated the database. A missing envelope
      // must never generate a replacement key for an existing workspace.
      loadWorkspaceKey: () => dependencies.loadWorkspaceKey({ envelopePath: keyEnvelopePath, databaseExists: true }),
      clock: domainClock,
      ids: domainIds,
    };
    backupService = dependencies.createBackupService?.(backupOptions) ?? new BackupService(backupOptions);
    // Key loading must not hold window startup. The service retains a safe
    // failure code and retries at the next hourly due check.
    void backupService.start().catch((): undefined => undefined);
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

    return {
      databasePath,
      createPreReleaseBackup: async () => {
        if (shutdownPromise !== undefined || backupService === undefined) {
          throw new Error('Application backups are unavailable.');
        }
        return backupService.createBackup('pre_release');
      },
      shutdown,
    };
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
