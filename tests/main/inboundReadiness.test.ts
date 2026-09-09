import { describe, expect, it, vi } from 'vitest';
import { createInboundReadiness, type InboundAdapter, type InboundRegistry } from '../../src/main/communications/inboundReadiness';
import { createOutboundCommandService } from '../../src/main/communications/outboundCommandService';
import { OutboundAuthorizationError } from '../../src/main/domain/support/domainErrors';
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

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

function serviceFixture(
  readiness = createInboundReadiness(registry({ initialized: true })),
  options: { beforeFinalDomain?: () => Promise<void> } = {},
) {
  const dispatch = vi.fn<PhoneHandoffPort['dispatch']>(async () => accepted);
  const phone: PhoneHandoffPort = { inspectCapability: vi.fn(async () => available), dispatch };
  const receipt = (result: HandoffResult): OutboundReceipt => ({ ...result, commandId: request.commandId, channel: request.channel, mutation });
  const domainPort: OutboundDomainPort = {
    inspectOutboundCommand: vi.fn(() => null),
    prepareOutboundDispatch: vi.fn<OutboundDomainPort['prepareOutboundDispatch']>(() => ({ kind: 'dispatch', canonicalPhone: '+12025550123', mutation })),
    recordOutboundResult: vi.fn((_, result) => receipt(result)),
    recordOutboundRefusal: vi.fn((_, reasonCode) => receipt({ status: reasonCode === 'inbound_safety_unwired' ? 'unavailable' : 'refused', reasonCode })),
  };
  let domainEntries = 0;
  const domain: OutboundDomainGate = {
    withDomain: async (operation) => {
      domainEntries += 1;
      if (domainEntries === 2) await options.beforeFinalDomain?.();
      return operation(domainPort);
    },
  };
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

    const result = await readiness.check('person-1', new AbortController().signal);
    expect(result).toMatchObject({
      kind: 'ready',
      proof: { subject: { kind: 'person', id: 'person-1' }, registryRevision: 0, checkpoints: [] },
    });
    if (result.kind === 'ready') {
      expect(Object.isFrozen(result.proof)).toBe(true);
      expect(Object.isFrozen(result.proof.subject)).toBe(true);
      expect(Object.isFrozen(result.proof.checkpoints)).toBe(true);
    }
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

  it('lets current synchronized opt-out evidence reach domain authorization and prevents dispatch', async () => {
    let optedOut = false;
    const readiness = createInboundReadiness(registry({
      initialized: true,
      adapters: [adapter({
        synchronize: vi.fn(async () => {
          optedOut = true;
          return { revision: 'opt-out-applied' };
        }),
        isAppliedCurrent: vi.fn((_, revision) => optedOut && revision === 'opt-out-applied'),
      })],
    }));
    const f = serviceFixture(readiness);
    f.domainPort.prepareOutboundDispatch = vi.fn<OutboundDomainPort['prepareOutboundDispatch']>(() => {
      if (optedOut) throw new OutboundAuthorizationError('person_or_handle_opted_out');
      return { kind: 'dispatch', canonicalPhone: '+12025550123', mutation };
    });

    await expect(f.service.beginOutbound(request)).resolves.toMatchObject({ status: 'refused', reasonCode: 'person_or_handle_opted_out' });
    expect(f.domainPort.prepareOutboundDispatch).toHaveBeenCalledWith(request);
    expect(f.domainPort.recordOutboundRefusal).toHaveBeenCalledWith(request, 'person_or_handle_opted_out');
    expect(f.phone.dispatch).not.toHaveBeenCalled();
  });

  it('refuses without preparing or dispatching when registry changes after readiness before final domain reservation', async () => {
    let revision = 1;
    const adapterFixture = adapter();
    const readiness = createInboundReadiness({
      snapshot: () => ({ initialized: true, revision, adapters: [adapterFixture] }),
    });
    const enteredFinalDomain = deferred<void>();
    const releaseFinalDomain = deferred<void>();
    const f = serviceFixture(readiness, {
      beforeFinalDomain: async () => {
        enteredFinalDomain.resolve();
        await releaseFinalDomain.promise;
      },
    });

    const result = f.service.beginOutbound(request);
    await enteredFinalDomain.promise;
    revision = 2;
    releaseFinalDomain.resolve();

    await expect(result).resolves.toMatchObject({ status: 'unavailable', reasonCode: 'inbound_safety_unwired' });
    expect(f.domainPort.prepareOutboundDispatch).not.toHaveBeenCalled();
    expect(f.phone.dispatch).not.toHaveBeenCalled();
  });

  it('refuses without preparing or dispatching when a checkpoint changes after readiness before final domain reservation', async () => {
    let currentRevision = 'r1';
    const readiness = createInboundReadiness(registry({
      initialized: true,
      revision: 1,
      adapters: [adapter({
        synchronize: vi.fn(async () => ({ revision: currentRevision })),
        isAppliedCurrent: vi.fn((_, revision) => revision === currentRevision),
      })],
    }));
    const enteredFinalDomain = deferred<void>();
    const releaseFinalDomain = deferred<void>();
    const f = serviceFixture(readiness, {
      beforeFinalDomain: async () => {
        enteredFinalDomain.resolve();
        await releaseFinalDomain.promise;
      },
    });

    const result = f.service.beginOutbound(request);
    await enteredFinalDomain.promise;
    currentRevision = 'r2';
    releaseFinalDomain.resolve();

    await expect(result).resolves.toMatchObject({ status: 'unavailable', reasonCode: 'inbound_safety_unwired' });
    expect(f.domainPort.prepareOutboundDispatch).not.toHaveBeenCalled();
    expect(f.phone.dispatch).not.toHaveBeenCalled();
  });

  it('dispatches after a delayed final domain gate when readiness proof remains current', async () => {
    const readiness = createInboundReadiness(registry({ initialized: true, revision: 1, adapters: [adapter()] }));
    const enteredFinalDomain = deferred<void>();
    const releaseFinalDomain = deferred<void>();
    const f = serviceFixture(readiness, {
      beforeFinalDomain: async () => {
        enteredFinalDomain.resolve();
        await releaseFinalDomain.promise;
      },
    });

    const result = f.service.beginOutbound(request);
    await enteredFinalDomain.promise;
    releaseFinalDomain.resolve();

    await expect(result).resolves.toMatchObject({ status: 'handoff_accepted', reasonCode: null });
    expect(f.domainPort.prepareOutboundDispatch).toHaveBeenCalledWith(request);
    expect(f.phone.dispatch).toHaveBeenCalledTimes(1);
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

    await expect(readiness.check('person-1', new AbortController().signal)).resolves.toMatchObject({ kind: 'ready' });
    await expect(readiness.check('person-1', new AbortController().signal)).resolves.toMatchObject({ kind: 'ready' });
    await expect(readiness.checkSubject({ kind: 'account', id: 'account-1' }, new AbortController().signal)).resolves.toMatchObject({ kind: 'ready' });
    expect(synchronize).toHaveBeenCalledTimes(3);
    expect(synchronize.mock.calls[0][0]).toEqual({ kind: 'person', id: 'person-1' });
    expect(synchronize.mock.calls[1][0]).toEqual({ kind: 'person', id: 'person-1' });
    expect(synchronize.mock.calls[2][0]).toEqual({ kind: 'account', id: 'account-1' });

    const stale = createInboundReadiness(registry({ initialized: true, adapters: [adapter({ isAppliedCurrent: vi.fn(() => false) })] }));
    await expect(stale.check('person-1', new AbortController().signal)).resolves.toEqual(blocked);
  });
});
