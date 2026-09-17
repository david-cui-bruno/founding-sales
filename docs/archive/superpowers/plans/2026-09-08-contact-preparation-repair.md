# Contact Preparation Repair Implementation Plan

> **For agentic workers:** Use subagent-driven-development. Follow TDD and commit only owned changes.

**Goal:** Restore the existing assessed prospect to explicit contact lookup to editable unsent email workflow through the compact FSS interface.

**Architecture:** Keep the existing assessment worker, discovery snapshots, preparation transaction, enrichment writer and email service. Reconnect a small read-only suggested-contact list and a selected-person action. Mock only external storage/provider transport in integration tests, not preparation, qualification, intake or persistence.

**Tech Stack:** Electron, React, TypeScript, SQLite, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-08-functional-redesign.md`, `docs/superpowers/specs/2026-09-08-user-playbook.md`. User approved this bounded missing-workflow repair on 2026-09-08 at 20:38 UTC.

## Global Constraints

- No generic discovery-question cards, routine founder qualification, bulk lookup, fabricated warm firms or automatic outreach.
- Preserve identity conflicts, fit, suppression, opt-out, freshness, contact verification and rate-limit gates.
- Opening a person or email is read-only with respect to lifecycle. Only explicit selected contact preparation may mechanically make a candidate Ready.
- Keep Call and Email compact. Missing contacts expose one Find contact info action, with truthful pending/refusal status.
- Warm-work precedence comes from the existing capacity-gated backend snapshot.
- Do not touch live profiles, credentials, app bundles, external providers or running app during implementation and tests.
- Root owns isolated package builds. Never build into the running canonical `out` package.

## Task 1: Prove the missing real path (root)

**Files:** `tests/integration/discoveryWorkflow.test.ts`, `tests/e2e/discoveryWorkflow.spec.ts`.

**Interfaces consumed:** `DiscoveryApi.get/getBrief/begin`, `LeadDetailApi.findContactInfo`, real `EnrichmentRequestWriter`, `FounderSalesDomain.importCloudSourceEvent`, `OutreachApi`.

- [ ] Add optional `UpstreamObjectStore` fixture input; construct the real writer with the startup runtime. Keep default external operations forbidden.
- [ ] Import no-contact parcel owners through the actual facade with `cloudEntityId`, drain the real worker, mount FounderApp.
- [ ] Assert a bounded suggested list is reachable and reading/selecting it causes no lifecycle, contact, ledger or outbound mutation.
- [ ] Select a named owner and click Find contact info. Assert exactly the selected entity/address reaches the capture store and the real preparation/ledger persists without manual review.
- [ ] Import a controlled cloud-shaped enrichment response through the actual mapper/facade. Do not promote vendor candidate validation.
- [ ] Observe the new email through selected-person refresh, open Email, edit and reopen the durable unsent draft. Assert no send or unrelated mutation.
- [ ] Run with Node24 Vitest before implementation and record the missing reachable-control failure.

## Task 2: Reconnect compact UI (mouse)

**Files:** existing Today route/page and discovery components/hooks; lead inspector overview/provider; their colocated tests.

**Interfaces:** `discovery.get(): Promise<DiscoverySnapshot>` for suggestions; `getBrief({personId})` then `begin({commandId,personId,salesCycleId,assessmentId,expectedFingerprint})` for explicit preparation; `leadDetail.findContactInfo({personId})` for lookup; owner-scoped preserveView detail reads.

- [ ] Write failing tests for max-three read-only suggestions, one missing-contact action, explicit prepare-before-lookup, and no render-triggered mutation.
- [ ] Render compact Suggested contacts names from the existing fresh backend snapshot. Names select the existing inspector, not a new workspace.
- [ ] For an unreviewed candidate, freeze/reuse the complete preparation request on uncertain response. Validate returned person/cycle/assessment before progressing. Never automatically retry a command.
- [ ] Read current detail after preparation, then invoke the real lookup only when still selected and currently eligible. Display blocked reasons accurately, not success.
- [ ] Keep stale, conflict, missing evidence and low-fit cases closed. Already eligible leads use the existing lookup directly.
- [ ] Refresh pending selected contacts with bounded owner-scoped reads and focus refresh. Never reset an open composer or let late work switch/close another person.
- [ ] Verify rapid clicks, person switches, stale evidence, failed lookup, unavailable credentials, pending/timeout states and teardown. Commit owned renderer changes after focused tests/typecheck/lint.

## Task 3: Validate backend assumptions (llama)

**Files:** relevant existing discovery/enrichment test files. Source changes only for a reproducible blocker, coordinated before editing shared facade.

- [ ] Exercise actual facade intake, assessment, begin, candidate projection and writer eligibility in an isolated database.
- [ ] Confirm selected medium-fit candidates become lookup-eligible, while identity conflicts, suppressed people and unsupported/low-fit candidates remain blocked.
- [ ] Confirm warm work suppresses cold suggestions through backend capacity, not UI heuristics.
- [ ] If a backend defect is proven, add a failing regression first and fix only that defect. Preserve all current safety gates. Otherwise report no source changes needed.

## Task 4: Review, package and deliver (root)

- [ ] Run assembled workflow, renderer, backend regressions and typecheck/lint. Review the independent auditor findings against the exact diff.
- [ ] Replace packaged direct-preparation API bypass with actual UI selection/preparation. Use isolated fixture storage and real intake, never live enrichment.
- [ ] Run full source verification, secret hygiene and a separately signed candidate. Exercise real package light/dark/narrow, pointer actions and process restart.
- [ ] Record what is validated versus blocked by real provider availability. Do not claim an unsent candidate email is send-ready.
- [ ] Keep the existing workspace backup and stable installed bundle. Coordinate normal Quit and verified replacement only after acceptance, then resume the real walkthrough without sending.
