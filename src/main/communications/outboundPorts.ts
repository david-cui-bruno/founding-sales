import type { MutationReceipt } from '../../shared/contracts/commonContract';
import type {
  Capability, HandoffResult, OutboundCapabilities, OutboundReason, OutboundReceipt, OutboundRequest,
} from '../../shared/contracts/outboundContract';

export type Preparation =
  | Readonly<{ kind: 'dispatch'; canonicalPhone: string; mutation: MutationReceipt }>
  | Readonly<{ kind: 'receipt'; receipt: OutboundReceipt }>;
export interface OutboundDomainPort {
  inspectOutboundCommand(request: OutboundRequest): OutboundReceipt | null;
  prepareOutboundDispatch(request: OutboundRequest): Preparation;
  recordOutboundResult(request: OutboundRequest, result: HandoffResult): OutboundReceipt;
  recordOutboundRefusal(request: OutboundRequest, reason: OutboundReason): OutboundReceipt;
}
export interface OutboundDomainGate {
  withDomain<T>(operation: (domain: OutboundDomainPort) => T): Promise<T>;
}
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
export interface OutboundCommandServiceApi {
  beginOutbound(request: OutboundRequest): Promise<OutboundReceipt>;
  getCapabilities(): Promise<OutboundCapabilities>;
  invalidate(reason: 'wake' | 'lock' | 'restore' | 'shutdown'): void;
  resumeAfterUnlock(): void;
  dispose(): void;
}
