/**
 * The alarm-to-runbook table (specification 13.3).
 *
 * "Each alert has a tested runbook naming diagnosis, safe recovery, escalation, and
 * actions that must remain held."
 *
 * The alarm names are not ours. They are the keys of `local.alarms` in
 * `infra/modules/alerts/main.tf` — a file this lane may read and may not edit — plus
 * `all_sequences_held`, which is metric math rather than one metric and is therefore
 * its own resource. This table restates them so the application can put a runbook
 * path beside an open alert in Diagnostics, and
 * `packages/domain/test/dashboard/runbooks.test.ts` fails when this table, the
 * Terraform and the files in `docs/greenfield/runbooks/` stop agreeing.
 *
 * It is the same shape, and for the same reason, as `METRIC_OWNERS` in
 * `packages/domain/jobs/metrics.ts`: an alarm nobody can act on is nearly as bad as
 * an alarm that never fires, and the only way to keep the two lists equal is to make
 * a test compare them.
 */

export const RUNBOOK_DIRECTORY = 'docs/greenfield/runbooks';

/**
 * The headings every runbook carries. `## What must stay held` is the one the
 * specification is unusual in naming: the operator's instinct under an alarm is to
 * clear the blockage, and for most of these the blockage is the safety property.
 */
export const RUNBOOK_SECTIONS: readonly string[] = Object.freeze([
  '## Symptoms',
  '## First checks',
  '## Diagnosis',
  '## Safe recovery',
  '## Escalation',
  '## What must stay held',
]);

export interface AlarmRunbook {
  /** The CloudWatch metric the alarm reads. `all_sequences_held` reads two. */
  readonly metricName: string;
  readonly severity: 'critical' | 'warning';
  /** One line an operator sees beside the open alert, before they open the page. */
  readonly summary: string;
}

export const ALARM_RUNBOOKS: Readonly<Record<string, AlarmRunbook>> = Object.freeze({
  api_heartbeat_missed: {
    metricName: 'ApiHeartbeat',
    severity: 'critical',
    summary: 'The API has missed three one-minute heartbeats.',
  },
  scheduler_heartbeat_missed: {
    metricName: 'SchedulerHeartbeat',
    severity: 'critical',
    summary: 'The scheduler has missed three one-minute passes; no new due work is being materialized.',
  },
  worker_heartbeat_missed: {
    metricName: 'WorkerHeartbeat',
    severity: 'critical',
    summary: 'The worker has missed three one-minute heartbeats; queued jobs are waiting.',
  },
  mailbox_heartbeat_missed: {
    metricName: 'MailboxCheckHeartbeat',
    severity: 'critical',
    summary: 'A mailbox has missed three one-minute checks; coverage cannot be proved.',
  },
  today_snapshot_absent: {
    metricName: 'TodaySnapshotMissing',
    severity: 'critical',
    summary: 'No Today snapshot exists for the workspace business date at 05:10 workspace time.',
  },
  oldest_runnable_job_warning: {
    metricName: 'OldestRunnableJobAgeSeconds',
    severity: 'warning',
    summary: 'The oldest runnable job is older than five minutes.',
  },
  oldest_runnable_job_critical: {
    metricName: 'OldestRunnableJobAgeSeconds',
    severity: 'critical',
    summary: 'The oldest runnable job is older than fifteen minutes.',
  },
  gmail_watch_expiring: {
    metricName: 'GmailWatchHoursToExpiry',
    severity: 'critical',
    summary: 'A Gmail watch is within two days of expiry; push stops when it lapses.',
  },
  canary_stale: {
    metricName: 'CanaryCompletionAgeSeconds',
    severity: 'critical',
    summary: 'The scheduler-to-worker canary has not completed within five minutes.',
  },
  dead_job_unresolved: {
    metricName: 'DeadJobOldestAgeSeconds',
    severity: 'warning',
    summary: 'A dead job has been unresolved for an hour.',
  },
  mailbox_disconnected: {
    metricName: 'MailboxDisconnectedHours',
    severity: 'critical',
    summary: 'A mailbox that sent in the last 30 days has been disconnected for 48 hours.',
  },
  suppression_journal_failure: {
    metricName: 'SuppressionJournalWriteFailures',
    severity: 'critical',
    summary: 'A suppression journal write failed. Immediately critical.',
  },
  restore_generation_mismatch: {
    metricName: 'RestoreGenerationMismatches',
    severity: 'critical',
    summary: 'The database generation does not match the operator-controlled expected generation.',
  },
  outbound_invariant_failure: {
    metricName: 'OutboundSafetyInvariantFailures',
    severity: 'critical',
    summary: 'An outbound safety invariant failed. Immediately critical.',
  },
  unacknowledged_critical_alert: {
    metricName: 'UnacknowledgedCriticalAlertAgeSeconds',
    severity: 'warning',
    summary: 'A critical alert has been unacknowledged past its repeat interval.',
  },
  all_sequences_held: {
    metricName: 'HeldEnrollments',
    severity: 'critical',
    summary: 'Every active enrollment is held; automation has stopped across the workspace.',
  },
});

export function runbookPathOf(alarmKey: string): string {
  return `${RUNBOOK_DIRECTORY}/${alarmKey}.md`;
}

/**
 * The runbook for an application alert key, or null.
 *
 * `critical_alerts.alert_key` is chosen by whatever raised the condition and an alarm
 * key is chosen by Terraform. They are the same word where a condition has an alarm,
 * and null is the honest answer where they are not — better than a page that
 * describes a different failure.
 */
export function runbookForAlertKey(alertKey: string): { readonly alarmKey: string; readonly path: string } | null {
  return ALARM_RUNBOOKS[alertKey] === undefined
    ? null
    : { alarmKey: alertKey, path: runbookPathOf(alertKey) };
}
