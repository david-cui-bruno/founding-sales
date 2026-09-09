import { describe, expect, it, vi } from 'vitest';
import { createInboundReadiness, type InboundAdapter, type InboundRegistry } from '../../src/main/communications/inboundReadiness';
import { createOutboundCommandService } from '../../src/main/communications/outboundCommandService';
import type { OutboundDomainGate, OutboundDomainPort, PhoneHandoffPort } from '../../src/main/communications/outboundPorts';
import type { Capability, HandoffResult, OutboundReceipt, OutboundRequest } from '../../src/shared/contracts/outboundContract';

const request: OutboundRequest = {
  commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  channel: 'call',
  personId: 'person-1',
  salesCycleId: 'sales-1',
  contactMethodId: 'contact-1',
  expectedContactSnapshot: 'a'.repeat(64),
};
const mutation = { revision: 1, affectedPersonIds: ['person-1'], affectedSalesCycleIds: ['sales-1'] };
const accepted: HandoffResult = { status: 'handoff_accepted', reasonCode: null };
const available: Capability = { state: 'available', reasonCode: null };
const blocked = { kind: 'blocked' as const, reasonCode: 'inbound_safety_unwired' as const };

function registry(input: { initialized: boolean; revision?: number; adapters?: readonly InboundAdapter[] }): InboundRegistry {
  return { snapshot: () => ({ initialized: input.initialized, revision: input.revision ?? 0, adapters: input.adapters ?? [] }) };
}

function adapter(overrides: Partial<InboundAdapter> = {}): InboundAdapter {
  return {
    id: 'inbound-fixture',
    relevant: vi.fn(() => true),
    synchronize: vi.fn(async () => ({ revision: 'r1' })),
    isAppliedCurrent: vi.fn(() => true),
    ...overrides,
  };
}

function serviceFixture(readiness = createInboundReadiness(registry({ initialized: true }))) {
  const dispatch = vi.fn<PhoneHandoffPort['dispatch']>(async () => accepted);
  const phone: PhoneHandoffPort = { inspectCapability: vi.fn(async () => available), dispatch };
  const receipt = (result: HandoffResult): OutboundReceipt => ({ ...result, commandId: request.commandId, channel: request.channel, mutation });
  const domainPort: OutboundDomainPort = {
    inspectOutboundCommand: vi.fn(() => null),
    prepareOutboundDispatch: vi.fn<OutboundDomainPort['prepareOutboundDispatch']>(() => ({ kind: 'dispatch', canonicalPhone: '+12025550123', mutation })),
    recordOutboundResult: vi.fn((_, result) => receipt(result)),
    recordOutboundRefusal: vi.fn((_, reasonCode) => receipt({ status: reasonCode === 'inbound_safety_unwired' ? 'unavailable' : 'refused', reasonCode })),
  };
  const domain: OutboundDomainGate = { withDomain: async (operation) => operation(domainPort) };
  const service = createOutboundCommandService({ domain, phone, readiness });
  return { service, phone, domainPort };
}

describe('inbound readiness barrier', () => {
  it('blocks uninitialized registries and reports unavailable capability', async () => {
    const readiness = createInboundReadiness(registry({ initialized: false }));

    await expect(readiness.check('person-1', new AbortController().signal)).resolves.toEqual(blocked);
    expect(readiness.getCapability()).toEqual({ state: 'unavailable', reasonCode: 'inbound_safety_unwired' });
  });

  it('allows initialized empty registries and reports available capability', async () => {
    const readiness = createInboundReadiness(registry({ initialized: true }));

    await expect(readiness.check('person-1', new AbortController().signal)).resolves.toEqual({ kind: 'ready' });
    expect(readiness.getCapability()).toEqual(available);
  });

  it('blocks dispatch through the actual command service when a relevant adapter rejects', async () => {
    const readiness = createInboundReadiness(registry({
      initialized: true,
      adapters: [adapter({ synchronize: vi.fn(async () => { throw new Error('fictional sync rejection'); }) })],
    }));
    const f = serviceFixture(readiness);

    await expect(f.service.beginOutbound(request)).resolves.toMatchObject({ status: 'unavailable', reasonCode: 'inbound_safety_unwired' });
    expect(f.phone.dispatch).not.toHaveBeenCalled();
    expect(f.domainPort.prepareOutboundDispatch).not.toHaveBeenCalled();
  });

  it('blocks when opt-out evidence is applied during synchronization', async () => {
    let optedOut = false;
    const readiness = createInboundReadiness(registry({
      initialized: true,
      adapters: [adapter({ synchronize: vi.fn(async () => { optedOut = true; return { revision: 'r1' }; }), isAppliedCurrent: vi.fn(() => !optedOut) })],
    }));

    await expect(readiness.check('person-1', new AbortController().signal)).resolves.toEqual(blocked);
  });

  it('blocks when registry revision changes while synchronizing', async () => {
    let revision = 1;
    const readiness = createInboundReadiness({
      snapshot: () => ({ initialized: true, revision, adapters: [adapter({ synchronize: vi.fn(async () => { revision = 2; return { revision: 'r1' }; }) })] }),
    });

    await expect(readiness.check('person-1', new AbortController().signal)).resolves.toEqual(blocked);
  });

  it('blocks when the signal is already aborted or aborts before final checks', async () => {
    const before = new AbortController();
    before.abort();
    await expect(createInboundReadiness(registry({ initialized: true })).check('person-1', before.signal)).resolves.toEqual(blocked);

    const during = new AbortController();
    const readiness = createInboundReadiness(registry({
      initialized: true,
      adapters: [adapter({ synchronize: vi.fn(async () => { during.abort(); return { revision: 'r1' }; }) })],
    }));
    await expect(readiness.check('person-1', during.signal)).resolves.toEqual(blocked);
  });

  it('blocks stale checkpoints and requires fresh synchronization on each attempt', async () => {
    let syncCount = 0;
    const synchronize = vi.fn<InboundAdapter['synchronize']>(async () => {
      syncCount += 1;
      return { revision: `r${syncCount}` };
    });
    const isAppliedCurrent = vi.fn<InboundAdapter['isAppliedCurrent']>((_, revision) => revision === `r${syncCount}`);
    const readiness = createInboundReadiness(registry({ initialized: true, adapters: [adapter({ synchronize, isAppliedCurrent })] }));

    await expect(readiness.check('person-1', new AbortController().signal)).resolves.toEqual({ kind: 'ready' });
    await expect(readiness.checkSubject({ kind: 'account', id: 'account-1' }, new AbortController().signal)).resolves.toEqual({ kind: 'ready' });
    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(synchronize.mock.calls[0][0]).toEqual({ kind: 'person', id: 'person-1' });
    expect(synchronize.mock.calls[1][0]).toEqual({ kind: 'account', id: 'account-1' });

    const stale = createInboundReadiness(registry({ initialized: true, adapters: [adapter({ isAppliedCurrent: vi.fn(() => false) })] }));
    await expect(stale.check('person-1', new AbortController().signal)).resolves.toEqual(blocked);
  });
});
