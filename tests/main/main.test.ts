import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appOn: vi.fn(),
  appQuit: vi.fn(),
  browserWindows: vi.fn(() => []),
  createWindow: vi.fn(),
  loadUrl: vi.fn(),
  protocolSchemes: vi.fn(),
  registerProtocol: vi.fn(),
  startApplication: vi.fn(),
  whenReady: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/Users/founder/Library/Application Support/Callie'),
    getVersion: vi.fn(() => '4.5.6'),
    on: mocks.appOn,
    quit: mocks.appQuit,
    whenReady: mocks.whenReady,
  },
  BrowserWindow: { getAllWindows: mocks.browserWindows },
  protocol: { registerSchemesAsPrivileged: mocks.protocolSchemes },
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
      loadURL: mocks.loadUrl,
      webContents: {
        on: vi.fn(),
        setWindowOpenHandler: vi.fn(),
      },
    });
  });

  async function settleStartup(): Promise<void> {
    resolveReady?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('starts composition only after readiness and supplies the app-owned path and version', async () => {
    const shutdown = vi.fn();
    mocks.startApplication.mockImplementation(async (options) => {
      options.createWindow();
      return {
        databasePath: '/Users/founder/Library/Application Support/Callie/callie.sqlite3',
        interruptedJobsRecovered: 0,
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
      createWindow: expect.any(Function),
    });
    expect(mocks.registerProtocol).toHaveBeenCalledTimes(1);
    expect(mocks.createWindow).toHaveBeenCalledTimes(1);
    expect(
      mocks.registerProtocol.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.createWindow.mock.invocationCallOrder[0] as number);

    const beforeQuit = mocks.appOn.mock.calls.find(
      ([event]) => event === 'before-quit',
    )?.[1] as (() => void) | undefined;
    expect(beforeQuit).toBeTypeOf('function');
    beforeQuit?.();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('quits without creating an unmanaged window when initialization fails', async () => {
    mocks.startApplication.mockRejectedValue(new Error('database unavailable'));

    await import('../../src/main');
    await settleStartup();

    expect(mocks.createWindow).not.toHaveBeenCalled();
    expect(mocks.appQuit).toHaveBeenCalledTimes(1);
  });
});
