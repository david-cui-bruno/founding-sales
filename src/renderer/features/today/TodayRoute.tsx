import { useCallback, useEffect, useRef, useState } from 'react';

import type { MutationReceipt } from '../../../shared/contracts/commonContract';
import type {
  ConfirmTransitionRequest,
  DismissLeadRequest,
} from '../../../shared/contracts/leadDetailContract';
import type {
  CompleteActionRequest,
  LogPastActivityRequest,
  PinActionRequest,
  SetReviewPositionRequest,
  SnoozeActionRequest,
  TodayItem,
  TodaySnapshot,
  TriageLead,
  TriageQueue,
} from '../../../shared/contracts/todayContract';
import { ErrorState } from '../../components/ErrorState';
import { PageHeader } from '../../components/PageHeader';
import { ProgressBarThin } from '../../components/ProgressBarThin';
import { useLeadInspectorIfAvailable } from '../leadInspector/useLeadInspector';
import { DialMeter } from './DialMeter';
import { TodayPage, skipTodayResurfaceAt } from './TodayPage';
import { TriageMode, type TriageDecision } from './TriageMode';

export type TodayRouteApi = {
  get(): Promise<TodaySnapshot>;
  complete(input: CompleteActionRequest): Promise<MutationReceipt>;
  snooze(input: SnoozeActionRequest): Promise<MutationReceipt>;
  pin(input: PinActionRequest): Promise<MutationReceipt>;
  logPastActivity(input: LogPastActivityRequest): Promise<MutationReceipt>;
  getTriageQueue(): Promise<TriageQueue>;
  setReviewPosition(input: SetReviewPositionRequest): Promise<MutationReceipt>;
};

/** The lead-detail commands the call and triage flows reuse. */
export type TodayLeadCommandApi = {
  beginOutbound(input: {
    channel: 'call';
    personId: string;
    salesCycleId: string;
    contactMethodId: string;
  }): Promise<MutationReceipt>;
  confirmTransition(input: ConfirmTransitionRequest): Promise<MutationReceipt>;
  dismissLead(input: DismissLeadRequest): Promise<MutationReceipt>;
  get(input: { personId: string }): Promise<{
    revision: number;
    phones: ReadonlyArray<{ id: string }>;
  }>;
};

export type TodayRouteProps = {
  api: TodayRouteApi;
  leadApi?: TodayLeadCommandApi;
  onOpenLead(personId: string): void;
  /** Promotes a person to the full-page view for the call outcome flow. */
  onOpenLeadPage?(personId: string): void;
};

type TodayRouteState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; snapshot: TodaySnapshot };

type TriageState =
  | { kind: 'closed' }
  | { kind: 'loading' }
  | { kind: 'open'; queue: TriageQueue };

const LATER_RESURFACE_MS = 30 * 24 * 60 * 60 * 1000;

const todayDateLine = (): string =>
  new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

/**
 * Route container (audit 4.2): fetches the snapshot through the injected
 * API, refetches after every successful MutationReceipt and on window
 * focus (no visible Refresh control; a hidden manual path stays for E2E).
 * Owns triage mode and the call flow's navigation to the lead full page.
 */
export function TodayRoute({
  api,
  leadApi,
  onOpenLead,
  onOpenLeadPage,
}: TodayRouteProps) {
  const [state, setState] = useState<TodayRouteState>({ kind: 'loading' });
  const [triage, setTriage] = useState<TriageState>({ kind: 'closed' });
  const [busy, setBusy] = useState(false);
  const [commandFailed, setCommandFailed] = useState(false);
  const requestSequence = useRef(0);
  const inspector = useLeadInspectorIfAvailable();

  const load = useCallback(() => {
    requestSequence.current += 1;
    const requestId = requestSequence.current;
    api
      .get()
      .then((snapshot) => {
        if (requestSequence.current === requestId) {
          setState({ kind: 'ready', snapshot });
        }
      })
      .catch(() => {
        if (requestSequence.current === requestId) {
          setState({ kind: 'error' });
        }
      });
  }, [api]);

  useEffect(() => {
    load();
    return () => {
      requestSequence.current += 1;
    };
  }, [load]);

  // Poll on window focus instead of a visible Refresh control; the hidden
  // data hook below keeps a manual path for tests. Saved call outcomes
  // (logged from the full-page overlay) also trigger a refetch.
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    window.addEventListener('callie:outcome-logged', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('callie:outcome-logged', onFocus);
    };
  }, [load]);

  const runCommand = useCallback(
    (command: () => Promise<unknown>, after?: () => void) => {
      setBusy(true);
      setCommandFailed(false);
      command()
        .then(() => {
          setBusy(false);
          load();
          after?.();
        })
        .catch(() => {
          setBusy(false);
          setCommandFailed(true);
        });
    },
    [load],
  );

  const handleSnoozeUntil = useCallback(
    (item: TodayItem, resurfaceAt: string) =>
      runCommand(() =>
        api.snooze({ salesCycleId: item.salesCycleId, resurfaceAt }),
      ),
    [api, runCommand],
  );

  const handleSkipToday = useCallback(
    (item: TodayItem) =>
      runCommand(() =>
        api.snooze({
          salesCycleId: item.salesCycleId,
          resurfaceAt: skipTodayResurfaceAt(),
        }),
      ),
    [api, runCommand],
  );

  const handleLogPastActivity = useCallback(
    (request: LogPastActivityRequest) =>
      runCommand(() => api.logPastActivity(request)),
    [api, runCommand],
  );

  /**
   * The call flow (audit 4.7): log the outbound call through the same
   * beginOutbound path the inspector uses, then promote the lead to its
   * full page where the outcome section waits. Without the lead command
   * API (isolated tests) it degrades to opening the lead page directly.
   */
  const handleCall = useCallback(
    (item: TodayItem) => {
      const openPage = onOpenLeadPage ?? inspector?.openFullPage ?? onOpenLead;
      if (leadApi === undefined) {
        openPage(item.personId);
        return;
      }
      runCommand(
        async () => {
          const detail = await leadApi.get({ personId: item.personId });
          const phone = detail.phones[0];
          if (phone !== undefined) {
            await leadApi.beginOutbound({
              channel: 'call',
              personId: item.personId,
              salesCycleId: item.salesCycleId,
              contactMethodId: phone.id,
            });
          }
        },
        () => openPage(item.personId),
      );
    },
    [inspector, leadApi, onOpenLead, onOpenLeadPage, runCommand],
  );

  const handleOpenInLeads = useCallback((item: TodayItem) => {
    window.location.hash = '#/leads';
    onOpenLead(item.personId);
  }, [onOpenLead]);

  const loadTriage = useCallback(() => {
    setTriage({ kind: 'loading' });
    api
      .getTriageQueue()
      .then((queue) => setTriage({ kind: 'open', queue }))
      .catch(() => {
        setTriage({ kind: 'closed' });
        setCommandFailed(true);
      });
  }, [api]);

  const handleTriageDecide = useCallback(
    (lead: TriageLead, decision: TriageDecision, dismissReason: DismissLeadRequest['qualificationGateReason'] | null) => {
      if (leadApi === undefined) return;
      setBusy(true);
      setCommandFailed(false);
      const run = async () => {
        if (decision === 'ready') {
          const detail = await leadApi.get({ personId: lead.personId });
          await leadApi.confirmTransition({
            transition: 'review_to_ready',
            salesCycleId: lead.salesCycleId,
            expectedRevision: detail.revision,
          });
        } else if (decision === 'later') {
          await api.snooze({
            salesCycleId: lead.salesCycleId,
            resurfaceAt: new Date(Date.now() + LATER_RESURFACE_MS).toISOString(),
          });
        } else {
          const detail = await leadApi.get({ personId: lead.personId });
          await leadApi.dismissLead({
            salesCycleId: lead.salesCycleId,
            personId: lead.personId,
            qualificationGateReason: dismissReason ?? 'out_of_area',
            expectedRevision: detail.revision,
          });
        }
        // Every decision advances the persisted pass position.
        const current = triage.kind === 'open' ? triage.queue : null;
        const nextPosition = (current?.position ?? 0) + 1;
        await api.setReviewPosition({ position: nextPosition });
        const queue = await api.getTriageQueue();
        setTriage({ kind: 'open', queue });
      };
      run()
        .then(() => setBusy(false))
        .catch(() => {
          setBusy(false);
          setCommandFailed(true);
        });
    },
    [api, leadApi, triage],
  );

  const handleTriageExit = useCallback(() => {
    const queue = triage.kind === 'open' ? triage.queue : null;
    const finishedPass = queue !== null && queue.items.length === 0;
    setTriage({ kind: 'closed' });
    load();
    // Finishing a pass resets the counter; leaving mid-pass keeps it.
    if (finishedPass) {
      void api.setReviewPosition({ position: 0 }).catch((): undefined => undefined);
    }
  }, [api, load, triage]);

  const snapshot = state.kind === 'ready' ? state.snapshot : null;

  if (triage.kind !== 'closed') {
    return (
      <div className="today-route" data-testid="today-route">
        <PageHeader title="Today" description={todayDateLine()} />
        {triage.kind === 'loading' && (
          <ProgressBarThin label="Loading triage queue" />
        )}
        {triage.kind === 'open' && (
          <TriageMode
            queue={triage.queue}
            busy={busy}
            onDecide={handleTriageDecide}
            onExit={handleTriageExit}
          />
        )}
      </div>
    );
  }

  return (
    <div className="today-route" data-testid="today-route">
      <PageHeader
        title="Today"
        description={todayDateLine()}
        trailing={snapshot !== null ? <DialMeter snapshot={snapshot} /> : undefined}
      />
      {/* Hidden manual refresh path: no visible control by design. */}
      <button
        type="button"
        className="visually-hidden"
        data-testid="today-refresh"
        onClick={load}
      >
        Refresh Today
      </button>
      {commandFailed && (
        <div className="today-route__command-error" role="alert">
          The command could not be applied. Try again.
        </div>
      )}
      {state.kind === 'loading' && <ProgressBarThin label="Loading today" />}
      {state.kind === 'error' && (
        <ErrorState
          title="Today could not load"
          description="Retry to fetch the latest queue."
          onRetry={load}
        />
      )}
      {snapshot !== null && (
        <TodayPage
          snapshot={snapshot}
          busy={busy}
          onOpenLead={onOpenLead}
          onCall={handleCall}
          onSnoozeUntil={handleSnoozeUntil}
          onSkipToday={handleSkipToday}
          onLogPastActivity={handleLogPastActivity}
          onOpenInLeads={handleOpenInLeads}
          onStartTriage={loadTriage}
        />
      )}
    </div>
  );
}
