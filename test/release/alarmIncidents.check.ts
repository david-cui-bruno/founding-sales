import { describe, expect, it } from 'vitest';
import { METRIC_OWNERS } from '@fss/domain/jobs';
import { COVERAGE_FRESHNESS_SECONDS } from '@fss/domain/mail';
import { readRepositoryFile } from './support/coverage.ts';

/**
 * Three alarm defects the audit of 25 September found, and what now holds each shut
 * (lane g81).
 *
 * * **O14 — one open critical alarm hid the next.** One OR composite e-mailed on its
 *   own transitions only, so the second critical condition to trip while the first
 *   was open sent nothing. Each critical condition now has a composite of its own that
 *   changes state when it trips. Since lane g99 (the owner's decision 11C) no
 *   composite e-mails at all: the daily digest lists every state change, and
 *   `alarmDigest.check.ts` holds that half.
 * * **O15 — an unconnected mailbox read as critically broken.** The watch alarm
 *   treated a missing gauge as breaching, and the gauge is published only while a
 *   mailbox is connected; the check heartbeat was published from any mailbox heartbeat
 *   row. The watch alarm is not-breaching now, and the mail lane publishes the check
 *   heartbeat over connected mailboxes on every pass.
 * * **O16 — the restore-mismatch alarm cleared while the mismatch lasted.** The worker
 *   logged it once at startup. The metric loop logs it on every pass while it lasts,
 *   and the alarm clears only after three quiet minutes.
 *
 * ## The vacuous-pass trap, named
 *
 * These read Terraform and source as text, which proves wiring and not behaviour. So
 * each assertion reads the one block that decides — the alarm entry, the composite
 * resource, the metric-loop call — rather than the file, and asserts the old shape
 * absent as well as the new one present. The behaviour is proved elsewhere: the plan in
 * `infra/modules/alerts/tests/thresholds.tftest.hcl`, the check heartbeat against a
 * real PostgreSQL in `packages/domain/test/mail/mailboxCheckMetric.test.ts`, and the
 * repeated line by a real worker in `apps/worker/test/restoreGenerationContinuing.test.ts`.
 */

const ALERTS = readRepositoryFile('infra/modules/alerts/main.tf');
const WORKER = readRepositoryFile('apps/worker/src/bootstrap/worker.ts');

/** The `name = { … }` entry of `local.alarms`. */
function alarmEntry(name: string): string {
  const start = ALERTS.indexOf(`\n    ${name} = {\n`);
  if (start < 0) return '';
  const end = ALERTS.indexOf('\n    }\n', start);
  return end < 0 ? '' : ALERTS.slice(start, end);
}

function resourceBlock(type: string, name: string): string {
  const start = ALERTS.indexOf(`resource "${type}" "${name}" {`);
  if (start < 0) return '';
  const end = ALERTS.indexOf('\n}\n', start);
  return end < 0 ? ALERTS.slice(start) : ALERTS.slice(start, end);
}

const ROLL_UP = resourceBlock('aws_cloudwatch_composite_alarm', 'critical');
const PER_CONDITION = resourceBlock('aws_cloudwatch_composite_alarm', 'critical_condition');
const WARNING = resourceBlock('aws_cloudwatch_composite_alarm', 'warning');

describe('g81 / O14: every critical condition changes an alarm’s state when it trips', () => {
  it('still finds the three composites', () => {
    for (const block of [ROLL_UP, PER_CONDITION, WARNING]) expect(block).not.toBe('');
  });

  it('gives each critical condition a composite over its own alarm', () => {
    expect(PER_CONDITION).toContain('for_each = local.critical_condition_alarms');
    expect(PER_CONDITION).toContain('alarm_rule        = "ALARM(\\"${each.value}\\")"');
    expect(ALERTS).toContain('{ for name in local.critical_alarm_keys : name => aws_cloudwatch_metric_alarm.this[name].alarm_name },');
    expect(ALERTS).toContain('{ all_sequences_held = aws_cloudwatch_metric_alarm.all_sequences_held.alarm_name },');
  });

  it('lets no composite e-mail: the daily digest is the one e-mail (g99)', () => {
    // The old shape, asserted absent in each block that used to carry it: the roll-up's
    // all-clear, each condition's ALARM, and the warning roll-up's two.
    for (const [name, block] of [
      ['critical', ROLL_UP],
      ['critical_condition', PER_CONDITION],
      ['warning', WARNING],
    ] as const) {
      expect(block, name).toContain('alarm_actions   = []');
      expect(block, name).toContain('ok_actions      = []');
      expect(block, name).not.toContain('aws_sns_topic.alerts.arn');
      expect(block, name).not.toContain('insufficient_data_actions');
    }
  });

  it('holds back only what the worker’s own silence trips, behind the worker’s heartbeat alarm', () => {
    expect(PER_CONDITION).toContain('dynamic "actions_suppressor" {');
    expect(PER_CONDITION).toContain(
      'for_each = contains(local.worker_published_breaching_keys, each.key) ? [aws_cloudwatch_metric_alarm.this["worker_heartbeat_missed"].alarm_name] : []',
    );
    // The derivation: critical, breaching on missing data, not the worker's own.
    expect(ALERTS).toContain(
      'if alarm.severity == "critical" && alarm.treat_missing_data == "breaching" && name != "worker_heartbeat_missed"',
    );
    // And every metric that set reads is one the worker's metric loop publishes, which
    // is the whole reason its silence trips them.
    const held = ['api_heartbeat_missed', 'scheduler_heartbeat_missed', 'mailbox_heartbeat_missed', 'canary_stale'];
    for (const name of held) {
      const entry = alarmEntry(name);
      expect(entry, name).toContain('treat_missing_data  = "breaching"');
      expect(entry, name).toContain('severity            = "critical"');
      const metric = /metric_name\s+= "([A-Za-z]+)"/u.exec(entry)?.[1] ?? '';
      expect(METRIC_OWNERS[metric], `${name} reads ${metric}`).not.toBe('log_derived');
      expect(METRIC_OWNERS[metric], `${name} reads ${metric}`).toBeDefined();
    }
  });
});

describe('g81 / O15: no connected mailbox is not a critical condition', () => {
  it('reads a missing watch gauge as not breaching', () => {
    const entry = alarmEntry('gmail_watch_expiring');
    expect(entry).toContain('metric_name         = "GmailWatchHoursToExpiry"');
    expect(entry).toContain('treat_missing_data  = "notBreaching"');
    expect(entry).not.toContain('treat_missing_data  = "breaching"');
  });

  it('has the mail lane publish the check heartbeat, and the job lane not', () => {
    expect(METRIC_OWNERS['MailboxCheckHeartbeat']).toBe('mail');
    const jobs = readRepositoryFile('packages/domain/jobs/metrics.ts');
    expect(jobs).toContain("if (heartbeat.component === 'mailbox') continue;");
    const mail = readRepositoryFile('packages/domain/mail/metrics.ts');
    expect(mail).toContain("      WHERE m.status = 'connected'");
    expect(mail).toContain("data.push({ name: 'MailboxCheckHeartbeat', value: checks.every(check => check.fresh) ? 1 : 0, unit: 'Count' });");
  });
});

describe('g81 / O16: the restore-mismatch alarm holds while the mismatch does', () => {
  it('clears only after three quiet minutes and trips on one line', () => {
    const entry = alarmEntry('restore_generation_mismatch');
    expect(entry).toContain('metric_name         = "RestoreGenerationMismatches"');
    expect(entry).toContain('evaluation_periods  = 3');
    expect(entry).toContain('datapoints_to_alarm = 1');
    expect(METRIC_OWNERS['RestoreGenerationMismatches']).toBe('log_derived');
  });

  it('has the worker’s metric loop repeat the event on every pass', () => {
    const loop = WORKER.slice(WORKER.indexOf("name: 'metrics',"));
    expect(loop).toContain(
      'await observeRestoreGeneration(sessions.metrics, { expectedGeneration: config.expectedSystemGeneration, log });',
    );
    expect(loop.indexOf('observeRestoreGeneration')).toBeLessThan(loop.indexOf('for (const [collector, collect] of collectors)'));
  });
});

describe('g81: a stale coverage watermark is visible outside the Mac', () => {
  it('warns over the send gate’s own fifteen minutes, for three consecutive minutes', () => {
    const entry = alarmEntry('mailbox_coverage_stale');
    expect(entry).toContain('metric_name         = "MailboxCoverageAgeSeconds"');
    expect(entry).toContain('threshold           = var.mailbox_coverage_stale_seconds');
    expect(entry).toContain('comparison          = "GreaterThanThreshold"');
    expect(entry).toContain('period              = 60');
    expect(entry).toContain('evaluation_periods  = 3');
    expect(entry).toContain('datapoints_to_alarm = 3');
    expect(entry).toContain('treat_missing_data  = "notBreaching"');
    expect(entry).toContain('severity            = "warning"');

    const variables = readRepositoryFile('infra/modules/alerts/variables.tf');
    const start = variables.indexOf('variable "mailbox_coverage_stale_seconds" {');
    const block = variables.slice(start, variables.indexOf('\n}\n', start));
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain(`default     = ${String(COVERAGE_FRESHNESS_SECONDS)}\n`);
    expect(METRIC_OWNERS['MailboxCoverageAgeSeconds']).toBe('mail');
  });

  it('measures the column and the clock the gate measures', () => {
    const mail = readRepositoryFile('packages/domain/mail/metrics.ts');
    const reader = mail.slice(mail.indexOf('export async function mailboxCoverageAgeSeconds'));
    expect(reader).toContain('extract(epoch FROM (clock_timestamp() - coverage_watermark_at))::float8 AS age_seconds');
    expect(reader).toContain("WHERE status = 'connected' AND sync_state = 'ready'");
    expect(reader).toContain('coverageIsFresh(age)');
    const gate = readRepositoryFile('packages/domain/mail/coverage.ts');
    expect(gate).toContain('extract(epoch FROM (clock_timestamp() - coverage_watermark_at))::float8 AS age_seconds');
  });
});

describe('g81: a suppression journal failure can raise its alarm', () => {
  it('filters the failure event out of both log groups into the one metric', () => {
    const observability = readRepositoryFile('infra/modules/observability/main.tf');
    for (const [key, service] of [
      ['suppression_journal_write_failed', 'api'],
      ['suppression_journal_write_failed_worker', 'worker'],
    ] as const) {
      const start = observability.indexOf(`\n    ${key} = {\n`);
      expect(start, key).toBeGreaterThan(-1);
      const block = observability.slice(start, observability.indexOf('\n    }\n', start));
      expect(block, key).toContain(`service     = "${service}"`);
      expect(block, key).toContain('pattern     = "{ $.event = \\"suppression_journal_write_failed\\" }"');
      expect(block, key).toContain('metric_name = "SuppressionJournalWriteFailures"');
    }
  });

  it('has both writers log exactly that event when a write fails', () => {
    for (const [path, writer] of [
      ['apps/worker/src/bootstrap/deployment.ts', 'worker'],
      ['apps/api/src/bootstrap/deployment.ts', 'api'],
    ] as const) {
      expect(readRepositoryFile(path), path).toContain(
        `log.log('error', 'suppression_journal_write_failed', { writer: '${writer}', error_name: name });`,
      );
    }
  });
});
