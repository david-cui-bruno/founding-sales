import { describe, expect, it, vi } from 'vitest';
import {
  answerOperation,
  operationCoverage,
  operationHandlers,
  registerOperations,
} from '../src/main/operationHost.ts';
import type { AuthedClient } from '../src/main/authedClient.ts';
import type { ReplyBridgeHost } from '../src/main/replyBridge.ts';
import type { TodayBridgeHost } from '../src/main/todayBridge.ts';
import type { ReplyState } from '../src/renderer/replyContract.ts';
import type { TodayState } from '../src/renderer/todayContract.ts';
import {
  DIAL_IPC_CHANNELS,
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
  return {
    api: api as unknown as AuthedClient,
    today: today as unknown as TodayBridgeHost,
    replies: replies as unknown as ReplyBridgeHost,
    spies: { today, replies, api },
  };
};

describe('the operation registry', () => {
  it('is a closed list of operations, with two channels and the dial handoff beside them', () => {
    expect(OPERATION_NAMES).toEqual([
      'today.state',
      'today.refresh',
      'today.expand',
      'today.collapse',
      'today.snooze',
      'today.recordOutcome',
      'today.scheduleCallback',
      'today.releasePause',
      'replies.state',
      'replies.refresh',
      'replies.open',
      'replies.forget',
      'replies.collapse',
      'replies.confirm',
      'replies.resolve',
      'diagnostics.sendStatus',
      'diagnostics.resolveSend',
      'diagnostics.deadJobs',
      'diagnostics.requeueJob',
    ]);
    expect(Object.values(OPERATION_IPC_CHANNELS)).toEqual(['callie:op:read', 'callie:op:command']);
    expect(Object.values(DIAL_IPC_CHANNELS)).toEqual(['callie:dial:call']);
  });

  it('names no operation that closes an opportunity, sends, or dials', () => {
    const paths = OPERATION_NAMES.map(name => OPERATIONS[name].http?.path ?? null);
    expect(paths).not.toContain('/dial/authorize');
    expect(paths).not.toContain('/dial/consume');
    expect(paths.filter(path => path !== null && /opportunit|send|suppress/u.test(path))).toEqual([]);
    // Every operation says what the main process does for it, so a handler that stopped
    // doing it is a name with nothing behind it.
    for (const name of OPERATION_NAMES) expect(OPERATIONS[name].transform.length).toBeGreaterThan(3);
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
