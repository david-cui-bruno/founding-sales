import type {
  BeginOutboundRequest,
  CloudScoreOverrideRequest,
  ConfirmTransitionRequest,
  DismissLeadRequest,
} from '../../../shared/contracts/leadDetailContract';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { InspectorHeader } from './InspectorHeader';
import { InspectorTabs } from './LeadInspector';
import type { LeadDetailState } from './useLeadInspector';

export type LeadFullPageProps = {
  state: LeadDetailState;
  onRetry(): void;
  onBeginOutbound(request: BeginOutboundRequest): void;
  onConfirmTransition(request: ConfirmTransitionRequest): void;
  onDismissLead(request: DismissLeadRequest): void;
  onOverrideCloudScore(request: CloudScoreOverrideRequest): void;
};

/**
 * Full-width promotion of the same lead detail DTO. Reuses the inspector
 * header and tab sections so the two presentations cannot diverge.
 */
export function LeadFullPage({
  state,
  onRetry,
  onBeginOutbound,
  onConfirmTransition,
  onDismissLead,
  onOverrideCloudScore,
}: LeadFullPageProps) {
  if (state.status === 'loading') {
    return (
      <div className="lead-full-page">
        <LoadingState label="Loading lead details" />
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="lead-full-page">
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
      <InspectorHeader detail={state.detail} />
      <InspectorTabs
        key={state.detail.personId}
        detail={state.detail}
        onBeginOutbound={onBeginOutbound}
        onConfirmTransition={onConfirmTransition}
        onDismissLead={onDismissLead}
        onOverrideCloudScore={onOverrideCloudScore}
      />
    </article>
  );
}
