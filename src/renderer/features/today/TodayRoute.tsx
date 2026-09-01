import { useCallback, useEffect, useRef, useState } from 'react';

import type { MutationReceipt } from '../../../shared/contracts/commonContract';
import type {
  CompleteActionRequest,
  LogPastActivityRequest,
  PinActionRequest,
  SnoozeActionRequest,
  TodayItem,
  TodaySnapshot,
} from '../../../shared/contracts/todayContract';
import { Button } from '../../components/Button';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { PageHeader } from '../../components/PageHeader';
import { TodayPage } from './TodayPage';

export type TodayRouteApi = {
  get(): Promise<TodaySnapshot>;
  complete(input: CompleteActionRequest): Promise<MutationReceipt>;
  snooze(input: SnoozeActionRequest): Promise<MutationReceipt>;
  pin(input: PinActionRequest): Promise<MutationReceipt>;
  logPastActivity(input: LogPastActivityRequest): Promise<MutationReceipt>;
};

export type TodayRouteProps = {
  api: TodayRouteApi;
  onOpenLead(personId: string): void;
};

type TodayRouteState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; snapshot: TodaySnapshot };

const PIN_REASON = 'Keep at the top of its lane';
const SNOOZE_REASON = 'Snoozed from the Today queue';
const CONTROL_TTL_MS = 24 * 60 * 60 * 1000;

const controlExpiry = (): string =>
  new Date(Date.now() + CONTROL_TTL_MS).toISOString();

/**
 * Route container: fetches the snapshot through the injected API, ignores
 * stale responses, and refetches after every successful MutationReceipt.
 * The main-process snapshot alone controls lane membership and row order.
 */
export function TodayRoute({ api, onOpenLead }: TodayRouteProps) {
  const [state, setState] = useState<TodayRouteState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [commandFailed, setCommandFailed] = useState(false);
  const requestSequence = useRef(0);

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

  const runCommand = useCallback(
    (command: () => Promise<MutationReceipt>) => {
      setBusy(true);
      setCommandFailed(false);
      command()
        .then(() => {
          setBusy(false);
          load();
        })
        .catch(() => {
          setBusy(false);
          setCommandFailed(true);
        });
    },
    [load],
  );

  const handleComplete = useCallback(
    (item: TodayItem) =>
      runCommand(() =>
        api.complete({
          salesCycleId: item.salesCycleId,
          actionId: item.action.id,
          outcome: 'answered',
          activityId: null,
        }),
      ),
    [api, runCommand],
  );

  const handleSnooze = useCallback(
    (item: TodayItem, comparedSalesCycleId: string) =>
      runCommand(() =>
        api.snooze({
          salesCycleId: item.salesCycleId,
          reason: SNOOZE_REASON,
          expiresAt: controlExpiry(),
          comparedSalesCycleId,
        }),
      ),
    [api, runCommand],
  );

  const handlePin = useCallback(
    (item: TodayItem, comparedSalesCycleId: string) =>
      runCommand(() =>
        api.pin({
          salesCycleId: item.salesCycleId,
          reason: PIN_REASON,
          expiresAt: controlExpiry(),
          comparedSalesCycleId,
        }),
      ),
    [api, runCommand],
  );

  return (
    <div className="today-route">
      <PageHeader
        title="Today"
        trailing={
          <Button variant="quiet" disabled={busy} onClick={load}>
            Refresh
          </Button>
        }
      />
      {commandFailed && (
        <div className="today-route__command-error" role="alert">
          The command could not be applied. Refresh and try again.
        </div>
      )}
      {state.kind === 'loading' && <LoadingState label="Loading today" />}
      {state.kind === 'error' && (
        <ErrorState
          title="Today could not load"
          description="Retry to fetch the latest queue."
          onRetry={load}
        />
      )}
      {state.kind === 'ready' && (
        <TodayPage
          snapshot={state.snapshot}
          busy={busy}
          onOpenLead={onOpenLead}
          onComplete={handleComplete}
          onSnooze={handleSnooze}
          onPin={handlePin}
        />
      )}
    </div>
  );
}
