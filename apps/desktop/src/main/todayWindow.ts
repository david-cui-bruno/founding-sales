import { ipcMain } from 'electron';
import { DIAL_IPC_CHANNELS, IMPORT_IPC_CHANNELS } from '../shared/operations.ts';
import { createCrmBridge, type CrmBridgeDeps, type CrmBridgeHost } from './crmBridge.ts';
import { createImportHandoff, type ImportHandoff } from './importHandoff.ts';
import { createMailboxBridge, type MailboxBridgeDeps, type MailboxBridgeHost } from './mailboxBridge.ts';
import { registerOperations } from './operationHost.ts';
import { createTodayBridge, type TodayBridgeDeps, type TodayBridgeHost } from './todayBridge.ts';
import { createReplyBridge, type ReplyBridgeDeps, type ReplyBridgeHost } from './replyBridge.ts';
import { createSequenceBridge, type SequenceBridgeDeps, type SequenceBridgeHost } from './sequenceBridge.ts';
import { createAdminBridge, type AdminBridgeDeps, type AdminBridgeHost } from './settingsBridge.ts';

/**
 * Every channel the one window can reach (specification 8.2, 8.3, 11.1, 14.2).
 *
 * There are four: `callie:op:read` and `callie:op:command`, which carry D4's whole
 * registry, and the two handoffs beside them — dialling, which opens a `tel:` URI on the
 * operating system, and choosing a CSV, which opens macOS's file panel. Until 1.0.13
 * there were fifty-odd named channels, each a method in the preload, a name here, and a
 * handler that cast its argument and hoped; the casting is the registry's input schemas
 * now, and the six bridges below are what the operations are answered from.
 *
 * Registration is idempotent: `ipcMain.handle` throws on a second registration of the
 * same channel, and the tests register against fresh `ipcMain` fakes.
 */

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

export interface WindowBridges {
  readonly today: TodayBridgeHost;
  readonly replies: ReplyBridgeHost;
  readonly crm: CrmBridgeHost;
  readonly sequences: SequenceBridgeHost;
  readonly settings: AdminBridgeHost;
  readonly mailbox: MailboxBridgeHost;
}

export interface WindowBridgeDeps {
  readonly today: TodayBridgeDeps;
  readonly replies: ReplyBridgeDeps;
  readonly crm: CrmBridgeDeps;
  readonly sequences: SequenceBridgeDeps;
  readonly settings: AdminBridgeDeps;
  readonly mailbox: MailboxBridgeDeps;
  /** macOS's open panel, for the one thing the registry does not carry. */
  readonly chooseImportFile: ImportHandoff['choose'];
}

/**
 * Build the six bridges and register the four channels.
 *
 * The transformations did not move when the channels went: `createTodayBridge` is still
 * where the stale expansion and the refusal eviction live, `createCrmBridge` where the
 * board's fallback lives, and `operationHost.ts` says which operation reaches which.
 *
 * Dialling and choosing a file keep channels of their own: each does something to the
 * operating system rather than answering a question, and `api.command(op, input)` is not
 * where that belongs.
 */
export function registerWindowBridges(deps: WindowBridgeDeps): WindowBridges {
  const today = createTodayBridge(deps.today);
  const replies = createReplyBridge(deps.replies);
  const crm = createCrmBridge(deps.crm);
  const sequences = createSequenceBridge(deps.sequences);
  const settings = createAdminBridge(deps.settings);
  const mailbox = createMailboxBridge(deps.mailbox);
  registerOperations({ api: deps.today.api, today, replies, crm, sequences, settings, mailbox }, handleOnce);

  handleOnce(DIAL_IPC_CHANNELS.call, async argument => {
    // The renderer's word is never taken for a shape: a malformed request is the current
    // state back, not an argument passed on to the API.
    const input = argument as { firmId?: unknown; routeId?: unknown; contactId?: unknown } | null;
    if (typeof input?.firmId !== 'string' || typeof input.routeId !== 'string') return await today.state();
    return await today.dial({
      firmId: input.firmId,
      contactId: typeof input.contactId === 'string' ? input.contactId : null,
      routeId: input.routeId,
    });
  });

  handleOnce(IMPORT_IPC_CHANNELS.choose, async () => {
    // It takes nothing: the window asks for a file and macOS asks the person which. The
    // text is read here and previewed here, and the window is given what the server said.
    const file = await deps.chooseImportFile();
    return file === null ? await crm.state() : await crm.previewImport(file);
  });

  return { today, replies, crm, sequences, settings, mailbox };
}

export { createImportHandoff };
