import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { readRepositoryFile } from './support/repository.ts';

const workflow = readRepositoryFile('.github/workflows/greenfield-deploy.yml');
const google = readRepositoryFile('.github/workflows/greenfield-google.yml');
const executeName = 'Decrypt, stop if needed, apply exact saved bytes, migrate, restart and verify';

function job(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`Missing job ${name}`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/^ {2}[a-z-]+:\n/mu);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function step(source: string, name: string): string {
  const start = source.indexOf(`      - name: ${name}\n`);
  if (start < 0) throw new Error(`Missing step ${name}`);
  const next = source.indexOf('\n      - ', start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

function body(source: string): string {
  const script = source.split('        run: |\n')[1];
  if (!script) throw new Error('Missing shell body');
  return script.split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
}

interface Admission {
  readonly hold?: string;
  readonly event?: string;
  readonly mode?: string;
  readonly decision?: string;
}

/** Evaluate the actual simple job condition, not a second copy of the admission rule.
 * Hosted environment approval is deliberately NOT simulated or claimed by this helper.
 */
function admitted(name: string, input: Admission): boolean {
  const condition = job(name).match(/^ {4}if: (.+)$/mu)?.[1];
  if (!condition) throw new Error(`Missing condition ${name}`);
  const evaluate = new Function('github', 'inputs', 'needs', 'vars', `return (${condition});`);
  return evaluate(
    { event_name: input.event ?? 'workflow_dispatch' },
    { release_mode: input.mode ?? 'reviewed' },
    { gates: { outputs: { decision: input.decision ?? 'pass' } }, deploy: { result: 'success', outputs: { decision: 'maintenance' } } },
    input.hold === undefined ? {} : { FSS_RELEASE_HOLD: input.hold },
  ) === true;
}

function summary(result: string, mode = 'reviewed'): { output: string; file: string } {
  const source = step(job('summary'), 'One line');
  const names = [...source.matchAll(/^ {10}([A-Z_]+): \$\{\{/gmu)].map(match => match[1] ?? '');
  const directory = mkdtempSync(join(tmpdir(), 'scoped-reviewed-summary-'));
  try {
    const file = join(directory, 'summary');
    writeFileSync(file, '');
    const run = spawnSync('bash', ['-c', body(source)], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, ...Object.fromEntries(names.map(name => [name, ''])), COMMIT: 'b'.repeat(40), RELEASE_HOLD: 'true', RELEASE_MODE: mode, REVIEWED_RESULT: result, GITHUB_STEP_SUMMARY: file },
    });
    expect(run.status, run.stderr).toBe(0);
    return { output: run.stdout, file: readFileSync(file, 'utf8') };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe('protected reviewed execution without a shared release window', () => {
  it('keeps missing shared hold fail-closed and literal false only in the exact execute step', () => {
    expect(workflow.split('\njobs:\n')[0]).toContain("FSS_RELEASE_HOLD: ${{ vars.FSS_RELEASE_HOLD || 'true' }}");
    const reviewed = job('reviewed');
    expect(reviewed.split('    steps:\n')[0]).not.toContain('FSS_RELEASE_HOLD');
    const literal = "FSS_RELEASE_HOLD: 'false'";
    expect(workflow.split(literal)).toHaveLength(2);
    const execute = step(reviewed, executeName);
    expect(execute).toContain(`        env:\n          # Only this approved, validated execution and its children may pass the script guards.`);
    expect(execute).toContain(`          ${literal}`);
    expect(execute).toContain('node infra/scripts/reviewed-release.mjs execute');
    expect(workflow).not.toContain('$GITHUB_ENV');
    expect(workflow).not.toMatch(/actions\/variables|environments\/[^\s]+\/variables/u);
    expect(workflow).not.toContain('actions: write');
    expect(google).not.toContain(literal);
  });

  it('retains the hosted protection boundary and validates before assuming the existing role', () => {
    const reviewed = job('reviewed');
    expect(reviewed).toContain('    environment: production-release-review\n');
    expect(workflow).toContain('group: fss-production-deploy\n  cancel-in-progress: false');
    const verify = step(reviewed, 'Verify the prepared run, exact manifest and encrypted artifact before credentials');
    const assume = step(reviewed, 'Assume the existing deployment role under its explicitly reviewed OIDC trust');
    expect(reviewed.indexOf(verify)).toBeLessThan(reviewed.indexOf(assume));
    expect(reviewed.indexOf(assume)).toBeLessThan(reviewed.indexOf(step(reviewed, executeName)));
    for (const name of ['continue-on-error:', 'if: always()', 'FSS_RELEASE_HOLD:']) expect(verify).not.toContain(name);
    for (const required of ['.head_sha == $dispatch', '.repository == $repository', '.status == "completed"', '.conclusion == "success"', 'reviewed-release.mjs validate', 'deploy.sh ci download --run-id "$RUN_ID" --commit "$COMMIT"']) expect(verify).toContain(required);
    expect(assume).toContain('secrets.FSS_PRODUCTION_REVIEWED_ROLE_ARN');
    expect(assume).toContain('role-duration-seconds: 3600');
    const trust = readRepositoryFile('infra/policies/production-reviewed-oidc-trust.json');
    expect(trust).toContain('environment:production-release-review');
  });

  it.each([undefined, 'true', 'false'])('scoped dispatch admission does not depend on global hold %s', hold => {
    const input = hold === undefined ? {} : { hold };
    expect(admitted('reviewed', input)).toBe(true);
    expect(admitted('reviewed', { ...input, event: 'push' })).toBe(false);
    expect(admitted('reviewed', { ...input, mode: 'automatic' })).toBe(false);
    expect(admitted('reviewed', { ...input, mode: 'review_prepare' })).toBe(false);
    expect(admitted('reviewed', { ...input, decision: 'manual' })).toBe(false);
    // Passing job admission is not approval: GitHub must still enforce the environment.
  });

  it.each([undefined, 'true'])('queued automatic/maintenance writers stay held before and after observer loss: %s', hold => {
    const input = hold === undefined ? {} : { hold };
    for (const _phase of ['before approval', 'approved execute', 'observer disconnected', 'terminal']) {
      expect(admitted('deploy', { ...input, mode: 'automatic' })).toBe(false);
      expect(admitted('maintenance', input)).toBe(false);
    }
    expect(admitted('deploy', { hold: 'false', mode: 'automatic' })).toBe(true);
    expect(admitted('maintenance', { hold: 'false' })).toBe(true);
  });

  it.each([undefined, 'true'])('the actual Google apply shell refuses held input before invoking Terraform: %s', hold => {
    const apply = body(step(google, 'Apply that exact saved plan'));
    const run = spawnSync('bash', ['-c', `terraform() { echo FORBIDDEN_PROVIDER >&2; return 99; }\n${apply}`], {
      encoding: 'utf8', timeout: 5000,
      env: { PATH: '/usr/bin:/bin', ...(hold === undefined ? {} : { FSS_RELEASE_HOLD: hold }) },
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('production release is held; nothing applied');
    expect(run.stderr).not.toContain('FORBIDDEN_PROVIDER');
  });

  it.each(['success', 'failure', 'cancelled', 'skipped'])('reports actual reviewed %s rather than claiming the shared hold prevented it', result => {
    const report = summary(result);
    expect(report.file).toContain(`Reviewed production release ${result};`);
    expect(report.file).not.toContain('production was not authorized');
    expect(report.output).toContain(result === 'success' ? '::notice::' : '::error::');
  });

  it('still reports automatic admission held', () => {
    expect(summary('skipped', 'automatic').file).toContain('Release held: source checks may finish, but production was not authorized to deploy.');
  });
});
