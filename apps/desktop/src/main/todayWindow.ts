import { ipcMain } from 'electron';
import { DIAL_IPC_CHANNELS, IMPORT_IPC_CHANNELS } from '../shared/operations.ts';
import { createCrmBridge, type CrmBridgeDeps, type CrmBridgeHost } from './crmBridge.ts';
import { createBriefImport, type BriefImportHost } from './briefImport.ts';
import { guardIdentity } from './identityReset.ts';
import type { FileChoice } from './importHandoff.ts';
import { createImportHandoff, type ImportHandoff } from './importHandoff.ts';
import { createMailboxBridge, type MailboxBridgeDeps, type MailboxBridgeHost } from './mailboxBridge.ts';
import { registerOperations } from './operationHost.ts';
import { createTodayBridge, type TodayBridgeDeps, type TodayBridgeHost } from './todayBridge.ts';
import { createReplyBridge, type ReplyBridgeDeps, type ReplyBridgeHost } from './replyBridge.ts';
import { createResearchBridge, type ResearchBridgeDeps, type ResearchBridgeHost } from './researchBridge.ts';
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
  readonly research: ResearchBridgeHost;
  readonly crm: CrmBridgeHost;
  readonly sequences: SequenceBridgeHost;
  readonly settings: AdminBridgeHost;
  readonly mailbox: MailboxBridgeHost;
  readonly briefImport: BriefImportHost;
}

export interface WindowBridgeDeps {
  readonly today: TodayBridgeDeps;
  readonly replies: ReplyBridgeDeps;
  readonly research: ResearchBridgeDeps;
  readonly crm: CrmBridgeDeps;
  readonly sequences: SequenceBridgeDeps;
  readonly settings: AdminBridgeDeps;
  readonly mailbox: MailboxBridgeDeps;
  /** macOS's open panel, for the one thing the registry does not carry. */
  readonly chooseImportFile: ImportHandoff['choose'];
  /** Lane PB: macOS's open panel for a prepared-brief JSON file. Absent in tests that never import one. */
  readonly openBriefDialog?: () => Promise<FileChoice>;
  /** Reading the chosen brief file; the default is `node:fs`. */
  readonly readBriefFile?: (path: string) => Promise<string>;
  /**
   * The session's transition counter (1.0.13, P0-A).
   *
   * Every bridge method notes it on the way in; an answer that arrives under a
   * different number belongs to a person who has left this Mac, and it is thrown away
   * rather than stored. Absent in the tests that build bridges without a session.
   */
  readonly sessionGeneration?: () => number;
}

/**
 * Build the seven bridges and register the four channels.
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
  const generation = deps.sessionGeneration ?? (() => 0);
  const guard = <H extends { forget(): Promise<unknown> }>(host: H): H => guardIdentity(host, generation);
  const today = guard(createTodayBridge(deps.today));
  const replies = guard(createReplyBridge(deps.replies));
  const research = guard(createResearchBridge(deps.research));
  const crm = guard(createCrmBridge(deps.crm));
  const sequences = guard(createSequenceBridge(deps.sequences));
  const settings = guard(createAdminBridge(deps.settings));
  const mailbox = guard(createMailboxBridge(deps.mailbox));
  const briefImport = guard(
    createBriefImport({
      api: deps.today.api,
      sessionGeneration: generation,
      openDialog: deps.openBriefDialog ?? (async () => await Promise.resolve({ canceled: true, filePaths: [] })),
      ...(deps.readBriefFile === undefined ? {} : { read: deps.readBriefFile }),
    }),
  );
  registerOperations({ api: deps.today.api, today, replies, research, crm, sequences, settings, mailbox, briefImport }, handleOnce);

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

  // Lane PB: a prepared-brief file, chosen and previewed here; the window is given the preview.
  handleOnce(IMPORT_IPC_CHANNELS.chooseBriefs, async () => await briefImport.choose());

  return { today, replies, research, crm, sequences, settings, mailbox, briefImport };
}

export { createImportHandoff };
