// Release mutations that edit every other domain module (`packages/domain/`: dial, jobs, release, restore, suppression, today, …).
//
// Loaded by `loadMutations` in scripts/releaseMutationRunner.mjs, which also holds the
// rule that decides an entry's area (MUTATION_AREAS). Each entry's fields are described
// at the top of scripts/releaseMutationCheck.mjs. Append to the end of this file.

/** @type {import('../releaseMutationRunner.mjs').Mutation[]} */
export const MUTATIONS = [
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
    name: 'a rejected CloudWatch batch is no longer retried one datum at a time',
    file: 'packages/domain/jobs/metricsCloudWatch.ts',
    find: '        if (batch.length === 1) {\n',
    replace: '        if (batch.length >= 1) {\n',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/jobs/metricsCloudWatch.test.ts'],
    because:
      'CloudWatch rejects the whole request over one bad member, so without the per-datum retry one refused datum silences the heartbeats beside it, which is the blackout of 24 September. metricsCloudWatch.test.ts rejects any request carrying one named metric and has to go red when the others are not published.',
  },
  {
    name: 'step 9 accepts a report that lost a suppression recorded after the target',
    file: 'packages/domain/restore/report.ts',
    find: "    if (after < atFailure) return { ok: false, reason: 'suppression_lost' };\n",
    replace: '',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/restore/adminCommands.test.ts'],
    because:
      'A restore that brought back one of two post-target suppressions is above the baseline and below the failure, and only the at-failure comparison sees it. adminCommands.test.ts composes that report and has to go red when verifyRestoreReport lets the generation advance past it.',
  },
  {
    name: 'an attestation records the statement and leaves the number disabled',
    file: 'packages/domain/dial/identities.ts',
    find: '            enabled = true,\n',
    replace: '            enabled = false,\n',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/policy/callingIdentities.test.ts'],
    because:
      'A verified number that is not enabled is refused identity_disabled at 9.2’s second step and never reaches the Today card, so a salesperson who attested would still have no Call button. callingIdentities.test.ts authorizes a dial with the attested number and has to go red.',
  },
  {
    name: 'the Today card stops carrying the actor’s calling number',
    file: 'packages/domain/today/dto.ts',
    find: '    callingIdentityId,\n',
    replace: '    callingIdentityId: null,\n',
    suite: ['run', 'test', '--workspace', 'apps/api', '--', 'test/callingIdentities.test.ts'],
    because:
      'The Mac offers a Call button only when the expanded card carries a calling identity, so an attested number the card never reports is production on 24 September with extra steps. callingIdentities.test.ts reads /today/firm before and after the attestation and has to go red.',
  },
  // Lane g67: TodaySnapshotMissing has a publisher, and it reads the job rather than the rows.
  {
    name: 'the Today gauge counts a materialized today.build job as a built list',
    file: 'packages/domain/today/metrics.ts',
    find: "      WHERE j.state = 'done'`,\n",
    replace: '      WHERE true`,\n',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/today/snapshotMissing.test.ts'],
    because:
      'A job that exists is not a list that was built: a queued job is a scheduler that ran and a worker that did not, and a dead one is a build that failed four times. Counting any state as built would hold fss-prod-today-snapshot-absent at OK through exactly the mornings it exists for. snapshotMissing.test.ts reads 1 over a queued, a running and a dead job and has to go red.',
  },
  {
    name: 'the Today gauge owes the list at 05:00, the minute the build is materialized',
    file: 'packages/domain/today/metrics.ts',
    find: 'export const TODAY_SNAPSHOT_DEADLINE_LOCAL_MINUTE = 5 * 60 + 10;\n',
    replace: 'export const TODAY_SNAPSHOT_DEADLINE_LOCAL_MINUTE = 5 * 60;\n',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/today/snapshotMissing.test.ts'],
    because:
      'Specification 13.3 alarms at 05:10 workspace time, ten minutes after the 05:00 build, and the build minute is the plausible constant to reach for (the worker\u2019s TODAY_BUILD_LOCAL_MINUTE is 5 * 60). With the deadline at 05:00 every healthy morning reads 1 between the first scheduler pass and the first completion, and one such datapoint fires the critical alarm. snapshotMissing.test.ts reads 0 at 05:09:59 New York time with nothing built and has to go red.',
  },
  {
    name: 'step 3 reports a send whose fence the restore lost and inserts no tombstone for it',
    file: 'packages/domain/restore/missingFences.ts',
    find: "  if (only === undefined) return { outcome: 'unmatched', reason: 'no_live_enrollment' };\n",
    replace: "  return { outcome: 'unmatched', reason: 'no_live_enrollment' };\n",
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/restore/missingFences.test.ts'],
    because:
      'This is the P1 the 25 September review found: after a point-in-time restore, a send made after the restore point has no fence in the restored copy, its step is pending again, and the sender’s one dedupe key is the fence that was lost. Step 3 reconciled only fences the copy still had, and the drill stayed green on the in-flight one. With the missing-fence branch gone every such send is reported and left, and missingFences.test.ts expects a tombstone on the pending step and has to go red.',
  },
  {
    name: 'the release-record binding stops comparing the running image digest',
    file: 'packages/domain/release/records.ts',
    find: "  if (digestFor(record, side) !== runningDigest) return { ok: false, reason: 'release_record_digest_mismatch' };\n",
    replace: '',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/outbound/attestation.test.ts'],
    because:
      'Specification 16.2 asks that the deployed image digests match the rehearsal artifacts, and this comparison is the only place the software asks it. Without it any stored passing record would bind to any image, so a worker deployed from digests nobody rehearsed would send under an old attestation. attestation.test.ts dispatches under a mismatching worker digest and requires release_record_digest_mismatch, and has to go red.',
  },
  {
    name: 'the release-record binding accepts a record whose suite did not pass',
    file: 'packages/domain/release/records.ts',
    find: "  if (record.suite !== 'pass') return { ok: false, reason: 'release_record_not_passing' };\n",
    replace: '',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/settings/sendingEnable.test.ts'],
    because:
      'The contract stores a suite verdict other than pass on purpose, so that this rule is the one that refuses it at the moment an admin relies on the record. Without it an enable could name a failed rehearsal whose digests happen to match. sendingEnable.test.ts enables against a stored failed record and requires release_record_not_passing, and has to go red.',
  },
  // Lane g79: a ticket is re-authorized at consumption, a logged call applies its step,
  // and the Mac resolves a DST gap with the domain's clock.
  {
    name: 'consuming a dial ticket stops re-running the dial decision',
    file: 'packages/domain/dial/tickets.ts',
    find: '  if (!decision.allowed) return refuse(decision.reason);\n\n  const { rows } = await context.db.query<{ id: string; e164: string; consumed_at: Date }>(\n',
    replace: '  const { rows } = await context.db.query<{ id: string; e164: string; consumed_at: Date }>(\n',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/policy/callsAndCallbacks.test.ts'],
    because:
      'Audit item S10 (25 September 2026): consumption checked the workspace, the device, the expiry and prior consumption only, so a pause, a restore hold, a disabled identity, a revoked posture, a suppression or a retired route that arrived inside the ticket’s sixty seconds was not seen and the tel: URI was issued anyway. callsAndCallbacks.test.ts authorizes, changes the world, then consumes, and expects each refusal code with the ticket left unconsumed; without the re-run every one of those consumptions succeeds and it has to go red.',
  },
  {
    name: 'a logged call records its step and applies nothing to it',
    file: 'packages/domain/dial/calls.ts',
    find: '    if (bound !== null) {\n      const step = await applyCallToStep(context, {\n',
    replace: '    if (bound !== null && bound.open === null) {\n      const step = await applyCallToStep(context, {\n',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/policy/callsAndCallbacks.test.ts'],
    because:
      'Audit item C04: G4 recorded a step_effect on the call log and never applied it, so a logged voicemail left its call task on Today for ever and the cadence stalled behind it. callsAndCallbacks.test.ts logs a voicemail against a real enrollment’s call task and expects the step completed by call_log, the frozen version’s step 2 created, and a retry_call step re-armed with a retry_call shift; with the application skipped the step stays pending with no successor and it has to go red.',
  },
  {
    name: 'the sequence action’s key forgets the wake, and a held step collides with its done job',
    file: 'packages/domain/jobs/jobKinds.ts',
    find: '    wake === undefined ? `step-execution:${stepExecutionId}` : `step-execution:${stepExecutionId}:${wake}`,\n',
    replace: '    `step-execution:${stepExecutionId}`,\n',
    suite: ['run', 'test', '--workspace', 'apps/worker', '--', 'test/sequenceActionRearm.test.ts'],
    because:
      'This is audit C02: the key was the execution id alone, so a step the cap held completed its job, the scheduler’s next insert for it collided with the done row, and the step never ran again. sequenceActionRearm.test.ts holds a step on the day’s cap, lets its hour pass and requires a second job and one send; with the old key the second pass inserts nothing and it has to go red.',
  },
  {
    name: 'a Won or Lost firm is a new firm again the next morning',
    file: 'packages/domain/today/build.ts',
    find: "                 AND closed.status <> 'open'\n",
    replace: '                 AND closed.status <> closed.status\n',
    suite: ['run', 'test', '--workspace', 'packages/domain', '--', 'test/today/newFirms.test.ts'],
    because:
      'Audit item C19: the new-firm query joined only the open opportunity, so a firm whose opportunity was Won or Lost read as never contacted and came back on Today as a new firm to call. newFirms.test.ts builds one firm of each kind, requires the Won and Lost ones off the list, and has to go red.',
  },
];
