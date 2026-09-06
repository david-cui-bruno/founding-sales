import type { OutboundReceipt } from '../../../shared/contracts/outboundContract';
import { useEffect } from 'react';

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
import type { LeadDetailState, OutboundStatusPresentation } from './useLeadInspector';

export type LeadFullPageProps = OutboundStatusPresentation & {
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
  onClose?(): void;
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
  ...outboundPresentation
}: LeadFullPageProps) {
  useEffect(() => {
    if (onClose === undefined) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  if (state.status === 'loading') {
    return (
      <div className="lead-full-page">
        {outboundPresentation.outboundStatus}
        <LoadingState label="Loading lead details" />
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="lead-full-page">
        {outboundPresentation.outboundStatus}
        <ErrorState
          title="Couldn't load this lead"
          description="The details were unavailable. Try again."
          onRetry={onRetry}
        />
      </div>
    );
  }

  if (state.status !== 'ready') {
    return null;
  }

  return (
    <article
      className="lead-full-page"
      aria-label={`${state.detail.personName} full page`}
    >
      {outboundPresentation.outboundStatus}
      <InspectorHeader detail={state.detail} onClose={onClose} />
      {outcomeApi !== undefined && onOutcomeSaved !== undefined && (
        <CallOutcomeSection
          key={`${state.detail.personId}:${state.detail.salesCycleId}:${outboundCommandId ?? "unlinked"}`}
          outboundCommandId={outboundCommandId}
          detail={state.detail}
          api={outcomeApi}
          onSaved={onOutcomeSaved}
        />
      )}
      <InspectorTabs
              {...outboundPresentation}
        key={state.detail.personId}
        detail={state.detail}
        onBeginOutbound={onBeginOutbound}
        onConfirmTransition={onConfirmTransition}
        onDismissLead={onDismissLead}
        onOverrideCloudScore={onOverrideCloudScore}
        onFindContactInfo={onFindContactInfo}
      />
    </article>
  );
}
