import { ipcMain } from 'electron';
import { ADMIN_IPC_CHANNELS, createAdminBridge, type AdminBridgeDeps, type AdminBridgeHost } from './settingsBridge.ts';

/**
 * The administration window's channels.
 *
 * Its own file rather than a third block in `todayWindow.ts`, and its own
 * registration set, so opening and closing this window cannot interfere with the
 * Today window's handlers. Registration is idempotent for the reason G6 recorded:
 * `ipcMain.handle` throws on a second registration of the same channel, and a person
 * who closes a window and opens it again must not take the application down.
 *
 * Every handler validates the renderer's argument before it goes anywhere. A
 * malformed request returns the current state, never an argument passed through to
 * the API — the renderer's word is never taken for a shape.
 */

const registered = new Set<string>();

function handleOnce(channel: string, handler: (argument: unknown) => Promise<unknown>): void {
  if (registered.has(channel)) return;
  registered.add(channel);
  ipcMain.handle(channel, async (_event, argument: unknown) => await handler(argument));
}

/** Only for tests: forget what has been registered, so a fresh `ipcMain` can be used. */
export function resetAdminWindowRegistrations(): void {
  registered.clear();
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

export function registerAdminBridge(deps: AdminBridgeDeps): AdminBridgeHost {
  const host = createAdminBridge(deps);

  handleOnce(ADMIN_IPC_CHANNELS.state, async () => await host.state());

  handleOnce(ADMIN_IPC_CHANNELS.show, async argument => {
    const screen = (argument as { screen?: unknown } | null)?.screen;
    return screen === 'settings' || screen === 'dashboard' || screen === 'diagnostics'
      ? await host.show({ screen })
      : await host.state();
  });

  handleOnce(ADMIN_IPC_CHANNELS.saveSetting, async argument => {
    const input = argument as { settingKey?: unknown; value?: unknown; changeNote?: unknown } | null;
    const settingKey = text(input?.settingKey);
    const changeNote = text(input?.changeNote);
    if (settingKey === null || changeNote === null) return await host.state();
    // The key is not checked against `SETTING_KEYS` here: the server chooses the
    // validator from it and refuses an unknown one, and a second copy of that list
    // in the main process is a second thing to keep equal.
    return await host.saveSetting({
      settingKey: settingKey as Parameters<AdminBridgeHost['saveSetting']>[0]['settingKey'],
      value: input?.value,
      changeNote,
    });
  });

  handleOnce(ADMIN_IPC_CHANNELS.openHistory, async argument => {
    const settingKey = text((argument as { settingKey?: unknown } | null)?.settingKey);
    return settingKey === null
      ? await host.state()
      : await host.openHistory({
          settingKey: settingKey as Parameters<AdminBridgeHost['openHistory']>[0]['settingKey'],
        });
  });

  handleOnce(ADMIN_IPC_CHANNELS.loadDashboard, async argument => {
    const input = argument as { from?: unknown; to?: unknown } | null;
    const from = text(input?.from);
    const to = text(input?.to);
    return from === null || to === null ? await host.state() : await host.loadDashboard({ from, to });
  });

  handleOnce(ADMIN_IPC_CHANNELS.createStage, async argument => {
    const input = argument as { key?: unknown; displayName?: unknown } | null;
    const key = text(input?.key);
    const displayName = text(input?.displayName);
    return key === null || displayName === null ? await host.state() : await host.createStage({ key, displayName });
  });

  handleOnce(ADMIN_IPC_CHANNELS.renameStage, async argument => {
    const input = argument as { stageKey?: unknown; displayName?: unknown } | null;
    const stageKey = text(input?.stageKey);
    const displayName = text(input?.displayName);
    return stageKey === null || displayName === null
      ? await host.state()
      : await host.renameStage({ stageKey, displayName });
  });

  handleOnce(ADMIN_IPC_CHANNELS.reorderStages, async argument => {
    const keys = (argument as { stageKeys?: unknown } | null)?.stageKeys;
    return Array.isArray(keys) && keys.every(key => typeof key === 'string')
      ? await host.reorderStages({ stageKeys: keys })
      : await host.state();
  });

  handleOnce(ADMIN_IPC_CHANNELS.retireStage, async argument => {
    const stageKey = text((argument as { stageKey?: unknown } | null)?.stageKey);
    return stageKey === null ? await host.state() : await host.retireStage({ stageKey });
  });

  handleOnce(ADMIN_IPC_CHANNELS.acknowledgeAlert, async argument => {
    const alertId = text((argument as { alertId?: unknown } | null)?.alertId);
    return alertId === null ? await host.state() : await host.acknowledgeAlert({ alertId });
  });

  return host;
}
