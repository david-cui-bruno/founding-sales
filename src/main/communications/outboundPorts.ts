import type { Capability, HandoffResult, OutboundReason } from '../../shared/contracts/outboundContract';

export interface PhoneHandoffPort {
  inspectCapability(): Promise<Capability>;
  // Starts the fixed handoff synchronously. The Promise only observes its reply.
  dispatch(canonicalPhone: string): Promise<HandoffResult>;
}
export type OutboundSubject = Readonly<{ kind: 'person' | 'account'; id: string }>;
export type OutboundReadinessProof = Readonly<{
  subject: OutboundSubject;
  registryRevision: number;
  checkpoints: readonly Readonly<{ adapterId: string; revision: string }>[];
}>;
export type OutboundReadinessResult =
  | Readonly<{ kind: 'ready'; proof: OutboundReadinessProof }>
  | Readonly<{ kind: 'blocked'; reasonCode: OutboundReason }>;
export interface OutboundReadinessPort {
  getCapability(): Capability;
  check(personId: string, signal: AbortSignal): Promise<OutboundReadinessResult>;
  assertCurrent(proof: OutboundReadinessProof): void;
}
