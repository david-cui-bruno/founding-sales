import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repositoryPath } from './support/repository.ts';

/**
 * Appendix G 39: "Production and rehearsal Terraform plans use distinct state keys,
 * roles, secrets and resource namespaces; rehearsal teardown cannot address
 * production resources."
 *
 * Half of this is checkable offline and the two `isolation.tftest.hcl` suites check
 * it: each root pins its own name prefix, refuses the other's, and asserts no
 * resource name carries the neighbour's string. The other half — that a rehearsal
 * teardown *cannot* reach a production resource — is an IAM boundary, and no plan
 * proves an IAM boundary, which is why `rehearsal-prefix-guard.sh` runs after
 * teardown in the rehearsal and why this check insists the workflow calls it.
 *
 * ## The vacuous-pass trap
 *
 * Two plans that differ in every value are isolated by accident rather than by
 * construction: change one variable and the accident evaporates, and no offline test
 * notices. Closed by pinning the two things that must be structurally different —
 * the state key prefix and the name prefix — and by asserting each root refuses the
 * other's prefix explicitly, so isolation is a rule the plan enforces rather than a
 * coincidence of the values somebody typed.
 */

describe('Appendix G 39: the prefix guard tells the run from the stable repositories', () => {
  it('runs that classifier rather than only declaring it', () => {
    // Asserting the source would pass against a classifier somebody commented out.
    const reports = mkdtempSync(join(tmpdir(), 'fss-guard-'));
    const output = execFileSync(repositoryPath('infra/scripts/rehearsal-prefix-guard.sh'), ['fss-rh-check', 'after'], {
      env: { ...process.env, FSS_REHEARSAL_DRY_RUN: '1', FSS_REHEARSAL_REPORTS: reports },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    expect(output).toContain('fss-rh-check-api: rehearsal-run');
    expect(output).toContain('fss-rh-api: rehearsal-stable');
    expect(output).toContain('fss-rh-worker: rehearsal-stable');
  });
});

/**
 * G12e: the provider does not re-assume the role the session already holds.
 *
 * All three roots assumed `deployment_role_name` unconditionally. Locally that is
 * right — David's user assumes `fss-prod-deploy` — but in CI the job has already
 * assumed `fss-rh-deploy` through GitHub OIDC, so Terraform would ask STS to assume
 * `fss-rh-deploy` from a session that already is `fss-rh-deploy`. That succeeds only
 * if the role trusts itself, which it does not and must not (Appendix G 39). The
 * answer is a root variable, `assume_deployment_role`, defaulting to true everywhere
 * and passed as false by the two workflows whose session already holds the role.
 *
 * ## The vacuous-pass trap
 *
 * `assume_deployment_role=false` means "use whatever credentials this process has",
 * and a workflow that passed it without proving what those credentials are would have
 * turned a scoped role into an ambient one — the opposite of scenario 39. Asserting
 * the flag's presence would pass against exactly that workflow. Closed by running the
 * caller-identity check against six identities offline: a user, a role whose name
 * merely starts the same way, a different rehearsal role, an ARN with no session, no
 * identity at all, and the one it must accept.
 */
describe('Appendix G 39: the caller-identity check refuses every principal but the rehearsal role', () => {
  it('runs the check rather than describing it: one identity accepted, five refused', () => {
    const judge = (identity: string, role?: string): boolean => {
      try {
        execFileSync(repositoryPath('infra/scripts/rehearsal-caller-identity.sh'), role === undefined ? [] : [role], {
          // Supplied rather than fetched: this makes no AWS call.
          env: {
            ...process.env,
            FSS_REHEARSAL_CALLER_IDENTITY: identity,
            FSS_REHEARSAL_REPORTS: mkdtempSync(join(tmpdir(), 'fss-identity-')),
          },
          encoding: 'utf8',
          stdio: 'pipe',
        });
        return true;
      } catch {
        return false;
      }
    };

    expect(judge('arn:aws:sts::123456789012:assumed-role/fss-rh-deploy/fss-rh-2026')).toBe(true);

    // A user who happens to be allowed to run the workflow is not the role.
    expect(judge('arn:aws:iam::123456789012:user/someone')).toBe(false);
    // A role whose name merely begins the same way. `*fss-rh-*` would have passed it.
    expect(judge('arn:aws:sts::123456789012:assumed-role/fss-rh-deploy-other/x')).toBe(false);
    expect(judge('arn:aws:sts::123456789012:assumed-role/fss-rh-readonly/x')).toBe(false);
    // The role ARN rather than a session of it: the shape is the evidence.
    expect(judge('arn:aws:sts::123456789012:assumed-role/fss-rh-deploy')).toBe(false);
    // No identity at all, which is what an unauthenticated call would print.
    expect(judge('')).toBe(false);
    // And it refuses to vouch for production, whose applies assume their role in the
    // provider and never pass this flag.
    expect(judge('arn:aws:sts::123456789012:assumed-role/fss-prod-deploy/x', 'fss-prod-deploy')).toBe(false);
  });
});

/**
 * G12f, and lane g97: the guard reads the run's own resources, and nothing names production.
 *
 * Until g97 Appendix G 39's last clause was measured by recording the *production*
 * inventory before the run and comparing it afterwards. That read named production, and
 * `rehearsal_refuse_production_arguments` refuses every argument that names production —
 * so the first credentialed rehearsal (Actions 35548888865) refused itself with
 *
 *   FAIL: a rehearsal command names a production resource: Key=Name,Values=fss-prod*
 *
 * and G12f gave the read the one exemption from the refusal. Lane g97 (25 September
 * 2026) dropped the production diff — it failed a rehearsal only because the operator
 * applied production while it ran — and the read is now of the run's own resources, by
 * name, through the ordinary wrapper. There is no exemption left.
 *
 * ## The vacuous-pass trap
 *
 * A read that selected by a bare string prefix would count another run's resources as
 * this one's, and a guard that "has no exemption" is only worth saying if the old
 * exempt caller is really gone and the old query is really refused. So the selection is
 * run against a longer prefix and a production name, the old caller is called and must
 * not exist, and the old query through the wrapper must still be refused.
 */

/** Run a body with `rehearsal-common.sh` sourced, and report what it did. */
function inCommon(
  body: string,
  environment: Readonly<Record<string, string>> = {},
): { readonly code: number; readonly output: string } {
  const directory = mkdtempSync(join(tmpdir(), 'fss-common-'));
  const script = join(directory, 'case.sh');
  writeFileSync(
    script,
    `#!/usr/bin/env bash\nsource ${repositoryPath('infra/scripts/rehearsal-common.sh')}\nset +e\n${body}\n`,
  );
  chmodSync(script, 0o755);
  const result = spawnSync('/bin/bash', [script], {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
  return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

/** Write an executable stand-in (a fake `aws`, a fake `terraform`) and return its path. */
function stubCommand(directory: string, name: string, body: string): string {
  const path = join(directory, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** Run one of the rehearsal scripts and report everything it said. */
function runRehearsalScript(
  script: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
  cwd?: string,
): { readonly code: number; readonly output: string } {
  const result = spawnSync(repositoryPath(script), [...args], {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
    ...(cwd === undefined ? {} : { cwd }),
  });
  return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

/** A plan file holding exactly these lines. */
function planFile(...lines: readonly string[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'fss-plan-'));
  const path = join(directory, 'plan.txt');
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

const GUARD = 'infra/scripts/rehearsal-prefix-guard.sh';
const PRODUCTION_FILTER = 'Key=Name,Values=fss-prod*';
/** The line the dry run prints for the read of the run's own resources. */
const RUN_READ = 'PLAN aws resourcegroupstaggingapi get-resources --tag-filters Key=Name --output json | select names beginning fss-rh-dryrun';

describe('Appendix G 39: the guard reads the run’s own resources, and no rehearsal command names production', () => {
  it('reads the run’s own resources through the ordinary wrapper, and prints the line the plan guard looks for', () => {
    const { code, output } = inCommon('FSS_REHEARSAL_DRY_RUN=1 rehearsal_read_run_inventory fss-rh-dryrun');

    expect(code).toBe(0);
    expect(output).toContain(RUN_READ);
    expect(output).not.toContain('fss-prod');
  });

  it('refuses a production prefix, so the read cannot become the old production read', () => {
    const { output } = inCommon('FSS_REHEARSAL_DRY_RUN=1 rehearsal_read_run_inventory fss-prod\necho "rc=$?"');

    expect(output).toContain("'fss-prod' is not a rehearsal prefix");
    expect(output).toContain('rc=1');
    expect(output).not.toContain('PLAN aws resourcegroupstaggingapi');
  });

  it('refuses the old production query issued through the ordinary wrapper', () => {
    // The exact command of the first credentialed run. It is still refused everywhere.
    const { output } = inCommon(
      `FSS_REHEARSAL_DRY_RUN=1 rehearsal_aws resourcegroupstaggingapi get-resources --tag-filters '${PRODUCTION_FILTER}'\necho "rc=$?"`,
    );

    expect(output).toContain(`FAIL: a rehearsal command names a production resource: ${PRODUCTION_FILTER}`);
    expect(output).toContain('rc=1');
    // And it did not go on to plan the command anyway: a refusal that returns 0 is a
    // refusal only while the caller happens to have errexit on.
    expect(output).not.toContain('PLAN aws resourcegroupstaggingapi');
  });

  it('refuses a mutating command that names production, wrapper or not', () => {
    const wrapped = inCommon(
      'FSS_REHEARSAL_DRY_RUN=1 rehearsal_aws rds delete-db-instance --db-instance-identifier fss-prod-pg\necho "rc=$?"',
    );
    expect(wrapped.output).toContain('FAIL: a rehearsal command names a production resource: fss-prod-pg');
    expect(wrapped.output).toContain('rc=1');
    expect(wrapped.output).not.toContain('PLAN aws rds delete-db-instance');

    const terraform = inCommon(
      'FSS_REHEARSAL_DRY_RUN=1 rehearsal_terraform destroy -var=name_prefix=fss-prod\necho "rc=$?"',
    );
    expect(terraform.output).toContain('FAIL: a rehearsal command names a production resource');
    expect(terraform.output).toContain('rc=1');
  });

  it('selects the run’s own names locally, sorted, and neither a longer prefix nor production', () => {
    // `get-resources` tag-filter values are exact matches and take no wildcard, so the
    // selection is local; and `fss-rh-dryrunx` is another run, not this one.
    const rows = JSON.stringify([
      { arn: 'arn:aws:s3:::fss-rh-dryrun-journal', name: 'fss-rh-dryrun-journal' },
      { arn: 'arn:aws:rds:us-east-1:1:db:fss-rh-dryrun-pg', name: 'fss-rh-dryrun-pg' },
      { arn: 'arn:aws:ecs:us-east-1:1:cluster/fss-rh-dryrun', name: 'fss-rh-dryrun' },
      { arn: 'arn:aws:rds:us-east-1:1:db:fss-rh-dryrunx-pg', name: 'fss-rh-dryrunx-pg' },
      { arn: 'arn:aws:s3:::fss-prod-journal', name: 'fss-prod-journal' },
      { arn: 'arn:aws:s3:::somebody-elses', name: 'other' },
    ]);
    const { code, output } = inCommon(`printf '%s' '${rows}' | rehearsal_select_run_names fss-rh-dryrun`);

    expect(code).toBe(0);
    expect(JSON.parse(output)).toEqual([
      'arn:aws:ecs:us-east-1:1:cluster/fss-rh-dryrun',
      'arn:aws:rds:us-east-1:1:db:fss-rh-dryrun-pg',
      'arn:aws:s3:::fss-rh-dryrun-journal',
    ]);
  });

  it('records a sentinel in dry mode, and the after phase refuses to compare against it', () => {
    const reports = mkdtempSync(join(tmpdir(), 'fss-inventory-'));
    const before = runRehearsalScript(GUARD, ['fss-rh-dryrun', 'before'], {
      FSS_REHEARSAL_DRY_RUN: '1',
      FSS_REHEARSAL_REPORTS: reports,
    });
    expect(before.code).toBe(0);
    expect(readFileSync(join(reports, 'run-inventory.json'), 'utf8')).toContain('dry-run: no inventory was read');

    // The workflow runs the `before` phase in dry mode when it decides the prefix. If
    // the real one never ran, comparing against that file would be a pass by
    // construction.
    const stubs = mkdtempSync(join(tmpdir(), 'fss-stub-'));
    const after = runRehearsalScript(GUARD, ['fss-rh-dryrun', 'after'], {
      FSS_REHEARSAL_REPORTS: reports,
      FSS_REHEARSAL_CALLER_IDENTITY: 'arn:aws:sts::123456789012:assumed-role/fss-rh-deploy/x',
      TERRAFORM: stubCommand(stubs, 'terraform', 'echo "No state file was found!" >&2; exit 1'),
      FSS_REHEARSAL_AWS_COMMAND: stubCommand(stubs, 'aws', 'echo "[]"'),
    });
    expect(after.code).not.toBe(0);
    expect(after.output).toContain('the only inventory recorded was a dry run');
  });
});

describe('Appendix G 39: the plan guard reads a printed plan, so the rehearsal cannot refuse itself', () => {
  it('accepts the plan the dry run actually prints today', () => {
    // Generated rather than fabricated: this is the same sequence the workflow runs,
    // so a step that acquires a production-named command fails here on the pull
    // request that adds it.
    const reports = mkdtempSync(join(tmpdir(), 'fss-planrun-'));
    const environment = {
      FSS_REHEARSAL_DRY_RUN: '1',
      FSS_REHEARSAL_REPORTS: reports,
    };
    const steps: readonly (readonly [string, readonly string[]])[] = [
      ['infra/scripts/rehearsal-caller-identity.sh', ['fss-rh-deploy']],
      [GUARD, ['fss-rh-dryrun', 'before']],
      ['infra/scripts/rehearsal-schema-ranges.sh', ['fss-rh-dryrun']],
      ['infra/scripts/rehearsal-restore-drill.sh', ['fss-rh-dryrun']],
      ['infra/scripts/rehearsal-teardown.sh', ['fss-rh-dryrun']],
      [GUARD, ['fss-rh-dryrun', 'after']],
    ];
    let printed = '';
    for (const [script, args] of steps) {
      const step = runRehearsalScript(script, args, environment);
      expect(step.code, `${script} ${args.join(' ')}\n${step.output}`).toBe(0);
      printed += step.output;
    }
    // The read is in the plan at all, and nothing in it names production.
    expect(printed).toContain(RUN_READ);
    expect(printed).not.toContain('fss-prod');

    const directory = mkdtempSync(join(tmpdir(), 'fss-plan-'));
    const path = join(directory, 'plan.txt');
    writeFileSync(path, printed);
    const guard = runRehearsalScript(GUARD, ['fss-rh-dryrun', 'plan', path], {});
    expect(guard.code, guard.output).toBe(0);
    expect(guard.output).toContain('no planned command names production');
  });

  it('refuses the plan this rehearsal printed before the exemption existed', () => {
    // The literal command of Actions run 35548888865. Red on the pull request now.
    const guard = runRehearsalScript(
      GUARD,
      [
        'fss-rh-dryrun',
        'plan',
        planFile(
          RUN_READ,
          `PLAN aws resourcegroupstaggingapi get-resources --tag-filters ${PRODUCTION_FILTER} --query 'ResourceTagMappingList[].ResourceARN' --output json`,
        ),
      ],
      {},
    );

    expect(guard.code).not.toBe(0);
    expect(guard.output).toContain('a rehearsal command names a production resource');
  });

  it('refuses the production read the exemption allowed until g97, marker and all', () => {
    const guard = runRehearsalScript(
      GUARD,
      [
        'fss-rh-dryrun',
        'plan',
        planFile(
          RUN_READ,
          'PLAN aws resourcegroupstaggingapi get-resources --tag-filters Key=Name --output json | select names beginning fss-prod # exempt-read-only-production-inventory',
        ),
      ],
      {},
    );

    expect(guard.code).not.toBe(0);
    expect(guard.output).toContain('a rehearsal command names a production resource');
  });

  it('refuses a production command standing beside a legitimate read', () => {
    // The refusal that the "no read" case cannot distinguish: a plan with the read in
    // it and one other command naming production. Without this, a guard that counted
    // the read and ignored everything else would look identical.
    const guard = runRehearsalScript(
      GUARD,
      ['fss-rh-dryrun', 'plan', planFile(RUN_READ, 'PLAN terraform destroy -var=name_prefix=fss-prod')],
      {},
    );

    expect(guard.code).not.toBe(0);
    expect(guard.output).toContain('a rehearsal command names a production resource');
    expect(guard.output).toContain("would be refused by the rehearsal's own guard");
  });

  it('refuses a plan whose read is of another run', () => {
    const guard = runRehearsalScript(
      GUARD,
      ['fss-rh-dryrun', 'plan', planFile(RUN_READ.replace(/fss-rh-dryrun$/u, 'fss-rh-otherrun'))],
      {},
    );

    expect(guard.code).not.toBe(0);
    expect(guard.output).toContain('the plan contains no read of the resources named for fss-rh-dryrun');
  });

  it('refuses a plan with no read at all, which is the shape of a silent deletion', () => {
    const guard = runRehearsalScript(
      GUARD,
      ['fss-rh-dryrun', 'plan', planFile('PLAN terraform destroy -var=name_prefix=fss-rh-dryrun')],
      {},
    );

    expect(guard.code).not.toBe(0);
    expect(guard.output).toContain('the plan contains no read of the resources named for fss-rh-dryrun');
  });

  it('refuses a plan file that is not there, which is the shape of a step that did not run', () => {
    const guard = runRehearsalScript(GUARD, ['fss-rh-dryrun', 'plan', join(tmpdir(), 'fss-no-plan.txt')], {});
    expect(guard.code).not.toBe(0);
  });

});

describe('Appendix G 39: a teardown of a run that created nothing still tears down', () => {
  /** Everything absent, as it is after a run whose creation step never ran. */
  const NOTHING_EXISTS = `
case "$1 $2" in
  "ecs list-tasks")
    echo "An error occurred (ClusterNotFoundException) when calling the ListTasks operation: not found" >&2
    exit 254 ;;
  "rds delete-db-instance")
    echo "An error occurred (DBInstanceNotFound) when calling the DeleteDBInstance operation: not found" >&2
    exit 254 ;;
  "rds wait") exit 0 ;;
  "rds describe-db-snapshots") echo '[]' ; exit 0 ;;
  "s3api list-object-versions")
    echo "An error occurred (NoSuchBucket) when calling the ListObjectVersions operation: no such bucket" >&2
    exit 254 ;;
  "s3api delete-bucket")
    echo "An error occurred (NoSuchBucket) when calling the DeleteBucket operation: no such bucket" >&2
    exit 254 ;;
esac
echo "unexpected: $*" >&2; exit 9`;

  /** A rehearsal root with no state, and stand-ins for the two commands the teardown runs. */
  function teardownWorld(options: {
    readonly aws: string;
    readonly terraform: string;
    /** The create step writes this file beside the root; a teardown from a fresh checkout has none. */
    readonly tfvars?: boolean;
  }): {
    readonly code: number;
    readonly output: string;
    readonly reports: string;
  } {
    const stubs = mkdtempSync(join(tmpdir(), 'fss-teardown-'));
    const reports = mkdtempSync(join(tmpdir(), 'fss-teardown-reports-'));
    if (options.tfvars ?? true) {
      // What the create step leaves: identifiers only, and every variable the root
      // requires, because `terraform destroy` asks for the same ones `apply` did.
      writeFileSync(
        join(stubs, 'run.auto.tfvars.json'),
        JSON.stringify({
          assume_deployment_role: false,
          bootstrap: true,
          name_prefix: 'fss-rh-nothing',
          api_image: `123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-rh-api@sha256:${'a'.repeat(64)}`,
          worker_image: `123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-rh-worker@sha256:${'b'.repeat(64)}`,
          certificate_arn: 'arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000',
          api_hostname: 'rehearsal.example.invalid',
          api_schema_range: { min: 14, max: 14 },
          worker_schema_range: { min: 14, max: 14 },
        }),
      );
    }
    const result = runRehearsalScript(
      'infra/scripts/rehearsal-teardown.sh',
      ['fss-rh-nothing'],
      {
        FSS_REHEARSAL_REPORTS: reports,
        FSS_REHEARSAL_CALLER_IDENTITY: 'arn:aws:sts::123456789012:assumed-role/fss-rh-deploy/x',
        FSS_REHEARSAL_AWS_COMMAND: stubCommand(stubs, 'aws', options.aws),
        TERRAFORM: stubCommand(stubs, 'terraform', options.terraform),
      },
      stubs,
    );
    return { ...result, reports };
  }

  it('treats every absent thing as already done, and reaches the last step', () => {
    const { code, output, reports } = teardownWorld({
      aws: NOTHING_EXISTS,
      terraform: 'echo "No state file was found!" >&2; exit 1',
    });

    expect(code, output).toBe(0);
    // Every one of the five steps ran; before G12f the first stopped the script.
    // Step 0 is G12h's: a one-off task still running holds an elastic network
    // interface in a subnet the destroy is about to delete, and a cluster that was
    // never created is an absence like any other.
    expect(output).toContain('already absent (ClusterNotFoundException)');
    expect(output).toContain('already absent (DBInstanceNotFound)');
    expect(output).toContain('already absent (NoSuchBucket)');
    expect(output).toContain('4/5 destroying the rehearsal root');
    expect(output).toContain('created nothing to destroy');
    expect(output).toContain('5/5 removing the journal bucket if the destroy left it');
    const report = readFileSync(join(reports, 'teardown.txt'), 'utf8');
    expect(report).toContain('destroyed=nothing_created');
    expect(report).toContain('journal_bucket=gone');
  });

  it('still destroys when there is something in the state, so tolerance is not silence', () => {
    // The positive control. Without it, "skip everything" would pass the test above.
    const { code, output, reports } = teardownWorld({
      aws: NOTHING_EXISTS,
      terraform:
        'if [ "$1" = "state" ]; then echo "module.stack.aws_s3_bucket.journal"; else echo "destroy: $*"; fi',
    });

    expect(code, output).toBe(0);
    expect(output).toContain('destroy: destroy -auto-approve');
    expect(readFileSync(join(reports, 'teardown.txt'), 'utf8')).toContain('destroyed=true');
  });

  it('names the journal bucket with the account of the verified session, and deletes it when the destroy left it', () => {
    // Actions 35649752231 (21 September 2026): the script named the bucket without the
    // account-id suffix the module appends, listed a bucket that does not exist, was told
    // NoSuchBucket, and the real bucket outlived a destroy whose state never held it.
    // Every call is recorded so the order can be checked: the bucket is deleted after the
    // destroy, never before it.
    const record = join(mkdtempSync(join(tmpdir(), 'fss-teardown-record-')), 'calls');
    const { code, output, reports } = teardownWorld({
      aws: [
        `echo "aws $*" >> '${record}'`,
        'case "$*" in',
        `  *list-object-versions*) echo '{"Objects": []}' ;;`,
        `  *list-tasks*|*describe-db-snapshots*) echo '[]' ;;`,
        `  *delete-db-instance*) echo 'An error occurred (DBInstanceNotFound) when calling the DeleteDBInstance operation' >&2; exit 254 ;;`,
        `  *) echo '{}' ;;`,
        'esac',
      ].join('\n'),
      terraform: [
        `echo "terraform $*" >> '${record}'`,
        'if [ "$1" = "state" ]; then echo "module.stack.module.journal.aws_s3_bucket_policy.journal"; else echo "destroy: $*"; fi',
      ].join('\n'),
    });

    expect(code, output).toBe(0);
    const calls = readFileSync(record, 'utf8').split('\n');
    const bucket = 'fss-rh-nothing-suppression-journal-123456789012';
    expect(calls.filter(call => call.includes(`--bucket ${bucket} `) || call.endsWith(`--bucket ${bucket}`)).length, calls.join('\n')).toBeGreaterThan(0);
    // The old name, without the account, never appears.
    expect(calls.filter(call => /suppression-journal(\s|$)/.test(call))).toEqual([]);
    const destroyAt = calls.findIndex(call => call.startsWith('terraform destroy'));
    const deleteAt = calls.findIndex(call => call.includes(`s3api delete-bucket --bucket ${bucket}`));
    expect(destroyAt, calls.join('\n')).toBeGreaterThan(-1);
    expect(deleteAt, calls.join('\n')).toBeGreaterThan(destroyAt);
    // The restored instance's deletion is waited for before the destroy that would meet
    // its subnet group and security groups still held (independent review, 22 September).
    const instanceDeleteAt = calls.findIndex(call => call.includes('rds delete-db-instance --db-instance-identifier fss-rh-nothing-pg-restored'));
    const waitAt = calls.findIndex(call => call.includes('rds wait db-instance-deleted --db-instance-identifier fss-rh-nothing-pg-restored'));
    expect(instanceDeleteAt, calls.join('\n')).toBeGreaterThan(-1);
    expect(waitAt, calls.join('\n')).toBeGreaterThan(instanceDeleteAt);
    expect(waitAt).toBeLessThan(destroyAt);
    expect(readFileSync(join(reports, 'teardown.txt'), 'utf8')).toContain('destroyed=true journal_bucket=gone');
  });

  it('refuses to destroy without the file the create step wrote, rather than fail on a missing variable', () => {
    // `terraform destroy` requires every variable `apply` did. The second credentialed
    // run (21 September 2026) showed the apply itself missing two of them; a teardown
    // that reached destroy with none would have been refused by Terraform and left the
    // environment standing. The script's refusal names the file and where the recipe is.
    const { code, output } = teardownWorld({
      aws: NOTHING_EXISTS,
      terraform:
        'if [ "$1" = "state" ]; then echo "module.stack.aws_s3_bucket.journal"; else echo "destroy: $*"; fi',
      tfvars: false,
    });

    expect(code, output).toBe(1);
    expect(output).toContain('run.auto.tfvars.json is absent');
    expect(output).toContain('release.md section 3 step 13');
    expect(output).not.toContain('destroy: destroy -auto-approve');
  });

  it('fails on a refusal that is not an absence, because those must not read the same', () => {
    const { code, output } = teardownWorld({
      aws: 'echo "An error occurred (AccessDenied) when calling the DeleteDBInstance operation: no" >&2; exit 254',
      terraform: 'echo "No state file was found!" >&2; exit 1',
    });

    expect(code).not.toBe(0);
    expect(output).toContain('did not fail because the resource was absent');
  });

  it('fails when the state is unreadable for a reason that is not “nothing was created”', () => {
    const { code, output } = teardownWorld({
      aws: NOTHING_EXISTS,
      terraform: 'echo "Error: error loading state: AccessDenied" >&2; exit 1',
    });

    expect(code).not.toBe(0);
    expect(output).toContain('not because the run created nothing');
  });

  it('deletes only this run’s snapshots, and tolerates one that is already gone', () => {
    const { code, output } = teardownWorld({
      aws: `
case "$1 $2" in
  "ecs list-tasks") echo '[]' ; exit 0 ;;
  "rds delete-db-instance") exit 0 ;;
  "rds wait") exit 0 ;;
  "rds describe-db-snapshots") echo '["fss-rh-nothing-final","fss-prod-nightly","fss-rh-someone-else"]' ; exit 0 ;;
  "rds delete-db-snapshot")
    echo "An error occurred (DBSnapshotNotFound) when calling the DeleteDBSnapshot operation: gone" >&2
    exit 254 ;;
  "s3api list-object-versions") echo '{"Objects": null}' ; exit 0 ;;
  "s3api delete-bucket") exit 0 ;;
esac
echo "unexpected: $*" >&2; exit 9`,
      terraform: 'echo "No state file was found!" >&2; exit 1',
    });

    expect(code, output).toBe(0);
    expect(output).toContain('deleting snapshot fss-rh-nothing-final: already absent (DBSnapshotNotFound)');
    // The classifier, not a prefix match somebody wrote twice.
    expect(output).not.toContain('fss-prod-nightly');
    expect(output).not.toContain('deleting snapshot fss-rh-someone-else');
  });

  it('still compares the run’s own resources afterwards when nothing was created', () => {
    // The deliverable of the scenario, and the thing that was lost when the teardown
    // stopped at its first step: the comparison has to run, and pass, on the run that
    // created nothing. The account holds production's resources; the run's own read
    // selects none of them.
    const stubs = mkdtempSync(join(tmpdir(), 'fss-after-'));
    const reports = mkdtempSync(join(tmpdir(), 'fss-after-reports-'));
    const environment = {
      FSS_REHEARSAL_REPORTS: reports,
      FSS_REHEARSAL_CALLER_IDENTITY: 'arn:aws:sts::123456789012:assumed-role/fss-rh-deploy/x',
      FSS_REHEARSAL_AWS_COMMAND: stubCommand(
        stubs,
        'aws',
        `echo '[{"arn":"arn:aws:s3:::fss-prod-journal","name":"fss-prod-journal"}]'`,
      ),
      TERRAFORM: stubCommand(stubs, 'terraform', 'echo "No state file was found!" >&2; exit 1'),
    };

    const before = runRehearsalScript(GUARD, ['fss-rh-nothing', 'before'], environment);
    expect(before.code, before.output).toBe(0);
    expect(JSON.parse(readFileSync(join(reports, 'run-inventory.json'), 'utf8'))).toEqual([]);

    const after = runRehearsalScript(GUARD, ['fss-rh-nothing', 'after'], environment, stubs);
    expect(after.code, after.output).toBe(0);
    expect(after.output).toContain('nothing with the production prefix was addressed');
    const report = readFileSync(join(reports, 'prefix-guard.txt'), 'utf8');
    expect(report).toContain('state_read=false');
    expect(report).toContain('production_untouched=true run_resources_left=0');
  });

  it('passes when production changes during the run, which is what failed the night of 25 September', () => {
    // Lane g97: the operator applied production while a rehearsal ran, and the old
    // production diff failed the rehearsal for it. Production is not compared any more.
    const stubs = mkdtempSync(join(tmpdir(), 'fss-changed-'));
    const reports = mkdtempSync(join(tmpdir(), 'fss-changed-reports-'));
    const terraform = stubCommand(stubs, 'terraform', 'echo "No state file was found!" >&2; exit 1');

    const before = runRehearsalScript(GUARD, ['fss-rh-nothing', 'before'], {
      FSS_REHEARSAL_REPORTS: reports,
      FSS_REHEARSAL_AWS_COMMAND: stubCommand(
        stubs,
        'aws-before',
        `echo '[{"arn":"arn:aws:ecs:us-east-1:1:task-definition/fss-prod-api:4","name":"fss-prod-api"}]'`,
      ),
      TERRAFORM: terraform,
    });
    expect(before.code, before.output).toBe(0);

    const after = runRehearsalScript(
      GUARD,
      ['fss-rh-nothing', 'after'],
      {
        FSS_REHEARSAL_REPORTS: reports,
        FSS_REHEARSAL_CALLER_IDENTITY: 'arn:aws:sts::123456789012:assumed-role/fss-rh-deploy/x',
        FSS_REHEARSAL_AWS_COMMAND: stubCommand(
          stubs,
          'aws-after',
          `echo '[{"arn":"arn:aws:ecs:us-east-1:1:task-definition/fss-prod-api:5","name":"fss-prod-api"},{"arn":"arn:aws:rds:us-east-1:1:db:fss-prod-pg","name":"fss-prod-pg"}]'`,
        ),
        TERRAFORM: terraform,
      },
      stubs,
    );
    expect(after.code, after.output).toBe(0);
    expect(after.output).not.toContain('fss-prod');
  });

  it('fails when the run left a durable resource of its own, after reading again, so the pass above is not free', () => {
    const stubs = mkdtempSync(join(tmpdir(), 'fss-left-'));
    const reports = mkdtempSync(join(tmpdir(), 'fss-left-reports-'));
    writeFileSync(join(reports, 'run-inventory.json'), '[]\n');
    const database = 'arn:aws:rds:us-east-1:123456789012:db:fss-rh-nothing-pg';

    const after = runRehearsalScript(
      GUARD,
      ['fss-rh-nothing', 'after'],
      {
        FSS_REHEARSAL_REPORTS: reports,
        FSS_REHEARSAL_CALLER_IDENTITY: 'arn:aws:sts::123456789012:assumed-role/fss-rh-deploy/x',
        FSS_REHEARSAL_AWS_COMMAND: stubCommand(stubs, 'aws', `echo '[{"arn":"${database}","name":"fss-rh-nothing-pg"}]'`),
        TERRAFORM: stubCommand(stubs, 'terraform', 'echo "No state file was found!" >&2; exit 1'),
        FSS_REHEARSAL_SETTLE_READS: '2',
        FSS_REHEARSAL_SETTLE_SECONDS: '0',
      },
      stubs,
    );
    expect(after.code).not.toBe(0);
    expect(after.output).toContain('the rehearsal run left resources named for fss-rh-nothing behind after its teardown');
    expect(after.output).toContain(database);
    // Read three times — the first and two more — before it was called a leftover.
    expect(after.output).toContain('(1 of 3)');
    expect(after.output).toContain('(2 of 3)');
    expect(after.output).not.toContain('nothing with the production prefix was addressed');
  });

  it('passes when the tagging API stops listing the leftover by the next read, because it lags a deletion', () => {
    const stubs = mkdtempSync(join(tmpdir(), 'fss-lag-'));
    const reports = mkdtempSync(join(tmpdir(), 'fss-lag-reports-'));
    writeFileSync(join(reports, 'run-inventory.json'), '[]\n');
    const counter = join(stubs, 'reads');
    const aws = stubCommand(
      stubs,
      'aws',
      `n=$(cat '${counter}' 2>/dev/null || echo 0); echo $((n + 1)) > '${counter}'
if [ "$n" -eq 0 ]; then echo '[{"arn":"arn:aws:s3:::fss-rh-nothing-updates","name":"fss-rh-nothing-updates"}]'; else echo '[]'; fi`,
    );

    const after = runRehearsalScript(
      GUARD,
      ['fss-rh-nothing', 'after'],
      {
        FSS_REHEARSAL_REPORTS: reports,
        FSS_REHEARSAL_CALLER_IDENTITY: 'arn:aws:sts::123456789012:assumed-role/fss-rh-deploy/x',
        FSS_REHEARSAL_AWS_COMMAND: aws,
        TERRAFORM: stubCommand(stubs, 'terraform', 'echo "No state file was found!" >&2; exit 1'),
        FSS_REHEARSAL_SETTLE_SECONDS: '0',
      },
      stubs,
    );
    expect(after.code, after.output).toBe(0);
    expect(after.output).toContain('still listed; reading again');
    expect(readFileSync(counter, 'utf8').trim()).toBe('2');
  });
});

/**
 * G47, G52 and lane g97: the comparison sets aside what AWS keeps listing after a deletion.
 *
 * The production comparison of G47 and G52 learned two shapes the tagging API keeps
 * listing that are not durable: ECS tasks, which ECS forgets about an hour after they
 * stop (run 35962272085: twelve of them), and a Fargate task's network interface, which
 * goes with the task (run 36032732128). Since lane g97 the comparison is of the run's own
 * resources after its teardown, and a teardown leaves more of those shapes behind: a
 * deleted service or cluster is INACTIVE for a while, a deregistered task-definition
 * revision is INACTIVE for good, a KMS key can only be scheduled for deletion, and a
 * production database keeps its automated backups when it is deleted. Run 36209569741
 * (26 September 2026) added two more: the tagging API kept listing a deleted security
 * group and its eight rules. The same run's other finding was real — the snapshot of a
 * retained automated backup, `snapshot:rds:<prefix>-pg-<date>` — and is compared.
 *
 * ## The vacuous-pass trap
 *
 * The cheap fix is to set aside every service the teardown ever troubled, which would
 * stop measuring the database, the buckets and the network — the leftovers that cost
 * money and hold data. So the guard is run, not read, against each set-aside shape still
 * listed after the teardown (pass, counted per class), and against each durable resource
 * left behind while those shapes churn beside it (fail, naming it and nothing set aside).
 * The set-aside is by parsed service and resource type, so a bucket whose name contains
 * `task-definition` and a KMS alias are still compared. A security group is set aside
 * because a group that really stayed keeps the run's VPC alive, and the VPC is compared;
 * that is run too.
 */
describe('Appendix G 39: the run’s own comparison is between durable resources', () => {
  const ACCOUNT = '123456789012';
  const RUN = 'fss-rh-durable';
  const ecs = (resource: string): string => `arn:aws:ecs:us-east-1:${ACCOUNT}:${resource}`;
  const ec2 = (resource: string): string => `arn:aws:ec2:us-east-1:${ACCOUNT}:${resource}`;
  /** What the run's teardown leaves listed that is not a leftover. */
  const LINGERING: readonly string[] = [
    ecs(`task/${RUN}-cluster/${'a1'.repeat(16)}`),
    ecs(`service/${RUN}-cluster/${RUN}-api`),
    ecs(`cluster/${RUN}-cluster`),
    ecs(`task-definition/${RUN}-worker:1`),
    ec2('network-interface/eni-0d67a1b2c3d4e5f60'),
    `arn:aws:kms:us-east-1:${ACCOUNT}:key/0a1b2c3d-0000-0000-0000-0a1b2c3d4e5f`,
    `arn:aws:rds:us-east-1:${ACCOUNT}:auto-backup:ab-0a1b2c3d4e5f60718`,
  ];
  /** What the teardown exists to remove, every one compared. */
  const DURABLE: readonly string[] = [
    `arn:aws:rds:us-east-1:${ACCOUNT}:db:${RUN}-pg`,
    `arn:aws:rds:us-east-1:${ACCOUNT}:snapshot:${RUN}-pg-drill`,
    `arn:aws:s3:::${RUN}-suppression-journal-${ACCOUNT}`,
    `arn:aws:elasticloadbalancing:us-east-1:${ACCOUNT}:loadbalancer/app/${RUN}-alb/0a1b2c3d4e5f6071`,
    `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:/fss/${RUN}/worker`,
    `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:${RUN}/session-signing-key-AbCdEf`,
    // The automated snapshot a retained backup keeps, which run 36209569741 found.
    `arn:aws:rds:us-east-1:${ACCOUNT}:snapshot:rds:${RUN}-pg-2026-09-26-02-05`,
    ec2('vpc/vpc-0a1b2c3d4e5f60718'),
    ec2('subnet/subnet-0a1b2c3d4e5f60718'),
    `arn:aws:s3:::${RUN}-task-definition-notes`,
    `arn:aws:s3:::${RUN}-security-group-notes`,
    `arn:aws:kms:us-east-1:${ACCOUNT}:alias/${RUN}-journal`,
  ];
  /** What run 36209569741's tagging API still listed of its deleted network: one group, eight rules. */
  const DELETED_SECURITY_GROUPS: readonly string[] = [
    ec2('security-group/sg-0a1b2c3d4e5f60718'),
    ...Array.from({ length: 8 }, (_, index) => ec2(`security-group-rule/sgr-0a1b2c3d4e5f6071${index}`)),
  ];

  /** Record `before`, then compare against `after`, the way the workflow does. */
  function guardAcross(
    before: readonly string[],
    after: readonly string[],
  ): { readonly code: number; readonly output: string; readonly recorded: string } {
    const stubs = mkdtempSync(join(tmpdir(), 'fss-durable-'));
    const reports = mkdtempSync(join(tmpdir(), 'fss-durable-reports-'));
    const terraform = stubCommand(stubs, 'terraform', 'echo "No state file was found!" >&2; exit 1');
    // What the tagging API answers after `--query`: every one carries the run's Name.
    const answer = (arns: readonly string[]): string =>
      `echo '${JSON.stringify(arns.map(arn => ({ arn, name: `${RUN}-thing` })))}'`;

    const recording = runRehearsalScript(GUARD, [RUN, 'before'], {
      FSS_REHEARSAL_REPORTS: reports,
      FSS_REHEARSAL_AWS_COMMAND: stubCommand(stubs, 'aws-before', answer(before)),
      TERRAFORM: terraform,
    });
    expect(recording.code, recording.output).toBe(0);

    const comparison = runRehearsalScript(
      GUARD,
      [RUN, 'after'],
      {
        FSS_REHEARSAL_REPORTS: reports,
        FSS_REHEARSAL_CALLER_IDENTITY: `arn:aws:sts::${ACCOUNT}:assumed-role/fss-rh-deploy/x`,
        FSS_REHEARSAL_AWS_COMMAND: stubCommand(stubs, 'aws-after', answer(after)),
        TERRAFORM: terraform,
        FSS_REHEARSAL_SETTLE_READS: '0',
        FSS_REHEARSAL_SETTLE_SECONDS: '0',
      },
      stubs,
    );
    return { ...comparison, recorded: readFileSync(join(reports, 'run-inventory.json'), 'utf8') };
  }

  it('passes when the teardown’s stopped tasks, INACTIVE ECS resources, interfaces, keys and backups are still listed', () => {
    const { code, output } = guardAcross([], LINGERING);

    expect(code, output).toBe(0);
    expect(output).toContain('nothing with the production prefix was addressed');
    // Said out loud, per class, rather than silently dropped.
    expect(output).toContain(
      'set aside 4 ECS ARN(s), 1 KMS key ARN(s), 1 network interface ARN(s), 1 retained automated backup ARN(s)',
    );
  });

  it('fails on each durable resource left behind, naming it and nothing set aside', () => {
    for (const left of DURABLE) {
      const { code, output } = guardAcross([], [...LINGERING, left]);

      expect(code, `${left} left behind, and the guard passed`).not.toBe(0);
      expect(output).toContain('left resources named for fss-rh-durable behind');
      expect(output).toContain(left);
      expect(output).not.toContain(':task/');
      expect(output).not.toContain(':network-interface/');
    }
  });

  it('passes when the tagging API still lists the security groups and rules the teardown deleted (run 36209569741)', () => {
    const { code, output } = guardAcross([], DELETED_SECURITY_GROUPS);

    expect(code, output).toBe(0);
    expect(output).toContain('nothing with the production prefix was addressed');
    expect(output).toContain('set aside 1 security group ARN(s), 8 security group rule ARN(s)');
  });

  it('fails on a retained automated backup’s snapshot, naming it, while the deleted groups beside it are set aside', () => {
    // Run 36209569741 exactly: nine deleted security-group ARNs and one real leftover.
    const snapshot = `arn:aws:rds:us-east-1:${ACCOUNT}:snapshot:rds:${RUN}-pg-2026-09-26-02-05`;
    const { code, output } = guardAcross([], [...DELETED_SECURITY_GROUPS, snapshot]);

    expect(code, 'a retained automated backup was left behind, and the guard passed').not.toBe(0);
    expect(output).toContain('left resources named for fss-rh-durable behind');
    expect(output).toContain(snapshot);
    expect(output).toContain('set aside 1 security group ARN(s), 8 security group rule ARN(s)');
    expect(output).not.toContain(':security-group/');
    expect(output).not.toContain(':security-group-rule/');
    expect(output).not.toContain('nothing with the production prefix was addressed');
  });

  it('still fails when a security group really stayed, because the VPC it is in stays with it', () => {
    // The set-aside is only sound because a VPC cannot be deleted around a group of its
    // own. So the group that stayed is set aside and its VPC is what the guard names.
    const vpc = ec2('vpc/vpc-0a1b2c3d4e5f60718');
    const { code, output } = guardAcross([], [...DELETED_SECURITY_GROUPS, vpc]);

    expect(code, 'a security group and its VPC were left behind, and the guard passed').not.toBe(0);
    expect(output).toContain(vpc);
    expect(output).toContain('set aside 1 security group ARN(s), 8 security group rule ARN(s)');
  });

  it('passes a teardown run whose orphan was recorded before it, gone or not', () => {
    // A `teardown` stage records the orphan's resources first. Removing them is a pass;
    // failing to is the teardown step's own failure, not a leftover of this run.
    expect(guardAcross(DURABLE.slice(0, 3), []).code).toBe(0);
    const stuck = guardAcross(DURABLE.slice(0, 1), DURABLE.slice(0, 1));
    expect(stuck.code, stuck.output).toBe(0);
    expect(stuck.recorded).toContain(DURABLE[0]);
  });

  it('refuses a recording that is not a list of ARNs rather than comparing it', () => {
    const stubs = mkdtempSync(join(tmpdir(), 'fss-durable-bad-'));
    const reports = mkdtempSync(join(tmpdir(), 'fss-durable-bad-reports-'));
    writeFileSync(join(reports, 'run-inventory.json'), '{"not": "a list"}\n');
    const { code, output } = runRehearsalScript(
      GUARD,
      [RUN, 'after'],
      {
        FSS_REHEARSAL_REPORTS: reports,
        FSS_REHEARSAL_CALLER_IDENTITY: `arn:aws:sts::${ACCOUNT}:assumed-role/fss-rh-deploy/x`,
        FSS_REHEARSAL_AWS_COMMAND: stubCommand(stubs, 'aws', `echo '[]'`),
        TERRAFORM: stubCommand(stubs, 'terraform', 'echo "No state file was found!" >&2; exit 1'),
      },
      stubs,
    );

    expect(code).not.toBe(0);
    expect(output).toContain('recorded before the run is not a list of ARNs');
    expect(output).not.toContain('nothing with the production prefix was addressed');
  });
});

/**
 * G12h: the drill's front door to the one-off task runner. The runner's own guards are
 * run in `lib.check.ts`.
 */
describe('Appendix G 39: the refusal is symmetric, and the wrapper enforces it per launch', () => {
  /**
   * The drill's front door, run rather than read (lane g48). Run 35962272085 (24
   * September 2026) completed the point-in-time restore and was then refused at the
   * drill's first task: `rehearsal-run-task.sh` passed the restored endpoint as
   * `--database-host` as well as the override, and the definition names the primary.
   * The guard suite above calls the wrapper directly and could not see which host the
   * front door passed; this drives the front door with the root's outputs and the
   * registered definition supplied, and no credential.
   */
  function drillFrontDoor(restoredHost: string | undefined): { readonly code: number; readonly output: string } {
    const digest = `sha256:${'b'.repeat(64)}`;
    const secret = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:fss-rh-check/app-runtime-database-a';
    return runRehearsalScript(
      'infra/scripts/rehearsal-run-task.sh',
      ['fss-rh-check', 'drill', 'drill', '--', 'drill', '--reports', '/tmp/fss-drill'],
      {
        FSS_REHEARSAL_DRY_RUN: '1',
        FSS_REHEARSAL_REPORTS: mkdtempSync(join(tmpdir(), 'fss-drill-door-')),
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
        // What Terraform registered: the primary host, before any restore existed.
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
        ...(restoredHost === undefined ? {} : { FSS_RESTORED_DATABASE_HOST: restoredHost }),
      },
    );
  }

  it('launches the drill at the restored instance, with the primary as the host the definition is checked against', () => {
    const { code, output } = drillFrontDoor('fss-rh-check-pg-restored.example');

    expect(code, output).toBe(0);
    expect(output).not.toContain('this task would connect to');
    // The container is pointed at the restored endpoint, and the log says so.
    expect(output).toContain('drill: target database host fss-rh-check-pg-restored.example');
    expect(output).toContain('{"name": "FSS_DATABASE_HOST", "value": "fss-rh-check-pg-restored.example"}');
  });

  it('launches an ordinary step at the primary when there is no restored instance', () => {
    const { code, output } = drillFrontDoor(undefined);

    expect(code, output).toBe(0);
    expect(output).toContain('drill: target database host fss-rh-check-pg.example');
    expect(output).not.toContain('FSS_DATABASE_HOST');
  });

});
