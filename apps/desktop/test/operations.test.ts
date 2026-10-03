import { describe, expect, it, vi } from 'vitest';
import {
  answerOperation,
  operationCoverage,
  operationHandlers,
  registerOperations,
} from '../src/main/operationHost.ts';
import type { AuthedClient } from '../src/main/authedClient.ts';
import type { CrmBridgeHost } from '../src/main/crmBridge.ts';
import type { MailboxBridgeHost } from '../src/main/mailboxBridge.ts';
import type { BriefImportHost } from '../src/main/briefImport.ts';
import type { RecordingImportHost } from '../src/main/recordings/importer.ts';
import type { ReplyBridgeHost } from '../src/main/replyBridge.ts';
import type { ResearchBridgeHost } from '../src/main/researchBridge.ts';
import type { SequenceBridgeHost } from '../src/main/sequenceBridge.ts';
import type { AdminBridgeHost } from '../src/main/settingsBridge.ts';
import type { TodayBridgeHost } from '../src/main/todayBridge.ts';
import type { ReplyState } from '../src/renderer/replyContract.ts';
import type { TodayState } from '../src/renderer/todayContract.ts';
import {
  DIAL_IPC_CHANNELS,
  IMPORT_IPC_CHANNELS,
  OPERATIONS,
  OPERATION_IPC_CHANNELS,
  OPERATION_NAMES,
  operationOf,
} from '../src/shared/operations.ts';

const ITEM_ID = '11111111-1111-4111-8111-111111111111';
const FIRM_ID = '22222222-2222-4222-8222-222222222222';

const todayState = (notice: string | null = null): TodayState => ({
  snapshotDate: '2026-09-27',
  businessTimeZone: 'America/New_York',
  cards: [],
  expanded: null,
  online: true,
  stale: false,
  asOf: '2026-09-27T12:00:00.000Z',
  mayMutate: true,
  role: 'salesperson',
  notice,
  handoffNotice: '',
  dialAdvice: [],
  followUpTemplates: [],
  lastCall: null,
});

const replyState = (notice: string | null = null): ReplyState => ({
  businessDate: '2026-09-27',
  businessTimeZone: 'America/New_York',
  cards: [],
  open: null,
  online: true,
  mayMutate: true,
  classifier: null,
  notice,
});

const hosts = () => {
  const today = {
    state: vi.fn(async () => todayState('state')),
    refresh: vi.fn(async (_input?: unknown) => todayState('refresh')),
    expand: vi.fn(async (_input: unknown) => todayState('expand')),
    collapse: vi.fn(async () => todayState('collapse')),
    snooze: vi.fn(async (_input: unknown) => todayState('snooze')),
    dial: vi.fn(async (_input: unknown) => todayState('dial')),
    recordOutcome: vi.fn(async (_input: unknown) => todayState('outcome')),
    scheduleCallback: vi.fn(async (_input: unknown) => todayState('callback')),
    releasePause: vi.fn(async (_input: unknown) => todayState('released')),
  };
  const replies = {
    state: vi.fn(async () => replyState('state')),
    refresh: vi.fn(async () => replyState('refresh')),
    open: vi.fn(async (_input: unknown) => replyState('open')),
    collapse: vi.fn(async () => replyState('collapse')),
    confirm: vi.fn(async (_input: unknown) => replyState('confirmed')),
    resolve: vi.fn(async (_input: unknown) => replyState('resolved')),
  };
  const api = {
    read: vi.fn(async (_path: string, _parse: (value: unknown) => unknown, _body?: unknown) => ({
      ok: true as const,
      value: { deadJobs: [] },
    })),
    command: vi.fn(async () => ({ ok: true as const, value: {} })),
  };
  // The four views the registry gained in 1.0.13. Their own suites hold what each host
  // does; here they only have to exist, so that "one handler per operation" is a fact
  // about the whole list rather than about Today and Replies.
  const stub = <T>(methods: readonly string[], answer: () => T): T =>
    Object.fromEntries(methods.map(name => [name, vi.fn(async () => await Promise.resolve(answer()))])) as T;
  return {
    api: api as unknown as AuthedClient,
    today: today as unknown as TodayBridgeHost,
    replies: replies as unknown as ReplyBridgeHost,
    crm: stub<CrmBridgeHost>(
      ['state', 'openFirm', 'openPipeline', 'openAddFirm', 'openImport', 'addFirm', 'previewImport', 'commitImport', 'saveContact', 'changeStage', 'setValue', 'resolveMerge', 'openOpportunity', 'enroll', 'checkRoute'],
      () => ({}) as never,
    ),
    sequences: stub<SequenceBridgeHost>(
      ['state', 'openSequence', 'createSequence', 'saveSteps', 'saveTemplate', 'publish', 'retire'],
      () => ({}) as never,
    ),
    settings: stub<AdminBridgeHost>(
      ['state', 'show', 'saveSetting', 'openHistory', 'loadDashboard', 'retireStage', 'acknowledgeAlert', 'setSendingCap', 'recordSendingAuthentication', 'recordHolidayCalendar', 'addCallingNumber', 'retireCallingNumber', 'allowStates', 'revokePosture'],
      () => ({}) as never,
    ),
    research: stub<ResearchBridgeHost>(
      ['state', 'open', 'run', 'addLink', 'saveSettings'],
      () => ({}) as never,
    ),
    mailbox: stub<MailboxBridgeHost>(['state', 'refresh', 'connect', 'switch'], () => ({}) as never),
    briefImport: stub<BriefImportHost>(['state', 'choose', 'commit', 'reset', 'forget'], () => ({}) as never),
    recordings: stub<RecordingImportHost>(['state', 'chooseMeeting', 'ignore', 'retry', 'forget'], () => ({}) as never),
    spies: { today, replies, api },
  };
};

describe('the operation registry', () => {
  it('is a closed list covering every view, with two channels and the two handoffs beside them', () => {
    // Every view is here since 1.0.13; the names are the vocabulary a renderer may use.
    const families = [...new Set(OPERATION_NAMES.map(name => name.slice(0, name.indexOf('.'))))];
    expect(families).toEqual(['today', 'calling', 'review', 'suppressions', 'research', 'replies', 'diagnostics', 'crm', 'sequences', 'settings', 'mailbox', 'meetings', 'firms', 'calls', 'recordings']);
    // Slice S2: a firm's basics from Today and the firm page, and an incoming call.
    expect(OPERATION_NAMES.filter(name => name.startsWith('firms.') || name.startsWith('calls.'))).toEqual([
      'firms.saveBasics',
      'calls.logIncoming',
      // Lane PB: importing prepared briefs from a JSON file (briefs are read-only otherwise).
      'firms.briefImportState',
      'firms.briefImportCommit',
      'firms.briefImportReset',
    ]);
    // Slice M1: the firm page's meetings and the bookings to match, straight through the client.
    expect(OPERATION_NAMES.filter(name => name.startsWith('meetings.'))).toEqual(['meetings.forFirm', 'meetings.brief', 'meetings.unmatched', 'meetings.match', 'meetings.setAttendance']);
    // Slice C1: placing a call from Callie, when `calling_provider = twilio`.
    expect(OPERATION_NAMES.filter(name => name.startsWith('calling.'))).toEqual([
      'calling.status',
      'calling.start',
      'calling.cancel',
      'calling.setActive',
      'calling.resume',
      'calling.history',
      'calling.analysis',
      'calling.analysisRetry',
      'calling.analysisEdit',
      'calling.proposalsApply',
      'calling.proposalsDecline',
      'calling.pendingDismiss',
      'calling.recap',
      'calling.acceptance',
      'calling.trial',
      // S3X lane X2: every call log of the firm, and correcting one.
      'calling.logs',
      'calling.correctionPreview',
      'calling.correctOutcome',
      'calling.recording',
      // Slice C2: the call's transcript, under its row on the firm page.
      'calling.transcript',
    ]);
    expect(OPERATION_NAMES.filter(name => name.startsWith('today.'))).toEqual([
      'today.state',
      'today.refresh',
      'today.expand',
      'today.previewFollowUp',
      'today.callsPlaced',
      'today.collapse',
      'today.snooze',
      'today.recordOutcome',
      'today.recordAgreedDates',
      'today.scheduleCallback',
      'today.releasePause',
      'today.completeTask',
    ]);
    expect(OPERATION_NAMES.filter(name => name.startsWith('replies.'))).toEqual([
      'replies.state',
      'replies.refresh',
      'replies.open',
      'replies.forget',
      'replies.collapse',
      'replies.confirm',
      'replies.resolve',
      'replies.model',
      'replies.saveModel',
    ]);
    expect(Object.values(OPERATION_IPC_CHANNELS)).toEqual(['callie:op:read', 'callie:op:command']);
    expect(Object.values(DIAL_IPC_CHANNELS)).toEqual(['callie:dial:call']);
    expect(Object.values(IMPORT_IPC_CHANNELS)).toEqual([
      'callie:import:choose',
      'callie:import:choose-briefs',
      // Lane M4: the recordings folder, and one recording folder by hand.
      'callie:import:choose-recordings-folder',
      'callie:import:import-recording-folder',
    ]);
  });

  it('names no operation that dials, and every operation says what the main process does for it', () => {
    const paths = OPERATION_NAMES.flatMap(name => OPERATIONS[name].calls.map(call => call.path));
    // Dialling is a channel of its own and never an operation: these two are the pair
    // that authorises and spends a call, and no operation may reach them.
    expect(paths).not.toContain('/dial/authorize');
    expect(paths).not.toContain('/dial/consume');
    expect(operationOf('today.dial')).toBeNull();
    /*
     * `/dial/check` is a different thing and is declared (1.0.13, P1-5). Opening a card
     * asks it once per usable number for the advice the card shows — "it is 9:10 there",
     * "this number is not callable and why" — and it moves nothing. Leaving it out of
     * `calls` made the deprecated-route check below a check of an incomplete list.
     */
    expect(OPERATIONS['today.expand'].calls.map(call => call.path)).toContain('/dial/check');
    for (const name of OPERATION_NAMES) expect(OPERATIONS[name].transform.length).toBeGreaterThan(3);
  });

  /**
   * The list W3-C deletes from the server.
   *
   * `calls` is every path the main process may reach for an operation, so this is the
   * whole of what 1.0.13 can ask for — the dial itself (`/dial/authorize`,
   * `/dial/consume`, `/calls/log`) and the import handoff (`/import/preview`) aside,
   * which are named channels and whose paths are in their own modules. A route that
   * reappeared here would be a failing test rather than a caller nobody noticed.
   *
   * The list is only as good as `calls` is complete, which is why
   * `registryTraffic.test.ts` drives every operation against a recording client with
   * answers the bridges accept, and fails on a request that is not declared here.
   */
  it('calls none of the routes wave 2 deprecated', () => {
    const paths = new Set(OPERATION_NAMES.flatMap(name => OPERATIONS[name].calls.map(call => call.path)));
    for (const retired of [
      '/dial/authorize',
      '/dial/consume',
      '/calling-identities/attest',
      '/contacts/routes/confirm',
      '/postures/record',
      '/templates/approve',
      '/enrollments/resume',
      '/enrollments/resume/preview',
    ]) {
      expect([...paths]).not.toContain(retired);
    }
    // The one deprecated route that still has a caller, and why: it is the only way a
    // sequence gets its first version, so W3-C keeps it until something else makes one.
    expect([...paths]).toContain('/sequences/versions/draft');
    expect(OPERATIONS['sequences.createSequence'].transform).toContain('first empty version');
  });

  it('refuses a name that is not one of them, including a prototype key', () => {
    expect(operationOf('today.state')).toBe('today.state');
    expect(operationOf('today.dial')).toBeNull();
    expect(operationOf('__proto__')).toBeNull();
    expect(operationOf('constructor')).toBeNull();
    expect(operationOf(null)).toBeNull();
  });

  it('has one handler per operation and no handler without one', () => {
    const deps = hosts();
    expect(operationCoverage(operationHandlers(deps))).toEqual({ missing: [], extra: [] });
  });

  it('will not answer a command on the read channel, or a read on the command channel', async () => {
    const deps = hosts();
    const handlers = operationHandlers(deps);
    await expect(answerOperation(handlers, 'read', 'today.snooze', {})).rejects.toThrow('is a command');
    await expect(answerOperation(handlers, 'command', 'today.state', {})).rejects.toThrow('is a read');
    await expect(answerOperation(handlers, 'read', 'today.everything', {})).rejects.toThrow('no such operation');
  });

  it('parses the input with the operation’s own schema, and answers the view’s state when it does not fit', async () => {
    const deps = hosts();
    const handlers = operationHandlers(deps);
    const refused = (await answerOperation(handlers, 'command', 'today.snooze', {
      itemId: 'not-a-uuid',
      reason: '',
      returnAt: '',
    })) as TodayState;
    expect(refused.notice).toBe('state');
    expect(deps.spies.today.snooze).not.toHaveBeenCalled();

    const answered = (await answerOperation(handlers, 'read', 'today.expand', { firmId: FIRM_ID })) as TodayState;
    expect(answered.notice).toBe('expand');
    expect(deps.spies.today.expand).toHaveBeenCalledWith({ firmId: FIRM_ID });
  });

  it('refuses a field the operation did not declare', async () => {
    const deps = hosts();
    const handlers = operationHandlers(deps);
    const refused = (await answerOperation(handlers, 'read', 'replies.open', {
      messageId: ITEM_ID,
      body: 'the message text',
    })) as ReplyState;
    expect(refused.notice).toBe('state');
    expect(deps.spies.replies.open).not.toHaveBeenCalled();
  });

  it('parses the answer too, so a state that grew a field never reaches the page', async () => {
    const deps = hosts();
    const handlers = operationHandlers(deps);
    const leaky = { ...todayState(), accessToken: 'secret' } as unknown as TodayState;
    deps.spies.today.state.mockResolvedValueOnce(leaky);
    await expect(answerOperation(handlers, 'read', 'today.state', {})).rejects.toThrow();
  });

  it('a diagnostics refusal is a rejected call, not another view’s state', async () => {
    const deps = hosts();
    const handlers = operationHandlers(deps);
    await expect(answerOperation(handlers, 'command', 'diagnostics.requeueJob', { jobId: ITEM_ID, reason: '' })).rejects.toThrow(
      'a shape it does not accept',
    );
  });

  it('sends the dead-job requeue through the read client, because that route answers a plain body', async () => {
    const deps = hosts();
    const handlers = operationHandlers(deps);
    deps.spies.api.read.mockResolvedValueOnce({
      ok: true as const,
      value: { requeued: true, jobId: ITEM_ID, kind: 'send_email' },
    } as never);
    const answer = await answerOperation(handlers, 'command', 'diagnostics.requeueJob', {
      jobId: ITEM_ID,
      reason: 'the mailbox was reconnected',
    });
    expect(answer).toEqual({ requeued: true, jobId: ITEM_ID, kind: 'send_email' });
    expect(OPERATIONS['diagnostics.requeueJob'].envelope).toBe('plain');
    expect(deps.spies.api.command).not.toHaveBeenCalled();
    expect(deps.spies.api.read.mock.calls[0]?.[0]).toBe('/admin/jobs/requeue');
  });

  it('registers exactly the two channels', () => {
    const deps = hosts();
    const registered: string[] = [];
    const { channels } = registerOperations(deps, channel => registered.push(channel));
    expect(registered).toEqual(['callie:op:read', 'callie:op:command']);
    expect(channels).toEqual(['callie:op:read', 'callie:op:command']);
  });
});
