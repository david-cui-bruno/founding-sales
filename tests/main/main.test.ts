import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppDatabase } from '../../src/main/db/database';
import type { AppleBridgeSupervisorApi } from '../../src/main/appleBridge/appleBridgeSupervisor';
import type { HealthProvider } from '../../src/main/health/registerHealthIpc';
import type { ApplicationStartupDependencies } from '../../src/main/startApplication';

const mocks = vi.hoisted(() => ({
  appOn: vi.fn(),
  appQuit: vi.fn(),
  browserWindows: vi.fn(() => []),
  commandLineHasSwitch: vi.fn((name: string) => name.length < 0),
  createWindow: vi.fn(),
  loadUrl: vi.fn(),
  protocolSchemes: vi.fn(),
  requestSingleInstanceLock: vi.fn(() => true),
  registerProtocol: vi.fn(),
  startApplication: vi.fn(),
  whenReady: vi.fn(),
  windowDestroy: vi.fn(),
  windowIsDestroyed: vi.fn(() => false),
}));

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

describe('main process startup', () => {
  let resolveReady: (() => void) | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
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

  it('quits a second instance before readiness or database startup', async () => {
    mocks.requestSingleInstanceLock.mockReturnValueOnce(false);

    await import('../../src/main');

    expect(mocks.requestSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(mocks.appQuit).toHaveBeenCalledTimes(1);
    expect(mocks.whenReady).not.toHaveBeenCalled();
    expect(mocks.startApplication).not.toHaveBeenCalled();
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
      signal: expect.anything(),
      isTrustedRendererUrl: expect.any(Function),
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
      createJobRepository: () => {
        events.push('jobs');
        return {
          listActive: () => [],
          recoverInterruptedJobs: () => 0,
        };
      },
      createHealthService: () => {
        events.push('health');
        return { getHealth: () => ({}) };
      },
      registerHealthIpc: (provider) => {
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
      createJobRepository: () => ({
        listActive: () => [],
        recoverInterruptedJobs: () => {
          events.push('recover');
          return 0;
        },
      }),
      createHealthService: () => {
        events.push('health');
        return { getHealth: () => ({}) };
      },
      registerHealthIpc: () => {
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
