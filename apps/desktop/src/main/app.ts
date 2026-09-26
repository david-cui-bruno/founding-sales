import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import { z } from 'zod';
import { uuid } from '@fss/contracts';
import { createApiClient, fetchSend } from './apiClient.ts';
import { createAuthedClient } from './authedClient.ts';
import { createDialHandoff } from './dialHandoff.ts';
import { createDialApi, createTelLaunchDriver } from './telHandoff.ts';
import { registerCrmBridge, registerReplyBridge, registerSequenceBridge, registerTodayBridge } from './todayWindow.ts';
import { windowMenuTemplate } from './windowMenu.ts';
import { registerAdminBridge } from './settingsWindow.ts';
import { createDeviceStore } from './deviceStore.ts';
import { createKeychainVault } from './keychain.ts';
import { createOfflineCache } from './offlineCache.ts';
import { createSessionManager, type SessionManager } from './sessionManager.ts';
import { IPC_CHANNELS } from './ipc.ts';
import type { RouteName } from '../shared/contract.ts';
import {
  MAILBOX_IPC_CHANNELS,
  createMailboxBridge,
  type MailboxBridgeDeps,
  type MailboxBridgeHost,
} from './mailboxBridge.ts';

/**
 * The Electron main process.
 *
 * It does four things and no more: build the session manager from real adapters,
 * open one window with context isolation on and node integration off, answer the
 * bridges, and send external links to the system browser. Since wave 1 that one window
 * is the whole app: a sidebar and one view at a time, and the Window menu and deep links
 * tell it which view with `callie:navigate` rather than opening a window. Every rule
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

/**
 * The Mailbox row on this window's "This Mac" card (release.md 8.0x).
 *
 * Its three channels take no argument, so there is nothing of the renderer's to
 * validate: whatever it sent is ignored rather than passed on. The consent URL is
 * opened by `shell.openExternal` inside the bridge and never returned across it.
 */
export function registerMailboxBridge(deps: MailboxBridgeDeps): MailboxBridgeHost {
  const host = createMailboxBridge(deps);
  ipcMain.handle(MAILBOX_IPC_CHANNELS.state, async () => await host.state());
  ipcMain.handle(MAILBOX_IPC_CHANNELS.refresh, async () => await host.refresh());
  ipcMain.handle(MAILBOX_IPC_CHANNELS.connect, async () => await host.connect());
  return host;
}

/** The one window, whether its page has loaded, and a route asked for before it had. */
let mainWindow: BrowserWindow | null = null;
let windowLoaded = false;
let pendingRoute: RouteName | null = null;

/**
 * Bring the window forward on `route`: the Window menu's ⌘1–⌘6 and every deep link.
 *
 * A link that launched the app arrives before the window exists (`open-url` fires
 * before `ready`), and until wave 1 it was dropped. It is kept here now and sent once
 * the page has loaded and is listening; a later one replaces an earlier one.
 */
export function showRoute(route: RouteName): void {
  const window = mainWindow;
  if (window === null || window.isDestroyed() || !windowLoaded) {
    pendingRoute = route;
    return;
  }
  if (window.isMinimized()) window.restore();
  window.focus();
  window.webContents.send(IPC_CHANNELS.navigate, route);
}

export async function openWindow(configuration: DesktopConfiguration): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 760,
    minHeight: 480,
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
  mainWindow = window;
  windowLoaded = false;
  if (configuration.rendererUrl === undefined) await window.loadFile(configuration.rendererEntry);
  else await window.loadURL(configuration.rendererUrl);
  // The page's script has run by now (a module script runs before the load finishes),
  // so its `callie:navigate` listener is there to hear a route kept for it.
  windowLoaded = true;
  const queued = pendingRoute;
  pendingRoute = null;
  if (queued !== null) showRoute(queued);
  return window;
}

/**
 * Register the Today, reply, CRM, sequence, administration and mailbox bridges, and put
 * the six views on the Window menu.
 *
 * Every view is in the one window, and every bridge answers it: `firmWorkspace.ts` reads
 * `globalThis.callieCrm`, the preload script installs it, and these handlers answer it.
 * Only the window plumbing changed in wave 1; the bridges and their channels did not.
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
    // G4's handoff logic, bound to macOS through `telHandoff.ts`: the launch-services
    // probe for the setup proof and `shell.openExternal` for the open, with every
    // scheme but `tel:` unreachable from that module. There is no Swift helper (2).
    handoff: createDialHandoff({ driver: createTelLaunchDriver(), api: createDialApi(api) }),
    session,
  });
  // 8.3's reply cards. The same `AuthedClient` and the same session manager: the
  // reply state is never cached, so it needs nothing from the offline cache but the
  // token, the online flag and the version gate.
  registerReplyBridge({ api, session });
  registerCrmBridge({ api, session, clientVersion: configuration.clientVersion });
  // G8's editor.
  registerSequenceBridge({ api, session });
  // Lane G9: Settings, the dashboard and Diagnostics, in one window of three screens.
  registerAdminBridge({ api, session });
  // The Mailbox row on G2's own window: the same token and the same version gate, and
  // the consent screen in the system browser exactly as sign-in opens it (5.1).
  registerMailboxBridge({
    api,
    session,
    openExternally: async url => {
      await shell.openExternal(url);
    },
  });

  Menu.setApplicationMenu(
    Menu.buildFromTemplate(windowMenuTemplate(showRoute) as unknown as Electron.MenuItemConstructorOptions[]),
  );
}

/**
 * The entry point. Kept tiny so that everything above it is testable without Electron.
 *
 * It answers the session manager so the updater can ask whether the API has raised the
 * minimum above this build (lane g83): the one fact that decides whether a staged update
 * waits for Restart or installs at once.
 */
export async function start(configuration: DesktopConfiguration): Promise<SessionManager> {
  await app.whenReady();
  const manager = buildSessionManager(configuration);
  registerWindows(configuration, manager);
  registerBridge(manager);
  await openWindow(configuration);
  app.on('window-all-closed', () => {
    app.quit();
  });
  return manager;
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
