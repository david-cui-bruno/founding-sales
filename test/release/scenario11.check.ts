import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
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

  /**
   * G12h replaced the second precondition rather than removing it.
   *
   * `fss` is not on this machine's PATH and never will be: the database is private,
   * so every command that touches it runs as a one-off ECS task using the worker
   * image, and the tool is a command override of that image. What the drill needs
   * before it creates anything is the release's worker digest, because the wrapper
   * refuses to launch a task whose registered image is anything else — which is the
   * release gate at the moment of use. A drill that reconstructed a restored database
   * with last release's image would pass and prove nothing about this one.
   *
   * The refusal is still in the credentialed branch and still tested by running the
   * script rather than by reading it.
   */
  it('refuses to start without the digest the wrapper checks every launch against', () => {
    const { code, output } = runDrill('fss-rh-nodigest', {
      FSS_REHEARSAL_REPORTS: mkdtempSync(join(tmpdir(), 'fss-nodigest-')),
      FSS_RELEASE_WORKER_DIGEST: '',
    });

    expect(code).not.toBe(0);
    expect(output).toContain('FSS_RELEASE_WORKER_DIGEST is not set');
    // And it refuses *before* the restore, not after an RDS instance exists.
    expect(output).not.toContain('restore-db-instance-to-point-in-time');
  });
});

/**
 * G12g: the drill's commands exist, and the restore point is one RDS can restore to.
 *
 * Two findings from reading the drill end to end, both of which would have failed only
 * in the cloud and only after money had been spent:
 *
 *   * every `fss admin …` line named a command line this repository did not contain.
 *     G12f made the missing executable a precondition; this lane wrote the tool, and
 *     `apps/worker/test/fssCli.test.ts` parses the drill's own invocations out of the
 *     script and requires the parser to accept each one, so a drill that grows a
 *     command fails on a laptop instead of at step 5 of a credentialed run;
 *   * the restore asked for `--restore-time "$DRILL_START"`, an instant a second old.
 *     RDS restores to a point inside its continuous backup window, which lags real
 *     time by up to about five minutes (spec 4.1), so that request is refused with
 *     `InvalidRestoreTime`. The drill now reads `LatestRestorableTime` before the
 *     restore, measures the baseline at it, and asks for `--use-latest-restorable-time`.
 *
 * ## The vacuous-pass trap
 *
 * Asserting that the script *contains* `--use-latest-restorable-time` would pass
 * against a script that also still passed `--restore-time`, which is the failure. So
 * the dry run is executed and its plan is read: the restore line must carry the flag
 * and must not carry an explicit restore time, and the baseline's `--as-of` must be the
 * instant the plan named rather than a fresh clock reading.
 */
describe('Appendix G 11: the drill calls commands that exist, at an instant RDS can restore to', () => {
  function planOf(environment: Readonly<Record<string, string>>): string {
    const result = spawnSync(repositoryPath('infra/scripts/rehearsal-restore-drill.sh'), ['fss-rh-plan'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FSS_REHEARSAL_DRY_RUN: '1',
        FSS_REHEARSAL_REPORTS: mkdtempSync(join(tmpdir(), 'fss-plan-')),
        ...environment,
      },
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    return result.stdout;
  }

  /** The plan with an operator-named target, which is the one whose instants are fixed. */
  const plan = planOf({ FSS_RESTORE_TARGET: '2026-09-21T00:00:00Z' });
  /** And the plan with none, which is the branch that reads the point from RDS. */
  const readingPlan = planOf({});

  it('restores to the latest restorable point rather than to an instant it made up', () => {
    const restore = plan
      .split('\n')
      .find(line => line.includes('restore-db-instance-to-point-in-time'));
    expect(restore, 'the plan no longer contains the restore at all').toBeDefined();
    expect(restore).toContain('--use-latest-restorable-time');
    expect(restore, 'an explicit restore time is the request RDS refuses').not.toContain('--restore-time');
  });

  it('reads the restorable point before the restore, because the baseline is measured at it', () => {
    const readAt = readingPlan.indexOf('LatestRestorableTime');
    const restoreAt = readingPlan.indexOf('restore-db-instance-to-point-in-time');
    expect(readAt).toBeGreaterThanOrEqual(0);
    expect(readAt, 'the point has to be known before the baseline and the restore').toBeLessThan(restoreAt);
    expect(readAt, 'and before the baseline counts').toBeLessThan(readingPlan.indexOf('fss admin counts'));
    // And it is that instant the counts are taken as of, not a fresh clock reading.
    expect(plan).toContain('fss admin counts --as-of 2026-09-21T00:00:00Z');
  });

  it('calls only commands the tool accepts, with the flags it accepts', async () => {
    const { drillInvocations, parseFssCommand } = await import('../../apps/worker/src/tools/fss/commands.ts');
    // Both release scripts, because G12h moved the database work into two one-off
    // tasks (`admin counts` and `drill`) and put three more in the deploy script.
    // The fourteen admin commands still run — inside `fss drill`, which calls them
    // as functions — and `apps/worker/test/fssSurface.test.ts` is where each one's
    // behaviour is asserted.
    const invocations = [
      'infra/scripts/rehearsal-restore-drill.sh',
      'infra/scripts/release-deploy.sh',
    ].flatMap(path => drillInvocations(readRepositoryFile(path)));
    expect(invocations.length, 'the extractor found no fss invocation at all').toBeGreaterThanOrEqual(5);
    for (const invocation of invocations) {
      const parsed = parseFssCommand(invocation.argv);
      // A planned line carries prose after the command, so a missing *required* flag is
      // expected there; an unknown command or an unknown flag never is.
      if (!parsed.ok) {
        expect(parsed.reason, `${invocation.text} is not a command the tool has`).toBe('flag_missing');
      }
    }
  });

  it('ships the tool in the worker image, because the database is not publicly reachable', () => {
    // The image copies `apps/worker/src`, so the tool travels with the worker and the
    // `imageClosure` test already covers the domain directories it reaches.
    expect(readRepositoryFile('Dockerfile.worker')).toContain('COPY apps/worker/src apps/worker/src');
    expect(readRepositoryFile('Dockerfile.worker')).toContain('COPY packages/domain/restore packages/domain/restore');
    expect(readRepositoryFile('Dockerfile.worker.dockerignore')).toContain('!packages/domain/restore');
    // And the two invocation forms are written down where an operator will look.
    const processes = readRepositoryFile('docs/greenfield/processes.md');
    expect(processes).toContain('apps/worker/src/tools/fss.ts');
    expect(processes).toContain('containerOverrides');
  });
});

/**
 * Lane g53: the drill task is handed the baseline measured on the source.
 *
 * The thirteenth full run (24 September 2026) launched the drill against the restored
 * instance with `--as-of <restore target>` and no baseline. The drill therefore measured
 * step 0 again on the restored copy, and died writing it into a reports directory
 * nothing had created. Had it not died, "no suppression lost" would have been compared
 * with the restored database's own counts rather than with the source's, measured by the
 * separate baseline task before the restore. A Fargate task can be handed nothing but
 * its command, so the baseline now travels in it: `fss drill --baseline-json '<json>'`.
 *
 * ## The vacuous-pass trap
 *
 * The plan is the only thing a dry run prints, and the real launch is a different line
 * of the script: a check of the plan alone passes against a script whose plan says
 * `--baseline-json` while its real `drill_task` still passes `--as-of`. So the real
 * launch is read through the extractor that also reads `drill_task`, the plan is read
 * for the value it would hand over, and the value is pushed through the run-task
 * wrapper to show it arrives in the task's command byte for byte.
 */
describe('Appendix G 11: the drill is handed the baseline measured on the source (lane g53)', () => {
  const SCRIPT = 'infra/scripts/rehearsal-restore-drill.sh';

  /** A baseline as `fss admin counts` prints it, per-workspace breakdown included. */
  const measured = {
    asOf: '2026-09-21T00:00:00Z',
    sends: 2,
    replies: 3,
    suppressions: 4,
    crm_edits: 5,
    migrations: 30,
    workspaces: [
      { workspaceId: '00000000-0000-4000-8000-000000000001', sends: 2, replies: 3, suppressions: 4, crm_edits: 5 },
    ],
  };
  /** What the drill task is handed: the instant and the five counts, on one line. */
  const handed = '{"asOf":"2026-09-21T00:00:00Z","sends":2,"replies":3,"suppressions":4,"crm_edits":5,"migrations":30}';

  function dryRun(baseline: Readonly<Record<string, unknown>>): { readonly code: number; readonly output: string } {
    const reports = mkdtempSync(join(tmpdir(), 'fss-g53-drill-'));
    writeFileSync(join(reports, 'baseline.json'), JSON.stringify(baseline));
    const result = spawnSync(repositoryPath(SCRIPT), ['fss-rh-handoff'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FSS_REHEARSAL_DRY_RUN: '1',
        FSS_REHEARSAL_REPORTS: reports,
        FSS_RESTORE_TARGET: '2026-09-21T00:00:00Z',
      },
    });
    return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
  }

  it('launches the drill with --baseline-json, in the real launch as well as the plan', async () => {
    const { drillInvocations } = await import('../../apps/worker/src/tools/fss/commands.ts');
    const launches = drillInvocations(readRepositoryFile(SCRIPT)).filter(invocation => invocation.argv[0] === 'drill');
    expect(
      launches.filter(invocation => !invocation.planned).length,
      'the extractor no longer sees the real drill_task launch, so this check would read the plan alone',
    ).toBeGreaterThanOrEqual(1);
    for (const launch of launches) {
      expect(launch.argv, `${launch.text} does not hand the drill the source baseline`).toContain('--baseline-json');
      expect(launch.argv, `${launch.text} would measure step 0 again on the restored copy`).not.toContain('--as-of');
    }
  });

  it('hands over the instant and the five counts the source measured, on one line', () => {
    const { code, output } = dryRun(measured);
    expect(code, output).toBe(0);
    const line = output.split('\n').find(entry => entry.startsWith('PLAN fss drill '));
    expect(line, 'the plan no longer launches the drill').toBeDefined();
    const words = (line ?? '').split(' ');
    const value = words[words.indexOf('--baseline-json') + 1];
    expect(value).toBe(handed);
    expect(JSON.parse(value ?? '')).toEqual({ ...measured, workspaces: undefined });
    expect(line).not.toContain('--as-of');
  });

  it('refuses a baseline with no instant before the restore, not in the drill task after it', () => {
    const { code, output } = dryRun({ ...measured, asOf: undefined });
    expect(code).not.toBe(0);
    expect(output).toContain('carries no asOf instant');
    expect(output).not.toContain('restore-db-instance-to-point-in-time');
  });

  it('reaches the drill task byte for byte through the run-task wrapper', () => {
    // The drill's own front door, with the root's outputs and the registered definition
    // supplied and no credential, exactly as scenario39's g48 case drives it. The
    // wrapper reads the command one word per line and JSON-encodes each, and refuses any
    // argument naming production; a value with braces, quotes and colons must survive
    // both unchanged.
    const digest = `sha256:${'c'.repeat(64)}`;
    const secret = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:fss-rh-check/app-runtime-database-a';
    const command = [
      'drill',
      '--reports',
      '/tmp/fss-drill',
      '--baseline-json',
      handed,
      '--from',
      '2026-09-20T23:00:00Z',
      '--since',
      '2026-09-20T23:50:00Z',
      '--all-mailboxes',
    ];
    const result = spawnSync(
      repositoryPath('infra/scripts/rehearsal-run-task.sh'),
      ['fss-rh-check', 'drill', 'drill', '--', ...command],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          FSS_REHEARSAL_DRY_RUN: '1',
          FSS_REHEARSAL_REPORTS: mkdtempSync(join(tmpdir(), 'fss-g53-door-')),
          FSS_RELEASE_CALLER_ACCOUNT: '123456789012',
          FSS_RELEASE_CLUSTER_TAGS: '[{"key":"Environment","value":"rehearsal"}]',
          FSS_RELEASE_OUTPUT_CLUSTER_ARN: 'arn:aws:ecs:us-east-1:123456789012:cluster/fss-rh-check-cluster',
          FSS_RELEASE_OUTPUT_TASK_NETWORK_CONFIGURATION: JSON.stringify({
            subnet_ids: ['subnet-1111111111111111a', 'subnet-1111111111111111b'],
            security_group_id: 'sg-1111111111111111b',
            assign_public_ip: 'ENABLED',
            database_host: 'fss-rh-check-pg.example',
            inbound_rule_count: 0,
          }),
          FSS_RELEASE_OUTPUT_WORKER_LOG_GROUP_NAME: 'fss-rh-check-worker',
          FSS_RELEASE_OUTPUT_DRILL_TASK_DEFINITION_ARN:
            'arn:aws:ecs:us-east-1:123456789012:task-definition/fss-rh-check-drill:1',
          FSS_RELEASE_OUTPUT_APP_RUNTIME_DATABASE_SECRET_ARN: secret,
          FSS_RELEASE_TASK_DEFINITION: JSON.stringify({
            containerDefinitions: [
              {
                name: 'drill',
                image: `123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-rh-worker@${digest}`,
                environment: [{ name: 'FSS_DATABASE_HOST', value: 'fss-rh-check-pg.example' }],
                secrets: [{ name: 'DATABASE_SECRET_ARN', valueFrom: secret }],
              },
            ],
          }),
          FSS_RELEASE_WORKER_DIGEST: digest,
          FSS_RESTORED_DATABASE_HOST: 'fss-rh-check-pg-restored.example',
        },
      },
    );
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);
    const launch = output.split('\n').find(line => line.startsWith('PLAN aws ecs run-task '));
    expect(launch, 'the wrapper planned no launch').toBeDefined();
    const marker = ' --overrides ';
    const overrides = JSON.parse((launch ?? '').slice((launch ?? '').indexOf(marker) + marker.length)) as {
      containerOverrides: { name: string; command: string[] }[];
    };
    expect(overrides.containerOverrides[0]?.name).toBe('drill');
    expect(overrides.containerOverrides[0]?.command).toEqual(command);
  });
});
