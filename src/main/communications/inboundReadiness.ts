import type { Capability } from '../../shared/contracts/outboundContract';
import type { OutboundReadinessPort } from './outboundPorts';

export type OutboundSubject = { kind: 'person' | 'account'; id: string };
export type InboundReadiness = OutboundReadinessPort & {
  checkSubject(subject: OutboundSubject, signal: AbortSignal): ReturnType<OutboundReadinessPort['check']>;
};
export type InboundAdapter = Readonly<{
  id: string;
  relevant(subject: OutboundSubject): boolean;
  synchronize(subject: OutboundSubject, signal: AbortSignal): Promise<{ revision: string }>;
  isAppliedCurrent(subject: OutboundSubject, revision: string): boolean;
}>;
export interface InboundRegistry {
  snapshot(): { initialized: boolean; revision: number; adapters: readonly InboundAdapter[] };
}

const blocked = Object.freeze({ kind: 'blocked' as const, reasonCode: 'inbound_safety_unwired' as const });
const ready = Object.freeze({ kind: 'ready' as const });
const available: Capability = Object.freeze({ state: 'available', reasonCode: null });
const unavailable: Capability = Object.freeze({ state: 'unavailable', reasonCode: 'inbound_safety_unwired' });

export function createInboundReadiness(registry: InboundRegistry): InboundReadiness {
  async function checkSubject(subject: OutboundSubject, signal: AbortSignal): ReturnType<OutboundReadinessPort['check']> {
    try {
      const before = registry.snapshot();
      if (!before.initialized || signal.aborted) return blocked;
      const relevant = before.adapters.filter((adapter) => adapter.relevant(subject));
      const checkpoints = await Promise.all(relevant.map(async (adapter) => ({
        adapter,
        checkpoint: await adapter.synchronize(subject, signal),
      })));
      const after = registry.snapshot();
      const current = after.initialized && before.revision === after.revision && !signal.aborted
        && checkpoints.every(({ adapter, checkpoint }) => adapter.isAppliedCurrent(subject, checkpoint.revision));
      return current ? ready : blocked;
    } catch {
      return blocked;
    }
  }

  return {
    getCapability(): Capability {
      try {
        return registry.snapshot().initialized ? available : unavailable;
      } catch {
        return unavailable;
      }
    },
    check(personId: string, signal: AbortSignal) {
      return checkSubject({ kind: 'person', id: personId }, signal);
    },
    checkSubject,
  };
}
