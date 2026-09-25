import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRepositoryFile, repositoryPath } from './support/coverage.ts';
import { rehearsalJobSteps, stagesForCondition, stepScript } from './support/releaseWorkflow.ts';

/**
 * The drill has something to reconstruct (g40).
 *
 * The ninth full rehearsal (run 35930664547, 23 September 2026, at f44eb6bf) is the
 * evidence. Create, the fill, the whole deploy path, g39's workspace bootstrap, g38's
 * schema-range refusals, the production smoke and the release suite all passed for the
 * first time. Step 22 — the restore drill — then failed after 67 seconds: one in-VPC
 * `fss admin counts --as-of <restore target>` ran against the source and the script
 * refused, by design, with
 *
 *   FAIL: the drill baseline has no sends, so reconstructing them would prove nothing
 *
 * The refusal is right. What was missing was on the other side of it:
 * `docs/greenfield/restore-drill.md` 0.1 names six things that must exist before the
 * restore target is read, and nothing in this repository could produce five of them in
 * a deployed environment. There was no `fss` command for it and no workflow step, and
 * the release suite runs on the runner against its own database rather than against the
 * rehearsal's. So a fresh environment could never pass step 22, however correct
 * everything before it was.
 *
 * ## The vacuous-pass traps, named
 *
 * Three, and they are the three ways this lane could ship and change nothing.
 *
 *   * A step that *mentions* the script but runs after the drill, or in no stage, or
 *     without the worker digest the wrapper compares the registered image against.
 *     Closed by reading the step list through `rehearsalJobSteps` and comparing
 *     positions with the steps the evidence has to sit between.
 *   * A drill that reads its restore target immediately. RDS's backup window lags real
 *     time by up to about five minutes, so the point it reports a moment after the
 *     evidence was written is a point *before* the evidence existed — the restore lands
 *     on a database without it and the baseline refusal fires again, with the seeding
 *     step having run and worked. Closed by asserting the wait and the instant it waits
 *     for, and by a mutation that removes it.
 *   * A seeding script with a production escape hatch. Production's drill reconstructs a
 *     salesperson's real sends; seeding it would replace the thing being proved with a
 *     fixture. Closed by *running* the script with a production prefix and requiring a
 *     non-zero exit, rather than by reading its text.
 */

const SCRIPT = 'infra/scripts/release-seed-drill-evidence.sh';
const DRILL_SCRIPT = 'infra/scripts/rehearsal-restore-drill.sh';
const EVIDENCE_STEP = 'Create the evidence the drill has to reconstruct';
const BOOTSTRAP_STEP = 'Bootstrap the rehearsal workspace and its admin';
const RANGES_STEP = 'The declared schema ranges, against the deployed images';
const DRILL_STEP = 'Restore drill, Appendix E steps 1 to 9';

const DIGEST = `sha256:${'b'.repeat(64)}`;

/** The root outputs a dry run cannot read, in the shape Terraform prints them. */
function outputs(prefix: string): Record<string, string> {
  return {
    FSS_RELEASE_ACCOUNT: '123456789012',
    FSS_RELEASE_CALLER_ACCOUNT: '123456789012',
    FSS_RELEASE_OUTPUT_CLUSTER_ARN: `arn:aws:ecs:us-east-1:123456789012:cluster/${prefix}-cluster`,
    FSS_RELEASE_OUTPUT_OPERATIONS_TASK_DEFINITION_ARN: `arn:aws:ecs:us-east-1:123456789012:task-definition/${prefix}-operations:1`,
    FSS_RELEASE_OUTPUT_APP_RUNTIME_DATABASE_SECRET_ARN: `arn:aws:secretsmanager:us-east-1:123456789012:secret:${prefix}/app-runtime-database-bbbbbb`,
    FSS_RELEASE_OUTPUT_WORKER_LOG_GROUP_NAME: `/fss/${prefix}/worker`,
    FSS_RELEASE_OUTPUT_TASK_NETWORK_CONFIGURATION: JSON.stringify({
      subnet_ids: ['subnet-1111111111111111a', 'subnet-1111111111111111b'],
      security_group_id: 'sg-1111111111111111b',
      assign_public_ip: 'ENABLED',
      database_port: 5432,
      database_host: `${prefix}-pg.example.us-east-1.rds.amazonaws.com`,
      inbound_rule_count: 0,
    }),
  };
}

function seed(
  args: readonly string[],
  extra: Record<string, string> = {},
): { readonly status: number | null; readonly output: string } {
  const result = spawnSync(repositoryPath(SCRIPT), [...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FSS_REHEARSAL_DRY_RUN: '1',
      FSS_REHEARSAL_REPORTS: mkdtempSync(join(tmpdir(), 'fss-drill-evidence-')),
      ...extra,
    },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('g40: the release creates the evidence the restore drill reconstructs', () => {
  const steps = rehearsalJobSteps();
  const indexOfStep = (name: string): number => {
    const found = steps.find(step => step.name === name);
    expect(found, `the rehearsal job has no step named ${name}`).toBeDefined();
    return (found as { index: number }).index;
  };

  it('runs after the workspace bootstrap, before the schema ranges, and before the drill', () => {
    const evidence = indexOfStep(EVIDENCE_STEP);
    // After the bootstrap: the seed refuses without a workspace and an active admin,
    // and g39's command is the only thing that makes either exist.
    expect(evidence).toBeGreaterThan(indexOfStep(BOOTSTRAP_STEP));
    expect(evidence).toBeLessThan(indexOfStep(RANGES_STEP));
    // And before the drill, which is the whole point: the baseline it measures is
    // measured at the restore target, and evidence written afterwards is evidence the
    // restore target predates.
    expect(evidence).toBeLessThan(indexOfStep(DRILL_STEP));
  });

  it('runs only in the full stage, which is the only stage that drills', () => {
    const step = steps[indexOfStep(EVIDENCE_STEP)];
    expect(step).toBeDefined();
    const stages = stagesForCondition(step?.condition ?? null);
    expect([...stages]).toEqual(['full']);
    // The same set as the drill's. A `deploy` run that seeded would leave four
    // fabricated firms and an accepted send in an environment whose drill never runs.
    const drill = steps[indexOfStep(DRILL_STEP)];
    expect([...stagesForCondition(drill?.condition ?? null)]).toEqual([...stages]);
  });

  it('passes the script the worker digest, the run’s own prefix and the phase', () => {
    const script = stepScript(EVIDENCE_STEP, steps);
    expect(script).toContain(`${SCRIPT} infra/roots/rehearsal`);
    expect(script).toContain("'${{ steps.prefix.outputs.prefix }}'");
    // The digest is the release gate at the moment of use: the wrapper refuses to
    // launch a task whose registered image is not the digest this release is about.
    expect(script).toContain("--worker-digest '${{ inputs.worker_image_digest }}'");
    expect(script).toContain('--phase before');
    // The slug g39's bootstrap creates, and not a guess.
    expect(script).toContain('--workspace-slug rehearsal');
    const bootstrap = stepScript(BOOTSTRAP_STEP, steps);
    expect(bootstrap).toContain('--slug rehearsal');
  });

  it('is in the credential-free plan, so a pull request runs it with no credential', () => {
    const workflow = readRepositoryFile('.github/workflows/greenfield-release.yml');
    const planAt = workflow.indexOf('      - name: Print the plan every rehearsal step would run');
    expect(planAt, 'the credential-free job no longer prints a plan').toBeGreaterThan(-1);
    const plan = workflow.slice(planAt, workflow.indexOf('\n      - name: ', planAt + 1));
    expect(plan).toContain(SCRIPT);
    // Beside the drill rather than instead of it, and with the digest the real step
    // passes, so the dry run reaches the launch branch.
    expect(plan).toContain(DRILL_SCRIPT);
    expect(plan).toContain('--phase before');
    expect(plan).toContain('--worker-digest $FSS_RELEASE_WORKER_DIGEST');
  });

  it('refuses a production prefix outright, with no flag that would let it through', () => {
    // Run rather than read. Production's drill (runbook section 7) reconstructs real
    // sends, replies and suppressions; seeding it would replace the thing being proved
    // with a fixture, so there is no `--environment production` to reach for.
    const refused = seed([
      'infra/roots/production',
      'fss-prod',
      '--worker-digest',
      DIGEST,
      '--phase',
      'before',
    ]);
    expect(refused.status, refused.output).not.toBe(0);
    expect(refused.output).toContain('is not a rehearsal prefix');

    // And with the rehearsal root, in case somebody "fixed" the root and left the
    // prefix — the prefix is what decides, and it is checked first.
    const alsoRefused = seed(['infra/roots/rehearsal', 'fss-prod', '--worker-digest', DIGEST, '--phase', 'before']);
    expect(alsoRefused.status, alsoRefused.output).not.toBe(0);

    // The word does not appear as a flag anywhere in the script: a production
    // environment cannot be named because there is nothing to name it with.
    const script = readRepositoryFile(SCRIPT);
    const commands = script
      .split('\n')
      .filter(line => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(commands).not.toContain('--environment production');
    expect(commands).toContain('rehearsal_require_prefix "$PREFIX"');
  });

  it('refuses a phase it does not have, and a missing one, rather than choosing', () => {
    const missing = seed(['infra/roots/rehearsal', 'fss-rh-0923', '--worker-digest', DIGEST]);
    expect(missing.status, missing.output).not.toBe(0);
    expect(missing.output).toContain('usage:');

    const wrong = seed([
      'infra/roots/rehearsal',
      'fss-rh-0923',
      '--worker-digest',
      DIGEST,
      '--phase',
      'during',
    ]);
    expect(wrong.status, wrong.output).not.toBe(0);
    expect(wrong.output).toContain("--phase takes before, in-flight or after, not 'during'");

    const noDigest = seed(['infra/roots/rehearsal', 'fss-rh-0923', '--phase', 'before']);
    expect(noDigest.status, noDigest.output).not.toBe(0);
    expect(noDigest.output).toContain('--worker-digest is required');
  });

  it('plans exactly one task, on the operations definition, in the recorded mode', () => {
    const prefix = 'fss-rh-0923';
    const planned = seed(
      ['infra/roots/rehearsal', prefix, '--worker-digest', DIGEST, '--phase', 'before', '--workspace-slug', 'rehearsal'],
      outputs(prefix),
    );
    expect(planned.status, planned.output).toBe(0);

    const launches = planned.output.split('\n').filter(line => line.includes('aws ecs run-task'));
    expect(launches, 'the plan launches no task at all').toHaveLength(1);
    const launch = launches[0] ?? '';
    // An `awsvpc` task definition cannot be launched without this.
    expect(launch).toContain('--network-configuration');
    expect(launch).toContain(`${prefix}-operations`);
    expect(launch).toContain('"admin", "drill", "seed-evidence"');
    expect(launch).toContain('"--phase", "before"');
    // The rehearsal root defaults `dependencies_mode` to `live` so that sign-in
    // rehearses the path production runs, and the tool refuses to seed in `live`. The
    // recorded seam is therefore chosen by name, on this one launch, as an environment
    // override — which is a public identifier and which `describe-tasks` may show.
    expect(launch).toContain('{"name": "FSS_DEPENDENCIES", "value": "recorded"}');
  });

  it('launches through the one wrapper and never the CLI directly', () => {
    const script = readRepositoryFile(SCRIPT);
    expect(script).toContain('release_run_task \\');
    // g38's finding, applied before it can happen again: a step that called
    // `aws ecs run-task` itself would be launched without the network configuration an
    // `awsvpc` task cannot start without, and would read the API call's own failure as
    // the task's verdict.
    expect(script).not.toMatch(/(?:command |rehearsal_)?aws ecs run-task/u);
    expect(script).toContain('--container operations');
    expect(script).toContain('release_output "$ROOT_DIRECTORY" operations_task_definition_arn');
    expect(script).toContain('release_output "$ROOT_DIRECTORY" app_runtime_database_secret_arn');
    expect(script).toContain('release_captured_report');
    expect(script).toContain('drill-evidence-$PHASE.txt');
  });

  it('calls a command the tool has, with flags the tool has, and not as the migration user', async () => {
    const { drillInvocations, parseFssCommand } = await import('../../apps/worker/src/tools/fss/commands.ts');
    const { MIGRATION_IDENTITY_COMMANDS } = await import('../../apps/worker/src/tools/fss.ts');
    const invocations = drillInvocations(readRepositoryFile(SCRIPT));
    expect(invocations.length, 'the extractor found no fss invocation in the script').toBeGreaterThanOrEqual(1);
    for (const invocation of invocations) {
      expect(parseFssCommand(invocation.argv), invocation.text).toMatchObject({ ok: true });
    }
    // The runtime identity, like `verify` and `admin workspace bootstrap`: it writes
    // business rows with the credential the services use. The migration task definition
    // injects no runtime connection at all.
    expect(MIGRATION_IDENTITY_COMMANDS).not.toContain('admin drill seed-evidence');
    // And both flags are required, so a half-typed command refuses rather than guessing.
    expect(parseFssCommand(['admin', 'drill', 'seed-evidence', '--phase', 'before'])).toMatchObject({
      ok: false,
      reason: 'flag_missing',
    });
    expect(parseFssCommand(['admin', 'drill', 'seed-evidence', '--workspace-slug', 'rehearsal'])).toMatchObject({
      ok: false,
      reason: 'flag_missing',
    });
  });

  it('is refused in a live deployment, because production is never seeded', async () => {
    const { COMMAND_DEPENDENCIES } = await import('../../apps/worker/src/tools/fss/commands.ts');
    expect(COMMAND_DEPENDENCIES['drill seed-evidence']).toBe('recorded');
    // The refusal is in the same branch `fss drill`'s is, so the two cannot drift: both
    // reach the Gmail seam and both are bound by the deployment's named mode.
    const tool = readRepositoryFile('apps/worker/src/tools/fss.ts');
    expect(tool).toContain("if (path === 'admin drill seed-evidence')");
    expect(tool).toContain("config.dependencies !== 'recorded'");
  });
});

describe('g40: the drill waits for the restore target to pass the evidence', () => {
  const drill = readRepositoryFile(DRILL_SCRIPT);

  it('waits on LatestRestorableTime before it reads the restore target', () => {
    // The whole reason this wait exists: the backup window lags real time by up to
    // about five minutes (spec 4.1), so a target read a moment after the evidence was
    // written predates the evidence, and the baseline measured at it is empty again.
    expect(drill).toContain('wait_for_restorable_point');
    expect(drill).toContain('RESTORABLE_WAIT_ATTEMPTS');
    expect(drill).toContain('RESTORABLE_WAIT_SECONDS');
    // The instant it waits for is the one the seed recorded, read from the report the
    // seed wrote rather than guessed from the clock.
    expect(drill).toContain('drill-evidence-before.txt');
    expect(drill).toContain("grep -o 'asOf=[^ ]*'");

    // And it happens *before* the read, not after it.
    const wait = drill.indexOf('wait_for_restorable_point "$EVIDENCE_AT"');
    const read = drill.indexOf('LATEST_RESTORABLE="$(rehearsal_aws rds describe-db-instances');
    expect(wait, 'the drill never calls the wait').toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(wait);
    // And before the restore itself, which is the call the target is for.
    expect(drill.indexOf('restore-db-instance-to-point-in-time')).toBeGreaterThan(wait);
  });

  it('seeds the in-flight send before the target, and the after phase once the restore is requested', () => {
    const inFlight = drill.indexOf('--phase in-flight');
    const wait = drill.indexOf('wait_for_restorable_point "$EVIDENCE_AT"');
    const baseline = drill.indexOf('for kind in sends replies suppressions crm_edits migrations; do');
    const after = drill.indexOf('--phase after');
    const restore = drill.indexOf('rehearsal_aws rds restore-db-instance-to-point-in-time');
    const available = drill.indexOf('rehearsal_aws rds wait db-instance-available');
    const launch = drill.indexOf('drill_task drill drill');
    expect(inFlight, 'the drill never leaves a send in doubt at the target (lane g59)').toBeGreaterThan(-1);
    expect(after, 'the drill never seeds the work the restore is meant to lose').toBeGreaterThan(-1);
    expect(baseline, 'the drill no longer checks its baseline').toBeGreaterThan(-1);
    // Lane g59. The in-flight send is before the wait, so the target the wait produces
    // is after it and step 3's ten-minute window contains it.
    expect(inFlight).toBeLessThan(wait);
    // After the baseline, because the baseline is measured at the restore target and
    // this activity is deliberately later than it; and after the restore is *requested*
    // (lane g59), because `--use-latest-restorable-time` restores to whatever point RDS
    // has when it acts, and only work written after the request is certain to be lost —
    // steps 2 and 4 now reconstruct exactly that work. Before the drill task, which is
    // what reconstructs it.
    expect(after).toBeGreaterThan(baseline);
    expect(after).toBeGreaterThan(restore);
    expect(after).toBeLessThan(available);
    expect(after).toBeLessThan(launch);
    expect(drill).toContain('release-seed-drill-evidence.sh');
  });

  it('is exercised by the credential-free dry run without waiting on a clock', () => {
    const prefix = 'fss-rh-0923';
    const result = spawnSync('bash', [repositoryPath(DRILL_SCRIPT), prefix], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FSS_REHEARSAL_DRY_RUN: '1',
        FSS_REHEARSAL_REPORTS: mkdtempSync(join(tmpdir(), 'fss-drill-plan-')),
      },
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    // A dry run reaches no AWS, so the wait is planned rather than run: a loop that
    // polled a helper which returns nothing would sleep for ten minutes in ordinary CI.
    expect(output).toContain('wait until aws rds describe-db-instances reports a LatestRestorableTime');
    expect(output).toContain('--phase after');
    // Lane g59: the in-flight phase first, then the wait, then the restore, then the
    // after phase — in the order the plan prints them, which is the order they run.
    const order = ['--phase in-flight', 'wait until aws rds', 'restore-db-instance-to-point-in-time', '--phase after'].map(
      marker => output.indexOf(marker),
    );
    expect(order.every(at => at >= 0), output).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('plans the in-flight phase as one recorded task on the operations definition (lane g59)', () => {
    const prefix = 'fss-rh-0925';
    const planned = seed(
      ['infra/roots/rehearsal', prefix, '--worker-digest', DIGEST, '--phase', 'in-flight', '--workspace-slug', 'rehearsal'],
      outputs(prefix),
    );
    expect(planned.status, planned.output).toBe(0);
    const launches = planned.output.split('\n').filter(line => line.includes('aws ecs run-task'));
    expect(launches).toHaveLength(1);
    expect(launches[0]).toContain(`${prefix}-operations`);
    expect(launches[0]).toContain('"--phase", "in-flight"');
    expect(launches[0]).toContain('{"name": "FSS_DEPENDENCIES", "value": "recorded"}');
  });
});
