import type { OutboundReceipt } from '../../../shared/contracts/outboundContract';
import { useRef } from 'react';
import { useDismissibleLayer } from '../../app/overlayLayers';

import type {
  FindContactInfoReceipt,
  FindContactInfoRequest,
} from '../../../shared/contracts/enrichmentRequestContract';
import type {
  BeginOutboundRequest,
  CloudScoreOverrideRequest,
  ConfirmTransitionRequest,
  DismissLeadRequest,
} from '../../../shared/contracts/leadDetailContract';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { CallOutcomeSection, type CallOutcomeApi } from './CallOutcomeSection';
import { InspectorHeader } from './InspectorHeader';
import { InspectorTabs } from './LeadInspector';
import type { LeadDetailState, OutboundStatusPresentation, DiscoveryPresentation, ReviewPresentation } from './useLeadInspector';

export type LeadFullPageProps = OutboundStatusPresentation & DiscoveryPresentation & ReviewPresentation & {
  state: LeadDetailState;
  onRetry(): void;
  onBeginOutbound(request: BeginOutboundRequest): Promise<OutboundReceipt>;
  onConfirmTransition(request: ConfirmTransitionRequest): void;
  onDismissLead(request: DismissLeadRequest): void;
  onOverrideCloudScore(request: CloudScoreOverrideRequest): void;
  onFindContactInfo?(request: FindContactInfoRequest): Promise<FindContactInfoReceipt>;
  /** Present when the call-outcome flow is available (audit 4.7). */
  outcomeApi?: CallOutcomeApi;
  outboundCommandId?: string;
  /** Save & next: the next queue lead, or null when the queue is done. */
  onOutcomeSaved?(nextPersonId: string | null): void;
  /** Escape returns to the queue without logging anything. */
  onClose(): void;
  returnFocus?: () => HTMLElement | null;
};

/**
 * Full-width promotion of the same lead detail DTO. Reuses the inspector
 * header and tab sections so the two presentations cannot diverge; the
 * call flow appends the outcome section above the tabs.
 */
export function LeadFullPage({
  state,
  onRetry,
  onBeginOutbound,
  onConfirmTransition,
  onDismissLead,
  onOverrideCloudScore,
  onFindContactInfo,
  outcomeApi, outboundCommandId,
  onOutcomeSaved,
  onClose,
  returnFocus,
  ...outboundPresentation
}: LeadFullPageProps) {
  const elementRef = useRef<HTMLElement>(null);
  const layer = useDismissibleLayer({ open: true, kind: 'nonmodal', elementRef, canDismiss: () => true, onDismiss: onClose, returnFocus });

  return (
    <article
      ref={elementRef}
      className="lead-full-page"
      aria-label={state.status === 'ready' ? `${state.detail.personName} full page` : 'Lead details'}
    >
      {outboundPresentation.outboundStatus}
      <InspectorHeader detail={state.status === 'ready' ? state.detail : null} onClose={() => { layer.requestDismiss('close-button'); }} />
      {state.status === 'loading' && <LoadingState label="Loading lead details" />}
      {state.status === 'error' && <ErrorState title="Couldn't load this lead" description="The details were unavailable. Try again." onRetry={onRetry} />}
      {state.status === 'ready' && (
      <InspectorTabs
        activityTools={outcomeApi !== undefined && onOutcomeSaved !== undefined ? <CallOutcomeSection
          key={`${state.detail.personId}:${state.detail.salesCycleId}:${outboundCommandId ?? 'unlinked'}`}
          outboundCommandId={outboundCommandId} detail={state.detail} api={outcomeApi} onSaved={onOutcomeSaved} /> : undefined}
              {...outboundPresentation}
        key={state.detail.personId}
        detail={state.detail}
        onBeginOutbound={onBeginOutbound}
        onConfirmTransition={onConfirmTransition}
        onDismissLead={onDismissLead}
        onOverrideCloudScore={onOverrideCloudScore}
        onFindContactInfo={onFindContactInfo}
      />
      )}
    </article>
  );
}
