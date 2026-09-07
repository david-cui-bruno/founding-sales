import type { ReactNode } from 'react';
import type { OutboundReceipt, OutboundCapabilities } from '../../../shared/contracts/outboundContract';
import { createContext, useContext } from 'react';

import type { MutationReceipt } from '../../../shared/contracts/commonContract';
import type {
  FindContactInfoReceipt,
  FindContactInfoRequest,
} from '../../../shared/contracts/enrichmentRequestContract';
import type {
  BeginOutboundRequest,
  CloudScoreOverrideRequest,
  ConfirmTransitionRequest,
  DismissLeadRequest,
  LeadDetail,
  LeadDetailRequest,
} from '../../../shared/contracts/leadDetailContract';

/** Injected transport. The inspector never touches Electron directly. */
export type LeadDetailApi = {
  get(input: LeadDetailRequest): Promise<LeadDetail>;
  beginOutbound(input: BeginOutboundRequest): Promise<OutboundReceipt>;
  getOutboundCapabilities(): Promise<OutboundCapabilities>;
  confirmTransition(input: ConfirmTransitionRequest): Promise<MutationReceipt>;
  dismissLead(input: DismissLeadRequest): Promise<MutationReceipt>;
  overrideCloudScore(input: CloudScoreOverrideRequest): Promise<MutationReceipt>;
  findContactInfo(input: FindContactInfoRequest): Promise<FindContactInfoReceipt>;
};

export type LeadDetailState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; detail: LeadDetail };

/**
 * How a list route hands the inspector its current ordering: given the person
 * just reviewed, return the next person to open, or null at the end. The
 * resolver may also refresh its own list.
 */
export type ReviewAdvanceResolver = (personId: string) => string | null;

export type LeadInspectorHandle = {
  /** Replaces the current selection; the app never stacks inspectors. */
  openLead(personId: string): void;
  /** Promotes a person to the full page view using the same detail DTO. */
  openFullPage(personId: string, options?: { refresh: boolean }): void;
  closeLead(): void;
  selectedPersonId: string | null;
  /**
   * Registers (or clears with null) the active list's next-lead resolver so
   * Mark ready / Dismiss can keep the founder in flow. Last writer wins:
   * only the route that owns the visible list should register.
   */
  setReviewAdvance(resolver: ReviewAdvanceResolver | null): void;
};

export const LeadInspectorContext = createContext<LeadInspectorHandle | null>(
  null,
);

export function useLeadInspector(): LeadInspectorHandle {
  const handle = useContext(LeadInspectorContext);

  if (handle === null) {
    throw new Error(
      'useLeadInspector must be used within a LeadInspectorProvider.',
    );
  }

  return handle;
}

/**
 * Optional variant for components that also render outside the provider
 * (for example in isolated tests): returns null instead of throwing.
 */
export function useLeadInspectorIfAvailable(): LeadInspectorHandle | null {
  return useContext(LeadInspectorContext);
}

/** Shared presentation inputs. The provider owns request lifetime and receipts. */
export type OutboundPresentation = {
  capabilities?: OutboundCapabilities | null;
  outboundPending?: boolean;
  outboundBlocked?: boolean;
  onLogPastActivity?(commandId?: string): void;
};
export type OutboundStatusPresentation = OutboundPresentation & { outboundStatus?: ReactNode };

/** Discovery and manual evidence are injected separately from outbound execution. */
export type DiscoveryPresentation = {
  discoveryEvidence?: ReactNode;
  pastActivityControls?: ReactNode;
};
