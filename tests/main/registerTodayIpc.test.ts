import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: electron.handle,
    removeHandler: electron.removeHandler,
  },
}));

import type { MutationReceipt } from '../../src/shared/contracts/commonContract';
import type {
  CompleteActionRequest,
  LogPastActivityRequest,
  TodaySnapshot,
} from '../../src/shared/contracts/todayContract';
import type { TodayProvider } from '../../src/main/today/todayService';
import { registerTodayIpc } from '../../src/main/today/registerTodayIpc';
import {
  registeredIpcHandler,
  type IpcInvokeEvent,
} from '../fixtures/registeredIpcHandler';

const trustedEvent: IpcInvokeEvent = {
  senderFrame: { url: 'callie://app/index.html' },
};
const untrustedEvent: IpcInvokeEvent = {
  senderFrame: { url: 'https://attacker.test/' },
};

const TODAY_CHANNELS = [
  'today:add-note',
  'today:complete',
  'today:get',
  'today:log-activity',
  'today:log-call-outcome',
  'today:mark-activity-in-error',
  'today:pin',
  'today:snooze',
] as const;

const validSnapshot: TodaySnapshot = {
  lanes: [
    {
      id: 'due_cadence',
      items: [
        {
          id: 'cycle-1',
          lane: 'due_cadence',
          personId: 'person-1',
          salesCycleId: 'cycle-1',
          personName: 'Avery Landlord',
          contextLabel: 'Landlord LLC',
          stage: 'contacted',
          priorityContext: {
            priority: 'P1',
            fitPoints: 24,
            fitBand: 'high',
            timingValue: 31,
            timingBand: 'hot',
            reachability: 'direct',
            dataConfidence: 8,
          },
          action: {
            id: 'action-1',
            type: 'call_lead',
            channel: 'call',
            label: 'Call lead',
          },
          reason: 'Cadence says this is next',
          activeTriggers: [
            { label: 'inbound_reply', expiresAt: '2026-09-01T15:00:00.000Z' },
          ],
          verifyFirst: false,
          pinned: false,
          consentRequirement: null,
        },
      ],
      overflowCount: 0,
    },
  ],
  dialBudget: 40,
  scheduledDials: 1,
  conversationTarget: 5,
  reviewErrorCount: 0,
  unreviewedBacklogCount: 0,
  revision: 3,
};

const receipt: MutationReceipt = {
  revision: 4,
  affectedPersonIds: ['person-1'],
  affectedSalesCycleIds: ['cycle-1'],
};

const completeRequest: CompleteActionRequest = {
  salesCycleId: 'cycle-1',
  actionId: 'action-1',
  outcome: 'answered',
  activityId: null,
};

const snoozeRequest = {
  salesCycleId: 'cycle-1',
  resurfaceAt: '2026-09-01T15:00:00.000Z',
} as const;

const pinRequest = {
  salesCycleId: 'cycle-1',
  reason: 'Founder context',
  expiresAt: '2026-09-01T15:00:00.000Z',
  comparedSalesCycleId: 'cycle-2',
} as const;

const logActivityRequest: LogPastActivityRequest = {
  personId: 'person-1',
  salesCycleId: 'cycle-1',
  kind: 'note',
  direction: 'internal',
  occurredAt: '2026-08-31T15:00:00.000Z',
  summary: 'Met at the RIREIG meetup.',
  outcome: null,
};

function fakeProvider(): TodayProvider {
  return {
    get: vi.fn(async () => validSnapshot),
    complete: vi.fn(async () => receipt),
    snooze: vi.fn(async () => receipt),
    pin: vi.fn(async () => receipt),
    logPastActivity: vi.fn(async () => receipt),
    addLeadNote: vi.fn(async () => receipt),
    logCallOutcome: vi.fn(async () => receipt),
    markActivityInError: vi.fn(async () => receipt),
  };
}

const invokeRegistered = (
  channel: string,
  event: IpcInvokeEvent,
  ...args: unknown[]
) => Promise.resolve(registeredIpcHandler(electron.handle, channel)(event, ...args));

describe('registerTodayIpc', () => {
  beforeEach(() => {
    electron.handle.mockReset();
    electron.removeHandler.mockReset();
  });

  it('registers exactly the eight strict Today channels', () => {
    registerTodayIpc(fakeProvider());

    expect(electron.handle).toHaveBeenCalledTimes(8);
    expect(electron.handle.mock.calls.map((call) => call[0]).sort()).toEqual([
      ...TODAY_CHANNELS,
    ]);
  });

  it('returns the validated snapshot from today:get without a request payload', async () => {
    const provider = fakeProvider();
    registerTodayIpc(provider);

    await expect(
      invokeRegistered('today:get', trustedEvent),
    ).resolves.toEqual(validSnapshot);
    expect(provider.get).toHaveBeenCalledTimes(1);
  });

  it('rejects any today:get request payload', async () => {
    const provider = fakeProvider();
    registerTodayIpc(provider);

    await expect(
      invokeRegistered('today:get', trustedEvent, { limit: 5 }),
    ).rejects.toThrow();
    expect(provider.get).not.toHaveBeenCalled();
  });

  it('passes parsed command requests through and returns receipts', async () => {
    const provider = fakeProvider();
    registerTodayIpc(provider);

    await expect(
      invokeRegistered('today:complete', trustedEvent, completeRequest),
    ).resolves.toEqual(receipt);
    expect(provider.complete).toHaveBeenCalledWith(completeRequest);

    await expect(
      invokeRegistered('today:snooze', trustedEvent, snoozeRequest),
    ).resolves.toEqual(receipt);
    expect(provider.snooze).toHaveBeenCalledWith(snoozeRequest);

    await expect(
      invokeRegistered('today:pin', trustedEvent, pinRequest),
    ).resolves.toEqual(receipt);
    expect(provider.pin).toHaveBeenCalledWith(pinRequest);

    await expect(
      invokeRegistered('today:log-activity', trustedEvent, logActivityRequest),
    ).resolves.toEqual(receipt);
    expect(provider.logPastActivity).toHaveBeenCalledWith(logActivityRequest);
  });

  it('rejects malformed command requests before invoking the provider', async () => {
    const provider = fakeProvider();
    registerTodayIpc(provider);

    await expect(
      invokeRegistered('today:complete', trustedEvent, {
        ...completeRequest,
        outcome: 'ghosted',
      }),
    ).rejects.toThrow();
    await expect(
      invokeRegistered('today:snooze', trustedEvent, {
        salesCycleId: 'cycle-1',
        resurfaceAt: 'not-a-timestamp',
      }),
    ).rejects.toThrow();
    await expect(
      invokeRegistered('today:pin', trustedEvent, {
        ...pinRequest,
        score: 90,
      }),
    ).rejects.toThrow();
    await expect(
      invokeRegistered('today:log-activity', trustedEvent, {
        ...logActivityRequest,
        summary: '',
      }),
    ).rejects.toThrow();
    expect(provider.complete).not.toHaveBeenCalled();
    expect(provider.snooze).not.toHaveBeenCalled();
    expect(provider.pin).not.toHaveBeenCalled();
    expect(provider.logPastActivity).not.toHaveBeenCalled();
  });

  it('rejects an untrusted sender on every channel before the provider runs', async () => {
    const provider = fakeProvider();
    registerTodayIpc(provider);

    await expect(
      invokeRegistered('today:get', untrustedEvent),
    ).rejects.toThrow('trusted');
    await expect(
      invokeRegistered('today:complete', untrustedEvent, completeRequest),
    ).rejects.toThrow('trusted');
    await expect(
      invokeRegistered('today:snooze', untrustedEvent, snoozeRequest),
    ).rejects.toThrow('trusted');
    await expect(
      invokeRegistered('today:pin', untrustedEvent, pinRequest),
    ).rejects.toThrow('trusted');
    await expect(
      invokeRegistered('today:log-activity', untrustedEvent, logActivityRequest),
    ).rejects.toThrow('trusted');
    expect(provider.get).not.toHaveBeenCalled();
    expect(provider.complete).not.toHaveBeenCalled();
    expect(provider.snooze).not.toHaveBeenCalled();
    expect(provider.pin).not.toHaveBeenCalled();
    expect(provider.logPastActivity).not.toHaveBeenCalled();
  });

  it('rejects a malformed provider snapshot in the main process', async () => {
    const provider = fakeProvider();
    provider.get = vi.fn(async () => ({
      ...validSnapshot,
      dialBudget: -1,
    })) as TodayProvider['get'];
    registerTodayIpc(provider);

    await expect(invokeRegistered('today:get', trustedEvent)).rejects.toThrow();
  });

  it('returns one idempotent unregister function that removes all eight channels', () => {
    const unregister = registerTodayIpc(fakeProvider());

    unregister();
    unregister();

    expect(electron.removeHandler).toHaveBeenCalledTimes(8);
    expect(
      electron.removeHandler.mock.calls.map((call) => call[0]).sort(),
    ).toEqual([...TODAY_CHANNELS]);
  });
});
