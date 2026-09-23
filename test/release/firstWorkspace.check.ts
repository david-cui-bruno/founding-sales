import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROVISIONAL_GOOGLE_SUB_PREFIX } from '@fss/contracts';
import { readRepositoryFile, repositoryPath } from './support/coverage.ts';
import { rehearsalJobSteps, stagesForCondition, stepScript } from './support/releaseWorkflow.ts';

/**
 * The first workspace and its first admin exist before anything asks for them (g39).
 *
 * The eighth full rehearsal (run 35919040315, 23 September 2026, at 12b559e7) is the
 * evidence. Create, the secret fill, the whole deploy path and the schema-range
 * refusals all passed for the first time; step 19, the production smoke, then failed
 * after ten one-minute attempts with "the rehearsal environment published no
 * `CanaryCompletionAgeSeconds` datapoint in ten minutes".
 *
 * The cause was not the smoke and not the metric. `apps/worker/src/scheduler/sources.ts`
 * inserts one canary **per workspace** — `SELECT id FROM workspaces` — and a freshly
 * migrated database has no workspace row, so a perfectly healthy scheduler correctly
 * had nothing to do. Underneath that sat a larger gap: `apps/api/src/auth/signIn.ts`
 * refuses with `workspace_unknown` without the workspace and `membership_required`
 * without an active membership, and writes the `users` row only at the end of a
 * successful sign-in — three rows that each presuppose the others, and nothing in
 * `apps/` or `packages/` ever inserted the first of them.
 *
 * ## The vacuous-pass trap, named
 *
 * Two of them, and they are opposites.
 *
 * Asserting that the workflow *mentions* the script would pass against a step that
 * runs after the smoke, or in no stage at all, or without the digest the wrapper
 * compares the registered image against — each of which leaves the run failing exactly
 * as run 35919040315 did while this file stayed green. Closed by reading the step list
 * through `rehearsalJobSteps`: the step's position is compared with the two steps it
 * has to sit between, and its `if:` is resolved to the set of stages it runs in.
 *
 * And asserting that `signIn.ts` contains the adoption `UPDATE` would pass against one
 * with the `NOT EXISTS` guard removed — which silently rewrites the `google_sub` of an
 * account that already exists for the same address. Closed by asserting the guard, the
 * order against the upsert that follows it, and that neither side spells the sentinel
 * prefix as a literal: both read the one exported constant, because two copies of it
 * are two facts that can disagree and the disagreement is a workspace whose admin can
 * never sign in.
 */

const SCRIPT = 'infra/scripts/release-bootstrap-workspace.sh';
const BOOTSTRAP_STEP = 'Bootstrap the rehearsal workspace and its admin';
const DEPLOY_STEP = 'Migrate forward, then deploy the worker, then the API';
const RANGES_STEP = 'The declared schema ranges, against the deployed images';
const SMOKE_STEP = 'Smoke the rehearsal environment with the production smoke script';

describe('g39: the release creates the first workspace, between the deploy and the ranges', () => {
  const steps = rehearsalJobSteps();
  const indexOfStep = (name: string): number => {
    const found = steps.find(step => step.name === name);
    expect(found, `the rehearsal job has no step named ${name}`).toBeDefined();
    return (found as { index: number }).index;
  };

  it('runs after the deploy, before the schema ranges, and before the smoke', () => {
    const bootstrap = indexOfStep(BOOTSTRAP_STEP);
    // After the deploy: the services and the one-off tasks cannot reach a database
    // whose schema has not been migrated, and the migration is step 17's.
    expect(bootstrap).toBeGreaterThan(indexOfStep(DEPLOY_STEP));
    expect(bootstrap).toBeLessThan(indexOfStep(RANGES_STEP));
    // And before the smoke, which is the step that waits ten minutes for the canary
    // this workspace is what produces.
    expect(bootstrap).toBeLessThan(indexOfStep(SMOKE_STEP));
  });

  it('runs in exactly the stages that deploy, so a `deploy` run is a usable environment', () => {
    const step = steps[indexOfStep(BOOTSTRAP_STEP)];
    expect(step).toBeDefined();
    const stages = stagesForCondition(step?.condition ?? null);
    expect([...stages].sort()).toEqual(['deploy', 'full']);
    // The same set as the deploy step's: a stage that deployed and did not bootstrap
    // would leave a breaching `canary_stale` alarm and an API nobody can sign in to.
    const deploy = steps[indexOfStep(DEPLOY_STEP)];
    expect([...stagesForCondition(deploy?.condition ?? null)].sort()).toEqual([...stages].sort());
  });

  it('passes the script the worker digest and the run’s own prefix', () => {
    const script = stepScript(BOOTSTRAP_STEP, steps);
    expect(script).toContain(`${SCRIPT} infra/roots/rehearsal`);
    expect(script).toContain("'${{ steps.prefix.outputs.prefix }}'");
    // The digest is the release gate at the moment of use: the wrapper refuses to
    // launch a task whose registered image is not the digest this release is about,
    // and it cannot compare against one it was not given.
    expect(script).toContain("--worker-digest '${{ inputs.worker_image_digest }}'");
    expect(script).toContain('--slug rehearsal');
    expect(script).toContain('--admin-email rehearsal-admin@usecallie.com');
    // A rehearsal never *passes* the production word, and could not: the prefix
    // decides the environment and the script refuses a disagreement. The comment in
    // the step names it, so the command lines are what is read here.
    const commands = script
      .split('\n')
      .filter(line => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(commands).not.toContain('--environment production');
  });

  it('is in the credential-free plan, so a pull request runs it with no credential', () => {
    // The plan step belongs to the `dry-run` job, which `rehearsalJobSteps` does not
    // read: that reader is scoped to the credentialed job on purpose. The list is
    // taken out of the workflow text between the job's two markers instead.
    const workflow = readRepositoryFile('.github/workflows/greenfield-release.yml');
    const planAt = workflow.indexOf('      - name: Print the plan every rehearsal step would run');
    expect(planAt, 'the credential-free job no longer prints a plan').toBeGreaterThan(-1);
    const plan = workflow.slice(planAt, workflow.indexOf('\n      - name: ', planAt + 1));
    expect(plan).toContain(SCRIPT);
    // Beside the other two release scripts rather than instead of one of them.
    expect(plan).toContain('infra/scripts/release-deploy.sh');
    expect(plan).toContain('infra/scripts/rehearsal-schema-ranges.sh');
    // The dry run needs no credential and must reach the launch branch, so the plan
    // passes the digest the real step passes.
    expect(plan).toContain('--worker-digest $FSS_RELEASE_WORKER_DIGEST');
  });

  it('launches through the one wrapper and never the CLI directly', () => {
    const script = readRepositoryFile(SCRIPT);
    expect(script).toContain('release_run_task \\');
    // This is lane g38's finding, applied before it can happen again: a step that
    // called `aws ecs run-task` itself would be launched without the network
    // configuration an `awsvpc` task cannot start without, and would read the API
    // call's own failure as the task's verdict.
    expect(script).not.toMatch(/(?:command |rehearsal_)?aws ecs run-task/u);
    // The operations task definition, which carries the runtime credential — the
    // credential whose privileges on these three tables are the thing in doubt.
    expect(script).toContain('--container operations');
    expect(script).toContain('release_output "$ROOT_DIRECTORY" operations_task_definition_arn');
    expect(script).toContain('app_runtime_database_secret_arn');
    // The answer comes back out of the log stream, because a task's filesystem goes
    // away with the task.
    expect(script).toContain('release_captured_report');
    expect(script).toContain('bootstrap-workspace.txt');
  });

  it('refuses production unless production was named, and refuses a foreign argument', () => {
    const reports = mkdtempSync(join(tmpdir(), 'fss-bootstrap-plan-'));
    const runScript = (args: readonly string[]): { status: number | null; output: string } => {
      const result = spawnSync(repositoryPath(SCRIPT), [...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          FSS_REHEARSAL_DRY_RUN: '1',
          FSS_REHEARSAL_REPORTS: reports,
          FSS_RELEASE_ACCOUNT: '123456789012',
          FSS_RELEASE_CALLER_ACCOUNT: '123456789012',
        },
      });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    };

    const production = runScript([
      'infra/roots/production',
      'fss-prod',
      '--worker-digest',
      'sha256:aaaa',
      '--slug',
      'callie',
      '--display-name',
      'Callie',
      '--admin-email',
      'callie@usecallie.test',
    ]);
    expect(production.status, production.output).not.toBe(0);
    expect(production.output).toContain('--environment production');

    // The other direction: a rehearsal prefix may not be told it is production.
    const crossed = runScript([
      'infra/roots/rehearsal',
      'fss-rh-dryrun',
      '--environment',
      'production',
      '--worker-digest',
      'sha256:aaaa',
      '--slug',
      'rehearsal',
      '--display-name',
      'Rehearsal',
      '--admin-email',
      'a@usecallie.test',
    ]);
    expect(crossed.status, crossed.output).not.toBe(0);

    // A root that is not the prefix's root, and a flag the script does not have.
    expect(
      runScript([
        'infra/roots/production',
        'fss-rh-dryrun',
        '--worker-digest',
        'sha256:aaaa',
        '--slug',
        's',
        '--display-name',
        'N',
        '--admin-email',
        'a@usecallie.test',
      ]).status,
    ).not.toBe(0);
    expect(runScript(['infra/roots/rehearsal', 'fss-rh-dryrun', '--nope', 'x']).status).not.toBe(0);
    // And without the digest, which is the comparison the wrapper makes.
    const noDigest = runScript([
      'infra/roots/rehearsal',
      'fss-rh-dryrun',
      '--slug',
      'rehearsal',
      '--display-name',
      'Rehearsal',
      '--admin-email',
      'a@usecallie.test',
    ]);
    expect(noDigest.status, noDigest.output).not.toBe(0);
    expect(noDigest.output).toContain('--worker-digest is required');
  });

  it('plans one operations task carrying the command and the report flag', () => {
    const prefix = 'fss-rh-dryrun';
    const digest = `sha256:${'b'.repeat(64)}`;
    const result = spawnSync(
      repositoryPath(SCRIPT),
      [
        'infra/roots/rehearsal',
        prefix,
        '--worker-digest',
        digest,
        '--slug',
        'rehearsal',
        '--display-name',
        'Rehearsal',
        '--admin-email',
        'rehearsal-admin@usecallie.com',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          FSS_REHEARSAL_DRY_RUN: '1',
          FSS_REHEARSAL_REPORTS: mkdtempSync(join(tmpdir(), 'fss-bootstrap-plan-')),
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
        },
      },
    );
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).toBe(0);

    const launch = output.split('\n').find(line => line.includes('aws ecs run-task'));
    expect(launch, 'the plan launches no task at all').toBeDefined();
    // An `awsvpc` task definition cannot be launched without this, which is how the
    // stale schema-range case passed vacuously for as long as it existed.
    expect(launch).toContain('--network-configuration');
    expect(launch).toContain(`${prefix}-operations`);
    expect(launch).toContain('"admin", "workspace", "bootstrap"');
    expect(launch).toContain('"--report", "/tmp/fss-bootstrap.json"');
    // One task, not two.
    expect(output.split('\n').filter(line => line.includes('aws ecs run-task')).length).toBe(1);
  });

  it('calls a command the tool has, with flags the tool has, and not as the migration user', async () => {
    const { drillInvocations, parseFssCommand } = await import('../../apps/worker/src/tools/fss/commands.ts');
    const { MIGRATION_IDENTITY_COMMANDS } = await import('../../apps/worker/src/tools/fss.ts');
    const invocations = drillInvocations(readRepositoryFile(SCRIPT));
    expect(invocations.length, 'the extractor found no fss invocation in the script').toBeGreaterThanOrEqual(1);
    for (const invocation of invocations) {
      expect(parseFssCommand(invocation.argv), invocation.text).toMatchObject({ ok: true });
    }
    // It writes business rows with the *runtime* credential, which is whose privileges
    // on these three tables are in doubt. The migration task definition injects no
    // runtime connection at all, so running it there would refuse before the database.
    expect(MIGRATION_IDENTITY_COMMANDS).not.toContain('admin workspace bootstrap');
    expect(parseFssCommand(['admin', 'workspace', 'bootstrap', '--slug', 'x'])).toMatchObject({
      ok: false,
      reason: 'flag_missing',
    });
  });
});

describe('g39: a bootstrapped admin can sign in, and nobody else is adopted by accident', () => {
  const signIn = readRepositoryFile('apps/api/src/auth/signIn.ts');
  const tool = readRepositoryFile('apps/worker/src/tools/fss/bootstrapWorkspace.ts');

  it('adopts the provisional row before the upsert that would otherwise make a second one', () => {
    const adopt = signIn.indexOf('UPDATE users\n        SET google_sub = $1');
    const upsert = signIn.indexOf('INSERT INTO users (google_sub, email, display_name)');
    const membership = signIn.indexOf("SELECT role FROM workspace_memberships WHERE workspace_id = $1");
    expect(adopt, 'the adoption UPDATE is gone').toBeGreaterThan(-1);
    expect(upsert).toBeGreaterThan(adopt);
    // And the membership check still comes after both. Adoption changes which row the
    // upsert finds; it does not decide access.
    expect(membership).toBeGreaterThan(upsert);
  });

  it('matches the pending row by prefix and e-mail, not by the sub it is about to write', () => {
    // `WHERE google_sub = $1` is the mutation this closes, and it is worse than it
    // looks: with the `NOT EXISTS` guard beside it the clause is a contradiction, so
    // the statement can never touch a row. The first sign-in would then insert a
    // *second* `users` row, the membership would stay on the first, and that person
    // would be refused `membership_required` for ever — which from outside is
    // indistinguishable from having no access at all.
    expect(signIn).toContain('WHERE google_sub = $4 || $2');
    // And `$4` is the shared constant, bound rather than spliced into the text.
    expect(signIn).toMatch(/WHERE google_sub = \$4 \|\| \$2[\s\S]{0,400}PROVISIONAL_GOOGLE_SUB_PREFIX,\n\s*\],/u);
  });

  it('never overwrites an account that already exists for the address', () => {
    expect(signIn).toContain('AND NOT EXISTS (SELECT 1 FROM users WHERE google_sub = $1)');
    // The one audit action that says an adoption happened, so a release can tell a
    // first sign-in that consumed a pending row from one that did not.
    expect(signIn).toContain("action: 'auth.provisional_user_adopted'");
  });

  it('keeps the sentinel prefix in one module, read by both sides', () => {
    expect(PROVISIONAL_GOOGLE_SUB_PREFIX).toBe('pending-email:');
    // A Google `sub` is a decimal string of digits, so the sentinel can never collide
    // with one. If the prefix ever became digits-only this would be a different design.
    expect(PROVISIONAL_GOOGLE_SUB_PREFIX).not.toMatch(/^[0-9]+$/u);
    for (const [name, source] of [
      ['apps/api/src/auth/signIn.ts', signIn],
      ['apps/worker/src/tools/fss/bootstrapWorkspace.ts', tool],
    ] as const) {
      expect(source, `${name} does not import the prefix`).toContain('PROVISIONAL_GOOGLE_SUB_PREFIX');
      expect(source, `${name} does not take it from @fss/contracts`).toMatch(
        /import \{[^}]*PROVISIONAL_GOOGLE_SUB_PREFIX[^}]*\} from '@fss\/contracts'/su,
      );
      // A second copy of the value is the drift this constant exists to prevent, and
      // a copy inside a SQL string is the copy nobody notices.
      const code = source
        .split('\n')
        .filter(line => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
        .join('\n');
      expect(code, `${name} spells the prefix out instead of importing it`).not.toContain(
        `'${PROVISIONAL_GOOGLE_SUB_PREFIX}`,
      );
    }
  });

  it('is needed because the canary is per workspace, which is still true', () => {
    // The reason the smoke had nothing to judge. If the canary ever stops being per
    // workspace this check should be revisited rather than deleted: the sign-in half
    // of the gap does not depend on it.
    const sources = readRepositoryFile('apps/worker/src/scheduler/sources.ts');
    expect(sources).toContain('SELECT id FROM workspaces');
    // And the alarm treats an absent metric as a breach, so an environment with no
    // workspace alarms rather than going quiet — which is what made this findable.
    const alerts = readRepositoryFile('infra/modules/alerts/main.tf');
    const canary = alerts.slice(alerts.indexOf('canary_stale = {'));
    expect(canary.slice(0, canary.indexOf('}'))).toContain('treat_missing_data  = "breaching"');
  });
});
