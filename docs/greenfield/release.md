# FSS release: the invariants

**Execution:** [lean release workflow](../operations/lean-release-workflow.md) is the sole supported production execution entrypoint. This page explains constraints, not an alternative local apply, rollback or approval recipe. [Current state](../operations/current-state.md) owns dated build/schema/sending observations. Earlier local production hand paths are retired.

## 0. Who does what

CI builds immutable images, verifies their digests and binds release records to passing exact-main gate/images runs. The hosted shared production queue executes application, maintenance and reviewed infrastructure changes with the appropriate scoped identity/protected approval. Root owns release integration and actual-state observation. Owner configuration and capability consent are separate from deployment approval.

The desktop build/signing/update path remains separately governed by [install](install.md). A signed client is not deployed API/schema acceptance or sending permission.

## 1. Before the first release

First-release history is retained in [release-first](../archive/release-first.md), not current authority. Production and rehearsal roles, namespaces and state keys remain separate. `s3:BypassGovernanceRetention` may exist for same-day rehearsal teardown, never on the production deployment role. The suppression journal must remain append-only to its deployer.

## 2. The images

### 2.1 Where a digest comes from, and what makes it trustworthy

- CI is the only source. Nothing is rebuilt on a Mac for production. Greenfield images publishes immutable `ci-<commit>` tags, verifies pulled digests and emits `fss-image-digests` with commit/run/schema bindings. Production gets a copy of those bytes, never a rebuild. Mutable tags are not release identity.
- Promotion preserves bare-manifest digest identity and reads production back. Existing tags naming different bytes are refused, not overwritten. Re-run provenance must attest an earlier attempt of the same run, not merely a plausible clock time.
- A docs-only commit can use older image-input builds without relabeling them. Dispatch commit, image commit and gate/image runs are explicit separate bindings.
- Plans must not destroy/replace ECR repositories. Repository destruction would remove the artifacts immutable release records identify.

## 3. The rehearsal

The existing `greenfield-release.yml` rehearsal uses only its own `fss-rh-*` namespace and scoped role, with teardown and empty-prefix guard even after failure. [Restore](runbooks/restore.md) and [release history](../archive/release-history.md) retain recovery context. A rehearsal result is not production deployment, restoration proof or feature activation. Required release-class rehearsal/upgrade checks remain mandatory; an ordinary local documentation edit does not create a new rehearsal campaign.

Infrastructure/release-script changes and migrations classified `touches-existing`, `privilege`, `destructive` or `unclassified` retain their required rehearsal. `additive`/`replaces-routine` migrations use actual deployed-baseline upgrade evidence instead, never an empty-database substitute. Every migration must qualify; replaced routines must actually be exercised. App-only/desktop-only changes do not create a schema rehearsal requirement. Retain the exact gate's upgrade artifact before hosted artifact expiry. The workflow's baseline bindings and live schema checks must agree, not merely copied repository variables.

An empty Terraform state is not evidence that no cloud leftovers exist. The guard checks actual namespaced resources and locks. Unknown reads refuse absence. Reconcile the exact owned run/lock before cleanup, never unlock another active writer or broadly delete resources.

## 4. Production releases

All supported production writers serialize on `fss-production-deploy`, cancellation disabled. Local production preparation/read paths are not write permission. Routine local apply, direct secret/service mutation and standalone `rollback.sh --apply` are not substitutes for the hosted queue.

### 4.0 App-only changes deploy themselves: the protected paths and the gates (lane g91)

Automatic admission requires literal `FSS_RELEASE_HOLD=false`; missing means held. A merged PR or successful held run proves no production write. Current protected `application`, reviewed saved-plan and maintenance branches are documented in the sole execution procedure, not the historical five-job/manual-path recipe formerly here.

Classification starts from observed running builds through the candidate history, including reverted protected changes. Infrastructure, migration/schema acceptance/runner, release-script/workflow and unknown paths cannot silently become ordinary app-only work. Existing migration bytes remain immutable. Only explicitly classified contiguous additive/routine migrations with actual deployed-to-candidate PostgreSQL upgrade evidence qualify for automatic maintenance. Destructive/privilege/ambiguous changes require review.

Exact gate/image provenance is checked before production writes. A new failed gate attempt, changed main/source/state/configuration or mismatched saved-plan binding is not permission to reuse an older pass. Protected environment approval binds one exact execution, not a standing shared-hold override.

### 4.1 The order inside a release, and the policy that is not negotiable

The hosted implementation must preserve these checks and their actual readbacks:

1. Observe current build/digests/schema/task definitions/counts, reconcile unknown writes and validate candidate bindings. Pin a fresh PITR point before any migration. Backup retention/timestamp is measured, restoration remains UNTESTED unless demonstrated.
2. Pause sending under the release's temporary control, preserving stored owner OFF and newer holds. Write the exact immutable release record before new workers can run. Populate required secret entries through the approved path before tasks needing them start, never expose values in plans/logs/artifacts.
3. Before schema maintenance, authenticate the exact release migration image/credential against the expected database/role in bounded READ ONLY. Bind freshness to current credential-version/task metadata. Then drain, wait for idle and recheck authentication/activity/metadata before stopping writers. Refusal leaves services running and clears drain when appropriate. No force-idle/authentication bypass is an operating recipe.
4. Stop schema-incompatible writers before migration. Apply only the authorized exact plan when required. Migrate forward, ensure database users and verify the new schema using the intended runtime credential before restart. An application-only branch must not invent a migration or Terraform rewrite.
5. Start only the exact intended task definitions/digests/schema ranges at declared counts, then verify runtime and canary/public smokes. A generic stable waiter is insufficient: require sole PRIMARY rollout COMPLETED, correct revisions/digests/counts and no pending tasks. A same-digest circuit-breaker rollback can still be the wrong configuration revision.
6. Read the exact stored release record back as `existing`, inspect final stored sending posture and cleanup state, and record actual success/failure/unknown phase. Only a healthy release may remove its own temporary block after fresh checks for already-authorized sending. Never enable stored owner OFF or clear newer stops.

Every supported range is strict at schema transitions. Migrations are forward-only, contiguous and checksummed. Editing an applied migration fails instead of undoing production. A failure after migration leaves the new schema in place. Failure before service restart leaves services stopped for forward repair, not an implied rollback.

Plan/live binding must include the actual service revision, not merely the family's latest ACTIVE definition. Read declared counts from the applicable deployment plan. Unknown or changed bindings refuse. During a restore every applicable plan must preserve the active restored database host rather than silently reverting to the managed instance.

One-off task launches validate account/region/production cluster, exact image, existing network/security-group and credential-entry bindings before dispatch. Retain the returned task ARN, inspect launch failures/exit status and reconcile that same task before retry. Missing exit status is unknown, not success. Production OIDC subjects/environment restrictions and scoped PassRole/resource rights remain enforced; IAM cannot by itself constrain every task-definition field, so exact hosted guards/review are load-bearing.

### 4.1b A schema release never stops production under a call: the idle check, the drain, and the timings (slice A4)

Drain is a bounded audited release control, not the owner's sending switch. Idle checks include active calls, recent command work and non-chunked leased jobs. Unreadable activity is refusal, never idle. Fresh authentication after waiting prevents reuse across credential changes; check activity again because startup took time. Historical first-rollout force-idle exceptions are not current permission.

Worker shutdown drains within its deadline. Uncommitted transactions roll back, expired leases are reclaimed, and chunked work resumes from committed cursors. Provider calls are different: outbound fences and reserved/calling/settled attempts preserve charged/unknown outcomes. A killed worker is not permission to dispatch again.

Timings are observations, not gates or estimates. Missing attributable timestamps remain unknown/null. They are separate from the immutable pre-rollout record because later phase timings did not exist when it was stored.

### 4.1a Rolling back: images only, and never across `beed2d90` or the applied-revision boundary

Standalone production rollback application is retired. Any image repair uses the reviewed hosted path after actual-state reconciliation. Candidate images must accept the current schema. Prior Terraform must not resurrect the deleted restore drill, omit applied-revision outputs, change committed origin/alert/sending configuration, or redirect an active restore host. An image-only repair cannot smuggle infrastructure changes.

Never deregister a revision merely because an update response failed. It may have committed. The safe historical cleanup condition requires ECS-confirmed FAILED new rollout with no tasks on it and the service/sole PRIMARY naming the previous revision. Otherwise retain evidence and reconcile.

### 4.2 The release record, from the CI gate (lane g96)

The `fss.release-record.v1` record binds exact passing push-to-main gate/image runs, commit and API/worker digests. Validate workflow paths/repository/attempt/artifact identity, not display names. Records are immutable: identical bytes return `existing`, different bytes under the same reference refuse conflict. Keep the original bytes through readback rather than rebuilding after a gate re-run.

The record is stored before rollout. A post-smoke readback must find it already existing. Schema-valid storage alone does not authenticate GitHub provenance; the record builder and hosted gates establish that. A record stored for a failed rollout grants no effect to a different running digest. CI records claim no rehearsal drill.

`enablesSending` is not activation permission. Conditional email admission's release evidence, deployment configuration, owner consent, current campaign/source and all runtime fences remain separate.

## 5. The manual steps after the first apply

Historical first workspace/secret/DNS/sign-in setup is in [release-first](../archive/release-first.md). It is not a current local production mutation procedure. Never commit or print secrets, Terraform state/provider values, private runtime payloads or recovery credentials.

## 6. Sending: what binds it

The [outbound gate](../../packages/domain/outbound/gate.ts) rechecks deployment sending configuration, domain authentication/checklist and authenticated owner attestation against a passing record naming the running image. A process-form attestation such as `ci-gate:main` avoids per-release reapproval only for already-authorized configuration. It does not enable a stored OFF switch, grant recipients/content or waive current readiness/eligibility/campaign/source/caps/holds/unknown-write checks.

Deployment enablement requires literal `true`. Domain automated sending requires SPF, DKIM, DMARC and recorded Postmaster review. Fix missing evidence/configuration, never bypass the database constraint. Owner enablement is authenticated/admin, versioned and release-bound, not a side effect of a healthy release. The thirty-day mailbox reply-reception rule remains an operating obligation, not a claim of complete software enforcement.

Release-record unknown/not-passing/digest-mismatch/identity-unknown states fail closed. Turning owner sending off is always accepted, but cannot recall a fence already dispatching. Preserve reply-only opt-out reception and the [mailbox lifecycle](mail.md) rule for recently sent mail. Public health's process `sendingEnabled` flag is not stored owner consent.

## 7. If the release has to be undone

Contain sending, hold further releases, observe actual services/schema/state and fix forward. Cancellation can leave provider or migration writes unknown. A disconnected observer is not a failed/cancelled hosted job. Never blindly replay a plan, migration or outbound command.

A data restore uses [restore](runbooks/restore.md) under separate authority for potential write loss: stopped writers, new point-in-time instance, suppression-journal replay, read-only Sent reconciliation, release binding and verified restart. PITR availability alone is not proof that restoration works. No schema-down migration or incompatible old-image rollback exists.

## 8. Records, and what is still unverified

[Release records](../archive/release-records.md) preserve numbered historical observations. They grant no current authority. [Current state](../operations/current-state.md) links current dated receipts and limitations rather than copying a production ledger here.

## 9. Dependency updates

Dependabot updates remain normal reviewed PRs through required CI, never automatic merge authority. Desktop major changes also require the actual packaging/signing/update path when released, not merely ordinary source checks.

## Operations image retention and availability

Retain an actually pullable operations image for recovery. IMMUTABLE tags are not a retention guarantee. The protected branch checks the exact operations/migration image and actual availability; a stale task-definition ARN alone is insufficient. Preserve current images/recovery artifacts and unknown-write evidence until the owning release establishes safe cleanup.

Tagged release images are retained; only untagged images expire after seven days. Any future pruning must inventory service/one-off references and designated schema-compatible recovery images before removing tags/manifests. Never substitute a new digest in an old release record or widen task roles to bypass missing-image refusal.
