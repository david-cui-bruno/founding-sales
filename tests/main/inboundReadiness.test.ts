import { describe, expect, it, vi } from 'vitest';
import { createInboundReadiness, type InboundAdapter, type InboundRegistry } from '../../src/main/communications/inboundReadiness';
import type { Capability } from '../../src/shared/contracts/outboundContract';

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
