import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { z } from 'zod';
import { uuid } from '@fss/contracts';
import { createApiClient, fetchSend } from './apiClient.ts';
import { createAuthedClient } from './authedClient.ts';
import { BUNDLE_ORIGIN } from './bundleScheme.ts';
import { processCallActivity } from './callActivity.ts';
import { createDialHandoff } from './dialHandoff.ts';
import { allowPermissionCheck, allowPermissionRequest } from './mediaPermission.ts';
import { createTelLaunchDriver, isBrowserLink } from './telHandoff.ts';
import { resetBridges } from './identityReset.ts';
import { BRIEF_FILE_FILTERS } from './briefImport.ts';
import { createImportHandoff, IMPORT_FILE_FILTERS } from './importHandoff.ts';
import { registerWindowBridges } from './todayWindow.ts';
import { windowMenuTemplate } from './windowMenu.ts';
import { loadWindowChoice, rememberWindowState } from './windowStateWiring.ts';
import { createDeviceStore } from './deviceStore.ts';
import { createKeychainVault } from './keychain.ts';
import { createOfflineCache } from './offlineCache.ts';
import { createRecordingStore } from './recordings/store.ts';
import { createSessionManager, type SessionManager } from './sessionManager.ts';
import { IPC_CHANNELS } from './ipc.ts';
import type { NavigationTarget, SessionChange } from '../shared/contract.ts';

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

// Both optional (wave 1): a Mac that has signed in before remembers its workspace and
// its name, and the form sends neither.
const signInInputSchema = z.strictObject({
  workspaceId: uuid.optional(),
  deviceLabel: z.string().trim().min(1).max(120).optional(),
});

/** One Mac to sign out (wave 3b). A uuid and nothing else. */
const revokeDeviceInputSchema = z.strictObject({ deviceId: uuid });

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
  ipcMain.handle(IPC_CHANNELS.devices, async () => await manager.listDevices());
  ipcMain.handle(IPC_CHANNELS.revokeDevice, async (_event, raw: unknown) => {
    // The renderer's word is never taken for a shape, here least of all: the argument
    // names a device to end.
    const parsed = revokeDeviceInputSchema.safeParse(raw);
    if (!parsed.success) return await manager.state();
    return await manager.revokeDevice(parsed.data);
  });
}

/** The one window, whether its page has loaded, and a route asked for before it had. */
let mainWindow: BrowserWindow | null = null;
let windowLoaded = false;
let pendingRoute: NavigationTarget | null = null;

/**
 * Bring the window forward on `route`: the Window menu's ⌘1–⌘6 and every deep link.
 *
 * A link that launched the app arrives before the window exists (`open-url` fires
 * before `ready`), and until wave 1 it was dropped. It is kept here now and sent once
 * the page has loaded and is listening; a later one replaces an earlier one.
 */
export function showRoute(route: NavigationTarget): void {
  const window = mainWindow;
  if (window === null || window.isDestroyed() || !windowLoaded) {
    pendingRoute = route;
    return;
  }
  if (window.isMinimized()) window.restore();
  window.focus();
  window.webContents.send(IPC_CHANNELS.navigate, route);
}

/** Tell the page a session transition happened. Dropped if there is no page yet. */
export function sendSessionChange(change: SessionChange): void {
  const window = mainWindow;
  if (window === null || window.isDestroyed() || !windowLoaded) return;
  window.webContents.send(IPC_CHANNELS.sessionChanged, change);
}

export async function openWindow(configuration: DesktopConfiguration): Promise<BrowserWindow> {
  // Most of the screen on first launch, and wherever he left it after that (`windowState.ts`).
  const chosen = loadWindowChoice();
  const window = new BrowserWindow({
    ...chosen.bounds,
    minWidth: chosen.minimum.width,
    minHeight: chosen.minimum.height,
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
  if (chosen.maximized) window.maximize();
  if (chosen.fullScreen) window.setFullScreen(true);
  rememberWindowState(window);
  // A link the renderer asks to open goes to the system browser, never to a second
  // Electron window where a person cannot see where they are — and **only if it is a
  // web link**. Until 1.0.12 this handler passed any URL to `shell.openExternal`, so a
  // renderer that opened `tel:+1…` placed a call without `/dial/check` having said the
  // number may be called, and without the handoff recording what was dialled. Dialling
  // has one door (`dialHandoff.ts`), and this is not it.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isBrowserLink(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // The microphone, for a call placed from Callie (slice C1), asked by our own page; every
  // other permission, and anything from anywhere else, is refused (`mediaPermission.ts`).
  const ownOrigin = configuration.rendererUrl === undefined ? 'file://' : BUNDLE_ORIGIN;
  window.webContents.session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const media = details as { readonly mediaTypes?: readonly string[]; readonly requestingUrl?: string };
    callback(
      allowPermissionRequest({
        permission,
        mediaTypes: media.mediaTypes,
        requestingUrl: media.requestingUrl ?? '',
        ownOrigin,
      }),
    );
  });
  window.webContents.session.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) =>
    allowPermissionCheck({
      permission,
      mediaType: (details as { readonly mediaType?: string }).mediaType,
      requestingOrigin,
      ownOrigin,
    }),
  );
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
 * Build the six bridges behind the one window, and put the views on the Window menu.
 *
 * Every view reaches the main process through the operation registry — `api.read(op)` and
 * `api.command(op)` — with dialling and choosing a CSV beside it on their own channels.
 * Nothing here opens a window: there is one, and the menu shows a view in it.
 */
export function registerWindows(configuration: DesktopConfiguration, manager: SessionManager): void {
  const api = createAuthedClient({
    baseUrl: configuration.apiBaseUrl,
    clientVersion: configuration.clientVersion,
    send: fetchSend,
    accessToken: async () => await manager.accessToken(),
    onConnection: reachable => {
      manager.noteConnection(reachable);
    },
    // A bridge call refused as unauthenticated. A revocation wipes here exactly as one
    // on the renewal path does — for the session that made the call, and no other — and
    // the window hears about it through `onSessionChange`.
    onAuthRefusal: (reason, _status, sessionGeneration) => {
      void manager.noteAuthRefusal(reason, sessionGeneration);
    },
  });
  const session = { state: async () => await manager.state(), refreshToday: async () => await manager.refreshToday() };
  const openExternally = async (url: string): Promise<void> => {
    await shell.openExternal(url);
  };
  const importHandoff = createImportHandoff({
    openDialog: async () =>
      await dialog.showOpenDialog({
        title: 'Choose a CSV to import',
        properties: ['openFile'],
        filters: [...IMPORT_FILE_FILTERS],
      }),
  });

  const bridges = registerWindowBridges({
    today: {
      api,
      // The handoff logic, bound to macOS through `telHandoff.ts`: the launch-services
      // probe for the setup proof and `shell.openExternal` for the open, with every
      // scheme but `tel:` unreachable from that module. There is no Swift helper (2).
      handoff: createDialHandoff({ driver: createTelLaunchDriver() }),
      session,
      // A call placed from Callie is live: the updater waits for it (slice C1).
      callActivity: processCallActivity,
    },
    // The reply state is never cached, so it needs nothing from the offline cache but the
    // token, the online flag and the version gate.
    replies: { api, session },
    // The brief, the facts and the ceilings. Nothing of it is ever cached (lane R).
    research: { api, session },
    crm: { api, session, clientVersion: configuration.clientVersion },
    sequences: { api, session },
    settings: { api, session },
    // The consent screen goes to the system browser exactly as sign-in opens it (5.1).
    mailbox: { api, session, openExternally },
    chooseImportFile: importHandoff.choose,
    openBriefDialog: async () =>
      await dialog.showOpenDialog({
        title: 'Choose a prepared-brief JSON file to import',
        properties: ['openFile'],
        filters: [...BRIEF_FILE_FILTERS],
      }),
    sessionGeneration: () => manager.sessionGeneration(),
    // Lane M4: the demo recordings folder this Mac watches (a device setting, in
    // `recordings.json` beside `device.json`), and the import keyed by the signed-in person
    // (workspace and user: review M4R, finding 7).
    recordings: {
      store: createRecordingStore({ directory: configuration.userDataDirectory }),
      identity: async () => await manager.signedInIdentity(),
      defaultFolder: join(app.getPath('home'), 'Movies', 'Callie Demos'),
      openRecoveryFileDialog: async () => await dialog.showOpenDialog({ title: 'Choose the original demo audio', properties: ['openFile'], filters: [{ name: 'Zoom audio', extensions: ['m4a'] }] }),
      openFolderDialog: async purpose =>
        await dialog.showOpenDialog({
          title: purpose === 'watch' ? 'Choose the demo recordings folder' : 'Choose a recording folder to import',
          defaultPath: join(app.getPath('home'), 'Movies'),
          properties: purpose === 'watch' ? ['openDirectory', 'createDirectory'] : ['openDirectory'],
        }),
    },
  });
  // The watcher, the minute's rescan and a scan now; each scan does nothing until somebody is signed in.
  void bridges.recordings.start();

  /*
   * A session transition empties this Mac (1.0.12; every bridge since 1.0.13's review).
   *
   * The main process is where it is known — a sign-out confirmed or still owed to the
   * server, another workspace, a role the server now gives this membership, a revoked
   * device seen as an authenticated refusal — and the renderer used to find out by
   * noticing that a state it happened to read looked different.
   *
   * Three things happen the moment it is known. The session manager has already wiped
   * the encrypted Today cache and the list in memory. **Every** bridge drops its
   * snapshot here — until the review only Replies did, so the CRM bridge would answer
   * the next person's first read with the last one's firm page, and Settings with the
   * last one's numbers and figures. And the window is told, so it empties its request
   * cache and everything anybody had typed.
   */
  manager.onSessionChange(change => {
    void resetBridges([
      bridges.today,
      bridges.replies,
      bridges.crm,
      bridges.sequences,
      bridges.settings,
      bridges.mailbox,
      bridges.briefImport,
      bridges.recordings,
    ]).then(async () => {
      // Lane M4: the next person's own import, if anybody is signed in now.
      await bridges.recordings.scan();
    });
    sendSessionChange(change);
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
