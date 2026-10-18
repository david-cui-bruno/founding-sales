# Deployment simplification research — October 11, 2026

## Conclusion

Recommendation: keep the existing production stack and release scripts. Add a thin operator entry point that assembles a release candidate, presents one reviewed plan and executes the existing ordered procedure. Do not introduce permanent staging, blue/green infrastructure or a new deployment platform to solve coordination friction. Keep deployment separate from capability activation, but assemble their evidence automatically. These are proposals, not permission to release, activate or change sending.

The current production release procedure has succeeded. Most recent failed attempts belong to the temporary Gmail diagnostic, not ordinary production rollout. Calling the entire deployment system broken overstates the evidence. The genuine simplification opportunity is manual assembly, stale documentation and repeated re-binding of independently named artifacts.

## Questions and primary evidence

Reviewed repository sources: [.github/workflows/greenfield-deploy.yml](../../../../.github/workflows/greenfield-deploy.yml), [release invariants](../../../greenfield/release.md), [operator procedure](../../../greenfield/runbooks/operate.md), [deploy.sh](../../../../infra/scripts/deploy.sh), [stop.sh](../../../../infra/scripts/stop.sh), [rollback.sh](../../../../infra/scripts/rollback.sh), [cluster module](../../../../infra/modules/cluster/main.tf), [schema acceptance](../../../../packages/domain/db/schemaRange.ts), [ADR0009](../../../adr/0009-separate-capability-authority-from-settings.md), [ADR0010](../../../adr/0010-isolate-acquisition-acceptance-from-activation.md), [current state](../../../operations/current-state.md), and live GitHub issue bodies [#466](https://github.com/david-cui-bruno/founding-sales/issues/466) and [#552](https://github.com/david-cui-bruno/founding-sales/issues/552). This was a source/document audit; no fresh production observation, deployment, permission change or provider access occurred.

External primary sources answer narrower implementation questions:

- GitHub environments can restrict deployment refs, gate jobs on reviewers and withhold environment secrets until approval. Availability depends on repository visibility and account plan; the actual repository/environment settings were not audited here. A sole founder should not enable a self-review prohibition that makes their own approved deployment impossible. [GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).
- GitHub concurrency serializes runs in a shared group. Default pending-run replacement can cancel an older queued run; ordering is not guaranteed by dispatch time. A prepared release therefore still needs candidate/current-state checks when execution begins. `cancel-in-progress: false` protects an active rollout from replacement. [GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
- ECS circuit breakers detect task-start/health failures and can roll back to an earlier completed service deployment. They do not roll back a database migration or establish application-level correctness. [AWS circuit breaker](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-circuit-breaker.html).
- PostgreSQL schema operations acquire locks; many `ALTER TABLE` variants take exclusive locks. Expand/contract is an application compatibility design, not a switch that eliminates migration locking. [PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html).
- RDS blue/green brings its own PostgreSQL replication/DDL restrictions. It is not an immediate substitute for Callie's strict schema acceptance and migration contracts. [RDS blue/green limitations](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/blue-green-deployments-considerations.html).

## What already exists and works

The automatic app-only workflow already verifies the image publish and exact green gate, checks protected changes since deployed source, stores a release record before promotion/rollout, deploys worker then API, runs public smoke and reads back identical record bytes. It shares a non-cancelling production concurrency group and uses scoped OIDC authority. A green `manual` classification deliberately performs no rollout; it is not a release receipt. [Deployment workflow](../../../../.github/workflows/greenfield-deploy.yml).

For protected schema/infrastructure changes, reusable scripts already implement image pinning/promotion, migration classification, upgrade evidence, read-only migration authentication, drain/idle checks, stop/apply/migrate/start, exact definition/digest checks, smoke and readback. Additive and routine-replacement changes already avoid whole-stack rehearsal when their required real upgrade evidence passes. Changing the external interface need not reimplement those checks. [Release invariants](../../../greenfield/release.md), [operator procedure](../../../greenfield/runbooks/operate.md).

Production schema88/backend d49dda37 and signed desktop1.0.51 were released through that procedure and verified. Source now requires99; it remains unreleased. The recent diagnostic reached migrated99, healthy HTTPS and workspace bootstrap before preparation failed. Its owned cleanup passed. The unlogged original preparation substage is unknown; later reproduced record-command failures were repaired in #578/#579 and a new proposal inspected successfully. Do not infer the original precise failure or claim the repair has passed real Gmail acceptance. [Current operating state](../../../operations/current-state.md).

## What is actually difficult

1. An operator manually coordinates candidate source, image-building source, gate/image run IDs, exact record bytes, schema ranges, Terraform plan, stop/drain, desktop publication and activation evidence.
2. Main may contain operations-only changes reusing earlier images. Operator-facing status must distinguish release source from image source rather than making a user synchronize them mentally.
3. The automatic deploy's protected-path classifier keeps app deploys on the manual path until protected changes have been shipped; merging more application work cannot bypass the accumulated protected change.
4. Documentation has historical commands/numbers inline with current procedure. `operate.md` still describes schema19/20/21 examples near its opening while current source is99. #552 still references schema90 as the next unreleased release. Those are historical/stale references, not accurate current release scope.
5. #466 originally bundled integrated signed release and native behavior acceptance. The signed release is already shipped; OS notification behavior and LinkedIn provider acceptance remain distinct and incomplete. Releasing another backend does not close those obligations.

## Simplest sound release flow

Recommendation: one logical Deploy operation, with a prepare/review stage for protected changes and one bounded execution after approval. A user cannot approve an unknown Terraform plan before preparation; the two physical stages should look like one coherent operator journey.

`Prepare candidate → show changes, outage and checks → approve exact release → execute existing scripts → show deployed/failed/recovery status`

Prepare automatically resolves source/image identities, current deployment, schema delta/class, exact CI/upgrade evidence, prerequisites, compatible rollback availability, immutable record bytes and saved plan. It reports blockers without cloud writes. Execution consumes exactly that candidate, refreshes mutable bindings, serializes against all other production writers and calls the existing commands in order. It keeps new external capabilities disabled and preserves the current sending posture. It should not require manually copying SHA/run/revision values between pages.

Failure handling needs explicit stages: refused before change, drained but not stopped, stopped before migration, migration applied, rolling out, healthy but smoke/readback failed, complete. On interruption, inspect actual durable state before continuing; do not rerun a migration or assume rollback safe from a timeout. Reuse existing operation reports rather than add an independent parallel authority protocol. Migration is forward-only; automatic recovery must never switch to an old schema-incompatible image.

Keep exact schema99 acceptance and planned maintenance for the immediate release. Expand/contract compatibility may be valuable later, but changing schema acceptance ranges safely requires old/new application behavior and worker concurrency proofs. Widening `{99,99}` is not a cosmetic deployment simplification. Current API and worker already enable ECS rollback, but schema releases intentionally stop both because previous strict ranges reject the migrated database. [SchemaRange](../../../../packages/domain/db/schemaRange.ts), [stop.sh](../../../../infra/scripts/stop.sh), [rollback.sh](../../../../infra/scripts/rollback.sh), [cluster module](../../../../infra/modules/cluster/main.tf).

## Concrete ticket recommendations

These are proposed complete units, not published issues and not approval to change live controls.

| Unit | Complete outcome | Reuse / boundary |
| --- | --- | --- |
| Release candidate preparation | One body-free candidate report resolves current release, exact source/images/schema, CI/upgrade evidence, record and saved plan; current blockers and expected outage are readable. A changed binding invalidates it. | `images.sh pin`, `record.sh from-ci`, classification/preflight/current scripts and Terraform saved plan; no new registry/platform. |
| Protected Deploy orchestration and recovery status | One reviewed candidate executes existing drain/auth/stop/apply/migrate/rollout/smoke/readback sequence under shared serialization. Resume inspects actual state, refuses unsafe redispatch and reports whether forward repair or compatible rollback is possible. | Existing scripts/production OIDC boundaries; do not silently broaden the current app-only CI role to full infrastructure permissions. Include signed desktop build/publication when required, or explicitly show its remaining step. |
| Capability readiness and guided Enable | Extend #552: aggregate existing current configuration, release, purpose, acquisition/evaluation/budget evidence; show each missing prerequisite; trusted operations assembles reviewed authority receipt; authenticated enable/disable and readback remain normal product commands. | Existing capability authority and settings contracts; capture does not wait on Ask quality. UI cannot mint its own independent authority. |

A documentation/contract cleanup belongs in these units: current schema/release values derived at preparation time, historical examples moved to history, #466 narrowed to its genuinely remaining acceptance and #552 stale source references updated. Do not add a separate open-ended “clean all deployment code” ticket.

Tests should exercise the coordinator through its operator command and existing external adapters: interruption at each irreversible boundary, fresh binding mismatch, migration failure, smoke/readback failure, concurrent release, already-completed resume and no activation/sending changes. Existing public disposable PostgreSQL upgrades remain the migration proof. Codex can run inspections, normal commands and browser/desktop acceptance autonomously where authorized, producing measured receipts; its statement alone cannot replace OAuth consent, private scope approval, model quality or actual OS delivery.

## Decisions to preserve or explicitly reconsider

ADR0009 separates independent reviewed authority from ordinary settings. A readiness/enable interface can simplify assembly without changing that boundary. Replacing it with “the same command enables itself because its diagnostic passed” is an ADR change, not UI cleanup.

ADR0010 currently requires isolated infrastructure for acquisition acceptance. Testing locally or in a production-isolated workspace is not currently compliant merely because Codex observes it. A simpler acquisition path is worth a specific ADR review; production access, identity/data separation, cleanup, OAuth and sending fences must be stated before replacing the temporary-stack contract. No permanent staging environment is needed by these deployment recommendations.

No hold was lifted and no issue was changed by this research.
