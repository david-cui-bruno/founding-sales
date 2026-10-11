# Lean startup release research — October 11, 2026

## Decision context

David now accepts crashes, failed jobs, temporary downtime and imperfect AI, including a short migration maintenance window and hours of repair. Retain the protections against lost business history, unintended sends and exposure of another person's data. Proposed default: merges automatically deploy app changes and classified routine migrations after focused CI; destructive changes receive specific review. Codex performs technical acceptance, with only a few owner-visible outputs rather than a new ceremony for every release.

This report assesses feasibility. It does not change ADRs, tickets, runtime policy, roles, operational approvals or the existing release hold.

## Smallest feasible implementation

Recommendation: extend the existing deployment workflow with a narrowly defined routine-migration branch that calls existing stop/drain, migration and restart logic. Keep strict schema acceptance and accept planned downtime. There is no immediate need for overlapping schema ranges, zero-downtime expand/contract, blue/green deployment or another environment.

Current source requires schema99; both API and worker ranges are exactly `{99,99}`. Earlier images therefore refuse a changed schema. Existing `stop.sh` authenticates migration credentials, drains work, checks idleness, rechecks credentials and scales API/worker to zero. Existing `deploy.sh release --schema-change` validates exact planned definitions, migrates, starts and verifies both services. Automating this sequence changes who coordinates it, not the migration behavior. [Schema acceptance](../../packages/domain/db/schemaRange.ts), [stop.sh](../../infra/scripts/stop.sh), [deploy.sh](../../infra/scripts/deploy.sh).

Migration runner checks historical checksums and applies each migration in a transaction. This does not make all multi-migration releases atomic: if an earlier migration commits and a later one fails, status must report actual applied version and forward repair. Do not blindly restart the old binaries after a committed migration. PostgreSQL transactions group participating statements; they do not reverse already committed prior transactions. [Runner](../../packages/domain/db/migrationRunner.ts), [PostgreSQL BEGIN](https://www.postgresql.org/docs/16/sql-begin.html).

## Existing machinery to retain internally

- Immutable CI image digests and exact record bytes, assembled by code rather than typed by David. Workers currently require a stored passing release record naming their image. Removing that record is a sending-gate policy change; making its preparation/write/readback automatic is straightforward reuse. [Release record and sending invariants](../greenfield/release.md).
- Current observed production schema as upgrade-test baseline; a successful test against branch-parent schema is not proof of the actual deployed upgrade. Existing upgrade job already resolves production health only when schema/migration inputs changed. [Greenfield gate](../../.github/workflows/greenfield.yml).
- One serialization group across automatic and operator release writers. `cancel-in-progress: false` avoids intentionally interrupting active rollout. GitHub concurrency does not establish candidate freshness or guarantee dispatch-order execution; recheck source/current deployment at execution. [GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
- Actual status after partial failure: stopped, schema advanced, rollout incomplete, healthy but smoke failed. ECS circuit-breaker rollback cannot reverse a database migration. Accepted downtime reduces availability requirements; it does not justify falsely reporting success. [AWS circuit breaker](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-circuit-breaker.html).

## Concrete constraints before automation

**Routine classification is not yet broad enough for the current backlog.** I ran the existing read-only classifier on migrations89–99 using supported Node24. Results: nine `touches-existing`, one `destructive` (0092), one `replaces-routine` (0099). Current rules treat only additive/routine-replacement classes as avoiding full rehearsal after actual upgrade evidence. The entire88→99 release cannot be called routine based on its final migration. [Classifier](../../infra/scripts/classify-migration.sh), [shared classifier](../../tools/upgrade/classify.ts), [release classification](../greenfield/release.md).

Recommendation: initially auto-deploy only the existing explicit eligible classes, with genuine deployed-baseline upgrade checks. Review destructive/privilege/unclassified changes; assess whether `touches-existing` needs a narrower safe subclass using actual statements and data-preservation proof. Do not add a blanket automatic exception simply because a migration changes existing tables. The current88→99 backlog needs its own reviewed release scope under the accepted maintenance/repair posture.

**The app-only CI role cannot perform migrations.** Its policy intentionally excludes migration families/roles, Terraform state and infrastructure authority. A schema branch requires a reviewed narrowly scoped workflow identity or separate role, not calling existing commands with assumed permissions. Prefer a routine schema branch limited to current production runtime definitions and migration operations; broader infrastructure/IAM changes remain reviewed. OIDC trust binds the workflow environment identity; changing workflow UX does not confer cloud permissions. [Current CI role](../../infra/roots/production/ci_deploy.tf), [AWS OIDC](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html).

**SQL locks still exist.** Maintenance makes them easier to manage, but a stalled lock should yield a bounded failure and visible repair rather than an indefinite release. PostgreSQL exposes statement/lock timeouts; use the existing migration/session implementation deliberately and test the refusal, rather than assume default settings impose a bound. [PostgreSQL16 client defaults](https://www.postgresql.org/docs/16/runtime-config-client.html).

## Focused CI: current facts and recommendation

Actual `.github/workflows/greenfield.yml` defines four jobs: broad `greenfield`, conditional-execution `upgrade`, `workflows` and `secrets`. Its broad job runs `gate:greenfield`: global typecheck/lint, contracts/domain/API/worker/desktop tests, operations tests and Ask evaluation tests. It triggers for every PR and main push without path filters. Configured timeouts are20minutes broad gate,30upgrade,5workflow,30secret; these are upper limits, not measured duration or guarantees. Prior successful runs around17minutes do not establish future timing. [Workflow](../../.github/workflows/greenfield.yml), [package scripts](../../package.json).

Recommendation: one always-present required gate computes affected areas and dispatches focused existing suites. Shared contracts/domain/database/build/release/auth/ownership/deletion/sending changes require their dependent consumers; unknown paths and selector changes fall back to broad coverage. Preserve cross-cutting no-loss/no-unintended-send/no-cross-owner regressions. A desktop-only cosmetic edit need not run unrelated Gmail/Ask quality suites. Run broad regression periodically and for dependency/shared changes, with failures visible; periodic coverage does not excuse known affected tests failing before deploy.

Do not blindly place workflow-level `paths` filters on required checks: a skipped workflow can leave required checks pending. Use conditional jobs behind an always-produced gate, and explicitly reject missing or failed required selected jobs. GitHub documents the skipped-required-check behavior. [Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpull_requestpull_request_targetpathspaths-ignore).

No numeric speedup is established by this source audit. First implementation should record which suites ran, why and observed durations, then verify selector coverage against representative changed-file cases. A new elaborate test-selection platform would defeat the simplification.

## Shrink the two existing tickets

**#580:** make merge-to-deploy the normal outcome for app and explicitly eligible routine schemas. The existing prepare/execute/status interface becomes code-internal orchestration and the exceptional reviewed flow for destructive/infrastructure changes. Reuse exact image/record/migration/rollout modules. Include focused CI selection in this unit if reasonably scoped; do not spawn a platform project. Source acceptance proves selection, stage failures and preservation fences; separately observed production execution remains actual deployment proof.

**#581:** keep capability readiness and trusted operations, but avoid asking David to assemble technical receipts each release. Codex/code loads evidence, refreshes applicable exact-release bindings and reports only meaningful missing decisions. Owner approval concerns changed account/source/data/purpose/spend or external action scope; unchanged technical rebinding can follow an explicitly approved ongoing policy. This policy must be stated and implemented, since current ADR0009 requires independent reviewed exact bindings. Do not silently treat present receipts as version-agnostic.

The desired owner experience is: connect Gmail once; approve intended capability/data/spend scope; review a handful of actual CRM/Ask outputs; then see changes deploy and operate, with disabling and failures visible. This is a design target, not permission to execute provider consent or paid calls now. Codex observations can provide the technical evidence; an unsupported inference that a provider operation happened cannot.

## Immediate implementation frontier

First freeze auto-versus-reviewed release classes and the narrow migration-role contract. Implement selectors and existing stop/migrate/start orchestration under one integration owner. In parallel, implement local Gmail acceptance and the approved provisional AI/readiness seam. Keep immutable sending/history/privacy protections; do not spend another sprint pursuing zero downtime or independent receipt-entry screens. The existing held99 release is a reviewed backlog, not the first automatic routine example.

No deployment, cloud role change, provider call, ticket edit or ADR edit occurred in this research.
