import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type {
  FindContactInfoRequest,
} from '../../../shared/contracts/enrichmentRequestContract';
import type {
  BeginOutboundRequest,
  CloudScoreOverrideRequest,
  ConfirmTransitionRequest,
  DismissLeadRequest,
} from '../../../shared/contracts/leadDetailContract';
import type { CallOutcomeApi } from './CallOutcomeSection';
import { LeadFullPage } from './LeadFullPage';
import { LeadInspector } from './LeadInspector';
import {
  LeadInspectorContext,
  type LeadDetailApi,
  type LeadDetailState,
  type LeadInspectorHandle,
  type ReviewAdvanceResolver,
} from './useLeadInspector';
import './leadInspector.css';

export type LeadInspectorProviderProps = {
  api: LeadDetailApi;
  /** Optional Today commands enabling the full page call-outcome flow. */
  outcomeApi?: CallOutcomeApi;
  children: ReactNode;
};

type Selection = {
  personId: string;
  view: 'inspector' | 'page';
};

/**
 * Owns the single global lead selection: which person is open, the async
 * detail state, and whether it renders as the docked inspector or the full
 * page. `openLead` always replaces the current selection; panels never stack.
 */
export function LeadInspectorProvider({
  api,
  outcomeApi,
  children,
}: LeadInspectorProviderProps) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [detailState, setDetailState] = useState<LeadDetailState>({
    status: 'idle',
  });
  const requestSequence = useRef(0);
  const detailStateRef = useRef(detailState);
  detailStateRef.current = detailState;
  // The visible list's next-lead resolver; a ref so registering never
  // re-renders the whole app.
  const reviewAdvanceRef = useRef<ReviewAdvanceResolver | null>(null);

  const fetchDetail = useCallback(
    (personId: string) => {
      requestSequence.current += 1;
      const sequence = requestSequence.current;
      setDetailState({ status: 'loading' });
      api.get({ personId }).then(
        (detail) => {
          if (requestSequence.current === sequence) {
            setDetailState({ status: 'ready', detail });
          }
        },
        () => {
          if (requestSequence.current === sequence) {
            setDetailState({ status: 'error' });
          }
        },
      );
    },
    [api],
  );

  useEffect(
    () => () => {
      // Invalidate in-flight responses once the provider unmounts.
      requestSequence.current += 1;
    },
    [],
  );

  const openWith = useCallback(
    (personId: string, view: Selection['view']) => {
      setSelection({ personId, view });
      const current = detailStateRef.current;
      const alreadyLoaded =
        current.status === 'ready' && current.detail.personId === personId;
      if (!alreadyLoaded) {
        fetchDetail(personId);
      }
    },
    [fetchDetail],
  );

  const openLead = useCallback(
    (personId: string) => openWith(personId, 'inspector'),
    [openWith],
  );

  const openFullPage = useCallback(
    (personId: string) => openWith(personId, 'page'),
    [openWith],
  );

  const closeLead = useCallback(() => {
    requestSequence.current += 1;
    setSelection(null);
    setDetailState({ status: 'idle' });
  }, []);

  const setReviewAdvance = useCallback(
    (resolver: ReviewAdvanceResolver | null) => {
      reviewAdvanceRef.current = resolver;
    },
    [],
  );

  const retry = useCallback(() => {
    setSelection((current) => {
      if (current !== null) {
        fetchDetail(current.personId);
      }
      return current;
    });
  }, [fetchDetail]);

  const refresh = useCallback(
    (personId: string) => {
      setSelection((current) => {
        if (current !== null && current.personId === personId) {
          fetchDetail(personId);
        }
        return current;
      });
    },
    [fetchDetail],
  );

  /**
   * After a review decision, keep the founder in flow: open the next lead in
   * the active list's order, or close at (or without) a list end. Falls back
   * to refetching the current person when no list registered a resolver.
   */
  const advanceAfterReview = useCallback(
    (personId: string) => {
      const resolver = reviewAdvanceRef.current;
      if (resolver === null) {
        refresh(personId);
        return;
      }
      const nextPersonId = resolver(personId);
      if (nextPersonId === null) {
        closeLead();
      } else {
        setSelection((current) => {
          const view = current?.view ?? 'inspector';
          fetchDetail(nextPersonId);
          return { personId: nextPersonId, view };
        });
      }
    },
    [closeLead, fetchDetail, refresh],
  );

  const beginOutbound = useCallback(
    async (request: BeginOutboundRequest) => {
      await api.beginOutbound(request);
      refresh(request.personId);
    },
    [api, refresh],
  );

  const confirmTransition = useCallback(
    async (request: ConfirmTransitionRequest) => {
      await api.confirmTransition(request);
      if (request.transition === 'review_to_ready') {
        // Mark ready is part of the review burn-down: advance to the next
        // lead instead of leaving the founder staring at the same one.
        setSelection((current) => {
          if (current !== null) {
            advanceAfterReview(current.personId);
          }
          return current;
        });
        return;
      }
      setSelection((current) => {
        if (current !== null) {
          fetchDetail(current.personId);
        }
        return current;
      });
    },
    [advanceAfterReview, api, fetchDetail],
  );

  const dismissLead = useCallback(
    async (request: DismissLeadRequest) => {
      await api.dismissLead(request);
      const resolver = reviewAdvanceRef.current;
      if (resolver === null) {
        // The dismissed lead left the actionable list; keeping its stale
        // detail open would mislead, so close instead of refetching.
        closeLead();
        return;
      }
      advanceAfterReview(request.personId);
    },
    [advanceAfterReview, api, closeLead],
  );

  const overrideCloudScore = useCallback(
    async (request: CloudScoreOverrideRequest) => {
      // Log-only: the outbox row is the entire effect, so the detail DTO
      // needs no refresh (no local score ever changes).
      await api.overrideCloudScore(request);
    },
    [api],
  );

  const findContactInfo = useCallback(
    // One explicit click, one request line; the receipt renders inline in
    // the contact section (no toast, no activity row).
    (request: FindContactInfoRequest) => api.findContactInfo(request),
    [api],
  );

  /**
   * Save & next (audit 4.7): open the next queue lead's full page, or
   * close back to Today when the queue has nothing else.
   */
  const handleOutcomeSaved = useCallback(
    (nextPersonId: string | null) => {
      if (nextPersonId === null) {
        closeLead();
      } else {
        openFullPage(nextPersonId);
      }
    },
    [closeLead, openFullPage],
  );

  const handle = useMemo<LeadInspectorHandle>(
    () => ({
      openLead,
      openFullPage,
      closeLead,
      selectedPersonId: selection?.personId ?? null,
      setReviewAdvance,
    }),
    [openLead, openFullPage, closeLead, selection, setReviewAdvance],
  );

  return (
    <LeadInspectorContext.Provider value={handle}>
      {children}
      {selection !== null && selection.view === 'inspector' && (
        <LeadInspector
          state={detailState}
          onClose={closeLead}
          onRetry={retry}
          onOpenFullPage={openFullPage}
          onBeginOutbound={beginOutbound}
          onConfirmTransition={confirmTransition}
          onDismissLead={dismissLead}
          onOverrideCloudScore={overrideCloudScore}
          onFindContactInfo={findContactInfo}
        />
      )}
      {selection !== null && selection.view === 'page' && (
        <LeadFullPage
          state={detailState}
          onRetry={retry}
          onBeginOutbound={beginOutbound}
          onConfirmTransition={confirmTransition}
          onDismissLead={dismissLead}
          onOverrideCloudScore={overrideCloudScore}
          onFindContactInfo={findContactInfo}
          outcomeApi={outcomeApi}
          onOutcomeSaved={handleOutcomeSaved}
          onClose={closeLead}
        />
      )}
    </LeadInspectorContext.Provider>
  );
}
