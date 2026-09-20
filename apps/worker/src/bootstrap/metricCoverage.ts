/**
 * Every alarm metric this process does *not* publish, and what raises it instead.
 *
 * `infra/modules/alerts/main.tf` is the contract: each entry of `local.alarms` watches
 * one metric name. `packages/domain/jobs/metrics.ts` publishes the ones that can be
 * read out of the job, heartbeat, canary and alert tables. The rest are here, each
 * with the mechanism that raises it, and `test/metricCoverage.test.ts` starts the real
 * worker, records what it publishes, and fails when an alarm name is in neither list.
 *
 * An alarm over a metric nobody emits never fires, and an operator who has seen the
 * alarm exist will believe it is watching. That is worse than having no alarm, so the
 * gap is written down as work rather than left to be discovered in a rehearsal.
 */

export type MetricRaiser = 'log_event' | 'api_process' | 'later_lane';

export interface ApplicationRaisedMetric {
  readonly raisedBy: MetricRaiser;
  /**
   * For `log_event`, the exact `$.event` value the CloudWatch metric filter in
   * `infra/modules/observability/main.tf` matches. For the others, the lane or process.
   */
  readonly detail: string;
  readonly why: string;
}

export const APPLICATION_RAISED_METRICS: Readonly<Record<string, ApplicationRaisedMetric>> = Object.freeze({
  // Derived from a structured log line rather than from PutMetricData, so a task that
  // cannot reach the metrics API still raises the three immediately-critical ones.
  SuppressionJournalWriteFailures: {
    raisedBy: 'log_event',
    detail: 'suppression_journal_write_failed',
    why: 'the API writes the journal (10.2); the metric filter counts the failure event',
  },
  RestoreGenerationMismatches: {
    raisedBy: 'log_event',
    detail: 'restore_generation_mismatch',
    why: 'this worker logs the event at startup when the generation is not the expected one (Appendix E 1)',
  },
  OutboundSafetyInvariantFailures: {
    raisedBy: 'log_event',
    detail: 'outbound_invariant_violation',
    why: 'the outbound fence lane raises it from the send path (Appendix B)',
  },

  // Owned by the lanes that build the tables they are read from. Each one is a metric
  // the worker will publish once that table exists, through the same metric loop.
  TodaySnapshotMissing: {
    raisedBy: 'later_lane',
    detail: 'today list',
    why: 'no today_snapshots table exists yet; 13.3 alarms at 05:10 workspace time',
  },
});
