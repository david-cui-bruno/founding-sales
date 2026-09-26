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
 * **A guard that reads only Terraform state.** A create interrupted part-way leaves
 * resources the state never recorded (run 35944594998: an RDS instance, a load balancer
 * and a distribution), so the guard reads the cloud: the tagging API, RDS by identifier,
 * CloudFront, log groups by name, and the two lock records of the run's state key. There
 * is an orphan case for each, and one for a leftover that clears on the second read.
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

/** The state key this run's guard reads its two lock records under, and where they live. */
const STATE_BUCKET = 'callie-sourcing-tfstate-326255650484';
const LOCK_TABLE = 'callie-sourcing-tflock';
const STATE_KEY = 'fss/greenfield/rehearsal/fss-rh-nothing/terraform.tfstate';

/** `<code>` in the shape the CLI reports it. */
const notFound = (code: string): string => `echo "An error occurred (${code}) when calling it" >&2; exit 254`;

/**
 * One page of `cloudfront list-distributions --no-paginate --query DistributionList`, in
 * the shape a real account answers it: the coordinator read an account with three
 * distributions on 27 September 2026 and got `IsTruncated`, `Items`, `Marker`, `MaxItems`
 * and `Quantity`. (The CLI's own pagination merges the pages and leaves `Items` alone,
 * which is why the reader passes `--no-paginate`.)
 */
const distributions = (...items: readonly Record<string, unknown>[]): string =>
  JSON.stringify({ IsTruncated: false, Items: items, Marker: '', MaxItems: 100, Quantity: items.length });

/** One distribution, as the list holds it. */
const distribution = (id: string, comment: string, origins: readonly string[] = []): Record<string, unknown> => ({
  Id: id,
  Comment: comment,
  Origins: { Items: origins.map(DomainName => ({ DomainName })) },
});

/**
 * The five readings `leftovers` makes, each answering "nothing of this run", and the
 * status of a candidate of every settling class, each answering "gone or inactive". A
 * stub that wants one of them to answer otherwise puts its own `case` before this one.
 */
const NOTHING_LEFT = [
  'case "$1 $2" in',
  '  "resourcegroupstaggingapi get-resources") echo "[]"; exit 0 ;;',
  '  "rds describe-db-instances") echo "[]"; exit 0 ;;',
  '  "rds describe-db-snapshots") echo "[]"; exit 0 ;;',
  `  "cloudfront list-distributions") echo '${distributions()}'; exit 0 ;;`,
  '  "logs describe-log-groups") echo "[]"; exit 0 ;;',
  '  "s3api head-object") echo "An error occurred (404) when calling the HeadObject operation: Not Found" >&2; exit 254 ;;',
  '  "dynamodb get-item") echo "None"; exit 0 ;;',
  '  "ecs describe-services") printf "INACTIVE\\t0\\t0\\tNone\\n"; exit 0 ;;',
  '  "ecs describe-clusters") printf "INACTIVE\\tNone\\n"; exit 0 ;;',
  '  "ecs describe-tasks") printf "STOPPED\\tNone\\n"; exit 0 ;;',
  '  "ecs describe-task-definition") echo "INACTIVE"; exit 0 ;;',
  `  "ec2 describe-network-interfaces") ${notFound('InvalidNetworkInterfaceID.NotFound')} ;;`,
  `  "ec2 describe-security-groups") ${notFound('InvalidGroup.NotFound')} ;;`,
  `  "ec2 describe-security-group-rules") ${notFound('InvalidSecurityGroupRuleId.NotFound')} ;;`,
  '  "kms describe-key") echo "PendingDeletion"; exit 0 ;;',
  '  "rds describe-db-instance-automated-backups") echo "retained"; exit 0 ;;',
  'esac',
].join('\n');

/** The tagging API answers with exactly these resources, all of this run. */
const taggedWith = (...arns: readonly string[]): string =>
  `  "resourcegroupstaggingapi get-resources") echo '${JSON.stringify(arns.map(arn => ({ arn, name: 'fss-rh-nothing' })))}'; exit 0 ;;`;

/** A `case` block placed before NOTHING_LEFT. */
const answering = (...lines: readonly string[]): string => ['case "$1 $2" in', ...lines, 'esac'].join('\n');

const ARN = {
  service: 'arn:aws:ecs:us-east-1:123456789012:service/fss-rh-nothing-cluster/fss-rh-nothing-api',
  cluster: 'arn:aws:ecs:us-east-1:123456789012:cluster/fss-rh-nothing-cluster',
  task: 'arn:aws:ecs:us-east-1:123456789012:task/fss-rh-nothing-cluster/0a',
  definition: 'arn:aws:ecs:us-east-1:123456789012:task-definition/fss-rh-nothing-api:3',
  interface: 'arn:aws:ec2:us-east-1:123456789012:network-interface/eni-0a',
  group: 'arn:aws:ec2:us-east-1:123456789012:security-group/sg-0a',
  rule: 'arn:aws:ec2:us-east-1:123456789012:security-group-rule/sgr-0a',
  key: 'arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555555',
  backup: 'arn:aws:rds:us-east-1:123456789012:auto-backup:ab-0a',
} as const;

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
    /** Answers placed before NOTHING_LEFT, so one of the guard's five readings differs. */
    readonly leftovers?: string;
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
        FSS_REHEARSAL_AWS_COMMAND: stubCommand(
          stubs,
          'aws',
          `echo "aws $*" >> '${record}'\n${options.leftovers ?? ''}\n${NOTHING_LEFT}\n${options.aws}`,
        ),
        TERRAFORM: stubCommand(stubs, 'terraform', `echo "terraform $*" >> '${record}'\n${options.terraform}`),
        FSS_REHEARSAL_SETTLING_READS: '1',
        FSS_REHEARSAL_SETTLING_SECONDS: '0',
        FSS_REHEARSAL_STATE_BUCKET: STATE_BUCKET,
        FSS_REHEARSAL_LOCK_TABLE: LOCK_TABLE,
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
    // The drill's restored instance and snapshot deletions went with W3-S8; the only RDS
    // calls left are the two readings that prove the run left no instance or snapshot.
    expect(calls.filter(call => call.startsWith('aws rds')).map(call => call.split(' ').slice(1, 3).join(' '))).toEqual([
      'rds describe-db-instances',
      'rds describe-db-snapshots',
    ]);
    expect(readFileSync(join(reports, 'teardown.txt'), 'utf8')).toContain('nothing_left=true');
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

  it('fails, and writes no report, when the destroy left something behind', () => {
    // A destroy that left something standing is a failed teardown, not a passing one with
    // a failing guard after it (review of PR 292b).
    const left = teardown({
      aws: NOTHING_EXISTS,
      terraform: NEVER_INITIALISED,
      leftovers: answering(taggedWith(ARN.key), '  "kms describe-key") echo "Enabled"; exit 0 ;;'),
    });
    expect(left.code, left.output).toBe(1);
    expect(left.output).toContain(`the teardown: 1 resource(s) still carry fss-rh-nothing`);
    expect(left.output).toContain(`kms-key ${ARN.key} (Enabled)`);
    expect(existsSync(join(left.reports, 'teardown.txt')), 'no teardown.txt claiming nothing_left=true').toBe(false);
  });
});

describe('Appendix G 39: rehearsal.sh guard, after the teardown: an empty state, nothing left in the cloud, the rehearsal role', () => {
  function guard(options: {
    readonly terraform: string;
    /** Answers placed before NOTHING_LEFT, so one reading differs and the rest are empty. */
    readonly leftovers?: string;
    readonly aws?: string;
    readonly identity?: string;
    readonly script?: string;
    readonly reads?: string;
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
        FSS_REHEARSAL_AWS_COMMAND: stubCommand(
          stubs,
          'aws',
          `echo "aws $*" >> '${record}'\n${options.leftovers ?? ''}\n${NOTHING_LEFT}\n${options.aws ?? 'echo "unexpected: $*" >&2; exit 9'}`,
        ),
        TERRAFORM: stubCommand(stubs, 'terraform', options.terraform),
        FSS_REHEARSAL_SETTLING_READS: options.reads ?? '1',
        FSS_REHEARSAL_SETTLING_SECONDS: '0',
        FSS_REHEARSAL_STATE_BUCKET: STATE_BUCKET,
        FSS_REHEARSAL_LOCK_TABLE: LOCK_TABLE,
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

  it('passes an empty state and a cloud that holds nothing of the run, reading all five sources, through either name', () => {
    const now = guard({ terraform: 'exit 0' });
    expect(now.code, now.output).toBe(0);
    expect(now.report).toBe('prefix=fss-rh-nothing production_untouched=true state_empty=true nothing_left=true state_read=true');
    // Every reading an empty state cannot make: the wide net, then the four it misses.
    expect(now.calls.map(call => call.split(' ').slice(1, 3).join(' '))).toEqual([
      'resourcegroupstaggingapi get-resources',
      'rds describe-db-instances',
      'rds describe-db-snapshots',
      'cloudfront list-distributions',
      'logs describe-log-groups',
      'logs describe-log-groups',
      's3api head-object',
      'dynamodb get-item',
    ]);
    expect(now.calls.join('\n')).toContain(`--key ${STATE_KEY}.tflock`);
    expect(now.calls.join('\n'), 'one page, in the shape the API returns it').toContain('cloudfront list-distributions --no-paginate');
    expect(now.calls.join('\n')).toContain(`--log-group-name-prefix /fss/fss-rh-nothing`);
    const old = guard({ terraform: 'exit 0', script: 'infra/scripts/rehearsal-prefix-guard.sh' });
    expect(old.code, old.output).toBe(0);
    expect(old.report).toBe(now.report);
  });

  it('fails on an orphan of each class the state never recorded, naming it', () => {
    // Run 35944594998 left exactly these outside state, and a teardown reported success.
    for (const [what, answer, named] of [
      [
        'a load balancer, through the tagging API',
        `  "resourcegroupstaggingapi get-resources") echo '[{"arn":"arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/fss-rh-nothing-alb/1","name":"fss-rh-nothing-alb"}]'; exit 0 ;;`,
        'tagged arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/fss-rh-nothing-alb/1',
      ],
      ['a database, by identifier', `  "rds describe-db-instances") echo '["fss-rh-nothing-pg"]'; exit 0 ;;`, 'database fss-rh-nothing-pg'],
      ['a manual snapshot', `  "rds describe-db-snapshots") echo '["fss-rh-nothing-pg-final"]'; exit 0 ;;`, 'snapshot fss-rh-nothing-pg-final'],
      [
        'a distribution, by its comment',
        `  "cloudfront list-distributions") echo '${distributions(distribution('E111', 'fss-rh-nothing Electron package distribution.'))}'; exit 0 ;;`,
        'distribution E111',
      ],
      [
        'a distribution, by its origin, beside another account’s',
        `  "cloudfront list-distributions") echo '${distributions(
          distribution('E222', 'somebody else', ['other.example.invalid']),
          distribution('E333', 'no comment', ['fss-rh-nothing-updates.s3.us-east-1.amazonaws.com']),
        )}'; exit 0 ;;`,
        'distribution E333',
      ],
      ['a log group, by name', `  "logs describe-log-groups") echo '["/fss/fss-rh-nothing/worker"]'; exit 0 ;;`, 'log group /fss/fss-rh-nothing/worker'],
    ] as const) {
      const stub = guard({ terraform: 'exit 0', leftovers: ['case "$1 $2" in', answer, 'esac'].join('\n') });
      expect(stub.code, what).toBe(1);
      expect(stub.output, what).toContain(named);
      expect(stub.output, what).toContain('resource(s) still carry fss-rh-nothing');
      expect(stub.output, what).toContain('run stage=teardown again');
      expect(stub.report, what).toBeNull();
    }
  });

  it('fails on either stale lock record of the run’s state key, which blocks the next run', () => {
    const s3 = guard({
      terraform: 'exit 0',
      leftovers: ['case "$1 $2" in', '  "s3api head-object") echo "{}"; exit 0 ;;', 'esac'].join('\n'),
    });
    expect(s3.code).toBe(1);
    expect(s3.output).toContain(`state lock s3://${STATE_BUCKET}/${STATE_KEY}.tflock`);
    const dynamo = guard({
      terraform: 'exit 0',
      leftovers: ['case "$1 $2" in', `  "dynamodb get-item") echo '${STATE_BUCKET}/${STATE_KEY}'; exit 0 ;;`, 'esac'].join('\n'),
    });
    expect(dynamo.code).toBe(1);
    expect(dynamo.output).toContain(`state lock dynamodb:${LOCK_TABLE}/${STATE_BUCKET}/${STATE_KEY}`);
  });

  it('sets aside a candidate its own service reports gone, inactive or pending deletion, and says which', () => {
    // A task STOPPED, an interface EC2 has forgotten, a group and a rule it has forgotten,
    // a key scheduled for deletion, a backup retained. Each was read, not assumed.
    const aside = guard({ terraform: 'exit 0', leftovers: answering(taggedWith(ARN.task, ARN.interface, ARN.group, ARN.rule, ARN.key, ARN.backup)) });
    expect(aside.code, aside.output).toBe(0);
    expect(aside.output).toContain('set aside, read as gone, inactive or pending deletion');
    expect(aside.output).toContain('1 ecs-task, 1 kms-key, 1 network-interface, 1 rds-auto-backup, 1 security-group, 1 security-group-rule');
    // Every one of them was asked of its own service.
    expect(aside.calls.map(call => call.split(' ').slice(1, 3).join(' '))).toEqual(
      expect.arrayContaining(['ecs describe-tasks', 'ec2 describe-network-interfaces', 'ec2 describe-security-groups', 'ec2 describe-security-group-rules', 'kms describe-key', 'rds describe-db-instance-automated-backups']),
    );
    // A VPC carrying the prefix is not a candidate at all: a group that really stayed keeps it.
    const vpc = guard({ terraform: 'exit 0', leftovers: answering(taggedWith('arn:aws:ec2:us-east-1:123456789012:vpc/vpc-0a')) });
    expect(vpc.code).toBe(1);
    expect(vpc.output).toContain('tagged arn:aws:ec2:us-east-1:123456789012:vpc/vpc-0a');
  });

  it('reports a candidate that is still live, in every class, with the state it was read in', () => {
    // The P1 of the review of PR 292b: being of a settling class is not being settled.
    // An ACTIVE service, an Enabled key or a live security group is what a failed teardown leaves.
    for (const [what, arn, answers, named] of [
      ['an ACTIVE service', ARN.service, ['  "ecs describe-services") printf "ACTIVE\\t2\\t0\\tNone\\n"; exit 0 ;;'], `ecs-service ${ARN.service} (ACTIVE, 2 running, 0 pending)`],
      ['a service draining with a task still on it', ARN.service, ['  "ecs describe-services") printf "DRAINING\\t1\\t0\\tNone\\n"; exit 0 ;;'], `ecs-service ${ARN.service} (DRAINING, 1 running, 0 pending)`],
      ['an ACTIVE cluster', ARN.cluster, ['  "ecs describe-clusters") printf "ACTIVE\\tNone\\n"; exit 0 ;;'], `ecs-cluster ${ARN.cluster} (ACTIVE)`],
      ['a task still running', ARN.task, ['  "ecs describe-tasks") printf "RUNNING\\tNone\\n"; exit 0 ;;'], `ecs-task ${ARN.task} (RUNNING)`],
      ['a task definition still ACTIVE', ARN.definition, ['  "ecs describe-task-definition") echo "ACTIVE"; exit 0 ;;'], `ecs-task-definition ${ARN.definition} (ACTIVE)`],
      ['an interface EC2 still has', ARN.interface, ['  "ec2 describe-network-interfaces") echo "in-use"; exit 0 ;;'], `network-interface ${ARN.interface} (still there, in-use)`],
      [
        'a group with rules, in a VPC that is still there',
        ARN.group,
        ['  "ec2 describe-security-groups") printf "vpc-0a\\t1\\t1\\n"; exit 0 ;;', '  "ec2 describe-vpcs") echo "vpc-0a"; exit 0 ;;'],
        `security-group ${ARN.group} (still there in vpc-0a, 1 ingress and 1 egress rule(s))`,
      ],
      [
        'a ruleless group whose interfaces are still attached',
        ARN.group,
        [
          '  "ec2 describe-security-groups") printf "vpc-0a\\t0\\t0\\n"; exit 0 ;;',
          '  "ec2 describe-vpcs") echo "vpc-0a"; exit 0 ;;',
          '  "ec2 describe-network-interfaces") echo "eni-0b"; exit 0 ;;',
        ],
        `security-group ${ARN.group} (no rule, but interface(s) eni-0b)`,
      ],
      ['a rule EC2 still has', ARN.rule, ['  "ec2 describe-security-group-rules") echo "sgr-0a"; exit 0 ;;'], `security-group-rule ${ARN.rule} (still there)`],
      ['an Enabled key', ARN.key, ['  "kms describe-key") echo "Enabled"; exit 0 ;;'], `kms-key ${ARN.key} (Enabled)`],
      ['an active automated backup', ARN.backup, ['  "rds describe-db-instance-automated-backups") echo "active"; exit 0 ;;'], `rds-auto-backup ${ARN.backup} (active)`],
    ] as const) {
      const live = guard({ terraform: 'exit 0', leftovers: answering(taggedWith(arn), ...answers) });
      expect(live.code, `${what}: ${live.output}`).toBe(1);
      expect(live.output, what).toContain(named);
      expect(live.output, what).toContain('resource(s) still carry fss-rh-nothing');
      expect(live.report, what).toBeNull();
    }
    // A group whose VPC has gone, and a ruleless group with no interface, are settled.
    for (const [what, answers] of [
      ['its VPC is gone', ['  "ec2 describe-security-groups") printf "vpc-0a\\t1\\t1\\n"; exit 0 ;;', `  "ec2 describe-vpcs") ${notFound('InvalidVpcID.NotFound')} ;;`]],
      [
        'no rule and no interface',
        [
          '  "ec2 describe-security-groups") printf "vpc-0a\\t0\\t0\\n"; exit 0 ;;',
          '  "ec2 describe-vpcs") echo "vpc-0a"; exit 0 ;;',
          // An empty list prints no line at all; `None` would be a state nobody read.
          '  "ec2 describe-network-interfaces") exit 0 ;;',
        ],
      ],
    ] as const) {
      const settled = guard({ terraform: 'exit 0', leftovers: answering(taggedWith(ARN.group), ...answers) });
      expect(settled.code, `${what}: ${settled.output}`).toBe(0);
      expect(settled.output, what).toContain('1 security-group');
    }
  });

  it('reads again while the tagging API settles, and passes when the leftover has gone', () => {
    // The tagging API lags a deletion, so one sighting is not a leftover.
    const settling = guard({
      terraform: 'exit 0',
      reads: '2',
      leftovers: [
        'case "$1 $2" in',
        '  "resourcegroupstaggingapi get-resources")',
        `    if [ -e "$(dirname "$0")/seen" ]; then echo '[]'; else : > "$(dirname "$0")/seen"; echo '[{"arn":"arn:aws:s3:::fss-rh-nothing-updates","name":"fss-rh-nothing-updates"}]'; fi`,
        '    exit 0 ;;',
        'esac',
      ].join('\n'),
    });
    expect(settling.code, settling.output).toBe(0);
    expect(settling.output).toContain('1 resource(s) still carry fss-rh-nothing (read 1 of 2)');
    expect(settling.report).toContain('nothing_left=true');
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

  it('passes a run that created nothing, saying so rather than swallowing it', () => {
    const nothing = guard({ terraform: 'echo "Backend initialization required, please run terraform init" >&2; exit 1' });
    expect(nothing.code, nothing.output).toBe(0);
    expect(nothing.output).toContain('never initialised, so this run created nothing');
    expect(nothing.report).toContain('state_read=false');
  });

  it('fails a reading it could not make, and a session that is not the role', () => {
    // "It is gone" and "I was not allowed to look" must not report the same thing.
    for (const [call, phrase] of [
      ['resourcegroupstaggingapi get-resources', 'the resources tagged for fss-rh-nothing could not be listed'],
      ['rds describe-db-instances', 'the RDS instances could not be listed'],
      ['cloudfront list-distributions', 'the CloudFront distributions could not be listed'],
      ['s3api head-object', 'the state lock object could not be read, and not because it is gone'],
    ] as const) {
      const denied = guard({
        terraform: 'exit 0',
        leftovers: [
          'case "$1 $2" in',
          `  "${call}") echo "An error occurred (AccessDenied) when calling it" >&2; exit 254 ;;`,
          'esac',
        ].join('\n'),
      });
      expect(denied.code, call).toBe(1);
      expect(denied.output, call).toContain(phrase);
    }
    const somebody = guard({ terraform: 'exit 0', identity: 'arn:aws:sts::123456789012:assumed-role/fss-prod-deploy/x' });
    expect(somebody.code).toBe(1);
    expect(somebody.output).toContain('which is not an assumed-role session of fss-rh-deploy');
    expect(somebody.calls).toEqual([]);
  });

  it('fails an answer it cannot read as the shape it asked for, rather than reading it as empty', () => {
    // Every one of these parses, and every one would otherwise be followed by four empty
    // readings and reported as a pass (review of PR 292b).
    for (const [what, answer, phrase] of [
      ['a null projection', '  "resourcegroupstaggingapi get-resources") echo "null"; exit 0 ;;', 'the tagging API answered something that is not a list of resources'],
      ['an empty answer', '  "resourcegroupstaggingapi get-resources") exit 0 ;;', 'the tagging API answered something that is not a list of resources'],
      ['a row with no ARN', `  "resourcegroupstaggingapi get-resources") echo '[{"name":"fss-rh-nothing"}]'; exit 0 ;;`, 'listed a resource without an ARN or a Name tag'],
      ['a row that is not an object', `  "resourcegroupstaggingapi get-resources") echo '["fss-rh-nothing-alb"]'; exit 0 ;;`, 'listed something that is not a resource'],
      ['an RDS answer that is not a list', `  "rds describe-db-instances") echo '{"DBInstances":[]}'; exit 0 ;;`, 'the RDS instances answered something that is not a list of identifiers'],
      ['an RDS list of something other than names', `  "rds describe-db-snapshots") echo '[{"id":"x"}]'; exit 0 ;;`, 'the RDS snapshots answered something that is not a list of identifiers'],
      ['a CloudFront answer that is not a distribution list', '  "cloudfront list-distributions") echo "[]"; exit 0 ;;', 'CloudFront answered something that is not a distribution list'],
      // The CLI's merged answer: an Items member and nothing else. The reader asks for one
      // page so that it can check the count and the truncation (review of PR 292d).
      ['the CLI’s own merged pages', `  "cloudfront list-distributions") echo '{"Items":[{"Id":"E123"}]}'; exit 0 ;;`, 'CloudFront answered a distribution list with no readable IsTruncated'],
      // A page that would pass but for the truncation: one distribution, somebody else's.
      [
        'a page that says there are more',
        `  "cloudfront list-distributions") echo '{"IsTruncated":true,"Marker":"","MaxItems":1,"Quantity":1,"Items":[${JSON.stringify(distribution('E444', 'somebody else'))}]}'; exit 0 ;;`,
        'more than one page of distributions; the guard cannot read them all',
      ],
      ['a list that is there and null', `  "cloudfront list-distributions") echo '{"IsTruncated":false,"Quantity":0,"Items":null}'; exit 0 ;;`, 'CloudFront answered a distribution list whose Items is null'],
      ['a count of one and no distribution listed', `  "cloudfront list-distributions") echo '{"IsTruncated":false,"Quantity":1}'; exit 0 ;;`, 'CloudFront says it has 1 distribution(s) and listed none of them'],
      ['a count of one and an empty list', `  "cloudfront list-distributions") echo '{"IsTruncated":false,"Quantity":1,"Items":[]}'; exit 0 ;;`, 'CloudFront says it has 1 distribution(s) and listed 0'],
      [
        'a count of two and one distribution listed',
        `  "cloudfront list-distributions") echo '{"IsTruncated":false,"Quantity":2,"Items":[${JSON.stringify(distribution('E222', 'somebody else'))}]}'; exit 0 ;;`,
        'CloudFront says it has 2 distribution(s) and listed 1',
      ],
      ['a negative count', `  "cloudfront list-distributions") echo '{"IsTruncated":false,"Quantity":-1}'; exit 0 ;;`, 'CloudFront answered a distribution list with no readable Quantity'],
      ['a count of none and a distribution listed', `  "cloudfront list-distributions") echo '{"IsTruncated":false,"Quantity":0,"Items":[{"Id":"E123"}]}'; exit 0 ;;`, 'CloudFront says it has no distribution and listed some anyway'],
      ['a distribution with no id', `  "cloudfront list-distributions") echo '{"IsTruncated":false,"Quantity":1,"Items":[{"Comment":"fss-rh-nothing"}]}'; exit 0 ;;`, 'CloudFront listed something that is not a distribution'],
      [
        'a distribution with no readable comment',
        `  "cloudfront list-distributions") echo '{"IsTruncated":false,"Quantity":1,"Items":[{"Id":"E123","Origins":{"Items":[]}}]}'; exit 0 ;;`,
        'CloudFront listed a distribution with no readable comment or origins',
      ],
      [
        'a distribution with no readable origins',
        `  "cloudfront list-distributions") echo '{"IsTruncated":false,"Quantity":1,"Items":[{"Id":"E123","Comment":"another account"}]}'; exit 0 ;;`,
        'CloudFront listed a distribution with no readable comment or origins',
      ],
      ['a log-group answer that is not a list of names', '  "logs describe-log-groups") echo "[1]"; exit 0 ;;', 'answered something that is not a list of names'],
    ] as const) {
      const malformed = guard({ terraform: 'exit 0', leftovers: answering(answer) });
      expect(malformed.code, `${what}: ${malformed.output}`).toBe(1);
      expect(malformed.output, what).toContain(phrase);
      expect(malformed.report, what).toBeNull();
    }
  });

  it('fails a candidate whose own service answered nothing, rather than reading it as gone', () => {
    // A successful describe that projects to nothing is "I could not read the state", not
    // "it is gone"; only an absence error code settles a candidate (review of PR 292c).
    for (const [what, arn, answer, named] of [
      ['a service that answered None', ARN.service, '  "ecs describe-services") echo "None"; exit 0 ;;', `the ECS service ${ARN.service} answered 'None'`],
      ['a cluster that answered nothing', ARN.cluster, '  "ecs describe-clusters") exit 0 ;;', `the ECS cluster ${ARN.cluster} answered '<nothing>'`],
      ['a task definition that answered None', ARN.definition, '  "ecs describe-task-definition") echo "None"; exit 0 ;;', `the task definition ${ARN.definition} answered 'None'`],
      ['an interface that answered nothing', ARN.interface, '  "ec2 describe-network-interfaces") exit 0 ;;', "the network interface eni-0a answered '<nothing>'"],
      ['a rule that answered None', ARN.rule, '  "ec2 describe-security-group-rules") echo "None"; exit 0 ;;', "the security group rule sgr-0a answered 'None'"],
      ['a key that answered nothing', ARN.key, '  "kms describe-key") exit 0 ;;', `the KMS key ${ARN.key} answered '<nothing>'`],
      ['a backup that answered None', ARN.backup, '  "rds describe-db-instance-automated-backups") echo "None"; exit 0 ;;', `the automated backup ${ARN.backup} answered 'None'`],
      ['a group that answered nothing', ARN.group, '  "ec2 describe-security-groups") exit 0 ;;', "the security group sg-0a answered '<nothing>'"],
      ['a group that answered None', ARN.group, '  "ec2 describe-security-groups") echo "None"; exit 0 ;;', "the security group sg-0a answered 'None'"],
      // A whole answer with a field nobody read: `None 0 0` skipped the VPC check and
      // settled the group as ruleless (review of PR 292d).
      ['a group whose VPC is None', ARN.group, '  "ec2 describe-security-groups") printf "None\\t0\\t0\\n"; exit 0 ;;', "the security group sg-0a answered 'None' for its VPC"],
      [
        'a group whose rule count is None',
        ARN.group,
        '  "ec2 describe-security-groups") printf "vpc-0a\\tNone\\t0\\n"; exit 0 ;;',
        "the security group sg-0a answered 'None' for its ingress rule count",
      ],
      [
        'a service whose counts are None',
        ARN.service,
        '  "ecs describe-services") printf "ACTIVE\\tNone\\tNone\\tNone\\n"; exit 0 ;;',
        `the ECS service ${ARN.service} answered 'None' for its running count`,
      ],
      [
        'a service whose count is not a number',
        ARN.service,
        '  "ecs describe-services") printf "ACTIVE\\t2\\tsome\\tNone\\n"; exit 0 ;;',
        `the ECS service ${ARN.service} answered 'some' for its pending count, which is not a whole number`,
      ],
    ] as const) {
      const unread = guard({ terraform: 'exit 0', leftovers: answering(taggedWith(arn), answer) });
      expect(unread.code, `${what}: ${unread.output}`).toBe(1);
      expect(unread.output, what).toContain(named);
      // An empty answer, and an answer nobody can read, are both not an absence.
      expect(unread.output, what).toContain('is not an absence: nothing here can say whether this');
      expect(unread.report, what).toBeNull();
    }
    // A malformed identifier means the identifier could not be read, not that it is gone.
    const malformed = guard({
      terraform: 'exit 0',
      leftovers: answering(taggedWith(ARN.group), `  "ec2 describe-security-groups") ${notFound('InvalidGroup.Malformed')} ;;`),
    });
    expect(malformed.code, malformed.output).toBe(1);
    expect(malformed.output).toContain('the identifier itself could not be read');
    expect(malformed.output).toContain('a resource that was deleted answers NotFound instead');
  });

  it('settles an ECS candidate on ECS’s own MISSING, and on no other mixture', () => {
    // ECS reports absence with exit 0 and a `failures` entry: a deleted service, task or
    // cluster the tagging API still lists answers None for its state and MISSING for the
    // reason. Taking None alone for absence would set aside a service that is running;
    // refusing None altogether would fail every teardown (the coordinator's reading of the
    // real account, 27 September 2026).
    const CANNOT_DESCRIBE = 'An error occurred (ClientException) when calling the DescribeTaskDefinition operation: Unable to describe task definition.';
    for (const [what, arn, answer] of [
      ['a service', ARN.service, '  "ecs describe-services") printf "None\\tNone\\tNone\\tMISSING\\n"; exit 0 ;;'],
      ['a cluster', ARN.cluster, '  "ecs describe-clusters") printf "None\\tMISSING\\n"; exit 0 ;;'],
      ['a task', ARN.task, '  "ecs describe-tasks") printf "None\\tMISSING\\n"; exit 0 ;;'],
      ['a definition ECS cannot describe', ARN.definition, `  "ecs describe-task-definition") echo "${CANNOT_DESCRIBE}" >&2; exit 254 ;;`],
    ] as const) {
      const gone = guard({ terraform: 'exit 0', leftovers: answering(taggedWith(arn), answer) });
      expect(gone.code, `${what}: ${gone.output}`).toBe(0);
      expect(gone.output, what).toContain('set aside, read as gone, inactive or pending deletion');
      expect(gone.report, what).toContain('nothing_left=true');
    }
    for (const [what, arn, answer, named] of [
      ['a service with no state and no reason', ARN.service, '  "ecs describe-services") printf "None\\tNone\\tNone\\tNone\\n"; exit 0 ;;', 'answered None for its state and no failure reason at all'],
      ['a cluster with no state and no reason', ARN.cluster, '  "ecs describe-clusters") printf "None\\tNone\\n"; exit 0 ;;', 'answered None for its state and no failure reason at all'],
      ['a service both running and MISSING', ARN.service, '  "ecs describe-services") printf "ACTIVE\\t1\\t0\\tMISSING\\n"; exit 0 ;;', 'in one breath, which is not an absence anything can read'],
      ['a reason that is neither', ARN.task, '  "ecs describe-tasks") printf "None\\tINVALID_PARAMETER\\n"; exit 0 ;;', "answered the failure reason 'INVALID_PARAMETER'"],
      [
        'a definition refused for another reason',
        ARN.definition,
        '  "ecs describe-task-definition") echo "An error occurred (ClientException) when calling it" >&2; exit 254 ;;',
        'could not be read, and not because it is gone',
      ],
      [
        'a definition refused the credential',
        ARN.definition,
        '  "ecs describe-task-definition") echo "An error occurred (AccessDeniedException) when calling it" >&2; exit 254 ;;',
        'could not be read, and not because it is gone',
      ],
    ] as const) {
      const unread = guard({ terraform: 'exit 0', leftovers: answering(taggedWith(arn), answer) });
      expect(unread.code, `${what}: ${unread.output}`).toBe(1);
      expect(unread.output, what).toContain(named);
      expect(unread.report, what).toBeNull();
    }
  });

  it('refuses to assert anything on no reading at all', () => {
    const none = guard({ terraform: 'exit 0', reads: '0' });
    expect(none.code).toBe(1);
    expect(none.output).toContain('nothing can be asserted without reading at least once');
    const nonsense = guard({ terraform: 'exit 0', reads: 'twice' });
    expect(nonsense.code).toBe(1);
    expect(nonsense.output).toContain("FSS_REHEARSAL_SETTLING_READS is 'twice'");
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
