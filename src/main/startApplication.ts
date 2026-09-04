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
import { RemoteOperationTimeoutError } from './runtime/abortDeadline';

export type ApplicationStartupDependencies = FoundationRuntimeDependencies & {
  registerApplicationIpc(
    runtime: FoundationRuntime,
    isTrustedRendererUrl?: (url: string) => boolean,
    registrars?: undefined,
    sourcingProvider?: SourcingProvider,
    shellProvider?: undefined,
    enrichmentRequester?: EnrichmentRequester,
  ): () => void;
  createEnrichmentRequester?(
    runtime: FoundationRuntime,
    userDataPath: string,
  ): EnrichmentRequester;
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

/**
 * Production enrichment requester over the same scoped key as the poller:
 * the founder's "Find contact info" click writes exactly one request line
 * to upstream/enrichment-requests/. Missing credentials surface as a
 * validated 'credentials_unavailable' refusal, never a throw.
 */
function createProductionEnrichmentRequester(
  runtime: FoundationRuntime,
  userDataPath: string,
): EnrichmentRequester {
  const credentialStore = new SourcingCredentialStore({
    safeStorage,
    envelopePath: join(userDataPath, 'callie.sourcing-inbox-credentials.json'),
    fallbackKeyFilePath: join(homedir(), '.callie-sourcing-app-inbox-key.json'),
    clock: domainClock,
    log: (message) => console.info(`[sourcing] ${message}`),
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
): SourcingPoller {
  const credentialStore = new SourcingCredentialStore({
    safeStorage,
    envelopePath: join(userDataPath, 'callie.sourcing-inbox-credentials.json'),
    fallbackKeyFilePath: join(homedir(), '.callie-sourcing-app-inbox-key.json'),
    clock: domainClock,
    log: (message) => console.info(`[sourcing] ${message}`),
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
  let fixtureHangOnce = fixtureDirectory !== null
    && process.env.CALLIE_SOURCING_FIXTURE_HANG_ONCE === '1';
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
      if (!fixtureHangOnce) return client;
      return {
        listNewObjects: async () => {
          fixtureHangOnce = false;
          await new Promise((resolve) => setTimeout(resolve, 100));
          throw new RemoteOperationTimeoutError('POLL_TOTAL_TIMEOUT', 14 * 60_000);
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
      dependencies.createEnrichmentRequester?.(runtime, options.userDataPath),
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
