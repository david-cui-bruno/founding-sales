import { describe, expect, it } from 'vitest';
import { readRepositoryFile } from './support/coverage.ts';

/**
 * The job-age alarms fire at the ages 13.3 names (lane g86, audit O18).
 *
 * 13.3: "oldest runnable job older than five minutes warning or fifteen minutes
 * critical". Until this lane both alarms required five consecutive one-minute breaches,
 * so the five-minute warning fired when the oldest job had waited about ten minutes and
 * the fifteen-minute critical at about twenty, while the labels said five and fifteen.
 *
 * One breach is enough because of what the metric is: `collectJobMetrics` publishes
 * `now() - min(greatest(run_at, not_before))` over the runnable jobs, and that grows by
 * a second a second until the job is claimed. A second consecutive breach of a quantity
 * that only grows confirms nothing the first did not; it only adds a minute.
 *
 * ## The vacuous-pass trap, named
 *
 * Checking the thresholds alone would pass the old five-of-five alarms, which had the
 * right thresholds. So the periods and datapoints are required as well, and the premise
 * the single datapoint rests on — the metric is an age that only grows — is read from
 * the collector's own query rather than assumed. The mutation appended to
 * `scripts/releaseMutationCheck.mjs` puts five of five back on the critical alarm and
 * requires this file to go red.
 */

const ALERTS = readRepositoryFile('infra/modules/alerts/main.tf');
const ALERT_VARIABLES = readRepositoryFile('infra/modules/alerts/variables.tf');
const METRICS = readRepositoryFile('packages/domain/jobs/metrics.ts');

function alarm(key: string): Readonly<Record<string, string>> {
  const start = ALERTS.indexOf(`    ${key} = {\n`);
  expect(start, `infra/modules/alerts/main.tf declares no ${key} alarm`).toBeGreaterThan(-1);
  const end = ALERTS.indexOf('\n    }', start);
  const attributes: Record<string, string> = {};
  for (const line of ALERTS.slice(start, end).split('\n').slice(1)) {
    const match = /^\s*([a-z_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) attributes[match[1]] = match[2];
  }
  return attributes;
}

function variableDefault(name: string): number {
  const start = ALERT_VARIABLES.indexOf(`variable "${name}" {`);
  expect(start, `infra/modules/alerts/variables.tf declares no ${name}`).toBeGreaterThan(-1);
  const block = ALERT_VARIABLES.slice(start, ALERT_VARIABLES.indexOf('\n}', start));
  const match = /\n\s*default\s*=\s*([0-9]+)[ \t]*(?:\n|$)/.exec(block);
  expect(match?.[1], `${name} has no literal numeric default`).toBeDefined();
  return Number(match?.[1]);
}

describe('the job-age alarms fire at the ages 13.3 names', () => {
  const cases = [
    { key: 'oldest_runnable_job_warning', variable: 'oldest_job_age_warning_seconds', seconds: 300 },
    { key: 'oldest_runnable_job_critical', variable: 'oldest_job_age_critical_seconds', seconds: 900 },
  ] as const;

  for (const { key, variable, seconds } of cases) {
    it(`${key} alarms on the first one-minute maximum above ${String(seconds)} s`, () => {
      const declared = alarm(key);
      expect(declared['metric_name']).toBe('"OldestRunnableJobAgeSeconds"');
      expect(declared['statistic']).toBe('"Maximum"');
      expect(declared['comparison']).toBe('"GreaterThanThreshold"');
      expect(declared['threshold']).toBe(`var.${variable}`);
      expect(variableDefault(variable)).toBe(seconds);
      expect(declared['period']).toBe('60');
      expect(declared['evaluation_periods']).toBe('1');
      expect(declared['datapoints_to_alarm']).toBe('1');
    });
  }

  it('reads an age that only grows while the job waits, which is why one breach is enough', () => {
    expect(METRICS).toContain('now() - min(greatest(run_at, not_before))');
    expect(METRICS).toContain("WHERE state IN ('queued', 'retryable') AND run_at <= now() AND not_before <= now()");
  });
});
