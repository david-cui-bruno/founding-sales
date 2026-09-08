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
  LeadRow,
  LeadsListRequest,
  LeadsListResponse,
} from '../../src/shared/contracts/leadsContract';
import type { LeadsProvider } from '../../src/main/leads/leadsService';
import { registerLeadsIpc } from '../../src/main/leads/registerLeadsIpc';
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

const leadRow: LeadRow = {
  personId: 'person-1',
  salesCycleId: 'cycle-1',
  personName: 'Avery Landlord',
  initials: 'AL',
  organization: 'Landlord LLC',
  propertySummary: '12 Benefit St, Providence',
  stage: 'ready',
  source: 'frbo',
  segment: 'hot',
  cloudScores: null,
  priorityContext: {
    priority: 'P1',
    fitPoints: 24,
    fitBand: 'high',
    timingValue: 31,
    timingBand: 'hot',
    reachability: 'direct',
    dataConfidence: 8,
  },
  nextAction: {
    dueAt: null,
    id: 'action-1',
    type: 'call_lead',
    channel: 'call',
    label: 'Call lead',
  },
  optedOut: false,
  lastActivityAt: '2026-08-30T12:00:00.000Z',
};

const validPage: LeadsListResponse = {
  rows: [leadRow],
  nextCursor: null,
  total: 1,
  revision: 4,
};

const receipt: MutationReceipt = {
  revision: 5,
  affectedPersonIds: ['person-1'],
  affectedSalesCycleIds: ['cycle-1'],
};

const listRequest: LeadsListRequest = {
  limit: 50,
  cursor: null,
  query: '',
  stages: [],
  priorities: [],
  sort: 'priority',
};

function fakeProvider(): LeadsProvider {
  return {
    list: vi.fn(async () => validPage),
    updateField: vi.fn(async () => receipt),
    bulkUpdate: vi.fn(async () => receipt),
  };
}

const invokeRegistered = (
  channel: string,
  event: IpcInvokeEvent,
  ...args: unknown[]
) => Promise.resolve(registeredIpcHandler(electron.handle, channel)(event, ...args));

describe('registerLeadsIpc', () => {
  beforeEach(() => {
    electron.handle.mockReset();
    electron.removeHandler.mockReset();
  });

  it('registers strict leads channels and validates provider output', async () => {
    const provider = fakeProvider();

    registerLeadsIpc(provider);

    expect(electron.handle).toHaveBeenCalledTimes(3);
    expect(electron.handle.mock.calls.map((call) => call[0]).sort()).toEqual([
      'leads:bulk-update',
      'leads:list',
      'leads:update-field',
    ]);
    await expect(
      invokeRegistered('leads:list', trustedEvent, listRequest),
    ).resolves.toEqual(validPage);
    expect(provider.list).toHaveBeenCalledTimes(1);
    expect(provider.list).toHaveBeenCalledWith(listRequest);
  });

  it('passes the parsed update-field request through and returns the receipt', async () => {
    const provider = fakeProvider();
    registerLeadsIpc(provider);

    await expect(
      invokeRegistered('leads:update-field', trustedEvent, {
        personId: 'person-1',
        field: 'person_name',
        value: 'Renamed Person',
      }),
    ).resolves.toEqual(receipt);
    expect(provider.updateField).toHaveBeenCalledWith({
      personId: 'person-1',
      field: 'person_name',
      value: 'Renamed Person',
    });
  });

  it('accepts a bulk organization update for many people', async () => {
    const provider = fakeProvider();
    registerLeadsIpc(provider);

    await expect(
      invokeRegistered('leads:bulk-update', trustedEvent, {
        personIds: ['person-1', 'person-2'],
        field: 'organization_label',
        value: 'Shared Holdings',
      }),
    ).resolves.toEqual(receipt);
    expect(provider.bulkUpdate).toHaveBeenCalledWith({
      personIds: ['person-1', 'person-2'],
      field: 'organization_label',
      value: 'Shared Holdings',
    });
  });

  it('rejects malformed requests before invoking the provider', async () => {
    const provider = fakeProvider();
    registerLeadsIpc(provider);

    await expect(
      invokeRegistered('leads:list', trustedEvent, { ...listRequest, limit: 0 }),
    ).rejects.toThrow();
    await expect(
      invokeRegistered('leads:list', trustedEvent, { ...listRequest, score: 90 }),
    ).rejects.toThrow();
    await expect(
      invokeRegistered('leads:update-field', trustedEvent, {
        personId: 'person-1',
        field: 'stage',
        value: 'won',
      }),
    ).rejects.toThrow();
    await expect(
      invokeRegistered('leads:bulk-update', trustedEvent, {
        personIds: [],
        field: 'organization_label',
        value: 'Shared Holdings',
      }),
    ).rejects.toThrow();
    expect(provider.list).not.toHaveBeenCalled();
    expect(provider.updateField).not.toHaveBeenCalled();
    expect(provider.bulkUpdate).not.toHaveBeenCalled();
  });

  it('rejects an untrusted sender on every channel before the provider runs', async () => {
    const provider = fakeProvider();
    registerLeadsIpc(provider);

    await expect(
      invokeRegistered('leads:list', untrustedEvent, listRequest),
    ).rejects.toThrow('trusted');
    await expect(
      invokeRegistered('leads:update-field', untrustedEvent, {
        personId: 'person-1',
        field: 'person_name',
        value: 'Renamed Person',
      }),
    ).rejects.toThrow('trusted');
    await expect(
      invokeRegistered('leads:bulk-update', untrustedEvent, {
        personIds: ['person-1'],
        field: 'organization_label',
        value: null,
      }),
    ).rejects.toThrow('trusted');
    expect(provider.list).not.toHaveBeenCalled();
    expect(provider.updateField).not.toHaveBeenCalled();
    expect(provider.bulkUpdate).not.toHaveBeenCalled();
  });

  it('rejects a malformed provider response in the main process', async () => {
    const provider = fakeProvider();
    provider.list = vi.fn(async () => ({
      ...validPage,
      total: -1,
    })) as LeadsProvider['list'];
    registerLeadsIpc(provider);

    await expect(
      invokeRegistered('leads:list', trustedEvent, listRequest),
    ).rejects.toThrow();
  });

  it('returns one idempotent unregister function that removes all three channels', () => {
    const unregister = registerLeadsIpc(fakeProvider());

    unregister();
    unregister();

    expect(electron.removeHandler).toHaveBeenCalledTimes(3);
    expect(
      electron.removeHandler.mock.calls.map((call) => call[0]).sort(),
    ).toEqual(['leads:bulk-update', 'leads:list', 'leads:update-field']);
  });
});
