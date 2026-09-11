import { useCallback, useEffect, useRef, useState } from 'react';

import type { DiscoveryApi } from '../../../shared/contracts/discoveryContract';
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
  TriageQueue,
} from '../../../shared/contracts/todayContract';
import { ErrorState } from '../../components/ErrorState';
import { ProgressBarThin } from '../../components/ProgressBarThin';
import { useLeadInspectorIfAvailable } from '../leadInspector/useLeadInspector';
import { DialMeter } from './DialMeter';
import { TodayPage, skipTodayResurfaceAt } from './TodayPage';
import { SuggestedContacts } from '../discovery/SuggestedContacts';

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
  confirmTransition(input: ConfirmTransitionRequest): Promise<MutationReceipt>;
  dismissLead(input: DismissLeadRequest): Promise<MutationReceipt>;
  get(input: { personId: string }): Promise<{
    revision: number;
    phones: ReadonlyArray<{ id: string }>;
  }>;
};

export type TodayRouteProps = {
  api: TodayRouteApi;
  discoveryApi?: DiscoveryApi;
  leadApi?: TodayLeadCommandApi;
  onOpenLead(personId: string): void;
  /** Promotes a person to the full-page view for the call outcome flow. */
  onOpenLeadPage?(personId: string): void;
};

type TodayRouteState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; snapshot: TodaySnapshot };

const todayDateLine = (): string =>
  new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

/**
 * Route container (audit 4.2): fetches the snapshot through the injected
 * API, refetches after every successful MutationReceipt and on window
 * focus without a manual refresh or judgment surface.
 * Call navigates to the contact workspace without initiating outreach.
 */
export function TodayRoute({
  api,
  discoveryApi,
  onOpenLead,
  onOpenLeadPage,
}: TodayRouteProps) {
  const [state, setState] = useState<TodayRouteState>({ kind: 'loading' });
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

  // Read again on window focus and after explicit saved outcomes.
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    window.addEventListener('callie:outcome-logged', onFocus);
    window.addEventListener('callie:email-sent', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('callie:outcome-logged', onFocus);
      window.removeEventListener('callie:email-sent', onFocus);
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

  /** Call selects the full page. Only its explicit confirmation can request a handoff. */
  const handleCall = useCallback((item: TodayItem) => {
    const openPage = onOpenLeadPage ?? inspector?.openFullPage ?? onOpenLead;
    openPage(item.personId);
  }, [inspector, onOpenLead, onOpenLeadPage]);

  const handleOpenInLeads = useCallback((item: TodayItem) => {
    window.location.hash = '#/leads';
    onOpenLead(item.personId);
  }, [onOpenLead]);

  const snapshot = state.kind === 'ready' ? state.snapshot : null;

  return (
    <div className="today-route" data-testid="today-route">
      <header className="today-header">
        <div>
          <p className="today-header__eyebrow">{todayDateLine()}</p>
          <h1>Today</h1>
          <p className="today-header__subtitle">Keep your commitments. Make room for a good conversation.</p>
        </div>
        <time className="today-header__date" aria-label="Current date" dateTime={new Date().toLocaleDateString('en-CA')}>
          <span>{new Date().toLocaleDateString(undefined, { weekday: 'short' })}</span>
          <strong>{new Date().toLocaleDateString(undefined, { day: '2-digit' })}</strong>
        </time>
      </header>
      {snapshot !== null && <details className="today-header__progress"><summary>Queue capacity</summary><DialMeter snapshot={snapshot} /></details>}
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
          selectedPersonId={inspector?.selectedPersonId}
          busy={busy}
          onOpenLead={onOpenLead}
          onCall={handleCall}
          onSnoozeUntil={handleSnoozeUntil}
          onSkipToday={handleSkipToday}
          onLogPastActivity={handleLogPastActivity}
          onOpenInLeads={handleOpenInLeads}
          onStartTriage={() => undefined}
        />
      )}
      {discoveryApi !== undefined && <SuggestedContacts api={discoveryApi} onOpenPerson={onOpenLead} />}
    </div>
  );
}
