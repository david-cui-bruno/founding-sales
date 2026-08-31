import { useCallback, useEffect, useRef, useState } from 'react';

import type { MutationReceipt } from '../../../shared/contracts/commonContract';
import type {
  CancelJobRequest,
  CreateJobRequest,
  FillJobRequest,
  FridayReport,
  MetricDrilldown,
  MetricDrilldownRequest,
  MetricId,
} from '../../../shared/contracts/fridayContract';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { FridayPage } from './FridayPage';

export type FridayApi = {
  getCurrent(): Promise<FridayReport>;
  getDrilldown(input: MetricDrilldownRequest): Promise<MetricDrilldown>;
  createJob(input: CreateJobRequest): Promise<MutationReceipt>;
  fillJob(input: FillJobRequest): Promise<MutationReceipt>;
  cancelJob(input: CancelJobRequest): Promise<MutationReceipt>;
};

export type FridayRouteProps = {
  api: FridayApi;
  onOpenLead(personId: string): void;
};

type FridayRouteState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; report: FridayReport };

/**
 * Route container: fetches the strict report through the injected API,
 * ignores stale responses, and refetches after every command receipt. It
 * never computes metrics or rates.
 */
export function FridayRoute({ api, onOpenLead }: FridayRouteProps) {
  const [state, setState] = useState<FridayRouteState>({ kind: 'loading' });
  const [drilldown, setDrilldown] = useState<MetricDrilldown | null>(null);
  const requestSequence = useRef(0);

  const load = useCallback(
    (options: { showLoading: boolean } = { showLoading: true }) => {
      requestSequence.current += 1;
      const requestId = requestSequence.current;
      if (options.showLoading) {
        setState({ kind: 'loading' });
      }
      api
        .getCurrent()
        .then((report) => {
          if (requestSequence.current === requestId) {
            setState({ kind: 'ready', report });
          }
        })
        .catch(() => {
          if (requestSequence.current === requestId) {
            setState({ kind: 'error' });
          }
        });
    },
    [api],
  );

  useEffect(() => {
    load();
    return () => {
      requestSequence.current += 1;
    };
  }, [load]);

  const openMetric = useCallback(
    (metricId: MetricId) => {
      api
        .getDrilldown({ metricId })
        .then(setDrilldown)
        .catch(() => setDrilldown(null));
    },
    [api],
  );

  const runCommand = useCallback(
    (command: Promise<MutationReceipt>) => {
      command
        .then(() => load({ showLoading: false }))
        .catch(() => load({ showLoading: false }));
    },
    [load],
  );

  if (state.kind === 'loading') {
    return <LoadingState label="Loading Friday scoreboard" />;
  }

  if (state.kind === 'error') {
    return (
      <ErrorState
        title="The scoreboard could not load"
        description="Retry to fetch this week's report."
        onRetry={() => load()}
      />
    );
  }

  return (
    <FridayPage
      report={state.report}
      onOpenMetric={openMetric}
      onCreateJob={(input) => runCommand(api.createJob(input))}
      onFillJob={(input) => runCommand(api.fillJob(input))}
      onCancelJob={(input) => runCommand(api.cancelJob(input))}
      drilldown={drilldown}
      onOpenLead={onOpenLead}
      onCloseDrilldown={() => setDrilldown(null)}
    />
  );
}
