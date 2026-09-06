import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { fakeDomainRuntime } from '../fixtures/fakeDomainRuntime';

import type { AppDatabase } from '../../src/main/db/database';
import type { MigrationOptions } from '../../src/main/db/migrate';
import type { HealthProvider } from '../../src/main/health/registerHealthIpc';
import type { SourcingPoller } from '../../src/main/sourcing/sourcingPoller';
import {
  startApplication,
  type ApplicationStartupDependencies,
  type ApplicationStartupOptions,
} from '../../src/main/startApplication';
import type { AppHealth } from '../../src/shared/healthContract';
import { createOutboundCommandService } from '../../src/main/communications/outboundCommandService';
import type { OutboundCommandServiceApi } from '../../src/main/communications/outboundPorts';
import type { FoundationRuntime } from '../../src/main/foundation/foundationRuntime';

const nativeDialogs = vi.hoisted(() => ({ showSaveDialog: vi.fn(), showOpenDialog: vi.fn() }));
vi.mock('electron', () => ({ dialog: nativeDialogs, safeStorage: {} }));

const health: AppHealth = {
  appVersion: '1.0.0',
  schemaVersion: 2,
  databasePath: '/tmp/callie.sqlite3',
  databaseEncrypted: true,
  cipherVersion: 'SQLite3 Multiple Ciphers 2.3.5',
  fts5Available: true,
  pendingJobs: 0,
  interruptedJobsRecovered: 4,
  domainStatus: 'ready',
  domainReady: true,
  domainBlockingViolationCount: 0,
  domainRepairableIssueCount: 0,
  domainProjectionRefreshCandidateCount: 0,
  pendingProjectionRebuilds: 0,
  domainStartupEvaluatedAt: '2026-08-30T12:00:00.000Z',
  operationalStatus: 'ready',
  sourcing: {
    status: 'healthy', reasons: [], lastSuccessAgeMs: null,
    state: {
      state: 'idle', pollId: null, startedAt: null, lastCompletedAt: null,
      consecutiveFailures: 0, lastFailureAt: null, lastFailureCode: null,
      backlogCount: null,
    },
  },
};

const keyDependencies = () => ({
  loadWorkspaceKey: async () => ({ bytes: Buffer.alloc(32, 0x2a), version: 1 as const }),
  prepareEncryptedDatabase: async (): Promise<void> => undefined,
});

describe('startApplication', () => {
  const request = { commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', channel: 'call' as const,
    personId: 'p', salesCycleId: 's', contactMethodId: 'c', expectedContactSnapshot: 'a'.repeat(64) };
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };

  function createDependencies(
    events: string[],
    captureHealth?: (provider: HealthProvider) => void,
    captureMigration?: (options: MigrationOptions) => void,
  ): ApplicationStartupDependencies {
    const database = { path: '/ignored-until-open' } as AppDatabase;

    return {
      ...keyDependencies(),
      createRecoveryService: () => ({ status: vi.fn(), beginSetup: vi.fn(), saveSetupMaterial: vi.fn(),
        completeSetup: vi.fn(), selectAndRunRestoreDrill: vi.fn(), shutdown: async () => undefined }),
      createBackupService: () => ({
        start: async () => undefined,
        shutdown: async () => undefined,
        listAvailableBackups: async () => [],
        createBackup: async () => { throw new Error('Unexpected backup request'); },
      }),
      openDatabase: ({ path }) => {
        events.push(`open:${path}`);
        return database;
      },
      migrateToLatest: async (_database, options) => {
        events.push('migrate');
        captureMigration?.(options);
        return {
          fromVersion: 0,
          toVersion: 2,
          appliedMigrationIds: ['0001Foundation', '0002DomainFoundation'],
        };
      },
      createDomainRuntime: () => fakeDomainRuntime({
        onInitialize: () => events.push('recover'),
        interruptedJobsRecovered: 4,
      }),
      createHealthService: (options) => {
        events.push(`health:${options.domainStartupReport.interruptedJobsRecovered}`);
        return { getHealth: () => health };
      },
      createSourcingPoller: () => ({
        getHealth: () => health.sourcing,
        stop: (): void => undefined,
        idle: async (): Promise<void> => undefined,
        pollNow: async (): Promise<void> => undefined,
        retry: async (): Promise<void> => undefined,
        getStatus: async () => ({}) as never,
        setHmacSalt: async (): Promise<void> => undefined,
      }) as unknown as SourcingPoller,
      registerApplicationIpc: (provider: HealthProvider) => {
        events.push('ipc');
        captureHealth?.(provider);
        return () => events.push('unregister');
      },
      createAppleBridgeSupervisor: () => {
        throw new Error('Apple bridge must not be created without startup options.');
      },
      closeDatabase: () => events.push('close'),
    };
  }

  it('constructs one outbound service after initialization, registers lifecycle before exposure and passes argument nine unchanged', async () => {
    const events: string[] = [];
    const dependencies = createDependencies(events);
    let service!: OutboundCommandServiceApi;
    let runtime!: FoundationRuntime;
    let callbacks!: Parameters<NonNullable<ApplicationStartupOptions['registerOutboundLifecycle']>>[0];
    const factory = vi.fn<typeof createOutboundCommandService>((input) => {
      expect(events).toContain('recover');
      events.push('outbound');
      service = createOutboundCommandService(input);
      return service;
    });
    dependencies.createOutboundCommandService = factory;
    const enrichment = { request: vi.fn() };
    dependencies.createEnrichmentRequester = () => enrichment;
    const register = vi.fn<ApplicationStartupDependencies['registerApplicationIpc']>((bound) => {
      runtime = bound; events.push('ipc'); return () => events.push('unregister');
    });
    dependencies.registerApplicationIpc = register;
    const trust = () => true;
    const controller = new AbortController();
    const removeAbort = vi.spyOn(controller.signal, 'removeEventListener');
    const app = await startApplication({ appVersion: '1', userDataPath: '/fixture/outbound', signal: controller.signal,
      isTrustedRendererUrl: trust, logDirectoryPath: '/fixture/logs',
      registerOutboundLifecycle: (owned) => { callbacks = owned; events.push('listen'); return () => events.push('unlisten'); },
      createWindow: () => { events.push('window'); },
    }, dependencies);
    try {
      expect(factory).toHaveBeenCalledTimes(1);
      expect(register.mock.calls[0]).toEqual([runtime, trust, undefined, expect.any(Object), expect.any(Object), undefined, enrichment, '/fixture/logs', service]);
      expect(events.slice(4, 8)).toEqual(['outbound', 'listen', 'ipc', 'window']);
      expect(removeAbort).toHaveBeenCalledTimes(1);
      const domain = vi.spyOn(runtime, 'withDomain');
      const active = await service.getCapabilities();
      expect(active.phoneHandoff).toEqual({ state: 'unavailable', reasonCode: 'inbound_safety_unwired' });
      expect(active.localDrafts).toBe(true);
      for (const name of ['callObservation', 'recording', 'messagesSend', 'gmailSend', 'managedAudioImport', 'appleTranscriptExtraction'] as const) {
        expect(active[name]).toEqual({ state: 'unavailable', reasonCode: 'not_integrated' });
      }
      callbacks.onLock(); callbacks.onWake();
      expect((await service.getCapabilities()).phoneHandoff.reasonCode).toBe('workspace_inactive');
      await expect(service.beginOutbound(request)).rejects.toThrow('inactive');
      callbacks.onUnlock();
      expect((await service.getCapabilities()).phoneHandoff.reasonCode).toBe('inbound_safety_unwired');
      expect(domain).not.toHaveBeenCalled();
      await app.shutdown();
      callbacks.onWake(); callbacks.onUnlock(); callbacks.onLock();
      expect((await service.getCapabilities()).phoneHandoff.reasonCode).toBe('workspace_inactive');
      await expect(service.beginOutbound(request)).rejects.toThrow('inactive');
      expect(domain).not.toHaveBeenCalled();
      expect(events.slice(-3)).toEqual(['unlisten', 'unregister', 'close']);
    } finally { await app.shutdown(); removeAbort.mockRestore(); }
  });

  it('uses the real default unavailable service even without a fixture factory', async () => {
    const dependencies = createDependencies([]);
    let outbound: OutboundCommandServiceApi | undefined;
    dependencies.registerApplicationIpc = (...args) => { outbound = args[8]; return () => undefined; };
    const app = await startApplication({ appVersion: '1', userDataPath: '/fixture/default-outbound', createWindow: () => undefined }, dependencies);
    try {
      expect(outbound).toBeDefined();
      expect((await outbound!.getCapabilities()).phoneHandoff.reasonCode).toBe('inbound_safety_unwired');
    } finally { await app.shutdown(); }
  });

  it('closes synchronously before owner drains and reserves one shutdown completion before reentrant disposal', async () => {
    const events: string[] = [];
    const dependencies = createDependencies(events);
    const drain = deferred<void>();
    let reentrant!: Promise<void>;
    let service!: OutboundCommandServiceApi;
    const disposeError = new Error('injected disposer failed before cleaning');
    const listenerError = new Error('listener cleanup failed');
    const invalidate = vi.fn<OutboundCommandServiceApi['invalidate']>();
    const dispose = vi.fn(() => { reentrant = app.shutdown(); throw disposeError; });
    dependencies.createOutboundCommandService = (input) => {
      service = createOutboundCommandService(input);
      invalidate.mockImplementation((reason) => service.invalidate(reason));
      return { ...service, dispose, invalidate };
    };
    dependencies.createRecoveryService = () => ({ status: vi.fn(), beginSetup: vi.fn(), saveSetupMaterial: vi.fn(),
      completeSetup: vi.fn(), selectAndRunRestoreDrill: vi.fn(), shutdown: () => { events.push('recovery-stop'); return drain.promise; } });
    let callbacks!: Parameters<NonNullable<ApplicationStartupOptions['registerOutboundLifecycle']>>[0];
    const app = await startApplication({ appVersion: '1', userDataPath: '/fixture/reentrant',
      registerOutboundLifecycle: (owned) => { callbacks = owned; return () => { events.push('unlisten'); throw listenerError; }; },
      createWindow: () => undefined,
    }, dependencies);
    const stopping = app.shutdown();
    const observed = stopping.catch((error: unknown) => error);
    expect(reentrant).toBe(stopping);
    expect(app.shutdown()).toBe(stopping);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(events.slice(-2)).toEqual(['unlisten', 'recovery-stop']);
    callbacks.onWake(); callbacks.onUnlock(); callbacks.onLock();
    expect(invalidate).not.toHaveBeenCalled();
    expect(events).not.toContain('close');
    drain.resolve();
    const error = await observed as AggregateError;
    expect(error.errors).toEqual([disposeError, listenerError]);
    expect(events.filter((event) => event === 'close')).toHaveLength(1);
    // A throwing injected disposer did NOT clean its service. Explicit fixture cleanup only.
    service.dispose();
  });

  it.each(['factory', 'registration'] as const)('handles a signal aborted synchronously during %s without exposing IPC', async (during) => {
    const dependencies = createDependencies([]); const controller = new AbortController();
    const dispose = vi.fn(); const unlisten = vi.fn();
    dependencies.createOutboundCommandService = (input) => {
      const service = createOutboundCommandService(input); dispose.mockImplementation(() => service.dispose());
      if (during === 'factory') controller.abort();
      return { ...service, dispose };
    };
    const register = vi.fn(() => vi.fn()); dependencies.registerApplicationIpc = register;
    await expect(startApplication({ appVersion: '1', userDataPath: '/fixture/sync-abort', signal: controller.signal,
      registerOutboundLifecycle: () => { controller.abort(); return unlisten; }, createWindow: vi.fn(),
    }, dependencies)).rejects.toThrow('cancelled');
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(unlisten).toHaveBeenCalledTimes(during === 'registration' ? 1 : 0);
    expect(register).not.toHaveBeenCalled();
  });

  it('independently attempts dispose, lifecycle and abort removal, preserving their errors with the window failure', async () => {
    const events: string[] = []; const dependencies = createDependencies(events);
    const controller = new AbortController(); const entered = deferred<void>(); const window = deferred<void>();
    const originalError = new Error('window'); const disposeError = new Error('dispose');
    const lifecycleError = new Error('lifecycle'); const abortError = new Error('abort removal');
    let service!: OutboundCommandServiceApi;
    const dispose = vi.fn(() => { throw disposeError; });
    dependencies.createOutboundCommandService = (input) => { service = createOutboundCommandService(input); return { ...service, dispose }; };
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener').mockImplementation((...args) => { remove(...args); throw abortError; });
    const unlisten = vi.fn(() => { throw lifecycleError; });
    const startup = startApplication({ appVersion: '1', userDataPath: '/fixture/cleanup-errors', signal: controller.signal,
      registerOutboundLifecycle: () => unlisten, createWindow: () => { entered.resolve(); return window.promise; },
    }, dependencies).catch((error: unknown) => error);
    await entered.promise; controller.abort();
    expect(dispose).toHaveBeenCalledTimes(1); expect(unlisten).toHaveBeenCalledTimes(1); expect(removeSpy).toHaveBeenCalledTimes(1);
    window.reject(originalError);
    const error = await startup as AggregateError;
    expect(error.cause).toBe(originalError); expect(error.errors[0]).toBe(originalError);
    expect((error.errors[1] as AggregateError).errors).toEqual([disposeError, lifecycleError, abortError]);
    expect(events.slice(-2)).toEqual(['unregister', 'close']);
    expect(dispose).toHaveBeenCalledTimes(1); expect(removeSpy).toHaveBeenCalledTimes(1);
    removeSpy.mockRestore(); service.dispose(); // The injected throwing disposer never cleaned it.
  });

  it.each(['resolve', 'reject'] as const)('startup abort permanently closes outbound while the window is pending, late window %s', async (settle) => {
    const events: string[] = [];
    const dependencies = createDependencies(events);
    const window = deferred<void>(); const entered = deferred<void>();
    const controller = new AbortController();
    let service!: OutboundCommandServiceApi;
    let dispose!: ReturnType<typeof vi.fn>;
    dependencies.createOutboundCommandService = (input) => {
      service = createOutboundCommandService(input); dispose = vi.fn(() => service.dispose());
      return { ...service, dispose };
    };
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const unlisten = vi.fn();
    const startup = startApplication({ appVersion: '1', userDataPath: '/fixture/abort', signal: controller.signal,
      registerOutboundLifecycle: () => unlisten,
      createWindow: () => { entered.resolve(); return window.promise; },
    }, dependencies);
    const observed = startup.catch((error: Error) => error);
    await entered.promise;
    controller.abort();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect((await service.getCapabilities()).phoneHandoff.reasonCode).toBe('workspace_inactive');
    expect(events).not.toContain('close');
    if (settle === 'resolve') window.resolve(); else window.reject(new Error('window rejected'));
    expect(await observed).toBeInstanceOf(Error);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event === 'close')).toHaveLength(1);
    remove.mockRestore();
  });

  it.each(['initialize', 'factory', 'poller', 'lifecycle', 'ipc', 'window'] as const)('cleans the one constructed service on startup failure at %s', async (stage) => {
    const events: string[] = [];
    const dependencies = createDependencies(events);
    const failure = new Error(stage);
    const dispose = vi.fn(); const unlisten = vi.fn();
    const factory = vi.fn<typeof createOutboundCommandService>((input) => {
      if (stage === 'factory') throw failure;
      const service = createOutboundCommandService(input);
      dispose.mockImplementation(() => service.dispose());
      return { ...service, dispose };
    });
    dependencies.createOutboundCommandService = factory;
    if (stage === 'initialize') dependencies.migrateToLatest = async () => { throw failure; };
    if (stage === 'poller') dependencies.createSourcingPoller = () => { throw failure; };
    if (stage === 'ipc') dependencies.registerApplicationIpc = () => { throw failure; };
    await expect(startApplication({ appVersion: '1', userDataPath: '/fixture/start-failure',
      registerOutboundLifecycle: () => { if (stage === 'lifecycle') throw failure; return unlisten; },
      createWindow: () => { if (stage === 'window') throw failure; },
    }, dependencies)).rejects.toBe(failure);
    expect(factory).toHaveBeenCalledTimes(stage === 'initialize' ? 0 : 1);
    expect(dispose).toHaveBeenCalledTimes(['initialize', 'factory'].includes(stage) ? 0 : 1);
    expect(unlisten).toHaveBeenCalledTimes(['poller', 'ipc', 'window'].includes(stage) ? 1 : 0);
    expect(events.filter((event) => event === 'close')).toHaveLength(1);
  });

  it('constructs recovery from initialized backup availability before IPC and drains it before DB closure', async () => {
    const events: string[] = [];
    const dependencies = createDependencies(events);
    let release!: () => void;
    const drained = new Promise<void>((resolve) => { release = resolve; });
    const provider = { status: vi.fn(), beginSetup: vi.fn(), saveSetupMaterial: vi.fn(), completeSetup: vi.fn(), selectAndRunRestoreDrill: vi.fn(), shutdown: async () => { events.push('recovery-stop'); await drained; events.push('recovery-drained'); } };
    dependencies.createRecoveryService = (options) => {
      expect(events).toContain('recover');
      expect(options.backups.listAvailableBackups).toBeTypeOf('function');
      events.push('recovery-create');
      return provider;
    };
    dependencies.registerApplicationIpc = (_runtime, _trust, _registrars, _sourcing, recovery) => {
      expect(recovery).toBe(provider); events.push('ipc'); return () => events.push('unregister');
    };
    const app = await startApplication({ appVersion: '1', userDataPath: '/tmp/callie-recovery-wiring', createWindow: () => { events.push('window'); } }, dependencies);
    expect(events.indexOf('recovery-create')).toBeLessThan(events.indexOf('ipc'));
    const stopping = app.shutdown(); await vi.waitFor(() => expect(events).toContain('recovery-stop'));
    expect(events).not.toContain('close'); release(); await stopping;
    expect(events.indexOf('recovery-drained')).toBeLessThan(events.indexOf('close'));
  });

  it('binds native dialogs only in main with fixed backup location and propagates cancellation', async () => {
    const events: string[] = []; const dependencies = createDependencies(events);
    let dialogs!: import('../../src/main/recovery/recoveryService').RecoveryDialogs;
    dependencies.createRecoveryService = (options) => {
      dialogs = options.dialogs;
      return { status: vi.fn(), beginSetup: vi.fn(), saveSetupMaterial: vi.fn(), completeSetup: vi.fn(), selectAndRunRestoreDrill: vi.fn(), shutdown: async () => undefined };
    };
    const app = await startApplication({ appVersion: '1', userDataPath: '/tmp/callie-native-dialog-fixture', createWindow: () => undefined }, dependencies);
    try {
      nativeDialogs.showSaveDialog.mockResolvedValueOnce({ canceled: true }).mockResolvedValueOnce({ canceled: false, filePath: '/synthetic/chosen-export.txt' });
      expect(await dialogs.saveMaterial()).toBeNull(); expect(await dialogs.saveMaterial()).toBe('/synthetic/chosen-export.txt');
      nativeDialogs.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/synthetic/backup.sqlite3'] }).mockResolvedValueOnce({ canceled: true, filePaths: [] });
      expect(await dialogs.selectBackup()).toBe('/synthetic/backup.sqlite3');
      expect(nativeDialogs.showOpenDialog).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: '/tmp/callie-native-dialog-fixture/backups', properties: ['openFile'] }));
      expect(await dialogs.selectMaterial()).toBeNull();
    } finally { await app.shutdown(); }
  });

  it('starts backups after initialization, wires fresh existing-workspace key loading and exposes explicit pre-release backup', async () => {
    const events: string[] = [];
    const dependencies = createDependencies(events);
    const loads: unknown[] = [];
    const load = dependencies.loadWorkspaceKey;
    dependencies.loadWorkspaceKey = async (input) => { loads.push(input); return load(input); };
    const snapshot = {
      path: '/disposable/pre_release.sqlite3', basename: 'pre_release.sqlite3',
      kind: 'pre_release' as const, schemaVersion: 15, sha256: 'a'.repeat(64),
      sizeBytes: 4096, createdAt: '2026-09-06T12:00:00.000Z', verifiedAt: '2026-09-06T12:00:00.000Z',
    };
    dependencies.createBackupService = (options) => {
      expect(events).toContain('migrate');
      expect(options.backupDirectory).toBe('/tmp/callie-backup-wiring/backups');
      return {
        start: async () => { events.push('backup-start'); },
        shutdown: async () => { events.push('backup-stop'); },
        listAvailableBackups: async () => [],
        createBackup: async (kind) => {
          expect(kind).toBe('pre_release');
          await options.databaseGate.withDatabase((database) => { expect(database).toBeDefined(); });
          const key = await options.loadWorkspaceKey();
          key.bytes.fill(0);
          return snapshot;
        },
      };
    };
    const running = await startApplication({
      appVersion: '1.0.0', userDataPath: '/tmp/callie-backup-wiring', createWindow: () => { events.push('window'); },
    }, dependencies);
    expect(events.indexOf('backup-start')).toBeGreaterThan(events.indexOf('recover'));
    expect(events.indexOf('backup-start')).toBeLessThan(events.indexOf('window'));
    await expect(running.createPreReleaseBackup()).resolves.toEqual(snapshot);
    expect(loads.at(-1)).toEqual({
      envelopePath: '/tmp/callie-backup-wiring/callie.key-envelope.json', databaseExists: true,
    });
    await running.shutdown();
    expect(events.indexOf('backup-stop')).toBeLessThan(events.indexOf('close'));
    await expect(running.createPreReleaseBackup()).rejects.toThrow();
  });

  it('waits for backup ownership cleanup before closing SQLite, including failed window startup', async () => {
    const events: string[] = [];
    const dependencies = createDependencies(events);
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => { release = resolve; });
    dependencies.createBackupService = () => ({
      start: async () => { events.push('backup-start'); },
      shutdown: async () => { events.push('backup-stopping'); await cleanup; events.push('backup-stopped'); },
      listAvailableBackups: async () => [],
      createBackup: async () => { throw new Error('Unexpected request'); },
    });
    const startup = startApplication({
      appVersion: '1.0.0', userDataPath: '/tmp/callie-backup-cleanup',
      createWindow: () => { throw new Error('window failed'); },
    }, dependencies);
    const result = expect(startup).rejects.toThrow('window failed');
    await vi.waitFor(() => expect(events).toContain('backup-stopping'));
    expect(events).not.toContain('close');
    release();
    await result;
    expect(events.indexOf('backup-stopped')).toBeLessThan(events.indexOf('close'));
  });

  it('rejects a missing sourcing poller dependency before IPC registration', async () => {
    const events: string[] = [];
    const dependencies = createDependencies(events);
    delete (dependencies as Partial<ApplicationStartupDependencies>).createSourcingPoller;

    await expect(startApplication({
      appVersion: '1.0.0', userDataPath: '/tmp/callie-user-data', createWindow: () => undefined,
    }, dependencies)).rejects.toThrow('Sourcing poller dependency is required.');
    expect(events).not.toContain('ipc');
  });

  it('requests the existing-workspace key and never replaces it when the envelope is unavailable', async () => {
    const events: string[] = [];
    const userDataPath = mkdtempSync(join(tmpdir(), 'callie-existing-key-'));
    const databasePath = join(userDataPath, 'callie.sqlite3');
    const original = Buffer.from('synthetic existing encrypted file');
    writeFileSync(databasePath, original);
    const dependencies = createDependencies(events);
    const loadWorkspaceKey = vi.fn(async () => {
      throw new Error('Workspace key is unavailable for an existing database');
    });
    dependencies.loadWorkspaceKey = loadWorkspaceKey;
    try {
      await expect(startApplication({
        appVersion: '1.0.0',
        userDataPath,
        createWindow: () => undefined,
      }, dependencies)).rejects.toThrow('Workspace key is unavailable');

      expect(loadWorkspaceKey).toHaveBeenCalledWith({
        envelopePath: join(userDataPath, 'callie.key-envelope.json'),
        databaseExists: true,
      });
      expect(readFileSync(databasePath)).toEqual(original);
      expect(events).toEqual([]);
    } finally {
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it('initializes the app-owned database before registering diagnostics and opening the window', async () => {
    const events: string[] = [];
    let provider: HealthProvider | undefined;
    const userDataPath = '/Users/founder/Library/Application Support/Callie';

    const running = await startApplication(
      {
        appVersion: '1.0.0',
        userDataPath,
        createWindow: () => {
          events.push('window');
        },
      },
      createDependencies(events, (registered) => {
        provider = registered;
      }),
    );

    expect(events).toEqual([
      `open:${join(userDataPath, 'callie.sqlite3')}`,
      'migrate',
      'recover',
      'health:4',
      'ipc',
      'window',
    ]);
    await expect(provider?.getHealth()).resolves.toEqual(health);
    expect(events).toEqual([
      `open:${join(userDataPath, 'callie.sqlite3')}`,
      'migrate',
      'recover',
      'health:4',
      'ipc',
      'window',
    ]);
    expect(running.databasePath).toBe(join(userDataPath, 'callie.sqlite3'));
  });

  it('passes the app-owned backup directory and live workspace key into migration', async () => {
    const events: string[] = [];
    const userDataPath = '/tmp/callie-migration-wiring';
    let backupDirectory: string | undefined;
    let keyWasLive = false;

    const running = await startApplication(
      {
        appVersion: '1.0.0',
        userDataPath,
        createWindow: () => undefined,
      },
      createDependencies(events, undefined, (options) => {
        backupDirectory = options.backupDirectory;
        keyWasLive = options.workspaceKey.bytes.equals(Buffer.alloc(32, 0x2a));
      }),
    );

    expect(backupDirectory).toBe(join(userDataPath, 'backups'));
    expect(keyWasLive).toBe(true);
    await running.shutdown();
  });

  it('unregisters IPC and closes initialized SQLite exactly once on repeated shutdown requests', async () => {
    const events: string[] = [];
    let provider: HealthProvider | undefined;
    const running = await startApplication(
      {
        appVersion: '1.0.0',
        userDataPath: '/tmp/callie-user-data',
        createWindow: () => {
          events.push('window');
        },
      },
      createDependencies(events, (registered) => {
        provider = registered;
      }),
    );
    await provider?.getHealth();

    await Promise.all([running.shutdown(), running.shutdown()]);

    expect(events.filter((event) => event === 'unregister')).toHaveLength(1);
    expect(events.filter((event) => event === 'close')).toHaveLength(1);
  });

  it('waits for sourcing owner cleanup before unregistering IPC and closing SQLite', async () => {
    const events: string[] = [];
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const dependencies = createDependencies(events);
    dependencies.createSourcingPoller = () => ({
      getHealth: () => health.sourcing,
      stop: (): void => { events.push('poller-stop'); },
      idle: async (): Promise<void> => { await cleanup; events.push('poller-cleanup'); },
      pollNow: async (): Promise<void> => undefined,
      retry: async (): Promise<void> => undefined,
      getStatus: async () => ({}) as never,
      setHmacSalt: async (): Promise<void> => undefined,
    }) as unknown as SourcingPoller;
    const running = await startApplication({
      appVersion: '1.0.0', userDataPath: '/tmp/callie-user-data', createWindow: () => undefined,
    }, dependencies);

    const shutdown = running.shutdown();
    await Promise.resolve();
    expect(events.slice(-1)).toEqual(['poller-stop']);
    expect(events).not.toContain('close');
    releaseCleanup();
    await shutdown;
    expect(events.slice(-3)).toEqual(['poller-cleanup', 'unregister', 'close']);
  });

  it('unregisters IPC and closes ready SQLite when bootstrap window creation fails', async () => {
    const events: string[] = [];

    await expect(
      startApplication(
        {
          appVersion: '1.0.0',
          userDataPath: '/tmp/callie-user-data',
          createWindow: () => {
            events.push('window');
            throw new Error('window failed');
          },
        },
        createDependencies(events),
      ),
    ).rejects.toThrow('window failed');

    expect(events).toEqual([
      'open:/tmp/callie-user-data/callie.sqlite3',
      'migrate',
      'recover',
      'health:4',
      'ipc',
      'window',
      'unregister',
      'close',
    ]);
  });

  it('fails before IPC and window creation when explicit foundation initialization fails', async () => {
    const events: string[] = [];
    let provider: HealthProvider | undefined;
    let migrationAttempts = 0;
    const dependencies = createDependencies(events, (registered) => {
      provider = registered;
    });
    dependencies.migrateToLatest = vi.fn(async () => {
      migrationAttempts += 1;
      events.push(`migrate:${migrationAttempts}`);
      if (migrationAttempts === 1) {
        throw new Error('migration failed');
      }
      return {
        fromVersion: 0,
        toVersion: 2,
        appliedMigrationIds: ['0001Foundation', '0002DomainFoundation'],
      };
    });

    await expect(startApplication(
      {
        appVersion: '1.0.0',
        userDataPath: '/tmp/callie-user-data',
        createWindow: () => {
          events.push('window');
        },
      },
      dependencies,
    )).rejects.toThrow('migration failed');

    expect(provider).toBeUndefined();
    expect(events).toEqual([
      'open:/tmp/callie-user-data/callie.sqlite3',
      'migrate:1',
      'close',
    ]);
  });

  it('cancels startup after Foundation initialization without registering IPC or opening a window', async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const options: ApplicationStartupOptions & { signal: AbortSignal } = {
      appVersion: '1.0.0',
      userDataPath: '/tmp/callie-user-data',
      createWindow: () => {
        events.push('window');
      },
      signal: controller.signal,
    };

    const startup = startApplication(options, createDependencies(events));
    controller.abort();

    await expect(startup).rejects.toThrow('cancelled');
    expect(events).toEqual([
      'open:/tmp/callie-user-data/callie.sqlite3',
      'migrate',
      'recover',
      'health:4',
      'close',
    ]);
  });

  it('awaits window loading and cleans up when it rejects', async () => {
    const events: string[] = [];

    await expect(
      startApplication(
        {
          appVersion: '1.0.0',
          userDataPath: '/tmp/callie-user-data',
          createWindow: async () => {
            events.push('window');
            throw new Error('renderer load failed');
          },
        },
        createDependencies(events),
      ),
    ).rejects.toThrow('renderer load failed');

    expect(events).toEqual([
      'open:/tmp/callie-user-data/callie.sqlite3',
      'migrate',
      'recover',
      'health:4',
      'ipc',
      'window',
      'unregister',
      'close',
    ]);
  });
});
