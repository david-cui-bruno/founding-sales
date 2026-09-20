import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import { z } from 'zod';
import { uuid } from '@fss/contracts';
import { createApiClient, fetchSend } from './apiClient.ts';
import { createAuthedClient } from './authedClient.ts';
import { unavailableDialHandoff } from './dialHandoff.ts';
import {
  openSecondaryWindow,
  registerCrmBridge,
  registerTodayBridge,
  windowMenuTemplate,
} from './todayWindow.ts';
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
  /**
   * Where the window loads the interface from, when it is not a plain file.
   *
   * A packaged build serves its own bundle over a privileged custom scheme rather
   * than over `file://`, because the `GrantFileProtocolExtraPrivileges` fuse is
   * burned off and Chromium's plain file loader cannot read inside an asar. See
   * `docs/decisions/g13-bundle-scheme.md`; the development path still loads the
   * file directly.
   */
  readonly rendererUrl?: string;
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
  if (configuration.rendererUrl === undefined) await window.loadFile(configuration.rendererEntry);
  else await window.loadURL(configuration.rendererUrl);
  return window;
}

/**
 * Register the Today and CRM bridges and put their windows on the menu.
 *
 * This is the wiring G3b's renderer has been waiting for: `firmWorkspace.ts` reads
 * `globalThis.callieCrm`, the preload script installs it, and nothing until now
 * answered the channels behind it. The Today window is the third, on the same
 * pattern.
 *
 * The windows are reachable from the application menu rather than from a button on
 * G2's page, because this lane does not own `renderer.ts` — and because on macOS the
 * menu is where a window that is not the front one is found anyway.
 */
export function registerWindows(configuration: DesktopConfiguration, manager: SessionManager): void {
  const api = createAuthedClient({
    baseUrl: configuration.apiBaseUrl,
    clientVersion: configuration.clientVersion,
    send: fetchSend,
    accessToken: async () => await manager.accessToken(),
  });
  const session = { state: async () => await manager.state(), refreshToday: async () => await manager.refreshToday() };

  registerTodayBridge({
    api,
    // The `tel:` handoff needs an OS binding this build does not have yet: the
    // launch-services probe is a read (`launchServices.ts`) and the opener is not
    // written. Until it is, the window shows its Call buttons refused with
    // `no_tel_handler` rather than pretending. See docs/greenfield/today.md.
    handoff: unavailableDialHandoff(),
    session,
  });
  registerCrmBridge({ api, session });

  const renderer = (name: string): { readonly pageFile: string; readonly pageUrl?: string; readonly preloadEntry: string } => ({
    preloadEntry: configuration.preloadEntry,
    pageFile: join(configuration.rendererEntry, '..', name),
    ...(configuration.rendererUrl === undefined
      ? {}
      : { pageUrl: new URL(name, configuration.rendererUrl).toString() }),
  });

  let todayWindow: BrowserWindow | null = null;
  let crmWindow: BrowserWindow | null = null;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(Menu.getApplicationMenu()?.items.map(item => item as unknown as Electron.MenuItemConstructorOptions) ?? []),
      ...(windowMenuTemplate({
        today: () => {
          void openSecondaryWindow('Callie — Today', renderer('today.html'), todayWindow).then(window => {
            todayWindow = window;
          });
        },
        firms: () => {
          void openSecondaryWindow('Callie — CRM', renderer('firmWorkspace.html'), crmWindow).then(window => {
            crmWindow = window;
          });
        },
      }) as unknown as Electron.MenuItemConstructorOptions[]),
    ]),
  );
}

/** The entry point. Kept tiny so that everything above it is testable without Electron. */
export async function start(configuration: DesktopConfiguration): Promise<void> {
  await app.whenReady();
  const manager = buildSessionManager(configuration);
  registerBridge(manager);
  registerWindows(configuration, manager);
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
