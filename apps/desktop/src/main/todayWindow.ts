import { BrowserWindow, ipcMain, shell } from 'electron';
import { CRM_IPC_CHANNELS, createCrmBridge, type CrmBridgeDeps, type CrmBridgeHost } from './crmBridge.ts';
import { TODAY_IPC_CHANNELS, createTodayBridge, type TodayBridgeDeps, type TodayBridgeHost } from './todayBridge.ts';
import { REPLY_IPC_CHANNELS, createReplyBridge, type ReplyBridgeDeps, type ReplyBridgeHost } from './replyBridge.ts';
import {
  SEQUENCE_IPC_CHANNELS,
  createSequenceBridge,
  type SequenceBridgeDeps,
  type SequenceBridgeHost,
} from './sequenceBridge.ts';

/**
 * The windows beside the main one, and the channels that feed them
 * (specification 8.2, 8.3, 11.1, 14.2).
 *
 * G2 opened one window; G3b wrote a second renderer and a contract for its bridge and
 * stopped there; G6 added a Today window and wired both; G7b added the reply cards, G8
 * the sequence editor and G9 Administration. Lane g65 folded Today back into the main
 * window as its Home (`docs/decisions/g65-today-is-the-home.md`): the list a person
 * leaves open all day is the first thing the app shows, and ⌘1 brings that window
 * forward. `registerTodayBridge` stays here because Home is what calls it now. The
 * other four — Replies, Firms, Sequences, Administration — are opened, used and
 * closed, which is the choice G3b's own note records.
 *
 * Every window is built the same way as G2's: context isolation on, node integration
 * off, sandboxed, no `webview`, and every link out to the system browser. The only
 * thing a renderer can reach is the bridge the preload script installed, and the only
 * thing a bridge can reach is this file's `host`.
 *
 * Registration is idempotent. `ipcMain.handle` throws on a second registration of the
 * same channel, and a person who closes a window and opens it again must not take the
 * app down.
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
  // Only `quiet: true` is taken from the renderer; anything else is the plain Refresh.
  handleOnce(TODAY_IPC_CHANNELS.refresh, async argument =>
    await host.refresh({ quiet: (argument as { quiet?: unknown } | null)?.quiet === true }),
  );
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
  // Lane g79: set a time on "Callback — needs a time", and Resume a paused send.
  handleOnce(TODAY_IPC_CHANNELS.scheduleCallback, async argument => {
    const input = argument as { callLogId?: unknown; localDate?: unknown; localTime?: unknown } | null;
    if (typeof input?.callLogId !== 'string' || typeof input.localDate !== 'string' || typeof input.localTime !== 'string') {
      return await host.state();
    }
    return await host.scheduleCallback({ callLogId: input.callLogId, localDate: input.localDate, localTime: input.localTime });
  });
  handleOnce(TODAY_IPC_CHANNELS.releasePause, async argument => {
    const holdId = (argument as { holdId?: unknown } | null)?.holdId;
    return typeof holdId === 'string' ? await host.releasePause({ holdId }) : await host.state();
  });
  return host;
}

/**
 * The reply cards (8.3, 12.4).
 *
 * Five channels, and the argument checking is the same as everywhere else in this
 * file: the renderer's word is never taken for a shape, and a malformed request is
 * the current state back rather than an argument passed on to the API.
 *
 * `confirm` is the consequential one, so it is checked field by field rather than
 * cast. A confirmation with no disposition is not a confirmation, and a callback the
 * renderer sent as something other than the three strings the contract names would be
 * an instant somebody has to guess at — which is the one thing 12.4 will not have.
 */
export function registerReplyBridge(deps: ReplyBridgeDeps): ReplyBridgeHost {
  const host = createReplyBridge(deps);
  handleOnce(REPLY_IPC_CHANNELS.state, async () => await host.state());
  handleOnce(REPLY_IPC_CHANNELS.refresh, async () => await host.refresh());
  handleOnce(REPLY_IPC_CHANNELS.open, async argument => {
    const messageId = (argument as { messageId?: unknown } | null)?.messageId;
    return typeof messageId === 'string' ? await host.open({ messageId }) : await host.state();
  });
  handleOnce(REPLY_IPC_CHANNELS.collapse, async () => await host.collapse());
  handleOnce(REPLY_IPC_CHANNELS.confirm, async argument => {
    const input = argument as Record<string, unknown> | null;
    if (input === null || typeof input['messageId'] !== 'string' || typeof input['disposition'] !== 'string') {
      return await host.state();
    }
    const raw = input['callback'] as Record<string, unknown> | null | undefined;
    const callback =
      raw === null || raw === undefined
        ? null
        : typeof raw['localDate'] === 'string' &&
            typeof raw['localTime'] === 'string' &&
            typeof raw['sourceTimeZone'] === 'string'
          ? { localDate: raw['localDate'], localTime: raw['localTime'], sourceTimeZone: raw['sourceTimeZone'] }
          : undefined;
    if (callback === undefined) return await host.state();
    return await host.confirm({
      messageId: input['messageId'],
      disposition: input['disposition'] as Parameters<ReplyBridgeHost['confirm']>[0]['disposition'],
      callback,
      firmWideOptOut: input['firmWideOptOut'] === true,
      note: typeof input['note'] === 'string' ? input['note'] : '',
    });
  });
  // Lane g88: two ids, and the bridge checks the opportunity is one of the open card's.
  handleOnce(REPLY_IPC_CHANNELS.resolve, async argument => {
    const input = argument as { messageId?: unknown; opportunityId?: unknown } | null;
    if (typeof input?.messageId !== 'string' || typeof input.opportunityId !== 'string') return await host.state();
    return await host.resolve({ messageId: input.messageId, opportunityId: input.opportunityId });
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
  // Lane g84: Add firm and Import. The form's seven fields are strings or the call is
  // refused here; a file is text and a name, and its size is the bridge's to judge.
  handleOnce(CRM_IPC_CHANNELS.openAddFirm, async () => await host.openAddFirm());
  handleOnce(CRM_IPC_CHANNELS.addFirm, async argument => {
    const input = argument as Record<string, unknown> | null;
    const fields = ['name', 'website', 'timeZone', 'contactName', 'contactTitle', 'contactEmail', 'contactPhone'] as const;
    if (input === null || fields.some(field => typeof input[field] !== 'string')) return await host.state();
    const text = (field: (typeof fields)[number]): string => input[field] as string;
    return await host.addFirm({
      name: text('name'),
      website: text('website'),
      timeZone: text('timeZone'),
      contactName: text('contactName'),
      contactTitle: text('contactTitle'),
      contactEmail: text('contactEmail'),
      contactPhone: text('contactPhone'),
    });
  });
  handleOnce(CRM_IPC_CHANNELS.openImport, async () => await host.openImport());
  handleOnce(CRM_IPC_CHANNELS.previewImport, async argument => {
    const input = argument as { csv?: unknown; fileName?: unknown } | null;
    if (typeof input?.csv !== 'string' || typeof input.fileName !== 'string') return await host.state();
    return await host.previewImport({ csv: input.csv, fileName: input.fileName });
  });
  handleOnce(CRM_IPC_CHANNELS.commitImport, async () => await host.commitImport());
  // Lane g88: the firm and its opportunity are the open page's, so enrolment takes a
  // version and a contact, and a confirmation a route id and the version on screen.
  handleOnce(CRM_IPC_CHANNELS.openOpportunity, async () => await host.openOpportunity());
  handleOnce(CRM_IPC_CHANNELS.enroll, async argument => {
    const input = argument as { sequenceVersionId?: unknown; contactId?: unknown } | null;
    if (typeof input?.sequenceVersionId !== 'string' || typeof input.contactId !== 'string') return await host.state();
    return await host.enroll({ sequenceVersionId: input.sequenceVersionId, contactId: input.contactId });
  });
  handleOnce(CRM_IPC_CHANNELS.confirmRoute, async argument => {
    const input = argument as { routeId?: unknown; routeVersion?: unknown } | null;
    if (typeof input?.routeId !== 'string' || typeof input.routeVersion !== 'number') return await host.state();
    return await host.confirmRoute({ routeId: input.routeId, routeVersion: input.routeVersion });
  });
  return host;
}

/**
 * Lane G8's sequence editor (11.1, 11.3, 4.3).
 *
 * The same shape as the two above: a renderer's word is never taken for a shape, and
 * a malformed request is the current state back rather than an argument passed on to
 * the API.
 */
export function registerSequenceBridge(deps: SequenceBridgeDeps): SequenceBridgeHost {
  const host = createSequenceBridge(deps);
  const withString = (
    channel: string,
    field: string,
    call: (value: string) => Promise<unknown>,
  ): void => {
    handleOnce(channel, async argument => {
      const value = (argument as Record<string, unknown> | null)?.[field];
      return typeof value === 'string' ? await call(value) : await host.state();
    });
  };

  handleOnce(SEQUENCE_IPC_CHANNELS.state, async () => await host.state());
  withString(SEQUENCE_IPC_CHANNELS.openSequence, 'sequenceId', async sequenceId =>
    await host.openSequence({ sequenceId }),
  );
  withString(SEQUENCE_IPC_CHANNELS.createSequence, 'name', async name =>
    await host.createSequence({ name }),
  );
  withString(SEQUENCE_IPC_CHANNELS.publish, 'sequenceVersionId', async sequenceVersionId =>
    await host.publish({ sequenceVersionId }),
  );
  withString(SEQUENCE_IPC_CHANNELS.retire, 'sequenceVersionId', async sequenceVersionId =>
    await host.retire({ sequenceVersionId }),
  );
  withString(SEQUENCE_IPC_CHANNELS.approveTemplate, 'templateVersionId', async templateVersionId =>
    await host.approveTemplate({ templateVersionId }),
  );
  withString(SEQUENCE_IPC_CHANNELS.completeLinkedIn, 'stepExecutionId', async stepExecutionId =>
    await host.completeLinkedIn({ stepExecutionId }),
  );
  withString(SEQUENCE_IPC_CHANNELS.undoLinkedIn, 'stepExecutionId', async stepExecutionId =>
    await host.undoLinkedIn({ stepExecutionId }),
  );
  withString(SEQUENCE_IPC_CHANNELS.resumeEnrollment, 'enrollmentId', async enrollmentId =>
    await host.resumeEnrollment({ enrollmentId }),
  );
  // Lane g88: authoring and the resume review. The steps are passed to the bridge as they
  // came, and parsed there against the draft step schema; a template draft is five
  // strings (the template id may be null) or the call is the current state back.
  withString(SEQUENCE_IPC_CHANNELS.createDraft, 'sequenceId', async sequenceId => await host.createDraft({ sequenceId }));
  withString(SEQUENCE_IPC_CHANNELS.reviewEnrollment, 'enrollmentId', async enrollmentId =>
    await host.reviewEnrollment({ enrollmentId }),
  );
  handleOnce(SEQUENCE_IPC_CHANNELS.closeReview, async () => await host.closeReview());
  handleOnce(SEQUENCE_IPC_CHANNELS.saveDraft, async argument => {
    const input = argument as Record<string, unknown> | null;
    if (input === null || typeof input['sequenceVersionId'] !== 'string' || !Array.isArray(input['steps'])) {
      return await host.state();
    }
    return await host.saveDraft({ sequenceVersionId: input['sequenceVersionId'], steps: input['steps'] });
  });
  handleOnce(SEQUENCE_IPC_CHANNELS.createTemplate, async argument => {
    const input = argument as Record<string, unknown> | null;
    const fields = ['name', 'subject', 'body', 'signOff'] as const;
    const templateId = input?.['templateId'];
    if (input === null || fields.some(field => typeof input[field] !== 'string') || !(templateId === null || typeof templateId === 'string')) {
      return await host.state();
    }
    return await host.createTemplate({
      templateId,
      name: input['name'] as string,
      subject: input['subject'] as string,
      body: input['body'] as string,
      signOff: input['signOff'] as string,
    });
  });
  handleOnce(SEQUENCE_IPC_CHANNELS.enroll, async argument => {
    const input = argument as Record<string, unknown> | null;
    if (
      input === null ||
      typeof input['sequenceVersionId'] !== 'string' ||
      typeof input['opportunityId'] !== 'string' ||
      typeof input['firmId'] !== 'string' ||
      typeof input['contactId'] !== 'string'
    ) {
      return await host.state();
    }
    return await host.enroll(input as unknown as Parameters<SequenceBridgeHost['enroll']>[0]);
  });
  handleOnce(SEQUENCE_IPC_CHANNELS.recordLinkedInResult, async argument => {
    const input = argument as Record<string, unknown> | null;
    const result = input?.['result'];
    if (
      input === null ||
      typeof input['enrollmentId'] !== 'string' ||
      (result !== 'replied' && result !== 'no_engagement')
    ) {
      return await host.state();
    }
    return await host.recordLinkedInResult({ enrollmentId: input['enrollmentId'], result });
  });
  return host;
}

/**
 * How a window is opened: with a query on its address, and whether a window that is
 * already open is loaded again with it rather than only brought forward.
 *
 * Only Administration uses either (lane g65). `?screen=dashboard` is how ⌘6 opens it
 * on the Dashboard screen; `settingsPage.ts` reads it once, when the page loads. A
 * query rather than a fragment, because a changed query is a new document everywhere
 * — the bundle scheme matches the path alone, so it serves the same page — and the
 * page's one entry point is the only reader it needs.
 */
export interface OpenOptions {
  readonly query?: Readonly<Record<string, string>>;
  readonly reloadExisting?: boolean;
}

async function load(window: BrowserWindow, deps: WindowDeps, query: Readonly<Record<string, string>> | undefined): Promise<void> {
  if (deps.pageUrl === undefined) {
    await window.loadFile(deps.pageFile, query === undefined ? undefined : { query: { ...query } });
    return;
  }
  const url = new URL(deps.pageUrl);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  await window.loadURL(url.toString());
}

/** One window, built exactly as G2 builds its own. Focused rather than duplicated. */
export async function openSecondaryWindow(
  title: string,
  deps: WindowDeps,
  existing: BrowserWindow | null,
  options: OpenOptions = {},
): Promise<BrowserWindow> {
  if (existing !== null && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    if (options.reloadExisting === true) await load(existing, deps, options.query);
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
  await load(window, deps, options.query);
  return window;
}
