import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { MutationReceipt } from '../../../shared/contracts/commonContract';
import { cancelJobRequestSchema, createJobRequestSchema, fillJobRequestSchema } from '../../../shared/contracts/fridayContract';
import type {
  CancelJobRequest, CreateJobRequest, FillJobRequest, FridayReport,
  FridayReportRequest, MetricDrilldown, MetricDrilldownRequest, MetricId,
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
export type FridayRouteProps = { api: FridayApi; onOpenLead(personId: string): void };
export type FridayIntent =
  | { kind: 'create'; input: CreateJobRequest }
  | { kind: 'fill'; input: FillJobRequest }
  | { kind: 'cancel'; input: CancelJobRequest };
export type FridayMutationView = { status: 'idle' } | {
  status: 'pending' | 'unconfirmed' | 'saved'; intent: FridayIntent; message: string | null;
};
export type FridaySaveResult =
  | { status: 'saved' } | { status: 'unconfirmed'; message: string } | { status: 'not_started' };
const UNCONFIRMED = 'The change could not be confirmed. Your input is kept. Review the job before retrying.';
const NOT_STARTED: FridaySaveResult = { status: 'not_started' };
const MIN_WEEK_OFFSET = -520;
const held = (view: FridayMutationView) => view.status === 'pending' || view.status === 'unconfirmed';

function matches(report: FridayReport, intent: FridayIntent): boolean {
  const job = report.jobs.find((row) => row.id === intent.input.jobId);
  if (!job) return false;
  switch (intent.kind) {
    case 'create': return job.salesCycleId === intent.input.salesCycleId && job.requestedAt === intent.input.requestedAt;
    case 'fill': return job.status === 'filled' && job.contractorAcceptedAt === intent.input.contractorAcceptedAt;
    case 'cancel': return job.status === 'cancelled';
  }
}

/** A new API occurrence is a new owner, including A -> B -> A. */
export function FridayRoute(props: FridayRouteProps) {
  const [owner, setOwner] = useState({ api: props.api, generation: 0 });
  if (owner.api !== props.api) {
    setOwner({ api: props.api, generation: owner.generation + 1 });
    return null;
  }
  return <FridaySession key={owner.generation} {...props} />;
}

function FridaySession(props: FridayRouteProps) {
  const [weekOffset, setWeekOffset] = useState(0);
  return <FridayWeek key={weekOffset} {...props} weekOffset={weekOffset}
    onPreviousWeek={() => setWeekOffset((value) => Math.max(value - 1, MIN_WEEK_OFFSET))}
    onNextWeek={() => setWeekOffset((value) => Math.min(value + 1, 0))} />;
}

type Lifetime = { active: boolean };
function FridayWeek({ api, onOpenLead, weekOffset, onPreviousWeek, onNextWeek }: FridayRouteProps & {
  weekOffset: number; onPreviousWeek(): void; onNextWeek(): void;
}) {
  const [report, setReport] = useState<FridayReport | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [mutation, setMutation] = useState<FridayMutationView>({ status: 'idle' });
  const [validation, setValidation] = useState<string | null>(null);
  const mutationRef = useRef<FridayMutationView>({ status: 'idle' });
  const lifetime = useRef<Lifetime | null>(null);
  const readSequence = useRef(0);
  const drillSequence = useRef(0);
  const [drilldown, setDrilldown] = useState<MetricDrilldown | null>(null);
  // A captured token, not a revived mounted boolean, also fences StrictMode replay.
  useLayoutEffect(() => {
    const token = { active: true };
    lifetime.current = token;
    return () => { token.active = false; };
  }, []);
  const publish = useCallback((view: FridayMutationView) => {
    mutationRef.current = view;
    setMutation(view);
  }, []);

  const load = useCallback(async (): Promise<FridaySaveResult> => {
    const token = lifetime.current;
    if (!token?.active) return NOT_STARTED;
    const sequence = ++readSequence.current;
    const captured = mutationRef.current;
    setRefreshing(true);
    try {
      const next = await api.getCurrent(weekOffset === 0 ? undefined : { weekOffset });
      if (!token.active || lifetime.current !== token || readSequence.current !== sequence) return NOT_STARTED;
      setReport(next);
      setReadFailed(false);
      if (captured.status === 'unconfirmed' && mutationRef.current === captured && matches(next, captured.intent)) {
        publish({ status: 'saved', intent: captured.intent, message: null });
        return { status: 'saved' };
      }
      return captured.status === 'unconfirmed' ? { status: 'unconfirmed', message: UNCONFIRMED } : NOT_STARTED;
    } catch {
      if (!token.active || lifetime.current !== token || readSequence.current !== sequence) return NOT_STARTED;
      setReadFailed(true);
      return captured.status === 'unconfirmed' ? { status: 'unconfirmed', message: UNCONFIRMED } : NOT_STARTED;
    } finally {
      if (token.active && lifetime.current === token && readSequence.current === sequence) setRefreshing(false);
    }
  }, [api, weekOffset, publish]);
  useEffect(() => { void load(); }, [load]);

  const runCommand = async (intent: FridayIntent, retry = false): Promise<FridaySaveResult> => {
    const token = lifetime.current;
    const prior = mutationRef.current;
    if (!token?.active || prior.status === 'pending' || (!retry && held(prior)) ||
      (retry && (prior.status !== 'unconfirmed' || prior.intent !== intent))) return NOT_STARTED;
    let captured: FridayIntent;
    try {
      // Parsing clones only the admitted new intent. Retry uses the frozen original.
      captured = retry ? intent : intent.kind === 'create'
        ? { kind: 'create', input: createJobRequestSchema.parse(intent.input) }
        : intent.kind === 'fill'
          ? { kind: 'fill', input: fillJobRequestSchema.parse(intent.input) }
          : { kind: 'cancel', input: cancelJobRequestSchema.parse(intent.input) };
    } catch {
      setValidation('Check the job date and time before saving.');
      return NOT_STARTED;
    }
    const pending: FridayMutationView = { status: 'pending', intent: captured, message: null };
    publish(pending); // Synchronous shared admission BEFORE invoking any transport.
    setValidation(null);
    const invoke = () => captured.kind === 'create' ? api.createJob(captured.input)
      : captured.kind === 'fill' ? api.fillJob(captured.input) : api.cancelJob(captured.input);
    try {
      await invoke();
    } catch {
      if (!token.active || lifetime.current !== token || mutationRef.current !== pending) return NOT_STARTED;
      publish({ status: 'unconfirmed', intent: captured, message: UNCONFIRMED });
      return { status: 'unconfirmed', message: UNCONFIRMED };
    }
    if (!token.active || lifetime.current !== token || mutationRef.current !== pending) return NOT_STARTED;
    publish({ status: 'saved', intent: captured, message: null });
    setReadFailed(false);
    void load(); // Receipt acknowledgement never waits on the report read.
    return { status: 'saved' };
  };

  const openMetric = (metricId: MetricId) => {
    const token = lifetime.current;
    if (!token?.active) return;
    const sequence = ++drillSequence.current;
    api.getDrilldown({ metricId }).then((next) => {
      if (token.active && lifetime.current === token && sequence === drillSequence.current) setDrilldown(next);
    }).catch(() => {
      if (token.active && lifetime.current === token && sequence === drillSequence.current) setDrilldown(null);
    });
  };
  if (!report) {
    return readFailed ? <ErrorState title="The scoreboard could not load"
      description="Retry to fetch this week's report." onRetry={() => { void load(); }} />
      : <LoadingState label="Loading Friday scoreboard" />;
  }
  return <>
    <div role="status" aria-live="polite">
      {mutation.status === 'pending' ? 'Saving job change…'
        : mutation.status === 'unconfirmed' ? UNCONFIRMED
          : mutation.status === 'saved' ? (readFailed ? 'Saved; scoreboard refresh failed' : 'Saved')
            : readFailed ? 'The scoreboard could not refresh. Your input is kept.' : null}
      {validation}
    </div>
    <FridayPage report={report} weekOffset={weekOffset}
      onPreviousWeek={() => {
        const token = lifetime.current;
        if (!token?.active || held(mutationRef.current) || weekOffset <= MIN_WEEK_OFFSET) return;
        token.active = false; // Retire admission now, not at the later React commit.
        onPreviousWeek();
      }}
      onNextWeek={() => {
        const token = lifetime.current;
        if (!token?.active || held(mutationRef.current) || weekOffset >= 0) return;
        token.active = false;
        onNextWeek();
      }}
      onOpenMetric={openMetric} mutation={mutation}
      onCreateJob={(input) => runCommand({ kind: 'create', input })}
      onFillJob={(input) => runCommand({ kind: 'fill', input })}
      onCancelJob={(input) => runCommand({ kind: 'cancel', input })}
      onRetryMutation={() => {
        const current = mutationRef.current;
        return current.status === 'unconfirmed' ? runCommand(current.intent, true) : Promise.resolve(NOT_STARTED);
      }}
      onRefreshJobs={() => mutationRef.current.status === 'pending' || refreshing ? Promise.resolve(NOT_STARTED) : load()}
      drilldown={drilldown} onOpenLead={(id) => { if (lifetime.current?.active) onOpenLead(id); }}
      onCloseDrilldown={() => { ++drillSequence.current; setDrilldown(null); }} />
  </>;
}
