import { BrowserWindow, ipcMain, shell } from 'electron';
import { CRM_IPC_CHANNELS, createCrmBridge, type CrmBridgeDeps, type CrmBridgeHost } from './crmBridge.ts';
import { TODAY_IPC_CHANNELS, createTodayBridge, type TodayBridgeDeps, type TodayBridgeHost } from './todayBridge.ts';

/**
 * The two windows beside G2's, and the channels that feed them
 * (specification 8.2, 14.2).
 *
 * G2 opened one window; G3b wrote a second renderer and a contract for its bridge and
 * stopped there; this lane adds the third and wires both. They are separate windows
 * rather than screens inside one, which is the choice G3b's own note records: the
 * Today window is the one a person leaves open all day and has to stay small and
 * fast, and the CRM windows are opened, used and closed.
 *
 * Every window is built the same way as G2's: context isolation on, node integration
 * off, sandboxed, no `webview`, and every link out to the system browser. The only
 * thing a renderer can reach is the bridge the preload script installed, and the only
 * thing a bridge can reach is this file's `host`.
 *
 * Registration is idempotent. `ipcMain.handle` throws on a second registration of the
 * same channel, and a person who closes the Today window and opens it again must not
 * take the app down.
 */

export interface WindowDeps {
  readonly preloadEntry: string;
  /** Where the renderer is loaded from: a bundle URL in a package, a file in dev. */
  readonly pageUrl?: string | undefined;
  readonly pageFile: string;
}

const registered = new Set<string>();

function handleOnce(channel: string, handler: (argument: unknown) => Promise<unknown>): void {
  if (registered.has(channel)) return;
  registered.add(channel);
  ipcMain.handle(channel, async (_event, argument: unknown) => await handler(argument));
}

/** Only for tests: forget what has been registered, so a fresh `ipcMain` can be used. */
export function resetWindowRegistrations(): void {
  registered.clear();
}

export function registerTodayBridge(deps: TodayBridgeDeps): TodayBridgeHost {
  const host = createTodayBridge(deps);
  handleOnce(TODAY_IPC_CHANNELS.state, async () => await host.state());
  handleOnce(TODAY_IPC_CHANNELS.refresh, async () => await host.refresh());
  handleOnce(TODAY_IPC_CHANNELS.expand, async argument => {
    // The renderer's word is never taken for a shape: a malformed request is the
    // current state back, not an argument passed on to the API.
    const firmId = (argument as { firmId?: unknown } | null)?.firmId;
    return typeof firmId === 'string' ? await host.expand({ firmId }) : await host.state();
  });
  handleOnce(TODAY_IPC_CHANNELS.collapse, async () => await host.collapse());
  handleOnce(TODAY_IPC_CHANNELS.snooze, async argument => {
    const input = argument as { itemId?: unknown; reason?: unknown; returnAt?: unknown } | null;
    if (typeof input?.itemId !== 'string' || typeof input.reason !== 'string' || typeof input.returnAt !== 'string') {
      return await host.state();
    }
    return await host.snooze({ itemId: input.itemId, reason: input.reason, returnAt: input.returnAt });
  });
  handleOnce(TODAY_IPC_CHANNELS.dial, async argument => {
    const input = argument as { firmId?: unknown; routeId?: unknown; routeVersion?: unknown; contactId?: unknown } | null;
    if (typeof input?.firmId !== 'string' || typeof input.routeId !== 'string' || typeof input.routeVersion !== 'number') {
      return await host.state();
    }
    return await host.dial({
      firmId: input.firmId,
      contactId: typeof input.contactId === 'string' ? input.contactId : null,
      routeId: input.routeId,
      routeVersion: input.routeVersion,
    });
  });
  handleOnce(TODAY_IPC_CHANNELS.recordOutcome, async argument => {
    const input = argument as Record<string, unknown> | null;
    if (input === null || typeof input['firmId'] !== 'string' || typeof input['outcome'] !== 'string') {
      return await host.state();
    }
    return await host.recordOutcome(input as unknown as Parameters<TodayBridgeHost['recordOutcome']>[0]);
  });
  return host;
}

export function registerCrmBridge(deps: CrmBridgeDeps): CrmBridgeHost {
  const host = createCrmBridge(deps);
  handleOnce(CRM_IPC_CHANNELS.state, async () => await host.state());
  handleOnce(CRM_IPC_CHANNELS.openPipeline, async () => await host.openPipeline());
  handleOnce(CRM_IPC_CHANNELS.openFirm, async argument => {
    const firmId = (argument as { firmId?: unknown } | null)?.firmId;
    return typeof firmId === 'string' ? await host.openFirm({ firmId }) : await host.state();
  });
  handleOnce(CRM_IPC_CHANNELS.saveContact, async argument => {
    const input = argument as Record<string, unknown> | null;
    if (input === null || typeof input['contactId'] !== 'string' || typeof input['fullName'] !== 'string') {
      return await host.state();
    }
    return await host.saveContact(input as unknown as Parameters<CrmBridgeHost['saveContact']>[0]);
  });
  handleOnce(CRM_IPC_CHANNELS.changeStage, async argument => {
    const input = argument as Record<string, unknown> | null;
    if (input === null || typeof input['opportunityId'] !== 'string' || typeof input['toStageKey'] !== 'string') {
      return await host.state();
    }
    return await host.changeStage(input as unknown as Parameters<CrmBridgeHost['changeStage']>[0]);
  });
  handleOnce(CRM_IPC_CHANNELS.resolveMerge, async argument => {
    const input = argument as Record<string, unknown> | null;
    if (input === null || typeof input['sourceFirmId'] !== 'string' || typeof input['targetFirmId'] !== 'string') {
      return await host.state();
    }
    return await host.resolveMerge(input as unknown as Parameters<CrmBridgeHost['resolveMerge']>[0]);
  });
  return host;
}

/** One window, built exactly as G2 builds its own. Focused rather than duplicated. */
export async function openSecondaryWindow(
  title: string,
  deps: WindowDeps,
  existing: BrowserWindow | null,
): Promise<BrowserWindow> {
  if (existing !== null && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return existing;
  }
  const window = new BrowserWindow({
    width: 1100,
    height: 820,
    title,
    webPreferences: {
      preload: deps.preloadEntry,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  if (deps.pageUrl === undefined) await window.loadFile(deps.pageFile);
  else await window.loadURL(deps.pageUrl);
  return window;
}

/**
 * The application menu items that open them.
 *
 * A menu rather than a button on G2's page: this lane does not own `renderer.ts`, and
 * a menu is the macOS way to reach a window that is not the front one anyway. The
 * template is a value so it can be asserted without Electron.
 */
export function windowMenuTemplate(open: {
  readonly today: () => void;
  readonly firms: () => void;
}): readonly { readonly label: string; readonly submenu: readonly { readonly label: string; readonly accelerator: string; readonly click: () => void }[] }[] {
  return [
    {
      label: 'Window',
      submenu: [
        { label: 'Today', accelerator: 'CmdOrCtrl+1', click: open.today },
        { label: 'Firms', accelerator: 'CmdOrCtrl+2', click: open.firms },
      ],
    },
  ];
}
