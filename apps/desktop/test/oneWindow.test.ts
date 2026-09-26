import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../src/main/ipc.ts';

/**
 * The one window's main-process half (wave 1): the Window menu and deep links show a
 * route in the window rather than opening one, and a deep link that launched the app —
 * which arrives before there is a window — is kept until the page is listening.
 *
 * Electron is replaced by a recorder, as `updater.test.ts` does: importing the real
 * package outside the app would download the Electron binary.
 */

const electron = vi.hoisted(() => {
  const state = {
    sent: [] as [string, unknown][],
    focused: 0,
    windows: 0,
    finishLoad: (): void => undefined,
  };
  return state;
});

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent', whenReady: async () => undefined, on: () => undefined, quit: () => undefined },
  BrowserWindow: class {
    readonly webContents = {
      send: (channel: string, argument: unknown) => {
        electron.sent.push([channel, argument]);
      },
      setWindowOpenHandler: () => undefined,
    };
    constructor() {
      electron.windows += 1;
    }
    async loadURL(): Promise<void> {
      await new Promise<void>(resolve => {
        electron.finishLoad = resolve;
      });
    }
    async loadFile(): Promise<void> {
      await this.loadURL();
    }
    isDestroyed(): boolean {
      return false;
    }
    isMinimized(): boolean {
      return false;
    }
    restore(): void {}
    focus(): void {
      electron.focused += 1;
    }
  },
  ipcMain: { handle: () => undefined },
  Menu: { setApplicationMenu: () => undefined, buildFromTemplate: (template: unknown) => template },
  shell: { openExternal: async () => undefined },
}));

const configuration = {
  apiBaseUrl: 'https://api.callie.invalid',
  clientVersion: '1.0.11',
  keychainService: 'com.callie.fss.desktop.test',
  userDataDirectory: '/nonexistent',
  rendererEntry: '/nonexistent/index.html',
  rendererUrl: 'callie-app://bundle/index.html',
  preloadEntry: '/nonexistent/preload.cjs',
};

beforeEach(() => {
  vi.resetModules();
  electron.sent.length = 0;
  electron.focused = 0;
  electron.windows = 0;
});

describe('a route asked for before the window exists (a cold deep link)', () => {
  it('is kept, and sent once the page has loaded', async () => {
    const { openWindow, showRoute } = await import('../src/main/app.ts');
    showRoute('firms');
    expect(electron.sent).toEqual([]);

    const opened = openWindow(configuration);
    // The window exists and is still loading: the page is not listening yet.
    showRoute('dashboard');
    expect(electron.sent).toEqual([]);
    electron.finishLoad();
    await opened;

    // The last link wins, and it is sent exactly once, to the one window.
    expect(electron.sent).toEqual([[IPC_CHANNELS.navigate, 'dashboard']]);
    expect(electron.windows).toBe(1);
  });

  it('is sent at once, with the window brought forward, when the page is already listening', async () => {
    const { openWindow, showRoute } = await import('../src/main/app.ts');
    const opened = openWindow(configuration);
    electron.finishLoad();
    await opened;
    expect(electron.sent).toEqual([]);

    showRoute('replies');
    showRoute('today');
    expect(electron.sent).toEqual([
      [IPC_CHANNELS.navigate, 'replies'],
      [IPC_CHANNELS.navigate, 'today'],
    ]);
    expect(electron.focused).toBe(2);
    // Showing a view never opens a second window.
    expect(electron.windows).toBe(1);
  });
});

describe('main.ts', () => {
  it('reads a deep link through the closed set and hands it to showRoute, from before the app is ready', async () => {
    const source = await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    const focusFor = source.slice(source.indexOf('export function focusFor('));
    expect(focusFor).toContain('const route = deepLinkRoute(url);');
    expect(focusFor).toContain('showRoute(route);');
    // `open-url` is registered before `whenReady`, so a link that launched the app reaches focusFor.
    expect(source.indexOf("app.on('open-url'")).toBeGreaterThan(0);
    expect(source.indexOf("app.on('open-url'")).toBeLessThan(source.indexOf('.whenReady()'));
    expect(source).not.toContain('BrowserWindow');
  });
});
