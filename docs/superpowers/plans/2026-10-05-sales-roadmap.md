# Five-part sales roadmap implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline in the existing isolated worktree. Preserve the selected native execution method and one independent whole-branch review per release. Steps use checkbox syntax for tracking.

**Goal:** Deliver continuous lead discovery, evidence-based qualification, a ranked call queue, outcome learning, autonomous Gmail outreach and approved text/image social scheduling.

**Architecture:** Extend the existing domain modules, Postgres, API, job worker and Electron desktop. Reuse the sender and sequence engine; add firm-level sequence ownership rather than invent deals. Social scheduling uses a narrow desktop-owned browser session to hand approved posts to native platform scheduling.

**Tech Stack:** Node 24, TypeScript, PostgreSQL, AWS Bedrock, existing AWS infrastructure, React/shadcn/Tailwind and Electron 44. No direct Anthropic/OpenAI billing, new subscription, paid X integration or new general-purpose service.

**Spec:** [Five-part design](../specs/2026-10-05-sales-roadmap-design.md). Design approval for detailed planning: David's request to write this plan after the Gmail/social clarifications. Product baseline inspected: `32684e23`, schema 49, desktop 1.0.44. Refresh baseline at execution; do not assume production stayed here.

## Global Constraints

- Plan all five parts before execution. This plan and its linked plans are not an activation report.
- Execute in the existing suitable worktree after checking its changes, branch and current main. Do not use the stale primary checkout as the product baseline.
- Stronger leads into calls first; autonomous email next; social follows. Outcome attribution ships with/after sourcing and collects data while email is built.
- Preserve the $25 additional monthly cash ceiling. Only eligible AWS/GCP credits and existing free allowances; no new cash allocation. X costs $0. Existing credit-covered development allowance is not cash and is not a new recurring runtime allowance.
- Gmail uses david@usecallie.com under David's reported account-specific Google permission. No visible unsubscribe link; recipient stops, domain pause, authentication, limits and direct-send takeover still apply. Do not enable sending merely by deploying code.
- Social: David's LinkedIn/X profiles and Callie's Facebook Page; exact draft/image/account/time approval before scheduling; text, screenshots, web images and phone photos, no videos.
- One active outreach contact per firm; no automatic creation or advancement of deals. Qualified means a held demo, a buying participant, real maintenance need and openness to paying.
- Settled starting cadence: five total emails for email-only firms, or four emails plus up to four call attempts for call-first firms, over roughly 21 days. One cold touch per firm/local day; replies, requested callbacks, bookings and stops interrupt obsolete cold work. E3 defines spacing, weekday adjustment, lifetime caps and fixed expiry.
- Keep React/shadcn/Tailwind, quiet Today and existing meeting follow-through. No whole-web crawler, vector database, workflow builder, account farming or release-system rewrite.
- New commands use authenticated workspace scope, commandId/clientVersion, expectedRevision and audited mutations. Network work never runs while holding database row locks. Repository/database time governs deadlines.

## Review Focus

1. New cold prospect without an opportunity must work without creating a fake deal: email Task E2.
2. A user edit, mailbox switch, firm merge or stop races a paid/external action: sourcing A4, email E0/E3/E5, social S2/S4.
3. Resumed backlog must not burst calls/emails/posts or repeat ambiguous actions: email E3/E5 and social S4/S5.
4. A small/biased cohort must not become a claimed conversion winner: learning L1–L3.
5. A Mac sleep/login expiry or wrong social account must not publish the wrong thing or duplicate a post: social S0/S4/S5.

## Build order and independently usable releases

| Order | Deliverable | Detailed plan | Depends on |
|---|---|---|---|
| V | Close discovery's real-production verification gap | V1 below | Existing deployment; read-only access |
| A | Verified evidence, reviewed/automatic admission, ranked call queue | [Qualification and admission, A1–A7](2026-10-05-sourcing-qualification-admission.md) | Existing candidates; V result may still be zero |
| L | Sourcing attribution, qualified-demo facts, learning report | [Learning, L1–L3](2026-10-05-sales-learning.md) | A evidence/admission identifiers |
| E | Gmail eligibility, firm-level coordinated outreach, routine replies | [Email, E0–E6](2026-10-05-autonomous-outreach.md) | A; L attribution interface, not statistically significant results |
| S | Image library, content drafts/approval, free native scheduling | [Social, S0–S5](2026-10-05-social-publishing.md) | Approved fact blocks from E1; existing meeting/call evidence |

Prefer two social releases: drafts/assets first (S1–S3), delivery second (S4–S5). The S0 capability probe precedes both to settle runtime assumptions. Email can similarly split compatibility/storage from enabled automation, but do not label incomplete reply handling complete. No fixed dates or progress percentages until execution evidence exists.

## Shared file and interface rules

All paths in linked plans are repository-relative. Existing integration seams are `packages/contracts/src/index.ts`, `apps/api/src/bootstrap/{routes,routeRegistry}.ts`, `apps/desktop/src/shared/operations.ts`, `apps/desktop/src/main/{operationHost,todayWindow}.ts`, and `apps/worker/src/bootstrap/main.ts`. Register each new read/command/job using these seams, with contract tests; do not introduce a generic renderer-controlled URL or shell bridge.

New domain directories must also be included in `Dockerfile.api`, `Dockerfile.worker` and their dockerignore/import-closure checks as appropriate. Pin migration/version updates in `packages/domain/db/{migrationRunner,schemaRange}.ts` and their existing fixtures; don't let a desktop-only success hide an omitted server module.

Assign additive migrations from current main when their release starts. Suggested migration **stems**, not pre-reserved numbers: `sourcing_qualification`, `sourcing_learning`, `gmail_prospecting_authorization`, `outreach_scope`, `outreach_replies`, `social_content`, `social_delivery`. Combine tightly coupled schema changes in a release, but never modify released migrations. Add corresponding schema/version/upgrade fixtures and retention/merge/restore handling with the owning task.

Signatures in linked plans use `Ctx = RepositoryContext`, UUID/ISO-date strings, and the existing result convention `{ok:true,value:T}|{ok:false,reason:string}`. Contract schemas narrow refusal codes before they reach the UI. Reuse existing types when names coincide; do not add a parallel database abstraction. Each plan defines the new DTO fields its later tasks consume. For new revisioned records, expectedRevision=0 means absent; successful creation returns revision 1. Existing-record changes require the exact current revision. Existing tables without a revision use their established identity/assignment guards rather than an invented field.

## Task V1: Verify the deployed discovery cycle and establish yield baseline

**Files:** Read `packages/domain/sourcing/discovery.ts`, `apps/worker/src/{handlers/sourcingDiscovery,sourcing/tavilySearch,tools/fss/discoveryConfigure}.ts`, `packages/contracts/src/sourcing.ts`; write `docs/sourcing/discovery-production-verification.md`. No product edit unless an actual defect is reproduced.

**Interfaces:** existing `sourcing.candidates.list` read returns candidates plus `discovery:{enabled,nextRunAt,lastResult,dailyRemaining,monthlyRemaining,halted}`. Counts/evidence queries use existing read-only administrative access; do not add an operations command merely to avoid reading the existing one.

- [ ] Read the current deployment/schema and verified workspace ID; inspect latest discovery attempt, shared usage, next run and orphaned dispatch state. Redact credentials and contact content from the report.
- [ ] Follow a due attempt through request ID, conserved usage and persisted hits/candidates. If none is due or quota is exhausted, record waiting and proceed with A fixtures/existing candidates; do not reset quota, dispatch a local request outside accounting or silently increase one query/day.
- [ ] Read Candidates through the real API/desktop and compare IDs/counts. A successful zero-hit request passes execution verification but leaves useful yield unproven. If results exist, distinguish duplicates, category fit, reachable firms and genuinely supported need.
- [ ] Record at most five hits/query, current shared 20/day and 600/month bounds, unknowns and the next meaningful check. Use existing search evaluations as baseline; do not extrapolate qualified demos from raw hits.
- [ ] Commit the factual report. If a defect exists, reproduce it in the relevant existing discovery suite before a narrow fix; no speculative rewrite.

## Task R1: Apply the same release gate to each completed release

**Files:** existing `.github/workflows/greenfield-release.yml`, `infra/scripts/rehearsal.sh`, `scripts/{productionSmoke,verifySecrets}.mjs`, `tools/upgrade/main.ts`; each plan's completion ledger. Read these interfaces before invoking operational commands; the plan does not invent release flags.

- [ ] Run the owning tasks' focused tests first with Node 24: `npm test --workspace packages/domain -- test/<suite>.test.ts` and equivalent `apps/api`, `apps/worker`, `apps/desktop` paths. A changed-behavior test must fail for the old behavior and pass for the change; use the real database suite for lock/constraint races.
- [ ] At the release boundary run `npm run gate:greenfield`, `npm run upgrade:test` for schema changes, and `npm run verify:secrets`. Record exit status and any existing skips. Add affected infrastructure/package tests only when those components change.
- [ ] Obtain one independent whole-branch review; fix material findings and rerun affected checks. Preserve this review cadence rather than dispatching a reviewer per task.
- [ ] Use existing CI image/rehearsal/deployment machinery and branch protection. Rehearse the actual release images for schema changes. Do not create a parallel release helper or skip an existing gate.
- [ ] Verify production commit/schema, smoke, compatible desktop and one persisted feature readback. Production writes/paid tests use the exact approved activation/test scope; sending and social publication remain separate from code release.
- [ ] Rollback strategy: disable the new capability using its existing/new audited setting; keep evidence and accepted provider actions for reconciliation. Do not restore a database snapshot over live stops or remove migrations to hide a failure.
- [ ] Update shipped/verified/pending status separately. Commit the report with remaining limitations; don't claim the ten-call trial, lead conversion or publication passed without its evidence.

## Plan coverage and stopping conditions

Every roadmap item has a linked implementation plan, including the technically expensive parts: eligibility at both Gmail gates, nullable deal ownership, combined contact pacing, versioned approved answers, source attribution and a product-owned social runtime. External login or a platform challenge can block a delivery adapter; record that destination's limitation while completing independent work. No new user interview is needed to write or execute fixture-based tasks.

Execution method remains native in this chat, with one whole-branch review per release. The next step after David reviews this plan is V1 and A1; writing this document does not start either.

**Status:** planned; no implementation tasks performed by this document.
