// Release mutations that edit the worker and the `fss` tool (`apps/worker/`).
//
// Loaded by `loadMutations` in scripts/releaseMutationRunner.mjs, which also holds the
// rule that decides an entry's area (MUTATION_AREAS). Each entry's fields are described
// at the top of scripts/releaseMutationCheck.mjs. Append to the end of this file.

/** @type {import('../releaseMutationRunner.mjs').Mutation[]} */
export const MUTATIONS = [
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
    name: 'the tool demands the runtime connection for migrate again',
    file: 'apps/worker/src/tools/fss.ts',
    find: "readToolConfig(environment, { runtimeConnection: migrationIdentity ? 'optional' : 'required' })",
    replace: 'readToolConfig(environment)',
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/fssTool.test.ts'],
    because:
      'The migration task definition injects MIGRATION_DATABASE_SECRET and no DATABASE_SECRET_ARN (tests/migration_identity.tftest.hcl). Runs 35812168524 and 35817370929 of 23 September 2026 exited 20 before touching the database because the tool read the runtime connection first for every command.',
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
    name: 'the bootstrap stops preferring the task environment over the secret',
    file: 'apps/worker/src/bootstrap/deployment.ts',
    find: '  const fromEnvironment = environment[variableName]?.trim();\n  if (fromEnvironment !== undefined && fromEnvironment.length > 0) {',
    replace: '  const fromEnvironment = environment[variableName]?.trim();\n  if (false) {',
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/deployment.test.ts'],
    because:
      'The Pub/Sub topic and the Workspace domain moved into the task environment with the secret as a one-release fallback. A reader that silently kept preferring the secret would leave the apply doing nothing, and the two sources agree in production, so only a test that sets them to different values can tell.',
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
    name: 'a failed metric publication counts against the worker liveness file again',
    file: 'apps/worker/src/bootstrap/worker.ts',
    find: "    onError: error => logLoopFailure('metrics', error),\n",
    replace: "    onError: onError('metrics'),\n",
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/workerProcess.test.ts'],
    because:
      'On 24 September 2026 three refused publications removed /tmp/fss-worker-heartbeat and ECS stopped fss-prod-worker at 18:15Z for failed health checks, then its replacement, while the scheduler and runners were healthy. workerProcess.test.ts refuses every publication with a liveness threshold of one and has to go red when the file disappears.',
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
    name: 'the worker logs a restore and opens no restore hold again',
    file: 'apps/worker/src/bootstrap/worker.ts',
    find:
      "  await enforceRestoreGeneration(sessions.scheduler, {\n    expectedGeneration: config.expectedSystemGeneration,\n    observedGeneration: startup.systemGeneration,\n    openedBy: 'worker',\n    log,\n  });\n",
    replace: '',
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/workerProcess.test.ts'],
    because:
      'This is rehearsal run 36062337914 (24 September 2026) exactly: the drill passed step 0 and stopped at step 1 because nothing anywhere opened a restore_in_progress hold, and a production restore would have held nothing. workerProcess.test.ts starts a worker pinned one generation ahead of the database and reads the holds back per workspace, so it has to go red when the startup opener is gone.',
  },
  {
    name: 'the drill ignores its pin and skips step 1a',
    file: 'apps/worker/src/tools/fss/drill.ts',
    find: '  if (expectedGeneration !== undefined) {\n',
    replace: "  if (expectedGeneration === 'never-a-flag-value') {\n",
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/fssSurface.test.ts'],
    because:
      'A drill that accepted --expected-generation and never ran the check would stop at step 1 on every run with the pin in its command line, which reads like the runner is right and the database is wrong. fssSurface.test.ts drills a database that has a workspace and no hold, with the pin one ahead, and has to go red when step 1a does not open the hold.',
  },
  {
    name: 'the drill reports a pass when a step could not be answered',
    file: 'apps/worker/src/tools/fss/drill.ts',
    find: '  const first = unanswered[0];\n  if (first !== undefined) {\n',
    replace: "  const first = unanswered[0];\n  if (first !== undefined && first.step === 'never-a-step') {\n",
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/drillRehearsal.test.ts'],
    because:
      'Lane g59 lets the drill run past a dial probe that had nothing to probe, so the steps after it are measured; that is only honest if the drill still fails. drillRehearsal.test.ts drills a restored copy whose only failing step is the unanswered probe and has to go red when that drill reports ok.',
  },
  {
    name: 'the drill stops at a probe that could not be answered, as before lane g59',
    file: 'apps/worker/src/tools/fss/drill.ts',
    find: '  steps.every(entry => entry.ok || entry.unanswered === true);\n',
    replace: '  steps.every(entry => entry.ok);\n',
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/drillRehearsal.test.ts'],
    because:
      'No firm in any environment this build makes has an assignee with a verified calling identity, so a drill that stops at the dial probe measures nothing after step 1 on any run, and every fix for steps 2 to 9 goes unproved. drillRehearsal.test.ts requires all fifteen steps in the report and has to go red when the drill stops at the probe.',
  },
  {
    name: 'a recorded deployment wraps with a per-process key again',
    file: 'apps/worker/src/bootstrap/deployment.ts',
    find: '    const recordedSeam = envelopeKeyId.length > 0;\n',
    replace: '    const recordedSeam = false;\n',
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/deployment.test.ts'],
    because:
      'localDataKeyWrapper makes a master key per process, so the refresh token the drill-evidence seed stored could not be unwrapped by fss drill in the next task, and every mailbox step of the drill failed on it (release.md 8.0s). deployment.test.ts has a second recorded deployment unwrap what the first wrapped and has to go red.',
  },
  {
    name: 'the drill stops handing step 8 the counts at the moment of failure',
    file: 'apps/worker/src/tools/fss/drill.ts',
    find: "              ...(atFailurePath === undefined ? {} : { '--at-failure': atFailurePath }),\n",
    replace: '',
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/drillRehearsal.test.ts'],
    because:
      'restore-drill.md step 8 reads --at-failure and nothing wrote it until lane g59; without it "no suppression lost" is measured against the baseline alone, which never had the suppressions recorded after the target. drillRehearsal.test.ts requires the step 8 report to carry suppressions_at_failure and has to go red.',
  },
  {
    name: 'a drill that failed prints no report again',
    file: 'apps/worker/src/tools/fss.ts',
    find: '        write(JSON.stringify(outcome.report));\n',
    replace: '',
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/fssSurface.test.ts'],
    because:
      'A one-off task keeps nothing but its log, so a drill that failed left one line naming the first failure and no record of the steps it measured, which past an unanswered step is every step. fssSurface.test.ts reads the report off stdout of a drill that failed and has to go red.',
  },
  {
    name: 'the in-flight seed lets its send reach sent in one pass',
    file: 'apps/worker/src/tools/fss/drillEvidence.ts',
    find: "        sendBehaviour: 'indeterminate_but_delivered',\n",
    replace: "        sendBehaviour: 'accept',\n",
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/drillEvidence.test.ts'],
    because:
      'Appendix E step 3 reconciles a fence left in doubt, and a send that reached sent in one pass leaves it nothing to reconcile (release.md 8.0s). drillEvidence.test.ts reads the in-flight fence back in reconciling and has to go red.',
  },
  {
    name: 'the after seed delivers the late opt-out and never ingests it',
    file: 'apps/worker/src/tools/fss/drillEvidence.ts',
    find: "        await ingestPending('late_opt_out');\n",
    replace: '',
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/drillEvidence.test.ts'],
    because:
      'Step 2 replays a suppression the restore lost, and the only one the after phase journals is the late opt-out; a phase that put the message in the mailbox without ingesting it journals nothing. drillEvidence.test.ts counts the after phase’s two journalled suppressions and has to go red.',
  },
  {
    name: 'the drill seed registers the rehearsal admin’s number and never attests it',
    file: 'apps/worker/src/tools/fss/drillEvidence.ts',
    find: '    async () => await verifyCallingIdentity(context, { identityId: registered.value.identity.id }),\n',
    replace: '    async () => await registerCallingIdentity(context, { e164: DRILL_CALLING_NUMBER }),\n',
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/drillEvidence.test.ts'],
    because:
      'An unverified number is no subject for the step 1 dial probe, which would go back to no_dialable_subject and leave the drill unanswered. drillEvidence.test.ts reads the identity back verified, enabled and attested by its owner and has to go red.',
  },
  {
    name: 'step 1 accepts a dial refused for a reason that has nothing to do with the restore',
    file: 'apps/worker/src/tools/fss/drill.ts',
    find: "  return holds.includes('restore_in_progress')\n",
    replace: '  return holds.length >= 0\n',
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/drillDialProbe.test.ts'],
    because:
      'authorizeDial stops at its first refusal and the restore hold is step 8, so a rehearsal probe is refused posture_missing whether or not a restore is in progress. drillDialProbe.test.ts hands the verdict a refusal with no restore hold behind it and has to go red.',
  },
  {
    name: 'the worker journal reads a 409 ConditionalRequestConflict as a durable suppression again',
    file: 'apps/worker/src/bootstrap/deployment.ts',
    find: "  return errorName === 'PreconditionFailed';\n",
    replace: "  return errorName === 'PreconditionFailed' || errorName === 'ConditionalRequestConflict';\n",
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/suppressionJournalConflict.test.ts'],
    because:
      'This is audit S12 in the worker: a 409 says another write to the key was in flight and proves nothing is stored, and read as success it let mail sync commit an opt-out no journal object recorded, which a restore would lose. suppressionJournalConflict.test.ts drives the real loader over a fake S3 client that answers 409 and requires JOURNAL_UNAVAILABLE and no suppression_events row; with the conflict accepted the append resolves, the row commits, and the suite has to go red.',
  },
  {
    name: 'the worker logs a restore-generation mismatch once at startup and never again',
    file: 'apps/worker/src/bootstrap/worker.ts',
    find: '        await observeRestoreGeneration(sessions.metrics, { expectedGeneration: config.expectedSystemGeneration, log });\n',
    replace: '',
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/restoreGenerationContinuing.test.ts'],
    because:
      'This is audit O16: the alarm over RestoreGenerationMismatches is one line in its window with missing data not breaching, so a single startup line let it read OK minutes later while the database stayed on the wrong generation. restoreGenerationContinuing.test.ts starts a real worker pinned ahead of its database and waits for the event on three metric passes, then reconciles the generation and requires the lines to stop; without the per-pass call the continuing lines never come and the suite has to go red.',
  },
  {
    name: 'the worker journal fails a write without logging the event its alarm counts',
    file: 'apps/worker/src/bootstrap/deployment.ts',
    find: "        log.log('error', 'suppression_journal_write_failed', { writer: 'worker', error_name: name });\n",
    replace: '',
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/suppressionJournalConflict.test.ts'],
    because:
      'Lane g81: SuppressionJournalWriteFailures is immediately critical and counted from the suppression_journal_write_failed log event, which nothing logged, so the alarm could never fire. suppressionJournalConflict.test.ts answers the put with a 409 through a fake S3 client and requires exactly one such line at level error naming the worker; without the call there is none and the suite has to go red.',
  },
];
