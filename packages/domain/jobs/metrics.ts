import type { Queryable } from '../db/queryable.ts';
import { canaryCompletionAgeSeconds } from './canary.ts';
import { unacknowledgedCriticalAlertAgeSeconds } from './criticalAlerts.ts';
import { readHeartbeats, type HeartbeatComponent } from './heartbeats.ts';

/**
 * The operational metrics, and the thin adapter that publishes them.
 *
 * The contract is not ours to invent: `infra/modules/alerts/main.tf` names every
 * metric an alarm reads, and `infra/modules/observability/main.tf` names the ones
 * derived from log events. `METRIC_OWNERS` below names, for each of those names, the
 * one thing that raises it: this lane's collector, another lane's collector in the
 * worker's metric loop (mail, outbound, Today, sequences), or a log filter. There is
 * no "later lane" any more (g72): `test/jobs/observability.test.ts` reads the two
 * Terraform files and fails if a name exists there without a claim here, or here
 * without existing there, and `apps/worker/test/metricCoverage.test.ts` starts the
 * real worker and fails if a name claimed by a collector is not published or a
 * log-derived name is. A metric nobody emits is an alarm that never fires, which is
 * worse than no alarm.
 *
 * The adapter takes a `putMetricData` function rather than importing an AWS SDK.
 * Locally none is supplied and publishing is a no-op that still validates the data,
 * so a wrong unit or an unknown metric name fails on a laptop rather than in
 * production.
 *
 * A refused datum refuses only itself. Every sink publishes the data that passed and
 * then throws one `METRIC_REJECTED` error naming the data that did not, so one bad
 * gauge cannot silence the heartbeats beside it. On 24 September 2026 a unit of
 * `Hours` — which CloudWatch does not have — made `PutMetricData` reject the whole
 * batch every minute from the first connected mailbox on, and every FSS worker
 * metric went dark with it.
 */

/**
 * Every unit `PutMetricData` accepts: the `StandardUnit` enumeration of the
 * CloudWatch API. A datum carrying anything else fails the whole request with
 * `InvalidParameterValueException`, so the set is checked here, before sending.
 */
export const CLOUDWATCH_STANDARD_UNITS = Object.freeze([
  'Seconds',
  'Microseconds',
  'Milliseconds',
  'Bytes',
  'Kilobytes',
  'Megabytes',
  'Gigabytes',
  'Terabytes',
  'Bits',
  'Kilobits',
  'Megabits',
  'Gigabits',
  'Terabits',
  'Percent',
  'Count',
  'Bytes/Second',
  'Kilobytes/Second',
  'Megabytes/Second',
  'Gigabytes/Second',
  'Terabytes/Second',
  'Bits/Second',
  'Kilobits/Second',
  'Megabits/Second',
  'Gigabits/Second',
  'Terabits/Second',
  'Count/Second',
  'None',
] as const);

export type CloudWatchUnit = (typeof CLOUDWATCH_STANDARD_UNITS)[number];

/**
 * The units this tree publishes, narrowed from the CloudWatch set so that a unit
 * CloudWatch does not know is a type error at the datum that names it. There is no
 * `Hours`: a gauge in hours is published as `None`, a dimensionless number, because
 * CloudWatch has no unit for it and the alarms compare the bare number against a
 * threshold in hours. `Count` is kept for things that are counted.
 */
export type MetricUnit = Extract<CloudWatchUnit, 'Seconds' | 'Count' | 'None'>;

export const METRIC_UNITS: readonly MetricUnit[] = Object.freeze(['Seconds', 'Count', 'None']);

export function isCloudWatchUnit(unit: unknown): unit is CloudWatchUnit {
  return typeof unit === 'string' && (CLOUDWATCH_STANDARD_UNITS as readonly string[]).includes(unit);
}

export interface MetricDatum {
  readonly name: string;
  readonly value: number;
  readonly unit: MetricUnit;
  readonly dimensions?: Readonly<Record<string, string>> | undefined;
}

/**
 * Who raises a metric. Every value but `log_derived` is a collector the worker's
 * metric loop runs (`apps/worker/src/bootstrap/worker.ts`), named after the package
 * it lives in; `log_derived` is a CloudWatch metric filter over a structured log
 * event. `later_lane` is gone: the last four names it held were published or claimed
 * truthfully in lane g72, and a name nobody publishes has no value to claim here.
 */
export type MetricOwner = 'jobs' | 'mail' | 'outbound' | 'today' | 'sequences' | 'log_derived';

/** Every metric name the infrastructure alarms on, and who is responsible for it. */
export const METRIC_OWNERS: Readonly<Record<string, MetricOwner>> = Object.freeze({
  // Emitted here, from the job, heartbeat, canary and alert tables.
  ApiHeartbeat: 'jobs',
  SchedulerHeartbeat: 'jobs',
  WorkerHeartbeat: 'jobs',
  OldestRunnableJobAgeSeconds: 'jobs',
  DeadJobOldestAgeSeconds: 'jobs',
  // The newest canary run's scheduler-to-worker latency — `completed_at - inserted_at`
  // once the worker has written it, `now() - inserted_at` while it has not, worst over
  // the newest run of each workspace. Not the time since the last completion, which
  // sawtooths to 900 between quarter hours and made the alarm flap (g41).
  CanaryCompletionAgeSeconds: 'jobs',
  UnacknowledgedCriticalAlertAgeSeconds: 'jobs',

  // Emitted by `collectTodayMetrics` in `packages/domain/today/metrics.ts` on every
  // metric pass, from the day's `today.build` job and the workspace zone rather than
  // from `today_snapshots`, which a workspace with no firms never writes (lane g67).
  TodaySnapshotMissing: 'today',

  // Emitted by `collectMailMetrics` in `packages/domain/mail/metrics.ts`: the soonest
  // watch expiry over connected mailboxes, published only while one is connected.
  // Labelled `later_lane` until g72, long after the mail lane began publishing it.
  GmailWatchHoursToExpiry: 'mail',
  // Emitted by `collectMailMetrics` on every pass: 1 when every *connected* mailbox's
  // check is on time (and when none is connected), 0 otherwise. It was this lane's
  // until g81, read from every mailbox heartbeat row, so a mailbox nobody had
  // connected, or one its owner disconnected, alarmed as a missed check (audit O15).
  MailboxCheckHeartbeat: 'mail',
  // Emitted by `collectMailMetrics` while a mailbox is connected and `ready`: the
  // stalest coverage watermark's age by the send gate's freshness rule (lane g81).
  MailboxCoverageAgeSeconds: 'mail',
  // Emitted by `collectOutboundMetrics` in `packages/domain/outbound/metrics.ts`, which
  // can ask 12.6's "sent in the last 30 days" of `outbound_messages`. The mail lane's
  // collector declares the name too but publishes it only when handed recent senders,
  // and the worker hands it none. Also `later_lane` until g72.
  MailboxDisconnectedHours: 'outbound',

  // Emitted by `collectSequenceMetrics` in `packages/domain/sequences/metrics.ts` on
  // every metric pass, 0 and 0 when nothing is enrolled: the two inputs of the
  // `all_sequences_held` metric-math alarm (lane g72).
  ActiveEnrollments: 'sequences',
  HeldEnrollments: 'sequences',

  // Derived by a CloudWatch metric filter from a structured log event, so a task that
  // cannot reach the metrics API still raises them.
  SuppressionJournalWriteFailures: 'log_derived',
  OutboundSafetyInvariantFailures: 'log_derived',
});

/** The metric names this lane actually publishes. */
export const JOB_METRIC_NAMES: readonly string[] = Object.freeze(
  Object.entries(METRIC_OWNERS)
    .filter(([, owner]) => owner === 'jobs')
    .map(([name]) => name)
    .sort(),
);

const HEARTBEAT_METRIC: Readonly<Record<HeartbeatComponent, string>> = Object.freeze({
  api: 'ApiHeartbeat',
  scheduler: 'SchedulerHeartbeat',
  worker: 'WorkerHeartbeat',
  mailbox: 'MailboxCheckHeartbeat',
});

export type MetricErrorCode = 'METRIC_UNKNOWN' | 'METRIC_VALUE_INVALID' | 'METRIC_UNIT_INVALID' | 'METRIC_REJECTED';

/** One datum a sink did not publish, and why. Names and units only, never a value. */
export interface MetricRejection {
  readonly name: string;
  readonly unit: string;
  readonly errorName: string;
  readonly errorMessage: string;
}

export class MetricError extends Error {
  constructor(
    readonly code: MetricErrorCode,
    message: string,
    /** For `METRIC_REJECTED`: every datum that was not published. The rest were. */
    readonly rejected: readonly MetricRejection[] = [],
  ) {
    super(message);
    this.name = 'MetricError';
  }
}

/** Refuse a datum the alarms could not read. Runs in every environment, including none. */
export function validateMetricDatum(datum: MetricDatum): void {
  if (METRIC_OWNERS[datum.name] === undefined) {
    throw new MetricError('METRIC_UNKNOWN', `${datum.name} is not a metric any alarm reads`);
  }
  if (!Number.isFinite(datum.value)) {
    throw new MetricError('METRIC_VALUE_INVALID', `${datum.name} was given a value that is not a number`);
  }
  if (!isCloudWatchUnit(datum.unit)) {
    throw new MetricError('METRIC_UNIT_INVALID', `${datum.name} was given the unit ${String(datum.unit)}, which CloudWatch does not accept`);
  }
}

export function metricRejection(datum: MetricDatum, error: unknown): MetricRejection {
  const code = error instanceof MetricError ? error.code : undefined;
  return {
    name: String(datum.name),
    unit: String(datum.unit),
    errorName: code ?? (error instanceof Error ? error.name : 'unknown'),
    errorMessage: error instanceof Error ? error.message : 'a value that is not an Error was thrown',
  };
}

/** Split a publication into the data that may be sent and the data that may not. */
export function partitionMetricData(data: readonly MetricDatum[]): {
  readonly valid: readonly MetricDatum[];
  readonly rejected: readonly MetricRejection[];
} {
  const valid: MetricDatum[] = [];
  const rejected: MetricRejection[] = [];
  for (const datum of data) {
    try {
      validateMetricDatum(datum);
      valid.push(datum);
    } catch (error) {
      rejected.push(metricRejection(datum, error));
    }
  }
  return { valid, rejected };
}

/** The one error a partial publication ends in, after everything else was published. */
export function metricRejectedError(rejected: readonly MetricRejection[]): MetricError {
  const names = rejected.map(entry => `${entry.name} (${entry.errorName})`).join(', ');
  return new MetricError('METRIC_REJECTED', `not published: ${names}`, rejected);
}

/**
 * Publish what is valid through `send`, then throw once for what was not. Every sink
 * goes through here, so a laptop, a test and production refuse the same data the
 * same way and still publish the rest.
 */
export async function publishValidMetricData(
  data: readonly MetricDatum[],
  send: (valid: readonly MetricDatum[]) => Promise<void>,
): Promise<void> {
  const { valid, rejected } = partitionMetricData(data);
  let later: readonly MetricRejection[] = [];
  if (valid.length > 0) {
    try {
      await send(valid);
    } catch (error) {
      if (!(error instanceof MetricError) || error.code !== 'METRIC_REJECTED') throw error;
      later = error.rejected;
    }
  }
  const all = [...rejected, ...later];
  if (all.length > 0) throw metricRejectedError(all);
}

export interface MetricSink {
  publish(data: readonly MetricDatum[]): Promise<void>;
}

/** What a real CloudWatch client is narrowed to. Nothing here imports an AWS SDK. */
export type PutMetricData = (namespace: string, data: readonly MetricDatum[]) => Promise<void>;

export interface MetricSinkOptions {
  readonly namespace: string;
  /** Absent locally and in tests, which is what makes the sink a validating no-op. */
  readonly putMetricData?: PutMetricData | undefined;
}

export function createMetricSink(options: MetricSinkOptions): MetricSink {
  return {
    publish: async data => {
      await publishValidMetricData(data, async valid => {
        if (options.putMetricData === undefined) return;
        await options.putMetricData(options.namespace, valid);
      });
    },
  };
}

/** A sink that keeps what it was given, for tests that assert on the emission. */
export function recordingMetricSink(): MetricSink & { readonly published: MetricDatum[] } {
  const published: MetricDatum[] = [];
  return {
    published,
    publish: async data => {
      await publishValidMetricData(data, async valid => {
        published.push(...valid);
        await Promise.resolve();
      });
    },
  };
}

/**
 * Read the operational gauges from the database.
 *
 * Absence is meaningful and is expressed by absence: no runnable job means no
 * `OldestRunnableJobAgeSeconds` datapoint, and the alarm's `notBreaching` handling of
 * missing data is what makes that correct. The one exception is the heartbeats, whose
 * alarms treat missing data as *breaching*: a stale component is published as zero so
 * that "we looked and it was dead" and "we could not look" stay distinguishable.
 */
export async function collectJobMetrics(db: Queryable): Promise<MetricDatum[]> {
  const data: MetricDatum[] = [];

  const oldest = await db.query<{ age_seconds: string | null }>(
    `SELECT extract(epoch FROM now() - min(greatest(run_at, not_before)))::text AS age_seconds
       FROM jobs
      WHERE state IN ('queued', 'retryable') AND run_at <= now() AND not_before <= now()`,
  );
  const oldestAge = oldest.rows[0]?.age_seconds;
  if (oldestAge !== null && oldestAge !== undefined) {
    data.push({ name: 'OldestRunnableJobAgeSeconds', value: Number(oldestAge), unit: 'Seconds' });
  }

  const dead = await db.query<{ age_seconds: string | null }>(
    "SELECT extract(epoch FROM now() - min(dead_at))::text AS age_seconds FROM jobs WHERE state = 'dead'",
  );
  const deadAge = dead.rows[0]?.age_seconds;
  if (deadAge !== null && deadAge !== undefined) {
    data.push({ name: 'DeadJobOldestAgeSeconds', value: Number(deadAge), unit: 'Seconds' });
  }

  const canaryAge = await canaryCompletionAgeSeconds(db);
  if (canaryAge !== null) {
    data.push({ name: 'CanaryCompletionAgeSeconds', value: canaryAge, unit: 'Seconds' });
  }

  const unacknowledged = await unacknowledgedCriticalAlertAgeSeconds(db);
  if (unacknowledged !== null) {
    data.push({ name: 'UnacknowledgedCriticalAlertAgeSeconds', value: unacknowledged, unit: 'Seconds' });
  }

  // One datapoint per component, not per instance: the alarms are `Sum < 1`, so "any
  // instance of this component is alive" is the question they ask. The mailbox
  // heartbeat is not here since lane g81: its question is "is every connected mailbox
  // being checked", which needs the mailbox table, so the mail lane publishes it
  // (`collectMailMetrics`).
  const freshest = new Map<HeartbeatComponent, boolean>();
  for (const heartbeat of await readHeartbeats(db)) {
    if (heartbeat.component === 'mailbox') continue;
    freshest.set(heartbeat.component, (freshest.get(heartbeat.component) ?? false) || heartbeat.fresh);
  }
  for (const [component, fresh] of freshest) {
    data.push({ name: HEARTBEAT_METRIC[component], value: fresh ? 1 : 0, unit: 'Count' });
  }

  return data;
}
