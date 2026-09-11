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
import { NativeDeskRoute, type NativeDeskApi } from './NativeDeskRoute';

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
  workspaceApi?: NativeDeskApi;
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
export function TodayRoute(props: TodayRouteProps) {
  const inspector = useLeadInspectorIfAvailable();
  if (props.workspaceApi) return <NativeDeskRoute api={props.workspaceApi}
    onOpenLead={props.onOpenLeadPage ?? inspector?.openFullPage ?? props.onOpenLead}
    renderLegacy={readHeld => <LegacyTodayRoute {...props} readHeld={readHeld} />} />;
  return <LegacyTodayRoute {...props} />;
}

function LegacyTodayRoute({
  api,
  discoveryApi,
  onOpenLead,
  onOpenLeadPage,
  readHeld = false,
}: TodayRouteProps & { readHeld?: boolean }) {
  const [state, setState] = useState<TodayRouteState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [commandFailed, setCommandFailed] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const queueReadReady = useRef(false);
  const parentReadHeld = useRef(readHeld);
  parentReadHeld.current = readHeld;
  const requestSequence = useRef(0);
  const commandGeneration = useRef(0);
  useEffect(() => {
    commandGeneration.current++;
    return () => { commandGeneration.current++; };
  }, [api]);
  const inspector = useLeadInspectorIfAvailable();

  const load = useCallback(() => {
    requestSequence.current += 1;
    const requestId = requestSequence.current;
    api
      .get()
      .then((snapshot) => {
        if (requestSequence.current === requestId) {
          queueReadReady.current = true;
          setRefreshFailed(false);
          setState({ kind: 'ready', snapshot });
        }
      })
      .catch(() => {
        if (requestSequence.current === requestId) {
          queueReadReady.current = false;
          setRefreshFailed(true);
          // A failed read is not a form close or a mutation result.
          setState(previous => previous.kind === 'ready' ? previous : { kind: 'error' });
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
    async (command: () => Promise<unknown>, after?: () => void): Promise<void> => {
      // Retaining the displayed snapshot must not authorize new stale-queue writes.
      if (!queueReadReady.current || parentReadHeld.current) throw new Error('Refresh Today before issuing another command.');
      const current = commandGeneration.current;
      setBusy(true);
      setCommandFailed(false);
      try { await command(); }
      catch (error) { if (current === commandGeneration.current) setCommandFailed(true); throw error; }
      finally { if (current === commandGeneration.current) setBusy(false); }
      // A refresh is a read, not a second interpretation of the accepted receipt.
      if (current === commandGeneration.current) { load(); after?.(); }
    },
    [load],
  );

  const handleSnoozeUntil = useCallback(
    (item: TodayItem, resurfaceAt: string) =>
      runCommand(() =>
        api.snooze({ salesCycleId: item.salesCycleId, resurfaceAt }),
      ).catch((): void => undefined),
    [api, runCommand],
  );

  const handleSkipToday = useCallback(
    (item: TodayItem) =>
      runCommand(() =>
        api.snooze({
          salesCycleId: item.salesCycleId,
          resurfaceAt: skipTodayResurfaceAt(),
        }),
      ).catch((): void => undefined),
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
      {readHeld && <p role="status">Queue commands are held while the workspace read is pending or unavailable. Your existing input and pending result are retained.</p>}
      {commandFailed && (
        <div className="today-route__command-error" role="alert">
          The command result was not confirmed. Check the current record before submitting again.
        </div>
      )}
      {refreshFailed && snapshot !== null && (
        <ErrorState
          title="Today could not refresh"
          description="The last loaded queue and your input are still here. Pending commands have not been retried. Refresh successfully before issuing another queue command."
          onRetry={load}
        />
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
        />
      )}
      {discoveryApi !== undefined && <SuggestedContacts api={discoveryApi} onOpenPerson={onOpenLead} />}
    </div>
  );
}
