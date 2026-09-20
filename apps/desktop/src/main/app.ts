import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { z } from 'zod';
import { uuid } from '@fss/contracts';
import { createApiClient, fetchSend } from './apiClient.ts';
import { createDeviceStore } from './deviceStore.ts';
import { createKeychainVault } from './keychain.ts';
import { createOfflineCache } from './offlineCache.ts';
import { createSessionManager, type SessionManager } from './sessionManager.ts';
import { IPC_CHANNELS } from './ipc.ts';

/**
 * The Electron main process.
 *
 * It does four things and no more: build the session manager from real adapters,
 * open one window with context isolation on and node integration off, answer the
 * four bridge channels, and send external links to the system browser. Every rule
 * about sessions, caches and versions lives in `sessionManager.ts`, which knows
 * nothing about Electron and is therefore tested without it.
 *
 * `shell.openExternal` is how "the system browser" (specification 5.1) is real: the
 * authorization URL is opened by macOS in the person's own browser, where the address
 * bar shows Google's domain. The app never renders a Google page itself.
 */

export interface DesktopConfiguration {
  readonly apiBaseUrl: string;
  readonly clientVersion: string;
  readonly keychainService: string;
  readonly userDataDirectory: string;
  readonly rendererEntry: string;
  readonly preloadEntry: string;
}

const signInInputSchema = z.strictObject({
  workspaceId: uuid,
  deviceLabel: z.string().trim().min(1).max(120),
});

export function buildSessionManager(configuration: DesktopConfiguration): SessionManager {
  const vault = createKeychainVault({ service: configuration.keychainService });
  return createSessionManager({
    api: createApiClient({
      baseUrl: configuration.apiBaseUrl,
      clientVersion: configuration.clientVersion,
      send: fetchSend,
    }),
    store: createDeviceStore({ directory: configuration.userDataDirectory, vault }),
    cache: createOfflineCache({
      directory: configuration.userDataDirectory,
      vault,
      now: () => new Date(),
    }),
    clientVersion: configuration.clientVersion,
    now: () => new Date(),
    openInBrowser: async url => {
      await shell.openExternal(url);
    },
  });
}

export function registerBridge(manager: SessionManager): void {
  ipcMain.handle(IPC_CHANNELS.state, async () => await manager.state());
  ipcMain.handle(IPC_CHANNELS.signIn, async (_event, raw: unknown) => {
    // The renderer's word is never taken for a shape: a malformed request is a
    // refusal, not an argument passed on to the API.
    const parsed = signInInputSchema.safeParse(raw);
    if (!parsed.success) return await manager.state();
    return await manager.signIn(parsed.data);
  });
  ipcMain.handle(IPC_CHANNELS.signOut, async () => await manager.signOut());
  ipcMain.handle(IPC_CHANNELS.refreshToday, async () => await manager.refreshToday());
}

export async function openWindow(configuration: DesktopConfiguration): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'Callie',
    webPreferences: {
      preload: configuration.preloadEntry,
      // The renderer gets no Node, no remote module and its own context. The bridge
      // in `preload.ts` is the entire surface it can reach.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  // Any link the renderer tries to open goes to the system browser, never to a
  // second Electron window where a person cannot see where they are.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  await window.loadFile(configuration.rendererEntry);
  return window;
}

/** The entry point. Kept tiny so that everything above it is testable without Electron. */
export async function start(configuration: DesktopConfiguration): Promise<void> {
  await app.whenReady();
  registerBridge(buildSessionManager(configuration));
  await openWindow(configuration);
  app.on('window-all-closed', () => {
    app.quit();
  });
}

export function defaultConfiguration(apiBaseUrl: string, clientVersion: string): DesktopConfiguration {
  const directory = join(app.getPath('userData'), 'callie');
  return {
    apiBaseUrl,
    clientVersion,
    keychainService: 'com.callie.fss.desktop',
    userDataDirectory: directory,
    rendererEntry: join(import.meta.dirname, '..', 'renderer', 'index.html'),
    preloadEntry: join(import.meta.dirname, '..', 'preload', 'preload.js'),
  };
}
