import { join } from 'node:path';
import { app, BrowserWindow, clipboard, ipcMain, Menu, shell } from 'electron';
import { z } from 'zod';
import { uuid } from '@fss/contracts';
import { createApiClient, fetchSend } from './apiClient.ts';
import { createAuthedClient } from './authedClient.ts';
import { createDialHandoff } from './dialHandoff.ts';
import { createDialApi, createTelLaunchDriver } from './telHandoff.ts';
import {
  openSecondaryWindow,
  registerCrmBridge,
  registerReplyBridge,
  registerSequenceBridge,
  registerTodayBridge,
  type OpenOptions,
} from './todayWindow.ts';
import { windowMenuTemplate } from './windowMenu.ts';
import { registerAdminBridge } from './settingsWindow.ts';
import { createDeviceStore } from './deviceStore.ts';
import { createKeychainVault } from './keychain.ts';
import { createOfflineCache } from './offlineCache.ts';
import { createSessionManager, type SessionManager } from './sessionManager.ts';
import { IPC_CHANNELS } from './ipc.ts';
import { windowTargetOf, type WindowTarget } from '../shared/contract.ts';
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
 * five bridge channels (and the Mailbox row's three), and send external links to the
 * system browser. Since lane g65 that window's signed-in content is Home: the Today
 * lanes, a status sidebar, the last seven days' figures and what needs the person, and
 * its fifth channel opens the other windows by name. Every rule
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

/**
 * What opens each window: the Window menu's items and Home's sidebar call the same ones.
 * `today` brings the main window forward; the rest are `WINDOW_TARGETS`.
 */
export type WindowOpeners = Readonly<Record<WindowTarget | 'today', () => void>>;

export function registerBridge(manager: SessionManager, open: WindowOpeners): void {
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
  // Lane g65. The page names a window and nothing else: a name outside WINDOW_TARGETS
  // opens nothing, and the answer is the current state either way, as for every
  // other channel here.
  ipcMain.handle(IPC_CHANNELS.openWindow, async (_event, raw: unknown) => {
    const target = windowTargetOf(raw);
    if (target !== null) open[target]();
    return await manager.state();
  });
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

/** The main window, so ⌘1 can bring it forward, or open it again once it was closed. */
let homeWindow: BrowserWindow | null = null;

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
  homeWindow = window;
  if (configuration.rendererUrl === undefined) await window.loadFile(configuration.rendererEntry);
  else await window.loadURL(configuration.rendererUrl);
  return window;
}

/** ⌘1: Home to the front, or a new main window when the last one was closed. */
function showHome(configuration: DesktopConfiguration): void {
  const existing = homeWindow;
  if (existing !== null && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return;
  }
  void openWindow(configuration);
}

/**
 * Register the Today, reply, CRM, sequence, administration and mailbox bridges, put
 * their windows on the menu, and return what opens each one.
 *
 * This is the wiring G3b's renderer waited for: `firmWorkspace.ts` reads
 * `globalThis.callieCrm`, the preload script installs it, and these handlers answer it.
 * The Today bridge was G6's window's; since lane g65 the main window's Home calls it.
 *
 * Each window is reachable from the application menu and, since lane g65, from Home's
 * sidebar, which asks for it by name through `registerBridge`'s `openWindow` channel.
 * Both call the openers returned here, so the two ways in cannot disagree.
 */
export function registerWindows(configuration: DesktopConfiguration, manager: SessionManager): WindowOpeners {
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
  // G8's editor. The clipboard and the browser open are ports so the bridge itself
  // imports nothing from Electron and is testable without a window (11.3).
  registerSequenceBridge({
    api,
    session,
    copyToClipboard: text => {
      clipboard.writeText(text);
    },
    openExternally: async url => {
      await shell.openExternal(url);
    },
  });
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

  const renderer = (name: string): { readonly pageFile: string; readonly pageUrl?: string; readonly preloadEntry: string } => ({
    preloadEntry: configuration.preloadEntry,
    pageFile: join(configuration.rendererEntry, '..', name),
    ...(configuration.rendererUrl === undefined
      ? {}
      : { pageUrl: new URL(name, configuration.rendererUrl).toString() }),
  });

  let replyWindow: BrowserWindow | null = null;
  let crmWindow: BrowserWindow | null = null;
  let sequenceWindow: BrowserWindow | null = null;
  let adminWindow: BrowserWindow | null = null;
  const openAdministration = (options: OpenOptions): void => {
    void openSecondaryWindow('Callie — Administration', renderer('settings.html'), adminWindow, options).then(window => {
      adminWindow = window;
    });
  };
  const open: WindowOpeners = {
    today: () => {
      showHome(configuration);
    },
    replies: () => {
      void openSecondaryWindow('Callie — Replies', renderer('replyCard.html'), replyWindow).then(window => {
        replyWindow = window;
      });
    },
    firms: () => {
      void openSecondaryWindow('Callie — CRM', renderer('firmWorkspace.html'), crmWindow).then(window => {
        crmWindow = window;
      });
    },
    sequences: () => {
      void openSecondaryWindow('Callie — Sequences', renderer('sequenceEditor.html'), sequenceWindow).then(
        window => {
          sequenceWindow = window;
        },
      );
    },
    // ⌘5 opens Administration on Settings, and only brings it forward when it is
    // already open, so nothing typed into it is lost. ⌘6 is the same window on its
    // Dashboard screen, and loads it again when it is open, exactly as pressing the
    // Dashboard tab would redraw it.
    administration: () => {
      openAdministration({ query: { screen: 'settings' } });
    },
    dashboard: () => {
      openAdministration({ query: { screen: 'dashboard' }, reloadExisting: true });
    },
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(Menu.getApplicationMenu()?.items.map(item => item as unknown as Electron.MenuItemConstructorOptions) ?? []),
      ...(windowMenuTemplate(open) as unknown as Electron.MenuItemConstructorOptions[]),
    ]),
  );
  return open;
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
  const windows = registerWindows(configuration, manager);
  registerBridge(manager, windows);
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
