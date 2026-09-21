#!/usr/bin/env node
// Prove the release suite's vacuous-pass traps are actually closed.
//
//   npm run test:release:mutation
//
// G12's brief: "every test names and closes its vacuous-pass trap, and a mutation check
// (a script that removes the setup and expects the test to fail) proves at least the
// traps you added."
//
// A test that cannot fail is worse than no test, because it is counted. The way to find
// out is to break the thing it claims to be testing and watch. This script does that,
// one mutation at a time, always restoring the file afterwards — including when a run is
// interrupted, which is why the restore is in a `finally` and the originals are held in
// memory rather than in a sibling file somebody could leave behind.
//
// Each mutation names:
//
//   * `file`        — what is edited;
//   * `find`/`replace` — the exact edit, which must match exactly once;
//   * `suite`       — the vitest invocation that must then FAIL;
//   * `because`     — the trap this proves is closed, in one sentence.
//
// A mutation whose `find` does not appear, or appears more than once, is itself a
// failure: it means the code moved and the mutation is no longer testing what it says.
// A mutation that leaves the suite GREEN is the finding this script exists for.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** @type {{name: string, file: string, find: string, replace: string, suite: string[], because: string}[]} */
const MUTATIONS = [
  {
    name: 'the outbound world stops attesting to a release gate',
    file: 'packages/domain/test/outbound/support/outboundWorld.ts',
    find: "VALUES ($1, 'sending_enabled', 1, $2::jsonb, 'fixture: the rehearsal gate this world stands for', $3)",
    replace: "VALUES ($1, 'business_time_zone', 1, '{\"timeZone\":\"UTC\"}'::jsonb, 'fixture: not the attestation', $3)",
    suite: ['--workspace', 'packages/domain', '--', 'test/outbound/'],
    because:
      'The fixture seeds 16.2 admin attestation so that cap, window and suppression scenarios refuse for their own reasons. Without it every send must hold, so a suite that still passed would not be reading the attestation at all.',
  },
  {
    name: 'the send gate stops requiring the deployment flag',
    file: 'packages/domain/outbound/gate.ts',
    find: 'if (!effectiveSendingEnabled(deps.deploymentSendingEnabled ?? false, attestation.value)) {',
    replace: 'if (false) {',
    suite: ['--workspace', 'packages/domain', '--', 'test/outbound/attestation.test.ts'],
    because:
      'Appendix G 42 is four conditions ANDed, and the attestation test is the only place the dispatch path is asked about two of them. Removing the check must fail it.',
  },
  {
    name: 'the production bootstrap accepts an absent dependency switch',
    file: 'apps/worker/src/bootstrap/deployment.ts',
    find: "if (environmentName === 'production') {\n      throw new DeploymentConfigError(\n        'DEPENDENCIES_UNSET',",
    replace: "if (false) {\n      throw new DeploymentConfigError(\n        'DEPENDENCIES_UNSET',",
    suite: ['--workspace', 'apps/worker', '--', 'test/deployment.test.ts'],
    because:
      'The coordinator note asks for a release-gate test that the production path never reaches a no-op by accident. If a production deployment can start with no switch set, that test must go red.',
  },
  {
    name: 'the production API accepts a journal that keeps nothing',
    file: 'apps/api/src/bootstrap/deployment.ts',
    find: "const suppressionJournal = dependencies === 'live' ? requireDurableJournal(resolved) : resolved.journal;",
    replace: 'const suppressionJournal = resolved.journal;',
    suite: ['--workspace', 'apps/api', '--', 'test/deployment.test.ts'],
    because:
      '10.2 makes the journal write a precondition of acknowledging a suppression. A live API that silently used the local no-op would accept opt-outs with nothing to replay after a restore.',
  },
  {
    name: 'the scenario map loses a scenario',
    file: 'test/release/support/scenarioMap.ts',
    find: '  {\n    number: 42,',
    replace: '  /* removed by the mutation check */ {\n    number: 43,',
    suite: ['run', 'test:release'],
    because:
      'The map is the index from Appendix G to its proof. A scenario that fell off it silently would be a scenario nobody runs, so the map must assert its own completeness against the literal range 1 to 42.',
  },
  {
    name: 'a rehearsal-only scenario loses its script',
    file: 'test/release/support/scenarioMap.ts',
    find: "    script: 'infra/scripts/rehearsal-restore-drill.sh',",
    replace: '',
    suite: ['run', 'test:release'],
    because:
      'A rehearsal-only scenario with no script is a scenario the workflow never runs, which would leave Appendix G 11 unproved while the suite stayed green.',
  },
  {
    name: 'the production API stops requiring a sign-in client',
    file: 'apps/api/src/bootstrap/deployment.ts',
    find: '  const signInBundle = readGoogleClientBundle(required(environment, VARIABLES.oidcClient), VARIABLES.oidcClient);',
    replace: "  const signInBundle = { clientId: 'x', clientSecret: 'y', pushTopic: null, hostedDomain: null };",
    suite: ['run', 'test:release'],
    because:
      'G12 shipped the API with no identity at all, which from outside looks exactly like a working deployment that refuses every command. Appendix G 23\'s four replay refusals are dead code without sign-in, so the release suite must go red when a live deployment can start without it.',
  },
  {
    name: 'the bootstrap stops preferring the task environment over the secret',
    file: 'apps/worker/src/bootstrap/deployment.ts',
    find: '  const fromEnvironment = environment[variableName]?.trim();\n  if (fromEnvironment !== undefined && fromEnvironment.length > 0) {',
    replace: '  const fromEnvironment = environment[variableName]?.trim();\n  if (false) {',
    suite: ['--workspace', 'apps/worker', '--', 'test/deployment.test.ts'],
    because:
      'The Pub/Sub topic and the Workspace domain moved into the task environment with the secret as a one-release fallback. A reader that silently kept preferring the secret would leave the apply doing nothing, and the two sources agree in production, so only a test that sets them to different values can tell.',
  },
  {
    name: 'the carry drill stops refusing a half-configured cutover',
    file: 'infra/scripts/rehearsal-carry-watermark.sh',
    find: 'if [ -z "$WATERMARK" ] || [ -z "$SOURCE_TABLE" ]; then',
    replace: 'if false; then',
    suite: ['run', 'test:release'],
    because:
      'The carry drill may skip before the cutover, and a skippable step is one that can be skipped by accident. A watermark set with no table must fail rather than quietly drill nothing, so scenario 20 must go red when the refusal is gone.',
  },
  {
    name: 'the release record stops distinguishing a skipped carry drill from a run one',
    file: 'infra/scripts/rehearsal-release-record.sh',
    find: '  *carry_drill=skipped_no_watermark*) CARRY_DRILL="skipped_no_watermark" ;;',
    replace: '  *carry_drill=skipped_no_watermark*) CARRY_DRILL="ran" ;;',
    suite: ['run', 'test:release'],
    because:
      'The record is what an admin reads at enable time. A record claiming the export half ran when it was skipped is the vacuous pass Appendix G 20 exists to prevent, and the two states must be distinguishable.',
  },
  {
    name: 'the prefix guard stops knowing the stable repositories are rehearsal resources',
    file: 'infra/scripts/rehearsal-common.sh',
    find: "REHEARSAL_STABLE_NAMES='fss-rh-api fss-rh-worker'",
    replace: "REHEARSAL_STABLE_NAMES=''",
    suite: ['run', 'test:release'],
    because:
      'fss-rh-api and fss-rh-worker are the only fss-rh- names that carry no run. A guard that classified them as foreign would fail Appendix G 39 for the wrong reason on every release, so the classifier has to name them and the check has to run it.',
  },
  {
    name: 'the rehearsal registry apply stops running in the rehearsal environment',
    file: '.github/workflows/greenfield-rehearsal-registry.yml',
    find: '    environment: rehearsal\n',
    replace: '',
    suite: ['run', 'test:release'],
    because:
      'fss-rh-deploy trusts only the OIDC subject repo:…:environment:rehearsal, so a job without the environment cannot assume it — and would fail at the role step rather than at review. The scenario 39 check has to notice the declaration leaving.',
  },
  {
    name: 'the registry plan guard stops refusing a destroy',
    file: 'infra/scripts/rehearsal-registry-guard.sh',
    find: '    if "delete" in actions:',
    replace: '    if False:',
    suite: ['run', 'test:release'],
    because:
      'force_delete = false stops a destroy of a repository holding images; nothing but this guard stops a *replacement*, which Terraform proposes as delete-then-create and which would take every image past releases were rehearsed on. The guard is the only reader of a plan no operator can see, so a guard that waves a destroy through must turn the suite red.',
  },
  {
    name: 'the caller-identity check stops reading the shape of the ARN',
    file: 'infra/scripts/rehearsal-common.sh',
    find: 'pattern="^arn:aws[a-z0-9-]*:sts::[0-9]{12}:assumed-role/${role}/.+$"',
    replace: 'pattern=".*"',
    suite: ['run', 'test:release'],
    because:
      'Every rehearsal terraform command runs with -var=assume_deployment_role=false, so the job\'s ambient credentials are what the apply acts as. A pattern that matches anything would accept a user, another role, or a role whose name merely starts the same way — which is exactly what the old `*fss-rh-*` check did — and scenario 39 has to notice.',
  },
  {
    name: 'the rehearsal apply goes back to assuming the role it already holds',
    file: '.github/workflows/greenfield-release.yml',
    find: '            -var="assume_deployment_role=false" \\\n',
    replace: '',
    suite: ['run', 'test:release'],
    because:
      'Without the flag the provider asks STS to assume fss-rh-deploy from a session that already is fss-rh-deploy, which needs the role to trust itself and is refused at provider configuration. The failure would only ever be seen inside a credentialed run, so the offline check is the only place it can be caught.',
  },
  {
    name: "the inventory exemption stops being read-only",
    file: 'infra/scripts/rehearsal-common.sh',
    find: '  if [ "$matched" -ne 1 ]; then',
    replace: '  if false; then',
    suite: ['run', 'test:release'],
    because:
      'The production-inventory read is the one rehearsal command allowed to name production, and the only thing keeping that from being a hole is the check that it is resourcegroupstaggingapi get-resources and nothing else. Remove it and the same function will issue rds delete-db-instance against fss-prod, so scenario 39 has to go red.',
  },
  {
    name: 'the dry run stops reading the plan it printed',
    file: 'infra/scripts/rehearsal-prefix-guard.sh',
    find: '    if [ "$offending" -gt 0 ]; then',
    replace: '    if false; then',
    suite: ['run', 'test:release'],
    because:
      "The first credentialed rehearsal refused its own inventory read, and no pull request could have caught it because the refusal only happens when the command is issued. The plan scan is the offline half; a scan that refuses nothing would let the next self-refusal through to the next credentialed run.",
  },
  {
    name: 'the teardown starts treating every failure as an absence',
    file: 'infra/scripts/rehearsal-common.sh',
    find: '    case "$output" in\n      *"($code)"*)',
    replace: '    case "$output" in\n      *)',
    suite: ['run', 'test:release'],
    because:
      'A teardown has to survive a run that created nothing, and the way it does that is by reading the AWS error code. A tolerance that matched anything would turn an AccessDenied into "already gone" and report a rehearsal environment destroyed while it was still standing and still holding prospect-shaped data.',
  },
  {
    name: 'the restore drill stops requiring a baseline to reconstruct',
    file: 'infra/scripts/rehearsal-restore-drill.sh',
    find: '  if [ "$count" -lt 1 ]; then',
    replace: '  if false; then',
    suite: ['run', 'test:release'],
    because:
      '"A restore drill against an empty database proves nothing." The drill has to fail its own setup rather than report a pass, and the scenario 11 check asserts the refusal is there.',
  },
  {
    name: 'the restore drill asks RDS for an instant it cannot restore to',
    file: 'infra/scripts/rehearsal-restore-drill.sh',
    find: '  --use-latest-restorable-time \\\n',
    replace: '  --restore-time "$RESTORE_TARGET" \\\n',
    suite: ['run', 'test:release'],
    because:
      "The latest restorable point lags real time by up to about five minutes, so restoring to an instant the drill chose is refused with InvalidRestoreTime — in the cloud, after the guard, on a credentialed run. Scenario 11 reads the dry-run plan rather than the script's text, so a restore that went back to naming its own time must turn it red.",
  },
  {
    name: 'the fss command line accepts any command at all',
    file: 'apps/worker/src/tools/fss/commands.ts',
    find: "    return { ok: false, reason: 'command_unknown', detail: argv.filter(word => !word.startsWith('--')).join(' ') };",
    replace: '    return { ok: true, value: { spec: FSS_COMMANDS[0], options: {}, switches: new Set() } };',
    suite: ['--workspace', 'apps/worker', '--', 'test/fssCli.test.ts'],
    because:
      'The drill writes fourteen `fss admin` lines and the tool is the only thing that can say whether they are real. A parser that accepted everything would make a misspelt flag in the drill do nothing at all at three in the morning, so the suite that reads the drill has to go red when the refusal is gone.',
  },
  {
    name: 'the operations tool stops fixing the dependency mode per command',
    file: 'apps/worker/src/tools/fss.ts',
    find: "  if (config.dependencies !== 'recorded') {\n    return {\n      refusal: {",
    replace: '  if (false) {\n    return {\n      refusal: {',
    suite: ['--workspace', 'apps/worker', '--', 'test/fssSurface.test.ts'],
    because:
      'David fixed the dependency mode per admin command so that a restore reconstruction run from a command line can never reach live Gmail. If a `live` deployment can run `mailbox recover`, the suite that asserts the refusal must go red rather than the tool trusting that nothing downstream sends.',
  },
  {
    name: 'the journal replay stops keeping the workspaces apart',
    file: 'packages/domain/suppression/replay.ts',
    find: '    if (record.workspaceId !== context.scope.workspaceId) {',
    replace: '    if (false) {',
    suite: ['--workspace', 'packages/domain', '--', 'test/restore/adminCommands.test.ts'],
    because:
      "Appendix E's replay is the one path that writes suppression rows from outside a command, and a record carries the workspace it belongs to. A replay that inserted another workspace's event would be the only way a suppression could cross a workspace boundary in this system, so the two-workspace case must fail when the check is removed.",
  },
  {
    name: 'the run-task wrapper stops comparing the registered image with the release digest',
    file: 'infra/scripts/release-common.sh',
    find: '    *"@$expected_digest") ;;',
    replace: '    *) ;;',
    suite: ['run', 'test:release'],
    because:
      'The release gate is the comparison between the digest that passed rehearsal and the digest that is deployed, and a one-off task is the one place it is made at the moment of use: a migration applied by last release\'s image is a migration nobody rehearsed. Scenario 39 runs the guard against a launch carrying the wrong digest and has to go red when it stops refusing.',
  },
  {
    name: 'a stopped task with no exit code is read as a success',
    file: 'infra/scripts/release-common.sh',
    find: '    if code is None:',
    replace: '    if False:',
    suite: ['run', 'test:release'],
    because:
      'A task that could not pull its image or could not resolve its secret stops with no exitCode at all. `exitCode or 0` is the bug that turns each of those into a green release, so the wrapper must fail on absence and scenario 39 must notice when it does not.',
  },
  {
    name: 'the wrapper stops refusing a credential-shaped environment override',
    file: 'infra/scripts/release-common.sh',
    find: "    if printf '%s' \"$override_name\" | grep -qiE '(password|secret|token|credential|private_key|api_key)'; then",
    replace: '    if false; then',
    suite: ['run', 'test:release'],
    because:
      'The restored instance\'s endpoint travels as an environment override because a hostname is public. A credential must not: an override is visible in `describe-tasks` to anyone who can read the cluster, which is the opposite of the Secrets Manager reference the design uses everywhere else.',
  },
  {
    name: 'a retried step launches a second migration instead of waiting',
    file: 'infra/scripts/release-common.sh',
    find: '  if [ -s "$record" ]; then',
    replace: '  if false; then',
    suite: ['run', 'test:release'],
    because:
      'A re-run job that launched a second `fss migrate` would have it block on the advisory lock, find nothing to apply and exit zero — which looks exactly like success and means the first migration\'s outcome was never read. The recorded task ARN is the only thing that makes a retry wait.',
  },
  {
    name: 'a production command stops refusing a rehearsal resource',
    file: 'infra/scripts/release-common.sh',
    find: '          *fss-rh-*)',
    replace: '          __never_matches__)',
    suite: ['run', 'test:release'],
    because:
      'G12h made one script the code path for both environments, so Appendix G 39\'s refusal has to be symmetric. A production deploy that picked up a rehearsal cluster ARN would scale a rehearsal service and report success, and the rehearsal-side refusal alone would not notice.',
  },
  {
    name: 'the migration entry becomes readable by the services',
    file: 'infra/modules/cluster/main.tf',
    find: '  runtime_secret_arns = distinct(concat(values(var.secret_arns), [var.app_runtime_database_secret_arn]))',
    replace:
      '  runtime_secret_arns = distinct(concat(values(var.secret_arns), [var.app_runtime_database_secret_arn, var.migration_database_secret_arn]))',
    suite: ['run', 'test:release'],
    because:
      "David's first condition of 21 September is that the runtime task role has no path to DDL credentials. It is one line of a `locals` block, and nothing but the tftest stands between it and a service that can migrate its own database, so scenario 22's infrastructure assertions have to go red when the line changes.",
  },
  {
    name: 'a fresh environment starts its services before the schema exists',
    file: 'infra/modules/cluster/main.tf',
    find: '  api_desired_count    = var.bootstrap ? 0 : var.api_desired_count',
    replace: '  api_desired_count    = var.api_desired_count',
    suite: ['run', 'test:release'],
    because:
      'Both binaries refuse a database whose schema version is not exactly the range they declare, so an apply that created the API running would create it crash-looping against an empty database while the migration task that would fix it had not been launched. The bootstrap is the whole of condition 2 and it is one ternary.',
  },
  {
    name: 'the drill task stops fixing its dependency mode',
    file: 'infra/modules/cluster/main.tf',
    find: '  drill_environment = merge(local.worker_environment, { FSS_DEPENDENCIES = "recorded" })',
    replace: '  drill_environment = local.worker_environment',
    suite: ['run', 'test:release'],
    because:
      '`reconcile-sent`, `recover` and `watch-renew` all reach Gmail when dependencies are live, and a rehearsal that reached a real mailbox would send real mail. The tool refuses in any other mode, and the task definition is the second lock on the same door: with it gone the drill inherits the root\'s mode, which in production is `live`.',
  },
  {
    name: 'the rehearsal apply stops naming a variable the root requires',
    file: '.github/workflows/greenfield-release.yml',
    find: '            -var="api_schema_range={min=${API_SCHEMA_MIN},max=${API_SCHEMA_MAX}}" \\\n',
    replace: '',
    suite: ['run', 'test:release'],
    because:
      'The second credentialed run initialised the backend and was refused at the apply because the workflow named six of the eight variables the rehearsal root requires. Scenario 22 now derives the list from variables.tf and reads the workflow for each; drop one line and it has to go red, or the next required variable a lane adds will be found the same way, in the cloud.',
  },
];

function run(script) {
  return execFileSync('npm', script, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
}

let failures = 0;
let proven = 0;

for (const mutation of MUTATIONS) {
  const path = `${ROOT}${mutation.file}`;
  const original = readFileSync(path, 'utf8');
  const occurrences = original.split(mutation.find).length - 1;
  if (occurrences !== 1) {
    console.error(
      `MUTATION_STALE ${mutation.name}: the text it edits appears ${String(occurrences)} times in ${mutation.file}`,
    );
    failures += 1;
    continue;
  }

  try {
    writeFileSync(path, original.replace(mutation.find, mutation.replace));
    let stayedGreen = false;
    try {
      run(mutation.suite);
      stayedGreen = true;
    } catch {
      stayedGreen = false;
    }
    if (stayedGreen) {
      console.error(`MUTATION_SURVIVED ${mutation.name}`);
      console.error(`  ${mutation.because}`);
      console.error(`  The suite stayed green with ${mutation.file} broken, so it is not testing this.`);
      failures += 1;
    } else {
      proven += 1;
      console.error(`killed: ${mutation.name}`);
    }
  } finally {
    // Always, including on an interrupt: a mutation left in the tree is a broken
    // repository, and a half-finished run must not be one of the ways that happens.
    writeFileSync(path, original);
  }
}

console.error(`\n${String(proven)} mutation(s) killed, ${String(failures)} problem(s).`);
process.exitCode = failures === 0 ? 0 : 1;
