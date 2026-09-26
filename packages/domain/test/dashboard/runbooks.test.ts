import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALARM_RUNBOOKS, RUNBOOK_DIRECTORY, RUNBOOK_SECTIONS, runbookPathOf } from '../../dashboard/index.ts';

/**
 * Every alarm the infrastructure raises has a runbook, and every runbook names an
 * alarm that exists (specification 13.3: "Each alert has a tested runbook naming
 * diagnosis, safe recovery, escalation, and actions that must remain held").
 *
 * The alarm list is not this repository's prose: it is `local.alarms` in
 * `infra/modules/alerts/main.tf`, plus the one alarm that could not be a single
 * metric and is therefore its own resource. This test reads that file as text —
 * `terraform` is never run — and asserts three things agree: the Terraform, the
 * `ALARM_RUNBOOKS` table the application reads, and the files on disk.
 *
 * The failure it exists to prevent is the quiet one: an operator woken at 03:00 by
 * an alarm whose name means nothing to them, with no page saying what is safe to do
 * and, more importantly, what must stay held while they do it.
 */

const REPOSITORY_ROOT = new URL('../../../../', import.meta.url).pathname;
const ALERTS_TF = fileURLToPath(new URL('../../../../infra/modules/alerts/main.tf', import.meta.url));

/** The keys of `local.alarms`, read as text at their own indentation. */
function alarmKeysInTerraform(): Set<string> {
  const text = readFileSync(ALERTS_TF, 'utf8');
  const start = text.indexOf('  alarms = {');
  expect(start, 'infra/modules/alerts/main.tf no longer declares local.alarms').toBeGreaterThan(-1);
  const keys = new Set<string>();
  for (const line of text.slice(start).split('\n').slice(1)) {
    // The block ends at the first line that closes it at the `local` indentation.
    if (line === '  }') break;
    const match = /^ {4}([a-z0-9_]+) = \{$/u.exec(line);
    if (match?.[1] !== undefined) keys.add(match[1]);
  }
  // "All active sequences unexpectedly held" is metric math rather than one metric,
  // so it is its own resource. 13.3 lists it, so it needs a runbook like the rest.
  for (const match of text.matchAll(/resource "aws_cloudwatch_metric_alarm" "([a-z0-9_]+)"/gu)) {
    const name = match[1];
    if (name !== undefined && name !== 'this') keys.add(name);
  }
  return keys;
}

function runbookFiles(): Set<string> {
  return new Set(
    readdirSync(new URL('../../../../docs/greenfield/runbooks/', import.meta.url).pathname)
      // `restore.md` is a procedure (the point-in-time restore), not an alarm's runbook.
      .filter(name => name.endsWith('.md') && name !== 'README.md' && name !== 'restore.md')
      .map(name => name.slice(0, -'.md'.length)),
  );
}

describe('alarm runbooks', () => {
  const declared = alarmKeysInTerraform();

  it('finds the alarms in the Terraform, so a later emptiness is a failure and not a pass', () => {
    expect(declared.size).toBeGreaterThanOrEqual(16);
    expect(declared.has('all_sequences_held')).toBe(true);
  });

  it('claims exactly the alarms the infrastructure declares', () => {
    expect(Object.keys(ALARM_RUNBOOKS).sort()).toEqual([...declared].sort());
  });

  it('has one runbook file per alarm and no orphans', () => {
    expect([...runbookFiles()].sort()).toEqual([...declared].sort());
  });

  it('gives every runbook the sections an operator needs at three in the morning', () => {
    for (const key of declared) {
      const text = readFileSync(`${REPOSITORY_ROOT}${runbookPathOf(key)}`, 'utf8');
      for (const section of RUNBOOK_SECTIONS) {
        expect(text, `${key}.md is missing ${section}`).toContain(section);
      }
      // The alarm name and the metric it reads, so a page found from a CloudWatch
      // notification can be matched to it without guessing.
      const entry = ALARM_RUNBOOKS[key];
      expect(entry, key).toBeDefined();
      expect(text, `${key}.md does not name its metric`).toContain(entry?.metricName ?? '');
    }
  });

  it('agrees with the Terraform about severity and metric', () => {
    const text = readFileSync(ALERTS_TF, 'utf8');
    for (const [key, entry] of Object.entries(ALARM_RUNBOOKS)) {
      if (key === 'all_sequences_held') continue;
      const block = text.slice(text.indexOf(`    ${key} = {`));
      const metric = /metric_name\s+= "([A-Za-z0-9]+)"/u.exec(block)?.[1];
      const severity = /severity\s+= "([a-z]+)"/u.exec(block)?.[1];
      expect(metric, key).toBe(entry.metricName);
      expect(severity, key).toBe(entry.severity);
    }
  });

  it('points at the directory the documents actually live in', () => {
    expect(RUNBOOK_DIRECTORY).toBe('docs/greenfield/runbooks');
    expect(runbookPathOf('canary_stale')).toBe('docs/greenfield/runbooks/canary_stale.md');
  });
});
