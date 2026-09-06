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
export interface OutboundReadinessPort {
  getCapability(): Capability;
  check(personId: string, signal: AbortSignal): Promise<
    { kind: 'ready' } | { kind: 'blocked'; reasonCode: OutboundReason }
  >;
}
export interface OutboundCommandServiceApi {
  beginOutbound(request: OutboundRequest): Promise<OutboundReceipt>;
  getCapabilities(): Promise<OutboundCapabilities>;
  invalidate(reason: 'wake' | 'lock' | 'restore' | 'shutdown'): void;
  resumeAfterUnlock(): void;
  dispose(): void;
}
