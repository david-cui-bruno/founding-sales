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
// interrupted, which is why the restore is in a `finally`, the process listens for the
// signals that would otherwise end it mid-edit, and the originals are held in memory
// rather than in a sibling file somebody could leave behind.
//
// Each mutation names:
//
//   * `file`        — what is edited;
//   * `find`/`replace` — the exact edit, which must match exactly once;
//   * `suite`       — the arguments to `npm` for the vitest run that must then FAIL:
//                     `['run', 'test:release']`, `['run', 'test:release', '--', '<file>']`
//                     or `['run', 'test', '--workspace', '<workspace>', '--', '<file>']`;
//   * `because`     — the trap this proves is closed, in one sentence.
//
// A mutation whose `find` does not appear, or appears more than once, is itself a
// failure: it means the code moved and the mutation is no longer testing what it says.
// A mutation that leaves the suite GREEN is the finding this script exists for.
//
// A red exit status is not a failing test. Each distinct suite runs once unmutated first
// and must pass, and a mutated run counts as a kill only when vitest itself reports a
// failure; an npm usage error or a setup that never reached a test is a problem. The
// rules, and the two ways they were learned, are in `scripts/releaseMutationRunner.mjs`.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runMutationCheck, spawnSuite } from './releaseMutationRunner.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** @type {{name: string, file: string, find: string, replace: string, suite: string[], because: string}[]} */
const MUTATIONS = [
  {
    name: 'the stale schema-range case reads the run-task call again instead of the container',
    file: 'infra/scripts/rehearsal-schema-ranges.sh',
    find:
      '  if ! launch_selftest "schema-stale-$service" "$service" "$definition" "$digest" "$SCHEMA_REFUSAL_EXIT_CODE" \\\n      --env "FSS_SCHEMA_MIN=$stale" --env "FSS_SCHEMA_MAX=$stale"; then\n',
    replace:
      '  if ! rehearsal_aws ecs run-task --cluster "$CLUSTER_ARN" --task-definition "$family" --output text >/dev/null; then\n',
    suite: ['run', 'test:release'],
    because:
      'This is the defect run 35905867795 found on 23 September 2026: the case called the CLI directly and treated a successful run-task *API call* as the image accepting the range. The refusal happens inside the container at startup, so the assertion is the container\u2019s exit code \u2014 12, `configurationInvalid` in both API_EXIT_CODES and WORKER_EXIT_CODES. With the launch judged by the API call again, a container that exits 0 or 1 passes, and scenario22 must go red.',
  },
  {
    name: 'the rehearsal stops filling one of the six application entries',
    file: '.github/workflows/greenfield-release.yml',
    find: '              session-signing-key|device-credential-pepper)\n',
    replace: '              session-signing-key)\n',
    suite: ['run', 'test:release'],
    because:
      'An ECS task whose secrets block names an empty entry does not start (run 35891175510, 23 September 2026, at fss verify). The step must know every name on the stack\u2019s list; an unknown one is a failure, and this mutation turns a known one into that failure path only if the test reads the arms.',
  },
  {
    name: 'the tool forgets that database-users runs as the migration identity',
    file: 'apps/worker/src/tools/fss.ts',
    find: "  'migrate up',\n  'admin database-users ensure',\n",
    replace: "  'migrate up',\n",
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/fssCli.test.ts'],
    because:
      'release-deploy.sh runs `admin database-users ensure` on the migration task definition, which injects no runtime connection. Run 35883201716 (23 September 2026) migrated the database and then refused this command for the reason migrate had been refused the run before; the script and the set are read together now.',
  },
  {
    name: 'the wrapper stops fetching a failed task’s log',
    file: 'infra/scripts/release-common.sh',
    find: '  release_report_task "$step" "$described" "$container" "$expect_exit" || verdict=1\n',
    replace: '  release_report_task "$step" "$described" "$container" "$expect_exit" || return 1\n',
    suite: ['run', 'test:release'],
    because:
      'A failed one-off task is the one whose output matters. Run 35876269976 (23 September 2026) printed "container migration exited 21" and nothing else, because the wrapper returned on the verdict before the fetch.',
  },
  {
    name: 'the drill passes the restored endpoint as the host the definition is checked against',
    file: 'infra/scripts/rehearsal-run-task.sh',
    find: '  --database-host "$DATABASE_HOST" \\\n',
    replace: '  --database-host "${FSS_RESTORED_DATABASE_HOST:-$DATABASE_HOST}" \\\n',
    suite: ['run', 'test:release'],
    because:
      'This is run 35962272085 exactly (24 September 2026): the point-in-time restore succeeded and the drill\u2019s first task was refused, "this task would connect to \'<prefix>-pg.\u2026\' and the database this release targets is \'<prefix>-pg-restored.\u2026\'", because the front door passed the restored endpoint as --database-host as well as the override, and the task definition names the primary. The wrapper suite calls release_run_task directly and cannot see which host the front door passes, so scenario 39 drives rehearsal-run-task.sh with a restored host and has to go red.',
  },
  {
    name: 'the worker image stops verifying the database\u2019s certificate',
    file: 'Dockerfile.worker',
    find: '    PGSSLMODE=verify-full \\\n',
    replace: '    PGSSLMODE=no-verify \\\n',
    suite: ['run', 'test:release'],
    because:
      'rds.force_ssl = 1 refuses a plain connection and Node\u2019s roots do not include Amazon RDS. no-verify would connect to anything that answers on the port; verify-full plus the RDS bundle is the contract. Run 35876269976 (23 September 2026) was the first process to reach the real database, and it was refused at the handshake.',
  },
  {
    name: 'the database stops forcing SSL',
    file: 'infra/modules/database/main.tf',
    find: '    name  = "rds.force_ssl"\n    value = "1"',
    replace: '    name  = "rds.force_ssl"\n    value = "0"',
    suite: ['run', 'test:release'],
    because:
      'The images verify TLS because the database demands it; a parameter group that stopped demanding it would let a misconfigured client fall back to plaintext unnoticed. The two are one contract.',
  },
  {
    name: 'the tool demands the runtime connection for migrate again',
    file: 'apps/worker/src/tools/fss.ts',
    find: "readToolConfig(environment, { runtimeConnection: migrationIdentity ? 'optional' : 'required' })",
    replace: 'readToolConfig(environment)',
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/fssTool.test.ts'],
    because:
      'The migration task definition injects MIGRATION_DATABASE_SECRET and no DATABASE_SECRET_ARN (tests/migration_identity.tftest.hcl). Runs 35812168524 and 35817370929 of 23 September 2026 exited 20 before touching the database because the tool read the runtime connection first for every command.',
  },
  {
    name: 'the log fetch stops waiting for a stream that is still empty',
    file: 'infra/scripts/release-common.sh',
    find: '        if [ "$waited" -lt "$RELEASE_LOG_GRACE_SECONDS" ]; then\n          sleep "$RELEASE_LOG_POLL_SECONDS"',
    replace: '        if false; then\n          sleep "$RELEASE_LOG_POLL_SECONDS"',
    suite: ['run', 'test:release'],
    because:
      'The awslogs driver delivers a stopped container’s last lines seconds after ECS reports the stop. Both runs of 23 September 2026 read the stream in that gap and the job log carried nothing of what the container said.',
  },
  {
    name: 'a one-off task’s log stops being kept beside its ARN',
    file: 'infra/scripts/release-common.sh',
    find: '  capture=${capture:-${record%.arn}.log}',
    replace: '  capture=${capture:-}',
    suite: ['run', 'test:release'],
    because:
      'The teardown destroys the log group minutes after the task; the copy in .rehearsal-reports/tasks is what the artifact keeps of the container’s own words.',
  },
  {
    name: 'the outbound world stops attesting to a release gate',
    file: 'packages/domain/test/outbound/support/outboundWorld.ts',
    find: "VALUES ($1, 'sending_enabled', 1, $2::jsonb, 'fixture: the rehearsal gate this world stands for', $3)",
    replace: "VALUES ($1, 'business_time_zone', 1, '{\"timeZone\":\"UTC\"}'::jsonb, 'fixture: not the attestation', $3)",
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/outbound/'],
    because:
      'The fixture seeds 16.2 admin attestation so that cap, window and suppression scenarios refuse for their own reasons. Without it every send must hold, so a suite that still passed would not be reading the attestation at all.',
  },
  {
    name: 'the send gate stops requiring the deployment flag',
    file: 'packages/domain/outbound/gate.ts',
    find: 'if (!effectiveSendingEnabled(deps.deploymentSendingEnabled ?? false, attestation.value)) {',
    replace: 'if (false) {',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/outbound/attestation.test.ts'],
    because:
      'Appendix G 42 is four conditions ANDed, and the attestation test is the only place the dispatch path is asked about two of them. Removing the check must fail it.',
  },
  {
    name: 'the production bootstrap accepts an absent dependency switch',
    file: 'apps/worker/src/bootstrap/deployment.ts',
    find: "if (environmentName === 'production') {\n      throw new DeploymentConfigError(\n        'DEPENDENCIES_UNSET',",
    replace: "if (false) {\n      throw new DeploymentConfigError(\n        'DEPENDENCIES_UNSET',",
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/deployment.test.ts'],
    because:
      'The coordinator note asks for a release-gate test that the production path never reaches a no-op by accident. If a production deployment can start with no switch set, that test must go red.',
  },
  {
    name: 'the production API accepts a journal that keeps nothing',
    file: 'apps/api/src/bootstrap/deployment.ts',
    find: "const suppressionJournal = dependencies === 'live' ? requireDurableJournal(resolved) : resolved.journal;",
    replace: 'const suppressionJournal = resolved.journal;',
    suite: ['run', 'test', '--workspace', 'apps/api', '--', 'test/deployment.test.ts'],
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
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/deployment.test.ts'],
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
    name: 'the production guard compares ECS tasks again',
    file: 'infra/scripts/rehearsal-prefix-guard.sh',
    find: 'tasks = [arn for arn in arns if is_ecs_task(arn)]\n',
    replace: 'tasks = []\n',
    suite: ['run', 'test:release'],
    because:
      'This is run 35962272085 exactly (24 September 2026): twelve production tasks the redeploy had stopped were recorded at 05:59Z and forgotten by ECS before the 07:10Z comparison, and the guard reported a production touch that never happened. The tagging API lists tasks because they carry propagated tags, and ECS drops a stopped task after about an hour, so scenario 39 runs the guard against that shape and has to go red when tasks are compared again.',
  },
  {
    name: 'the production guard sets aside task-definition revisions with the tasks',
    file: 'infra/scripts/rehearsal-prefix-guard.sh',
    find: 'parts[5].startswith("task/")',
    replace: 'parts[5].startswith("task")',
    suite: ['run', 'test:release'],
    because:
      'A new task-definition revision is what a production deploy leaves behind, so it is a production touch and the guard must still see it. `task-definition/…` and `task/…` differ by one character after `task`. A filter that matched the prefix without the slash would quietly stop measuring the one ECS resource that proves a deploy happened, and scenario 39 has to go red when it does.',
  },
  {
    name: 'the production guard compares task network interfaces again',
    file: 'infra/scripts/rehearsal-prefix-guard.sh',
    find: 'interfaces = [arn for arn in arns if is_network_interface(arn)]\n',
    replace: 'interfaces = []\n',
    suite: ['run', 'test:release'],
    because:
      'This is run 36032732128 exactly (24 September 2026): ECS replaced the production worker task during the run, and the guard failed on one changed line, network-interface/eni-0d67\u2026 before and eni-0e2f\u2026 after. A Fargate task\u2019s elastic network interface is created and deleted with the task and carries its propagated tags, so the tagging API lists it; scenario 39 runs the guard against that shape and has to go red when interfaces are compared again.',
  },
  {
    name: 'the production guard sets aside every ec2 resource with the network interfaces',
    file: 'infra/scripts/rehearsal-prefix-guard.sh',
    find: 'parts[2] == "ec2" and parts[5].startswith("network-interface/")',
    replace: 'parts[2] == "ec2"',
    suite: ['run', 'test:release'],
    because:
      'The VPC, the subnets, the security groups, the route tables and the internet gateway are all ec2 ARNs, and they are the durable resources an interface lives in and wears. A filter that matched the service without the resource type would quietly stop measuring the production network, and scenario 39 has to go red when a replaced VPC, subnet or security group passes the guard.',
  },
  {
    name: 'the production guard stops filtering the inventory it recorded',
    file: 'infra/scripts/rehearsal-prefix-guard.sh',
    find: `      recorded="$(durable_inventory 'recorded before the run' < "$INVENTORY")"\n`,
    replace: '      recorded="$(cat "$INVENTORY")"\n',
    suite: ['run', 'test:release'],
    because:
      'The recorded file is the raw read, tasks included, so that it stays evidence of what existed and so that a file an older guard recorded compares correctly. The filter therefore has to be applied to the recorded side at comparison time as well as to the fresh read. Filter only one side and the twelve stopped tasks of run 35962272085 fail the guard again.',
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
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/fssCli.test.ts'],
    because:
      'The drill writes fourteen `fss admin` lines and the tool is the only thing that can say whether they are real. A parser that accepted everything would make a misspelt flag in the drill do nothing at all at three in the morning, so the suite that reads the drill has to go red when the refusal is gone.',
  },
  {
    name: 'the operations tool stops fixing the dependency mode per command',
    file: 'apps/worker/src/tools/fss.ts',
    find: "  if (config.dependencies !== 'recorded') {\n    return {\n      refusal: {",
    replace: '  if (false) {\n    return {\n      refusal: {',
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/fssSurface.test.ts'],
    because:
      'David fixed the dependency mode per admin command so that a restore reconstruction run from a command line can never reach live Gmail. If a `live` deployment can run `mailbox recover`, the suite that asserts the refusal must go red rather than the tool trusting that nothing downstream sends.',
  },
  {
    name: 'the journal replay stops keeping the workspaces apart',
    file: 'packages/domain/suppression/replay.ts',
    find: '    if (record.workspaceId !== context.scope.workspaceId) {',
    replace: '    if (false) {',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/restore/adminCommands.test.ts'],
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
  {
    name: 'any stage can write a release record',
    file: '.github/workflows/greenfield-release.yml',
    find: "      - name: Write the release record, last\n        if: inputs.stage == 'full'\n",
    replace: '      - name: Write the release record, last\n',
    suite: ['run', 'test:release'],
    because:
      'The `plan`, `create` and `deploy` stages exist so that a plan-time error costs a minute instead of an hour, and none of them proves what 16.2 asks of a release. The one thing they must be unable to produce is the artifact an admin points at when enabling sending, and the whole of that impossibility is this `if:`. Appendix G 42 has to go red when it goes.',
  },
  {
    name: 'a plan run applies what it planned',
    file: '.github/workflows/greenfield-release.yml',
    find: "      - name: Create the rehearsal environment\n        if: contains(fromJSON('[\"create\",\"deploy\",\"full\"]'), inputs.stage)\n",
    replace: '      - name: Create the rehearsal environment\n',
    suite: ['run', 'test:release'],
    because:
      'A `plan` stage that applied would be the opposite of the thing it was added for: the cheap, repeatable, creates-nothing run that David uses to find the next plan-time error. The condition is one line, its absence is invisible until a run creates an environment nobody asked for, and the monotonicity check is the only reader of it.',
  },
  {
    name: 'the plan summary guard stops looking for the values it holds',
    file: '.github/workflows/greenfield-release.yml',
    find: '                  if len(text) >= 8 and text in summary:\n',
    replace: '                  if False:\n',
    suite: ['run', 'test:release'],
    because:
      'The plan summary goes to the job summary and to a ninety-day artifact, and `terraform show -json` carries every value the plan resolved — the two image references, the certificate ARN and the hostname, all assembled from repository secrets. The summariser prints addresses, and this guard is the second lock on the same door; scenario 39 runs it against a summary that leaks one and must go red when it stops refusing.',
  },
  {
    name: 'a teardown run also creates the environment',
    file: '.github/workflows/greenfield-release.yml',
    find: "        if: contains(fromJSON('[\"create\",\"deploy\",\"full\"]'), inputs.stage)\n",
    replace: "        if: contains(fromJSON('[\"create\",\"deploy\",\"full\",\"teardown\"]'), inputs.stage)\n",
    suite: ['run', 'test:release'],
    because:
      'The `teardown` stage exists to remove the environment the fourth credentialed run left standing (fss-rh-202609211659), with `run_suffix` naming a prefix that already exists. A teardown that also applied would create a second environment under the orphan\'s own name and then destroy whichever of the two Terraform could see, which is the expensive mistake the stage was added to avoid. Appendix G 42 asserts that no step of a teardown run plans, applies, deploys, drills or records.',
  },
  {
    name: "the deployment role's KMS deny goes back to covering every key",
    file: 'infra/policies/deployment-role-policy.json.tftpl',
    find: '      "NotResource": "${state_kms_key_arn}",\n      "Condition": {\n        "StringNotLike": {\n          "aws:ResourceTag/NamePrefix": "${name_prefix}*"\n        }\n      }\n',
    replace: '      "Resource": "*"\n',
    suite: ['run', 'test:release'],
    because:
      'This is the 21 September failure exactly: `kms:GenerateDataKey*` and `kms:Decrypt` denied on every key but the Terraform state key, which Secrets Manager checks at CreateSecret, so all eight entries failed with "Access to KMS is not allowed" while the policy still carried an allow for them. A check that searched the document for the action would stay green; only an evaluation that reads the denies as well can go red, and that is what the coverage check does.',
  },
  {
    name: "the journal's write and read denies stop exempting the deployer",
    file: 'infra/modules/journal/main.tf',
    find: 'Condition = merge({ ArnNotLike = { "aws:PrincipalArn" = local.writer_principal_patterns } }, local.administrative_exemption)',
    replace: 'Condition = { ArnNotLike = { "aws:PrincipalArn" = local.writer_principal_patterns } }',
    suite: ['run', 'test:release'],
    because:
      'A deny that exempts the deployer from deletion but not from writes or reads is the 21 September shape with one statement fixed: the teardown could not even list the bucket versions it was about to bypass. `terraform test` proves this properly and runs in the offline gate rather than here, so the release suite asserts the merge expression verbatim and has to notice when it becomes a replacement.',
  },
  {
    name: 'the journal stops letting its deployer see that the bucket exists',
    file: 'infra/modules/journal/main.tf',
    find:
      'Condition = merge({ ArnNotLike = { "aws:PrincipalArn" = local.reader_principal_patterns } }, local.listing_exemption)',
    replace: 'Condition = { ArnNotLike = { "aws:PrincipalArn" = local.reader_principal_patterns } }',
    suite: ['run', 'test:release'],
    because:
      'This is the first production apply exactly (23 September 2026): `fss-prod-deploy` created the bucket, was refused its own HeadBucket \u2014 which S3 authorises as `s3:ListBucket` \u2014 and the provider read the 403 as "the bucket is gone", dropped it from state, planned to create it again and deleted the encryption configuration and the ownership controls on the way past. `terraform test` proves the rendered condition and runs in the offline gate rather than here, so the release suite asserts the merge expression verbatim and has to notice when the exemption leaves it.',
  },
  {
    name: 'sign-in stops adopting the workspace the operator bootstrapped',
    file: 'apps/api/src/auth/signIn.ts',
    find: '      WHERE google_sub = $4 || $2\n',
    replace: '      WHERE google_sub = $1\n',
    suite: ['run', 'test:release'],
    because:
      '`fss admin workspace bootstrap` writes the first admin\u2019s users row with a sentinel google_sub, because the real Google sub cannot be known before that person signs in. This UPDATE is the only thing that turns it into a real account; without it the first sign-in inserts a *second* users row, the membership still hangs off the first, and the person is refused membership_required for ever \u2014 which from outside is indistinguishable from having no access. The release check reads the statement and its NOT EXISTS guard.',
  },
  {
    name: 'discovery goes back to requiring every endpoint at the issuer origin',
    file: 'apps/api/src/auth/googleClient.ts',
    find:
      "  if (url.origin === issuer.origin) return true;\n  if (url.protocol !== 'https:') return false;\n  return url.hostname === issuer.hostname || url.hostname.endsWith('.googleapis.com');\n",
    replace: '  return url.origin === issuer.origin;\n',
    suite: ['run', 'test:release'],
    because:
      'This is production\u2019s first real sign-in exactly (24 September 2026): four refusals `token_exchange_failed`, because Google\u2019s discovery document names its token endpoint on oauth2.googleapis.com and its key set on www.googleapis.com while the issuer is accounts.google.com, so the same-origin rule answered null and the exchange never ran. The rehearsal has no real Google and the lane tests\u2019 local provider serves every endpoint from one origin, so scenario23 asserts the rule against Google\u2019s real hosts and has to go red when it is put back.',
  },
  {
    name: 'discovery stops requiring HTTPS for a Google API host',
    file: 'apps/api/src/auth/googleClient.ts',
    find: "  if (url.protocol !== 'https:') return false;\n",
    replace: '',
    suite: ['run', 'test:release'],
    because:
      'Widening the rule to Google\u2019s API hosts must not widen it to plain HTTP: a document naming http://oauth2.googleapis.com/token would send the code and the client secret in the clear to whoever is on the path. scenario23\u2019s refusal case includes exactly that endpoint and has to go red.',
  },
  {
    name: 'the id token accepts any issuer',
    file: 'apps/api/src/auth/idToken.ts',
    find: '  if (claimed === null) return false;\n  if (claimed === configured) return true;\n',
    replace: '  return true;\n',
    suite: ['run', 'test:release'],
    because:
      'Widening the issuer check to the two forms Google documents (`https://accounts.google.com` and `accounts.google.com`, 24 September 2026) must not widen it to everything: a validator that accepts any `iss` accepts a token some other issuer signed with a key that happens to be served. scenario23 validates otherwise-perfect tokens whose only fault is the issuer and has to go red.',
  },
  {
    name: 'a deploy stage stops bootstrapping the first workspace',
    file: '.github/workflows/greenfield-release.yml',
    find:
      "      - name: Bootstrap the rehearsal workspace and its admin\n        if: contains(fromJSON('[\"deploy\",\"full\"]'), inputs.stage)\n",
    replace: "      - name: Bootstrap the rehearsal workspace and its admin\n        if: inputs.stage == 'teardown'\n",
    suite: ['run', 'test:release'],
    because:
      'Run 35919040315 (23 September 2026) passed create, fill, the deploy path and the schema-range refusals and then failed the smoke: no CanaryCompletionAgeSeconds datapoint in ten minutes, because the canary source is per workspace and a fresh database has none. A deploy that skips this step reproduces that failure exactly, and the step\u2019s stage condition is the whole of the difference.',
  },
  {
    name: 'the drill evidence seeder stops refusing a production prefix',
    file: 'infra/scripts/release-seed-drill-evidence.sh',
    find: 'rehearsal_require_prefix "$PREFIX"\n',
    replace: 'release_environment_for_prefix "$PREFIX" >/dev/null\n',
    suite: ['run', 'test:release'],
    because:
      'This script writes a firm, a contact, an accepted send, two prospect suppressions and a salesperson\u2019s own suppression. Production\u2019s restore drill (runbook section 7) reconstructs a salesperson\u2019s real activity, so seeding it would replace the thing being proved with the thing proving it. `release_environment_for_prefix` classifies and permits `fss-prod`, which is right for the two scripts that genuinely run in both environments and catastrophic here \u2014 and the difference is invisible unless something runs the script with a production prefix and requires it to refuse.',
  },
  {
    name: 'the canary metric goes back to measuring the gap between completions',
    file: 'packages/domain/jobs/canary.ts',
    find:
      '    `WITH newest_per_workspace AS (\n       SELECT DISTINCT ON (workspace_id) inserted_at, completed_at\n         FROM canary_runs\n        ORDER BY workspace_id, inserted_at DESC\n     )\n     SELECT max(extract(epoch FROM coalesce(completed_at, now()) - inserted_at))::text AS age_seconds\n       FROM newest_per_workspace`,\n',
    replace:
      "    'SELECT extract(epoch FROM now() - max(completed_at))::text AS age_seconds FROM canary_runs',\n",
    suite: ['run', 'test:release'],
    because:
      'This is the first production smoke exactly (23 September 2026): `FAIL canary (age=359.441672s limit=300s)` against a production completing its canaries in seconds. The canary is inserted once per quarter hour, so seconds-since-the-newest-completion sawtooths 59, 119, \u2026, 419 and back to 59 and sits above the 300 the smoke and `fss-prod-canary-stale` compare against for about ten minutes in every fifteen \u2014 the smoke fails most of the time and the alarm flaps into the operator\u2019s inbox. `test/release/canaryAge.check.ts` reads the query and has to go red when the latency expression is replaced by the age one, because a threshold that is right for a latency is nonsense for a sawtooth.',
  },
  {
    name: 'the Mac stops opening the Gmail consent screen',
    file: 'apps/desktop/src/main/mailboxBridge.ts',
    find: '        await deps.openExternally(url);\n',
    replace: '',
    suite: ['run', 'test:release', '--', 'test/release/desktopMailbox.check.ts'],
    because:
      'This is production\u2019s first sign-in exactly (24 September 2026, 15:08Z): desktop 1.0.0 signed in and had no way to connect Gmail, because nothing in apps/desktop called POST /gmail/connect or opened the consent URL it returns. A bridge that sends the command and never opens the browser is the same outcome with more code, and a check that searched for the path would stay green; desktopMailbox.check.ts drives the bridge and asserts the URL reached the system browser, so it has to go red.',
  },
  {
    name: 'the preload stops exposing the mailbox bridge to the window',
    file: 'apps/desktop/src/preload/preload.ts',
    find: "contextBridge.exposeInMainWorld('callieMailbox', mailbox);\n",
    replace: '',
    suite: ['run', 'test:release', '--', 'test/release/desktopMailbox.check.ts'],
    because:
      'The bridge can be complete and tested and the This Mac card still have nothing to call, which is 1.0.0 from where David sits. The preload is Electron wiring the release suite cannot run, so desktopMailbox.check.ts asserts the exposure line itself and has to go red when it is gone.',
  },
  {
    name: 'the API stops admitting the desktop build that carries the Mailbox row',
    file: 'apps/api/src/bootstrap/main.ts',
    find: "  maximum: '1.0.1',\n",
    replace: "  maximum: '1.0.0',\n",
    suite: ['run', 'test:release', '--', 'test/release/desktopMailbox.check.ts'],
    because:
      'A client above the published maximum is api_behind_client, and runCommand, sign-in and renewal refuse it client_upgrade_required exactly as they refuse one below the minimum. Desktop 1.0.1 is the build with Connect Gmail, so an API still publishing 1.0.0 as its maximum refuses the fix outright; desktopMailbox.check.ts reads the constant the container serves and has to go red.',
  },
  {
    name: 'the Gmail watch gauge goes back to a unit CloudWatch does not have',
    file: 'packages/domain/mail/metrics.ts',
    find: "value: Math.max(watchHours, 0), unit: 'None' });\n",
    replace: "value: Math.max(watchHours, 0), unit: 'Hours' as 'None' });\n",
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/jobs/metricUnits.test.ts'],
    because:
      'This is production on 24 September 2026 from 18:11Z: the first connected mailbox added GmailWatchHoursToExpiry in Hours, PutMetricData rejected the whole batch every minute, and every FSS worker metric went dark. The cast defeats the type, which is exactly how a unit slips past the compiler, so metricUnits.test.ts reads every datum literal in the source against the CloudWatch set and has to go red.',
  },
  {
    name: 'a failed metric publication counts against the worker liveness file again',
    file: 'apps/worker/src/bootstrap/worker.ts',
    find: "    onError: error => logLoopFailure('metrics', error),\n",
    replace: "    onError: onError('metrics'),\n",
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/workerProcess.test.ts'],
    because:
      'On 24 September 2026 three refused publications removed /tmp/fss-worker-heartbeat and ECS stopped fss-prod-worker at 18:15Z for failed health checks, then its replacement, while the scheduler and runners were healthy. workerProcess.test.ts refuses every publication with a liveness threshold of one and has to go red when the file disappears.',
  },
  {
    name: 'a rejected CloudWatch batch is no longer retried one datum at a time',
    file: 'packages/domain/jobs/metricsCloudWatch.ts',
    find: '        if (batch.length === 1) {\n',
    replace: '        if (batch.length >= 1) {\n',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/jobs/metricsCloudWatch.test.ts'],
    because:
      'CloudWatch rejects the whole request over one bad member, so without the per-datum retry one refused datum silences the heartbeats beside it, which is the blackout of 24 September. metricsCloudWatch.test.ts rejects any request carrying one named metric and has to go red when the others are not published.',
  },
  {
    name: 'the drill stops making its own reports directory',
    file: 'apps/worker/src/tools/fss/drill.ts',
    find: '    await mkdir(directory, { recursive: true, mode: 0o700 });\n',
    replace: '',
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/fssSurface.test.ts'],
    because:
      "This is the thirteenth full run exactly (24 September 2026): the drill task exited 21 on ENOENT opening /tmp/fss-drill/step0-baseline.json, because nothing in the image or the task definition creates the reports directory. fssSurface.test.ts points --reports at a directory that does not exist and expects the drill to reach step 1, so it has to go red when the directory is not made.",
  },
  {
    name: 'the restore drill launches the drill with an instant again instead of the source baseline',
    file: 'infra/scripts/rehearsal-restore-drill.sh',
    find: '    --baseline-json "$BASELINE_JSON" \\\n',
    replace: '    --as-of "$RESTORE_TARGET" \\\n',
    suite: ['run', 'test:release', '--', 'test/release/scenario11.check.ts'],
    because:
      'Launched with --as-of, the drill measures step 0 again on the restored copy, so "no suppression lost" is compared with the restored database rather than with the source baseline measured before the restore (lane g53). The dry run prints only the plan line, so scenario 11 reads the real drill_task launch through the extractor and has to go red when it passes an instant.',
  },
  {
    name: 'the rehearsal smoke reads the canary age from the bare FSS namespace again',
    file: '.github/workflows/greenfield-release.yml',
    find: '            age="$(aws cloudwatch get-metric-statistics --namespace "$namespace" \\\n',
    replace: '            age="$(aws cloudwatch get-metric-statistics --namespace FSS \\\n',
    suite: ['run', 'test:release', '--', 'test/release/metricNamespace.check.ts'],
    because:
      'This is the tenth full rehearsal exactly (run 35943001092, 23 September 2026): the smoke failed in two seconds on a canary age of 837.9 s that was production\u2019s, because every environment in the account published into the bare FSS namespace and the smoke read it. The step still reads the run\u2019s namespace from the root output and still checks it, so a check that only looked for the output would stay green; metricNamespace.check.ts reads the query itself and has to go red.',
  },
  {
    name: 'the mutation runner reads any non-zero exit as a kill again',
    file: 'scripts/releaseMutationRunner.mjs',
    find: "  if (run.signal) return { verdict: 'broken', reason: `npm was stopped by ${String(run.signal)}` };\n",
    replace:
      "  if (run.signal) return { verdict: 'broken', reason: `npm was stopped by ${String(run.signal)}` };\n  if (run.status !== 0) return { verdict: 'red', reason: 'a non-zero exit' };\n",
    suite: ['run', 'test:release', '--', 'test/release/mutationRunner.check.ts'],
    because:
      'This is how ten mutations were counted as killed from 20 September 2026 until lane g54: their suites had no `run test`, npm answered "Unknown command" and exited 1, and a runner that reads only the exit status called that a failing test. mutationRunner.check.ts feeds the runner that exact npm output, and a setup that never reached a test, and has to go red when either is read as a kill.',
  },
  {
    name: 'the mutation runner runs the mutations of a suite that was red before any mutation',
    file: 'scripts/releaseMutationRunner.mjs',
    find: "    if (before?.verdict !== 'green') {\n",
    replace: '    if (false) {\n',
    suite: ['run', 'test:release', '--', 'test/release/mutationRunner.check.ts'],
    because:
      'A worktree whose embedded PostgreSQL was never hydrated fails every suite in its globalSetup, and on 24 September 2026 the check reported 67 kills and no problems in 33 seconds from exactly that. A suite that is red before anything is broken cannot be red because something was, so its mutations must be reported rather than run; mutationRunner.check.ts gives the runner such a suite and has to go red when a kill is counted from it.',
  },
  {
    name: 'registering a sending domain inserts nothing again',
    file: 'packages/domain/outbound/domainGuard.ts',
    find:
      '      `INSERT INTO sending_domains (workspace_id, domain, is_primary)\n       VALUES ($1::uuid, $2::text, NOT EXISTS (\n         SELECT 1 FROM sending_domains WHERE workspace_id = $1::uuid AND is_primary\n       ))\n       ON CONFLICT DO NOTHING\n       RETURNING ${DOMAIN_COLUMNS}`,\n',
    replace:
      '      `SELECT ${DOMAIN_COLUMNS} FROM sending_domains WHERE false AND workspace_id = $1::uuid AND domain = $2::text`,\n',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/outbound/sendingDomainRegistration.test.ts'],
    because:
      'This is production on 24 September 2026 (lane g57): the admin had verified SPF, DKIM, DMARC and Postmaster Tools for usecallie.com and Administration read "No sending domain is configured." because nothing in the tree inserted a sending_domains row, and recordAuthenticationChecklist is an UPDATE that answers domain_unknown without one. An idempotence test passes against a function that inserts nothing and reports what it finds, so sendingDomainRegistration.test.ts asserts `created`, reads the primary back and records the checklist on it, and has to go red.',
  },
  {
    name: 'the Gmail callback stops registering the connected mailbox\u2019s domain',
    file: 'apps/api/src/routes/gmail.ts',
    find: '    await registerConnectedDomain(auth.db, scoped.context, outcome.value, options.log);\n',
    replace: '',
    suite: ['run', 'test', '--workspace', 'apps/api', '--', 'test/sendingDomain.test.ts'],
    because:
      'A connected mailbox\u2019s domain is the workspace\u2019s sending domain, and the callback is the only zero-step path to the row 12.7\u2019s checklist is recorded against (lane g57). Without the call the consent page still says "Gmail connected" and every status check still passes, so sendingDomain.test.ts reads sending_domains back after a real callback and has to go red when no row appears.',
  },
];

// A listener on each of these keeps Node from exiting mid-mutation with a file still
// broken; the check stops after restoring it instead. An interactive Ctrl-C reaches the
// suite's npm as well, which ends that run at once.
let stopRequested = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    stopRequested = true;
  });
}

const { problems } = await runMutationCheck({
  mutations: MUTATIONS,
  runSuite: suite => spawnSuite(ROOT, suite),
  readFile: file => readFileSync(`${ROOT}${file}`, 'utf8'),
  writeFile: (file, text) => writeFileSync(`${ROOT}${file}`, text),
  log: line => console.error(line),
  stopRequested: () => stopRequested,
});
process.exitCode = problems === 0 ? 0 : 1;
