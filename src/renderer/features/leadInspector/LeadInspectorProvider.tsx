import { mutationReceiptSchema } from '../../../shared/contracts/commonContract';
import { discoveryBriefSchema, type DiscoveryApi, type DiscoveryBrief as Brief, type OverrideDiscoveryRequest } from '../../../shared/contracts/discoveryContract';
import type { LogPastActivityRequest } from '../../../shared/contracts/todayContract';
import { DiscoveryBrief } from '../discovery/DiscoveryBrief';
import { staleDiscoveryError } from '../discovery/useDiscovery';
import { LogPastActivityDialog } from '../today/LogPastActivityDialog';
import { outboundCapabilitiesSchema, outboundReceiptSchema, type OutboundCapabilities, type OutboundReceipt } from '../../../shared/contracts/outboundContract';
import { Button } from '../../components/Button';
import { OutboundReceiptPanel, outboundReceiptMessage } from './OutboundReceiptPanel';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type {
  FindContactInfoRequest,
} from '../../../shared/contracts/enrichmentRequestContract';
import type {
  BeginOutboundRequest,
  LeadDetail,
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
  outreachApi?: import('../../../shared/contracts/outreachContract').OutreachApi;
  discoveryApi?: DiscoveryApi;
  pastActivityApi?: { logPastActivity(input: LogPastActivityRequest): Promise<import('../../../shared/contracts/commonContract').MutationReceipt> };
  /** Optional Today commands enabling the full page call-outcome flow. */
  outcomeApi?: CallOutcomeApi;
  children: ReactNode;
};

type OutboundState = { request: BeginOutboundRequest; pending: boolean; uncertain: boolean; receipt: OutboundReceipt | null };

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
  outreachApi,
  discoveryApi,
  pastActivityApi,
  outcomeApi,
  children,
}: LeadInspectorProviderProps) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [detailState, setDetailState] = useState<LeadDetailState>({
    status: 'idle',
  });
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const lastDetails = useRef(new Map<string, LeadDetail>());
  const [capabilities, setCapabilities] = useState<OutboundCapabilities | null>(null);
  const [outbounds, setOutbounds] = useState<Record<string, OutboundState>>({});
  const outboundRef = useRef(outbounds);
  const [manual, setManual] = useState<{ personId: string; cycleId: string; commandId?: string } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    let current = true;
    setCapabilities(null);
    void api.getOutboundCapabilities().then((value) => {
      const parsed = outboundCapabilitiesSchema.safeParse(value);
      if (current && parsed.success) setCapabilities(value);
    }, () => { if (current) setCapabilities(null); });
    return () => { current = false; };
  }, [api]);
  const storeOutbound = useCallback((personId: string, value: OutboundState) => {
    outboundRef.current = { ...outboundRef.current, [personId]: value };
    if (mounted.current) setOutbounds(outboundRef.current);
  }, []);
  const requestSequence = useRef(0);
  const detailStateRef = useRef(detailState);
  detailStateRef.current = detailState;
  // The visible list's next-lead resolver; a ref so registering never
  // re-renders the whole app.
  const reviewAdvanceRef = useRef<ReviewAdvanceResolver | null>(null);

  const fetchDetail = useCallback(
    (personId: string, preserveView = false) => {
      requestSequence.current += 1;
      const sequence = requestSequence.current;
      if (!preserveView) setDetailState({ status: 'loading' });
      api.get({ personId }).then(
        (detail) => {
          if (requestSequence.current === sequence) {
            lastDetails.current.set(personId, detail);
            setDetailState({ status: 'ready', detail });
          }
        },
        () => {
          if (requestSequence.current === sequence && !preserveView) {
            setDetailState({ status: 'error' });
          }
        },
      );
    },
    [api],
  );

  useEffect(
    () => {
      mounted.current = true;
      return () => {
      mounted.current = false;
      // Invalidate in-flight responses once the provider unmounts.
      requestSequence.current += 1;
      };
    },
    [],
  );

  const openWith = useCallback(
    (personId: string, view: Selection['view'], forceRefresh = false) => {
      if (selectionRef.current?.personId !== personId) setManual(null);
      selectionRef.current = { personId, view };
      setSelection({ personId, view });
      const current = detailStateRef.current;
      const alreadyLoaded =
        current.status === 'ready' && current.detail.personId === personId;
      if (forceRefresh || !alreadyLoaded) {
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
    (personId: string, options?: { refresh: boolean }) => openWith(personId, 'page', options?.refresh),
    [openWith],
  );

  const closeLead = useCallback(() => {
    requestSequence.current += 1;
    selectionRef.current = null;
    setSelection(null);
    setManual(null);
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

  const refresh = useCallback((personId: string) => {
    if (mounted.current && selectionRef.current?.personId === personId) fetchDetail(personId);
  }, [fetchDetail]);

  useEffect(() => {
    const onEmailSent = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const owner = event.detail as { personId?: unknown; salesCycleId?: unknown } | null;
      if (owner === null || typeof owner !== 'object' || typeof owner.personId !== 'string') return;
      if (selectionRef.current?.personId === owner.personId
        && lastDetails.current.get(owner.personId)?.salesCycleId === owner.salesCycleId) {
        // Keep the sent receipt/editor mounted while updating activity and action.
        fetchDetail(owner.personId, true);
      }
    };
    window.addEventListener('callie:email-sent', onEmailSent);
    return () => window.removeEventListener('callie:email-sent', onEmailSent);
  }, [fetchDetail]);

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

  const beginOutbound = useCallback(async (request: BeginOutboundRequest): Promise<OutboundReceipt> => {
    const previous = outboundRef.current[request.personId];
    if (previous?.pending || previous?.uncertain || previous?.receipt?.status === 'unknown') {
      throw new Error('An outbound request is already pending or uncertain.');
    }
    const pending: OutboundState = { request, pending: true, uncertain: false, receipt: null };
    storeOutbound(request.personId, pending);
    try {
      const parsed = outboundReceiptSchema.parse(await api.beginOutbound(request));
      if (parsed.commandId !== request.commandId || parsed.channel !== request.channel) throw new Error('Mismatched outbound receipt.');
      const receipt: OutboundReceipt = { ...parsed, reasonCode: parsed.reasonCode };
      storeOutbound(request.personId, { ...pending, pending: false, receipt });
      refresh(request.personId);
      return receipt;
    } catch (error) {
      // A lost IPC reply cannot prove refusal or that no dispatch occurred.
      storeOutbound(request.personId, { ...pending, pending: false, uncertain: true });
      refresh(request.personId);
      throw error;
    }
  }, [api, refresh, storeOutbound]);

  const logPastActivity = useCallback((commandId?: string) => {
    const personId = selectionRef.current?.personId;
    const detail = personId === undefined ? undefined : lastDetails.current.get(personId);
    if (detail === undefined) return;
    if (commandId !== undefined) {
      const submitted = outboundRef.current[personId];
      const live = submitted?.receipt;
      const attempt = detail.outboundAttempts.find((entry) => entry.commandId === commandId);
      if (attempt !== undefined && attempt.manualActivityId !== null) return;
      const liveEligible = live?.commandId === commandId && submitted.request.personId === personId
        && submitted.request.salesCycleId === detail.salesCycleId && live.channel === 'call'
        && (live.status === 'handoff_accepted' || live.status === 'unknown')
        && live.mutation.affectedPersonIds.includes(personId)
        && live.mutation.affectedSalesCycleIds.includes(detail.salesCycleId);
      // Recovered summaries do not carry cycle identity. This is a requested
      // association only. The domain validates exact cycle/channel before saving.
      const recoveredEligible = attempt?.channel === 'call' && attempt.manualActivityId === null
        && (attempt.status === 'handoff_accepted' || attempt.status === 'unknown');
      if (live?.commandId === commandId ? !liveEligible : !recoveredEligible) return;
    }
    setManual({ personId, cycleId: detail.salesCycleId, commandId });
    openFullPage(personId);
  }, [openFullPage]);

  const confirmTransition = useCallback(
    async (request: ConfirmTransitionRequest) => {
      const owner = selectionRef.current?.personId;
      const selected = owner === undefined ? undefined : lastDetails.current.get(owner);
      if (selected === undefined || selected.salesCycleId !== request.salesCycleId) throw new Error('Selection changed');
      await api.confirmTransition(request);
      if (!mounted.current || selectionRef.current?.personId !== owner
        || lastDetails.current.get(owner)?.salesCycleId !== request.salesCycleId) return;
      if (request.transition === 'review_to_ready') {
        // Mark ready is part of the review burn-down: advance to the next
        // lead instead of leaving the founder staring at the same one.
        advanceAfterReview(owner);
        return;
      }
      fetchDetail(owner);
    },
    [advanceAfterReview, api, fetchDetail],
  );

  const dismissLead = useCallback(
    async (request: DismissLeadRequest) => {
      if (selectionRef.current?.personId !== request.personId
        || lastDetails.current.get(request.personId)?.salesCycleId !== request.salesCycleId) throw new Error('Selection changed');
      await api.dismissLead(request);
      if (!mounted.current || selectionRef.current?.personId !== request.personId
        || lastDetails.current.get(request.personId)?.salesCycleId !== request.salesCycleId) return;
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

  const personId = selection?.personId;
  const currentOutbound = personId === undefined ? undefined : outbounds[personId];
  const currentDetail = personId === undefined ? undefined : lastDetails.current.get(personId);
  const attempts = currentDetail?.outboundAttempts ?? [];
  const receipt = currentOutbound?.receipt;
  const uncertainCommandId = currentOutbound?.uncertain ? currentOutbound.request.commandId : undefined;
  const recoveredCurrent = attempts.find((attempt) => attempt.commandId === currentOutbound?.request.commandId);
  const recoveredManualActivityId = recoveredCurrent?.manualActivityId ?? null;
  const recoveredCanLink = recoveredCurrent?.channel === 'call'
    && (recoveredCurrent.status === 'handoff_accepted' || recoveredCurrent.status === 'unknown');
  // A detail read can supply manual evidence, but cannot resolve a live lost reply.
  const displayed: { receipt: OutboundReceipt; manualActivityId: string | null }[] = [
    ...(receipt === null || receipt === undefined ? [] : [{ receipt, manualActivityId: attempts.find((attempt) => attempt.commandId === receipt.commandId)?.manualActivityId ?? null }]),
    ...attempts.filter((attempt) => attempt.commandId !== receipt?.commandId && attempt.commandId !== uncertainCommandId).map((attempt) => ({
      receipt: { commandId: attempt.commandId, channel: attempt.channel, status: attempt.status, reasonCode: attempt.reasonCode,
        mutation: { revision: currentDetail.revision, affectedPersonIds: [personId], affectedSalesCycleIds: [] as string[] } },
      manualActivityId: attempt.manualActivityId,
    })),
  ];
  const outboundStatus = <>
    {currentOutbound?.pending && <p role="status">Phone handoff request pending. <span>{currentOutbound.request.commandId}</span></p>}
    {currentOutbound?.uncertain && <section className="outbound-receipt">
      <p role="status">Phone handoff response unavailable. Execution is unknown. Do not retry.</p>
      <p>{currentOutbound.request.commandId}</p>
      {recoveredManualActivityId !== null ? (
        <p>Manual evidence: {recoveredManualActivityId}. This does not verify the handoff.</p>
      ) : (
        <Button variant="quiet" onClick={() => logPastActivity(recoveredCanLink ? recoveredCurrent.commandId : undefined)}>Log past activity</Button>
      )}
    </section>}
    {displayed.map(({ receipt: result, manualActivityId }) => <div key={result.commandId}>
      {manualActivityId === null ? <OutboundReceiptPanel receipt={result} onLogPastActivity={logPastActivity} /> : (
        <section className="outbound-receipt" aria-label="Outbound execution status">
          <p role="status">{outboundReceiptMessage(result)}</p>
          {result.reasonCode !== null && <p>{result.reasonCode}</p>}
          <p className="outbound-receipt__command">{result.commandId}</p>
          <p>Manual evidence: {manualActivityId}. This does not verify the handoff.</p>
        </section>
      )}
      {manualActivityId === null && (result.status === 'refused' || result.status === 'unavailable') && <Button variant="quiet" onClick={() => logPastActivity()}>Log past activity</Button>}
    </div>)}
  </>;
  const outboundPresentation = { outreachApi, capabilities, outboundStatus, onLogPastActivity: logPastActivity,
    outboundPending: currentOutbound?.pending ?? false,
    outboundBlocked: currentOutbound?.uncertain || receipt?.status === 'unknown' || attempts.some((attempt) => attempt.channel === 'call' && attempt.status === 'unknown') };

  const discoveryPresentation = {
    discoveryEvidence: discoveryApi === undefined || currentDetail === undefined ? undefined : <SelectedDiscovery
      key={`${personId}:${currentDetail.salesCycleId}`} api={discoveryApi} personId={personId!} salesCycleId={currentDetail.salesCycleId} />,
    pastActivityControls: pastActivityApi === undefined || currentDetail === undefined ? undefined : <PastActivityControls
      key={`${personId}:${currentDetail.salesCycleId}`} detail={currentDetail} api={pastActivityApi} onSaved={() => refresh(currentDetail.personId)} />,
  };
  return (
    <LeadInspectorContext.Provider value={handle}>
      {children}
      {selection !== null && selection.view === 'inspector' && (
        <LeadInspector
          {...outboundPresentation}
          {...discoveryPresentation}
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
          {...outboundPresentation}
          {...discoveryPresentation}
          outboundCommandId={manual?.personId === personId && manual?.cycleId === currentDetail?.salesCycleId ? manual.commandId : undefined}
          state={detailState}
          onRetry={retry}
          onBeginOutbound={beginOutbound}
          onConfirmTransition={confirmTransition}
          onDismissLead={dismissLead}
          onOverrideCloudScore={overrideCloudScore}
          onFindContactInfo={findContactInfo}
          outcomeApi={outcomeApi}
          onOutcomeSaved={(next) => { if (selectionRef.current?.personId === personId) handleOutcomeSaved(next); }}
          onClose={closeLead}
        />
      )}
    </LeadInspectorContext.Provider>
  );
}

/** A keyed selected-Person reader. It never prepares or enriches on mount. */
function SelectedDiscovery({ api, personId, salesCycleId }: { api: DiscoveryApi; personId: string; salesCycleId: string }) {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  const apiRef = useRef(api);
  apiRef.current = api;
  const pending = useRef<{ api: DiscoveryApi; promise: Promise<Brief> } | null>(null);
  const load = useCallback(async () => {
    if (!mounted.current || apiRef.current !== api) return;
    const current = generation.current;
    setFailed(false);
    if (pending.current?.api !== api) {
      const promise = api.getBrief({ personId });
      pending.current = { api, promise };
      void promise.then(() => { if (pending.current?.promise === promise) pending.current = null; },
        () => { if (pending.current?.promise === promise) pending.current = null; });
    }
    const promise = pending.current.promise;
    try {
      const value = discoveryBriefSchema.parse(await promise);
      if (value.personId !== personId || value.salesCycleId !== salesCycleId) throw new Error('Mismatched discovery owner');
      if (mounted.current && generation.current === current && apiRef.current === api) setBrief(value);
    } catch { if (mounted.current && generation.current === current && apiRef.current === api) setFailed(true); }
  }, [api, personId, salesCycleId]);
  useEffect(() => {
    generation.current++; mounted.current = true; void load();
    return () => { mounted.current = false; generation.current++; };
  }, [load]);
  const assessmentId = brief?.assessment?.id;
  const fingerprint = brief?.assessment?.fingerprint;
  const override = useCallback(async (request: OverrideDiscoveryRequest) => {
    if (request.personId !== personId || request.assessmentId !== assessmentId
      || request.expectedFingerprint !== fingerprint) throw new Error('DISCOVERY_STALE_ASSESSMENT');
    const current = generation.current;
    const isCurrent = () => mounted.current && generation.current === current && apiRef.current === api;
    try {
      const receipt = mutationReceiptSchema.parse(await api.override(request));
      if (!receipt.affectedPersonIds.includes(personId)) throw new Error('Mismatched override receipt');
      // The issued decision keeps its result, but only its live UI can refresh.
      if (isCurrent()) void load();
      return receipt;
    } catch (error) { if (staleDiscoveryError(error) && isCurrent()) void load(); throw error; }
  }, [api, personId, assessmentId, fingerprint, load]);
  return <section aria-label="Prepared conversation evidence">
    {failed && <p role="alert">Discovery evidence could not refresh.</p>}
    {brief === null ? <p>{failed ? 'Evidence unavailable' : 'Loading discovery evidence'}</p> : <DiscoveryBrief brief={brief} onOverride={override} />}
    <Button variant="quiet" onClick={() => { void load(); }}>Refresh discovery evidence</Button>
  </section>;
}

function PastActivityControls({ detail, api, onSaved }: { detail: LeadDetail; api: NonNullable<LeadInspectorProviderProps['pastActivityApi']>; onSaved(): void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return <section aria-label="Past communication evidence">
    <Button variant="quiet" disabled={busy} onClick={() => setOpen(true)}>Log dated past activity</Button>
    {message !== null && <p role="status">{message}</p>}
    {open && <LogPastActivityDialog item={detail} busy={busy} onClose={() => setOpen(false)} onSubmit={request => {
      if (pending.current || request.personId !== detail.personId || request.salesCycleId !== detail.salesCycleId) return;
      pending.current = true; setBusy(true); setOpen(false); setMessage(null);
      void api.logPastActivity(request).then(() => {
        if (!mounted.current) return;
        setMessage('Past activity saved. In Activity, select the actual price-stated evidence and separately confirm Offered. If the event is outside recent history, do not guess its ID.');
        onSaved();
      }, () => { if (mounted.current) setMessage('Past activity response unavailable. Check Activity before logging it again.'); })
        .finally(() => { pending.current = false; if (mounted.current) setBusy(false); });
    }} />}
  </section>;
}
