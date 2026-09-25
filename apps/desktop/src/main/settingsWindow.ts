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

/** A cap bound from the renderer: an integer, an explicit null, or nothing at all. */
function bound(input: Record<string, unknown> | null, key: string): number | null | undefined {
  const value = input?.[key];
  if (value === null) return null;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  return undefined;
}

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

  handleOnce(ADMIN_IPC_CHANNELS.setSendingCap, async argument => {
    const input = argument as Record<string, unknown> | null;
    const mailboxId = text(input?.['mailboxId']);
    if (mailboxId === null) return await host.state();
    // Absent and null are carried through unchanged: `setAdminCap` reads null as
    // "clear the lowering" and absence as "leave it alone", and collapsing the two
    // here would make a control that cannot undo itself. The bounds are the
    // server's; nothing is clamped on the way.
    const lowerTo = bound(input, 'lowerTo');
    const raiseTo = bound(input, 'raiseTo');
    return await host.setSendingCap({
      mailboxId,
      ...(lowerTo === undefined ? {} : { lowerTo }),
      ...(raiseTo === undefined ? {} : { raiseTo }),
    });
  });

  handleOnce(ADMIN_IPC_CHANNELS.recordSendingAuthentication, async argument => {
    const input = argument as Record<string, unknown> | null;
    const domain = text(input?.['domain']);
    const flags = ['spfPass', 'dkimPass', 'dmarcPass', 'postmasterReviewed', 'automatedSendingEnabled'];
    if (domain === null || flags.some(flag => typeof input?.[flag] !== 'boolean')) {
      return await host.state();
    }
    return await host.recordSendingAuthentication({
      domain,
      spfPass: input?.['spfPass'] === true,
      dkimPass: input?.['dkimPass'] === true,
      dmarcPass: input?.['dmarcPass'] === true,
      postmasterReviewed: input?.['postmasterReviewed'] === true,
      automatedSendingEnabled: input?.['automatedSendingEnabled'] === true,
    });
  });

  handleOnce(ADMIN_IPC_CHANNELS.recordHolidayCalendar, async argument => {
    const input = argument as { version?: unknown; dates?: unknown } | null;
    const version = text(input?.version);
    const dates = input?.dates;
    // Shape only. Which dates are valid, and whether the version is already taken,
    // are the server's to say: a client that pre-judged them would be a second
    // implementation of a rule that has to have exactly one.
    if (version === null || !Array.isArray(dates) || !dates.every(date => typeof date === 'string')) {
      return await host.state();
    }
    return await host.recordHolidayCalendar({ version, dates });
  });

  // Lane g60. Shape only, as everywhere in this file: whether the number is a number,
  // whose it is and whether the person may attest it are the server's answers.
  handleOnce(ADMIN_IPC_CHANNELS.addCallingNumber, async argument => {
    const input = argument as { e164?: unknown; label?: unknown; attested?: unknown } | null;
    const e164 = text(input?.e164);
    const label = input?.label;
    if (e164 === null || typeof label !== 'string' || typeof input?.attested !== 'boolean') {
      return await host.state();
    }
    return await host.addCallingNumber({ e164, label, attested: input.attested });
  });

  handleOnce(ADMIN_IPC_CHANNELS.attestCallingNumber, async argument => {
    const identityId = text((argument as { identityId?: unknown } | null)?.identityId);
    return identityId === null ? await host.state() : await host.attestCallingNumber({ identityId });
  });

  handleOnce(ADMIN_IPC_CHANNELS.retireCallingNumber, async argument => {
    const identityId = text((argument as { identityId?: unknown } | null)?.identityId);
    return identityId === null ? await host.state() : await host.retireCallingNumber({ identityId });
  });

  // Lane g84: the postures form. Shape only again: whether the statements are all of
  // them, whether the state is a state and whether the dates are dates are the server's.
  handleOnce(ADMIN_IPC_CHANNELS.recordPosture, async argument => {
    const input = argument as Record<string, unknown> | null;
    const statements = input?.['confirmedStatements'];
    if (
      input === null ||
      typeof input['state'] !== 'string' ||
      typeof input['effectiveFromDate'] !== 'string' ||
      typeof input['reviewDate'] !== 'string' ||
      typeof input['note'] !== 'string' ||
      !Array.isArray(statements) ||
      !statements.every(key => typeof key === 'string')
    ) {
      return await host.state();
    }
    return await host.recordPosture({
      state: input['state'],
      effectiveFromDate: input['effectiveFromDate'],
      reviewDate: input['reviewDate'],
      confirmedStatements: statements as string[],
      note: input['note'],
    });
  });

  handleOnce(ADMIN_IPC_CHANNELS.revokePosture, async argument => {
    const postureId = text((argument as { postureId?: unknown } | null)?.postureId);
    return postureId === null ? await host.state() : await host.revokePosture({ postureId });
  });

  return host;
}
