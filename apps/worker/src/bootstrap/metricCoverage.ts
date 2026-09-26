/**
 * Every alarm metric this process does *not* publish, and what raises it instead.
 *
 * `infra/modules/alerts/main.tf` is the contract: each entry of `local.alarms` watches
 * one metric name, and `all_sequences_held`, its own resource because it is metric
 * math, watches two. The worker's metric loop publishes the ones its collectors read
 * out of the database: `packages/domain/jobs/metrics.ts` (the job, heartbeat, canary
 * and alert tables), the mail and outbound lanes' gauges, the Today lane's
 * `TodaySnapshotMissing` (g67) and the sequences lane's `ActiveEnrollments` and
 * `HeldEnrollments` (g72). The rest are here, each with the log event a CloudWatch
 * metric filter counts, and `test/metricCoverage.test.ts` starts the real worker,
 * records what it publishes, and fails when an alarm name is in neither list — or when
 * `METRIC_OWNERS` claims a collector for a name the worker did not publish.
 *
 * An alarm over a metric nobody emits never fires, and an operator who has seen the
 * alarm exist will believe it is watching. That is worse than having no alarm. Until
 * g72 this list could also hold a metric "owed by a later lane"; it cannot any more.
 * A metric is published by the worker or derived from a log event, and a new alarm
 * over anything else fails the coverage test until somebody publishes it.
 */

export type MetricRaiser = 'log_event';

export interface ApplicationRaisedMetric {
  readonly raisedBy: MetricRaiser;
  /** The exact `$.event` value the CloudWatch metric filter in `infra/modules/observability/main.tf` matches. */
  readonly detail: string;
  readonly why: string;
}

export const APPLICATION_RAISED_METRICS: Readonly<Record<string, ApplicationRaisedMetric>> = Object.freeze({
  // Derived from a structured log line rather than from PutMetricData, so a task that
  // cannot reach the metrics API still raises the two immediately-critical ones.
  SuppressionJournalWriteFailures: {
    raisedBy: 'log_event',
    detail: 'suppression_journal_write_failed',
    why: 'the API and the worker write the journal (10.2) and each logs the failure event; a metric filter on each log group counts it (lane g81)',
  },
  OutboundSafetyInvariantFailures: {
    raisedBy: 'log_event',
    detail: 'outbound_invariant_violation',
    why: 'the outbound fence lane raises it from the send path (Appendix B)',
  },
});
