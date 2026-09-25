import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mustBeRehearsed, readRepositoryFile, repositoryPath } from './support/coverage.ts';

/** The exact line the workflow step prints when there is nothing to drill yet. */
const SKIP_LINE = 'carry drill skipped: no cutover watermark yet';

/**
 * Run the carry drill offline, with the two carry variables under this test's control
 * rather than the ambient environment's.
 */
function runCarryDrill(
  prefix: string,
  carry: { readonly watermark?: string; readonly table?: string },
): { readonly exitCode: number; readonly output: string; readonly reports: string } {
  const reports = mkdtempSync(join(tmpdir(), 'fss-carry-'));
  const environment: Record<string, string> = { ...process.env } as Record<string, string>;
  delete environment['FSS_CARRY_WATERMARK'];
  delete environment['FSS_CARRY_SOURCE_TABLE'];
  environment['FSS_REHEARSAL_DRY_RUN'] = '1';
  environment['FSS_REHEARSAL_REPORTS'] = reports;
  if (carry.watermark !== undefined) environment['FSS_CARRY_WATERMARK'] = carry.watermark;
  if (carry.table !== undefined) environment['FSS_CARRY_SOURCE_TABLE'] = carry.table;

  try {
    const output = execFileSync(repositoryPath('infra/scripts/rehearsal-carry-watermark.sh'), [prefix], {
      env: environment,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { exitCode: 0, output, reports };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { exitCode: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`, reports };
  }
}

/** Write the four reports the release record demands, then run it. */
function runReleaseRecord(reports: string, carryReport: string): Record<string, unknown> {
  for (const [name, body] of [
    ['restore-drill.txt', 'prefix=fss-rh-check steps=9'],
    ['carry-watermark.txt', carryReport],
    ['schema-ranges.txt', 'prefix=fss-rh-check order=migrate,worker,api'],
    ['prefix-guard.txt', 'prefix=fss-rh-check production_untouched=true stable_repositories=rehearsal'],
  ] as const) {
    writeFileSync(join(reports, name), `${body}\n`);
  }
  const out = join(reports, 'release-record.json');
  execFileSync(
    repositoryPath('infra/scripts/rehearsal-release-record.sh'),
    [
      'fss-rh-check',
      `sha256:${'a'.repeat(64)}`,
      `sha256:${'b'.repeat(64)}`,
      '0123456789abcdef0123456789abcdef01234567',
      'pass',
      out,
    ],
    { env: { ...process.env, FSS_REHEARSAL_DRY_RUN: '1', FSS_REHEARSAL_REPORTS: reports }, encoding: 'utf8', stdio: 'pipe' },
  );
  return JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
}

/**
 * Appendix G 20: "Post-watermark sends and suppressions exist; the old stack is
 * read-only and cannot be a rollback target."
 *
 * The first half is provable on a laptop and the carry suites prove it: the export
 * refuses a table that wrote after the watermark, and the import refuses a record
 * recorded after it even in a hand-made artifact. The second half is not provable
 * anywhere but in the rehearsal, because "the old stack is read-only" is a statement
 * about a running deployment, not about this repository — hence the script and the
 * workflow entry this check insists on.
 *
 * ## The vacuous-pass trap
 *
 * A carry run over a fixture with no post-watermark write never reaches the refusal;
 * the export succeeds, the counts match and the suite is green while the one rule
 * that matters was never consulted. `tableWithPostWatermarkWrite` exists for exactly
 * this, and the rehearsal script asserts the export refuses on the real table. This
 * file makes the fixture's existence a gate condition rather than a convention: if
 * the fixture is deleted or renamed, the round-trip suite still passes its other
 * cases and this check goes red.
 */

describe('Appendix G 20: the carry refuses what the old stack wrote after the watermark', () => {
  mustBeRehearsed(20);

  it('keeps the post-watermark fixture, and uses it to reach the refusal', () => {
    const roundTrip = readRepositoryFile('apps/worker/test/carry/roundTrip.test.ts');
    expect(roundTrip).toContain('tableWithPostWatermarkWrite');
    // The refusal reasons, named. An export that merely returned fewer items would
    // look like a successful carry of a smaller table.
    expect(roundTrip).toContain('post_watermark_items_present');
    expect(roundTrip).toContain('post_watermark_record');

    // And the fixture is real rather than a stub the test file declares inline.
    const fixtures = readRepositoryFile('apps/worker/test/fixtures/carry/oldTable.ts');
    expect(fixtures).toContain('export function tableWithPostWatermarkWrite');
  });

  describe('before the cutover there is no watermark, and the drill says so rather than inventing one', () => {
    // `FSS_REHEARSAL_CARRY_WATERMARK` and `FSS_REHEARSAL_CARRY_TABLE` name an instant
    // and a table that do not exist until the cutover is scheduled. Making them
    // required secrets would mean either inventing values — a drill against a made-up
    // watermark proves nothing and would still write a release record — or blocking
    // the first release on a cutover that comes after it.
    //
    // ## The vacuous-pass trap this opens, and how it is closed
    //
    // A skippable step is a step that can be skipped by accident, and Appendix G 20
    // would then be green in a release record while nothing ran. Closed three ways:
    // the skip is only legal when *both* variables are absent (half a configuration
    // is a refusal); the release record carries the drill's own verdict rather than
    // an assumption; and the half of 20 that needs no watermark — the old stack has
    // no writer — runs in the skip branch too.

    it('skips with exactly one line when neither variable is set', () => {
      const { exitCode, output, reports } = runCarryDrill('fss-rh-check', {});
      expect(exitCode, output).toBe(0);
      expect(output.split('\n')).toContain(SKIP_LINE);

      const report = readFileSync(join(reports, 'carry-watermark.txt'), 'utf8');
      expect(report).toContain('carry_drill=skipped_no_watermark');
    });

    it('still proves the old stack has no writer while skipping', () => {
      const { output } = runCarryDrill('fss-rh-check', {});
      // The half of scenario 20 that is a property of this repository rather than of a
      // cutover. If the skip branch stopped running it, "the old stack is not a
      // rollback target" would be unchecked for every release before the cutover.
      expect(output).toContain('cannot write to it');
      expect(output).toContain('no legacy state key');
    });

    it('refuses half a configuration, because a watermark with no table is a mistake', () => {
      for (const carry of [{ watermark: '2026-09-21T00:00:00Z' }, { table: 'old-table' }]) {
        const { exitCode, output } = runCarryDrill('fss-rh-check', carry);
        expect(exitCode, JSON.stringify(carry)).not.toBe(0);
        expect(output).toContain('both or neither');
      }
    });

    it('runs the drill as before when both are set, so the skip is not the only path', () => {
      const { exitCode, output, reports } = runCarryDrill('fss-rh-check', {
        watermark: '2026-09-21T00:00:00Z',
        table: 'rehearsal-old-table',
      });
      expect(exitCode, output).toBe(0);
      expect(output).not.toContain(SKIP_LINE);
      expect(readFileSync(join(reports, 'carry-watermark.txt'), 'utf8')).toContain('carry_drill=ran');
    });
  });

  describe('the release record carries the drill’s own verdict', () => {
    it('reports skipped_no_watermark only when the drill reported it', () => {
      const { reports } = runCarryDrill('fss-rh-check', {});
      const record = runReleaseRecord(reports, 'prefix=fss-rh-check carry_drill=skipped_no_watermark');
      expect(record['carryDrill']).toBe('skipped_no_watermark');
      // The record still refuses to exist for a run that did not finish; the drill
      // being skipped is not the same fact as the suite being red.
      expect(record['suite']).toBe('pass');
      expect(record['enablesSending']).toBe(false);
    });

    it('reports ran when the drill ran, so the two states are distinguishable', () => {
      const { reports } = runCarryDrill('fss-rh-check', {
        watermark: '2026-09-21T00:00:00Z',
        table: 'rehearsal-old-table',
      });
      const record = runReleaseRecord(reports, 'prefix=fss-rh-check old_stack=read_only carry_drill=ran');
      expect(record['carryDrill']).toBe('ran');
    });
  });

  it('exercises both branches in the workflow’s dry run, with no credential', () => {
    const workflow = readRepositoryFile('.github/workflows/greenfield-release.yml');
    // The present branch is the existing plan step; the absent branch is its own step,
    // because a dry run that only ever saw one of them would not be a dry run of what
    // the first release actually does.
    expect(workflow).toContain(SKIP_LINE);
    expect(workflow).toContain('carryDrill');
  });
});
