import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mustBeRehearsed, readRepositoryFile, repositoryPath } from './support/coverage.ts';

/**
 * Appendix G 11: "A restore predating an accepted send, reply, suppression, ordinary
 * CRM edit and migration: protected effects reconstruct, the accepted CRM RPO is
 * reported, no send repeats."
 *
 * Nothing on a laptop can prove this. It needs a database restored from a real
 * point-in-time backup, real Gmail Sent folders to reconstruct sends from, and a real
 * suppression journal to replay — which is why it is rehearsal-only and why the check
 * here asserts the drill exists and the release workflow runs it rather than
 * attempting the drill. What this file adds beyond that is the drill's own shape:
 * Appendix E's nine steps, all present, in a document the operator follows under
 * pressure.
 *
 * ## The vacuous-pass trap
 *
 * A drill run against an empty restored database reconstructs nothing, reports zero
 * unresolved exceptions and passes in about four minutes. That is closed twice over:
 * step 0.1 of the runbook generates all six kinds of activity *before* the restore
 * point so there is something to reconstruct, and `rehearsal-restore-drill.sh`
 * refuses to report a pass when the baseline counts are zero. The trap left for this
 * file is a runbook quietly losing a step — the replay, or the watch renewal — which
 * would narrow the drill without failing it, so the nine headings are asserted by
 * name.
 */

describe('Appendix G 11: the restore drill is nine steps and has something to restore', () => {
  mustBeRehearsed(11);

  it('keeps all nine of Appendix E’s steps in the runbook', () => {
    const drill = readRepositoryFile('docs/greenfield/restore-drill.md');
    for (let step = 1; step <= 9; step += 1) {
      expect(drill, `the runbook has lost step ${String(step)}`).toContain(`## Step ${String(step)}.`);
    }
    // The last step is the one that ends the outage, and it is gated on the one
    // before it rather than on the operator's judgement.
    expect(drill).toContain('## Step 9. Advance the generation and release the restore holds');
  });

  it('generates the evidence before the restore point, and gates the pass on it', () => {
    const drill = readRepositoryFile('docs/greenfield/restore-drill.md');
    // Step 0.1 is what stops the empty-database pass. It comes before step 1, which
    // is the restore itself, and the drill script reads the counts it produces.
    expect(drill).toContain('### 0.1 Create the evidence the drill has to reconstruct');
    expect(drill.indexOf('### 0.1')).toBeLessThan(drill.indexOf('## Step 1.'));
    expect(drill).toContain('/tmp/restore-report.json');

    const script = readRepositoryFile('infra/scripts/rehearsal-restore-drill.sh');
    expect(script).toContain('restore-report.json');
  });

  it('actually refuses a baseline with nothing to reconstruct', async () => {
    // Asserting that the refusal is *written* would pass against a refusal somebody had
    // commented out, so the script is run. In dry-run mode it reaches nothing — every
    // `aws` and `fss` call prints a plan — and it honours a baseline the caller placed,
    // which is how an empty one can be handed to it offline.
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execFileSync } = await import('node:child_process');

    const reports = mkdtempSync(join(tmpdir(), 'fss-drill-'));
    writeFileSync(
      join(reports, 'baseline.json'),
      JSON.stringify({ sends: 0, replies: 0, suppressions: 0, crm_edits: 0, migrations: 0 }),
    );

    let exitCode = 0;
    let output = '';
    try {
      execFileSync(repositoryPath('infra/scripts/rehearsal-restore-drill.sh'), ['fss-rh-empty'], {
        env: { ...process.env, FSS_REHEARSAL_DRY_RUN: '1', FSS_REHEARSAL_REPORTS: reports },
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (error) {
      const failure = error as { status?: number; stderr?: string; stdout?: string };
      exitCode = failure.status ?? 1;
      output = `${failure.stderr ?? ''}${failure.stdout ?? ''}`;
    }
    expect(exitCode, 'the drill reported a pass against a baseline with nothing in it').not.toBe(0);
    expect(output).toContain('the drill baseline has no sends');
  });

  it('and reports a pass when there is something to reconstruct, so the refusal is not free', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execFileSync } = await import('node:child_process');

    const reports = mkdtempSync(join(tmpdir(), 'fss-drill-'));
    const output = execFileSync(repositoryPath('infra/scripts/rehearsal-restore-drill.sh'), ['fss-rh-full'], {
      env: { ...process.env, FSS_REHEARSAL_DRY_RUN: '1', FSS_REHEARSAL_REPORTS: reports },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    expect(output).toContain('Appendix E steps 1 to 9 complete');
  });
});

/**
 * G12f: the drill refuses its own missing preconditions before it creates anything.
 *
 * The first credentialed rehearsal never reached this script, but reading the order it
 * runs in found two ways it would have failed only in the cloud, both after money had
 * been spent:
 *
 *   * `FSS_RESTORE_TARGET` is handed straight to `date`, whose GNU and BSD branches
 *     both parse exactly `YYYY-MM-DDTHH:MM:SSZ`. Anything else died inside a command
 *     substitution with `date: illegal time format` and no statement of the cause;
 *   * every non-dry step runs `fss admin …`, and nothing in this repository builds an
 *     `fss` executable — no `bin` in any package, no install step in the release
 *     workflow. The first `command not found` would have arrived at step 0, or, had
 *     the baseline come from elsewhere, after step 1 had created a restored RDS
 *     instance nobody was going to use.
 *
 * ## The vacuous-pass trap
 *
 * A precondition check that runs in dry mode only is a check of the fixture: dry mode
 * reaches no `fss` and needs none, so a guard that fired there would say nothing about
 * the credentialed run and would break every pull request. So the `fss` check runs in
 * the real branch, and it is tested by running the drill with an empty PATH rather than
 * by reading the script.
 */
describe('Appendix G 11: the drill refuses its own missing preconditions', () => {
  /** Run the drill and report everything it said. */
  function runDrill(
    prefix: string,
    environment: Readonly<Record<string, string>>,
  ): { readonly code: number; readonly output: string } {
    const result = spawnSync(repositoryPath('infra/scripts/rehearsal-restore-drill.sh'), [prefix], {
      encoding: 'utf8',
      env: { ...process.env, ...environment },
    });
    return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
  }

  it('refuses a restore target the date arithmetic cannot parse', () => {
    const { code, output } = runDrill('fss-rh-shape', {
      FSS_REHEARSAL_DRY_RUN: '1',
      FSS_REHEARSAL_REPORTS: mkdtempSync(join(tmpdir(), 'fss-target-')),
      FSS_RESTORE_TARGET: '2026-09-21 00:00:00',
    });

    expect(code).not.toBe(0);
    expect(output).toContain('is not an instant this drill can measure from');
  });

  it('accepts one it can, so the refusal is not a refusal of everything', () => {
    // The positive control: without it, a guard that refused every target would pass
    // the case above and take the whole drill down with it.
    const { code, output } = runDrill('fss-rh-shape', {
      FSS_REHEARSAL_DRY_RUN: '1',
      FSS_REHEARSAL_REPORTS: mkdtempSync(join(tmpdir(), 'fss-target-ok-')),
      FSS_RESTORE_TARGET: '2026-09-21T00:00:00Z',
    });

    expect(code, output).toBe(0);
    expect(output).toContain('restore target 2026-09-21T00:00:00Z');
  });

  it('names the missing fss executable rather than dying halfway through the drill', () => {
    const { code, output } = runDrill('fss-rh-nocli', {
      FSS_REHEARSAL_REPORTS: mkdtempSync(join(tmpdir(), 'fss-nocli-')),
      PATH: `${mkdtempSync(join(tmpdir(), 'fss-nopath-'))}:/usr/bin:/bin`,
    });

    expect(code).not.toBe(0);
    expect(output).toContain('no fss executable is on PATH');
  });
});
