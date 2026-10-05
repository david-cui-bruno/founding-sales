# Sourcing qualification and call-queue admission implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline in the existing isolated worktree. Use one independent whole-branch review before release. Steps use checkbox syntax for tracking.

**Goal:** Turn discovered firms into a useful, evidence-backed call queue, automatically admitting supported matches and keeping uncertain matches in review.

**Architecture:** Extend the existing candidate, research and Today modules. Fetch bounded public pages and use the existing Bedrock transport to propose source-linked facts; deterministic rules decide eligibility. An idempotent transaction attaches the result to an existing or new CRM firm and refreshes Today without creating a deal, enrollment, permission or call.

**Tech Stack:** Node 24, TypeScript, PostgreSQL, existing job worker, AWS Bedrock, React/shadcn/Tailwind desktop. No new service or paid dependency.

**Spec:** [Targeted lead sourcing](../specs/2026-10-04-targeted-lead-sourcing-design.md) and the approved-for-planning [five-part roadmap](../specs/2026-10-05-sales-roadmap-design.md). Baseline: `32684e23230acb033113ec688be357b0dcfacdb4`, schema 49, desktop 1.0.44. This is release A within the [master build plan](2026-10-05-sales-roadmap.md); Tasks 1–7 here are referenced there as A1–A7.

## Global Constraints

- David chose **A then B**: qualification/call-queue admission first; autonomous email second. This plan never changes sending settings or enrolls contacts.
- Prioritize single-family/scattered-site firms in Texas and the Providence/Boston areas; strong residential matches may qualify. Door count is context, not a cutoff.
- Automatic admission requires resolved identity, supported geography/residential fit, a published business phone for this call queue, and an explicit relevant help request or operational burden. Email-only routes remain reviewable but cannot produce a callable card.
- Existing coordinators/software do not disqualify a firm. Generic service promises, tenant instructions, job duties and missing staff entries do not establish unmet need.
- Evidence must have been checked within seven days before admission. Help requests older than 30 days and growth events older than 90 days require revalidation. Missing publication dates remain unknown; an undated job is never described as new.
- Keep facts, generated suggestions and unknowns separate. Page text cannot instruct the worker. Model-selected quotations prove attribution, not correct interpretation.
- Reuse existing research settings and budget controls; no new cash allowance, direct Anthropic/OpenAI fallback, subscription or search-cap increase. Bedrock coverage and gross usage remain visible separately from cash.
- Callbacks, replies and commitments retain priority. All admitted leads remain accessible by pagination; there is no daily display cap.
- Existing stops, assignment, calling-state policy, merge handling and one-active-contact rules still apply. No automatic dialing, opportunity creation, deal changes or suggestion application.
- Preserve the ten-call suggestion trial as a separate evaluation. No-answer is not evidence that a sourcing hypothesis failed.

## Review Focus

1. A maintenance vendor advertises coverage or a firm describes existing support: do not misread it as a buyer asking for help (Tasks 2–3).
2. A shared franchise domain, same-name firm or phone shared by branches: do not silently merge or manufacture identity certainty (Task 4).
3. A dismissed/edited candidate changes while analysis is in flight: charge any dispatched work but discard stale effects and do not admit it (Tasks 1–3).
4. A stop, assignment change or active enrollment races admission: preserve the newer control and create no parallel contact thread (Task 4).
5. A source fails, a job is undated, or midnight passes during processing: preserve historical evidence, mark uncertainty and neither renew freshness nor release potentially spent budget (Tasks 2–3).

## Scope and file map

This plan delivers A, including a small outcome-feedback loop. Employer job-feed adapters, query optimization and social monitoring are later improvements, not prerequisites. Initial fetches use the firm's own allowed pages; external employer-linked sources stay in review until a separately tested adapter supports them. Do not relax the existing blocked-host policy to increase volume.

| Area | Files and responsibility |
| --- | --- |
| Contracts/storage | Extend `packages/contracts/src/sourcing.ts`; add `packages/domain/db/migrations/0050_sourcing_qualification.sql`; add `packages/domain/sourcing/qualificationStore.ts` for versioned runs, evidence, verdicts, admissions and feedback. Reserve migration 50 only if still next at implementation time. |
| Fetch/extract | Add `packages/domain/sourcing/qualificationRun.ts`, `qualificationPrompt.ts`, and `apps/worker/src/sourcing/qualificationExtraction.ts`; reuse research page parser/fetcher, model transport, pricing and reservation ledger. |
| Policy | Add `packages/domain/sourcing/qualificationPolicy.ts` for pure evidence/freshness verdicts and rank tiers. |
| Admission | Add `packages/domain/sourcing/admission.ts`; reuse CRM firm/route functions, identity indexes and Today locks. Extend `crm/merges.ts` only for the new provenance association. |
| Composition/API | Extend `apps/api/src/routes/sourcing.ts`, `apps/worker/src/bootstrap/main.ts`; add `apps/worker/src/handlers/sourcingQualification.ts`; register contract exports and desktop operations. |
| Presentation | Extend `apps/desktop/src/renderer/sourcing/Candidates.tsx`; add a small shared evidence component for Candidates/Today/firm detail. Extend `packages/domain/today/{snapshots,lanes,types,dto}.ts` and their contract for ordering/provenance. |
| Evaluation | Add focused tests alongside existing suites and `docs/sourcing/qualification-evaluation-20261005.md` when the real batch is run. |

New internal result type: `SourcingResult<T> = { ok: true; value: T } | { ok: false; reason: string }`. Commands that change an existing revision carry `expectedRevision`; create commands retain `commandId` and `clientVersion` without inventing a prior version. All repository operations take `RepositoryContext`, scope every read/write to its workspace, and use database time.

### Task 1: Store versioned evidence and qualification attempts

**Files:** contracts/storage above; `packages/domain/research/reservations.ts`; tests `packages/domain/test/sourcing/qualificationStore.test.ts` and `packages/domain/test/db/support/sourcingCases.ts`.

**Interfaces:**
- `requestQualification(ctx, { candidateId, expectedRevision }): Promise<SourcingResult<{ runId: string }>>` queues one run against the current candidate revision; no firm is created.
- `readQualification(ctx, { candidateId }): Promise<QualificationView | null>` exposes `QualificationView = {candidateId:string,runId:string,status:QualificationStatus,observations:SourceObservation[],facts:QualificationFact[],verdict:QualificationVerdict|null,admission:{firmId:string,routeId:string}|null}`. `QualificationVerdict` is defined in Task 3.
- `QualificationStatus = 'pending' | 'running' | 'review' | 'eligible' | 'admitted' | 'unavailable'` is independent of the candidate's existing kept/dismissed state.
- `SourceObservation = { id, url, contentHash, relevantTextHash, retrievedAt, publishedAt: string | null, firstParty, blocks: { id, text }[], truncated }` stores bounded supporting text, not raw HTML. A published date needs a supporting block; retrieval time cannot substitute.
- `QualificationFact = { kind, value, observationId, blockId }`; kind is one of `firm_identity`, `residential_management`, `service_area`, `business_phone`, `help_request`, `operational_burden`, `coordination_job`, `growth`, `tool_gap`, `existing_support`. Store contradictory evidence too. Validate each value against its cited text; unmatched values are unknown, not facts.

- [ ] Write failing persistence tests: cross-workspace references refused; same candidate/revision/run fingerprint is idempotent; candidate edit/dismissal invalidates an in-flight result; source history survives an unavailable refresh; publication date without a source block is refused.
- [ ] Run `npm test --workspace packages/domain -- test/sourcing/qualificationStore.test.ts` and confirm the missing implementation fails.
- [ ] Add workspace-scoped runs/observations/verdicts and a unique candidate admission mapping. Add `sourcing_qualification` to token-priced reservation subjects and the existing SQL subject-kind constraint, without changing accounting for existing subjects. Each paid attempt references its run, not a provisional CRM firm. Preserve source data through candidate deletion only according to the existing deletion/retention contract; do not leave a new unbounded orphan store.
- [ ] Implement request/read functions, audit mutations, enqueue with candidate revision and prompt/policy version. Register schema/version/constraint checks using the current migration convention; never edit a released migration.
- [ ] Run the new suite plus `npm test --workspace packages/domain -- test/db/constraints.test.ts`; confirm passing, then commit `feat: persist candidate qualification evidence`.

### Task 2: Bounded source collection and Bedrock extraction

**Files:** fetch/extract files above; `packages/domain/research/{providers,pricing,reservations}.ts` only where shared interfaces require extension; tests `packages/domain/test/sourcing/qualificationRun.test.ts` and `apps/worker/test/sourcingQualification.test.ts`.

**Interfaces:**
- `runQualification(ctx, { runId }, { pageFetch, extraction }): Promise<void>` advances durable run stages using the job runner's committed-step facilities.
- `QualificationExtractionProvider.extract({ observations, maxInputTokens, maxOutputTokens }): Promise<ProviderOutcome<QualificationExtractionAnswer>>` returns proposed facts via block references and at most one generated opening question (240 characters). It cannot supply quote text or URLs outside the input observations.
- `QualificationExtractionAnswer = { facts: QualificationFact[]; openingQuestion: string | null }`, bounded to 30 facts. URLs, phone normalization and source references are locally validated.

- [ ] Write failing tests for: correct official identity versus similarly named vendor; published main phone versus unrelated footer number; homepage links to resident/maintenance pages; page injection; unrecognized block IDs; truncated evidence; stale candidate; credit-unavailable route; provider timeout after dispatch; shared budget race; midnight crossing; unchanged content reuse.
- [ ] Run the focused domain/worker suites and verify failures occur at the new behavior.
- [ ] Collect up to the configured `maxPagesPerFirm` (default 4, ceiling 8), each within existing byte/robots/DNS/redirect limits. Count the initial page in this same page budget. Prefer the source page, official identity/contact evidence and discovered relevant links; do not spray guessed paths. Unresolved official websites remain review-only. Do not treat an externally hosted search result as the firm's homepage merely because it was returned for the query.
- [ ] Reuse the configured Haiku model through the existing **Bedrock** route. Count the complete new prompt plus bounded page text before dispatch using existing token admission and priced model tables; do not reuse the old extraction prompt's cost bound for a longer prompt. Reserve worst-case usage, commit the calling marker before network, settle once, and preserve conservative estimated cost after uncertain failure. Research holds and caps apply before each dispatch. A noncredit route makes this work wait; it does not fall back to cash.
- [ ] Permit one model dispatch per run, maximum output 2,048 tokens, with a 30-minute total run deadline enforced independently of handler success. A crashed check-up cannot retry forever. Reusing unchanged relevant text still updates successful observation time; it does not change publication time or turn an old help request into a new one. Policy/prompt/model/identity changes invalidate cached interpretation.
- [ ] Store the run's evidence and proposed facts before policy evaluation; recheck revision/dismissal before applying any result. A failed read preserves prior evidence as historical and sets current verification unavailable. Billing settlement survives stale-result rejection.
- [ ] Run focused tests, worker/domain typecheck and affected-file lint; commit `feat: qualify candidates with bounded sourced research`.

### Task 3: Deterministic qualification, freshness and ranking

**Files:** `packages/domain/sourcing/qualificationPolicy.ts`, contract/store extensions, `packages/domain/test/sourcing/qualificationPolicy.test.ts`.

**Interfaces:**
- `qualifyCandidate({ facts, observations, identity, now }): QualificationVerdict` is pure. Identity is `resolved | ambiguous | unknown`, with canonical website/name/location and existing-firm match when resolved.
- `QualificationVerdict = { decision: 'eligible' | 'review'; rank: 'help_request' | 'operational_burden' | 'investigation' | 'fit_only'; reasons: string[]; evidenceIds: string[]; unknowns: string[]; policyVersion: string }`.
- `rankQualifiedLeads(a, b): number` orders categorical tiers, then corroborated evidence before a single source, observation recency, published named business contact before switchboard, firm name and stable ID. It never outputs a buying probability.

- [ ] Write a table-driven failing corpus covering genuine help versus vendor ads, owner responsibility versus explicit overload, technician work versus coordination work, current coordinator job without burden, generic 24/7 claims, reviews, growth without pressure, existing support with/without a stated gap, anonymous author, wrong geography and email-only contact.
- [ ] Add boundary assertions: exactly seven days since observation is accepted, older requires refresh; help older than 30 days and growth older than 90 days need renewed explicit evidence; missing/future dates cannot create urgency; unavailable sources cannot renew evidence; copied job posts count once.
- [ ] Run `npm test --workspace packages/domain -- test/sourcing/qualificationPolicy.test.ts`, confirm the new policy fails before implementation, then implement the interface.
- [ ] Require resolved identity, supported target geography, residential-management fit, source-backed business phone and explicit help/burden for `eligible`. A bare model confidence number, source quote match or human click on Keep is insufficient. Human-reviewed fit/investigation leads may be admitted by the explicit command in Task 4; missing identity/contact evidence and existing stops remain non-overridable there.
- [ ] Produce short supported why-firm/why-now explanations plus unknowns. Undated evidence uses “current page checked …”, never “new opening”. Validate the generated opening question against the facts; use a neutral maintenance-workflow question if unsupported. Ensure AppFolio availability is not generalized to other integrations.
- [ ] Run policy/run regression suites; commit `feat: apply evidence based sourcing qualification rules`.

### Task 4: Atomic CRM admission without parallel prospecting

**Files:** `packages/domain/sourcing/admission.ts`, store/contracts/API, `packages/domain/crm/merges.ts`; tests `packages/domain/test/sourcing/admission.test.ts`, `apps/api/test/sourcing.test.ts`.

**Interfaces:**
- `admitCandidate(ctx, { candidateId, expectedRevision, qualificationRunId, mode: 'automatic' | 'reviewed' }): Promise<SourcingResult<{ firmId: string; routeId: string; alreadyAdmitted: boolean }>>`.
- `reviewed` is an authenticated admin action on the displayed evidence, audited as a reviewed investigation/fit admission; it does not falsely upgrade evidence to confirmed need. `automatic` requires the eligible policy result.

- [ ] Write database tests for concurrent repeated admission; two candidate sources resolving to one firm; shared franchise domains; same-name firms in different metros; stopped phone/firm; email-only stop preserving phone rules; active contact on another route; assignment race; merged firm; stale evidence; missing phone; unenabled calling state. Assert no new enrollments, permissions, opportunities or provider calls.
- [ ] Confirm failures, then implement lock order: Today shared build lock, workspace-scoped sourcing identity advisory lock, relevant firm locks in stable ID order, candidate/run and route locks as required by current CRM ordering. Re-read candidate version, match, stops, ownership and active-contact state under the locks before effects. Check lock order against the merge path and cover that race explicitly; do not hold a row lock during network work.
- [ ] Reuse `crm/import.ts` normalization/index matching, but require name/location corroboration and refuse domain-only franchise ambiguity. A known unambiguous existing firm attaches evidence; never replace its assignee or duplicate its active contact. Do not reset worked/won/lost firms to new. Create a new CRM firm only after admission passes; use a firm-level published phone through `addPhoneRoute` when no named person is known, rather than inventing a contact. Reviewed admissions use the authenticated salesperson; automatic admissions use a persisted sourcing owner who is still an active member. Backfill the owner only for an unambiguous single-salesperson workspace; otherwise keep automatic admission in review until an owner is selected. Do not pick an arbitrary admin or assign a system actor.
- [ ] Resolve actual calling geography/zone from supported location; a Texas-only statement cannot resolve its zone. Reuse existing calling-state/hold and suppression policy. Outside calling hours can still enter the queue with the normal disabled-call explanation; a state not enabled or unresolved zone remains review until resolved. Actual dial authorization always runs again when David calls.
- [ ] Persist the admission mapping and `refreshTodayForFirm` in the same transaction; repeated admission returns the existing mapping. Merges carry the mapping/evidence to the surviving firm while preserving stops. Dismissal removes pending sourcing work, not a previously created deal, callback or CRM history.
- [ ] Run focused admission/API plus existing merge/suppression suites; commit `feat: admit qualified sourcing candidates into the CRM`.

### Task 5: Connect daily discovery to qualification and review

**Files:** worker handler/bootstrap, `packages/domain/sourcing/{discovery,monitoring,qualificationRun}.ts`, sourcing API/desktop operation registries; tests `apps/worker/test/sourcingQualification.test.ts`, `packages/domain/test/sourcing/discovery.test.ts`.

**Interfaces:** `sourcingQualificationHandler(deps)` uses persisted pending runs; `sourcingQualificationSource(enabled)` selects bounded due work. Successful discovery enqueues qualification for new supported candidate URLs; unknown identity starts review, not automatic CRM creation.

- [ ] Write failing tests for discovery replay, dismissed-hit rediscovery, same-domain candidates, missing model transport, exhausted research quota, pause between fetch/extraction, expired run, failed job before deadline check, changed weekly evidence, and backlog larger than one scheduler page.
- [ ] Confirm failures, then connect discovery persistence to idempotent qualification scheduling. Consume the existing workspace research-run counter and caps, not a second free daily allowance. Before automatic admission, invoke Task 4; before staleness-triggered rechecks, preserve completed call obligations. Pending work waits visibly on quota/holds; it cannot mark missing evidence as false.
- [ ] Weekly kept-candidate monitoring detects changes and schedules interpretation only when relevant content/version changes; seven-day admission freshness can require a free re-fetch without a model rerun. Dismissed candidates remain excluded. Content changes do not auto-reopen rejected prospects or alter a deal.
- [ ] Expose “Checking evidence”, “Needs review”, “Ready for calls”, “Waiting for research budget” and specific retryable failures through contracts/API. No separate scheduler service or new chat automation.
- [ ] Run focused suites and composition/missing-secret tests; commit `feat: connect discovery to candidate qualification`.

### Task 6: A useful ranked call queue and lightweight corrections

**Files:** Candidates/evidence UI and Today files above; `packages/contracts/src/today.ts`; add `packages/domain/sourcing/feedback.ts`; tests `apps/desktop/test/sourcing.component.test.tsx`, `packages/domain/test/sourcing/feedback.test.ts` and Today ordering tests.

**Interfaces:**
- `recordSourcingFeedback(ctx, { candidateId, qualificationRunId, code: 'wrong_firm' | 'already_covered' | 'real_pain' | 'not_relevant', note?: string }): Promise<SourcingResult<{ id: string }>>` audits feedback against the version actually shown. Optional note, maximum 500 characters; no automatic stop/deal effect.
- Candidate and Today DTOs include the supported brief, sources/observed dates, unknowns, qualification version/rank and provenance. Ranking applies only within the new-firm lane.

- [ ] Write failing UI/domain tests for obligations preceding higher-ranked new leads; stable order across reload/pages; source unavailable clearly shown; Keep not equivalent to admission; admitted firm linked back to evidence; rapid repeated actions/stale revisions; optional correction with no compulsory form; no unsupported claims in a question.
- [ ] Implement one compact evidence panel: why this firm, why now (or “Timing unknown”), one opening question and expandable sources/unknowns. Reuse React/shadcn styling; avoid permanent metrics/status clutter on the call queue.
- [ ] Extend both SQL read ordering and the TypeScript comparator consistently: preserve existing lane priority; apply Task 3's rank only to `new_firm`, then the existing deterministic tie-breaks. Preserve legacy new-firm visibility. Paginate the ranked result at 50 cards per page with a stable cursor tied to the ordering/version; reload a changed order cleanly rather than silently losing cards. Do not repurpose a due timestamp as a hidden score.
- [ ] Add explicit reviewed admission to Candidates and brief feedback actions to admitted cards. Ineligible candidates show the concrete missing requirement. Controls handle navigation/back/retry without losing a user's input or creating duplicate commands. A wrong-firm correction invalidates the qualification and pending automatic admission, removes its sourcing priority contribution, and marks any existing CRM association for review; it never silently deletes or merges the CRM firm. Other corrections feed review/evaluation without inventing a stop or changing a deal.
- [ ] Run focused component/Today/feedback suites, contract round-trip tests and typecheck; commit `feat: show sourced lead priorities and correction feedback`.

### Task 7: Validate usefulness and release A

**Files:** new evaluation report, this plan's completion ledger, spec status. Product changes only for findings demonstrated by the evaluation.

- [ ] Run one real sourced batch through fetch → extraction → policy → preview. Use existing candidates and shared budgets; do not issue local search requests outside the production quota ledger. Attempt 15–20 examples per available strong hypothesis and a fit-only comparison group. If fewer genuine examples exist, report fewer; never manufacture evidence to fill the batch.
- [ ] Review every automatically eligible result in that batch for correct firm, contact association, evidence meaning/freshness and callable geography. Include the negative corpus from Task 3. Correct any false eligibility before activation. Measure observed precision/unknown counts; do not infer conversion lift from this sample.
- [ ] Show a small admitted batch in the actual desktop. Verify identity/source links, order, review actions, pause/budget messaging and idempotent retries against persisted state. Confirm actual calls still use the existing dial authorization. State clearly which checks were fixtures and which were real provider/product checks.
- [ ] Run `npm run gate:greenfield` with Node 24, the existing migration/upgrade checks and secret scan. Obtain one independent whole-branch review, repair material findings and rerun the affected checks. Rehearse any schema release using the existing release machinery before deploying.
- [ ] Ship without changing any sending controls. Confirm version/schema, run production smoke and read back at least one persisted qualification/admission through the product/API. Record cost, corpus, remaining unknowns and any initial rollout bounds in the report.
- [ ] Commit the evidence/status update, then follow the already written [learning](2026-10-05-sales-learning.md) and [email](2026-10-05-autonomous-outreach.md) plans in master-plan order. A's qualification verdict is never email permission. Do not reopen the completed roadmap interview or postpone planning those subsystems until after A.

## Completion boundary and learning

A is complete when discovery candidates can be researched, explained, reviewed or automatically admitted under the rules above, and the real desktop shows the resulting ranked call queue. It is not complete merely because a model returned JSON or a migration passed. Sourcing-quality improvements continue after release through confirmed pain per answered call, held qualified meetings, customers, correction rate and cost per useful lead; no-answer stays a separate outcome.

Current status: **planned, not implemented**. Discovery itself is deployed/enabled, with its first production-result check still pending the daily quota reset. No additional user credential or purchase is required to start A.
