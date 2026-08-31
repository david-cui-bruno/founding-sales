import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type {
  BeginOutboundRequest,
  ConfirmTransitionRequest,
} from '../../../shared/contracts/leadDetailContract';
import { LeadFullPage } from './LeadFullPage';
import { LeadInspector } from './LeadInspector';
import {
  LeadInspectorContext,
  type LeadDetailApi,
  type LeadDetailState,
  type LeadInspectorHandle,
} from './useLeadInspector';
import './leadInspector.css';

export type LeadInspectorProviderProps = {
  api: LeadDetailApi;
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
  children,
}: LeadInspectorProviderProps) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [detailState, setDetailState] = useState<LeadDetailState>({
    status: 'idle',
  });
  const requestSequence = useRef(0);
  const detailStateRef = useRef(detailState);
  detailStateRef.current = detailState;

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
      setSelection((current) => {
        if (current !== null) {
          fetchDetail(current.personId);
        }
        return current;
      });
    },
    [api, fetchDetail],
  );

  const handle = useMemo<LeadInspectorHandle>(
    () => ({
      openLead,
      openFullPage,
      closeLead,
      selectedPersonId: selection?.personId ?? null,
    }),
    [openLead, openFullPage, closeLead, selection],
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
        />
      )}
      {selection !== null && selection.view === 'page' && (
        <LeadFullPage
          state={detailState}
          onRetry={retry}
          onBeginOutbound={beginOutbound}
          onConfirmTransition={confirmTransition}
        />
      )}
    </LeadInspectorContext.Provider>
  );
}
