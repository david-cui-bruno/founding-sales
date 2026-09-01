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
import type { LeadDetail } from '../../src/shared/contracts/leadDetailContract';
import type { LeadDetailProvider } from '../../src/main/leads/leadDetailService';
import { registerLeadDetailIpc } from '../../src/main/leads/registerLeadDetailIpc';
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

const detail: LeadDetail = {
  personId: 'person-1',
  salesCycleId: 'cycle-1',
  personName: 'Avery Landlord',
  phones: [
    { id: 'phone-1', kind: 'phone', value: '+14015550100', label: null, valid: true },
  ],
  emails: [],
  organizationLabel: null,
  propertySummaries: ['12 Benefit St, Providence'],
  stage: 'ready',
  workflowStatus: 'active',
  sourceLabel: 'frbo',
  segment: 'hot',
  priorityContext: {
    priority: 'P1',
    fitPoints: 24,
    fitBand: 'high',
    timingValue: 31,
    timingBand: 'hot',
    reachability: 'direct',
    dataConfidence: 8,
  },
  priorityReasons: ['Fit high 24/30'],
  nextAction: null,
  optedOut: false,
  cadence: null,
  activities: [],
  conversations: [],
  properties: [],
  history: [],
  revision: 4,
};

const receipt: MutationReceipt = {
  revision: 5,
  affectedPersonIds: ['person-1'],
  affectedSalesCycleIds: ['cycle-1'],
};

const beginCall = {
  channel: 'call' as const,
  personId: 'person-1',
  salesCycleId: 'cycle-1',
  contactMethodId: 'phone-1',
};

const confirmReady = {
  transition: 'review_to_ready' as const,
  salesCycleId: 'cycle-1',
  expectedRevision: 4,
};

function fakeProvider(): LeadDetailProvider {
  return {
    get: vi.fn(async () => detail),
    beginOutbound: vi.fn(async () => receipt),
    confirmTransition: vi.fn(async () => receipt),
  };
}

describe('registerLeadDetailIpc', () => {
  beforeEach(() => {
    electron.handle.mockReset();
    electron.removeHandler.mockReset();
  });

  it('registers exactly the three lead-detail channels', () => {
    registerLeadDetailIpc(fakeProvider());

    const channels = electron.handle.mock.calls.map((call) => call[0]);
    expect(channels).toEqual([
      'lead-detail:get',
      'lead-detail:begin-outbound',
      'lead-detail:confirm-transition',
    ]);
  });

  it('returns the validated detail DTO for a trusted get', async () => {
    const provider = fakeProvider();
    registerLeadDetailIpc(provider);

    const handler = registeredIpcHandler(electron.handle, 'lead-detail:get');
    await expect(
      handler(trustedEvent, { personId: 'person-1' }),
    ).resolves.toEqual(detail);
    expect(provider.get).toHaveBeenCalledWith({ personId: 'person-1' });
  });

  it('rejects an untrusted sender before touching the provider', async () => {
    const provider = fakeProvider();
    registerLeadDetailIpc(provider);

    const handler = registeredIpcHandler(electron.handle, 'lead-detail:get');
    await expect(
      handler(untrustedEvent, { personId: 'person-1' }),
    ).rejects.toThrow('trusted');
    expect(provider.get).not.toHaveBeenCalled();
  });

  it('rejects malformed get requests before the provider runs', async () => {
    const provider = fakeProvider();
    registerLeadDetailIpc(provider);

    const handler = registeredIpcHandler(electron.handle, 'lead-detail:get');
    await expect(
      handler(trustedEvent, { personId: '' }),
    ).rejects.toThrow();
    await expect(
      handler(trustedEvent, { personId: 'person-1', extra: true }),
    ).rejects.toThrow();
    await expect(handler(trustedEvent)).rejects.toThrow();
    expect(provider.get).not.toHaveBeenCalled();
  });

  it('rejects a strict-invalid provider response instead of forwarding it', async () => {
    const provider = fakeProvider();
    (provider.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...detail,
      leadScore: 97,
    });
    registerLeadDetailIpc(provider);

    const handler = registeredIpcHandler(electron.handle, 'lead-detail:get');
    await expect(
      handler(trustedEvent, { personId: 'person-1' }),
    ).rejects.toThrow();
  });

  it('validates channel-discriminated outbound requests', async () => {
    const provider = fakeProvider();
    registerLeadDetailIpc(provider);

    const handler = registeredIpcHandler(
      electron.handle,
      'lead-detail:begin-outbound',
    );
    await expect(handler(trustedEvent, beginCall)).resolves.toEqual(receipt);
    expect(provider.beginOutbound).toHaveBeenCalledWith(beginCall);

    await expect(
      handler(trustedEvent, { ...beginCall, channel: 'carrier_pigeon' }),
    ).rejects.toThrow();
    await expect(
      handler(trustedEvent, { channel: 'call', personId: 'person-1' }),
    ).rejects.toThrow();
    expect(provider.beginOutbound).toHaveBeenCalledTimes(1);
  });

  it('validates transition-discriminated confirm requests', async () => {
    const provider = fakeProvider();
    registerLeadDetailIpc(provider);

    const handler = registeredIpcHandler(
      electron.handle,
      'lead-detail:confirm-transition',
    );
    await expect(handler(trustedEvent, confirmReady)).resolves.toEqual(receipt);
    expect(provider.confirmTransition).toHaveBeenCalledWith(confirmReady);

    // interviewed/offered require the suggestion evidence.
    await expect(
      handler(trustedEvent, {
        transition: 'confirm_interviewed',
        salesCycleId: 'cycle-1',
        expectedRevision: 4,
      }),
    ).rejects.toThrow();
    expect(provider.confirmTransition).toHaveBeenCalledTimes(1);
  });

  it('unregisters all three channels exactly once', () => {
    const unregister = registerLeadDetailIpc(fakeProvider());

    unregister();
    unregister();

    const removed = electron.removeHandler.mock.calls.map((call) => call[0]);
    expect(removed.sort()).toEqual([
      'lead-detail:begin-outbound',
      'lead-detail:confirm-transition',
      'lead-detail:get',
    ]);
    expect(electron.removeHandler).toHaveBeenCalledTimes(3);
  });
});
