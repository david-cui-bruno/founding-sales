import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CLOUDWATCH_STANDARD_UNITS,
  METRIC_UNITS,
  MetricError,
  isCloudWatchUnit,
  validateMetricDatum,
  type MetricDatum,
} from '../../jobs/metrics.ts';

/**
 * Every unit this tree publishes is one CloudWatch accepts.
 *
 * On 24 September 2026 the first connected mailbox added `GmailWatchHoursToExpiry`
 * with the unit `Hours`, which is not a CloudWatch unit. `PutMetricData` rejects the
 * whole request over one bad member (`MetricData.member.6.Unit must be a value in
 * the set …`), so from 18:11Z no FSS worker metric was published at all. Nothing on
 * this side knew the set; now the set is in code and these tests read the source,
 * the Terraform and the validator against it.
 */

const REPOSITORY = fileURLToPath(new URL('../../../../', import.meta.url));

/** Where a metric datum can be written: the domain package, the worker and the API. */
const SOURCE_ROOTS = ['packages/domain', 'apps/worker/src', 'apps/api/src'];

function typeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry === 'test' || entry === 'dist') continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...typeScriptFiles(path));
    else if (path.endsWith('.ts')) files.push(path);
  }
  return files;
}

function terraformFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry.startsWith('.')) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...terraformFiles(path));
    else if (path.endsWith('.tf')) files.push(path);
  }
  return files;
}

/**
 * A metric datum literal is `{ name: …, value: …, unit: '…' }`, in that order, the
 * way every collector writes one. The sequence delays (`{ unit: 'elapsed', hours }`)
 * have no `name` and `value` before the unit and are not matched.
 */
const DATUM_UNIT = /\bname:\s*[^,{}]+,\s*value:[^{}]*?\bunit:\s*'([^']*)'/g;

describe('metric units', () => {
  it('knows the CloudWatch unit set, which has no Hours', () => {
    expect(CLOUDWATCH_STANDARD_UNITS).toHaveLength(27);
    for (const unit of ['Seconds', 'Milliseconds', 'Count', 'Percent', 'Bytes/Second', 'Count/Second', 'None']) {
      expect(isCloudWatchUnit(unit), unit).toBe(true);
    }
    for (const unit of ['Hours', 'Minutes', 'Days', 'hours', 'seconds', '', 'Count ']) {
      expect(isCloudWatchUnit(unit), unit).toBe(false);
    }
  });

  it('declares only units CloudWatch accepts', () => {
    const outside = METRIC_UNITS.filter(unit => !isCloudWatchUnit(unit));
    expect(outside).toEqual([]);
  });

  it('refuses a datum whose unit CloudWatch does not know', () => {
    const datum = { name: 'GmailWatchHoursToExpiry', value: 140, unit: 'Hours' } as unknown as MetricDatum;
    expect(() => validateMetricDatum(datum)).toThrow(MetricError);
    try {
      validateMetricDatum(datum);
    } catch (error) {
      expect((error as MetricError).code).toBe('METRIC_UNIT_INVALID');
    }
    expect(() => validateMetricDatum({ name: 'GmailWatchHoursToExpiry', value: 140, unit: 'None' })).not.toThrow();
  });

  it('publishes no unit outside the set from the domain, the worker or the API', () => {
    const found: { file: string; unit: string }[] = [];
    for (const root of SOURCE_ROOTS) {
      for (const file of typeScriptFiles(join(REPOSITORY, root))) {
        for (const match of readFileSync(file, 'utf8').matchAll(DATUM_UNIT)) {
          found.push({ file: relative(REPOSITORY, file), unit: match[1] ?? '' });
        }
      }
    }
    // The scan has to be finding the collectors, or it proves nothing.
    const files = new Set(found.map(entry => entry.file));
    expect(files).toContain('packages/domain/jobs/metrics.ts');
    expect(files).toContain('packages/domain/mail/metrics.ts');
    expect(files).toContain('packages/domain/outbound/metrics.ts');
    const outside = found.filter(entry => !isCloudWatchUnit(entry.unit));
    expect(outside, 'a metric datum carries a unit CloudWatch rejects').toEqual([]);
  });

  it('gives every Terraform metric transformation a unit CloudWatch accepts', () => {
    const found: { file: string; unit: string }[] = [];
    for (const file of terraformFiles(join(REPOSITORY, 'infra'))) {
      for (const match of readFileSync(file, 'utf8').matchAll(/^\s*unit\s*=\s*"([^"]*)"/gm)) {
        found.push({ file: relative(REPOSITORY, file), unit: match[1] ?? '' });
      }
    }
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter(entry => !isCloudWatchUnit(entry.unit))).toEqual([]);
  });
});
