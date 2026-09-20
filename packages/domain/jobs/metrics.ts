import type { Queryable } from '../db/queryable.ts';
import { canaryCompletionAgeSeconds } from './canary.ts';
import { unacknowledgedCriticalAlertAgeSeconds } from './criticalAlerts.ts';
import { readHeartbeats, type HeartbeatComponent } from './heartbeats.ts';

/**
 * The operational metrics, and the thin adapter that publishes them.
 *
 * The contract is not ours to invent: `infra/modules/alerts/main.tf` names every
 * metric an alarm reads, and `infra/modules/observability/main.tf` names the ones
 * derived from log events. `METRIC_OWNERS` below claims one of three things about
 * each of those names — this lane emits it, a log filter derives it, or a later lane
 * owns it — and `test/jobs/observability.test.ts` reads the two Terraform files and fails
 * if a name exists there without a claim here, or here without existing there. A
 * metric nobody emits is an alarm that never fires, which is worse than no alarm.
 *
 * The adapter takes a `putMetricData` function rather than importing an AWS SDK.
 * Locally none is supplied and publishing is a no-op that still validates the data,
 * so a wrong unit or an unknown metric name fails on a laptop rather than in
 * production.
 */

export type MetricUnit = 'Seconds' | 'Hours' | 'Count' | 'None';

export interface MetricDatum {
  readonly name: string;
  readonly value: number;
  readonly unit: MetricUnit;
  readonly dimensions?: Readonly<Record<string, string>> | undefined;
}

export type MetricOwner = 'jobs' | 'log_derived' | 'later_lane';

/**
 * Every metric name the infrastructure alarms on, and who is responsible for it.
 * `later_lane` names the slice that will emit it, so the gap is a scheduled piece of
 * work rather than a surprise during a rehearsal.
 */
export const METRIC_OWNERS: Readonly<Record<string, MetricOwner>> = Object.freeze({
  // Emitted here, from the job, heartbeat, canary and alert tables.
  ApiHeartbeat: 'jobs',
  SchedulerHeartbeat: 'jobs',
  WorkerHeartbeat: 'jobs',
  MailboxCheckHeartbeat: 'jobs',
  OldestRunnableJobAgeSeconds: 'jobs',
  DeadJobOldestAgeSeconds: 'jobs',
  CanaryCompletionAgeSeconds: 'jobs',
  UnacknowledgedCriticalAlertAgeSeconds: 'jobs',

  // Derived by a CloudWatch metric filter from a structured log event, so a task that
  // cannot reach the metrics API still raises them.
  SuppressionJournalWriteFailures: 'log_derived',
  RestoreGenerationMismatches: 'log_derived',
  OutboundSafetyInvariantFailures: 'log_derived',
  ApiErrors: 'log_derived',
  WorkerErrors: 'log_derived',
  Refusals: 'log_derived',
  StepsHeld: 'log_derived',
  DeadJobs: 'log_derived',

  // Owned by the lanes that build the tables they read.
  TodaySnapshotMissing: 'later_lane',
  GmailWatchHoursToExpiry: 'later_lane',
  MailboxDisconnectedHours: 'later_lane',
  ActiveEnrollments: 'later_lane',
  HeldEnrollments: 'later_lane',
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

export class MetricError extends Error {
  constructor(readonly code: 'METRIC_UNKNOWN' | 'METRIC_VALUE_INVALID', message: string) {
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
      for (const datum of data) validateMetricDatum(datum);
      if (options.putMetricData === undefined) return;
      await options.putMetricData(options.namespace, data);
    },
  };
}

/** A sink that keeps what it was given, for tests that assert on the emission. */
export function recordingMetricSink(): MetricSink & { readonly published: MetricDatum[] } {
  const published: MetricDatum[] = [];
  return {
    published,
    publish: async data => {
      for (const datum of data) validateMetricDatum(datum);
      published.push(...data);
      await Promise.resolve();
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
  // instance of this component is alive" is the question they ask. Per-mailbox
  // dimensions belong to the lane that connects mailboxes, which is also the lane that
  // will want to know *which* one went quiet.
  const freshest = new Map<HeartbeatComponent, boolean>();
  for (const heartbeat of await readHeartbeats(db)) {
    freshest.set(heartbeat.component, (freshest.get(heartbeat.component) ?? false) || heartbeat.fresh);
  }
  for (const [component, fresh] of freshest) {
    data.push({ name: HEARTBEAT_METRIC[component], value: fresh ? 1 : 0, unit: 'Count' });
  }

  return data;
}
