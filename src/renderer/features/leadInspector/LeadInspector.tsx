import { useEffect, useId, useRef, useState } from 'react';

import type {
  BeginOutboundRequest,
  ConfirmTransitionRequest,
  LeadDetail,
} from '../../../shared/contracts/leadDetailContract';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { InspectorActivity } from './InspectorActivity';
import { InspectorConversation } from './InspectorConversation';
import { InspectorHeader } from './InspectorHeader';
import { InspectorHistory } from './InspectorHistory';
import { InspectorOverview } from './InspectorOverview';
import { InspectorProperties } from './InspectorProperties';
import type { LeadDetailState } from './useLeadInspector';
import { useResizableInspector } from './useResizableInspector';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'activity', label: 'Activity' },
  { id: 'conversations', label: 'Conversations' },
  { id: 'properties', label: 'Properties' },
  { id: 'history', label: 'History' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export type InspectorTabsProps = {
  detail: LeadDetail;
  onBeginOutbound(request: BeginOutboundRequest): void;
  onConfirmTransition(request: ConfirmTransitionRequest): void;
};

/**
 * Shared tab sections for both the docked inspector and the full page so the
 * two views never diverge. Arrow keys cycle the tabs with wraparound.
 */
export function InspectorTabs({
  detail,
  onBeginOutbound,
  onConfirmTransition,
}: InspectorTabsProps) {
  const [selected, setSelected] = useState<TabId>('overview');
  const idPrefix = useId();
  const tabRefs = useRef(new Map<TabId, HTMLButtonElement>());

  const moveSelection = (delta: number) => {
    const index = TABS.findIndex((tab) => tab.id === selected);
    const next = TABS[(index + delta + TABS.length) % TABS.length];
    setSelected(next.id);
    tabRefs.current.get(next.id)?.focus();
  };

  const onTabListKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setSelected(TABS[0].id);
      tabRefs.current.get(TABS[0].id)?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      const last = TABS[TABS.length - 1];
      setSelected(last.id);
      tabRefs.current.get(last.id)?.focus();
    }
  };

  return (
    <div className="lead-inspector__tabs">
      <div
        role="tablist"
        aria-label="Lead sections"
        className="lead-inspector__tablist"
        onKeyDown={onTabListKeyDown}
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            ref={(element) => {
              if (element === null) {
                tabRefs.current.delete(tab.id);
              } else {
                tabRefs.current.set(tab.id, element);
              }
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.id}`}
            aria-selected={selected === tab.id}
            aria-controls={`${idPrefix}-panel-${tab.id}`}
            tabIndex={selected === tab.id ? 0 : -1}
            className="lead-inspector__tab"
            onClick={() => setSelected(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${idPrefix}-panel-${selected}`}
        aria-labelledby={`${idPrefix}-tab-${selected}`}
        className="lead-inspector__tabpanel"
      >
        {selected === 'overview' && (
          <InspectorOverview
            detail={detail}
            onBeginOutbound={onBeginOutbound}
            onConfirmTransition={onConfirmTransition}
          />
        )}
        {selected === 'activity' && (
          <InspectorActivity activities={detail.activities} />
        )}
        {selected === 'conversations' && (
          <InspectorConversation conversations={detail.conversations} />
        )}
        {selected === 'properties' && (
          <InspectorProperties properties={detail.properties} />
        )}
        {selected === 'history' && <InspectorHistory history={detail.history} />}
      </div>
    </div>
  );
}

export type LeadInspectorProps = {
  state: LeadDetailState;
  onClose(): void;
  onRetry(): void;
  onOpenFullPage(personId: string): void;
  onBeginOutbound(request: BeginOutboundRequest): void;
  onConfirmTransition(request: ConfirmTransitionRequest): void;
};

/**
 * The single right-docked lead panel: resizable within 380-640 px, labelled
 * with the person's name, closed by Escape, safe for loading and error states.
 */
export function LeadInspector({
  state,
  onClose,
  onRetry,
  onOpenFullPage,
  onBeginOutbound,
  onConfirmTransition,
}: LeadInspectorProps) {
  const resize = useResizableInspector();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const label =
    state.status === 'ready'
      ? `${state.detail.personName} details`
      : 'Lead details';

  return (
    <aside
      className="lead-inspector"
      aria-label={label}
      style={{ width: `${resize.width}px` }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize inspector"
        aria-valuenow={resize.width}
        aria-valuemin={resize.minWidth}
        aria-valuemax={resize.maxWidth}
        tabIndex={0}
        className="lead-inspector__resize-handle"
        onKeyDown={resize.onSeparatorKeyDown}
        onPointerDown={resize.onSeparatorPointerDown}
      />
      <div className="lead-inspector__body">
        {state.status === 'loading' && (
          <LoadingState label="Loading lead details" />
        )}
        {state.status === 'error' && (
          <ErrorState
            title="Couldn't load this lead"
            description="The details were unavailable. Try again."
            onRetry={onRetry}
          />
        )}
        {state.status === 'ready' && (
          <>
            <InspectorHeader
              detail={state.detail}
              onClose={onClose}
              onOpenFullPage={() => onOpenFullPage(state.detail.personId)}
            />
            <InspectorTabs
              key={state.detail.personId}
              detail={state.detail}
              onBeginOutbound={onBeginOutbound}
              onConfirmTransition={onConfirmTransition}
            />
          </>
        )}
      </div>
    </aside>
  );
}
