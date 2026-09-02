import { useCallback, useEffect, useRef, useState } from 'react';

import type { MutationReceipt } from '../../../shared/contracts/commonContract';
import type {
  CancelJobRequest,
  CreateJobRequest,
  FillJobRequest,
  FridayReport,
  FridayReportRequest,
  MetricDrilldown,
  MetricDrilldownRequest,
  MetricId,
} from '../../../shared/contracts/fridayContract';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { FridayPage } from './FridayPage';

export type FridayApi = {
  getCurrent(input?: FridayReportRequest): Promise<FridayReport>;
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

/** Matches the -520 floor in fridayReportRequestSchema. */
const MIN_WEEK_OFFSET = -520;

/**
 * Route container: fetches the strict report through the injected API,
 * ignores stale responses, and refetches after every command receipt or week
 * change. It never computes metrics or rates; the picked weekOffset is the
 * only piece of state it owns.
 */
export function FridayRoute({ api, onOpenLead }: FridayRouteProps) {
  const [state, setState] = useState<FridayRouteState>({ kind: 'loading' });
  const [weekOffset, setWeekOffset] = useState(0);
  const [drilldown, setDrilldown] = useState<MetricDrilldown | null>(null);
  const requestSequence = useRef(0);

  const load = useCallback(
    (
      offset: number,
      options: { showLoading: boolean } = { showLoading: true },
    ) => {
      requestSequence.current += 1;
      const requestId = requestSequence.current;
      if (options.showLoading) {
        setState({ kind: 'loading' });
      }
      const request = offset === 0 ? undefined : { weekOffset: offset };
      api
        .getCurrent(request)
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
    load(weekOffset);
    return () => {
      requestSequence.current += 1;
    };
  }, [load, weekOffset]);

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
        .then(() => load(weekOffset, { showLoading: false }))
        .catch(() => load(weekOffset, { showLoading: false }));
    },
    [load, weekOffset],
  );

  if (state.kind === 'loading') {
    return <LoadingState label="Loading Friday scoreboard" />;
  }

  if (state.kind === 'error') {
    return (
      <ErrorState
        title="The scoreboard could not load"
        description="Retry to fetch this week's report."
        onRetry={() => load(weekOffset)}
      />
    );
  }

  return (
    <FridayPage
      report={state.report}
      weekOffset={weekOffset}
      onPreviousWeek={() =>
        setWeekOffset((current) => Math.max(current - 1, MIN_WEEK_OFFSET))}
      onNextWeek={() => setWeekOffset((current) => Math.min(current + 1, 0))}
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
