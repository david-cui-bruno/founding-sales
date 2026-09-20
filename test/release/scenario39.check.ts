import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mustBeRehearsed, readRepositoryFile, repositoryPath } from './support/coverage.ts';

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

describe('Appendix G 39: the two roots cannot address each other', () => {
  mustBeRehearsed(39);

  it('pins two different state-key prefixes, and the gate compares them', () => {
    const keyOf = (backend: string): string => {
      const line = backend.split('\n').find(row => row.trimStart().startsWith('key '));
      return (line ?? '').split('"')[1] ?? '';
    };
    const production = keyOf(readRepositoryFile('infra/roots/production/backend.hcl'));
    const rehearsal = keyOf(readRepositoryFile('infra/roots/rehearsal/backend.hcl'));

    expect(production).toBe('fss/greenfield/production/terraform.tfstate');
    expect(rehearsal.startsWith('fss/greenfield/rehearsal/')).toBe(true);
    expect(rehearsal).not.toBe(production);

    // The comparison is in the gate rather than only here, so a hand-run of the
    // offline gate catches it too.
    const gate = readRepositoryFile('infra/scripts/offline-gate.sh');
    expect(gate).toContain('if [ "$production_key" = "$rehearsal_key" ]; then');
    expect(gate).toContain('fss/greenfield/production/*');
    expect(gate).toContain('fss/greenfield/rehearsal/*');
  });

  it('gives the durable rehearsal repositories a third state key, outside the per-run space', () => {
    const keyOf = (backend: string): string => {
      const line = backend.split('\n').find(row => row.trimStart().startsWith('key '));
      return (line ?? '').split('"')[1] ?? '';
    };
    const registry = keyOf(readRepositoryFile('infra/roots/rehearsal-registry/backend.hcl'));

    // `registry` is a legal run suffix (`fss-rh-registry`), so a state key under
    // fss/greenfield/rehearsal/ could be claimed by a run and destroyed on teardown,
    // taking every image past releases were rehearsed on.
    expect(registry).toBe('fss/greenfield/rehearsal-registry/terraform.tfstate');
    expect(registry.startsWith('fss/greenfield/rehearsal/')).toBe(false);

    const gate = readRepositoryFile('infra/scripts/offline-gate.sh');
    expect(gate).toContain('rehearsal_registry_key');
    expect(gate).toContain('the rehearsal registry state key is inside the per-run space');
    // And the per-run root creates no repository of its own.
    expect(gate).toContain('create_registry = false');
    expect(readRepositoryFile('infra/roots/rehearsal/main.tf')).toContain('create_registry = false');
  });

  it('treats the two stable repositories as rehearsal resources, not as production ones', () => {
    const common = readRepositoryFile('infra/scripts/rehearsal-common.sh');
    const guard = readRepositoryFile('infra/scripts/rehearsal-prefix-guard.sh');

    // They are the only fss-rh- names a guard sees that do not contain the run, so a
    // guard reasoning "not mine, therefore production's" would fail this scenario for
    // the wrong reason. The classifier says which of the four they are.
    expect(common).toContain("REHEARSAL_STABLE_NAMES='fss-rh-api fss-rh-worker'");
    expect(common).toContain('rehearsal_classify_name()');
    expect(common).toContain('rehearsal-stable');

    // And it is exercised rather than described: the after phase classifies the run's
    // own name, both stable names, a production name and another run's name, and the
    // dry run reaches all of it without a credential.
    expect(guard).toContain('rehearsal_classify_name "$PREFIX"');
    expect(guard).toContain('the name classifier accepted a production resource');
    expect(guard).toContain("the name classifier accepted another run's resource");
    expect(guard).toContain('stable_repositories=rehearsal');
  });

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

  it('makes each root refuse the other’s namespace rather than merely avoid it', () => {
    const production = readRepositoryFile('infra/roots/production/tests/isolation.tftest.hcl');
    const rehearsal = readRepositoryFile('infra/roots/rehearsal/tests/isolation.tftest.hcl');

    expect(production).toContain('output.name_prefix == "fss-prod"');
    expect(production).toContain('output.deployment_role_name == "fss-prod-deploy"');
    expect(production).toContain('run "a_rehearsal_prefix_is_refused"');
    expect(production).toContain('expect_failures');

    expect(rehearsal).toContain('startswith(output.name_prefix, "fss-rh-")');
    expect(rehearsal).toContain('run "the_production_prefix_is_refused"');
    // A prefix that merely looks like production's is refused too, which is the
    // difference between a rule and a string comparison somebody got lucky with.
    expect(rehearsal).toContain('run "a_prefix_that_merely_starts_like_production_is_refused"');
    expect(rehearsal).toContain('expect_failures');
  });
});

/**
 * G12d: the third root's one apply is a workflow run, not a command in a terminal.
 *
 * `fss-rh-deploy` trusts the GitHub OIDC provider and the subject
 * `repo:david-cui-bruno/founding-sales:environment:rehearsal`, and nothing else —
 * which is Appendix G 39's "distinct roles" clause taken seriously. The operator
 * tried `terraform apply` in `infra/roots/rehearsal-registry` and was refused
 * `sts:AssumeRole`. That refusal is the design working, so the apply moves to a
 * workflow that runs in that environment rather than the trust policy moving to
 * admit a laptop.
 *
 * ## The vacuous-pass trap
 *
 * A workflow that declares the environment and then applies whatever Terraform
 * proposes has moved the credential without moving the judgement: nobody reads the
 * plan, because nobody can — the plan exists only inside a run. Asserting the
 * workflow's text would pass against a guard that approves everything. Closed by
 * running the guard against fabricated plans, one acceptable and four not, and
 * requiring the refusals; and by requiring the default run to be plan-only, so the
 * apply is a second dispatch a person makes after reading a summary.
 */

const REGISTRY_WORKFLOW_PATH = '.github/workflows/greenfield-rehearsal-registry.yml';
const REGISTRY_GUARD_PATH = 'infra/scripts/rehearsal-registry-guard.sh';

/** One entry of `terraform show -json`'s `resource_changes`. */
function planned(
  address: string,
  type: string,
  actions: readonly string[],
  after: Readonly<Record<string, string>>,
): Readonly<Record<string, unknown>> {
  return {
    address,
    module_address: address.startsWith('module.registry.') ? 'module.registry' : '',
    mode: 'managed',
    type,
    name: 'this',
    change: { actions, before: null, after },
  };
}

/** The plan `infra/roots/rehearsal-registry` produces on the one apply. */
function goodPlan(): Readonly<Record<string, unknown>> {
  return {
    format_version: '1.2',
    resource_changes: [
      planned('module.registry.aws_ecr_repository.this["api"]', 'aws_ecr_repository', ['create'], {
        name: 'fss-rh-api',
      }),
      planned('module.registry.aws_ecr_repository.this["worker"]', 'aws_ecr_repository', ['create'], {
        name: 'fss-rh-worker',
      }),
      planned('module.registry.aws_ecr_lifecycle_policy.this["api"]', 'aws_ecr_lifecycle_policy', ['create'], {
        repository: 'fss-rh-api',
      }),
      planned('module.registry.aws_ecr_lifecycle_policy.this["worker"]', 'aws_ecr_lifecycle_policy', ['create'], {
        repository: 'fss-rh-worker',
      }),
    ],
  };
}

function runGuard(plan: unknown): { readonly accepted: boolean; readonly output: string } {
  const directory = mkdtempSync(join(tmpdir(), 'fss-registry-plan-'));
  const file = join(directory, 'plan.json');
  writeFileSync(file, JSON.stringify(plan));
  try {
    return {
      accepted: true,
      output: execFileSync(repositoryPath(REGISTRY_GUARD_PATH), ['plan', file], {
        env: { ...process.env, FSS_REHEARSAL_REPORTS: directory },
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { accepted: false, output: `${failure.stdout ?? ''}\n${failure.stderr ?? ''}` };
  }
}

describe('Appendix G 39: the rehearsal registry is applied by a workflow, never from a laptop', () => {
  const workflow = readRepositoryFile(REGISTRY_WORKFLOW_PATH);
  const release = readRepositoryFile('.github/workflows/greenfield-release.yml');

  it('is dispatch-only, so nothing a push or a pull request does can reach the role', () => {
    const triggers = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\npermissions:'));

    expect(triggers).toContain('workflow_dispatch:');
    expect(triggers).not.toContain('pull_request');
    expect(triggers).not.toContain('push:');
    expect(triggers).not.toContain('schedule:');
    expect(triggers).not.toContain('workflow_call');
  });

  it('declares the rehearsal environment, which is the only subject the role trusts', () => {
    expect(workflow).toContain('environment: rehearsal');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('role-to-assume: ${{ secrets.FSS_REHEARSAL_ROLE_ARN }}');
    // And it checks what it got, because an environment pointed at another role is a
    // configuration mistake no plan would catch.
    expect(workflow).toContain('is not an fss-rh- role');
  });

  it('references every action by the same commit sha the release workflow pins', () => {
    const references = [...workflow.matchAll(/uses:\s*(\S+)/gu)].map(match => match[1] ?? '');

    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(reference, reference).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/u);
      // The same pin, not merely a pin: two files pinning different commits of
      // configure-aws-credentials is two different credential paths.
      expect(release, reference).toContain(reference);
    }
    const version = /TERRAFORM_VERSION: '([\d.]+)'/u.exec(workflow)?.[1];
    expect(version).toBe(/TERRAFORM_VERSION: '([\d.]+)'/u.exec(release)?.[1]);
  });

  it('initializes the backend the runbook names, and the key that is not a run’s', () => {
    expect(workflow).toContain('infra/roots/rehearsal-registry');
    expect(workflow).toContain('callie-sourcing-tfstate-326255650484');
    expect(workflow).toContain('callie-sourcing-tflock');
    expect(workflow).toContain('fss/greenfield/rehearsal-registry/terraform.tfstate');
    expect(workflow).toContain('FSS_REHEARSAL_STATE_KMS_KEY_ARN');
  });

  it('defaults to plan-only, and the guard runs before the apply rather than beside it', () => {
    expect(workflow).toMatch(/apply:\s*\n\s+description:[^\n]*\n\s+required: false\n\s+type: boolean\n\s+default: false/u);

    const guardAt = workflow.indexOf('rehearsal-registry-guard.sh plan');
    const applyAt = workflow.indexOf('apply -input=false');
    expect(guardAt).toBeGreaterThan(-1);
    expect(applyAt).toBeGreaterThan(guardAt);
    // The apply step and the final read-back are both conditional on the input, so
    // the run an operator makes first cannot change anything.
    expect(workflow).toContain("if: ${{ inputs.apply }}");
    expect(workflow).toContain('aws ecr describe-repositories --repository-names fss-rh-api fss-rh-worker');
  });

  it('is what the runbook tells the operator to do, instead of a command that is refused', () => {
    const runbook = readRepositoryFile('docs/greenfield/infra-apply-runbook.md');
    const releaseDoc = readRepositoryFile('docs/greenfield/release.md');

    // The instruction that sent the operator at `sts:AssumeRole` was a local
    // `terraform apply` in this root. It must not still be there.
    const section = runbook.slice(
      runbook.indexOf('### 2.1 The rehearsal repositories'),
      runbook.indexOf('### 2.2 The production repositories'),
    );
    expect(section).toContain('Greenfield rehearsal registry apply');
    expect(section).toContain('You never assume `fss-rh-deploy`');
    expect(section).not.toMatch(/^terraform apply/mu);
    // And the one thing a reader needs when init is refused: the exact objects.
    expect(section).toContain('arn:aws:s3:::callie-sourcing-tfstate-326255650484/fss/greenfield/rehearsal-registry/terraform.tfstate');
    expect(section).toContain('arn:aws:dynamodb:us-east-1:326255650484:table/callie-sourcing-tflock');

    expect(releaseDoc).toContain('FSS_REHEARSAL_STATE_KMS_KEY_ARN');
  });

  it('has a shell block in every step that bash can parse', () => {
    // A dispatch-only workflow is never run by accident, which means a syntax error
    // in it is discovered on the one run that costs something. `bash -n` here is the
    // cheapest possible substitute for the run nobody can make.
    const require = createRequire(import.meta.url);
    const yaml = createRequire(require.resolve('eslint/package.json'))('js-yaml') as {
      load: (source: string) => unknown;
    };
    const parsed = yaml.load(workflow) as { jobs: Record<string, { steps: { run?: string }[] }> };
    const scripts = Object.values(parsed.jobs)
      .flatMap(job => job.steps)
      .map(step => step.run)
      .filter((run): run is string => typeof run === 'string');

    expect(scripts.length).toBeGreaterThan(4);
    for (const script of scripts) {
      const parse = spawnSync('/bin/bash', ['-n'], {
        input: script.replace(/\$\{\{[^}]+\}\}/gu, 'fixture'),
        encoding: 'utf8',
      });
      expect(parse.status, `${script.slice(0, 80)}\n${parse.stderr}`).toBe(0);
    }
  });

  it('prints the plan of its own commands in the release dry run, on every pull request', () => {
    expect(release).toContain(REGISTRY_WORKFLOW_PATH);
    expect(release).toContain(`${REGISTRY_GUARD_PATH} commands`);

    // And the printed plan is the workflow's commands rather than a description of
    // them: every command the guard prints has to appear in the file that runs it.
    const printed = execFileSync(repositoryPath(REGISTRY_GUARD_PATH), ['commands'], {
      env: { ...process.env, FSS_REHEARSAL_DRY_RUN: '1' },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const commands = printed
      .split('\n')
      .filter(line => line.startsWith('PLAN '))
      .map(line => (line.slice('PLAN '.length).split(/\s+[<#]/u)[0] ?? '').trim());

    expect(commands.length).toBe(6);
    for (const command of commands) expect(workflow, command).toContain(command);
  });
});

describe('Appendix G 39: the plan guard is what reads the plan nobody can read', () => {
  it('accepts the plan this root actually produces', () => {
    const { accepted, output } = runGuard(goodPlan());

    expect(output).toContain('create=4');
    expect(output).toContain('destroy=0');
    expect(accepted).toBe(true);
  });

  it('refuses a plan that destroys or replaces anything', () => {
    const plan = goodPlan();
    const changes = [...(plan['resource_changes'] as readonly unknown[])];
    changes[0] = planned('module.registry.aws_ecr_repository.this["api"]', 'aws_ecr_repository', ['delete', 'create'], {
      name: 'fss-rh-api',
    });
    const { accepted, output } = runGuard({ ...plan, resource_changes: changes });

    // `force_delete = false` stops a destroy of a repository that holds images; it
    // does not stop a replacement, which is the same deletion wearing a create.
    expect(accepted).toBe(false);
    expect(output).toContain('would be destroyed or replaced');
  });

  it('refuses a resource type this root does not create', () => {
    const plan = goodPlan();
    const changes = [
      ...(plan['resource_changes'] as readonly unknown[]),
      planned('module.registry.aws_ecr_repository_policy.this["api"]', 'aws_ecr_repository_policy', ['create'], {
        repository: 'fss-rh-api',
      }),
    ];
    const { accepted, output } = runGuard({ ...plan, resource_changes: changes });

    expect(accepted).toBe(false);
    expect(output).toContain('aws_ecr_repository_policy');
  });

  it('refuses a name outside the rehearsal namespace', () => {
    const plan = goodPlan();
    const changes = [...(plan['resource_changes'] as readonly unknown[])];
    changes[1] = planned('module.registry.aws_ecr_repository.this["worker"]', 'aws_ecr_repository', ['create'], {
      name: 'fss-prod-worker',
    });
    const { accepted, output } = runGuard({ ...plan, resource_changes: changes });

    expect(accepted).toBe(false);
    expect(output).toContain('fss-prod-worker');
  });

  it('refuses a resource it cannot name, rather than assuming it is one of the four', () => {
    const plan = goodPlan();
    const changes = [
      ...(plan['resource_changes'] as readonly unknown[]),
      planned('aws_ecr_repository.loose', 'aws_ecr_repository', ['create'], {}),
    ];
    const { accepted, output } = runGuard({ ...plan, resource_changes: changes });

    expect(accepted).toBe(false);
    expect(output).toContain('no readable name');
  });

  it('refuses a plan file that is not there, which is the shape a skipped step takes', () => {
    let refused = false;
    try {
      execFileSync(repositoryPath(REGISTRY_GUARD_PATH), ['plan', join(tmpdir(), 'fss-no-such-plan.json')], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });
});
