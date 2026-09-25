// Release mutations that edit the release and rehearsal scripts and the release suite (`infra/scripts/`, `scripts/`, `test/release/`).
//
// Loaded by `loadMutations` in scripts/releaseMutationRunner.mjs, which also holds the
// rule that decides an entry's area (MUTATION_AREAS). Each entry's fields are described
// at the top of scripts/releaseMutationCheck.mjs. Append to the end of this file.

/** @type {import('../releaseMutationRunner.mjs').Mutation[]} */
export const MUTATIONS = [
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
    name: 'the scenario map loses a scenario',
    file: 'test/release/support/scenarioMap.ts',
    kind: 'wiring',
    find: '  {\n    number: 42,',
    replace: '  /* removed by the mutation check */ {\n    number: 43,',
    suite: ['run', 'test:release'],
    because:
      'The map is the index from Appendix G to its proof. A scenario that fell off it silently would be a scenario nobody runs, so the map must assert its own completeness against the literal range 1 to 42.',
  },
  {
    name: 'a rehearsal-only scenario loses its script',
    file: 'test/release/support/scenarioMap.ts',
    kind: 'wiring',
    find: "    script: 'infra/scripts/rehearsal-restore-drill.sh',",
    replace: '',
    suite: ['run', 'test:release'],
    because:
      'A rehearsal-only scenario with no script is a scenario the workflow never runs, which would leave Appendix G 11 unproved while the suite stayed green.',
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
    name: 'the drill evidence seeder stops refusing a production prefix',
    file: 'infra/scripts/release-seed-drill-evidence.sh',
    find: 'rehearsal_require_prefix "$PREFIX"\n',
    replace: 'release_environment_for_prefix "$PREFIX" >/dev/null\n',
    suite: ['run', 'test:release'],
    because:
      'This script writes a firm, a contact, an accepted send, two prospect suppressions and a salesperson\u2019s own suppression. Production\u2019s restore drill (runbook section 7) reconstructs a salesperson\u2019s real activity, so seeding it would replace the thing being proved with the thing proving it. `release_environment_for_prefix` classifies and permits `fss-prod`, which is right for the two scripts that genuinely run in both environments and catastrophic here \u2014 and the difference is invisible unless something runs the script with a production prefix and requires it to refuse.',
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
    name: 'the restore drill launches the drill without a pin again',
    file: 'infra/scripts/rehearsal-restore-drill.sh',
    find: '    --expected-generation "$EXPECTED_GENERATION" \\\n',
    replace: '',
    suite: ['run', 'test:release', '--', 'test/release/scenario11.check.ts'],
    because:
      'Without --expected-generation the drill runs no generation check against the restored copy, which carries its source’s generation, so nothing opens a restore hold and step 1 fails as it did in run 36062337914. The dry run prints only the plan line, so scenario 11 reads the real drill_task launch through the extractor and has to go red when the pin is dropped from it.',
  },
  {
    name: 'the runner reads any alarm history as the alarm having fired',
    file: 'infra/scripts/rehearsal-restore-drill.sh',
    find: '    if (data.get("newState") or {}).get("stateValue") == "ALARM":\n',
    replace: '    if True:\n',
    suite: ['run', 'test:release', '--', 'test/release/scenario11.check.ts'],
    because:
      'restore-drill.md step 1 says the alarm must have fired, and a check that passes on any history, an OK transition included, never looks. scenario11.check.ts hands the runner a history whose only transition is to OK and has to go red when that passes.',
  },
  {
    name: 'the runner reads a drill that ran to the end as a pass whatever it could not answer',
    file: 'infra/scripts/rehearsal-restore-drill.sh',
    find: 'assert not unanswered, f"the drill could not answer',
    replace: 'assert True or not unanswered, f"the drill could not answer',
    suite: ['run', 'test:release', '--', 'test/release/scenario11.check.ts'],
    because:
      'A report with stoppedAt null and one unanswered step passes every other assertion the runner makes once that step is absent from the required list or tolerated. scenario11.check.ts hands the runner such a report and has to go red when it passes.',
  },
  {
    name: 'the restore drill launches the drill without the counts at the moment of failure',
    file: 'infra/scripts/rehearsal-restore-drill.sh',
    find: '    --at-failure-json "$AT_FAILURE_JSON" \\\n',
    replace: '',
    suite: ['run', 'test:release', '--', 'test/release/scenario11.check.ts'],
    because:
      'The runner measures the at-failure counts on the source and the plan line prints them, so a real launch that dropped the flag would read as handed over. scenario11.check.ts reads the real drill_task launch through the extractor and has to go red.',
  },
  {
    name: 'the restore drill launches the drill without the mailbox recording',
    file: 'infra/scripts/rehearsal-restore-drill.sh',
    find: '    --mailbox-recording-json "$MAILBOX_RECORDING_JSON" \\\n',
    replace: '',
    suite: ['run', 'test:release', '--', 'test/release/scenario11.check.ts'],
    because:
      'Without the recording the drill task runs its mail steps against the empty fixture every recorded deployment is handed, and step 3 finds no Sent message to reconcile. scenario11.check.ts reads the real drill_task launch through the extractor and has to go red.',
  },
  {
    name: 'the drill runner accepts a dial refused with no restore hold behind it',
    file: 'infra/scripts/rehearsal-restore-drill.sh',
    find: 'assert "restore_in_progress" in (dial.get("holds") or []), f"the dial was refused ({dial.get(\'reason\')}) but no restore hold applied to it, so the refusal says nothing about the restore: {dial}"\n',
    replace: '',
    suite: ['run', 'test:release', '--', 'test/release/scenario11.check.ts'],
    because:
      'The runner reads the report and decides the pass so that a change to the tool cannot quietly relax the gate; a runner that asked only for allowed false would pass a probe refused at step 6. scenario11.check.ts hands the runner such a report and has to go red.',
  },
  // Lane g70: a schema release stops before the apply, and the deploy refuses otherwise.
  {
    name: 'a schema-change deploy migrates under an API that is still running',
    file: 'infra/scripts/release-deploy.sh',
    find: '  release_require_service_stopped "$ENVIRONMENT" "$CLUSTER_ARN" "$API_SERVICE" || refuse_not_stopped "$API_SERVICE"\n',
    replace: '',
    suite: ['run', 'test:release'],
    because:
      'By the time release-deploy.sh runs, the apply has registered task definitions whose strict range refuses the schema the database is still at, which is the order the 25 September schema-16 deploy ran in (release.md 8.0af). Step 1 is the only thing between a running API and a migration under it, and it must refuse rather than scale. scenario22 drives the script against a fake ECS with the API running and requires no run-task; without this line the migration launches and it has to go red.',
  },
  {
    name: 'release-deploy.sh ignores --release-record and stores nothing',
    file: 'infra/scripts/release-deploy.sh',
    find: 'RELEASE_RECORD_OUTCOME=none\nif [ -n "$RELEASE_RECORD" ]; then\n',
    replace: 'RELEASE_RECORD_OUTCOME=none\nif false; then\n',
    suite: ['run', 'test:release', '--', 'test/release/scenario42.check.ts'],
    because:
      'The production operator passes the green rehearsal record to the deploy, and the enable rule refuses a reference no stored record carries, so a deploy that accepted the flag and skipped the put would leave sending impossible to enable with nothing saying why. scenario42.check.ts dry-runs the deploy with the flag and requires the put after the final verify, and has to go red.',
  },
  {
    name: 'the monthly pin takes the newest ancestor’s images whatever its image inputs',
    file: 'infra/scripts/release-images.sh',
    find: '    if git diff --quiet "$head" "$commit" -- "${IMAGE_INPUTS[@]}"; then\n',
    replace: '    if true; then\n',
    suite: ['run', 'test:release', '--', 'test/release/rehearsalCadence.check.ts'],
    because:
      'This is audit O10’s pinned-artifact rule (lane g74): the images workflow publishes only when an image input changes, so the monthly run may pin an earlier commit’s images only when every input is byte-identical to its own. Without the comparison a commit that changed packages/ and whose publish failed is rehearsed on the previous code’s images, and the manifest calls that a pass. rehearsalCadence.check.ts pins an unpublished image change against a real history and has to go red.',
  },
  {
    name: 'the monthly slot runs again every hour after an earlier run already pinned',
    file: 'infra/scripts/ci-schedule.sh',
    find: '    if job.get("name") == os.environ["FSS_PIN_JOB"] and job.get("conclusion") != "skipped":\n',
    replace: '    if False:\n',
    suite: ['run', 'test:release', '--', 'test/release/rehearsalCadence.check.ts'],
    because:
      'The monthly drill wakes every hour on Sunday so that a dropped schedule event is caught up (the nightly’s 25 September event never fired). Without the earlier-attempt check every later hour starts another full rehearsal — up to fifteen of them, queued behind one concurrency group, each an hour of rehearsal spend. rehearsalCadence.check.ts runs the slot after a run that pinned, failed or is still going and has to go red.',
  },
  {
    name: 'the freshness check calls every nightly fresh whatever its age',
    file: 'infra/scripts/ci-schedule.sh',
    find: '        fresh = age <= limit\n',
    replace: '        fresh = True\n',
    suite: ['run', 'test:release', '--', 'test/release/rehearsalCadence.check.ts'],
    because:
      'This is audit O11: a scheduled run that never started sends no failure e-mail, so the age comparison is the whole alarm. A check that cannot find anything stale is the silence of 25 September with a green tick beside it. rehearsalCadence.check.ts gives it a nightly 36 hours old and requires a failure and one opened issue, and has to go red.',
  },
  {
    name: 'the manifest verifies against a release record it was not written for',
    file: 'infra/scripts/release-manifest.sh',
    find: 'if bound.get("sha256") != env["FSS_RECORD_SHA256"]:\n',
    replace: 'if False:\n',
    suite: ['run', 'test:release', '--', 'test/release/releaseManifest.check.ts'],
    because:
      'This is audit O09: the manifest binds the release record by its SHA-256 so that neither file can be replaced under the other. Every other field it compares can agree while the record says something else — releaseManifest.check.ts flips one flag the other comparisons do not read — so without the hash the binding is the reference and two digests again. It has to go red.',
  },
  {
    name: 'a pinned manifest stops comparing the images’ inputs with the checkout',
    file: 'infra/scripts/release-manifest.sh',
    find: '    git diff --quiet "$images_commit" "$checkout" -- "${inputs[@]}" \\\n',
    replace: '    true \\\n',
    suite: ['run', 'test:release', '--', 'test/release/releaseManifest.check.ts'],
    because:
      'A weekly manifest says inputsMatchCheckout: true, which is the claim that the suite ran the code inside the images. The pin checked it once; the manifest checks it again in the job that actually ran the suite, so a pin and a checkout that drifted apart cannot produce that sentence. releaseManifest.check.ts builds images before a certificate change and has to go red.',
  },
  {
    name: 'the manifest records a production deployment that runs another image',
    file: 'infra/scripts/release-manifest.sh',
    find: '    elif digest != expected:\n',
    replace: '    elif False:\n',
    suite: ['run', 'test:release', '--', 'test/release/releaseManifest.check.ts'],
    because:
      'The deployed section is the last link of O09: what production runs, compared with what was rehearsed. Recording a mismatch as a deployment turns “the deployed digests match the rehearsal artifacts” (16.2) back into something a person reads. releaseManifest.check.ts answers describe-task-definition with another worker digest, requires nothing written, and has to go red.',
  },
  {
    name: 'the promotion trusts the copy instead of reading production back',
    file: 'infra/scripts/release-promote.sh',
    find: '  if [ "$copied" != "$digest" ]; then\n',
    replace: '  if false; then\n',
    suite: ['run', 'test:release', '--', 'test/release/releaseManifest.check.ts'],
    because:
      'This is audit O17’s promise: the digest production deploys is the digest that passed. imagetools create re-serialises a manifest it is asked to change, and a tag can land on something else; the read-back is the only thing that notices. releaseManifest.check.ts makes the stubbed copy change the digest and has to go red.',
  },
  {
    name: 'an app-only deploy launches a one-off task again',
    file: 'infra/scripts/release-deploy.sh',
    find: '  rehearsal_log "2/3 wait until both are stable"\n',
    replace:
      '  one_off migrate "$MIGRATION_TASK_DEFINITION" migration migrate --report /tmp/fss-migrate.json\n  rehearsal_log "2/3 wait until both are stable"\n',
    suite: ['run', 'test:release', '--', 'test/release/scenario22.check.ts'],
    because:
      'Audit item O03: a release with no --schema-change launched four administrative one-off tasks (migrate, database users, verify twice) that an app-only release does not need, each a chance to fail a deploy that changes no schema. scenario22 drives the rolling path against a fake ECS and requires no run-task at all, and has to go red when one comes back.',
  },
  {
    name: 'an app-only deploy forces a second rollout after the apply’s again',
    file: 'infra/scripts/release-deploy.sh',
    find: '--service "$WORKER_SERVICE" --desired-count "$WORKER_TARGET" \\\n',
    replace: '--service "$WORKER_SERVICE" --desired-count "$WORKER_TARGET" --force-new-deployment \\\n',
    suite: ['run', 'test:release', '--', 'test/release/scenario22.check.ts'],
    because:
      'The apply that registers the new task definitions has already started the rolling deployment; forcing another one replaces every task it just started and doubles the rollout (O03). scenario22 reads every update-service the rolling path makes and has to go red on a forced one.',
  },
  {
    name: 'the running-digest check stops comparing the digest a task runs with the release',
    file: 'infra/scripts/release-common.sh',
    find: '    elif running != digest:\n',
    replace: '    elif False:\n',
    suite: ['run', 'test:release', '--', 'test/release/scenario22.check.ts'],
    because:
      'Audit item O08: services-stable is also what a service the circuit breaker rolled back to the previous revision reports, so a deploy that ended there reported success on the old image. scenario22 leaves the API stable on another digest and requires the deploy to fail naming both, and has to go red.',
  },
  {
    name: 'the running-digest check passes over fewer tasks than the root declares',
    file: 'infra/scripts/release-common.sh',
    find: 'if len(tasks) != expected:\n',
    replace: 'if False:\n',
    suite: ['run', 'test:release', '--', 'test/release/scenario22.check.ts'],
    because:
      '"Every running task carries the digest" is true of no running tasks at all, which is the vacuous pass a rolled-back or crash-looping service would give. scenario22 lets ECS take the count and start nothing, requires "0 task(s) are RUNNING and the root declares 1", and has to go red.',
  },
  {
    name: 'a one-off task whose image could not be pulled is not launched again',
    file: 'infra/scripts/release-common.sh',
    find: '    if pull_reason="$(release_pull_failure "$described")"; then\n',
    replace: '    if false; then\n',
    suite: ['run', 'test:release', '--', 'test/release/oneOffTaskRecords.check.ts'],
    because:
      'Audit item O06: a CannotPullContainerError minutes after an ECR copy stopped a production one-off before any container ran, and clearing it took a person. oneOffTaskRecords.check.ts answers the first launch with that error and the second with exit 0, requires two launches and a pass, and has to go red.',
  },
  {
    name: 'the wrapper launches again after any failure that left no exit code',
    file: 'infra/scripts/release-common.sh',
    find: '    if "CannotPullContainerError" in reason:\n',
    replace: '    if True:\n',
    suite: ['run', 'test:release', '--', 'test/release/oneOffTaskRecords.check.ts'],
    because:
      'Only a pull failure is proven to be the registry catching up. A secret with no value, which also stops a task before any container runs, is a release that is wrong, and launching it three times hides that for minutes. oneOffTaskRecords.check.ts requires one launch for it and has to go red.',
  },
  {
    name: 'a recorded one-off task is waited on whatever invocation recorded it',
    file: 'infra/scripts/release-common.sh',
    find: '      if [ "$recorded_fingerprint" = "$fingerprint" ]; then\n',
    replace: '      if true; then\n',
    suite: ['run', 'test:release', '--', 'test/release/oneOffTaskRecords.check.ts'],
    because:
      'Audit item O07: the record was keyed by the step name alone, so a reports directory reused by another release, command or task definition revision read that task’s verdict as its own. oneOffTaskRecords.check.ts leaves another release’s passing task recorded and requires this one to launch its own and fail, and has to go red.',
  },
  {
    name: 'a one-off task record stays after its outcome was read',
    file: 'infra/scripts/release-common.sh',
    find: '    release_retire_task_record "$record" "read_verdict_$verdict"\n',
    replace: '',
    suite: ['run', 'test:release', '--', 'test/release/oneOffTaskRecords.check.ts'],
    because:
      'The restore drill’s step 7 runs rehearsal-schema-ranges.sh again, under the same step names, and a record kept after its verdict was read made that second run judge the first run’s tasks. oneOffTaskRecords.check.ts runs one step twice, passing then failing, requires two launches and the failure, and has to go red.',
  },
  {
    name: 'the production smoke requires sending to be disabled again, whatever it was told',
    file: 'scripts/productionSmoke.mjs',
    find: "      typeof enabled === 'boolean' && enabled === (expectation === 'enabled'),\n",
    replace: '      enabled === false,\n',
    suite: ['run', 'test:release', '--', 'test/release/productionSmoke.check.ts'],
    because:
      'Audit item O12: once section 6 turns sending on, a smoke that only passes on sendingEnabled=false fails every ordinary deployment for being right. productionSmoke.check.ts runs --expect-sending enabled against an enabled deployment and has to go red.',
  },
  {
    name: 'the mutation runner counts a mutated file that did not parse as a kill again',
    file: 'scripts/releaseMutationRunner.mjs',
    find: '  if (syntax !== null) {\n',
    replace: '  if (false) {\n',
    suite: ['run', 'test:release', '--', 'test/release/mutationRunner.check.ts'],
    because:
      'Audit item T01: a test that failed because the script it ran would not parse is a failing test for the wrong reason, and a mutation that broke the syntax proves nothing about the trap. mutationRunner.check.ts feeds the runner a failed test over a node SyntaxError and a bash syntax error, requires a broken run, and has to go red.',
  },
  {
    name: 'the mutation runner counts a failed test file with no failed test as a kill again',
    file: 'scripts/releaseMutationRunner.mjs',
    find: '  if (!testFailed && !(errors && testsRan)) {\n',
    replace: '  if (false) {\n',
    suite: ['run', 'test:release', '--', 'test/release/mutationRunner.check.ts'],
    because:
      'Audit item T01 exactly: "Test Files 1 failed" beside "Tests no tests", or beside only passing tests, is a test file that never loaded, and it was read as red. mutationRunner.check.ts gives the runner a file that failed to load beside passing ones, requires a broken run, and has to go red.',
  },
  {
    name: 'the mutation runner counts a wiring kill as a behaviour kill again',
    file: 'scripts/releaseMutationRunner.mjs',
    find: '      killedByKind[mutationKind(mutation)] += 1;\n',
    replace: '      killedByKind.behaviour += 1;\n',
    suite: ['run', 'test:release', '--', 'test/release/mutationRunner.check.ts'],
    because:
      'Audit T08: a kill of the scenario map, a script path or workflow text proves the index is checked, not that a process refuses anything, and reporting it as behaviour inflates the confidence the total reads as. mutationRunner.check.ts kills one of each kind and requires the split to say one and one.',
  },
  {
    name: 'the promotion lets buildx wrap a bare manifest in a new index again',
    file: 'infra/scripts/release-promote.sh',
    find: '  promote_docker buildx imagetools create --tag "$destination_uri:$TAG" --prefer-index=false "$source_uri@$digest" >/dev/null\n',
    replace: '  promote_docker buildx imagetools create --tag "$destination_uri:$TAG" "$source_uri@$digest" >/dev/null\n',
    suite: ['run', 'test:release', '--', 'test/release/releaseManifest.check.ts'],
    because:
      'Lane g86: the images workflow pushes a bare OCI manifest, and imagetools create wraps a single bare source in a new index unless told --prefer-index=false, so the tag named another digest and the promotion of e220f468 was refused on 25 September. releaseManifest.check.ts runs the copy against a stub that wraps exactly as buildx does and requires a plain copy with nothing tagged in place.',
  },
  {
    name: 'the promotion leaves the image a wrapping copy pushed untagged',
    file: 'infra/scripts/release-promote.sh',
    find: '    tagged="$(tag_in_place "$destination_repository" "$digest" "$media_type")"\n    rehearsal_log "$destination_repository:$tagged = $digest, the digest that passed ($TAG names the wrapper)"\n',
    replace: '    tagged=$TAG\n    rehearsal_log "$destination_repository:$tagged = $digest, the digest that passed ($TAG names the wrapper)"\n',
    suite: ['run', 'test:release', '--', 'test/release/releaseManifest.check.ts'],
    because:
      'Lane g86: after a wrapping copy the image itself is in production with no tag, and the lifecycle policy expires untagged images while a running task definition still names that digest. releaseManifest.check.ts requires the image to be tagged in place, by its own manifest and --image-digest, and read back.',
  },
  {
    name: 'an untagged image already in production is taken for a finished copy',
    file: 'infra/scripts/release-promote.sh',
    find: '    held="$(tag_of_digest "$destination_repository" "$digest")"\n    if [ -n "$held" ]; then\n',
    replace: '    held="$(tag_of_digest "$destination_repository" "$digest")"\n    if true; then\n',
    suite: ['run', 'test:release', '--', 'test/release/releaseManifest.check.ts'],
    because:
      'Lane g86: the refused promotion of e220f468 left the API image in fss-prod-api untagged beside the wrapper, and a promotion that stops at "already present" would leave it to expire. releaseManifest.check.ts starts from that state and requires it tagged in place.',
  },
];
