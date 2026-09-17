import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppDatabase } from '../../src/main/db/database';
import { fakeDomainRuntime } from '../fixtures/fakeDomainRuntime';
import type { AppleBridgeSupervisorApi } from '../../src/main/appleBridge/appleBridgeSupervisor';
import type { HealthProvider } from '../../src/main/health/registerHealthIpc';
import type { ApplicationStartupDependencies, ApplicationStartupOptions, RunningApplication } from '../../src/main/startApplication';
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
    appRelaunch: vi.fn(),
    installer: false,
    backupMode: false,
    backupHost: vi.fn(() => new Promise<never>(() => undefined)),
    dock: undefined as { setBadge(text: string): void } | undefined,
    dockSetBadge: vi.fn(),
    showMessageBox: vi.fn<(...args: unknown[]) => Promise<{ response: number; checkboxChecked: boolean }>>(),
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
    relaunch: mocks.appRelaunch,
    get dock() { return mocks.dock; },
    requestSingleInstanceLock: mocks.requestSingleInstanceLock,
    whenReady: mocks.whenReady,
  },
  dialog: { showMessageBox: mocks.showMessageBox },
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

vi.mock('electron-squirrel-startup', () => ({ get default() { return mocks.installer; } }));
vi.mock('../../src/main/backup/preReleaseBackupRuntime', () => ({
  isPreReleaseBackupInvocation: () => mocks.backupMode,
  runPreReleaseBackupHost: mocks.backupHost,
}));
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
    mocks.installer = false;
    mocks.backupMode = false;
    mocks.backupHost.mockReset().mockImplementation(() => new Promise<never>(() => undefined));
    mocks.appRelaunch.mockReset();
    mocks.dock = undefined;
    mocks.dockSetBadge.mockReset();
    mocks.showMessageBox.mockReset().mockResolvedValue({ response: 0, checkboxChecked: false });
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

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function held<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    return { promise, resolve, reject };
  }

  function returningApplication(shutdown: () => Promise<void>): RunningApplication {
    return {
      databasePath: '/fixture/main-owned.sqlite3',
      shutdown,
      createPreReleaseBackup: async () => { throw new Error('Unexpected backup request'); },
    };
  }

  function throwingDock(): void {
    // Test-only global facade. Never mutate the real process.platform descriptor.
    vi.stubGlobal('process', Object.create(process, {
      platform: { value: 'darwin', configurable: true },
    }));
    mocks.dock = { setBadge: mocks.dockSetBadge };
    mocks.dockSetBadge.mockImplementation(() => {
      throw new Error('private dock failure /private/startup-secret');
    });
  }

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

  it('selects the fixture phone route under the mock-keychain test switch', async () => {
    mocks.commandLineHasSwitch.mockImplementation(
      (name: string) => name === 'use-mock-keychain',
    );
    mocks.loadUrl.mockResolvedValue(undefined);

    await import('../../src/main');
    await settleStartup();

    expect(mocks.commandLineHasSwitch).toHaveBeenCalledWith('use-mock-keychain');
    expect(mocks.startApplication.mock.calls[0]?.[0]).toMatchObject({
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

  it.each(['installer', 'second-instance', 'backup-host'] as const)('suppresses fatal startup dialog for the intentional %s path', async mode => {
    mocks.installer = mode === 'installer';
    mocks.backupMode = mode === 'backup-host';
    if (mode === 'second-instance') mocks.requestSingleInstanceLock.mockReturnValueOnce(false);
    await import('../../src/main');
    await settleStartup();
    expect(mocks.whenReady).not.toHaveBeenCalled();
    expect(mocks.startApplication).not.toHaveBeenCalled();
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(mocks.appRelaunch).not.toHaveBeenCalled();
    expect(mocks.backupHost).toHaveBeenCalledTimes(mode === 'backup-host' ? 1 : 0);
  });

  it.each(['when-ready', 'before-raw-call'] as const)('offers Quit only for unconfirmed failure at %s', async stage => {
    const decision = held<{ response: number; checkboxChecked: boolean }>();
    mocks.showMessageBox.mockReturnValue(decision.promise);
    if (stage === 'when-ready') mocks.whenReady.mockRejectedValueOnce(new Error('/private/ready-secret'));
    else mocks.createFileLogSink.mockImplementationOnce(() => { throw new Error('/private/log-secret'); });
    await import('../../src/main');
    await settleStartup();
    expect(mocks.startApplication).not.toHaveBeenCalled();
    expect(mocks.appQuit).not.toHaveBeenCalled();
    expect(mocks.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ buttons: ['Quit'], defaultId: 0, cancelId: 0, noLink: true }));
    expect(JSON.stringify(mocks.showMessageBox.mock.calls)).not.toMatch(/private|ready-secret|log-secret/);
    decision.resolve({ response: 1, checkboxChecked: false });
    await settleStartup();
    expect(mocks.appRelaunch).not.toHaveBeenCalled();
    expect(mocks.appQuit).toHaveBeenCalledTimes(1);
  });

  it('does not begin raw startup when readiness resolves after an intentional before-quit', async () => {
    mocks.startApplication.mockResolvedValue(returningApplication(vi.fn(async () => undefined)));
    await import('../../src/main');
    const beforeQuit = mocks.appOn.mock.calls.find(([event]) => event === 'before-quit')![1] as (event: { preventDefault(): void }) => void;
    beforeQuit({ preventDefault: vi.fn() });
    await settleStartup();
    expect(mocks.startApplication).not.toHaveBeenCalled();
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(mocks.appRelaunch).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)('joins cleanup of a raw application fulfilled after intentional abort until it will %s', async outcome => {
    const raw = held<RunningApplication>();
    const cleanup = held<void>();
    const shutdown = vi.fn(() => cleanup.promise);
    mocks.startApplication.mockReturnValue(raw.promise);
    await import('../../src/main');
    await settleStartup();
    const beforeQuit = mocks.appOn.mock.calls.find(([event]) => event === 'before-quit')![1] as (event: { preventDefault(): void }) => void;
    beforeQuit({ preventDefault: vi.fn() });
    beforeQuit({ preventDefault: vi.fn() });
    raw.resolve(returningApplication(shutdown));
    await settleStartup();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(mocks.appQuit).not.toHaveBeenCalled();
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    if (outcome === 'resolve') cleanup.resolve(undefined); else cleanup.reject(new Error('late owned cleanup failed'));
    await settleStartup();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(mocks.appQuit).toHaveBeenCalledTimes(1);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(mocks.appRelaunch).not.toHaveBeenCalled();
  });

  it('reserves owned shutdown before a disposer reenters before-quit during dock failure', async () => {
    const cleanup = held<void>();
    const shutdown = vi.fn(() => { beforeQuit({ preventDefault: vi.fn() }); return cleanup.promise; });
    mocks.startApplication.mockResolvedValue(returningApplication(shutdown));
    throwingDock();
    await import('../../src/main');
    const beforeQuit = mocks.appOn.mock.calls.find(([event]) => event === 'before-quit')![1] as (event: { preventDefault(): void }) => void;
    await settleStartup();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(mocks.appQuit).not.toHaveBeenCalled();
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    cleanup.resolve(undefined);
    await settleStartup();
    expect(mocks.appQuit).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(mocks.appRelaunch).not.toHaveBeenCalled();
  });

  it('treats a synchronous owned shutdown throw as unconfirmed and never retries cleanup', async () => {
    const shutdown = vi.fn((): Promise<void> => { throw new Error('ordinary synchronous cleanup failure'); });
    mocks.startApplication.mockResolvedValue(returningApplication(shutdown));
    throwingDock();
    await import('../../src/main');
    await settleStartup();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(mocks.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ buttons: ['Quit'] }));
    expect(mocks.appQuit).toHaveBeenCalledTimes(1);
    expect(mocks.appRelaunch).not.toHaveBeenCalled();
  });

  it('safely quits on dialog rejection after confirmed raw cleanup without restarting or exposing errors', async () => {
    mocks.startApplication.mockRejectedValue(new Error('/private/startup-secret'));
    mocks.showMessageBox.mockRejectedValue(new Error('/private/dialog-secret'));
    await import('../../src/main');
    await settleStartup();
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.showMessageBox.mock.calls)).not.toMatch(/private|startup-secret|dialog-secret/);
    expect(mocks.appQuit).toHaveBeenCalledTimes(1);
    expect(mocks.appRelaunch).not.toHaveBeenCalled();
    expect(mocks.startApplication).toHaveBeenCalledTimes(1);
  });

  it('still quits once when explicitly permitted relaunch throws', async () => {
    mocks.startApplication.mockRejectedValue(new Error('raw failed after confirmed cleanup'));
    mocks.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false });
    mocks.appRelaunch.mockImplementation(() => { throw new Error('relaunch unavailable'); });
    await import('../../src/main');
    await settleStartup();
    expect(mocks.appRelaunch).toHaveBeenCalledTimes(1);
    expect(mocks.appQuit).toHaveBeenCalledTimes(1);
    const beforeQuit = mocks.appOn.mock.calls.find(([event]) => event === 'before-quit')![1] as (event: { preventDefault(): void }) => void;
    beforeQuit({ preventDefault: vi.fn() });
    await settleStartup();
    expect(mocks.appQuit).toHaveBeenCalledTimes(1);
    expect(mocks.appRelaunch).toHaveBeenCalledTimes(1);
  });

  it('keeps initialization failure windowless and waits for the explicit default Quit decision', async () => {
    const decision = held<{ response: number; checkboxChecked: boolean }>();
    mocks.showMessageBox.mockReturnValue(decision.promise);
    mocks.startApplication.mockRejectedValue(new Error('database unavailable'));

    await import('../../src/main');
    await settleStartup();

    expect(mocks.createWindow).not.toHaveBeenCalled();
    expect(mocks.appQuit).not.toHaveBeenCalled();
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    expect(mocks.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      buttons: ['Quit', 'Restart Callie'], defaultId: 0, cancelId: 0,
    }));
    decision.resolve({ response: 0, checkboxChecked: false });
    await settleStartup();
    expect(mocks.appQuit).toHaveBeenCalledTimes(1);
    expect(mocks.appRelaunch).not.toHaveBeenCalled();
    expect(mocks.createWindow).not.toHaveBeenCalled();
  });

  it.each(['confirmed', 'unconfirmed'] as const)('awaits owned cleanup after a successful startup and throwing dock: %s', async (outcome) => {
    const cleanup = held<void>();
    const decision = held<{ response: number; checkboxChecked: boolean }>();
    const shutdown = vi.fn(() => cleanup.promise);
    mocks.startApplication.mockResolvedValue(returningApplication(shutdown));
    mocks.showMessageBox.mockReturnValue(decision.promise);
    throwingDock();

    await import('../../src/main');
    await settleStartup();

    expect(mocks.dockSetBadge).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(mocks.appQuit).not.toHaveBeenCalled();
    expect(mocks.appRelaunch).not.toHaveBeenCalled();

    if (outcome === 'confirmed') cleanup.resolve(undefined);
    else cleanup.reject(new Error('ordinary cleanup rejection /private/key-secret'));
    await settleStartup();

    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    expect(mocks.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      buttons: outcome === 'confirmed' ? ['Quit', 'Restart Callie'] : ['Quit'],
      defaultId: 0,
      cancelId: 0,
    }));
    expect(JSON.stringify(mocks.showMessageBox.mock.calls)).not.toMatch(/private|startup-secret|key-secret/);
    expect(mocks.appQuit).not.toHaveBeenCalled();
    expect(mocks.appRelaunch).not.toHaveBeenCalled();

    // A disallowed response1 must still map to Quit when cleanup is unconfirmed.
    decision.resolve({ response: 1, checkboxChecked: false });
    await settleStartup();
    expect(mocks.appRelaunch).toHaveBeenCalledTimes(outcome === 'confirmed' ? 1 : 0);
    expect(mocks.appQuit).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
    if (outcome === 'confirmed') {
      expect(mocks.appRelaunch.mock.invocationCallOrder[0]).toBeLessThan(mocks.appQuit.mock.invocationCallOrder[0]);
    }
  });

  it.each(['resolve', 'reject'] as const)('before-quit joins detached dock-failure cleanup directly when it will %s', async (outcome) => {
    const cleanup = held<void>();
    const shutdown = vi.fn(() => cleanup.promise);
    mocks.startApplication.mockResolvedValue(returningApplication(shutdown));
    throwingDock();
    await import('../../src/main');
    await settleStartup();
    expect(mocks.dockSetBadge).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);

    const beforeQuit = mocks.appOn.mock.calls.find(([event]) => event === 'before-quit')![1] as
      (event: { preventDefault(): void }) => void;
    const preventDefault = vi.fn();
    beforeQuit({ preventDefault });
    beforeQuit({ preventDefault });
    await settleStartup();
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(mocks.appQuit).not.toHaveBeenCalled();
    expect(mocks.appRelaunch).not.toHaveBeenCalled();

    if (outcome === 'resolve') cleanup.resolve(undefined);
    else cleanup.reject(new Error('ordinary owned shutdown failure'));
    await settleStartup();
    expect(mocks.appQuit).toHaveBeenCalledTimes(1);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(mocks.appRelaunch).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledTimes(1);
    beforeQuit({ preventDefault });
    await settleStartup();
    expect(mocks.appQuit).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it.each(['restart', 'reject'] as const)('quits without awaiting an open dialog and ignores its late %s', async (late) => {
    const decision = held<{ response: number; checkboxChecked: boolean }>();
    mocks.showMessageBox.mockReturnValue(decision.promise);
    mocks.startApplication.mockRejectedValue(new Error('raw startup failed after cleanup'));
    await import('../../src/main');
    await settleStartup();
    expect(mocks.appQuit).not.toHaveBeenCalled();
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);

    const beforeQuit = mocks.appOn.mock.calls.find(([event]) => event === 'before-quit')![1] as
      (event: { preventDefault(): void }) => void;
    beforeQuit({ preventDefault: vi.fn() });
    await settleStartup();
    // The held decision is deliberately unresolved here.
    expect(mocks.appQuit).toHaveBeenCalledTimes(1);
    expect(mocks.appRelaunch).not.toHaveBeenCalled();

    if (late === 'restart') decision.resolve({ response: 1, checkboxChecked: false });
    else decision.reject(new Error('native dialog failed late'));
    await settleStartup();
    expect(mocks.appQuit).toHaveBeenCalledTimes(1);
    expect(mocks.appRelaunch).not.toHaveBeenCalled();
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('offers only Quit for an AggregateError from the exact raw startup boundary', async () => {
    const decision = held<{ response: number; checkboxChecked: boolean }>();
    mocks.showMessageBox.mockReturnValue(decision.promise);
    mocks.startApplication.mockRejectedValue(new AggregateError([new Error('private cleanup failure')], 'raw cleanup unconfirmed'));
    await import('../../src/main');
    await settleStartup();
    expect(mocks.appQuit).not.toHaveBeenCalled();
    expect(mocks.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      buttons: ['Quit'], defaultId: 0, cancelId: 0,
    }));
    decision.resolve({ response: 1, checkboxChecked: false });
    await settleStartup();
    expect(mocks.appQuit).toHaveBeenCalledTimes(1);
    expect(mocks.appRelaunch).not.toHaveBeenCalled();
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

  it('destroys and cleans a partial renderer window before the explicit default Quit decision', async () => {
    const decision = held<{ response: number; checkboxChecked: boolean }>();
    const events: string[] = [];
    let eventsAtDialog: string[] | undefined;
    let destroyCallsAtDialog: number | undefined;
    mocks.showMessageBox.mockImplementation(() => {
      eventsAtDialog = [...events];
      destroyCallsAtDialog = mocks.windowDestroy.mock.calls.length;
      return decision.promise;
    });
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
    expect(mocks.appQuit).not.toHaveBeenCalled();
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    expect(eventsAtDialog).toEqual(['open', 'migrate', 'recover', 'health', 'ipc', 'unregister', 'close']);
    expect(destroyCallsAtDialog).toBe(1);
    expect(mocks.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      buttons: ['Quit', 'Restart Callie'], defaultId: 0, cancelId: 0,
    }));
    decision.resolve({ response: 0, checkboxChecked: false });
    await settleStartup();
    expect(mocks.appQuit).toHaveBeenCalledTimes(1);
    expect(mocks.appRelaunch).not.toHaveBeenCalled();
    expect(mocks.windowDestroy).toHaveBeenCalledTimes(1);
  });
});
