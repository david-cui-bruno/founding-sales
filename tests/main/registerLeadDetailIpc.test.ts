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

import type { OutboundCapabilities, OutboundReceipt } from '../../src/shared/contracts/outboundContract';
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

const receipt: MutationReceipt = {
  revision: 5,
  affectedPersonIds: ['person-1'],
  affectedSalesCycleIds: ['cycle-1'],
};

const unavailable = { state: 'unavailable', reasonCode: 'not_integrated' } as const;
const capabilities: OutboundCapabilities = { phoneHandoff: unavailable, callObservation: unavailable, recording: unavailable, messagesSend: unavailable, gmailSend: unavailable, managedAudioImport: unavailable, appleTranscriptExtraction: unavailable, localDrafts: true };
const outboundReceipt: OutboundReceipt = { commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', channel: 'call', status: 'handoff_accepted', reasonCode: null, mutation: receipt };

const beginCall = {
  commandId: outboundReceipt.commandId,
  expectedContactSnapshot: 'a'.repeat(64),
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
    beginOutbound: vi.fn(async () => outboundReceipt),
    getOutboundCapabilities: vi.fn(async () => capabilities),
    confirmTransition: vi.fn(async () => receipt),
    dismissLead: vi.fn(async () => receipt),
    overrideCloudScore: vi.fn(async () => receipt),
    findContactInfo: vi.fn(async () => ({ written: false, refusalReason: null })),
  };
}

describe('registerLeadDetailIpc', () => {
  beforeEach(() => {
    electron.handle.mockReset();
    electron.removeHandler.mockReset();
  });

  it('registers exactly the seven lead-detail channels', () => {
    registerLeadDetailIpc(fakeProvider());

    const channels = electron.handle.mock.calls.map((call) => call[0]);
    expect(channels).toEqual([
      'lead-detail:get',
      'lead-detail:begin-outbound',
      'lead-detail:outbound-capabilities',
      'lead-detail:confirm-transition',
      'lead-detail:dismiss',
      'lead-detail:cloud-score-override',
      'lead-detail:find-contact-info',
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
    await expect(handler(trustedEvent, beginCall)).resolves.toEqual(outboundReceipt);
    expect(provider.beginOutbound).toHaveBeenCalledWith(beginCall);

    await expect(
      handler(trustedEvent, { ...beginCall, channel: 'carrier_pigeon' }),
    ).rejects.toThrow();
    await expect(
      handler(trustedEvent, { channel: 'call', personId: 'person-1' }),
    ).rejects.toThrow();
    expect(provider.beginOutbound).toHaveBeenCalledTimes(1);
  });

  it('rejects missing command/snapshot, forged fields and mismatched receipts', async () => {
    const provider = fakeProvider();
    registerLeadDetailIpc(provider);
    const handler = registeredIpcHandler(electron.handle, 'lead-detail:begin-outbound');
    for (const field of ['commandId', 'expectedContactSnapshot']) {
      const invalid: Record<string, unknown> = { ...beginCall };
      delete invalid[field];
      await expect(handler(trustedEvent, invalid)).rejects.toThrow();
    }
    for (const field of ['target', 'body', 'url']) {
      await expect(handler(trustedEvent, { ...beginCall, [field]: 'tel:+14015550100' })).rejects.toThrow();
    }
    expect(provider.beginOutbound).not.toHaveBeenCalled();
    for (const patch of [{ commandId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, { channel: 'text' }, { reasonCode: 'handoff_uncertain' }]) {
      vi.mocked(provider.beginOutbound).mockResolvedValueOnce({ ...outboundReceipt, ...patch } as OutboundReceipt);
      await expect(handler(trustedEvent, beginCall)).rejects.toThrow();
    }
  });

  it('validates strict empty capabilities requests, sender and response', async () => {
    const provider = fakeProvider();
    registerLeadDetailIpc(provider);
    const handler = registeredIpcHandler(electron.handle, 'lead-detail:outbound-capabilities');
    await expect(handler(trustedEvent, {})).resolves.toEqual(capabilities);
    await expect(handler(trustedEvent, { enable: true })).rejects.toThrow();
    await expect(handler(trustedEvent)).rejects.toThrow();
    await expect(handler(untrustedEvent, {})).rejects.toThrow('trusted');
    expect(provider.getOutboundCapabilities).toHaveBeenCalledTimes(1);
    vi.mocked(provider.getOutboundCapabilities).mockResolvedValueOnce({ ...capabilities, localDrafts: false } as never);
    await expect(handler(trustedEvent, {})).rejects.toThrow();
  });

  it.each([2, 4, 7])('rolls back a failed nth (%s) registration in reverse at the handler registry', (nth) => {
    const registry = new Set<string>();
    const order: string[] = [];
    const registrationError = new Error('registration failed');
    const cleanupError = new Error('cleanup failed');
    let count = 0;
    electron.handle.mockImplementation((channel: string) => {
      count += 1;
      if (count === nth) throw registrationError;
      registry.add(channel);
    });
    electron.removeHandler.mockImplementation((channel: string) => {
      registry.delete(channel);
      order.push(channel);
      if (order.length === 1) throw cleanupError;
    });
    let caught: unknown;
    try { registerLeadDetailIpc(fakeProvider()); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([registrationError, cleanupError]);
    expect(registry.size).toBe(0);
    expect(order).toEqual(electron.handle.mock.calls.slice(0, nth - 1).map(([channel]) => channel).reverse());
  });

  it('attempts every reverse cleanup once even when cleanup throws', () => {
    const registry = new Set<string>();
    electron.handle.mockImplementation((channel: string) => registry.add(channel));
    const failure = new Error('remove failed after removal');
    electron.removeHandler.mockImplementation((channel: string) => {
      registry.delete(channel);
      if (channel === 'lead-detail:find-contact-info') throw failure;
    });
    const dispose = registerLeadDetailIpc(fakeProvider());
    expect(dispose).toThrow();
    expect(registry.size).toBe(0);
    expect(electron.removeHandler.mock.calls.map(([channel]) => channel)).toEqual(electron.handle.mock.calls.map(([channel]) => channel).reverse());
    expect(dispose).not.toThrow();
    expect(electron.removeHandler).toHaveBeenCalledTimes(7);
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

  it('validates gate-reason-guarded dismiss requests', async () => {
    const provider = fakeProvider();
    registerLeadDetailIpc(provider);

    const handler = registeredIpcHandler(electron.handle, 'lead-detail:dismiss');
    const dismiss = {
      salesCycleId: 'cycle-1',
      personId: 'person-1',
      qualificationGateReason: 'out_of_area' as const,
      expectedRevision: 4,
    };
    await expect(handler(trustedEvent, dismiss)).resolves.toEqual(receipt);
    expect(provider.dismissLead).toHaveBeenCalledWith(dismiss);

    await expect(
      handler(trustedEvent, { ...dismiss, qualificationGateReason: 'did_not_vibe' }),
    ).rejects.toThrow();
    await expect(
      handler(untrustedEvent, dismiss),
    ).rejects.toThrow('trusted');
    expect(provider.dismissLead).toHaveBeenCalledTimes(1);
  });

  it('validates find-contact-info requests and receipts', async () => {
    const provider = fakeProvider();
    registerLeadDetailIpc(provider);

    const handler = registeredIpcHandler(
      electron.handle,
      'lead-detail:find-contact-info',
    );
    await expect(handler(trustedEvent, { personId: 'person-1' }))
      .resolves.toEqual({ written: false, refusalReason: null });
    expect(provider.findContactInfo).toHaveBeenCalledWith({ personId: 'person-1' });

    await expect(handler(trustedEvent, { personId: '' })).rejects.toThrow();
    await expect(
      handler(trustedEvent, { personId: 'person-1', extra: true }),
    ).rejects.toThrow();
    await expect(handler(untrustedEvent, { personId: 'person-1' }))
      .rejects.toThrow('trusted');
    expect(provider.findContactInfo).toHaveBeenCalledTimes(1);
  });

  it('unregisters all seven channels exactly once', () => {
    const unregister = registerLeadDetailIpc(fakeProvider());

    unregister();
    unregister();

    const removed = electron.removeHandler.mock.calls.map((call) => call[0]);
    expect(removed.sort()).toEqual([
      'lead-detail:begin-outbound',
      'lead-detail:cloud-score-override',
      'lead-detail:confirm-transition',
      'lead-detail:dismiss',
      'lead-detail:find-contact-info',
      'lead-detail:get',
      'lead-detail:outbound-capabilities',
    ]);
    expect(electron.removeHandler).toHaveBeenCalledTimes(7);
  });
});
