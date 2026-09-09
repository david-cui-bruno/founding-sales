import type { Capability } from '../../shared/contracts/outboundContract';
import type {
  OutboundReadinessPort, OutboundReadinessProof, OutboundReadinessResult, OutboundSubject,
} from './outboundPorts';

export type { OutboundSubject } from './outboundPorts';
export type InboundReadiness = OutboundReadinessPort & {
  checkSubject(subject: OutboundSubject, signal: AbortSignal): Promise<OutboundReadinessResult>;
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
const available: Capability = Object.freeze({ state: 'available', reasonCode: null });
const unavailable: Capability = Object.freeze({ state: 'unavailable', reasonCode: 'inbound_safety_unwired' });

function freezeProof(input: {
  subject: OutboundSubject; registryRevision: number; checkpoints: readonly { adapterId: string; revision: string }[];
}): OutboundReadinessProof {
  return Object.freeze({
    subject: Object.freeze({ kind: input.subject.kind, id: input.subject.id }),
    registryRevision: input.registryRevision,
    checkpoints: Object.freeze(input.checkpoints.map((checkpoint) => Object.freeze({ ...checkpoint }))),
  });
}

function assertUniqueAdapterIds(adapterIds: readonly string[]): void {
  if (new Set(adapterIds).size !== adapterIds.length) throw new Error('Inbound readiness proof is not current.');
}

export function createInboundReadiness(registry: InboundRegistry): InboundReadiness {
  function assertCurrent(proof: OutboundReadinessProof): void {
    const after = registry.snapshot();
    if (!after.initialized || after.revision !== proof.registryRevision) throw new Error('Inbound readiness proof is not current.');
    const relevant = after.adapters.filter((adapter) => adapter.relevant(proof.subject));
    const relevantIds = relevant.map((adapter) => adapter.id);
    const proofIds = proof.checkpoints.map((checkpoint) => checkpoint.adapterId);
    assertUniqueAdapterIds(relevantIds);
    assertUniqueAdapterIds(proofIds);
    if (relevantIds.length !== proofIds.length) throw new Error('Inbound readiness proof is not current.');
    const checkpoints = new Map(proof.checkpoints.map((checkpoint) => [checkpoint.adapterId, checkpoint.revision]));
    for (const adapter of relevant) {
      const revision = checkpoints.get(adapter.id);
      if (revision === undefined || !adapter.isAppliedCurrent(proof.subject, revision)) {
        throw new Error('Inbound readiness proof is not current.');
      }
    }
  }

  async function checkSubject(subject: OutboundSubject, signal: AbortSignal): Promise<OutboundReadinessResult> {
    try {
      const before = registry.snapshot();
      if (!before.initialized || signal.aborted) return blocked;
      const relevant = before.adapters.filter((adapter) => adapter.relevant(subject));
      assertUniqueAdapterIds(relevant.map((adapter) => adapter.id));
      const checkpoints = await Promise.all(relevant.map(async (adapter) => ({
        adapterId: adapter.id,
        revision: (await adapter.synchronize(subject, signal)).revision,
      })));
      const proof = freezeProof({ subject, registryRevision: before.revision, checkpoints });
      assertCurrent(proof);
      return signal.aborted ? blocked : { kind: 'ready', proof };
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
    assertCurrent,
    checkSubject,
  };
}
