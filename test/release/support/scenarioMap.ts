/**
 * Appendix G's 42 mandatory adversarial scenarios, as data.
 *
 * "All applicable scenarios must pass in the isolated rehearsal environment on the
 * production artifact digests before production sending is enabled."
 *
 * This file is the index and `scenarioNN.check.ts` is the check. Three kinds:
 *
 *   * `lane` — a lane suite already proves it. The check names the files, asserts they
 *     exist and asserts they say the thing rather than merely mentioning the number.
 *     Those suites run for real in the same gate (`npm run test:greenfield`).
 *   * `release` — nothing proved it, or nothing proved the *joining* of two lanes'
 *     halves. The check contains the assertion itself.
 *   * `rehearsal` — it cannot be proved on a laptop: it needs a restored database, a
 *     torn-down cloud environment, two image digests or a real deployment. The check
 *     asserts that the script which runs it exists and that the release workflow calls
 *     it, and the drill is what proves the scenario.
 *
 * ## Why every entry names a trap
 *
 * A scenario suite is the easiest place in a codebase to write a test that cannot
 * fail. `trap` is the specific way *this* check could pass while proving nothing, and
 * `closedBy` is the assertion that makes it fail if it did.
 * `scripts/releaseMutationCheck.mjs` removes the setup of the traps this lane added and
 * requires the suite to go red.
 */

export type ScenarioCoverage = 'lane' | 'release' | 'rehearsal';

export interface Scenario {
  readonly number: number;
  /** Appendix G's own words, shortened only where the sentence runs past a line. */
  readonly title: string;
  readonly coverage: ScenarioCoverage;
  /** Repository-relative paths that carry the proof. Every one is asserted to exist. */
  readonly references: readonly string[];
  /** How this check could pass while proving nothing. */
  readonly trap: string;
  /** What makes the trap fail. */
  readonly closedBy: string;
  /** For `rehearsal`: the script the workflow runs. */
  readonly script?: string;
}

const laneTest = (...paths: readonly string[]): readonly string[] => paths;

export const SCENARIOS: readonly Scenario[] = Object.freeze([
  {
    number: 1,
    title: 'Two scheduler transactions over one due execution create one job row; the same for Today, recovery and mail sync.',
    coverage: 'lane',
    references: laneTest(
      'apps/worker/test/schedulerPass.test.ts',
      'apps/worker/test/sequenceAction.test.ts',
      'apps/worker/test/todayBuild.test.ts',
      'apps/worker/test/mailHandlers.test.ts',
    ),
    trap: 'A suite that ran two passes sequentially would see one row because the second found nothing due, not because uniqueness held.',
    closedBy: 'The lane tests run the two passes against the same due row and assert the row count, and the check asserts the four kinds Appendix G names are each covered.',
  },
  {
    number: 2,
    title: 'Worker A pauses past its lease, B reclaims, A resumes: one business effect, proven by fencing or uniqueness.',
    coverage: 'lane',
    references: laneTest(
      'apps/worker/test/jobRunner.test.ts',
      'apps/worker/test/sequenceAction.test.ts',
      'apps/worker/test/mailHandlers.test.ts',
      'apps/worker/test/suppressionFinalize.test.ts',
    ),
    trap: 'A stolen-lease test where the resumed worker does nothing anyway proves the handler is inert, not that the fence held.',
    closedBy: 'The lane tests assert the *winner* produced the effect as well as that the loser produced none.',
  },
  {
    number: 3,
    title: 'Worker pauses after the eligibility read, a reply commits, the worker resumes: no external action after the reply linearizes.',
    coverage: 'release',
    references: laneTest(
      'packages/domain/outbound/gate.ts',
      'packages/domain/test/outbound/scenarios.test.ts',
      // Lane g77: the recheck and the claim share one transaction under the send gate.
      'packages/domain/outbound/send.ts',
      'packages/domain/policy/sendGate.ts',
      'packages/domain/test/outbound/dispatchRace.test.ts',
      'packages/domain/test/outbound/support/dispatchFixtures.ts',
    ),
    trap: 'Committing the reply before the dispatch begins proves only that the gate reads holds; the window between the dispatch’s own eligibility read and its claim, where the token refresh sits, is never entered (audit T02).',
    closedBy: 'The reply commits on another connection during the real dispatch’s token refresh — after the precheck found the fence sendable, before the claim — and the check requires no send and the reply’s own refusal, with a control whose identical pause commits nothing and sends; the lane suite also proves the send gate serializes claim and reply in both orders.',
  },
  {
    number: 4,
    title: 'Email, call and LinkedIn steps are due while the Gmail grant is revoked or coverage is stale: all automated steps hold through incomplete recovery.',
    coverage: 'lane',
    references: laneTest('packages/domain/test/mail/scenarios.test.ts', 'packages/domain/mail/mailboxes.ts'),
    trap: 'A hold that blocks only email would pass a test that only tried email.',
    closedBy: 'MAILBOX_HOLD_BLOCKS is asserted to name every automated action kind, not just email_send.',
  },
  {
    number: 5,
    title: 'Gmail accepts a Message-ID and drops the response; the Sent search misses then finds; permanent absence ends unknown without resend.',
    coverage: 'lane',
    references: laneTest('packages/domain/test/outbound/scenarios.test.ts', 'packages/domain/outbound/reconcile.ts'),
    trap: 'A fake that never indexes the message would make "no resend" true because nothing ever succeeded.',
    closedBy: 'The fixture has indeterminate_but_delivered and sentIndexingDelay, so the message really is in the Sent folder and really is found late.',
  },
  {
    number: 6,
    title: 'An opt-out commits while email and dial work is queued or claimed, including a shared handle: no post-commit external action.',
    coverage: 'lane',
    references: laneTest(
      'packages/domain/test/outbound/scenarios.test.ts',
      'packages/domain/test/policy/policy.test.ts',
      'packages/domain/test/mail/scenarios.test.ts',
    ),
    trap: 'Testing the firm scope only would miss the handle shared between two firms.',
    closedBy: 'The gate checks firm and handle scope in one call and the lane tests exercise both.',
  },
  {
    number: 7,
    title: 'Two salespeople and one assigned firm: every mutation and sensitive read by the other is refused, including concurrent reassignment.',
    coverage: 'lane',
    references: laneTest(
      'packages/domain/test/crm/commands.test.ts',
      'packages/domain/test/crm/pipelineAdmin.test.ts',
      'apps/api/test/crmSurface.test.ts',
    ),
    trap: 'Refusing an unauthenticated caller is not refusing an authenticated one with the wrong assignment.',
    closedBy: 'The lane tests act as a real second salesperson with a real session.',
  },
  {
    number: 8,
    title: 'Two workspaces with colliding external ids: reads, writes, receipts, messages and jobs never cross.',
    coverage: 'lane',
    references: laneTest(
      'packages/domain/test/db/workspaceScope.test.ts',
      'packages/domain/test/db/support/fixtures.ts',
      'packages/domain/test/mail/scenarios.test.ts',
      'packages/domain/test/outbound/scenarios.test.ts',
      'apps/api/test/auth/identity.test.ts',
    ),
    trap: 'Two workspaces with different ids for everything cross nothing by luck.',
    closedBy: 'seedTwoWorkspaces deliberately collides the command id, the E.164, the job idempotency key and the display email.',
  },
  {
    number: 9,
    title: 'The LinkedIn successor races undo at 9:59 and 10:00 database time: no early fence.',
    coverage: 'lane',
    references: laneTest('packages/domain/test/sequences/scenarios.test.ts', 'apps/desktop/test/sequences.test.ts'),
    trap: 'A test using the wall clock would pass or fail by when it ran.',
    closedBy: 'The lane test injects both instants and asserts the two outcomes differ.',
  },
  {
    number: 10,
    title: 'Duplicate push notifications during reconciliation and one direct Gmail send yield one activity and one manual transition.',
    coverage: 'lane',
    references: laneTest('packages/domain/test/mail/scenarios.test.ts', 'packages/domain/mail/coalesce.ts'),
    trap: 'Delivering the duplicate after the first finished tests nothing about coalescing.',
    closedBy: 'The lane test delivers the second notification while the first sync is in flight.',
  },
  {
    number: 11,
    title: 'A restore predating an accepted send, reply, suppression, ordinary CRM edit and migration: protected effects reconstruct, the accepted CRM RPO is reported, no send repeats.',
    coverage: 'rehearsal',
    references: laneTest(
      'docs/greenfield/restore-drill.md',
      'infra/scripts/rehearsal-restore-drill.sh',
      // The commands the drill calls, and the suite that proves they exist and that the
      // drill's own invocations parse (G12g). Before it, every `fss admin` line in the
      // script named a tool this repository did not contain.
      'apps/worker/src/tools/fss.ts',
      'apps/worker/src/tools/fss/commands.ts',
      'apps/worker/test/fssCli.test.ts',
      'packages/domain/restore/counts.ts',
      'packages/domain/suppression/replay.ts',
      // g40. Step 0.1's six kinds had nowhere to come from in a deployed environment
      // until this command and this step existed, so the baseline refusal fired on
      // every fresh rehearsal (run 35930664547, 23 September 2026).
      'apps/worker/src/tools/fss/drillEvidence.ts',
      'infra/scripts/release-seed-drill-evidence.sh',
      'test/release/drillEvidence.check.ts',
    ),
    trap: 'A drill against an empty database reconstructs nothing and passes; or the commands it calls do not exist and the drill fails only in the cloud.',
    closedBy: 'Step 0.1 of the drill generates all six kinds of activity first — `fss admin drill seed-evidence` produces five of them through the domain\u2019s own entry points in a deployed rehearsal — the script refuses to report a pass when the baseline counts are zero, and `apps/worker/test/fssCli.test.ts` parses every `fss` invocation out of the script and requires the tool to accept it.',
    script: 'infra/scripts/rehearsal-restore-drill.sh',
  },
  {
    number: 12,
    title: 'A worker sends after lease expiry while another reclaims and Sent indexing is delayed.',
    coverage: 'lane',
    references: laneTest('packages/domain/test/outbound/scenarios.test.ts', 'packages/domain/outbound/fence.ts'),
    trap: 'If the loser is refused before the gate, the fence was never the thing that stopped it.',
    closedBy: 'The lane test asserts the loser reaches claimForDispatch and is refused there.',
  },
  {
    number: 13,
    title: 'An expired Gmail cursor with a reply just outside nominal bounds is recovered by overlap and coverage proof.',
    coverage: 'lane',
    references: laneTest('packages/domain/test/mail/scenarios.test.ts', 'packages/domain/mail/recover.ts'),
    trap: 'A reply inside the nominal window would be found without any overlap at all.',
    closedBy: 'The fixture places the message before the watermark, inside RECOVERY_OVERLAP_SECONDS only.',
  },
  {
    number: 14,
    title: 'A shared receptionist address yields several candidates; only the ambiguity holds release after resolution.',
    coverage: 'lane',
    references: laneTest('packages/domain/test/mail/scenarios.test.ts', 'packages/domain/mail/matching.ts'),
    trap: 'Resolving when there is one other hold cannot show that other holds survive.',
    closedBy: 'The lane test opens an unrelated hold on a candidate and asserts it is still in force after resolution.',
  },
  {
    number: 15,
    title: 'A reply to a closed opportunity holds the new open automated opportunity.',
    coverage: 'lane',
    references: laneTest('packages/domain/test/mail/scenarios.test.ts'),
    trap: 'A firm with only a closed opportunity has nothing to hold.',
    closedBy: 'The lane test creates the *second*, open, automated opportunity first.',
  },
  {
    number: 16,
    title: 'Reassignment races a due send from the former owner mailbox; dispatching reconciles there and future work rebinds.',
    coverage: 'release',
    references: laneTest('packages/domain/test/outbound/scenarios.test.ts', 'packages/domain/outbound/reconcile.ts'),
    trap: 'A reassignment applied before the fence is created rebinds trivially.',
    closedBy: 'The check reassigns while a fence is already dispatching and asserts the fence still names the former mailbox.',
  },
  {
    number: 17,
    title: 'Dial command replay after suppression, route retirement, posture expiry or ticket consumption yields no allow.',
    coverage: 'lane',
    references: laneTest('packages/domain/test/policy/appendixG.test.ts', 'packages/domain/dial/authorize.ts'),
    trap: 'A replay that was refused for a missing ticket proves nothing about the four causes.',
    closedBy: 'The lane test replays a *valid* authorization after each of the four changes.',
  },
  {
    number: 18,
    title: 'A LinkedIn reply after handoff and before the next email stops the opportunity through the recorded-reply path.',
    coverage: 'lane',
    references: laneTest('packages/domain/test/sequences/scenarios.test.ts'),
    trap: 'If no successor was scheduled, nothing needed stopping.',
    closedBy: 'The lane test asserts the successor existed and is terminal afterwards.',
  },
  {
    number: 19,
    title: 'A direct Gmail message to an automated opportunity switches it to manual once.',
    coverage: 'lane',
    references: laneTest('packages/domain/test/mail/scenarios.test.ts', 'packages/domain/mail/effects.ts'),
    trap: 'An opportunity already manual cannot switch.',
    closedBy: 'The lane test asserts control_mode was automated before the import.',
  },
  {
    number: 20,
    title: 'Post-watermark sends and suppressions exist; the old stack is read-only and cannot be a rollback target.',
    coverage: 'rehearsal',
    references: laneTest(
      'apps/worker/test/carry/roundTrip.test.ts',
      'apps/worker/test/carry/export.test.ts',
      'docs/greenfield/carry-runbook.md',
      'infra/scripts/rehearsal-carry-watermark.sh',
    ),
    trap: 'A carry over a fixture with no post-watermark write never exercises the refusal.',
    closedBy: 'tableWithPostWatermarkWrite exists for exactly this, and the rehearsal script asserts the export refuses.',
    script: 'infra/scripts/rehearsal-carry-watermark.sh',
  },
  {
    number: 21,
    title: 'Suppression update, delete, cross-key supersession and an unsupported canonicalizer change are refused.',
    coverage: 'lane',
    references: laneTest('packages/domain/test/policy/appendixG.test.ts', 'packages/domain/db/migrations/0006_policy.sql'),
    trap: 'Refusing because the row did not exist is not refusing the operation.',
    closedBy: 'The lane test targets a row it has just inserted and asserts the privilege error.',
  },
  {
    number: 22,
    title: 'An old API with a new worker and the reverse, across every expand/contract phase, obey the declared schema ranges.',
    coverage: 'rehearsal',
    references: laneTest(
      'packages/domain/db/schemaRange.ts',
      'packages/domain/test/db/migrations.test.ts',
      'apps/worker/test/startup.test.ts',
      'infra/scripts/rehearsal-schema-ranges.sh',
      // The order is now performed rather than described (G12h). Until 21 September
      // the step was named "migrate, then worker, then API" and ran two
      // `update-service` calls; nothing anywhere applied a migration, so on a fresh
      // database both services would have refused to start for ever.
      'infra/scripts/release-deploy.sh',
      // Lane g70: the stop runs before the apply, and the apply cannot undo it.
      'infra/scripts/release-stop.sh',
      'infra/modules/cluster/main.tf',
      'infra/modules/cluster/tests/migration_identity.tftest.hcl',
      'infra/modules/cluster/tests/release_owns_the_count.tftest.hcl',
    ),
    trap: 'With both ranges equal to the current version, "every pair is compatible" is true and vacuous; a deploy order that is a heading rather than a sequence of commands is an order nothing performs; and a launch whose exit code nobody reads measures nothing at all — the rehearsal step asserted a successful run-task API call rather than the container’s refusal, and ran a task definition nothing registers.',
    closedBy: 'The check computes the overlap from the declared ranges and, when there is none, asserts the refusal reason each side gives instead; it reads the shared deploy script for the positions of migrate, database-users, verify, worker and API, so an order that stopped being an order fails offline; and it drives the rehearsal script offline against a fake CLI — a first release with no previous image, a registered previous image, an image that accepts the stale range and a container that stops for another reason — so the launch is judged by the container’s exit code (12, configurationInvalid) through the one-off wrapper, with a mutation that puts the run-task reading back.',
    script: 'infra/scripts/rehearsal-schema-ranges.sh',
  },
  {
    number: 23,
    title: 'OIDC state, nonce, code and token-audience replay are refused.',
    coverage: 'lane',
    references: laneTest('apps/api/test/auth/scenarios.test.ts', 'apps/api/src/auth/idToken.ts'),
    trap: 'Replaying against an expired request is refused for expiry, not for replay.',
    closedBy: 'The lane test replays inside the validity window.',
  },
  {
    number: 24,
    title: 'A stolen device, a revoked membership and the offline cache honour expiry and the next-check wipe.',
    coverage: 'lane',
    references: laneTest('apps/api/test/auth/scenarios.test.ts', 'apps/desktop/test/desktop.test.ts'),
    trap: 'A cache that was empty expires correctly and proves nothing.',
    closedBy: 'The desktop test writes a cache, advances the clock and asserts the contents are gone.',
  },
  {
    number: 25,
    title: 'Policy versions with zero, one and two applicable rows fail, allow and fail respectively.',
    coverage: 'release',
    references: laneTest('packages/domain/test/policy/policy.test.ts', 'packages/domain/test/domain/rules.test.ts'),
    trap: 'Testing zero and one only would let "two applicable rows" quietly allow.',
    closedBy: 'The check asserts all three counts, and that the middle one allows, so a rule that always refused would fail.',
  },
  {
    number: 26,
    title: 'An engaged call outcome after handoff prevents every successor.',
    coverage: 'lane',
    references: laneTest('packages/domain/test/policy/policy.test.ts', 'packages/domain/test/sequences/scenarios.test.ts'),
    trap: 'An enrollment with no remaining steps has no successor to prevent.',
    closedBy: 'The lane test asserts unexecuted steps existed before the outcome.',
  },
  {
    number: 27,
    title: 'A Pub/Sub token with a valid Google signature but the wrong audience or service-account email is refused.',
    coverage: 'release',
    references: laneTest(
      'packages/domain/test/mail/rules.test.ts',
      'packages/domain/test/mail/scenarios.test.ts',
      'apps/api/test/deployment.test.ts',
    ),
    trap: 'A refusal caused by an invalid signature says nothing about the claims.',
    closedBy: 'The check signs a genuinely valid token and asserts the refusal names the audience or the service account.',
  },
  {
    number: 28,
    title: 'Two overlapping holds clear in both orders; automation stays blocked until both clear and the shift counts only the union.',
    coverage: 'release',
    references: laneTest('packages/domain/test/domain/holds.test.ts', 'packages/domain/test/sequences/scenarios.test.ts'),
    trap: 'Non-overlapping intervals make union and sum equal, so a sum bug passes.',
    closedBy: 'The check uses intervals that genuinely overlap and asserts the shift is strictly less than the sum.',
  },
  {
    number: 29,
    title: 'A manual suppression corrects at 9:59 while the finalizer races; correction or finalization wins atomically, never contact during the window.',
    coverage: 'lane',
    references: laneTest('packages/domain/test/policy/appendixG.test.ts', 'apps/worker/test/suppressionFinalize.test.ts'),
    trap: 'Running the two sequentially never races.',
    closedBy: 'The lane test runs both in concurrent transactions and asserts exactly one won.',
  },
  {
    number: 30,
    title: 'A prospect opt-out cannot use the salesperson correction path.',
    coverage: 'lane',
    references: laneTest('packages/domain/test/policy/appendixG.test.ts', 'packages/domain/test/domain/rules.test.ts'),
    trap: 'A correction refused for being late is not a correction refused for the source.',
    closedBy: 'The lane test attempts the correction inside the ten-minute window.',
  },
  {
    number: 31,
    title: 'A hold longer than seven days never resumes without review; a shorter one shifts and resumes after a fresh eligibility check.',
    coverage: 'release',
    references: laneTest('packages/domain/test/domain/holds.test.ts', 'packages/domain/test/sequences/scenarios.test.ts'),
    trap: 'Testing only the long case cannot show the short case still resumes.',
    closedBy: 'The check asserts both sides of the boundary and the boundary itself.',
  },
  {
    number: 32,
    title: 'Monday-due email sends Monday morning; weekend work moves to Monday; DST gap and fold resolve deterministically.',
    coverage: 'release',
    references: laneTest(
      'packages/domain/test/domain/calendar.test.ts',
      'packages/domain/test/sequences/scenarios.test.ts',
      'packages/domain/test/sequences/workflow.test.ts',
    ),
    trap: 'A suite that searched for an open window and returned early when it found none reported green while testing nothing — G7-2 shipped exactly that bug.',
    closedBy: 'Every instant here is a literal; nothing reads the wall clock, and a fixture that produced no window would fail rather than return.',
  },
  {
    number: 33,
    title: 'Many contacts at one firm are due the same day; each has one active enrollment, mailbox caps hold the excess, and one reply stops all.',
    coverage: 'lane',
    references: laneTest(
      'packages/domain/test/sequences/scenarios.test.ts',
      'packages/domain/test/outbound/scenarios.test.ts',
      'packages/domain/test/today/today.test.ts',
    ),
    trap: 'A cap high enough for every contact never holds anything.',
    closedBy: 'The lane test sets the ramp so the cap is below the number of due contacts.',
  },
  {
    number: 34,
    title: 'The model labels a human reply automated with high confidence; the deterministic gate prevents release. Malformed output becomes uncertain.',
    coverage: 'release',
    references: laneTest('packages/domain/test/classification/authority.test.ts', 'packages/domain/classification/classify.ts'),
    trap: 'A gate that refuses every model answer would pass this and be useless.',
    closedBy: 'The check asserts the model may still label and prioritise, and only the five consequences are withheld.',
  },
  {
    number: 35,
    title: 'Ambiguous opt-out wording holds for review; explicit stop wording suppresses immediately.',
    coverage: 'release',
    references: laneTest(
      'packages/domain/src/rules/replyClassification.ts',
      'packages/domain/test/classification/confirmation.test.ts',
      'packages/domain/test/domain/rules.test.ts',
    ),
    trap: 'A rule that held everything would pass the ambiguous half alone.',
    closedBy: 'The check asserts both halves against the same rule, so holding everything fails.',
  },
  {
    number: 36,
    title: 'Unknown-terminal marked delivered continues from the original dispatch time; marked skipped stops and never resends.',
    coverage: 'lane',
    references: laneTest('packages/domain/test/outbound/scenarios.test.ts'),
    trap: 'A fence that never dispatched has no original dispatch time to continue from.',
    closedBy: 'The lane test drives the fence through dispatching and reconciling first.',
  },
  {
    number: 37,
    title: 'Firm and contact merge preserves suppressions, correspondence, opportunity history, aliases and uniqueness under concurrent research enrichment.',
    coverage: 'lane',
    references: laneTest('packages/domain/test/crm/commands.test.ts', 'packages/domain/test/research/commands.test.ts'),
    trap: 'A merge of two empty firms preserves everything trivially.',
    closedBy: 'The lane tests assert each preserved kind exists on the source before the merge.',
  },
  {
    number: 38,
    title: 'CSV import with duplicates, cross-workspace ids, invalid routes and partial failures produces a preview and atomic per-row commands without leakage.',
    coverage: 'lane',
    references: laneTest('packages/domain/test/crm/import.test.ts', 'apps/api/test/crmSurface.test.ts'),
    trap: 'A file where every row is valid never exercises partial failure.',
    closedBy: 'The lane fixture contains all four defects in one file.',
  },
  {
    number: 39,
    title: 'Production and rehearsal Terraform plans use distinct state keys, roles, secrets and resource namespaces; rehearsal teardown cannot address production resources.',
    coverage: 'rehearsal',
    references: laneTest(
      'infra/roots/production/tests/isolation.tftest.hcl',
      'infra/roots/rehearsal/tests/isolation.tftest.hcl',
      'infra/scripts/offline-gate.sh',
      'infra/scripts/rehearsal-prefix-guard.sh',
      'infra/scripts/rehearsal-registry-guard.sh',
      'infra/scripts/rehearsal-caller-identity.sh',
      '.github/workflows/greenfield-rehearsal-registry.yml',
      // G12h: one script is now the code path for both environments, so the refusal
      // has to be symmetric, and every one-off task launch is a new way to address
      // the wrong namespace.
      'infra/scripts/release-common.sh',
      'test/release/support/runTaskGuards.sh',
      'infra/scripts/rehearsal-teardown.sh',
    ),
    trap: 'Two plans that differ in every value are isolated by accident; an offline plan cannot prove an IAM boundary; a workflow holding the role proves nothing about the plan it applies; and a launch guard that refuses everything passes every refusal case while making the release undeployable.',
    closedBy: 'The offline tests pin the state-key prefixes and the name-prefix refusals; the rehearsal script asserts after teardown that nothing with the production prefix was touched; the registry apply runs in the rehearsal environment behind a plan guard exercised against a plan it must refuse; and every run-task guard is run against a launch it must refuse and one it must allow, with the AWS responses supplied offline.',
    script: 'infra/scripts/rehearsal-prefix-guard.sh',
  },
  {
    number: 40,
    title: 'A minimum-client-version increase blocks old Electron mutation while preserving the upgrade path.',
    coverage: 'lane',
    references: laneTest(
      'apps/api/test/auth/scenarios.test.ts',
      'apps/desktop/test/packaging/scenario40.test.ts',
      'packages/contracts/test/contracts.test.ts',
    ),
    trap: 'Blocking everything would also block the upgrade instruction.',
    closedBy: 'The lane tests assert the upgrade read still succeeds for the blocked client.',
  },
  {
    number: 41,
    title: 'Retention deletes unmatched metadata, raw MIME, canceled drafts and logs at their boundaries without deleting matched business history or suppression tombstones.',
    coverage: 'release',
    references: laneTest(
      'packages/domain/retention/coverage.ts',
      'packages/domain/retention/targets.ts',
      'packages/domain/test/retention/scenario41.test.ts',
      'packages/domain/test/retention/deletion.test.ts',
      'apps/worker/test/retention.test.ts',
      'packages/domain/db/migrations/0001_foundation.sql',
    ),
    trap: 'A retention suite proves what it deletes and never what survives, and a table added by a later lane is uncovered by definition because nothing existing mentions it.',
    closedBy: 'G14 TABLE_RETENTION_COVERAGE is asserted to be a real registry with no PENDING_RETENTION_TABLES left, and the tombstones are asserted unreachable by privilege rather than by policy.',
  },
  {
    number: 42,
    title: 'Authentication passes but production sending remains disabled until the artifact digest, the rehearsal gate, the smoke tests and the manual enable all agree.',
    coverage: 'rehearsal',
    references: laneTest(
      'packages/domain/settings/effective.ts',
      'packages/domain/outbound/gate.ts',
      'packages/domain/test/outbound/attestation.test.ts',
      'apps/worker/src/bootstrap/deployment.ts',
      'apps/api/src/bootstrap/deployment.ts',
      'infra/scripts/rehearsal-release-record.sh',
      'scripts/productionSmoke.mjs',
      // Lane g71: the record is stored, and the attestation binds to the running digests.
      'packages/contracts/src/release.ts',
      'packages/domain/release/records.ts',
      'packages/domain/release/identity.ts',
      'packages/domain/test/settings/sendingEnable.test.ts',
      'infra/scripts/release-deploy.sh',
    ),
    trap: 'Four conditions ANDed are indistinguishable from one condition if only one is ever varied.',
    closedBy: 'The check varies each of the four independently and requires sending to stay off for each; the release record script refuses to write a record whose digests differ or whose suite failed; and since lane g71 the API refuses an enable whose record does not pass or does not name its own digest, and the worker refuses to send when the record does not name its own.',
    script: 'infra/scripts/rehearsal-release-record.sh',
  },
]);

/** Appendix G 11, 20, 22, 39 and 42 cannot be proved on a laptop. */
export const REHEARSAL_ONLY: readonly number[] = Object.freeze([11, 20, 22, 39, 42]);

export function scenario(number: number): Scenario {
  const found = SCENARIOS.find(entry => entry.number === number);
  if (found === undefined) throw new Error(`Appendix G has no scenario ${String(number)}`);
  return found;
}
