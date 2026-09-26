import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repositoryPath } from './support/repository.ts';

/**
 * Appendix G 39: "Production and rehearsal Terraform plans use distinct state keys,
 * roles, secrets and resource namespaces; rehearsal teardown cannot address
 * production resources."
 *
 * Half of this is checkable offline and the two `isolation.tftest.hcl` suites check it:
 * each root pins its own name prefix, refuses the other's, and asserts no resource name
 * carries the neighbour's string. The other half is what a real run can reach, and that is
 * `infra/scripts/rehearsal.sh` (P7, 27 September 2026; the old `rehearsal-*.sh` names exec
 * it): `identity` before the create, `teardown` and `guard` after it, all driven here
 * against stub `aws` and `terraform` processes. rehearsal.sh has no dry run.
 *
 * ## The vacuous-pass traps, named
 *
 * **An identity check that accepts a look-alike.** Six identities are judged: the one it
 * must accept, a user, a role whose name merely begins the same way, another rehearsal
 * role, a role ARN with no session, and none at all.
 *
 * **A teardown that is silent rather than tolerant.** Every absent thing is "already
 * done", and the same world with something in the state still destroys; an AccessDenied
 * and an unreadable state still fail.
 *
 * **A guard that passes by construction.** It passes an empty state and a deleted
 * database, and fails each of: a state that still holds a resource, a database that is
 * still there, a database it could not describe, and a session that is not the role.
 */

/** Write an executable stand-in (a fake `aws`, a fake `terraform`) and return its path. */
function stubCommand(directory: string, name: string, body: string): string {
  const path = join(directory, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

interface Run {
  readonly code: number;
  readonly output: string;
}

const SCRIPT = 'infra/scripts/rehearsal.sh';
const ROLE_SESSION = 'arn:aws:sts::123456789012:assumed-role/fss-rh-deploy/fss-rh-2026';

/** One script, with no ambient FSS_ variable leaking in, and everything it said. */
function run(script: string, args: readonly string[], environment: Readonly<Record<string, string>> = {}, cwd?: string): Run {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith('FSS_')) env[name] = value;
  }
  const result = spawnSync(repositoryPath(script), [...args], {
    encoding: 'utf8',
    env: { ...env, FSS_REHEARSAL_REPORTS: mkdtempSync(join(tmpdir(), 'fss-rehearsal-reports-')), ...environment },
    ...(cwd === undefined ? {} : { cwd }),
  });
  return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

const failLines = (result: Run): readonly string[] => result.output.split('\n').filter(line => line.startsWith('FAIL:'));

describe('Appendix G 39: rehearsal.sh identity refuses every principal but the rehearsal role (G12e)', () => {
  it('accepts one identity and refuses five, and reads STS through the same seam as every other call', () => {
    const judge = (identity: string, role?: string, script = SCRIPT): boolean =>
      run(script, script === SCRIPT ? ['identity', ...(role === undefined ? [] : [role])] : role === undefined ? [] : [role], {
        FSS_REHEARSAL_CALLER_IDENTITY: identity,
      }).code === 0;

    expect(judge(ROLE_SESSION)).toBe(true);
    // A user who happens to be allowed to run the workflow is not the role.
    expect(judge('arn:aws:iam::123456789012:user/someone')).toBe(false);
    // A role whose name merely begins the same way. `*fss-rh-*` would have passed it.
    expect(judge('arn:aws:sts::123456789012:assumed-role/fss-rh-deploy-other/x')).toBe(false);
    expect(judge('arn:aws:sts::123456789012:assumed-role/fss-rh-readonly/x')).toBe(false);
    // The role ARN rather than a session of it: the shape is the evidence.
    expect(judge('arn:aws:sts::123456789012:assumed-role/fss-rh-deploy')).toBe(false);
    expect(judge('')).toBe(false);
    // Production's applies assume their role in the provider and never pass the flag.
    expect(judge('arn:aws:sts::123456789012:assumed-role/fss-prod-deploy/x', 'fss-prod-deploy')).toBe(false);
    // The old name judges the same.
    expect(judge(ROLE_SESSION, undefined, 'infra/scripts/rehearsal-caller-identity.sh')).toBe(true);
    expect(judge('arn:aws:iam::123456789012:user/someone', undefined, 'infra/scripts/rehearsal-caller-identity.sh')).toBe(false);

    const stubs = mkdtempSync(join(tmpdir(), 'fss-identity-'));
    const aws = stubCommand(stubs, 'aws', `[ "$1 $2" = "sts get-caller-identity" ] || exit 9\necho '${ROLE_SESSION}'`);
    const read = run(SCRIPT, ['identity'], { FSS_REHEARSAL_AWS_COMMAND: aws });
    expect(read.code, read.output).toBe(0);
    expect(read.output).toContain(`caller identity: ${ROLE_SESSION}`);
  });
});

describe('Appendix G 39: rehearsal.sh prefix, and the old guard phases', () => {
  it('accepts a rehearsal prefix and refuses production, a malformed prefix and none, before any credential', () => {
    expect(run(SCRIPT, ['prefix', 'fss-rh-202609271200']).code).toBe(0);
    for (const bad of ['fss-prod', 'fss-rh-X', 'fss-rh-', 'something']) {
      const refused = run(SCRIPT, ['prefix', bad]);
      expect(refused.code, bad).toBe(1);
      expect(refused.output).toContain('is not a rehearsal prefix');
    }
    expect(run(SCRIPT, ['prefix']).output).toContain('a rehearsal script needs a name prefix');
  });

  it('maps the old phases: before is prefix, after is guard, plan is retired, and there is no dry run', () => {
    const before = run('infra/scripts/rehearsal-prefix-guard.sh', ['fss-rh-202609271200', 'before']);
    expect(before.code, before.output).toBe(0);
    expect(before.output).toContain('run prefix fss-rh-202609271200: a rehearsal prefix');
    const plan = run('infra/scripts/rehearsal-prefix-guard.sh', ['fss-rh-202609271200', 'plan', '/dev/null']);
    expect(plan.code).toBe(1);
    expect(plan.output).toContain('the plan phase is retired (P7)');
    const dry = run(SCRIPT, ['prefix', 'fss-rh-202609271200'], { FSS_REHEARSAL_DRY_RUN: '1' });
    expect(dry.code).toBe(1);
    expect(dry.output).toContain('rehearsal.sh has no dry run');
  });
});

/** Run a body with `lib.sh` sourced, and report what it did. */
function inLib(body: string): Run {
  const directory = mkdtempSync(join(tmpdir(), 'fss-lib-'));
  const script = join(directory, 'case.sh');
  writeFileSync(script, `#!/usr/bin/env bash\nsource ${repositoryPath('infra/scripts/lib.sh')}\nset +e\n${body}\n`);
  chmodSync(script, 0o755);
  const result = spawnSync('/bin/bash', [script], { encoding: 'utf8', env: { ...process.env, FSS_REHEARSAL_DRY_RUN: '1' } });
  return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

describe('Appendix G 39: no rehearsal command may name production, wrapper or not', () => {
  it('refuses the first credentialed run’s production query and a mutating command at the call, and plans neither', () => {
    // The exact command of Actions 35548888865, which refused itself; it is still refused.
    const query = inLib(`rehearsal_aws resourcegroupstaggingapi get-resources --tag-filters 'Key=Name,Values=fss-prod*'\necho "rc=$?"`);
    expect(query.output).toContain('FAIL: a rehearsal command names a production resource: Key=Name,Values=fss-prod*');
    expect(query.output).toContain('rc=1');
    expect(query.output).not.toContain('PLAN aws resourcegroupstaggingapi');
    const deletion = inLib('rehearsal_aws rds delete-db-instance --db-instance-identifier fss-prod-pg\necho "rc=$?"');
    expect(deletion.output).toContain('FAIL: a rehearsal command names a production resource: fss-prod-pg');
    expect(deletion.output).toContain('rc=1');
    const destroy = inLib('rehearsal_terraform destroy -var=name_prefix=fss-prod\necho "rc=$?"');
    expect(destroy.output).toContain('FAIL: a rehearsal command names a production resource');
    expect(destroy.output).toContain('rc=1');
  });
});

describe('Appendix G 39: rehearsal.sh teardown tears down a run that created nothing, and one that created everything', () => {
  /** Everything absent, as it is after a run whose creation step never ran. */
  const NOTHING_EXISTS = `
case "$1 $2" in
  "ecs list-tasks")
    echo "An error occurred (ClusterNotFoundException) when calling the ListTasks operation: not found" >&2
    exit 254 ;;
  "s3api list-object-versions")
    echo "An error occurred (NoSuchBucket) when calling the ListObjectVersions operation: no such bucket" >&2
    exit 254 ;;
  "s3api delete-bucket")
    echo "An error occurred (NoSuchBucket) when calling the DeleteBucket operation: no such bucket" >&2
    exit 254 ;;
esac
echo "unexpected: $*" >&2; exit 9`;
  const NEVER_INITIALISED = 'echo "No state file was found!" >&2; exit 1';
  const STATE_HOLDS_THE_BUCKET = 'if [ "$1" = "state" ]; then echo "module.stack.aws_s3_bucket.journal"; else echo "destroy: $*"; fi';

  function teardown(options: {
    readonly aws: string;
    readonly terraform: string;
    /** The create step writes this file beside the root; a teardown from a fresh checkout has none. */
    readonly tfvars?: boolean;
    readonly identity?: string;
    readonly script?: string;
  }): Run & { readonly reports: string; readonly calls: readonly string[] } {
    const stubs = mkdtempSync(join(tmpdir(), 'fss-teardown-'));
    const reports = mkdtempSync(join(tmpdir(), 'fss-teardown-reports-'));
    const record = join(stubs, 'calls');
    if (options.tfvars ?? true) {
      writeFileSync(join(stubs, 'run.auto.tfvars.json'), JSON.stringify({ name_prefix: 'fss-rh-nothing', assume_deployment_role: false }));
    }
    const result = run(
      options.script ?? SCRIPT,
      options.script === undefined ? ['teardown', 'fss-rh-nothing'] : ['fss-rh-nothing'],
      {
        FSS_REHEARSAL_REPORTS: reports,
        FSS_REHEARSAL_CALLER_IDENTITY: options.identity ?? 'arn:aws:sts::123456789012:assumed-role/fss-rh-deploy/x',
        FSS_REHEARSAL_AWS_COMMAND: stubCommand(stubs, 'aws', `echo "aws $*" >> '${record}'\n${options.aws}`),
        TERRAFORM: stubCommand(stubs, 'terraform', `echo "terraform $*" >> '${record}'\n${options.terraform}`),
      },
      stubs,
    );
    return { ...result, reports, calls: existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(line => line !== '') : [] };
  }

  it('treats every absent thing as already done, reaches the last step, and asks nothing of RDS', () => {
    const { code, output, reports, calls } = teardown({ aws: NOTHING_EXISTS, terraform: NEVER_INITIALISED });
    expect(code, output).toBe(0);
    expect(output).toContain('already absent (ClusterNotFoundException)');
    expect(output).toContain('already absent (NoSuchBucket)');
    expect(output).toContain('3/4 destroying the rehearsal root');
    expect(output).toContain('never initialised, so this run created nothing');
    expect(output).toContain('4/4 removing the journal bucket if the destroy left it');
    expect(readFileSync(join(reports, 'teardown.txt'), 'utf8')).toContain('destroyed=nothing_created journal_bucket=gone');
    // The drill's restored instance and snapshots went with W3-S8.
    expect(calls.filter(call => call.startsWith('aws rds'))).toEqual([]);
  });

  it('still destroys when there is something in the state, so tolerance is not silence, and the old name does the same', () => {
    const now = teardown({ aws: NOTHING_EXISTS, terraform: STATE_HOLDS_THE_BUCKET });
    expect(now.code, now.output).toBe(0);
    expect(now.output).toContain('destroy: destroy -auto-approve -input=false -var=assume_deployment_role=false -var=name_prefix=fss-rh-nothing');
    expect(readFileSync(join(now.reports, 'teardown.txt'), 'utf8')).toContain('destroyed=true');
    const old = teardown({ aws: NOTHING_EXISTS, terraform: STATE_HOLDS_THE_BUCKET, script: 'infra/scripts/rehearsal-teardown.sh' });
    expect(old.code, old.output).toBe(0);
    expect(old.calls).toEqual(now.calls);
  });

  it('names the journal bucket with the verified session’s account, empties it with the bypass, and deletes it after the destroy', () => {
    // Actions 35649752231: the bucket was named without the account the module appends,
    // and the real bucket outlived a destroy whose state never held it.
    const bucket = 'fss-rh-nothing-suppression-journal-123456789012';
    const { code, output, calls } = teardown({
      aws: [
        'case "$*" in',
        `  *"--query {Objects: Versions"*) echo '{"Objects": [{"Key": "journal/1", "VersionId": "v1"}]}' ;;`,
        `  *"--query {Objects: DeleteMarkers"*) echo '{"Objects": null}' ;;`,
        `  *list-tasks*) echo '' ;;`,
        `  *) echo '{}' ;;`,
        'esac',
      ].join('\n'),
      terraform: STATE_HOLDS_THE_BUCKET,
    });
    expect(code, output).toBe(0);
    const emptied = calls.filter(call => call.includes('s3api delete-objects'));
    expect(emptied, calls.join('\n')).toHaveLength(1);
    expect(emptied[0]).toContain(`--bucket ${bucket} --bypass-governance-retention --delete`);
    expect(calls.filter(call => /suppression-journal(\s|$)/u.test(call))).toEqual([]);
    const destroyAt = calls.findIndex(call => call.startsWith('terraform destroy'));
    const deleteAt = calls.findIndex(call => call.includes(`s3api delete-bucket --bucket ${bucket}`));
    expect(destroyAt, calls.join('\n')).toBeGreaterThan(calls.findIndex(call => call.includes('delete-objects')));
    expect(deleteAt).toBeGreaterThan(destroyAt);
  });

  it('stops this run’s running tasks and no other’s', () => {
    const own = 'arn:aws:ecs:us-east-1:123456789012:task/fss-rh-nothing-cluster/0a1b';
    const other = 'arn:aws:ecs:us-east-1:123456789012:task/fss-rh-another-cluster/0c1d';
    const { code, output, calls } = teardown({
      aws: [
        'case "$1 $2" in',
        `  "ecs list-tasks") printf '%s\\t%s\\n' '${own}' '${other}' ;;`,
        '  "ecs stop-task") echo "{}" ;;',
        `  "s3api list-object-versions") echo '{"Objects": null}' ;;`,
        '  "s3api delete-bucket") exit 0 ;;',
        'esac',
      ].join('\n'),
      terraform: NEVER_INITIALISED,
    });
    expect(code, output).toBe(0);
    expect(calls.filter(call => call.startsWith('aws ecs stop-task'))).toEqual([
      `aws ecs stop-task --cluster fss-rh-nothing-cluster --task ${own} --reason rehearsal teardown`,
    ]);
    expect(output).toContain(`not this run's task, leaving it alone: ${other}`);
  });

  it('refuses to destroy without the file the create step wrote, rather than fail on a missing variable', () => {
    const { code, output } = teardown({ aws: NOTHING_EXISTS, terraform: STATE_HOLDS_THE_BUCKET, tfvars: false });
    expect(code).toBe(1);
    expect(output).toContain('run.auto.tfvars.json is absent');
    expect(output).toContain('release.md section 3 step 13');
    expect(output).not.toContain('destroy: destroy -auto-approve');
  });

  it('fails on a refusal that is not an absence, on an unreadable state, and on a session that is not the role', () => {
    const denied = teardown({
      aws: 'echo "An error occurred (AccessDenied) when calling the ListTasks operation: no" >&2; exit 254',
      terraform: NEVER_INITIALISED,
    });
    expect(denied.code).toBe(1);
    expect(denied.output).toContain('did not fail because the resource was absent');
    const unreadable = teardown({ aws: NOTHING_EXISTS, terraform: 'echo "Error: error loading state: AccessDenied" >&2; exit 1' });
    expect(unreadable.code).toBe(1);
    expect(unreadable.output).toContain('not because the run created nothing');
    const somebody = teardown({ aws: NOTHING_EXISTS, terraform: NEVER_INITIALISED, identity: 'arn:aws:iam::123456789012:user/someone' });
    expect(somebody.code).toBe(1);
    expect(somebody.output).toContain('which is not an assumed-role session of fss-rh-deploy');
    expect(somebody.calls, 'nothing is asked or deleted as somebody else').toEqual([]);
  });
});

describe('Appendix G 39: rehearsal.sh guard, after the teardown: an empty state, a deleted database, the rehearsal role', () => {
  const DATABASE_GONE =
    'echo "An error occurred (DBInstanceNotFound) when calling the DescribeDBInstances operation: DBInstance fss-rh-nothing-pg not found." >&2; exit 254';

  function guard(options: {
    readonly terraform: string;
    readonly aws?: string;
    readonly identity?: string;
    readonly script?: string;
  }): Run & { readonly report: string | null; readonly calls: readonly string[] } {
    const stubs = mkdtempSync(join(tmpdir(), 'fss-guard-'));
    const reports = mkdtempSync(join(tmpdir(), 'fss-guard-reports-'));
    const record = join(stubs, 'calls');
    const result = run(
      options.script ?? SCRIPT,
      options.script === undefined ? ['guard', 'fss-rh-nothing'] : ['fss-rh-nothing', 'after'],
      {
        FSS_REHEARSAL_REPORTS: reports,
        FSS_REHEARSAL_CALLER_IDENTITY: options.identity ?? 'arn:aws:sts::123456789012:assumed-role/fss-rh-deploy/x',
        FSS_REHEARSAL_AWS_COMMAND: stubCommand(stubs, 'aws', `echo "aws $*" >> '${record}'\n${options.aws ?? DATABASE_GONE}`),
        TERRAFORM: stubCommand(stubs, 'terraform', options.terraform),
      },
      stubs,
    );
    const report = join(reports, 'prefix-guard.txt');
    return {
      ...result,
      report: existsSync(report) ? readFileSync(report, 'utf8').trim() : null,
      calls: existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(line => line !== '') : [],
    };
  }

  it('passes an empty state and a deleted database, with one RDS describe, through either name', () => {
    const now = guard({ terraform: 'exit 0' });
    expect(now.code, now.output).toBe(0);
    expect(now.report).toBe('prefix=fss-rh-nothing production_untouched=true state_empty=true database=absent state_read=true');
    expect(now.calls).toEqual([
      'aws rds describe-db-instances --db-instance-identifier fss-rh-nothing-pg --query DBInstances[0].DBInstanceStatus --output text',
    ]);
    const old = guard({ terraform: 'exit 0', script: 'infra/scripts/rehearsal-prefix-guard.sh' });
    expect(old.code, old.output).toBe(0);
    expect(old.report).toBe(now.report);
  });

  it('passes a run that created nothing, saying so rather than swallowing it', () => {
    const nothing = guard({ terraform: 'echo "Backend initialization required, please run terraform init" >&2; exit 1' });
    expect(nothing.code, nothing.output).toBe(0);
    expect(nothing.output).toContain('never initialised, so this run created nothing');
    expect(nothing.report).toContain('state_read=false');
  });

  it('fails a state the teardown left resources in, naming them, and names production separately', () => {
    const left = guard({ terraform: 'printf "module.stack.module.database.aws_db_instance.main\\nmodule.stack.aws_s3_bucket.updates\\n"' });
    expect(left.code).toBe(1);
    expect(failLines(left)).toEqual([
      "FAIL: the teardown left 2 resource(s) in the run's state: module.stack.module.database.aws_db_instance.main module.stack.aws_s3_bucket.updates",
    ]);
    expect(left.report).toBeNull();
    const production = guard({ terraform: 'echo "aws_s3_bucket.fss-prod-journal"' });
    expect(production.code).toBe(1);
    expect(production.output).toContain('the rehearsal state names production resources: aws_s3_bucket.fss-prod-journal');
  });

  it('fails a database that is still there, or one it could not describe, and a session that is not the role', () => {
    const standing = guard({ terraform: 'exit 0', aws: 'echo deleting' });
    expect(standing.code).toBe(1);
    expect(standing.output).toContain("the run's database fss-rh-nothing-pg still exists after the teardown (deleting)");
    const denied = guard({ terraform: 'exit 0', aws: 'echo "An error occurred (AccessDenied) when calling the DescribeDBInstances operation" >&2; exit 254' });
    expect(denied.code).toBe(1);
    expect(denied.output).toContain('fss-rh-nothing-pg could not be described, and not because it is gone');
    const somebody = guard({ terraform: 'exit 0', identity: 'arn:aws:sts::123456789012:assumed-role/fss-prod-deploy/x' });
    expect(somebody.code).toBe(1);
    expect(somebody.output).toContain('which is not an assumed-role session of fss-rh-deploy');
    expect(somebody.calls).toEqual([]);
  });
});

/**
 * G12h: the rehearsal's front door to the one-off task runner, lib.sh's release_run_task,
 * whose own guards are run in `lib.check.ts`. Two identities since W3-S8: `migration` and
 * `operations`; the drill's went with its task definition.
 */
describe('Appendix G 39: rehearsal.sh run-task launches on the run’s own definitions, and the drill is gone', () => {
  const DIGEST = `sha256:${'b'.repeat(64)}`;
  const SECRET = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:fss-rh-check/app-runtime-database-a';
  const definition = (kind: string): string => `arn:aws:ecs:us-east-1:123456789012:task-definition/fss-rh-check-${kind}:1`;

  function runTask(kind: string, script = SCRIPT, withDigest = true): Run & { readonly calls: readonly string[] } {
    const stubs = mkdtempSync(join(tmpdir(), 'fss-run-task-'));
    const record = join(stubs, 'calls');
    const aws = stubCommand(
      stubs,
      'aws',
      [
        `echo "aws $*" >> '${record}'`,
        '[ "$1 $2" = "ecs run-task" ] || { echo "unexpected: $*" >&2; exit 9; }',
        `echo '{"tasks": [{"taskArn": "arn:aws:ecs:us-east-1:123456789012:task/fss-rh-check-cluster/0a1b"}], "failures": []}'`,
      ].join('\n'),
    );
    const result = run(script, [...(script === SCRIPT ? ['run-task'] : []), 'fss-rh-check', 'verify', kind, '--', 'verify'], {
      FSS_REHEARSAL_AWS_COMMAND: aws,
      AWS_REGION: 'us-east-1',
      FSS_RELEASE_RUN_ID: 'scenario39',
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
      FSS_RELEASE_OUTPUT_WORKER_LOG_GROUP_NAME: '/fss/fss-rh-check/worker',
      FSS_RELEASE_OUTPUT_OPERATIONS_TASK_DEFINITION_ARN: definition('operations'),
      FSS_RELEASE_OUTPUT_MIGRATION_TASK_DEFINITION_ARN: definition('migration'),
      FSS_RELEASE_OUTPUT_APP_RUNTIME_DATABASE_SECRET_ARN: SECRET,
      FSS_RELEASE_TASK_DEFINITION: JSON.stringify({
        containerDefinitions: [
          {
            name: kind,
            image: `123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-rh-worker@${DIGEST}`,
            environment: [{ name: 'FSS_DATABASE_HOST', value: 'fss-rh-check-pg.example' }],
            secrets: kind === 'operations' ? [{ name: 'DATABASE_SECRET_ARN', valueFrom: SECRET }] : [],
          },
        ],
      }),
      FSS_RELEASE_DESCRIBE_TASKS: JSON.stringify({
        tasks: [{ lastStatus: 'STOPPED', stopCode: 'EssentialContainerExited', containers: [{ name: kind, exitCode: 0 }] }],
      }),
      FSS_RELEASE_LOG_EVENTS: JSON.stringify({ events: [{ message: 'verified' }] }),
      ...(withDigest ? { FSS_RELEASE_WORKER_DIGEST: DIGEST } : {}),
    });
    return { ...result, calls: existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(line => line !== '') : [] };
  }

  it('launches an operations step and a migration step on their own definitions, the same through the old name', () => {
    const operations = runTask('operations');
    expect(operations.code, operations.output).toBe(0);
    expect(operations.calls).toHaveLength(1);
    expect(operations.calls[0]).toContain(`--task-definition ${definition('operations')}`);
    expect(operations.output).toContain('verify: target database host fss-rh-check-pg.example');
    const migration = runTask('migration');
    expect(migration.code, migration.output).toBe(0);
    expect(migration.calls[0]).toContain(`--task-definition ${definition('migration')}`);
    const old = runTask('operations', 'infra/scripts/rehearsal-run-task.sh');
    expect(old.code, old.output).toBe(0);
    expect(old.calls).toEqual(operations.calls);
  });

  it('refuses the drill and a launch with no digest, before any call', () => {
    const drill = runTask('drill');
    expect(drill.code).toBe(1);
    expect(drill.output).toContain("'drill' is not a task definition this rehearsal has");
    expect(drill.calls).toEqual([]);
    const blind = runTask('operations', SCRIPT, false);
    expect(blind.code).toBe(1);
    expect(blind.output).toContain('FSS_RELEASE_WORKER_DIGEST is not set');
    expect(blind.calls).toEqual([]);
  });
});
