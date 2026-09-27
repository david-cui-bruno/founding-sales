import { ipcMain } from 'electron';
import { DIAL_IPC_CHANNELS } from '../shared/operations.ts';
import { CRM_IPC_CHANNELS, createCrmBridge, type CrmBridgeDeps, type CrmBridgeHost } from './crmBridge.ts';
import { registerOperations } from './operationHost.ts';
import { createTodayBridge, type TodayBridgeDeps, type TodayBridgeHost } from './todayBridge.ts';
import { createReplyBridge, type ReplyBridgeDeps, type ReplyBridgeHost } from './replyBridge.ts';
import {
  SEQUENCE_IPC_CHANNELS,
  createSequenceBridge,
  type SequenceBridgeDeps,
  type SequenceBridgeHost,
} from './sequenceBridge.ts';

/**
 * The channels behind the Today, Replies, Firms and Sequences views
 * (specification 8.2, 8.3, 11.1, 14.2).
 *
 * Each of these once fed a window of its own; since wave 1 they all feed views of the one
 * window, and nothing here opens a window any more. The only thing a renderer can reach
 * is the bridge the preload script installed, and the only thing a bridge can reach is
 * this file's `host`.
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

/**
 * Today, Replies and the two Diagnostics recovery controls, behind the operation
 * registry (D4).
 *
 * Nine hand-written channels for Today and six for Replies became two — `api.read` and
 * `api.command` — and the per-channel argument checking that stood here became the
 * registry's input schemas. The transformations did not move: `createTodayBridge` and
 * `createReplyBridge` are still where the stale expansion, the refusal eviction and the
 * wall-clock callback live, and `operationHost.ts` says which operation reaches which.
 *
 * Dialling keeps a channel of its own: it opens a URI on the operating system rather than
 * answering with one, and `api.command(op, input)` is not where that belongs.
 */
export function registerOperationBridges(deps: {
  readonly today: TodayBridgeDeps;
  readonly replies: ReplyBridgeDeps;
}): { readonly today: TodayBridgeHost; readonly replies: ReplyBridgeHost } {
  const today = createTodayBridge(deps.today);
  const replies = createReplyBridge(deps.replies);
  registerOperations({ api: deps.today.api, today, replies }, handleOnce);
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
  return { today, replies };
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
  // Lane g90: "Check again" on an address, at the version on screen.
  handleOnce(CRM_IPC_CHANNELS.checkRoute, async argument => {
    const input = argument as { routeId?: unknown; routeVersion?: unknown } | null;
    if (typeof input?.routeId !== 'string' || typeof input.routeVersion !== 'number') return await host.state();
    return await host.checkRoute({ routeId: input.routeId, routeVersion: input.routeVersion });
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
  return host;
}
