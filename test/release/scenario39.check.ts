import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mustBeRehearsed, readRepositoryFile, repositoryPath } from './support/coverage.ts';
import {
  REHEARSAL_STAGES,
  REHEARSAL_STAGE_CHOICES,
  ladderStagesForCondition,
  embeddedPythonProgram,
  rehearsalJobSteps,
  stagesForCondition,
  stepScript,
  stepsForStage,
} from './support/releaseWorkflow.ts';

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
    // configuration mistake no plan would catch — and since G12e the plan runs with
    // the assumption turned off, so this session is what the apply acts as.
    expect(workflow).toContain('infra/scripts/rehearsal-caller-identity.sh fss-rh-deploy');
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
    expect(workflow).toContain('fss/greenfield/rehearsal-registry/terraform.tfstate');
    expect(workflow).toContain('FSS_REHEARSAL_STATE_KMS_KEY_ARN');

    // The bucket and the lock table are per-account values and are no longer written
    // here: G27 made the tree able to run in a dedicated AWS account, so the workflow
    // reads them out of the root's own `backend.hcl` — the per-account backend file —
    // and the state key, which names a root rather than an account, is the one it
    // states and checks. Two copies of an account-specific value is how they come to
    // disagree. `docs/greenfield/accounts.md`, `test/release/accountAgnostic.check.ts`.
    const backend = readRepositoryFile('infra/roots/rehearsal-registry/backend.hcl');
    expect(backend).toContain('callie-sourcing-tfstate-326255650484');
    expect(backend).toContain('callie-sourcing-tflock');
    expect(workflow).toContain("grep -E '^bucket ' infra/roots/rehearsal-registry/backend.hcl");
    expect(workflow).toContain("grep -E '^dynamodb_table ' infra/roots/rehearsal-registry/backend.hcl");
    expect(workflow).not.toContain('callie-sourcing-tfstate-326255650484');
    expect(workflow).not.toContain('callie-sourcing-tflock');
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

    expect(commands.length).toBe(7);
    for (const command of commands) expect(workflow, command).toContain(command);
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
 * the flag's presence would pass against exactly that workflow. Closed by requiring
 * the caller-identity check to appear *before* the flag is used, and by running that
 * check against six identities offline: a user, a role whose name merely starts the
 * same way, a different rehearsal role, an ARN with no session, no identity at all,
 * and the one it must accept.
 */
describe('Appendix G 39: the flag that stops the second assumption cannot become an ambient credential', () => {
  const release = readRepositoryFile('.github/workflows/greenfield-release.yml');
  const registry = readRepositoryFile(REGISTRY_WORKFLOW_PATH);
  const teardown = readRepositoryFile('infra/scripts/rehearsal-teardown.sh');
  const roots = ['production', 'rehearsal', 'rehearsal-registry'] as const;

  it('gives every root the variable, defaulting to assuming the role', () => {
    for (const root of roots) {
      const variables = readRepositoryFile(`infra/roots/${root}/variables.tf`);
      const providers = readRepositoryFile(`infra/roots/${root}/providers.tf`);

      // The default is true in all three, so a caller who forgets the flag is refused
      // at STS rather than acting as whatever credential the shell was holding.
      expect(variables, root).toMatch(/variable "assume_deployment_role" \{[\s\S]*?default {5}= true\n\}/u);
      // And the block is conditional rather than absent: turning the flag off must
      // not be the only way to configure the provider.
      expect(providers, root).toContain('dynamic "assume_role"');
      expect(providers, root).toContain('for_each = var.assume_deployment_role ? [1] : []');
      expect(providers, root).toContain(
        'role_arn     = "arn:aws:iam::${var.aws_account_id}:role/${var.deployment_role_name}"',
      );
      // The namespace validations G1 and G12c wrote are untouched by this.
      expect(variables, root).toContain('variable "deployment_role_name"');
      expect(variables, root).toContain('validation {');
    }
  });

  it('passes the flag in exactly the places whose session already holds the role', () => {
    // The two rehearsal roots, never production: section 3.2's apply is David's user
    // assuming `fss-prod-deploy`, and there is nothing in this repository that runs it.
    expect(release).toContain('-var="assume_deployment_role=false"');
    expect(registry).toContain('-var=assume_deployment_role=false');
    expect(teardown).toContain('"$REHEARSAL_NO_ASSUME_VAR"');
    expect(readRepositoryFile('infra/scripts/rehearsal-common.sh')).toContain(
      "REHEARSAL_NO_ASSUME_VAR='-var=assume_deployment_role=false'",
    );
  });

  it('names the principal before it uses the flag, in both workflows and in the teardown', () => {
    // By line, and only lines that are commands: both files explain the flag in a
    // comment above the step that runs it, and a prose mention must not be able to
    // satisfy an ordering assertion about commands.
    const commandLine = (workflow: string, match: (line: string) => boolean): number =>
      workflow.split('\n').findIndex(line => !line.trimStart().startsWith('#') && match(line));

    // Only the credentialed job of the release workflow: the dry-run job runs the
    // check too, and an ordering assertion satisfied by the job that holds no
    // credential would say nothing about the job that does.
    const credentialedJob = release.slice(release.indexOf('\n  rehearsal:\n'));
    expect(credentialedJob.length).toBeGreaterThan(1000);

    for (const [name, workflow] of [
      ['release', credentialedJob],
      ['registry', registry],
    ] as const) {
      const checkAt = commandLine(workflow, line =>
        line.includes('infra/scripts/rehearsal-caller-identity.sh fss-rh-deploy'),
      );
      const flagAt = commandLine(workflow, line => line.includes('assume_deployment_role=false'));
      expect(checkAt, name).toBeGreaterThan(-1);
      expect(flagAt, name).toBeGreaterThan(checkAt);
    }

    // The teardown runs on `always()`, including after a failure, so it repeats the
    // check rather than trusting a step that may not have been reached.
    const checkAt = teardown.indexOf('rehearsal_require_deployment_session');
    const destroyAt = teardown.indexOf('rehearsal_terraform destroy');
    expect(checkAt).toBeGreaterThan(-1);
    expect(destroyAt).toBeGreaterThan(checkAt);
  });

  it('runs the check rather than describing it: one identity accepted, five refused', () => {
    const judge = (identity: string, role?: string): boolean => {
      try {
        execFileSync(repositoryPath('infra/scripts/rehearsal-caller-identity.sh'), role === undefined ? [] : [role], {
          // Supplied rather than fetched: this makes no AWS call, which is also how
          // the release workflow's credential-free dry run exercises it.
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

  it('is what the runbook and the release document tell the operator', () => {
    const runbook = readRepositoryFile('docs/greenfield/infra-apply-runbook.md');
    const releaseDoc = readRepositoryFile('docs/greenfield/release.md');
    const decision = readRepositoryFile('docs/decisions/g12e-the-provider-does-not-reassume-its-own-session.md');
    const g12d = readRepositoryFile('docs/decisions/g12d-the-once-only-registry-apply-is-a-workflow.md');

    // Local applies keep the default; the flag is CI's.
    expect(runbook).toContain('assume_deployment_role');
    expect(runbook).toContain('rehearsal-caller-identity.sh');
    expect(releaseDoc).toContain('assume_deployment_role');

    // The provider version this rests on is named, because the behaviour is the
    // provider's rather than Terraform's.
    expect(decision).toContain('5.100.0');
    expect(decision).toContain('assume_role');

    // G12d predicted this failure and could not answer it. The runbook no longer
    // tells the operator to widen a trust policy.
    expect(runbook).not.toContain('allowing `arn:aws:iam::326255650484:role/fss-rh-deploy` to assume itself');
    expect(g12d).toContain('g12e');
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

/**
 * G12f: the guard refused the rehearsal's own production-inventory read.
 *
 * Appendix G 39's last clause is measured rather than asserted: the guard records the
 * production inventory before the run and compares it afterwards, so "teardown could
 * not address production" is a diff rather than a claim. That read names production,
 * and `rehearsal_refuse_production_arguments` refuses every argument that names
 * production — so the first credentialed rehearsal (Actions 35548888865) refused
 * itself at step 3 with
 *
 *   FAIL: a rehearsal command names a production resource: Key=Name,Values=fss-prod*
 *
 * and created nothing at all.
 *
 * ## The vacuous-pass trap
 *
 * The cheap fix is an exception for the string, and it is the wrong one twice over: a
 * substring exception would let a `delete-db-instance` wearing the same filter through,
 * and asserting that the guard "has an exception" would pass against a guard that had
 * stopped refusing anything. Closed by making the exemption a function — one caller,
 * one read-only operation checked against a list, no caller-supplied arguments — and by
 * running the guard against every neighbouring case rather than reading it: the read is
 * accepted, the same query anywhere else is refused, a mutating command naming
 * production is refused, and a mutating command *claiming the exemption* is refused.
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

describe('Appendix G 39: the production-name guard exempts one read-only inventory query', () => {
  it('accepts the inventory read, and marks the line of the plan that claimed the exemption', () => {
    const { code, output } = inCommon(
      'FSS_REHEARSAL_DRY_RUN=1 rehearsal_read_production_inventory resourcegroupstaggingapi get-resources',
    );

    expect(code).toBe(0);
    expect(output).toContain('resourcegroupstaggingapi get-resources');
    expect(output).toContain('exempt-read-only-production-inventory');
  });

  it('refuses the same query issued through the ordinary wrapper', () => {
    // The exemption is a caller, not a string. This is the exact command the first
    // credentialed run made, and it must still be refused everywhere else.
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

  it('refuses a mutating verb from inside the exemption itself', () => {
    // The read-only constraint is a check over the operation, not a property of the
    // one literal written in the guard, so it can be violated and must then refuse.
    const { output } = inCommon(
      'FSS_REHEARSAL_DRY_RUN=1 rehearsal_read_production_inventory rds delete-db-instance\necho "rc=$?"',
    );

    expect(output).toContain('may only issue [resourcegroupstaggingapi:get-resources]');
    expect(output).toContain('rc=1');
  });

  it('refuses arguments handed to the exemption, so no caller can push a name through it', () => {
    const { output } = inCommon(
      `FSS_REHEARSAL_DRY_RUN=1 rehearsal_read_production_inventory resourcegroupstaggingapi get-resources --tag-filters '${PRODUCTION_FILTER}'\necho "rc=$?"`,
    );

    expect(output).toContain('takes no further arguments');
    expect(output).toContain('rc=1');
  });

  it('selects the production names locally, sorted, because the tag filter cannot do it', () => {
    // `get-resources` tag-filter values are exact matches: `Values=fss-prod*` matches
    // nothing, which would have made the before/after comparison a comparison of two
    // empty lists. And the API promises no order, so an unsorted answer would fail the
    // comparison for no reason.
    const rows = JSON.stringify([
      { arn: 'arn:aws:s3:::fss-prod-journal', name: 'fss-prod-journal' },
      { arn: 'arn:aws:rds:us-east-1:1:db:fss-prod-pg', name: 'fss-prod-pg' },
      { arn: 'arn:aws:s3:::somebody-elses', name: 'other' },
    ]);
    const { code, output } = inCommon(`printf '%s' '${rows}' | rehearsal_select_production_names`);

    expect(code).toBe(0);
    expect(JSON.parse(output)).toEqual([
      'arn:aws:rds:us-east-1:1:db:fss-prod-pg',
      'arn:aws:s3:::fss-prod-journal',
    ]);
  });

  it('records a sentinel in dry mode, and the after phase refuses to compare against it', () => {
    const reports = mkdtempSync(join(tmpdir(), 'fss-inventory-'));
    const before = runRehearsalScript(GUARD, ['fss-rh-dryrun', 'before'], {
      FSS_REHEARSAL_DRY_RUN: '1',
      FSS_REHEARSAL_REPORTS: reports,
    });
    expect(before.code).toBe(0);
    expect(readFileSync(join(reports, 'production-inventory.json'), 'utf8')).toContain(
      'dry-run: no production inventory was read',
    );

    // The workflow runs the `before` phase in dry mode when it decides the prefix. If
    // the real one never ran, comparing production against that file would be a pass
    // by construction.
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

describe('Appendix G 39: the dry run reads the plan it printed, so the rehearsal cannot refuse itself', () => {
  const release = readRepositoryFile('.github/workflows/greenfield-release.yml');

  it('accepts the plan the dry run actually prints today', () => {
    // Generated rather than fabricated: this is the same sequence the workflow runs,
    // so a step that acquires a production-named command fails here on the pull
    // request that adds it.
    const reports = mkdtempSync(join(tmpdir(), 'fss-planrun-'));
    const environment = {
      FSS_REHEARSAL_DRY_RUN: '1',
      FSS_REHEARSAL_REPORTS: reports,
      FSS_CARRY_WATERMARK: '2026-09-21T00:00:00Z',
      FSS_CARRY_SOURCE_TABLE: 'rehearsal-old-table',
    };
    const steps: readonly (readonly [string, readonly string[]])[] = [
      ['infra/scripts/rehearsal-caller-identity.sh', ['fss-rh-deploy']],
      [GUARD, ['fss-rh-dryrun', 'before']],
      ['infra/scripts/rehearsal-schema-ranges.sh', ['fss-rh-dryrun']],
      ['infra/scripts/rehearsal-restore-drill.sh', ['fss-rh-dryrun']],
      ['infra/scripts/rehearsal-carry-watermark.sh', ['fss-rh-dryrun']],
      ['infra/scripts/rehearsal-teardown.sh', ['fss-rh-dryrun']],
      [GUARD, ['fss-rh-dryrun', 'after']],
    ];
    let printed = '';
    for (const [script, args] of steps) {
      const step = runRehearsalScript(script, args, environment);
      expect(step.code, `${script} ${args.join(' ')}\n${step.output}`).toBe(0);
      printed += step.output;
    }
    // The read is in the plan at all — before this lane it was invisible offline,
    // which is why nothing caught it until a credential was spent.
    expect(printed).toContain('exempt-read-only-production-inventory');

    const directory = mkdtempSync(join(tmpdir(), 'fss-plan-'));
    const path = join(directory, 'plan.txt');
    writeFileSync(path, printed);
    const guard = runRehearsalScript(GUARD, ['fss-rh-dryrun', 'plan', path], {});
    expect(guard.code, guard.output).toBe(0);
    expect(guard.output).toContain('no other planned command names production');
  });

  it('refuses the plan this rehearsal printed before the exemption existed', () => {
    // The literal command of Actions run 35548888865. Red on the pull request now.
    const guard = runRehearsalScript(
      GUARD,
      [
        'fss-rh-dryrun',
        'plan',
        planFile(
          `PLAN aws resourcegroupstaggingapi get-resources --tag-filters ${PRODUCTION_FILTER} --query 'ResourceTagMappingList[].ResourceARN' --output json`,
        ),
      ],
      {},
    );

    expect(guard.code).not.toBe(0);
    expect(guard.output).toContain('a rehearsal command names a production resource');
  });

  it('refuses an unmarked production command standing beside a legitimate read', () => {
    // The refusal that the "no inventory read" case cannot distinguish: a plan with the
    // exempt read in it and one other command naming production. Without this, a guard
    // that counted the read and ignored everything else would look identical.
    const guard = runRehearsalScript(
      GUARD,
      [
        'fss-rh-dryrun',
        'plan',
        planFile(
          'PLAN aws resourcegroupstaggingapi get-resources --tag-filters Key=Name --output json | select names beginning fss-prod # exempt-read-only-production-inventory',
          'PLAN terraform destroy -var=name_prefix=fss-prod',
        ),
      ],
      {},
    );

    expect(guard.code).not.toBe(0);
    expect(guard.output).toContain('a rehearsal command names a production resource');
    expect(guard.output).toContain("would be refused by the rehearsal's own guard");
  });

  it('refuses a mutating command that wears the exemption marker', () => {
    const guard = runRehearsalScript(
      GUARD,
      [
        'fss-rh-dryrun',
        'plan',
        planFile(
          'PLAN aws rds delete-db-instance --db-instance-identifier fss-prod-pg # exempt-read-only-production-inventory',
        ),
      ],
      {},
    );

    expect(guard.code).not.toBe(0);
    expect(guard.output).toContain('claims the inventory exemption without being the inventory read');
  });

  it('refuses a plan with no inventory read at all, which is the shape of a silent deletion', () => {
    const guard = runRehearsalScript(
      GUARD,
      ['fss-rh-dryrun', 'plan', planFile('PLAN terraform destroy -var=name_prefix=fss-rh-dryrun')],
      {},
    );

    expect(guard.code).not.toBe(0);
    expect(guard.output).toContain('the plan contains no production-inventory read');
  });

  it('refuses a plan file that is not there, which is the shape of a step that did not run', () => {
    const guard = runRehearsalScript(GUARD, ['fss-rh-dryrun', 'plan', join(tmpdir(), 'fss-no-plan.txt')], {});
    expect(guard.code).not.toBe(0);
  });

  it('is written down where the next operator will look for it', () => {
    const decision = readRepositoryFile(
      'docs/decisions/g12f-the-rehearsals-own-guard-refused-the-rehearsal.md',
    );
    const releaseDoc = readRepositoryFile('docs/greenfield/release.md');
    const g12 = readRepositoryFile('docs/decisions/g12-what-the-rehearsal-cannot-prove.md');

    // The run, so the claim can be checked against the log rather than believed.
    expect(decision).toContain('35548888865');
    expect(decision).toContain('rehearsal_read_production_inventory');
    expect(releaseDoc).toContain('rehearsal_read_production_inventory');
    // Section 8 separates what the first run proved from what it refuted; the old
    // section said the rehearsal had never run at all.
    expect(releaseDoc).toContain('What the first credentialed run proved, and what it refuted');
    expect(releaseDoc).toContain('arn:aws:sts::326255650484:assumed-role/fss-rh-deploy/');
    // And the paragraph that claimed this scenario was proved in rehearsal is corrected
    // where a reader of that document will meet it.
    expect(g12).toContain('g12f-the-rehearsals-own-guard-refused-the-rehearsal.md');
  });

  it('is run by the credential-free job on every pull request, after the plan is printed', () => {
    const dryRunJob = release.slice(release.indexOf('\n  dry-run:\n'), release.indexOf('\n  rehearsal:\n'));
    const printedAt = dryRunJob.indexOf('Print the plan every rehearsal step would run');
    const guardAt = dryRunJob.indexOf(`${GUARD} fss-rh-dryrun plan`);

    expect(printedAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(printedAt);
    // And the job that runs it holds no credential, which is the whole point.
    expect(dryRunJob).not.toContain('environment: rehearsal');
    expect(dryRunJob).toContain('The rehearsal dry run is offline and must never hold a cloud credential');
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

  it('still measures the production inventory afterwards when nothing was created', () => {
    // The deliverable of the scenario, and the thing that was lost when the teardown
    // stopped at its first step: the comparison has to run, and pass, on the run that
    // created nothing.
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
    expect(readFileSync(join(reports, 'production-inventory.json'), 'utf8')).toContain('fss-prod-journal');

    const after = runRehearsalScript(GUARD, ['fss-rh-nothing', 'after'], environment, stubs);
    expect(after.code, after.output).toBe(0);
    expect(after.output).toContain('nothing with the production prefix was addressed');
    expect(readFileSync(join(reports, 'prefix-guard.txt'), 'utf8')).toContain('state_read=false');
  });

  it('fails the comparison when production changed, so the pass above is not free', () => {
    const stubs = mkdtempSync(join(tmpdir(), 'fss-changed-'));
    const reports = mkdtempSync(join(tmpdir(), 'fss-changed-reports-'));
    const terraform = stubCommand(stubs, 'terraform', 'echo "No state file was found!" >&2; exit 1');

    const before = runRehearsalScript(GUARD, ['fss-rh-nothing', 'before'], {
      FSS_REHEARSAL_REPORTS: reports,
      FSS_REHEARSAL_AWS_COMMAND: stubCommand(stubs, 'aws-before', `echo '[{"arn":"arn:a","name":"fss-prod-a"}]'`),
      TERRAFORM: terraform,
    });
    expect(before.code, before.output).toBe(0);

    const after = runRehearsalScript(
      GUARD,
      ['fss-rh-nothing', 'after'],
      {
        FSS_REHEARSAL_REPORTS: reports,
        FSS_REHEARSAL_CALLER_IDENTITY: 'arn:aws:sts::123456789012:assumed-role/fss-rh-deploy/x',
        FSS_REHEARSAL_AWS_COMMAND: stubCommand(stubs, 'aws-after', `echo '[]'`),
        TERRAFORM: terraform,
      },
      stubs,
    );
    expect(after.code).not.toBe(0);
    expect(after.output).toContain('the production inventory changed during the rehearsal run');
  });
});

/**
 * G12h: the same clause read from the other direction, and the wrapper that makes it
 * true at the moment a task is launched.
 *
 * Until 21 September every rehearsal script refused an argument naming `fss-prod` and
 * nothing refused the reverse, because nothing in this repository ran against
 * production. `infra/scripts/release-deploy.sh` does: it is one code path for the
 * rehearsal in CI and for David's local production deploy, so a production command
 * that picked up a rehearsal ARN from a stale shell would scale a rehearsal service
 * and report success.
 *
 * ## The vacuous-pass trap
 *
 * Reading the guards out of the source would pass against a wrapper that refuses
 * everything, and a wrapper that refuses everything is a release that cannot deploy —
 * discovered in the cloud, on a credentialed run, after an apply. So the guards are
 * *run*: `test/release/support/runTaskGuards.sh` puts each one against a launch it
 * must refuse **and** against one it must allow, with every AWS response supplied
 * through an `FSS_RELEASE_*` variable so nothing reaches a network.
 */
describe('Appendix G 39: the refusal is symmetric, and the wrapper enforces it per launch', () => {
  it('runs every wrapper guard against a launch it must refuse and one it must allow', () => {
    const reports = mkdtempSync(join(tmpdir(), 'fss-wrapper-'));
    const output = execFileSync('bash', [repositoryPath('test/release/support/runTaskGuards.sh')], {
      env: { ...process.env, FSS_REHEARSAL_REPORTS: reports },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    expect(output).toContain('0 problem(s)');
    // A floor, so a suite that silently exercised nothing is a failure rather than a
    // pass: the guard list in the wrapper's own header has sixteen entries.
    const exercised = Number(/(\d+) wrapper guard\(s\) exercised/u.exec(output)?.[1] ?? '0');
    expect(exercised).toBeGreaterThanOrEqual(16);
  });

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

  it('refuses a rehearsal name from production and a production name from a rehearsal', () => {
    const common = readRepositoryFile('infra/scripts/release-common.sh');
    expect(common).toContain('release_refuse_foreign_arguments()');
    expect(common).toContain('a production command names a rehearsal resource');
    expect(common).toContain('rehearsal_refuse_production_arguments "$@" || return 1');
    // The command's own arguments are read too: a `--report /tmp/fss-prod-…` path in
    // a rehearsal is still a production name.
    expect(common).toContain('release_refuse_foreign_arguments "$environment" "${command_words[@]}"');
  });

  it('gives both credentialed workflows a concurrency group and never cancels one in flight', () => {
    for (const path of [
      '.github/workflows/greenfield-release.yml',
      '.github/workflows/greenfield-rehearsal-registry.yml',
    ]) {
      const workflow = readRepositoryFile(path);
      expect(workflow, `${path} declares no concurrency group`).toMatch(/^concurrency:$/mu);
      // Two rehearsals overlapping share the account, the two stable repositories and
      // the production-inventory comparison, which is recorded before a run and
      // compared after it. And a teardown that runs on `always()` must not be
      // cancelled: a cancelled run still has an environment standing.
      expect(workflow, `${path} cancels a run that is already holding the namespace`).toContain(
        'cancel-in-progress: false',
      );
    }
  });

  it('stops every one-off task before the teardown deletes the subnets they are in', () => {
    const teardown = readRepositoryFile('infra/scripts/rehearsal-teardown.sh');
    // A running task holds an elastic network interface in a subnet Terraform is
    // about to delete; the destroy then waits on the subnet and times out, and the
    // report blames the subnet.
    const stopAt = teardown.indexOf('0/5 stopping any one-off task still running');
    const destroyAt = teardown.indexOf('4/5 destroying the rehearsal root');
    expect(stopAt).toBeGreaterThan(-1);
    expect(destroyAt).toBeGreaterThan(stopAt);
    // And every ARN is classified before it is addressed, so another run's task — or
    // production's — is never a candidate.
    expect(teardown).toContain('rehearsal_classify_name "$PREFIX" "${task_arn##*:task/}"');
  });

  it('runs the 42 scenarios in the runner, against a service container, never the rehearsal database', () => {
    const workflow = readRepositoryFile('.github/workflows/greenfield-release.yml');
    expect(workflow).toContain('name: Release suite (recorded mode, runner)');
    expect(workflow).toContain('image: postgres:16');
    // The rehearsal database is private: no NAT, no bastion, `publicly_accessible =
    // false`. The step that assembled a URL from the rehearsal's outputs could never
    // have connected to it, and it is gone.
    expect(workflow).not.toContain("Assemble the rehearsal database URL from this run's own outputs");
    expect(workflow).not.toContain('sslmode=require');
  });
});

/**
 * G12k: the stages nest, and the two steps that clean up belong to all of them.
 * G16: and the fifth stage is not on that ladder at all.
 *
 * The rehearsal had one credentialed mode, so each of the three runs of 21 September
 * spent about an hour of David's attention to find one error. `stage` — `plan`,
 * `create`, `deploy`, `full` — makes the cheap part runnable alone. The risk it
 * introduces is a stage that is not a prefix of the next: a `deploy` that skipped
 * something `create` does would be a deploy of an environment nobody created, and a
 * `plan` that ran a step `full` does not would be a stage nobody designed.
 *
 * `teardown` is the fifth dispatch choice and deliberately outside that ladder: it
 * removes an environment an earlier run created and left, so it plans nothing, applies
 * nothing and writes no record. Every statement below about nesting is therefore about
 * the ladder — `ladderStagesForCondition` drops `teardown` before comparing — and the
 * statements about `teardown` are their own `describe`, further down.
 *
 * ## The vacuous-pass trap
 *
 * Reading the conditions out of the file and asserting the strings would pass against
 * a workflow where they were never evaluated, and asserting "every step has a stage
 * condition" would pass against four stages that all run everything. Closed by turning
 * each condition into the set of stages it admits, requiring that set to be a suffix of
 * `[plan, create, deploy, full]` for every step, and requiring each stage to run
 * *strictly more* steps than the one before it — so a `create` identical to `plan` is a
 * failure rather than a tautology. `stagesForCondition` refuses any condition grammar
 * it cannot read, because the permissive reading of an unknown condition is "every
 * stage", which is the answer that hides a mistake.
 */
describe('Appendix G 39: the rehearsal has five stages and four of them contain the one before', () => {
  const steps = rehearsalJobSteps();

  it('reads a job with every step named, so a parser that found nothing is a failure', () => {
    // The floor. Everything below is derived from this list, and a reader that
    // silently matched no steps would make each of those assertions vacuously true.
    expect(steps.length).toBeGreaterThanOrEqual(20);
    for (const step of steps) expect(step.name.length, `step ${String(step.index)} has no name`).toBeGreaterThan(3);
    expect(steps.map(step => step.name)).toContain('Write the release record, last');
    expect(steps.map(step => step.name)).toContain('Tear the rehearsal run down');
  });

  it('gives every step a ladder stage set that is a suffix of the four, never a hole in the middle', () => {
    for (const step of steps) {
      const stages = ladderStagesForCondition(step.condition);
      const suffix = REHEARSAL_STAGES.slice(REHEARSAL_STAGES.length - stages.length);
      expect([...stages], `${step.name} runs in a set of ladder stages that is not a suffix`).toEqual([...suffix]);
    }
  });

  it('runs strictly more with each stage, so no two stages are the same run', () => {
    for (const [index, stage] of REHEARSAL_STAGES.entries()) {
      if (index === 0) continue;
      const earlier = REHEARSAL_STAGES[index - 1] ?? 'plan';
      const previous = stepsForStage(earlier, steps).map(step => step.name);
      const current = stepsForStage(stage, steps).map(step => step.name);
      for (const name of previous) {
        expect(current, `${stage} does not run ${name}, which ${earlier} does`).toContain(name);
      }
      expect(current.length, `${stage} adds nothing to the stage before it`).toBeGreaterThan(previous.length);
    }
    // And the cheapest stage is a real run rather than a shell: it plans.
    expect(stepsForStage('plan', steps).length).toBeGreaterThanOrEqual(10);
  });

  it('tears down and re-reads the production inventory in every stage, unconditionally', () => {
    // These two are what protect against a stage condition being wrong, so neither may
    // depend on one: `always()` and nothing else. A `plan` run creates nothing, but
    // "creates nothing" is exactly the claim a broken `if:` would falsify, and the
    // teardown is tolerant of a run that created nothing (it reports
    // `destroyed=nothing_created`), so running it costs a few seconds and buys the
    // guarantee. They are also the only two steps the `teardown` stage exists to run.
    for (const name of ['Tear the rehearsal run down', 'Nothing with the production prefix was touched']) {
      const step = steps.find(candidate => candidate.name === name);
      expect(step, `the rehearsal job has no step named ${name}`).toBeDefined();
      expect(step?.condition).toBe('always()');
      for (const stage of REHEARSAL_STAGE_CHOICES) {
        expect(stepsForStage(stage, steps).map(candidate => candidate.name), `${stage} skips ${name}`).toContain(name);
      }
    }
    // The teardown needs the variables `terraform destroy` requires (G12i), so the
    // step that writes them is in every stage too — the `teardown` stage included, and
    // that is the whole reason a teardown of an orphan works at all from a fresh
    // checkout: the file is rebuilt from the run's inputs before the destroy.
    for (const stage of REHEARSAL_STAGE_CHOICES) {
      expect(stepsForStage(stage, steps).map(step => step.name)).toContain(
        'Write the variables this run plans, applies and tears down with',
      );
    }
  });

  it('plans in every ladder stage, and the apply names no variable of its own', () => {
    const plan = steps.find(step => step.text.includes('terraform plan'));
    const apply = steps.find(step => step.text.includes('terraform apply'));
    expect(plan, 'no step of the rehearsal job plans').toBeDefined();
    expect(apply, 'no step of the rehearsal job applies').toBeDefined();
    expect([...ladderStagesForCondition(plan?.condition ?? null)]).toEqual([...REHEARSAL_STAGES]);
    // And not in the fifth: a teardown of an orphan must not plan the environment it is
    // about to destroy, because a plan of a root whose state holds four leftover
    // resources proposes to create the other hundred and thirty-four.
    expect([...stagesForCondition(plan?.condition ?? null)]).not.toContain('teardown');
    expect(plan?.text).toContain('-out="$plan_file"');
    // One `-var` list, on the plan, which every stage runs. The apply takes its
    // values from `run.auto.tfvars.json`, which Terraform loads automatically from
    // the root directory and which `terraform destroy` already depends on (G12i). A
    // second list would be a second set of values to keep in step, and losing two of
    // eight from one of them is what stopped the second credentialed run.
    expect(apply?.text).toContain('terraform apply -auto-approve -input=false');
    expect(apply?.text).not.toContain('-var=');
  });

  it('gives the plan and the variables file the same expressions, so they cannot drift', () => {
    // The two are the same values only because they read the same secrets and the
    // same job environment. Nothing but this compares them, and a plan pointed at one
    // certificate while the apply reads another would be invisible until the apply.
    const plan = stepScript('Plan the rehearsal environment, and summarise it without values');
    const tfvars = stepScript('Write the variables this run plans, applies and tears down with');
    const expressions = (script: string): readonly string[] =>
      [...new Set([...script.matchAll(/\$\{\{ ([^}]+) \}\}/gu)].map(match => (match[1] ?? '').trim()))].sort();

    expect(expressions(plan)).toEqual(expressions(tfvars));
    // A floor: two scripts that reference nothing would compare equal.
    expect(expressions(plan).length).toBeGreaterThanOrEqual(6);
    for (const name of ['API_SCHEMA_MIN', 'API_SCHEMA_MAX', 'WORKER_SCHEMA_MIN', 'WORKER_SCHEMA_MAX']) {
      expect(plan, `the plan does not read ${name}`).toContain(name);
      expect(tfvars, `the variables file does not read ${name}`).toContain(name);
    }
  });
});

/**
 * G12k: what a `plan` run is allowed to print.
 *
 * The plan stage exists to be run often and read quickly, and its output is published
 * twice — to the job summary and to the ninety-day reports artifact. `terraform plan`
 * prints values: the image references, the certificate ARN, the hostname, every
 * attribute it can already resolve. So the summary is built from the machine-readable
 * plan, out of `address` and `change.actions` and nothing else.
 *
 * ## The vacuous-pass trap
 *
 * Asserting that the workflow contains a python program that looks careful would pass
 * against a program that had stopped being run, and against one whose refusal had
 * become a print. So both programs are lifted out of the workflow and executed: the
 * summariser against a plan whose values are secret-shaped, and the guard against a
 * summary that carries one, against a summary that does not, and against a variables
 * file that has stopped naming the values it is supposed to be looking for.
 */
describe('Appendix G 39: a plan run publishes addresses and counts, never values', () => {
  const script = stepScript('Plan the rehearsal environment, and summarise it without values');
  /** Secret-shaped, written here: nothing in this repository holds a real one. */
  const HOSTNAME = 'rehearsal-api.example.invalid';
  const CERTIFICATE = 'arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555';
  const IMAGE = `123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-rh-api@sha256:${'c'.repeat(64)}`;

  function python(program: string, args: readonly string[]): { readonly code: number; readonly output: string } {
    const result = spawnSync('python3', ['-', ...args], { encoding: 'utf8', input: program });
    return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
  }

  function variablesFile(overrides: Readonly<Record<string, unknown>> = {}): string {
    const directory = mkdtempSync(join(tmpdir(), 'fss-tfvars-'));
    const path = join(directory, 'run.auto.tfvars.json');
    const variables: Record<string, unknown> = {
      assume_deployment_role: false,
      bootstrap: true,
      name_prefix: 'fss-rh-case',
      api_image: IMAGE,
      worker_image: IMAGE.replace('fss-rh-api', 'fss-rh-worker'),
      certificate_arn: CERTIFICATE,
      api_hostname: HOSTNAME,
      api_schema_range: { min: 1, max: 1 },
      worker_schema_range: { min: 1, max: 1 },
      ...overrides,
    };
    for (const [name, value] of Object.entries(overrides)) {
      if (value === undefined) delete variables[name];
    }
    writeFileSync(path, JSON.stringify(variables, null, 2));
    return path;
  }

  it('prints one line per resource change, with the action and the address', () => {
    const summariser = embeddedPythonProgram(script, 'rehearsal-plan-summary:');
    const directory = mkdtempSync(join(tmpdir(), 'fss-planjson-'));
    const path = join(directory, 'plan.json');
    // The shape `terraform show -json` produces, carrying the values a real one has.
    writeFileSync(
      path,
      JSON.stringify({
        format_version: '1.2',
        variables: { api_hostname: { value: HOSTNAME } },
        resource_changes: [
          {
            address: 'module.stack.module.cluster.aws_ecs_service.api',
            change: { actions: ['create'], before: null, after: { name: 'fss-rh-case-api', image: IMAGE } },
          },
          {
            address: 'module.stack.module.network.aws_lb_listener.https',
            change: { actions: ['create'], before: null, after: { certificate_arn: CERTIFICATE } },
          },
          {
            address: 'module.stack.module.database.aws_db_instance.this',
            change: { actions: ['no-op'], before: {}, after: {} },
          },
        ],
      }),
    );

    const { code, output } = python(summariser, [path]);

    expect(code, output).toBe(0);
    expect(output).toContain('resource changes: 3');
    expect(output).toContain('  create: 2');
    expect(output).toContain('  no-op: 1');
    expect(output).toContain('create module.stack.module.cluster.aws_ecs_service.api');
    // The positive control above is what makes these three mean something.
    expect(output).not.toContain(HOSTNAME);
    expect(output).not.toContain(CERTIFICATE);
    expect(output).not.toContain(IMAGE);
  });

  it('refuses to publish a summary that carries a value the run holds', () => {
    const guard = embeddedPythonProgram(script, 'rehearsal-plan-summary-guard:');
    const directory = mkdtempSync(join(tmpdir(), 'fss-summary-'));
    const clean = join(directory, 'clean.txt');
    writeFileSync(clean, 'resource changes: 1\n  create: 1\ncreate module.stack.module.cluster.aws_ecs_service.api\n');
    const leaking = join(directory, 'leaking.txt');
    writeFileSync(leaking, `resource changes: 1\n  create: 1\ncreate ${HOSTNAME}\n`);
    const partial = join(directory, 'partial.txt');
    // Half of an image reference is still the account and the repository.
    writeFileSync(partial, `resource changes: 1\n  create: 1\ncreate ${IMAGE.split('@')[0] ?? ''}\n`);

    const accepted = python(guard, [clean, variablesFile()]);
    expect(accepted.code, accepted.output).toBe(0);
    expect(accepted.output).toContain('holds no value of the 4 secret-backed variables');

    const refused = python(guard, [leaking, variablesFile()]);
    expect(refused.code).not.toBe(0);
    expect(refused.output).toContain('the plan summary contains the value of api_hostname');

    const half = python(guard, [partial, variablesFile()]);
    expect(half.code).not.toBe(0);
    expect(half.output).toContain('the plan summary contains the value of api_image');
  });

  it('refuses a variables file that has stopped naming what it is supposed to check', () => {
    // Otherwise the guard passes by having nothing to look for, which is the shape
    // this whole suite exists to refuse.
    const guard = embeddedPythonProgram(script, 'rehearsal-plan-summary-guard:');
    const directory = mkdtempSync(join(tmpdir(), 'fss-summary-empty-'));
    const clean = join(directory, 'clean.txt');
    writeFileSync(clean, 'resource changes: 0\n');

    const { code, output } = python(guard, [clean, variablesFile({ api_hostname: undefined })]);

    expect(code).not.toBe(0);
    expect(output).toContain('this guard would check nothing');
  });

  it('keeps the plan output itself out of the log and out of the artifact', () => {
    // `$RUNNER_TEMP` is not `$FSS_REHEARSAL_REPORTS`, which is what the workflow
    // uploads for ninety days. The summary is copied there; the plan file, the plan
    // JSON and the plan's own stdout are not.
    expect(script).toContain('plan_log="$RUNNER_TEMP/terraform-plan.txt"');
    expect(script).toContain('> "$plan_log"; then');
    expect(script).toContain('cp "$summary" "$FSS_REHEARSAL_REPORTS/plan-summary.txt"');
    expect(script).not.toContain('"$FSS_REHEARSAL_REPORTS/rehearsal-plan.json"');
    expect(script).not.toContain('cat "$plan_log"');
  });
});

/**
 * G12k: the stages are written down where the next operator will look for them.
 *
 * A stage nobody knows about is a stage nobody runs, and the whole point of this lane
 * is that David reaches for `plan` before he reaches for `full`. The release document
 * is where that choice is made, so the check is on the document too.
 *
 * ## The vacuous-pass trap
 *
 * Asserting that the document mentions the word "stage" would pass against a sentence
 * that says nothing. Closed by requiring the two errors of the third credentialed run
 * *verbatim* — they are the evidence for the whole change, and a claim about a run is
 * worth only as much as the log line behind it — and by requiring the order David uses
 * the stages in, which is the operational content.
 */
describe('Appendix G 39: the stages, and the run that caused them, are in the release document', () => {
  const release = readRepositoryFile('docs/greenfield/release.md');
  const decision = readRepositoryFile('docs/decisions/g12k-the-rehearsal-has-stages-and-one-gate.md');

  it('says what each stage proves and that only the full one is the gate', () => {
    expect(release).toContain('### 3.0 The five stages, and the order to use them in');
    for (const stage of REHEARSAL_STAGE_CHOICES) expect(release).toContain(`\`${stage}\``);
    expect(release).toContain('**Only `full` is the gate.**');
    expect(release).toContain("`if: inputs.stage == 'full'`");
    // The order, which is the operational content: the local plan comes first.
    expect(release).toContain('**The local production plan, from your Mac**');
    expect(release).toContain('**Fix as a batch.**');
    expect(release).toContain('**Every stage tears down, and every stage re-reads the production inventory.**');
  });

  it('carries the third run’s two errors verbatim, and why no offline layer saw them', () => {
    expect(release).toContain('### 8.0c What the third credentialed run proved, and what it refuted');
    expect(release).toContain('35611374218');
    expect(release).toContain(
      'Attempted to load application default credentials since neither `credentials` nor `access_token` was set in the provider block.',
    );
    expect(release).toContain('count = var.kms_key_arn == null ? 1 : 0');
    expect(release).toContain('The "count" value depends on resource attributes that cannot be determined until apply.');
    expect(release).toContain('override_during = plan');
  });

  it('records the decision, and that the stages do not weaken the gate', () => {
    expect(decision).toContain('35611374218');
    expect(decision).toContain('35602423640');
    expect(decision).toContain('35548888865');
    expect(decision).toContain('## What this does not weaken');
  });
});
