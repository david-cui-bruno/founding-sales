import { createContext, useContext } from 'react';

import type { MutationReceipt } from '../../../shared/contracts/commonContract';
import type {
  BeginOutboundRequest,
  ConfirmTransitionRequest,
  LeadDetail,
  LeadDetailRequest,
} from '../../../shared/contracts/leadDetailContract';

/** Injected transport. The inspector never touches Electron directly. */
export type LeadDetailApi = {
  get(input: LeadDetailRequest): Promise<LeadDetail>;
  beginOutbound(input: BeginOutboundRequest): Promise<MutationReceipt>;
  confirmTransition(input: ConfirmTransitionRequest): Promise<MutationReceipt>;
};

export type LeadDetailState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; detail: LeadDetail };

export type LeadInspectorHandle = {
  /** Replaces the current selection; the app never stacks inspectors. */
  openLead(personId: string): void;
  /** Promotes a person to the full page view using the same detail DTO. */
  openFullPage(personId: string): void;
  closeLead(): void;
  selectedPersonId: string | null;
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
