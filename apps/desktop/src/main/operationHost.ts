import {
  applyCallProposalsResultSchema,
  callLogsResponseSchema,
  correctCallOutcomeResultSchema,
  correctionPreviewResponseSchema,
  applyKeyReasonsSchema,
  callAnalysisResponseSchema,
  callRecapResponseSchema,
  proposalAcceptanceResponseSchema,
  callTrialResponseSchema,
  reviewListResponseSchema,
  firmBasicsRefusalSchema,
  firmBasicsResultSchema,
  firmMeetingsResponseSchema,
  loggedCallResultSchema,
  meetingMatchedSchema,
  unmatchedMeetingsResponseSchema,
} from '@fss/contracts';
import type { z } from 'zod';
import {
  DIAL_IPC_CHANNELS,
  OPERATIONS,
  OPERATION_IPC_CHANNELS,
  OPERATION_NAMES,
  operationOf,
  type OperationInput,
  type OperationName,
} from '../shared/operations.ts';
import type { AuthedClient } from './authedClient.ts';
import type { BriefImportHost } from './briefImport.ts';
import type { CrmBridgeHost } from './crmBridge.ts';
import type { MailboxBridgeHost } from './mailboxBridge.ts';
import type { ReplyBridgeHost } from './replyBridge.ts';
import type { ResearchBridgeHost } from './researchBridge.ts';
import type { SequenceBridgeHost } from './sequenceBridge.ts';
import type { AdminBridgeHost } from './settingsBridge.ts';
import type { TodayBridgeHost } from './todayBridge.ts';

/**
 * The main-process half of the operation registry (D4; specification 14.2).
 *
 * Two channels answer every operation the converted views can name, and each answer goes
 * through the same three steps: look the operation up in the closed list, parse the input
 * with that operation's schema, and parse what comes back with its output schema. A
 * renderer that asked for something outside the list, or with a shape outside it, never
 * reaches a handler at all.
 *
 * The transformations are not written here. Today's stale expansion and refusal eviction
 * are `todayBridge.ts`'s, the wall-clock callback resolved against the business zone is
 * `replyBridge.ts`'s, and both keep the in-memory state a view's next read depends on.
 * What this file does is say which operation is answered by which of them, once, in a
 * table a test walks — so an operation with no handler and a handler with no operation
 * are both a failing test rather than a channel that answers `undefined`.
 *
 * **Parsing on both sides is not paranoia about our own code.** It is what makes the
 * renderer's type a guarantee rather than a hope, and it means a state that grew a field
 * it should not have — a token, a `tel:` URI, a message body on a Today card — fails at
 * the boundary instead of reaching the page.
 */

export interface OperationHostDeps {
  readonly api: AuthedClient;
  readonly today: TodayBridgeHost;
  readonly replies: ReplyBridgeHost;
  readonly research: ResearchBridgeHost;
  readonly crm: CrmBridgeHost;
  readonly sequences: SequenceBridgeHost;
  readonly settings: AdminBridgeHost;
  readonly mailbox: MailboxBridgeHost;
  /** Lane PB: the prepared-brief import the main process holds. */
  readonly briefImport: BriefImportHost;
}

type Handler = (input: never) => Promise<unknown>;

/**
 * A malformed input is the view's current state back, not an argument passed on to the
 * API — the rule every hand-written channel followed before the registry existed. The
 * diagnostics operations have no such state, so their refusal is a rejected call the
 * form shows where the answer would have been.
 */
const FALLBACK: Readonly<Record<string, OperationName>> = Object.freeze({
  today: 'today.state',
  replies: 'replies.state',
  research: 'research.state',
  crm: 'crm.state',
  sequences: 'sequences.state',
  settings: 'settings.state',
  mailbox: 'mailbox.state',
});

/**
 * The per-key reasons of a refused Apply: the 409 body's `keyReasons`, `{ [proposalKey]: code }`
 * (`applyKeyReasonsSchema`). An Apply is atomic: one refused key refuses the batch and writes
 * nothing, and each key that was refused says why. A refusal that names no key (a freshness
 * refusal) carries none, and anything that does not parse is no per-key detail.
 */
export function keyReasonsOf(refusal: unknown): Record<string, string> {
  if (typeof refusal !== 'object' || refusal === null) return {};
  const parsed = applyKeyReasonsSchema.safeParse((refusal as { keyReasons?: unknown }).keyReasons);
  return parsed.success ? parsed.data : {};
}

async function readAnalysis(api: AuthedClient, callSessionId: string): Promise<{ analysis: z.infer<typeof callAnalysisResponseSchema> | null; reason: string | null }> {
  const answer = await api.read(`/calls/analysis?callSessionId=${encodeURIComponent(callSessionId)}`, value =>
    callAnalysisResponseSchema.parse(value),
  );
  return answer.ok ? { analysis: answer.value, reason: null } : { analysis: null, reason: answer.reason.slice(0, 80) };
}

export function operationHandlers(deps: OperationHostDeps): Readonly<Record<OperationName, Handler>> {
  const handlers = {
    'today.state': async () => await deps.today.state(),
    'today.refresh': async (input: { readonly quiet?: boolean }) =>
      await deps.today.refresh({ quiet: input.quiet === true }),
    'today.expand': async (input: { readonly firmId: string }) => await deps.today.expand(input),
    'today.collapse': async () => await deps.today.collapse(),
    'today.callsPlaced': async () => await deps.today.callsPlaced(),
    'today.snooze': async (input: Parameters<TodayBridgeHost['snooze']>[0]) => await deps.today.snooze(input),
    'today.previewFollowUp': async (input: Parameters<TodayBridgeHost['previewFollowUp']>[0]) =>
      await deps.today.previewFollowUp(input),
    'today.recordOutcome': async (input: Parameters<TodayBridgeHost['recordOutcome']>[0]) =>
      await deps.today.recordOutcome(input),
    'today.recordAgreedDates': async (input: Parameters<TodayBridgeHost['recordAgreedDates']>[0]) =>
      await deps.today.recordAgreedDates(input),
    'today.scheduleCallback': async (input: Parameters<TodayBridgeHost['scheduleCallback']>[0]) =>
      await deps.today.scheduleCallback(input),
    'today.releasePause': async (input: Parameters<TodayBridgeHost['releasePause']>[0]) =>
      await deps.today.releasePause(input),

    'calling.status': async (input: { readonly firmId: string }) => await deps.today.callingStatus(input),
    'calling.start': async (input: Parameters<TodayBridgeHost['startCall']>[0]) => await deps.today.startCall(input),
    'calling.cancel': async (input: Parameters<TodayBridgeHost['cancelCall']>[0]) => await deps.today.cancelCall(input),
    'calling.setActive': async (input: { readonly active: boolean }) => await deps.today.setCallActive(input),
    'calling.resume': async (input: { readonly firmId: string }) => await deps.today.resumeCalling(input),
    'calling.history': async (input: { readonly firmId: string }) => await deps.today.callHistory(input),
    'calling.recording': async (input: { readonly sessionId: string }) => await deps.today.callRecording(input),
    'calling.transcript': async (input: { readonly callSessionId: string }) => await deps.today.callTranscript(input),

    'replies.state': async () => await deps.replies.state(),
    'replies.refresh': async () => await deps.replies.refresh(),
    'replies.open': async (input: { readonly messageId: string }) => await deps.replies.open(input),
    'replies.collapse': async () => await deps.replies.collapse(),
    'replies.forget': async () => await deps.replies.forget(),
    'replies.confirm': async (input: Parameters<ReplyBridgeHost['confirm']>[0]) => await deps.replies.confirm(input),
    'replies.resolve': async (input: Parameters<ReplyBridgeHost['resolve']>[0]) => await deps.replies.resolve(input),

    'replies.model': async () => await deps.replies.model(),
    'replies.saveModel': async (input: Parameters<ReplyBridgeHost['saveModel']>[0]) =>
      await deps.replies.saveModel(input),

    'research.state': async () => await deps.research.state(),
    'research.open': async (input: { readonly firmId: string }) => await deps.research.open(input),
    'research.run': async (input: { readonly firmId: string }) => await deps.research.run(input),
    'research.addLink': async (input: Parameters<ResearchBridgeHost['addLink']>[0]) =>
      await deps.research.addLink(input),
    'research.saveSettings': async (input: Parameters<ResearchBridgeHost['saveSettings']>[0]) =>
      await deps.research.saveSettings(input),

    'crm.state': async () => await deps.crm.state(),
    'crm.openFirm': async (input: { readonly firmId: string }) => await deps.crm.openFirm(input),
    'crm.openPipeline': async (input?: Parameters<CrmBridgeHost['openPipeline']>[0]) => await deps.crm.openPipeline(input),
    'crm.openAddFirm': async () => await deps.crm.openAddFirm(),
    'crm.openImport': async () => await deps.crm.openImport(),
    'crm.addFirm': async (input: Parameters<CrmBridgeHost['addFirm']>[0]) => await deps.crm.addFirm(input),
    'crm.commitImport': async () => await deps.crm.commitImport(),
    'crm.saveContact': async (input: Parameters<CrmBridgeHost['saveContact']>[0]) => await deps.crm.saveContact(input),
    'crm.changeStage': async (input: Parameters<CrmBridgeHost['changeStage']>[0]) => await deps.crm.changeStage(input),
    'crm.setValue': async (input: Parameters<CrmBridgeHost['setValue']>[0]) => await deps.crm.setValue(input),
    'crm.resolveMerge': async (input: Parameters<CrmBridgeHost['resolveMerge']>[0]) => await deps.crm.resolveMerge(input),
    'crm.openOpportunity': async () => await deps.crm.openOpportunity(),
    'crm.takeOver': async input => await deps.crm.takeOver(input),
    'crm.resolveOutgoing': async (input: Parameters<CrmBridgeHost['resolveOutgoing']>[0]) =>
      await deps.crm.resolveOutgoing(input),
    'crm.enroll': async (input: Parameters<CrmBridgeHost['enroll']>[0]) => await deps.crm.enroll(input),
    'crm.checkRoute': async (input: Parameters<CrmBridgeHost['checkRoute']>[0]) => await deps.crm.checkRoute(input),

    'sequences.state': async () => await deps.sequences.state(),
    'sequences.openSequence': async (input: { readonly sequenceId: string }) => await deps.sequences.openSequence(input),
    'sequences.createSequence': async (input: { readonly name: string }) => await deps.sequences.createSequence(input),
    'sequences.saveSteps': async (input: Parameters<SequenceBridgeHost['saveSteps']>[0]) =>
      await deps.sequences.saveSteps(input),
    'sequences.saveTemplate': async (input: Parameters<SequenceBridgeHost['saveTemplate']>[0]) =>
      await deps.sequences.saveTemplate(input),
    'sequences.publish': async (input: { readonly sequenceVersionId: string }) => await deps.sequences.publish(input),
    'sequences.retire': async (input: { readonly sequenceVersionId: string }) => await deps.sequences.retire(input),

    'settings.state': async () => await deps.settings.state(),
    'settings.show': async (input: Parameters<AdminBridgeHost['show']>[0]) => await deps.settings.show(input),
    'settings.saveSetting': async (input: Parameters<AdminBridgeHost['saveSetting']>[0]) =>
      await deps.settings.saveSetting(input),
    'settings.saveIntegration': async (input: Parameters<AdminBridgeHost['saveIntegration']>[0]) =>
      await deps.settings.saveIntegration(input),
    'settings.openHistory': async (input: Parameters<AdminBridgeHost['openHistory']>[0]) =>
      await deps.settings.openHistory(input),
    'settings.loadDashboard': async (input: Parameters<AdminBridgeHost['loadDashboard']>[0]) =>
      await deps.settings.loadDashboard(input),
    'settings.retireStage': async (input: { readonly stageKey: string }) => await deps.settings.retireStage(input),
    'settings.acknowledgeAlert': async (input: { readonly alertId: string }) =>
      await deps.settings.acknowledgeAlert(input),
    'settings.setSendingCap': async (input: Parameters<AdminBridgeHost['setSendingCap']>[0]) =>
      await deps.settings.setSendingCap(input),
    'settings.recordSendingAuthentication': async (input: Parameters<AdminBridgeHost['recordSendingAuthentication']>[0]) =>
      await deps.settings.recordSendingAuthentication(input),
    'settings.recordHolidayCalendar': async (input: Parameters<AdminBridgeHost['recordHolidayCalendar']>[0]) =>
      await deps.settings.recordHolidayCalendar(input),
    'settings.addCallingNumber': async (input: Parameters<AdminBridgeHost['addCallingNumber']>[0]) =>
      await deps.settings.addCallingNumber(input),
    'settings.retireCallingNumber': async (input: { readonly identityId: string }) =>
      await deps.settings.retireCallingNumber(input),
    'settings.allowStates': async (input: Parameters<AdminBridgeHost['allowStates']>[0]) =>
      await deps.settings.allowStates(input),
    'settings.revokePosture': async (input: { readonly postureId: string }) => await deps.settings.revokePosture(input),

    'mailbox.state': async () => await deps.mailbox.state(),
    'mailbox.refresh': async () => await deps.mailbox.refresh(),
    'mailbox.connect': async () => await deps.mailbox.connect(),
    'mailbox.switch': async (input: { readonly switchTo: string }) => await deps.mailbox.switch(input),

    // Settings › Diagnostics. Straight through the authenticated client: there is no
    // state to keep and nothing to transform, and the recovery forms read the answer.
    'diagnostics.sendStatus': async (input: { readonly outboundMessageId: string }) => {
      const answer = await deps.api.read('/outbound/status', value => value, input);
      if (!answer.ok) throw new Error(answer.reason);
      return { fence: (answer.value as { fence?: unknown }).fence ?? null };
    },
    'diagnostics.resolveSend': async (input: { readonly outboundMessageId: string; readonly resolution: string }) => {
      const answer = await deps.api.command('/outbound/resolve', input, value => value);
      if (!answer.ok) throw new Error(answer.reason);
      return answer.value;
    },
    'diagnostics.deadJobs': async () => {
      const answer = await deps.api.read('/admin/jobs/dead', value => value);
      if (!answer.ok) throw new Error(answer.reason);
      return answer.value;
    },
    'diagnostics.requeueJob': async (input: { readonly jobId: string; readonly reason: string }) => {
      // Its own parser: this route predates the accepted envelope and answers a plain
      // body, which `AuthedClient.command` would read as a refusal.
      const answer = await deps.api.read('/admin/jobs/requeue', value => value, input);
      if (!answer.ok) throw new Error(answer.reason);
      return answer.value;
    },

    // Slice 3a, lane C. Straight through the client, like Meetings: each answer is the value
    // or null/false with the server's code, so a route an API does not serve is a hidden
    // block and never an error page.
    'calling.analysis': async (input: { readonly callSessionId: string }) => await readAnalysis(deps.api, input.callSessionId),
    'calling.analysisRetry': async (input: OperationInput<'calling.analysisRetry'>) => {
      const answer = await deps.api.command('/calls/analysis/retry', input, value => value);
      if (!answer.ok) return { analysis: null, reason: answer.reason.slice(0, 80) };
      return await readAnalysis(deps.api, input.callSessionId);
    },
    'calling.analysisEdit': async (input: OperationInput<'calling.analysisEdit'>) => {
      const answer = await deps.api.command('/calls/analysis/edit', input, value => callAnalysisResponseSchema.parse(value));
      return answer.ok ? { analysis: answer.value, reason: null } : { analysis: null, reason: answer.reason.slice(0, 80) };
    },
    'calling.proposalsApply': async (input: OperationInput<'calling.proposalsApply'>) => {
      const { commandId, ...body } = input;
      const answer = await deps.api.command(
        '/calls/proposals/apply',
        body,
        value => applyCallProposalsResultSchema.parse(value),
        commandId === undefined ? {} : { commandId },
      );
      return answer.ok
        ? { applied: answer.value, reason: null, keyReasons: {} }
        : { applied: null, reason: answer.reason.slice(0, 80), keyReasons: answer.offline ? {} : keyReasonsOf(answer.refusal) };
    },
    'calling.proposalsDecline': async (input: OperationInput<'calling.proposalsDecline'>) => {
      const answer = await deps.api.command('/calls/proposals/decline', input, value => value);
      return { declined: answer.ok, reason: answer.ok ? null : answer.reason.slice(0, 80) };
    },
    'calling.pendingDismiss': async (input: OperationInput<'calling.pendingDismiss'>) => {
      const answer = await deps.api.command('/calls/pending/dismiss', input, value => value);
      return { dismissed: answer.ok, reason: answer.ok ? null : answer.reason.slice(0, 80) };
    },
    'calling.recap': async () => {
      const answer = await deps.api.read('/calls/recap', value => callRecapResponseSchema.parse(value));
      return { recap: answer.ok ? answer.value : null };
    },
    'calling.acceptance': async () => {
      const answer = await deps.api.read('/calls/proposals/acceptance', value => proposalAcceptanceResponseSchema.parse(value));
      return { acceptance: answer.ok ? answer.value : null };
    },
    'calling.trial': async () => {
      const answer = await deps.api.read('/calls/trial', value => callTrialResponseSchema.parse(value));
      return { trial: answer.ok ? answer.value : null };
    },
    'review.list': async () => {
      const answer = await deps.api.read('/review', value => reviewListResponseSchema.parse(value));
      if (answer.ok) return { items: answer.value.items, failed: false };
      // A 404 is an API that does not serve the list: the group hides. Anything else is a read
      // that did not answer, and the page keeps what it last knew.
      const notServed = !answer.offline && (answer.reason === 'not_found' || answer.reason === 'http_404');
      return { items: null, failed: !notServed };
    },
    'review.stageResolve': async (input: OperationInput<'review.stageResolve'>) => {
      const answer = await deps.api.command('/review/stage/resolve', input, value => value);
      return { resolved: answer.ok, reason: answer.ok ? null : answer.reason.slice(0, 80) };
    },
    'suppressions.firmStop': async (input: OperationInput<'suppressions.firmStop'>) => {
      // Scope firm, the firm, the source David's own "do not call" carries, and the channel
      // he chose (migration 0037: calls, or all contact). Nothing else.
      const answer = await deps.api.command(
        '/suppressions/record',
        {
          scope: 'firm',
          firmId: input.firmId,
          source: 'prospect_do_not_call',
          ...(input.channel === undefined ? {} : { channel: input.channel }),
        },
        value => value,
      );
      return { stopped: answer.ok, reason: answer.ok ? null : answer.reason.slice(0, 80) };
    },
    'today.completeTask': async (input: Parameters<TodayBridgeHost['completeTask']>[0]) => await deps.today.completeTask(input),

    // S3X lane X2. Straight through the client, like lane C: each answer is the value or null
    // with the server's code.
    'calling.logs': async (input: OperationInput<'calling.logs'>) => {
      const answer = await deps.api.read(`/calls?firmId=${encodeURIComponent(input.firmId)}&include=corrections`, value =>
        callLogsResponseSchema.parse(value),
      );
      return { calls: answer.ok ? answer.value.calls : null };
    },
    'calling.correctionPreview': async (input: OperationInput<'calling.correctionPreview'>) => {
      const answer = await deps.api.read('/calls/logs/correction-preview', value => correctionPreviewResponseSchema.parse(value), input);
      return answer.ok ? { preview: answer.value, reason: null } : { preview: null, reason: answer.reason.slice(0, 80) };
    },
    'calling.correctOutcome': async (input: OperationInput<'calling.correctOutcome'>) => {
      const { commandId, ...body } = input;
      const answer = await deps.api.command('/calls/logs/correct', body, value => correctCallOutcomeResultSchema.parse(value), { commandId });
      return answer.ok ? { corrected: answer.value, reason: null } : { corrected: null, reason: answer.reason.slice(0, 80) };
    },
    'suppressions.supersede': async (input: OperationInput<'suppressions.supersede'>) => {
      // The unchanged admin supersession, for the one stop David confirmed (DESIGN-S3X §3.4a).
      const answer = await deps.api.command('/suppressions/supersede', { eventId: input.eventId, reason: 'correction' }, value => value, {
        commandId: input.commandId,
      });
      return { lifted: answer.ok, reason: answer.ok ? null : answer.reason.slice(0, 80) };
    },

    // Meetings (slice M1). Straight through the authenticated client, like Diagnostics.
    'meetings.forFirm': async (input: { readonly firmId: string }) => {
      const answer = await deps.api.read(`/meetings/firm?firmId=${encodeURIComponent(input.firmId)}`, value =>
        firmMeetingsResponseSchema.parse(value),
      );
      return { meetings: answer.ok ? answer.value.meetings : null };
    },
    'meetings.unmatched': async () => {
      const answer = await deps.api.read('/meetings/unmatched', value => unmatchedMeetingsResponseSchema.parse(value));
      return { meetings: answer.ok ? answer.value.meetings : null };
    },
    'meetings.match': async (input: { readonly meetingId: string; readonly firmId: string }) => {
      const answer = await deps.api.command('/meetings/match', input, value => meetingMatchedSchema.parse(value));
      return answer.ok ? { matched: answer.value, reason: null } : { matched: null, reason: answer.reason.slice(0, 80) };
    },

    // Slice S2. Straight through the authenticated client, like Meetings: the view that
    // asked reads its own state again afterwards.
    'firms.saveBasics': async (input: OperationInput<'firms.saveBasics'>) => {
      const answer = await deps.api.command('/crm/firms/basics', input, value => firmBasicsResultSchema.parse(value));
      if (answer.ok) return { saved: answer.value, reason: null, issues: [] };
      const refusal = answer.offline ? null : firmBasicsRefusalSchema.safeParse(answer.refusal);
      return {
        saved: null,
        reason: answer.reason.slice(0, 80),
        issues: refusal?.success === true ? (refusal.data.issues ?? []) : [],
      };
    },
    // Lane PB. Straight through the client, like the basics: the view reads its own state again.
    'firms.briefImportState': async () => await deps.briefImport.state(),
    'firms.briefImportCommit': async (input: OperationInput<'firms.briefImportCommit'>) => await deps.briefImport.commit(input),
    'firms.briefImportReset': async () => await deps.briefImport.reset(),
    'calls.logIncoming': async (input: OperationInput<'calls.logIncoming'>) => {
      const answer = await deps.api.command(
        '/calls/log',
        {
          firmId: input.firmId,
          ...(input.contactId === null ? {} : { contactId: input.contactId }),
          outcome: input.outcome,
          direction: 'inbound',
          occurredAt: input.occurredAt,
          ...(input.durationSeconds === null ? {} : { durationSeconds: input.durationSeconds }),
          ...(input.note.trim() === '' ? {} : { note: input.note.trim() }),
        },
        value => loggedCallResultSchema.parse(value),
      );
      if (!answer.ok) return { logged: false, reason: answer.reason.slice(0, 80) };
      const needsTime = answer.value.followUps.some(entry => entry.kind === 'callback_time_needed');
      return { logged: true, reason: needsTime ? 'outcome_recorded_callback_time_needed' : null };
    },
  } satisfies Readonly<Record<OperationName, (input: never) => Promise<unknown>>>;
  return handlers as Readonly<Record<OperationName, Handler>>;
}

/** Answer one operation: the closed list, then its input schema, then its output schema. */
export async function answerOperation(
  handlers: Readonly<Record<OperationName, Handler>>,
  kind: 'read' | 'command',
  name: unknown,
  input: unknown,
): Promise<unknown> {
  const operation = operationOf(name);
  if (operation === null) throw new Error('no such operation');
  const declared = OPERATIONS[operation];
  if (declared.kind !== kind) throw new Error(`${operation} is a ${declared.kind}, not a ${kind}`);

  const parsed = declared.input.safeParse(input ?? {});
  if (!parsed.success) {
    // The model setting answers its own shape, not the lane's: a malformed save reads it back.
    const fallback = operation === 'replies.saveModel' ? 'replies.model' : FALLBACK[operation.slice(0, operation.indexOf('.'))];
    if (fallback === undefined) throw new Error(`${operation} was asked for with a shape it does not accept`);
    return declared.output.parse(await handlers[fallback](undefined as never));
  }
  return declared.output.parse(await handlers[operation](parsed.data as never));
}

export interface OperationRegistration {
  readonly handlers: Readonly<Record<OperationName, Handler>>;
  readonly channels: readonly string[];
}

/**
 * Register the two channels. `handle` is passed in rather than `ipcMain` being imported,
 * for the reason every other module in this directory gives: importing Electron outside
 * the app downloads its binary in the middle of `vitest`.
 */
export function registerOperations(
  deps: OperationHostDeps,
  handle: (channel: string, listener: (argument: unknown) => Promise<unknown>) => void,
): OperationRegistration {
  const handlers = operationHandlers(deps);
  handle(OPERATION_IPC_CHANNELS.read, async argument => {
    const request = argument as { operation?: unknown; input?: unknown } | null;
    return await answerOperation(handlers, 'read', request?.operation, request?.input);
  });
  handle(OPERATION_IPC_CHANNELS.command, async argument => {
    const request = argument as { operation?: unknown; input?: unknown } | null;
    return await answerOperation(handlers, 'command', request?.operation, request?.input);
  });
  return { handlers, channels: [OPERATION_IPC_CHANNELS.read, OPERATION_IPC_CHANNELS.command] };
}

/** Every operation the registry declares has a handler, and no handler has no operation. */
export function operationCoverage(handlers: Readonly<Record<string, Handler>>): {
  readonly missing: readonly string[];
  readonly extra: readonly string[];
} {
  const named = new Set<string>(OPERATION_NAMES);
  const implemented = new Set(Object.keys(handlers));
  return {
    missing: [...named].filter(name => !implemented.has(name)),
    extra: [...implemented].filter(name => !named.has(name)),
  };
}

export { DIAL_IPC_CHANNELS, OPERATION_IPC_CHANNELS };
