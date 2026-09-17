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
    {
      contactSnapshot: 'a'.repeat(64),
      id: 'phone-1', kind: 'phone', value: '+14015550100', label: null, valid: true,
      validationState: 'valid', reachability: 'none', sourceLabel: null, vendorRank: null,
      phoneKind: null, ownershipState: 'unknown', evidenceObservedAt: null,
      compliance: {
        status: 'verified_clear', label: 'Verified clear until Sep 15, 2026',
        expiresAt: '2026-09-15T00:00:00.000Z',
        callRefusalReason: null, textRefusalReason: null,
      },
    },
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
  cloudScores: null,
  cloudLinked: false,
  findContactEligibility: { eligible: false, refusalReason: 'qualification_required' },
  nextAction: null,
  optedOut: false,
  cadence: null,
  outboundAttempts: [],
  activities: [],
  conversations: [],
  properties: [],
  history: [],
  revision: 4,
};

const removedCommandChannels = [
  'lead-detail:begin-outbound',
  'lead-detail:outbound-capabilities',
  'lead-detail:confirm-transition',
  'lead-detail:dismiss',
  'lead-detail:cloud-score-override',
  'lead-detail:find-contact-info',
];

function fakeProvider(): LeadDetailProvider {
  return {
    get: vi.fn(async () => detail),
  };
}

describe('registerLeadDetailIpc', () => {
  beforeEach(() => {
    electron.handle.mockReset();
    electron.removeHandler.mockReset();
  });

  it('registers exactly the one lead-detail:get channel', () => {
    registerLeadDetailIpc(fakeProvider());

    const channels = electron.handle.mock.calls.map((call) => call[0]);
    expect(channels).toEqual(['lead-detail:get']);
    for (const channel of removedCommandChannels) {
      expect(() => registeredIpcHandler(electron.handle, channel)).toThrow('was not registered');
    }
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

  it('unregisters the single channel exactly once', () => {
    const unregister = registerLeadDetailIpc(fakeProvider());

    unregister();
    unregister();

    expect(electron.removeHandler.mock.calls.map((call) => call[0])).toEqual(['lead-detail:get']);
    expect(electron.removeHandler).toHaveBeenCalledTimes(1);
  });
});
