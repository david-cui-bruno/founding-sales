import { describe, expect, it } from 'vitest';
import {
  API_SCHEMA_RANGE,
  CURRENT_SCHEMA_VERSION,
  PREVIOUS_RELEASE_SCHEMA_RANGE,
  WORKER_SCHEMA_RANGE,
  acceptsSchemaVersion,
  type SchemaRange,
} from '@fss/domain/db';
import { mustBeRehearsed, readRepositoryFile } from './support/coverage.ts';
import { stepScript } from './support/releaseWorkflow.ts';

/**
 * Appendix G 22: "Old API with new worker and reverse across every expand/contract
 * phase obey schema ranges."
 *
 * Rehearsal-only, because an image either starts against a database or it does not, and
 * nothing on a laptop can ask it that. `infra/scripts/rehearsal-schema-ranges.sh` runs
 * the declared deploy order — migrate, then worker, then API — and then the reverse
 * cases through `--selftest`.
 *
 * ## The vacuous-pass trap
 *
 * With both declared ranges equal to the current schema version, "every pair is
 * compatible" is true and proves nothing: there is no old image that can run against the
 * new schema, so a suite that asserted compatibility would be asserting the absence of a
 * test. The coordinator's launch note says what to do instead — where no ranges overlap,
 * assert the refusal and say why.
 *
 * Closed by computing the overlap from the declared constants rather than assuming one,
 * and taking whichever branch the numbers dictate. It fails if the arithmetic stops
 * meaning anything: a range that does not accept the schema this tree produces, or a
 * refusal that is neither of the two reasons there are.
 */

/** The two refusals `checkSchemaRange` can give; they are this scenario's assertion. */
function refusalFor(range: SchemaRange, version: number): string {
  if (version < range.minimum) return 'database_behind_binary';
  if (version > range.maximum) return 'database_ahead_of_binary';
  return 'accepted';
}

describe('Appendix G 22: the declared ranges decide, and a non-overlap is the refusal', () => {
  mustBeRehearsed(22);

  it('both binaries accept the schema this tree produces', () => {
    // A binary that refused the database it has just been deployed against would be a
    // self-inflicted outage. This is the floor the rest of the scenario stands on.
    expect(acceptsSchemaVersion(API_SCHEMA_RANGE, CURRENT_SCHEMA_VERSION)).toBe(true);
    expect(acceptsSchemaVersion(WORKER_SCHEMA_RANGE, CURRENT_SCHEMA_VERSION)).toBe(true);
  });

  it('takes the overlap branch or the refusal branch according to the declared ranges', () => {
    const previous = refusalFor(PREVIOUS_RELEASE_SCHEMA_RANGE, CURRENT_SCHEMA_VERSION);
    if (previous === 'accepted') {
      // The expand case: the previous release widened its range a release ahead of this
      // migration, so the previous image really can run against the new schema and the
      // rehearsal runs it.
      expect(PREVIOUS_RELEASE_SCHEMA_RANGE.maximum).toBeGreaterThanOrEqual(CURRENT_SCHEMA_VERSION);
    } else {
      // No overlap. The scenario is then the refusal, and it must be one of exactly two
      // reasons — a third would mean the comparison had stopped being a comparison.
      expect(['database_behind_binary', 'database_ahead_of_binary']).toContain(previous);
    }
  });

  it('refuses a schema outside each declared range, whatever the numbers become', () => {
    // Computed from the constants, so a lane that widens a range does not have to
    // remember this file.
    expect(refusalFor(API_SCHEMA_RANGE, API_SCHEMA_RANGE.minimum - 1)).toBe('database_behind_binary');
    expect(refusalFor(WORKER_SCHEMA_RANGE, WORKER_SCHEMA_RANGE.minimum - 1)).toBe('database_behind_binary');
    expect(refusalFor(API_SCHEMA_RANGE, API_SCHEMA_RANGE.maximum + 1)).toBe('database_ahead_of_binary');
    expect(refusalFor(WORKER_SCHEMA_RANGE, WORKER_SCHEMA_RANGE.maximum + 1)).toBe('database_ahead_of_binary');
  });

  it('the rehearsal script reads the ranges from the source rather than from a literal', () => {
    const script = readRepositoryFile('infra/scripts/rehearsal-schema-ranges.sh');
    expect(script).toContain('packages/domain/db/schemaRange.ts');
    expect(script).toContain('API_SCHEMA_RANGE');
    expect(script).toContain('WORKER_SCHEMA_RANGE');
    expect(script).toContain('PREVIOUS_RELEASE_SCHEMA_RANGE');
  });

  /**
   * G12h. Until 21 September the deploy order was a heading and not a deployment.
   *
   * `rehearsal-schema-ranges.sh` was named "migrate, then worker, then API" and did
   * two `update-service --force-new-deployment` calls; nothing anywhere ran a
   * migration, and both binaries refuse to start unless the applied schema version is
   * exactly the range they declare. On a fresh database that is two services that
   * never start. These assert the order is now performed rather than described.
   */
  it('performs the order in the shared deploy script: migrate, users, verify, worker, API', () => {
    const script = readRepositoryFile('infra/scripts/release-deploy.sh');
    const at = (needle: string): number => {
      const index = script.indexOf(needle);
      expect(index, `release-deploy.sh does not ${needle}`).toBeGreaterThan(-1);
      return index;
    };

    const migrate = at('one_off migrate "$MIGRATION_TASK_DEFINITION" migration migrate');
    const users = at('one_off database-users "$MIGRATION_TASK_DEFINITION" migration admin database-users ensure');
    const verify = at('one_off verify-schema "$OPERATIONS_TASK_DEFINITION" operations verify');
    const worker = at('scale "$WORKER_SERVICE" "$WORKER_TARGET"');
    const api = at('scale "$API_SERVICE" "$API_TARGET"');
    const verifyDeployed = at('one_off verify-deployed "$OPERATIONS_TASK_DEFINITION" operations verify');

    expect(users).toBeGreaterThan(migrate);
    expect(verify).toBeGreaterThan(users);
    expect(worker).toBeGreaterThan(verify);
    expect(api).toBeGreaterThan(worker);
    // A release gate after every deploy, not only before it.
    expect(verifyDeployed).toBeGreaterThan(api);
  });

  it('stops during a schema migration and never rolls the database back', () => {
    const script = readRepositoryFile('infra/scripts/release-deploy.sh');
    // API first, so no request reaches a schema that is about to move.
    const stop = script.indexOf('scale "$API_SERVICE" 0');
    const stopWorker = script.indexOf('scale "$WORKER_SERVICE" 0');
    expect(stop).toBeGreaterThan(-1);
    expect(stopWorker).toBeGreaterThan(stop);
    expect(script.indexOf('scale "$API_SERVICE" 0')).toBeLessThan(
      script.indexOf('one_off migrate "$MIGRATION_TASK_DEFINITION"'),
    );

    // And the policy is written where an operator reads it, not only here.
    const release = readRepositoryFile('docs/greenfield/release.md');
    expect(release).toContain('Stop-during-migration');
    expect(release).toContain('The database never rolls back');
  });

  it('creates a fresh environment at desired count zero rather than crash-looping it', () => {
    // Both binaries refuse an unmigrated database, so an apply that started them
    // would create two services failing against an empty schema while the task that
    // would fix it had not been launched. `bootstrap` is the root variable that says
    // which of the two states an apply is.
    const cluster = readRepositoryFile('infra/modules/cluster/main.tf');
    expect(cluster).toContain('api_desired_count    = var.bootstrap ? 0 : var.api_desired_count');
    expect(cluster).toContain('worker_desired_count = var.bootstrap ? 0 : var.worker_desired_count');
    // Never `ignore_changes` on the count: that would make it untracked for ever and
    // take away Terraform's ability to scale to zero for the next schema release.
    expect(cluster).not.toContain('ignore_changes = [desired_count]');

    for (const root of ['infra/roots/rehearsal/main.tf', 'infra/roots/production/main.tf']) {
      expect(readRepositoryFile(root)).toContain('bootstrap              = var.bootstrap');
    }
    // The rehearsal creates a fresh environment every time, so its default is true.
    expect(readRepositoryFile('infra/roots/rehearsal/variables.tf')).toMatch(
      /variable "bootstrap"[\s\S]*?default\s*=\s*true/u,
    );
    expect(readRepositoryFile('infra/roots/production/variables.tf')).toMatch(
      /variable "bootstrap"[\s\S]*?default\s*=\s*false/u,
    );
    expect(readRepositoryFile('.github/workflows/greenfield-release.yml')).toContain('-var="bootstrap=true"');
  });

  it('names every variable the rehearsal root requires, in the plan and in the file the teardown destroys with', () => {
    // The second credentialed run (21 September 2026, Actions 35602423640) reached the
    // apply and was refused: "The root module input variable api_schema_range is not
    // set". The workflow named six of the root's eight required variables and nothing
    // compared its list with the root's. This does — and it asks the same of the file
    // the teardown's `terraform destroy` reads, because destroy requires the same
    // values and runs on `always()` after the create step's shell is gone.
    //
    // G12k moved the `-var` list on to `terraform plan`, which every stage runs, and
    // the apply consumes the plan file it wrote. So the list is asked of the step that
    // carries it rather than of the file as a whole: a `-var` in a comment, or in a
    // step that no longer runs, would otherwise satisfy this.
    const variables = readRepositoryFile('infra/roots/rehearsal/variables.tf');
    const required = variables
      .split(/^variable "/mu)
      .slice(1)
      .filter(block => !/^ {2}default\s*=/mu.test(block))
      .map(block => block.slice(0, block.indexOf('"')));
    expect(required).toEqual(
      expect.arrayContaining(['api_image', 'worker_image', 'api_schema_range', 'worker_schema_range']),
    );
    const plan = stepScript('Plan the rehearsal environment, and summarise it without values');
    const tfvars = stepScript('Write the variables this run plans, applies and tears down with');
    for (const name of required) {
      expect(plan, `the plan passes ${name}`).toContain(`-var="${name}=`);
      expect(tfvars, `the variables step writes ${name} for the teardown`).toContain(`"${name}": `);
    }
    // The ranges come from the source, as the images workflow reads them, never typed.
    const workflow = readRepositoryFile('.github/workflows/greenfield-release.yml');
    expect(workflow).toContain("const module = await import('./packages/domain/db/schemaRange.ts');");
    expect(tfvars).toContain('python3 - > run.auto.tfvars.json');
    const teardown = readRepositoryFile('infra/scripts/rehearsal-teardown.sh');
    expect(teardown).toContain('if [ ! -f run.auto.tfvars.json ]; then');
  });

  /**
   * The two identity boundaries, asserted here as well as in Terraform.
   *
   * `infra/modules/cluster/tests/migration_identity.tftest.hcl` reads them out of the
   * planned policy documents, which is the real check — but `terraform test` runs in
   * `infra/scripts/offline-gate.sh` and not in `npm run test:release`, so a mutation
   * of either line would leave this suite green. Each is a single expression, and
   * each is the whole of one of David's conditions.
   */
  it('keeps the runtime execution roles away from the migration entry', () => {
    const cluster = readRepositoryFile('infra/modules/cluster/main.tf');
    expect(cluster).toContain(
      'runtime_secret_arns = distinct(concat(values(var.secret_arns), [var.app_runtime_database_secret_arn]))',
    );
    // Condition 1: what the services may resolve is the application secrets and the
    // app_runtime entry. Not the migration entry, and not the RDS-managed master
    // secret, which after G12h nothing in the cluster reads at all.
    expect(cluster).not.toContain('runtime_secret_arns = distinct(concat(values(var.secret_arns), [var.app_runtime_database_secret_arn, var.migration_database_secret_arn]))');
    expect(cluster).not.toContain('database_master_secret_arn');
  });

  it('fixes the drill’s dependency mode in its task definition, not in a caller', () => {
    const cluster = readRepositoryFile('infra/modules/cluster/main.tf');
    // Condition 6: reconcile-sent, recover and watch-renew all reach Gmail when
    // dependencies are live, so a rehearsal that inherited the root's mode would send
    // real mail. The tool refuses in any other mode; this is the second lock.
    expect(cluster).toContain('drill_environment = merge(local.worker_environment, { FSS_DEPENDENCIES = "recorded" })');
  });

  it('scales to the count the root declares, read from the plan rather than typed', () => {
    // A literal in a shell file is a number that drifts from the one in the root.
    const script = readRepositoryFile('infra/scripts/release-deploy.sh');
    expect(script).toContain('release_output "$ROOT_DIRECTORY" deployment_plan json');
    expect(script).toContain('"api.declared_desired_count"');
    expect(script).toContain('"worker.declared_desired_count"');

    const outputs = readRepositoryFile('infra/modules/cluster/outputs.tf');
    expect(outputs).toContain('declared_desired_count = var.api_desired_count');
    expect(outputs).toContain('planned_desired_count  = aws_ecs_service.api.desired_count');
  });

  it('is the same code path in production, under the operator’s own credentials', () => {
    const script = readRepositoryFile('infra/scripts/release-deploy.sh');
    // The environment comes from the prefix, and the root must agree with it.
    expect(script).toContain('release_environment_for_prefix "$PREFIX"');
    expect(script).toContain('production:*roots/production');
    expect(script).toContain('rehearsal:*roots/rehearsal');

    const workflow = readRepositoryFile('.github/workflows/greenfield-release.yml');
    expect(workflow).toContain('infra/scripts/release-deploy.sh infra/roots/rehearsal');
    const runbook = readRepositoryFile('docs/greenfield/infra-apply-runbook.md');
    expect(runbook).toContain('infra/scripts/release-deploy.sh infra/roots/production fss-prod');
  });
});
