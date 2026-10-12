# Remaining roadmap and lean release contract audit — October 11, 2026

## Conclusion

The roadmap has **nine open execution tickets**, not twelve: #425, #438, #460, #466, #548, #549, #550, #551 and #552. #418, #441, #479 and #497 are four tracking parents, not four additional implementation units. The captured issue inventory and a fresh read-only GitHub open-issue query agree. #547, #580 and #581 closed after [PR582](https://github.com/david-cui-bruno/founding-sales/pull/582) merged at21:58:49UTC as `b57e7dcc8295fd0002a4b3f5ee77c8263efa30b8`; checked source is `a9be6eb05646ff35b22b0ea5a01f15bdabcbab3d`, schema104.

Most remaining release/CRM scope is **actual acceptance and operational configuration**, rather than unimplemented foundations. Ask and extraction quality are genuine unfinished work; new research should help separate model reasoning, evidence retrieval and execution budget failures. Neither additional release infrastructure nor another authority-receipt system follows from the current evidence.

This was a read-only audit plus this report. No runtime edit, ticket mutation, paid call, grant/bootstrap, held deployment or activation occurred.

## What the latest workflow actually proves

Fresh GitHub reads show successful main gate38178555963, images38178555964, infrastructure38178555951 and deploy workflow38178977774 at merge `b57e7dcc`. **Deploy success means the workflow correctly reported held**, not rollout: its logs contain `FSS_RELEASE_HOLD: true`, and application deployment, maintenance, reviewed preparation/application, smoke and release-record readback were all skipped. [Actual deploy run](https://github.com/david-cui-bruno/founding-sales/actions/runs/38178977774).

The dated production observation remains d49/schema88 and installed desktop1.0.51. This audit did not refresh production database/sender state and does not turn a previous observation into a current read. See [current-state](../operations/current-state.md). Source104 is not deployed104.

## Ticket-by-ticket assessment

| Ticket | What already exists | Actual remaining obligation | Dependency character |
|---|---|---|---|
| [#425](https://github.com/david-cui-bruno/founding-sales/issues/425) | Scoped admission controls/worker and historical sending/authentication evaluation; original release source shipped | Fresh exact admission policy/sequence/control binding, applicable sender/ramp/authentication and reply/opt-out/booking interruption evidence, then conditional activation and bounded ordinary observation | Independent sending scope; CRM setup cannot grant it |
| [#438](https://github.com/david-cui-bruno/founding-sales/issues/438) | Supported office-card parsing and retained ordinary discovery observations | Reproduce complete-page identity/geography/residential/source-selection shortcomings, correct through supported revision-bound boundaries, prove applicable policy behavior without widening domain or targeting rules | Independent discovery work; zero supported routes is a real yield problem, not proof all code is missing |
| [#460](https://github.com/david-cui-bruno/founding-sales/issues/460) | Native adapter, preparation diagnostics and source readiness repair | Corrected signed desktop; actual at-most-one approved schedule→inspect→restart→cancel observation on exact run2 identity | Native/social scope; no backend CRM blanket gate |
| [#466](https://github.com/david-cui-bruno/founding-sales/issues/466) | Signed1.0.51, persistent alert state and safe incomplete-reply refusal | Actual visible OS alert/click, closed-app launch, coordinated physical sleep/wake and complete authorized unsent reply context | Native scope; source callbacks cannot prove visibility |
| [#548](https://github.com/david-cui-bruno/founding-sales/issues/548) | Reviewed synthetic labels and retained paid-run outcomes | A useful evaluated capability set with honest limitations; actual model outputs and owner usefulness judgments where applicable | Quality preparation can proceed without Gmail capture or thirty customer threads |
| [#549](https://github.com/david-cui-bruno/founding-sales/issues/549) | Business qualification, bounded earlier-thread capture, rules, representation and recovery source; completed isolated two-message lifecycle | Ordinary production OAuth/callback/storage/provider composition, first normal registered-worker capture, recovery and usable selected-input/deletion outcomes | Gmail-backed scopes only; not a universal dependency for selected-source Ask |
| [#550](https://github.com/david-cui-bruno/founding-sales/issues/550) | Extraction configuration and controlled booking/opportunity/Today/brief/human-attendance journeys | Actual supported interpretation and meaningful owner review; offer/current/historical semantics are presently unaccepted | Deterministic progress and hosted extraction are separate outcomes |
| [#551](https://github.com/david-cui-bruno/founding-sales/issues/551) | Bounded agent/tools, sessions/history/citations, indexing foundations, structured output and browsing repairs | Actual useful model/tool/retrieval outcomes, latency/cost evidence and capability-specific owner review | Primary remaining Ask architecture/quality work |
| [#552](https://github.com/david-cui-bruno/founding-sales/issues/552) | Merged lean workflow and authenticated owner approval/Enable/Disable source | One-time deployment-role/environment bootstrap, concrete reviewed held104 rollout, ordinary configured provider operation, explicitly scoped enabled readback | Integration owner shares capture evidence with549; separate capabilities can pass independently |

The current #425 contract preserves outreach authority that was intentionally excluded from CRM owner setup. Its activation receipt is a sending safeguard, **not automatically stale** because #581 removed per-release CRM receipt provisioning. Preserve it unless a specific separate sending decision changes it.

## What source inspection establishes

### Release module

[ADR0011](../adr/0011-lean-automatic-releases-with-maintenance.md) and [lean release runbook](../operations/lean-release-workflow.md) define the existing approach: app changes and explicitly eligible routine migrations automatically deliver once the hold is specifically lifted; unknown/destructive/privilege/protected changes get one concrete review. No permanent staging or new platform.

Actual source boundaries:

- `.github/workflows/greenfield-deploy.yml`: shared `fss-production-deploy` queue; hold defaults true; automatic, maintenance, read-only `review_prepare` and exact `reviewed` modes. Preparation may run held; application may not.
- `tools/ci/release-plan.ts`: full deployed→candidate history, byte-identical deployed migration checks, contiguous migrations and explicit classifier exclusions. It records even infrastructure added then reverted. It does not classify just the most recent PR.
- `tools/ci/resolve-prod-base.sh`: observed `/health` build/schema replaces stale `FSS_PROD_COMMIT` copying; no variable fallback.
- `tools/ci/select.mjs`: an always-present gate selects API/domain/desktop or worker/domain/API consumer suites for known paths; shared/unknown/selector changes broaden; main always broad. `tools/ci/run-selected.mjs` records executions. This is suite selection, not an asserted wall-clock improvement.
- `infra/scripts/maintenance-release.mjs` and `reviewed-release.mjs`: readiness, immutable images, saved-plan binding, stop/migrate/start, smoke/readback and partial-failure state. PITR inventory is not a demonstrated production restore.
- `test/ops/routineRelease.check.ts`: additive/hold behavior, destructive/privilege/opaque review routing, reverted-infrastructure detection and old migration-byte refusal.
- `test/ops/maintenanceRelease.check.ts`: controlled successful sequencing, actual-shaped RDS readiness, refusal before writes and unknown-after-migration/forward-repair status.
- `test/ops/reviewedRelease.check.ts`: manifest binding, stable baseline/state and encrypted saved-plan preparation with controlled adapters.

Closed #580 is source closure. Newly defined CI roles/environments are not automatically provisioned. The runbook has one explicit bootstrap exception for the existing trusted administrator path while writers are frozen, then returns to the one queue. This is an operational prerequisite, not reason to create another release workflow.

### Owner configuration module

`packages/domain/crm/capabilityAuthority.ts` implements authenticated owner approvals, expected revisions, immutable audit, independently configured adapter availability, provisional limitations and ordinary Enable/Disable. `verifyCurrentCrmCapability` uses current enabled `owner_approval_id` and matching configuration fingerprint rather than a fresh image-bound registry receipt.

`packages/domain/crm/capabilityVerifiers.ts` rechecks this authority for acquisition/processing and adapts worker work to the original active owner. Its backfill branch now uses owner approval bound to the import/allocation configuration. `packages/domain/mail/crmBackfillAuthority.ts` preserves old documentary fields and adds current owner approval rather than inventing old receipt IDs. Historical privileged receipt provision/revoke helpers remain in source as historical/diagnostic operations; their mere presence does not establish two active founder-only activation mechanisms.

`apps/api/test/crmCapabilityActivation.test.ts` exercises unchanged-release enablement, configured-adapter refusal, disabled saves, material configuration changes, metadata/capture consent linkage and departure. It explicitly accepts current capture configuration with null historical grant/provider/evaluation/release receipt fields. These are controlled source contracts, not measured Google/model acceptance.

## Stale contract and documentation findings

The top of `docs/sourcing/roadmap-20261007.md` and historical paragraphs in `docs/operations/current-state.md` still describe twelve execution tickets, schema99 as the target, #547/#580/#581 as the parallel source frontier and the old registry as current. Historical detail may stay, but the leading current checkpoint should say nine execution tickets, merged104 source and held88 production.

#552 and #466 bodies still call the current held candidate schema99; actual candidate is104. #552 says scope-specific independence correctly, so update candidate/version wording without adding a new dependency. #552's title “independently verified” does not require a second reviewer or old per-image receipt system; latest body explicitly rejects those ceremonies.

The roadmap's older Ask paragraph says final #551 depends on #549. Later reconciliation supersedes that blanket dependency. State it once as: **Gmail-backed answers require applicable549 evidence; selected-source/structured Ask does not.** Likewise older “current code enforces previous receipt mechanism until581” wording is now historical source status, not current code status.

The native plan `docs/operations/native-acceptance-plan-20261011.md` describes run2 approval as proposed, while the later owner approval is retained in current-state. Preserve exact text/date/submission limit and attach approval status rather than requesting it anew. Its schema98 preparation wording also predates current104 source.

These findings justify one authoritative checkpoint/contract update. They do not justify reopening completed foundations, resetting approvals or rebuilding tested modules.

## Lean critical path and useful research

There are two concurrent critical paths:

1. **Operational bridge:** approved exact bootstrap→readback→review_prepare of actual held source/images→one concrete held release approval→normal rollout/health/readback→ordinary scoped provider setup/capture549 and capability activation552.
2. **Ask/extraction usefulness:** isolate model reasoning with known evidence; independently measure retrieval recall and source/context selection; research model/latency/cost and generation budget; then evaluate the changed configured integration and review meaningful outputs under548/550/551.

Capture can become useful before Ask. Selected-source Ask can be evaluated before ordinary Gmail. Backend capture need not wait for notification/LinkedIn acceptance. Discovery438 and admission425 maintain their own source/policy/sending prerequisites and can progress independently. Native460/466 follow the corrected signed distribution and actual human/OS/provider availability.

Additional research worth doing is targeted: (a) retrieval recall/precision and exact SQL versus keyword/vector responsibility, (b) stronger-model reasoning and output reliability with known evidence, (c) final-answer reserve/latency/cost limits, and (d) capture representation/attribution cases that actually affect commitments. Deployment research is no longer the bottleneck: the settled workflow is implemented, checked and currently held by design. Researching another release platform, permanent staging or another general agent harness would not resolve those operational prerequisites.

## Evidence limits

Primary evidence inspected: captured `.context/roadmap-audit-20261011/issues.json`; fresh GitHub issue states/PR582/run38178977774 logs; current-state and linked roadmap/ADRs/runbooks; the source and test files listed above. This audit read tests but did not rerun suites. It did not verify fresh cloud roles, sender controls, production grants, installed-client state, live model quality, vector quality, OAuth or OS behavior. Prior dated receipts remain prior dated receipts.
