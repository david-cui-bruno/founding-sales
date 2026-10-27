# Restore production to a point in time

## Status and execution boundary

**Hosted restore orchestration: NOT IMPLEMENTED. Restoration and hosted recovery rehearsal: UNTESTED.** This page preserves the recovery protocol and maps its implementation seams. It is not an executable production procedure. A successful deployment, PITR inventory or source test does not prove restoration.

October 27, 2026 G11 decision: recovery mutations must use the supported hosted model, serialized with deployment and other production writers, bound to an exact recovery target. Root owns the workflow/infra contract and implementation. Actual restoration that loses writes still needs David's separate authorization. This design grants no restore, cloud spend, sending activation or emergency bypass, and adds no blanket release blocker.

The sole current production entrypoint is the [lean release workflow](../../operations/lean-release-workflow.md). [Greenfield deploy](../../../.github/workflows/greenfield-deploy.yml) offers `automatic`, `review_prepare`, `reviewed` and `application`, not restore. It and [the Google writer](../../../.github/workflows/greenfield-google.yml) share `fss-production-deploy` with cancellation disabled. Those deployment modes are not arbitrary recovery-command runners. The existing shell guard in `infra/scripts/lib.sh` refuses real local production writes through its wrapper. Raw AWS/Terraform calls can bypass that wrapper, not this operating contract. Do not use them as an implicit exception or spoof hosted environment variables.

Use restoration when earlier data is better than damaged production data, not for ordinary instance failure handled by Multi-AZ. No fixed outage duration is established. The old instance must remain readable for mailbox inventory and abandon. If it is gone or unreadable, stop and escalate rather than invent an inventory.

## Existing support and missing hosted seams

Paths below identify retained source primitives, not verified live configuration or permission. All steps require the same recovery identity and predecessor checks described below. Labels (a) through (g) retain the protocol's existing cross-references.

| Step / writer | Existing source support | Missing hosted recovery seam |
| --- | --- | --- |
| Setup / progress ledger | Former local `restore.env` and `go` fingerprinted the target and invalidated later passes on rerun. | Durable private hosted progress, exact-target validation and resume/readback. A local ledger or workflow success flag is not serialization. |
| (a) Pin source, mark it, stop writers | RDS inventory reads; `admin restore-marker put` in `apps/worker/src/tools/fss/admin.ts`; `stop.sh`; release drain and `release-safety.mjs` quiescence primitives. | Bind marker write to pinned old instance, capture exact live digests/task definitions/schema and owner controls, drain/stop API and worker and account for other one-off writers under recovery ownership. Existing release helpers are not a restore entrypoint. |
| (b) Create and configure PITR copy | RDS PITR API and production database Terraform configuration describe required topology/settings. Release safety can pin a backup window but explicitly records `restoreTested: false`. | Hosted exact-source/exact-time restore, copy configuration, bounded waits, unknown-result observation and identity/KMS readback. No current restore mode or demonstrated restore-capable hosted identity. |
| (c) Repoint tasks, credential entry, migrate and ensure users | `active_database_host` in the production root/stack; `apps/worker/src/tools/restorePlan.ts` paired-plan validator; migration and operations tasks; `admin database-users ensure --rotate-password`; schema reader. | Hosted paired saved-plan preparation/application, exact secret-version handling and target-bound task launch. Existing reviewed release is not this protocol and assumes the managed database host in its safety binding. Do not feed it an improvised restore plan. |
| (d) Replay suppression and reconcile Sent | `admin suppression-journal replay`, `admin mailbox reconcile-sent`, `readOnlyGmail.ts`, `packages/domain/restore/`; marker/inventory checks, tombstones and unattached-send holds already exist. Reconciliation also revokes restored prospecting authority. | Hosted allowlisted launches against the copy with read-only old-instance inventory access, private report retention/readback and strict unresolved-result stop. Gmail reads are external operations, not authorized by this document change. |
| (e) Restore release record and verify holds | `record.sh` CI provenance/store primitives; `admin holds list`; reconciliation report and hold IDs. | Bind the exact record to selected known images and the copy, require identical existing-record readback and compare current restore holds with the exact successful (d) result. A historical record or generic health response is insufficient. |
| (f) Restart, smoke, final readback | `deploy.sh` exact-image/service checks; release safety; runtime/canary/public smoke and record readback used by current hosted delivery. | Recovery-specific restart gate and actual host/digest/revision/schema/control readback. Preserve copy-host routing across later production writes until retirement. Current deployment assumptions must be reconciled before admitting those writes. |
| Hold clearance / SQL mutation | `admin holds release-restore` audits note, task ARN, launcher claim and resolution; refuses outside ECS. | Exact-hold hosted operation plus independent CloudTrail RunTask-to-launcher verification. No blanket clearance or automatic release on restart. |
| (g) Retire old instance / RDS and Terraform state writers | `restorePlan.ts` retirement allowlist; existing database root; former protocol's identity, SQL, final-snapshot and state-backup checks. | Separately staged hosted retirement: exact destructive scope, final snapshot readback, rename, state import/reconciliation, checked plan, secret repoint and restart. No current orchestrated retirement or safe automatic state rollback. |
| Abandon before (f) | Repoint validator and retained old instance provide reference building blocks. | Hosted phase-aware abandon, old-host credential/record/schema checks, restart/readback and separately scoped copy cleanup. Unknown restart state must be observed before choosing abandon. |
| Former quarterly hand smoke | Marker, schema and Sent primitives remain. `greenfield-release.yml` is a schema rehearsal, not a restore drill. | Hosted isolated restoration rehearsal with explicit resource/spend/data authority and cleanup evidence. The old smoke also wrote a marker to production, so it was not scratch-only. No automatic quarterly run is authorized. |

## Exact recovery identity and serialization contract

**Required design, not implemented:** Root must choose the hosted workflow/identity ownership before source changes. Extend the existing production workflow rather than create a parallel local path. Reuse its production queue and protected execution boundary where appropriate, but do not assume its current identities have RDS restore, secret mutation, state-import or CloudTrail rights. Application/maintenance roles intentionally exclude restore authority. Any required infra/IAM changes belong to Root's concrete review, not permission broadening hidden in a runbook.

Minimum recovery inputs/state:

- Account, region, environment, exact dispatch/source commit and hosted run identity.
- Restore instant `T` in UTC; source RDS ARN, `DbiResourceId` and endpoint; unique target identifier and, once created, its distinct resource ID/endpoint; fresh marker bound to `T` and source ID; scan start `T` minus ten minutes.
- Exact image/gate provenance, API/worker digests, all four task definitions, schema ranges, observed current schema, network/secret references and original owner-control versions. Secret values, state, plans and mailbox reports stay private.
- Current phase, actual task/provider request identities, completed results, unresolved outcomes, applicable plan/state bindings and readbacks. Repeating a phase invalidates dependent passes. Changing the target invalidates the old progression. Never manually stamp a pass.

The queue protects concurrent hosted executions, not the interval between separate dispatches. Before stopping writers, establish recovery admission that every deployment, migration, infrastructure/Google writer and supported one-off mutator honors. Preserve it across failure, cancellation, job timeout, approval gaps and the interval before (g). Root must select whether one hosted execution owns a contiguous phase or separate dispatches resume durable recovery state. Neither may leave a gap where an unrelated queued writer can repoint or restart services. Shared release hold alone is insufficient: reviewed execution can operate while that hold remains set. Preserve the existing holds and do not open them globally.

Drain/stop runtime writers and verify API/worker desired/running/pending counts are zero plus complete one-off task enumeration. Record unknown launches and waits instead of relaunching them. The recovery task itself is an intentional writer and must be distinguished from unrelated tasks in quiescence checks. A Terraform backend lock protects a state transaction, not the whole recovery. Raw/manual writers are prohibited by the supported model, not technically fenced by GitHub concurrency. No emergency exception is currently defined.

## Recovery protocol and readbacks to preserve

### (a) Fix the target, mark the old instance, then stop

Pin the old `fss-prod-pg` resource identity through RDS and require its endpoint to agree with Terraform and the live task definitions. Before stopping, write a fresh marker to that instance with the runtime credential, bound to `T` and its resource ID, after `T`. Capture the running image digests and schema contracts. The marker proves a write occurred, not instance identity: RDS pins provide identity. Refuse reused markers with different bindings. Take control of writer admission, drain and verify quiescence before proceeding. Keep sending contained and stored owner OFF/newer stops intact. Capture current control/hold decisions from the old instance and retain them across recovery: pre-`T` settings in the copy cannot silently revive consent or erase a newer stop. The hosted implementation must define that target-bound preservation/readback before restart.

### (b) Restore a new instance

Require `T` in exactly one restorable window belonging to the pinned source, not a retained backup of a different instance with the same name. Require a new target, private network/security/parameter settings matching the production module, encryption and expected storage/master-secret KMS keys, retention/windows and deletion protection. Read back its distinct resource ID and endpoint. An existing target or uncertain creation is an observation/recovery branch, never a blind create/delete retry. Preserve the old instance and original restoration assets.

### (c) Repoint while stopped, then bring the copy forward

Prepare paired plans differing only in `active_database_host`, both explicitly replacing the four task definitions. Retain `restorePlan.ts` semantics: exactly API/worker/migration/operations definitions differ only by host, services differ only by their planned task definitions, and no other managed resource changes. Services stay zero. Apply only the checked exact plan under current state bindings. Safely fill the migration credential entry from the target's managed master secret without logging it, migrate the copy and ensure/rotate its runtime login to the current runtime credential. Read schema through the operations task and require both exact binaries to accept it. Do not downgrade migrations or mistake image rollback for data rollback.

### (d) Replay suppression and reconcile Sent while stopped

Re-read both resource IDs/endpoints and require the task host to be the copy. Replay the durable suppression journal from `T` minus ten minutes, then run Sent reconciliation against the copy using the old inventory host, marker and instance binding. Require the marker on the old instance after `T` and absent from the copy. Inventory includes every mailbox on the old instance plus every historically connected mailbox in its retained audit trail, never a typed list or the copy's inventory alone.

The Gmail client cannot send, watch or read message bodies. Listing/metadata ambiguity and incomplete coverage refuse. Reconcile lost send fences/tombstones and retain private reports even on nonzero exit. Reconciliation revokes restored prospecting authority before external reconciliation, including partial failures. Do not reconstruct activation consent from restored settings.

- Inventory unreadable, missing/mismatched marker, marker in copy, empty/incomplete inventory or `mailbox_not_in_inventory`: stop and escalate. No substitute list.
- `sent_folder_unscanned` with `rate_limited`, or `message_vanished`: a bounded, observed reconciliation rerun can resolve it. `malformed_response`: one rerun, then escalate. `truncated`: stop and escalate. No blind replay of an unknown task.
- `grant_revoked` or `mailbox_not_in_copy`: choose a later separately bound `T` with the required grant or abandon before serving. Do not waive coverage.
- `unattached_sent_message`: an explicit `--hold-unattached` reconciliation can open audited firm or workspace `restore_in_progress` holds with candidate enrollments. Preserve those holds through restart until human settlement.

No (d) pass until the exact command and report both succeed with no unresolved outcomes. Zero coverage is not success.

### (e) Record exact images and preserve holds

Rebuild/store only the CI-provenance record for the intended immutable images. Identical `existing` or first `created` storage can pass, with exact bytes retained for final readback. Verify report bindings (`since`, inventory host/marker/instance, `T`) match this recovery. Require the open restore-hold set to equal the successful reconciliation's held IDs: no early clearance or unnoticed old restore holds. Other safety holds stay intact. Any older restore hold needs its own justified, audited settlement, not blanket automatic clearing.

### (f) Restart and verify the actual target

Start only after (a) through (e) pass for the same identity. Require runtime/canary/public smokes and exact record readback under [release §4.1](../release.md#41-the-order-inside-a-release-and-the-policy-that-is-not-negotiable) and [§4.2](../release.md#42-the-release-record-from-the-ci-gate-lane-g96), not §6 (sending eligibility). Read back actual service PRIMARY revisions, digests, counts, no pending rollout, accepted schema and all four task-definition hosts. Confirm both live services reach the copy and owner controls/holds remain preserved. Health alone does not establish these facts.

Until (g), all admitted production plans must retain the exact copy host. Existing reviewed-release safety expects the managed host, so normal delivery after recovery is not automatically supported by the current implementation. Root must implement target-aware admission or explicitly refuse such delivery, not rely on an operator remembering a local flag. Healthy completion removes only the recovery's own temporary admission block when safe, never owner OFF, restored-authority revocation or newer stops. Actual sending still requires every current consent/eligibility/campaign/source/cap/hold/unknown-write check.

### Clearing a restore hold

This is a separate targeted hosted mutation, not an automatic recovery phase. For an unattached send, inspect its Sent time/mailbox/recipient/step, verify all enrollments that could duplicate the step are ended, and document permissible re-enrollment. A new enrollment starts at the first step, so ending old ones alone is not a lasting duplicate fence. A workspace hold may have no readable recipient or firm-page display. List through the admin command rather than assume UI visibility.

Release only the exact hold with a meaningful note. An unattached-send hold requires `checked-no-duplicate` resolution and records `basis: human_attestation`, not a fact enforced by the command. Older non-unattached restore holds still require justified audited settlement, without claiming that resolution proves them safe. A firm or workspace hold blocks all action kinds in its scope until released. Preserve `hold.restore_released` audit, recorded enrollment states, task ARN and launcher. `FSS_LAUNCHED_BY` is only a shape-checked claim: require independent CloudTrail RunTask attribution to the same launcher/task. The former lookup waited up to 21 minutes and could miss a just-arriving event. A later read can resolve absence, never waive a mismatch. Attribution NO-GO remains unresolved and is reported to David. An already-released response does not replace attribution/readback.

### (g) Retire later, without an unsafe state rollback

Retirement is a separate destructive stage and second maintenance interval, not an immediate cleanup obligation. Before deletion require both pinned instances available at their exact endpoints, SQL/schema reads against each, both live services on the copy, complete writer quiescence and a free final-snapshot name (only actual not-found counts). Retain private pre-change state and recoverable old-instance assets. Snapshot creation/retention needs actual readback, not only a delete request.

After deleting the old instance, the original sequence cannot safely restart. Observe each completed mutation. Rename the copy to the managed identifier and re-read its unchanged resource ID and possibly changed endpoint. Reconcile Terraform ownership/import under current state lineage/serial, then validate paired retirement plans. Only task/service host changes plus database tags and the validator's explicit Terraform settings allowlist may differ, never database replacement. Repoint the migration credential, restart and repeat exact readbacks. A saved state copy is evidence/recovery input, not authority to push old state over intervening writes. Partial import/rename/apply requires Root's state-aware forward repair.

## Failure, cancellation and abandon

Keep sending contained and recovery admission held on failed/unknown phases. Retain phase/target/task/request identities and actual state privately. An observer timeout is not hosted failure, cancellation or permission to redispatch. Never rerun an uncertain task, RDS mutation, saved plan, secret write or destructive stage without resolving its actual effect. Cancellation does not undo writes. No local fallback, global hold opening or new emergency bypass is authorized.

Before (f), abandon can return to the pinned readable old instance only after proving the copy never served production. If (b) never completed and hosts/credentials never changed, verify the old bindings before restart. If repointed, use checked paired plans in reverse, restore the old migration credential, verify old schema/image/record/control compatibility, then restart with smokes/readbacks. Keep copy cleanup separate and target-bound. If restart was attempted with unknown outcome, inspect whether the copy served or accepted writes before choosing this branch. After (f), repointing back loses new writes: it is another restoration decision requiring applicable write-loss authorization, not abandon.

## Retained reference assets and limits

The superseded hand-local recipe remains recoverable in Git at commit `af3c383538930cfcea0961267c661d897abf512d`, path `docs/greenfield/runbooks/restore.md`, blob `5d1bf2f5143e5cba003d7b00ce8c4c86362375b2`. Its shell setup, direct secret/RDS/Terraform calls, state push and quarterly smoke are historical reconstruction/reference, not current execution instructions. Do not replay them. No restoration source, validator, migration, suppression journal, old instance or retained backup is removed by this correction.

Retained local evidence assets include `apps/worker/test/restorePlan.test.ts`, `packages/domain/test/restore/`, `packages/domain/test/suppression/restorePath.test.ts` and production Terraform host-isolation tests. They cover source contracts, not hosted recovery or actual restoration. The former quarterly smoke is not accepted evidence: it creates a cloud copy, writes a production marker, reads real Sent metadata and deletes resources. Any replacement needs its own bounded execution/resource authority and target/readback/cleanup checks. No rehearsal was run for this design.

Credential handling still matters: database-user rotation logs DDL containing a salted runtime-password verifier, credential material even though it is not the plaintext password. Keep secret values, verifiers, Terraform state/plans, mailbox identities and reconciliation payloads out of public logs/artifacts. Use the existing private/encrypted transport where suitable, without treating deployment artifacts as recovery receipts.

**Next dependency: waiting on Root's hosted workflow/infra ownership decision.** Implement and check the mapped seams before presenting any production commands. Future acceptance must observe a separately authorized isolated restore, reconciliation/refusal and failure/abandon paths, actual target state and cleanup. Passing normal release checks cannot close that acceptance. Actual production restoration/write-loss remains separately unauthorized here.
