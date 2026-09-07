import { createDiscoveryWorker, type DiscoveryWorker } from './discovery/discoveryWorker';
import { unavailableDiscoveryResearch } from './discovery/discoveryResearchPort';
import { resolveApplicationPaths } from './applicationPaths';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { RecoveryService, type RecoveryServiceOptions, type RecoveryDialogs } from './recovery/recoveryService';
import type { RecoveryProvider } from '../shared/contracts/recoveryContract';

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
import { safeStorage, dialog } from 'electron';
import { SafeStorageKeyProtector } from './security/safeStorageKeyProtector';
import { WorkspaceKeyStore } from './security/workspaceKeyStore';
import type { SafeLogger } from './logging/safeLogger';
import { createOutboundCommandService } from './communications/outboundCommandService';
import { unavailablePhoneHandoff, unavailableOutboundReadiness } from './communications/phoneHandoffLauncher';
import type { OutboundCommandServiceApi, OutboundDomainGate } from './communications/outboundPorts';

export type ApplicationStartupDependencies = FoundationRuntimeDependencies & {
  createDiscoveryWorker?: typeof createDiscoveryWorker;
  createOutboundCommandService?: typeof createOutboundCommandService;
  createBackupService?(options: BackupServiceOptions): Pick<BackupService, 'start' | 'shutdown' | 'createBackup' | 'listAvailableBackups'>;
  createRecoveryService?(options: RecoveryServiceOptions): RecoveryProvider & { shutdown(): Promise<void> };
  registerApplicationIpc(
    runtime: FoundationRuntime,
    isTrustedRendererUrl: ((url: string) => boolean) | undefined,
    registrars: undefined,
    sourcingProvider: SourcingProvider,
    recoveryProvider: RecoveryProvider,
    shellProvider?: undefined,
    enrichmentRequester?: EnrichmentRequester,
    logDirectoryPath?: string,
    outbound?: OutboundCommandServiceApi,
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
  registerOutboundLifecycle?(callbacks: {
    onWake(): void;
    onLock(): void;
    onUnlock(): void;
  }): () => void;
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
  const { databasePath, keyEnvelopePath, backupDirectory } = resolveApplicationPaths(options.userDataPath);
  const runtime = new FoundationRuntime(
    {
      appVersion: options.appVersion,
      backupDirectory,
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
  let backupService: Pick<BackupService, 'start' | 'shutdown' | 'createBackup' | 'listAvailableBackups'> | undefined;
  let recoveryService: (RecoveryProvider & { shutdown(): Promise<void> }) | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let outbound: OutboundCommandServiceApi | undefined;
  let unregisterOutboundLifecycle: (() => void) | undefined;
  let removeStartupAbort: (() => void) | undefined;
  let discoveryWorker: DiscoveryWorker | undefined;
  let discoveryClosed = false;
  let outboundClosed = false;
  const cleanupErrors: unknown[] = [];

  const closeDiscovery = (): void => {
    if (discoveryClosed) return;
    discoveryClosed = true;
    try { discoveryWorker?.stop(); } catch (error) { cleanupErrors.push(error); }
  };
  const abortStartup = (): void => { closeDiscovery(); closeOutbound(); };
  const detachOutboundLifecycle = (): void => {
    const unregister = unregisterOutboundLifecycle;
    unregisterOutboundLifecycle = undefined;
    try { unregister?.(); } catch (error) { cleanupErrors.push(error); }
  };
  const detachStartupAbort = (): void => {
    const remove = removeStartupAbort;
    removeStartupAbort = undefined;
    remove?.();
  };
  const closeOutbound = (): void => {
    if (outboundClosed) return;
    // Reserve permanent owner closure before any injected callback can reenter.
    outboundClosed = true;
    try { outbound?.dispose(); } catch (error) { cleanupErrors.push(error); }
    detachOutboundLifecycle();
    try { detachStartupAbort(); } catch (error) { cleanupErrors.push(error); }
  };

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) {
      return shutdownPromise;
    }

    // Memoize before disposal/listener callbacks, without deferring admission
    // closure to a microtask. Reentrant callers share this exact completion.
    let resolveShutdown!: () => void;
    let rejectShutdown!: (error: unknown) => void;
    shutdownPromise = new Promise<void>((resolve, reject) => {
      resolveShutdown = resolve; rejectShutdown = reject;
    });
    closeDiscovery();
    closeOutbound();
    void (async () => {
      // Preserve recovery, backup, sourcing, IPC, helper and Foundation ownership.
      let recoveryCleanup: Promise<void> | undefined;
      try {
        recoveryCleanup = recoveryService?.shutdown();
        void recoveryCleanup?.catch((): undefined => undefined);
      } catch (error) { cleanupErrors.push(error); }
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

      try { await discoveryWorker?.idle(); } catch (error) { cleanupErrors.push(error); }
      finally { discoveryWorker = undefined; }

      try {
        await backupCleanup;
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        backupService = undefined;
      }

      try { await recoveryCleanup; } catch (error) { cleanupErrors.push(error); }
      finally { recoveryService = undefined; }

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
    })().then(resolveShutdown, rejectShutdown);

    return shutdownPromise;
  };

  try {
    throwIfStartupCancelled(options.signal);
    await runtime.initialize();
    throwIfStartupCancelled(options.signal);
    const domain: OutboundDomainGate = {
      withDomain: (operation) => runtime.withDomain((current) => operation({
        inspectOutboundCommand: (request) => current.inspectOutboundCommand(request),
        prepareOutboundDispatch: (request) => current.prepareOutboundDispatch(request),
        recordOutboundResult: (request, result) => current.recordOutboundResult(request, result),
        recordOutboundRefusal: (request, reason) => current.recordOutboundRefusal(request, reason),
      })),
    };
    outbound = (dependencies.createOutboundCommandService ?? createOutboundCommandService)({
      domain, phone: unavailablePhoneHandoff(), readiness: unavailableOutboundReadiness(),
    });
    if (options.signal !== undefined) {
      const signal = options.signal;
      removeStartupAbort = () => signal.removeEventListener('abort', abortStartup);
      signal.addEventListener('abort', abortStartup, { once: true });
      if (signal.aborted) abortStartup();
      throwIfStartupCancelled(signal);
    }
    unregisterOutboundLifecycle = options.registerOutboundLifecycle?.({
      onWake: () => { if (!outboundClosed) outbound.invalidate('wake'); },
      onLock: () => { if (!outboundClosed) outbound.invalidate('lock'); },
      onUnlock: () => {
        if (outboundClosed) return;
        outbound.invalidate('wake');
        if (!outboundClosed) outbound.resumeAfterUnlock();
      },
    });
    // A registrar can synchronously abort before returning its owned disposer.
    if (outboundClosed) detachOutboundLifecycle();
    throwIfStartupCancelled(options.signal);
    discoveryWorker = (dependencies.createDiscoveryWorker ?? createDiscoveryWorker)({
      domainGate: runtime, clock: domainClock, research: unavailableDiscoveryResearch,
      schedule: (run, delay) => { const timer = setTimeout(run, delay); timer.unref(); return () => clearTimeout(timer); },
    });
    // An injected factory can synchronously abort before handing back ownership.
    if (discoveryClosed) discoveryWorker.stop();
    throwIfStartupCancelled(options.signal);
    discoveryWorker.start();
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
    const recoveryOptions: RecoveryServiceOptions = {
      databaseGate: runtime, backups: backupService, liveDatabasePath: databasePath,
      loadWorkspaceKey: backupOptions.loadWorkspaceKey, clock: domainClock, ids: domainIds,
      dialogs: createRecoveryDialogs(backupOptions.backupDirectory),
    };
    recoveryService = dependencies.createRecoveryService?.(recoveryOptions) ?? new RecoveryService(recoveryOptions);
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
      recoveryService,
      undefined,
      dependencies.createEnrichmentRequester?.(
        runtime,
        options.userDataPath,
        options.logger,
      ),
      options.logDirectoryPath,
      outbound,
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
    detachStartupAbort();

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
        { cause: startupError },
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

function createRecoveryDialogs(backupDirectory: string): RecoveryDialogs {
  return {
    saveMaterial: async () => {
      const result = await dialog.showSaveDialog({ title: 'Save private recovery material', defaultPath: 'callie-recovery.txt', filters: [{ name: 'Recovery material', extensions: ['txt'] }] });
      return result.canceled ? null : result.filePath ?? null;
    },
    selectBackup: async () => {
      const result = await dialog.showOpenDialog({ title: 'Select a verified Callie backup', defaultPath: backupDirectory, properties: ['openFile'], filters: [{ name: 'Encrypted backup', extensions: ['sqlite3'] }] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
    selectMaterial: async () => {
      const result = await dialog.showOpenDialog({ title: 'Select your saved private recovery material', properties: ['openFile'], filters: [{ name: 'Recovery material', extensions: ['txt'] }] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
  };
}
