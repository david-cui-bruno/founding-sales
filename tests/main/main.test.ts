import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppDatabase } from '../../src/main/db/database';
import { fakeDomainRuntime } from '../fixtures/fakeDomainRuntime';
import type { AppleBridgeSupervisorApi } from '../../src/main/appleBridge/appleBridgeSupervisor';
import type { HealthProvider } from '../../src/main/health/registerHealthIpc';
import type { ApplicationStartupDependencies, ApplicationStartupOptions } from '../../src/main/startApplication';
import type { SourcingPoller } from '../../src/main/sourcing/sourcingPoller';
import type { SourcingPollHealth } from '../../src/shared/contracts/sourcingContract';
import { createOutboundCommandService } from '../../src/main/communications/outboundCommandService';
import type { OutboundCommandServiceApi } from '../../src/main/communications/outboundPorts';

const mocks = vi.hoisted(() => {
  const fileLogSink = {
    directoryPath: '/Users/founder/Library/Application Support/Callie/logs',
    write: vi.fn(),
  };
  const logger = { log: vi.fn() };

  return {
    appOn: vi.fn(),
    appQuit: vi.fn(),
    browserWindows: vi.fn(() => []),
    commandLineHasSwitch: vi.fn((name: string) => name.length < 0),
    createFileLogSink: vi.fn(() => fileLogSink),
    createSafeLogger: vi.fn(() => logger),
    createWindow: vi.fn(),
    fileLogSink,
    loadUrl: vi.fn(),
    logger,
    protocolSchemes: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    registerProtocol: vi.fn(),
    startApplication: vi.fn(),
    whenReady: vi.fn(),
    powerOn: vi.fn(),
    powerRemove: vi.fn(),
    powerListeners: new Map<string, Set<() => void>>(),
    windowDestroy: vi.fn(),
    windowIsDestroyed: vi.fn(() => false),
  };
});

vi.mock('electron', () => ({
  app: {
    commandLine: { hasSwitch: mocks.commandLineHasSwitch },
    getPath: vi.fn(() => '/Users/founder/Library/Application Support/Callie'),
    getVersion: vi.fn(() => '4.5.6'),
    isPackaged: false,
    on: mocks.appOn,
    quit: mocks.appQuit,
    requestSingleInstanceLock: mocks.requestSingleInstanceLock,
    whenReady: mocks.whenReady,
  },
  BrowserWindow: { getAllWindows: mocks.browserWindows },
  protocol: { registerSchemesAsPrivileged: mocks.protocolSchemes },
  powerMonitor: { on: mocks.powerOn, removeListener: mocks.powerRemove },
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    encryptStringAsync: vi.fn(async () => Buffer.from('protected')),
    decryptStringAsync: vi.fn(async () => ({
      result: Buffer.alloc(32, 0x2a).toString('base64'),
      shouldReEncrypt: false,
    })),
  },
}));

vi.mock('electron-squirrel-startup', () => ({ default: false }));
vi.mock('../../src/main/createWindow', () => ({
  createWindow: mocks.createWindow,
}));
vi.mock('../../src/main/protocol', () => ({
  registerCallieProtocol: mocks.registerProtocol,
}));
vi.mock('../../src/main/startApplication', () => ({
  startApplication: mocks.startApplication,
}));
vi.mock('../../src/main/logging/fileLogSink', () => ({
  createFileLogSink: mocks.createFileLogSink,
}));
vi.mock('../../src/main/logging/safeLogger', () => ({
  createSafeLogger: mocks.createSafeLogger,
}));

describe('main process startup', () => {
  let resolveReady: (() => void) | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.powerListeners.clear();
    mocks.powerOn.mockReset().mockImplementation((event: string, callback: () => void) => {
      const listeners = mocks.powerListeners.get(event) ?? new Set<() => void>();
      listeners.add(callback); mocks.powerListeners.set(event, listeners);
    });
    mocks.powerRemove.mockReset().mockImplementation((event: string, callback: () => void) => {
      mocks.powerListeners.get(event)?.delete(callback);
    });
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined);
    vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
    mocks.whenReady.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveReady = resolve;
      }),
    );
    mocks.createWindow.mockReturnValue({
      destroy: mocks.windowDestroy,
      isDestroyed: mocks.windowIsDestroyed,
      loadURL: mocks.loadUrl,
      webContents: {
        on: vi.fn(),
        setWindowOpenHandler: vi.fn(),
      },
    });
    mocks.commandLineHasSwitch.mockReturnValue(false);
  });

  async function settleStartup(): Promise<void> {
    resolveReady?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  function disabledAppleBridgeSupervisor(): AppleBridgeSupervisorApi {
    return {
      start: async () => undefined,
      getStatus: () => ({
        state: 'disabled',
        reason: 'not_packaged_or_configured',
      }),
      request: async () => {
        throw new Error('Apple integration helper is unavailable.');
      },
      subscribe: () => () => undefined,
      stop: async () => undefined,
    };
  }

  function explicitIdleSourcingPoller(): SourcingPoller {
    return {
      getHealth: (): SourcingPollHealth => ({
        status: 'healthy', reasons: [], lastSuccessAgeMs: null,
        state: {
          state: 'idle', pollId: null, startedAt: null, lastCompletedAt: null,
          consecutiveFailures: 0, lastFailureAt: null, lastFailureCode: null, backlogCount: null,
        },
      }),
      stop: (): void => undefined,
      idle: async (): Promise<void> => undefined,
      start: async (): Promise<void> => undefined,
    } as unknown as SourcingPoller;
  }

  const inertBackupRecovery = (): Pick<ApplicationStartupDependencies, 'createBackupService' | 'createRecoveryService'> => ({
    createBackupService: () => ({ start: async () => undefined, shutdown: async () => undefined,
      listAvailableBackups: async () => [], createBackup: async () => { throw new Error('unexpected backup'); } }),
    createRecoveryService: () => ({ status: vi.fn(), beginSetup: vi.fn(), saveSetupMaterial: vi.fn(),
      completeSetup: vi.fn(), selectAndRunRestoreDrill: vi.fn(), shutdown: async () => undefined }),
  });

  it('forwards real source events to the pending startup owner and captured late events cannot revive it after before-quit', async () => {
    let outbound!: OutboundCommandServiceApi;
    let resolveWindow!: () => void;
    mocks.loadUrl.mockReturnValue(new Promise<void>((resolve) => { resolveWindow = resolve; }));
    const close = vi.fn();
    const dependencies: ApplicationStartupDependencies = {
      ...inertBackupRecovery(),
      loadWorkspaceKey: async () => ({ bytes: Buffer.alloc(32, 0x2a), version: 1 }),
      prepareEncryptedDatabase: async () => undefined,
      openDatabase: () => ({ path: '/fixture/main-events' }) as AppDatabase,
      migrateToLatest: async () => ({ fromVersion: 0, toVersion: 2, appliedMigrationIds: [] }),
      createDomainRuntime: () => fakeDomainRuntime(),
      createHealthService: () => ({ getHealth: () => ({}) }),
      createSourcingPoller: explicitIdleSourcingPoller,
      createOutboundCommandService: (input) => { outbound = createOutboundCommandService(input); return outbound; },
      registerApplicationIpc: vi.fn(() => vi.fn()),
      createAppleBridgeSupervisor: disabledAppleBridgeSupervisor,
      closeDatabase: close,
    };
    const actual = await vi.importActual<typeof import('../../src/main/startApplication')>('../../src/main/startApplication');
    mocks.startApplication.mockImplementation((options) => actual.startApplication(options, dependencies));
    await import('../../src/main'); await settleStartup();
    expect(mocks.loadUrl).toHaveBeenCalledTimes(1);
    expect(mocks.powerOn.mock.calls.map(([event]) => event)).toEqual(['resume', 'lock-screen', 'unlock-screen']);
    const saved = Object.fromEntries(mocks.powerOn.mock.calls) as Record<string, () => void>;
    saved['lock-screen'](); saved.resume();
    expect((await outbound.getCapabilities()).phoneHandoff.reasonCode).toBe('workspace_inactive');
    saved['unlock-screen']();
    expect((await outbound.getCapabilities()).phoneHandoff.reasonCode).toBe('inbound_safety_unwired');
    const beforeQuit = mocks.appOn.mock.calls.find(([event]) => event === 'before-quit')![1];
    beforeQuit({ preventDefault: vi.fn() }); beforeQuit({ preventDefault: vi.fn() });
    expect((await outbound.getCapabilities()).phoneHandoff.reasonCode).toBe('workspace_inactive');
    saved.resume(); saved['unlock-screen'](); saved['lock-screen']();
    expect((await outbound.getCapabilities()).phoneHandoff.reasonCode).toBe('workspace_inactive');
    expect(mocks.powerRemove).toHaveBeenCalledTimes(3);
    expect([...mocks.powerListeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    resolveWindow(); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(close).toHaveBeenCalledTimes(1);
    expect(mocks.appQuit).toHaveBeenCalledTimes(1);
  });

  it('quits a second instance before readiness or database startup', async () => {
    mocks.requestSingleInstanceLock.mockReturnValueOnce(false);

    await import('../../src/main');

    expect(mocks.requestSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(mocks.appQuit).toHaveBeenCalledTimes(1);
    expect(mocks.whenReady).not.toHaveBeenCalled();
    expect(mocks.startApplication).not.toHaveBeenCalled();
    expect(mocks.powerOn).not.toHaveBeenCalled();
  });

  it('supplies owned resume, lock-screen and unlock-screen callbacks only after readiness', async () => {
    mocks.startApplication.mockResolvedValue({ shutdown: async (): Promise<void> => undefined });
    await import('../../src/main');
    expect(mocks.powerOn).not.toHaveBeenCalled();
    await settleStartup();
    const options = mocks.startApplication.mock.calls[0][0] as ApplicationStartupOptions;
    expect(options.registerOutboundLifecycle).toBeTypeOf('function');
    const callbacks = { onWake: vi.fn(), onLock: vi.fn(), onUnlock: vi.fn() };
    const foreign = (): void => undefined;
    mocks.powerOn('resume', foreign);
    const unregister = options.registerOutboundLifecycle!(callbacks);
    expect(mocks.powerOn.mock.calls.slice(1)).toEqual([
      ['resume', callbacks.onWake], ['lock-screen', callbacks.onLock], ['unlock-screen', callbacks.onUnlock],
    ]);
    for (const event of ['resume', 'lock-screen', 'unlock-screen']) {
      for (const listener of mocks.powerListeners.get(event) ?? []) listener();
    }
    expect(callbacks.onWake).toHaveBeenCalledTimes(1);
    expect(callbacks.onLock).toHaveBeenCalledTimes(1);
    expect(callbacks.onUnlock).toHaveBeenCalledTimes(1);
    unregister(); unregister();
    expect(mocks.powerRemove).toHaveBeenCalledTimes(3);
    expect([...mocks.powerListeners.get('resume')!]).toEqual([foreign]);
    expect(mocks.powerListeners.get('lock-screen')!.size).toBe(0);
    expect(mocks.powerListeners.get('unlock-screen')!.size).toBe(0);
  });

  it.each([2, 3])('rolls back successful lifecycle registrations after registration %s fails and preserves cleanup errors', async (nth) => {
    mocks.startApplication.mockResolvedValue({ shutdown: async (): Promise<void> => undefined });
    await import('../../src/main'); await settleStartup();
    const register = (mocks.startApplication.mock.calls[0][0] as ApplicationStartupOptions).registerOutboundLifecycle;
    expect(register).toBeTypeOf('function');
    const registrationError = new Error('registration'); const cleanupError = new Error('removal');
    const on = mocks.powerOn.getMockImplementation()!;
    mocks.powerOn.mockImplementation((...args) => {
      if (mocks.powerOn.mock.calls.length === nth) throw registrationError;
      return on(...args);
    });
    const remove = mocks.powerRemove.getMockImplementation()!;
    mocks.powerRemove.mockImplementation((...args) => { remove(...args); throw cleanupError; });
    let error: unknown;
    try { register!({ onWake: vi.fn(), onLock: vi.fn(), onUnlock: vi.fn() }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).cause).toBe(registrationError);
    expect((error as AggregateError).errors).toEqual([registrationError, ...Array(nth - 1).fill(cleanupError)]);
    expect([...mocks.powerListeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    expect(mocks.powerRemove.mock.calls.map(([name]) => name)).toEqual(nth === 2 ? ['resume'] : ['lock-screen', 'resume']);
  });

  it('attempts every owned removal and remains idempotent when removal throws', async () => {
    mocks.startApplication.mockResolvedValue({ shutdown: async (): Promise<void> => undefined });
    await import('../../src/main'); await settleStartup();
    const register = (mocks.startApplication.mock.calls[0][0] as ApplicationStartupOptions).registerOutboundLifecycle;
    expect(register).toBeTypeOf('function');
    const unregister = register!({ onWake: vi.fn(), onLock: vi.fn(), onUnlock: vi.fn() });
    const remove = mocks.powerRemove.getMockImplementation()!;
    const failure = new Error('remove');
    mocks.powerRemove.mockImplementation((...args) => { remove(...args); throw failure; });
    let error: unknown;
    try { unregister(); } catch (caught) { error = caught; }
    expect((error as AggregateError).errors).toEqual([failure, failure, failure]);
    expect([...mocks.powerListeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    expect(unregister).not.toThrow();
    expect(mocks.powerRemove).toHaveBeenCalledTimes(3);
  });

  it('starts composition only after readiness and supplies the app-owned path and version', async () => {
    const shutdown = vi.fn(async () => undefined);
    mocks.loadUrl.mockResolvedValue(undefined);
    mocks.startApplication.mockImplementation(async (options) => {
      await options.createWindow();
      return {
        databasePath: '/Users/founder/Library/Application Support/Callie/callie.sqlite3',
        shutdown,
      };
    });

    await import('../../src/main');

    expect(mocks.startApplication).not.toHaveBeenCalled();
    await settleStartup();

    expect(mocks.createFileLogSink).toHaveBeenCalledTimes(1);
    expect(mocks.createFileLogSink).toHaveBeenCalledWith({
      userDataPath: '/Users/founder/Library/Application Support/Callie',
    });
    expect(mocks.createSafeLogger).toHaveBeenCalledTimes(1);
    expect(mocks.createSafeLogger).toHaveBeenCalledWith({
      write: mocks.fileLogSink.write,
    });
    expect(mocks.startApplication).toHaveBeenCalledTimes(1);
    expect(mocks.startApplication).toHaveBeenCalledWith({
      appVersion: '4.5.6',
      userDataPath: '/Users/founder/Library/Application Support/Callie',
      appleBridge: {
        platform: process.platform,
        isPackaged: false,
        resourcesPath: process.resourcesPath,
        environment: {
          CALLIE_APPLE_BRIDGE_PATH:
            process.env.CALLIE_APPLE_BRIDGE_PATH,
        },
        allowDevelopmentOverride: true,
        allowUnsignedDevelopment: true,
        stagingRoot: '/Users/founder/Library/Application Support/Callie/apple-bridge-staging',
        expectedIdentifier: 'com.callie.foundersales.applebridge',
        parentExecutablePath: process.execPath,
      },
      appleSpikeEnabled: false,
      sourcingPollingEnabled: true,
      phoneRouteMode: 'native',
      signal: expect.anything(),
      isTrustedRendererUrl: expect.any(Function),
      logger: mocks.logger,
      logDirectoryPath: mocks.fileLogSink.directoryPath,
      registerOutboundLifecycle: expect.any(Function),
      createWindow: expect.any(Function),
    });
    const startupOptions = mocks.startApplication.mock.calls[0]?.[0] as
      | { isTrustedRendererUrl(url: string): boolean }
      | undefined;
    expect(
      startupOptions?.isTrustedRendererUrl('callie://app/index.html'),
    ).toBe(true);
    expect(
      startupOptions?.isTrustedRendererUrl('http://localhost:5173/'),
    ).toBe(false);
    expect(mocks.registerProtocol).toHaveBeenCalledTimes(1);
    expect(mocks.createWindow).toHaveBeenCalledTimes(1);
    expect(
      mocks.registerProtocol.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.createWindow.mock.invocationCallOrder[0] as number);

    const beforeQuit = mocks.appOn.mock.calls.find(
      ([event]) => event === 'before-quit',
    )?.[1] as
      | ((event: { preventDefault(): void }) => void)
      | undefined;
    expect(beforeQuit).toBeTypeOf('function');
    const preventDefault = vi.fn();
    beforeQuit?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.appQuit).toHaveBeenCalledTimes(1);
  });

  it('enables the spike only from the exact Electron command-line switch', async () => {
    mocks.commandLineHasSwitch.mockImplementation(
      (name: string) => name === 'apple-feasibility-spike',
    );
    mocks.loadUrl.mockResolvedValue(undefined);

    await import('../../src/main');
    await settleStartup();

    expect(mocks.commandLineHasSwitch).toHaveBeenCalledWith('apple-feasibility-spike');
    expect(mocks.startApplication.mock.calls[0]?.[0]).toMatchObject({
      appleSpikeEnabled: true,
    });
  });

  it('disables sourcing auto-polling under the mock-keychain test switch', async () => {
    mocks.commandLineHasSwitch.mockImplementation(
      (name: string) => name === 'use-mock-keychain',
    );
    mocks.loadUrl.mockResolvedValue(undefined);

    await import('../../src/main');
    await settleStartup();

    expect(mocks.commandLineHasSwitch).toHaveBeenCalledWith('use-mock-keychain');
    expect(mocks.startApplication.mock.calls[0]?.[0]).toMatchObject({
      sourcingPollingEnabled: false,
      phoneRouteMode: 'fixture',
    });
  });

  it('composes the exact Vite development URL into navigation and IPC trust', async () => {
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://localhost:5173');
    mocks.loadUrl.mockResolvedValue(undefined);

    await import('../../src/main');
    await settleStartup();

    const startupOptions = mocks.startApplication.mock.calls[0]?.[0] as
      | {
          createWindow(): Promise<void>;
          isTrustedRendererUrl(url: string): boolean;
        }
      | undefined;
    await startupOptions?.createWindow();

    expect(startupOptions?.isTrustedRendererUrl('http://localhost:5173/')).toBe(
      true,
    );
    expect(
      startupOptions?.isTrustedRendererUrl('http://localhost:5173/other'),
    ).toBe(false);
    expect(mocks.loadUrl).toHaveBeenCalledWith('http://localhost:5173/');
  });

  it('quits without creating an unmanaged window when initialization fails', async () => {
    mocks.startApplication.mockRejectedValue(new Error('database unavailable'));

    await import('../../src/main');
    await settleStartup();

    expect(mocks.createWindow).not.toHaveBeenCalled();
    expect(mocks.appQuit).toHaveBeenCalledTimes(1);
  });

  it('coordinates before-quit with foundation initialization that has not settled', async () => {
    const events: string[] = [];
    const database = { path: '/tmp/callie.sqlite3' } as AppDatabase;
    let healthProvider: HealthProvider | undefined;
    let settleMigration: (() => void) | undefined;
    const dependencies: ApplicationStartupDependencies = {
      ...inertBackupRecovery(),
      loadWorkspaceKey: async () => ({ bytes: Buffer.alloc(32, 0x2a), version: 1 }),
      prepareEncryptedDatabase: async () => undefined,
      openDatabase: () => {
        events.push('open');
        return database;
      },
      migrateToLatest: () => {
        events.push('migrate');
        return new Promise((resolve) => {
          settleMigration = () =>
            resolve({
              fromVersion: 0,
              toVersion: 2,
              appliedMigrationIds: ['0001Foundation', '0002DomainFoundation'],
            });
        });
      },
      createDomainRuntime: () => {
        events.push('jobs');
        return fakeDomainRuntime();
      },
      createHealthService: () => {
        events.push('health');
        return { getHealth: () => ({}) };
      },
      createSourcingPoller: explicitIdleSourcingPoller,
      registerApplicationIpc: (provider: HealthProvider) => {
        events.push('ipc');
        healthProvider = provider;
        return () => events.push('unregister');
      },
      createAppleBridgeSupervisor: disabledAppleBridgeSupervisor,
      closeDatabase: () => events.push('close'),
    };
    const actual = await vi.importActual<
      typeof import('../../src/main/startApplication')
    >('../../src/main/startApplication');
    mocks.startApplication.mockImplementation((options) =>
      actual.startApplication(options, dependencies),
    );

    await import('../../src/main');
    await settleStartup();
    expect(healthProvider).toBeUndefined();

    const beforeQuit = mocks.appOn.mock.calls.find(
      ([event]) => event === 'before-quit',
    )?.[1] as
      | ((event: { preventDefault(): void }) => void)
      | undefined;
    const preventDefault = vi.fn();
    beforeQuit?.({ preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);

    settleMigration?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toEqual([
      'open',
      'migrate',
      'jobs',
      'health',
      'close',
    ]);
    expect(mocks.createWindow).not.toHaveBeenCalled();
    expect(mocks.appQuit).toHaveBeenCalledTimes(1);
  });

  it('destroys a partial window and quits when renderer loading rejects', async () => {
    const events: string[] = [];
    const database = { path: '/tmp/callie.sqlite3' } as AppDatabase;
    const loadFailure = {
      then: (_resolve: unknown, reject: (error: Error) => void) =>
        reject(new Error('renderer load failed')),
    };
    mocks.loadUrl.mockReturnValue(loadFailure);
    const dependencies: ApplicationStartupDependencies = {
      ...inertBackupRecovery(),
      loadWorkspaceKey: async () => ({ bytes: Buffer.alloc(32, 0x2a), version: 1 }),
      prepareEncryptedDatabase: async () => undefined,
      openDatabase: () => {
        events.push('open');
        return database;
      },
      migrateToLatest: async () => {
        events.push('migrate');
        return {
          fromVersion: 0,
          toVersion: 2,
          appliedMigrationIds: ['0001Foundation', '0002DomainFoundation'],
        };
      },
      createDomainRuntime: () => fakeDomainRuntime({
        onInitialize: () => events.push('recover'),
      }),
      createHealthService: () => {
        events.push('health');
        return { getHealth: () => ({}) };
      },
      createSourcingPoller: explicitIdleSourcingPoller,
      registerApplicationIpc: () => {
        events.push('ipc');
        return () => events.push('unregister');
      },
      createAppleBridgeSupervisor: disabledAppleBridgeSupervisor,
      closeDatabase: () => events.push('close'),
    };
    const actual = await vi.importActual<
      typeof import('../../src/main/startApplication')
    >('../../src/main/startApplication');
    mocks.startApplication.mockImplementation((options) =>
      actual.startApplication(options, dependencies),
    );

    await import('../../src/main');
    await settleStartup();

    expect(mocks.windowDestroy).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      'open',
      'migrate',
      'recover',
      'health',
      'ipc',
      'unregister',
      'close',
    ]);
    expect(mocks.appQuit).toHaveBeenCalledTimes(1);
  });
});
