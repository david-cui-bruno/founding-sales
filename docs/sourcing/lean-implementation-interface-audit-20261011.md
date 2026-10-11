# Lean implementation interface audit — October 11, 2026

Read-only codebase-design audit of the actual current bodies of #547, #580, #581, #549 and #552, root glossary, ADR0009–0011 and current operating state. No cloud operation, provider read, issue mutation, source implementation or activation was performed. The latest ADR amendments govern; earlier receipt requirements remain historical rationale, not the desired interface.

## Conclusion

The three implementation tickets own the necessary simplification. No new architecture or cleanup epic is needed. Establish one integration owner before parallel TDD: the shared database/contracts and the capability verifier are not independent agent work. Most risk is removing the old machinery incompletely or replacing it with a second equally complex mechanism.

Four concrete integration obligations should be explicit in those existing tickets:

1. #547 needs real Google plus a shared API/worker local encryption key, not the existing recorded rehearsal composition.
2. #581 must replace the direct backfill registry query and all legacy receipt-bearing proof snapshots, not only the activation command.
3. #580 must make deployed-baseline bookkeeping and the one-time reviewed backlog path part of the coordinated flow; otherwise automation remains blocked after source closure.
4. #549/#552 own actual production adapter/callback/watch configuration and the first enabled capture. Local success alone cannot close that bridge.

## Three deep modules; small external interfaces

### Local acquisition acceptance — #547

The external interface should be one local runner with `start`, `verify/status` and `cleanup` behavior, or equivalent subcommands of one command. It owns process/database/key resources and returns fixed body-free status and evidence paths. OAuth is an explicit human handoff inside that run. It must not ask the caller to manually compose fake release records, ARNs, provider grants or multiple scripts.

Use a discriminated local/AWS isolation contract at the existing acquisition seam. The local witness binds actual run, artifact, schema, connected database/role and loopback listener identity. The AWS adapter stays for historical documents and explicitly supported cloud diagnostics; it is not called by the new local runner. Production refuses local mode. Keep exact selected-message authority and read accounting; neither isolation nor an OAuth grant authorizes ordinary capture.

Source trace:

- `packages/domain/mail/crmAcquisitionDiagnosticStartup.ts` currently requires an image digest, ECS metadata and AWS-only configuration.
- `packages/domain/mail/crmAcquisitionDiagnostic.ts` runtime and consent witness currently expose AWS-specific fields, including database/cluster ARNs.
- `packages/domain/mail/crmAcquisitionDiagnosticIsolation.ts` performs ECS/RDS/Secrets read-only inspection. Replace the AWS assumptions at the seam, not with an unconditional verifier success.
- `apps/api/src/bootstrap/main.ts` assembles diagnostic runtime; `apps/api/src/server.ts` limits available routes in diagnostic mode; `apps/api/src/routes/gmail.ts` guards consent and cleanup.
- `apps/worker/src/bootstrap/main.ts` selects the restricted diagnostic registry with only the capture handler. Preserve that restricted composition rather than running ordinary CRM/background sending jobs locally.
- `packages/domain/mail/crmAcquisitionDiagnosticCapture.ts` already reuses actual Gmail, access resolution and registered capture work. Retain parser, after-wait authorization and canonical read/delete behavior.

The existing `DataKeyWrapper`/`EnvelopeCipher` interface is a real reusable seam: KMS and local adapters already exist. But `localDataKeyWrapper()` generates its own master key on each construction. Independently starting API and worker with it produces incompatible token envelopes. The runner must own one ephemeral key shared through private run-scoped storage or an equally narrow run-local mechanism, remove it during cleanup, and verify real cross-process decrypt/refresh. Do not persist a production key or reuse installed credentials.

`apps/api/src/bootstrap/deployment.ts` couples the recorded Gmail branch to local encryption and the real HTTPS Gmail branch to KMS. `apps/worker/src/bootstrap/deployment.ts` has the same distinction. #547 must compose **real Google transport plus the local key adapter**, without selecting fixture responses or mocking the API/worker startup. Review localhost callback, session/state/PKCE and cookie behavior through actual browser sign-in; a callback registration alone does not prove session continuity. No new Gmail watch/Pub/Sub infrastructure is needed for the selected-message diagnostic.

Provision/revoke is a closed runner-owned local operation using disposable database roles. Retain existing immutable audit/accounting, but do not preserve unnecessary infrastructure approval packets in the operator interface. Cleanup owns API, worker, database/volume, token/key storage and copied content, and reports uncertain interruption without blind replay. Google revocation remains distinct from local deletion and is confined to the separate diagnostic project.

### Owner capability configuration — #581

Keep the existing authenticated read/save/Enable/Disable command family. A user should learn configuration, scope, budget and blocker reasons; the user should not learn authority fingerprints, migration-role provisioning or deployment image receipts.

The shared interface should return current configured/enabled/readiness state and a structured refusal when current consent or adapter availability is missing. Approval changes use an expected revision. A disabled save is preparation, not authorization. Material changed owner/mailbox/source/provider/purpose/model/data handling or increased budget needs explicit approval. Unchanged releases do not invalidate settings.

Implement current owner authorization in the existing deep module; retain current-source and request-specific checks in its internal seams. Do not introduce an owner receipt issuer, trusted assembler or feature-flag platform under different names.

Source trace and required replacement coverage:

- `packages/domain/crm/capabilityAuthority.ts`: settings snapshots, actual registry verification, release-record/image checks and activation are coupled today. Historical provisioned receipts remain audit; they cease being a prerequisite for new founder-only settings.
- `packages/domain/crm/capabilityVerifiers.ts`: API/worker capture, extraction, answering, embedding and backfill already share a module. Reuse this locality. Its backfill branch queries `crm_capability_authority_receipts` directly; replacing only `verifyCurrentCrmCapability` leaves history import blocked.
- `packages/domain/mail/crmBackfillAuthority.ts`: import snapshots join policy/controls and construct `grantReceipt`, `providerPolicyReceipt`, `evaluationReceipt` and `releaseReceipt` proof fields. Changes need explicit legacy/current version handling and replacement in persisted proof consumers; filling them with invented identifiers is not simplification.
- `packages/domain/business/acquisition.ts` and `packages/domain/crm/processing.ts` also touch registry-dependent activation/configuration. Inventory them with the shared verifier work.
- `apps/api/src/bootstrap/main.ts` and `apps/worker/src/bootstrap/main.ts` construct capability runtime/verifiers and adapters. Worker dispatch, after-wait publication and current original-source access must consume the same configuration decisions as authenticated commands.
- `apps/desktop/src/shared/operations.ts` and `apps/desktop/src/main/operationHost.ts` already expose current activation/read controls. Reuse them, update contracts/blockers and the corresponding views; do not build a parallel readiness application. Some operation descriptions still say independent authority or unavailable activation and must change with implementation.
- `packages/domain/db/migrations/0088_crm_capability_authority.sql` grants ordinary application reads but reserves authority writes to migration. Add an owner-decision audit through an additive migration; do not broaden writes to historical immutable authority tables or rewrite migration88.

`packages/domain/crm/capabilityStartup.ts` is a separate operational constraint: deployed adapters default absent, and model routes include endpoint/model/data/access versions and `fundingVerifiedUntil`. Removing per-release capability receipts does not magically install provider credentials or model adapters. Distinguish technical provider availability from owner scope/budget approval and keep clear blockers. A routine release must not require a new artificial funding timestamp or approval solely because its image changed. Genuine expired credentials/funding and changed purpose still require actionable repair.

Independent answering/embedding budgets, backfill scope/allocation, cancellation epochs, financial reservations and unknown dispatch are preserved. Current person/source access and deletion checks remain outside the simplified owner configuration. Capture never authorizes processing or sends.

### Automatic release — #580

The external interface is merge/main outcome plus one concise reviewed path for ineligible changes. Reuse `.github/workflows/greenfield-deploy.yml` and `infra/scripts/deploy.sh`, `preflight.sh`, `idle.sh`, `stop.sh`, `migration-auth.sh`, `images.sh`, `record.sh` and the existing upgrade tools. One serialized flow owns migration and rollout state. Avoid creating a general release orchestrator beside the existing one.

Source trace:

- The current workflow inspects **all commits since the production image build** and sends migration/schema/workflow/infra paths to the manual path. A new routine branch must deliberately classify the full deployed delta, not only the newest merge.
- `tools/upgrade/classify.ts` provides additive, routine replacement, destructive and unclassified distinctions. Initially automate only explicitly eligible classes with actual deployed-baseline upgrade evidence. Do not relabel the held88→99 backlog as routine.
- The workflow already publishes internal release records before rollout and reads them after smoke. Preserve sending records internally; removing CRM per-release authority is not removing sending's release safeguards.
- Its final attestation still asks the operator to set `FSS_PROD_COMMIT` manually. #580 should own correct baseline bookkeeping or make the observed deployed source the direct input to future upgrade selection. Otherwise the owner still coordinates deployment metadata after every successful rollout. Implement through a narrowly authorized existing operations path; do not silently give a workflow token broad repository or cloud administration.

The migration workflow identity is a one-time infrastructure/privilege prerequisite, not ordinary app-deploy authority. #580 includes its reviewed definition and integration into the existing flow; the actual role application and current backlog rollout remain specifically reviewed operations under #552. A source-only green gate cannot attest either. All writers share release serialization, including the reviewed manual branch.

A routine maintenance run stops work, verifies idle, stops incompatible binaries, migrates, restarts, checks health and resumes. If migration commits and rollout fails, report actual phase and schema so Codex can perform forward repair. Do not automatically boot schema-incompatible old images or call ECS rollback database rollback.

CI selection is an implementation inside the existing always-present gate. Include dependent consumers and broad fallback for shared/unknown paths, selector edits and uncertain impact; retain real upgrades and broader main regression. No second CI policy server, manual suite selection or claimed runtime speedup without measurement.

## Ownership and parallel integration

One integration owner reserves new migration numbers and owns `packages/contracts`, diagnostic authorization/witness types, owner consent/audit schemas, shared capability proof semantics and startup composition contracts. Publish those interfaces before the agents fork incompatible versions.

Parallel work then divides cleanly:

- #547 agent: local runner/witness, private key lifecycle and restricted real-Google composition against agreed contracts.
- #581 agent: owner settings, shared verifiers, backfill proof replacement and desktop controls against those contracts.
- #580 agent: workflow/scripts, affected-CI selector and release state; no edits to CRM authority tables.
- #548 preparation: labeled synthetic/usefulness cases, independent of those source edits.

Integration owner exercises actual API→registered worker→database composition, additive upgrade from deployed88 and current99, ordinary startup and diagnostic startup, unchanged-release enabled settings, and disabled/revoked/deleted/uncertain work. Unit tests alone cannot prove the shared composition works. Owner config changes must not accidentally remove capture's ordinary observer or enable sending; local mode must not register ordinary jobs.

## Remaining roadmap bridges and simplification

#549 owns ordinary business qualification/new-thread capture, actual incoming/manual Sent, history continuity and coverage beyond the exact diagnostic. It should use one checklist separating reused controlled regressions from real-provider and deployed readiness observations. Its earlier wording requiring exact release authority is superseded by the final lean amendment; remove stale language during ticket reconciliation.

#552 owns the one-time held backlog review, actual deployed configuration and owner enablement. This includes `FSS_CRM_CAPABILITY_ADAPTERS`, deployed Google clients/callbacks, token encryption, normal watch/push where needed, actual connected account and live ordinary worker behavior. Mark missing provider/data/budget choices explicitly. Do not close #549/#552 from local capture, or make all these observations another independent infrastructure epic.

Historical AWS diagnostic contracts, workflows and records may remain inert for evidence compatibility. Stop making them prerequisites for local acceptance. Delete obsolete live prerequisites and callers as part of #547/#581 rather than leaving two active authorization systems. Keep historical immutable audit and current financial/source-deletion behavior; a broad cleanup effort adds no immediate value.

The glossary still defines capability authority receipts as independent current review; update it with the superseding owner-consent term when #581 lands, preserving the historical term for old evidence. This is a small terminology repair, not a domain redesign.

No stack/framework research is needed to select these seams. A focused Google localhost/session/encryption integration check, narrow GitHub workflow identity/baseline check and cross-process/worker tests answer the implementation uncertainty. Research into agent harnesses may inform Ask separately; it should not delay removing release and activation friction already owned here.
