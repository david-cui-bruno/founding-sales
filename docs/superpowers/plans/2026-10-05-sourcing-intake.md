# Sourcing Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Save evidence-backed candidate drafts and review them inside Firms without creating outreach or deals.

**Architecture:** Add a workspace-scoped candidate store, authenticated idempotent commands and an admin review view under Firms. Candidate evidence remains explicitly unverified; keeping a candidate is a research decision, not admission to Today. Reuse the existing operation registry, command receipts, audit and database tooling.

**Tech Stack:** TypeScript, Zod, PostgreSQL, React, Electron, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-04-targeted-lead-sourcing-design.md`

## Global Constraints
- Only AWS/GCP credits or free allowances; this slice invokes no paid provider.
- Sending remains paused; no contacts, permissions, tasks, calls or opportunities are created.
- This first slice delivers candidate intake and review. Source fetching, continuous discovery, monitoring and automatic admission are subsequent slices.
- Native inline execution in the existing isolated worktree; no production migration or desktop publish in this slice.
- All reads and mutations workspace-scoped and admin-only; all mutations use command receipts.
- Quotes, names and URLs are untrusted content and never enter audit detail.

## Review Focus
- Repeat discovery must not reset a dismissed candidate; task 1 tests deduplication after review.
- A stale review must not overwrite a newer review; task 1 tests revision refusal.
- Related franchise pages must not be merged just because they share a hostname; task 1 tests path-sensitive identity.
- Unavailable reads must not display an empty-success state; task 3 tests failure/retry and identity isolation.
- Unverified text must not execute markup or look like verified research; task 3 tests inert evidence and explicit labeling.

### Task 1: Candidate storage and domain commands
**Files:** `packages/contracts/src/sourcing.ts`, contracts export; `packages/domain/sourcing/candidates.ts`; migration `0046_sourcing_candidates.sql`; schema range and retention coverage; `packages/domain/test/sourcing/candidates.test.ts`.
**Interfaces:** `saveCandidate(context, CandidateInput)` returns `{ok,value:{id,duplicate}}`; `listCandidates(context, {status,offset})` returns `{ok,value:{candidates,hasMore}}`; `reviewCandidate(context,{id,expectedRevision,status})` returns `{ok,value:{id}}`; `deleteCandidate(context,{id,expectedRevision})` removes the draft. Refusals use stable codes. Statuses: needs_review, kept, dismissed. Page size 50.
- [x] Write and run failing integration tests for durable storage, workspace isolation, denied salesperson, path-sensitive deduplication, preserved review, revision conflict and deletion. Assert no firm/opportunity/enrollment side effects and redacted audit.
- [x] Implement bounded schemas, additive table and domain functions. Deduplicate by normalized website including branch path plus normalized locality/region/name; retain original evidence on duplicate. Explicit admin delete removes drafts; no contact database is created.
- [x] Run domain tests and typechecks; include tested domain changes in the slice commit.

### Task 2: API and desktop operation boundaries
**Files:** `apps/api/src/routes/sourcing.ts`, `modules.ts`; `apps/api/test/sourcing.test.ts`; desktop `shared/operations.ts`, `main/operationHost.ts` and operation tests.
**Interfaces:** POST `/sourcing/candidates/list`, `/save`, `/review`, `/delete`; operations `sourcing.list`, `sourcing.save`, `sourcing.review`, `sourcing.delete`. Mutations return IDs only; listing returns evidence. Inputs share task 1 schemas. Commands carry commandId and clientVersion through existing infrastructure.
- [x] Write and run failing API tests for authentication, admin role, malformed evidence, receipt replay, cross-workspace IDs and method refusal.
- [x] Implement routes and stateless operation handlers with identity-generation checks. Register only exact paths; never expose arbitrary URL fetching.
- [x] Run API tests, operation tests and typechecks; include boundary changes in the slice commit.

### Task 3: Firms candidate review view
**Files:** `apps/desktop/src/renderer/sourcing/Candidates.tsx`, FirmsRoute integration, `apps/desktop/test/sourcing.component.test.tsx`.
**Interfaces:** Component uses only named sourcing operations, existing session identity, memory-only drafts, and shared buttons/inputs. Foldable candidate review section under Firms; back/collapse remains available. Form fields: firm, website, locality, region, signal, evidence, source URL, observed date, prepared by. No JSON required for a single entry.
- [x] Write failing component tests for add/read/review, plain text evidence, error/retry, duplicate notice, pagination, double-click prevention and draft persistence through collapse.
- [x] Implement Needs review / Kept / Dismissed filters, source links, unverified label, keep/dismiss/return-to-review and explicit delete. Preserve command IDs across uncertain retries; freeze a submitted draft while in flight.
- [x] Run desktop tests, full gate, independent code review and fix substantive findings. Record results and remaining roadmap without claiming deployment.

## Self-review
Candidate capture and review are fully covered. Provider evaluation, fetching, ranking, automatic admission and scheduler execution intentionally stay in later plans; keeping a candidate must never imply those exist. Shared task interfaces use the same contract types throughout. No schema changes to existing firm-page responses.

## Execution notes
- Domain, API and component tests were first run failing, then implemented.
- Independent review found no critical or important issue. Both minor findings were addressed with regression tests: reset pagination after mutation and explain future dates before submission.
- Browser preview used the real component and stylesheet with fixture ports. Reviewed list and expanded form; no application credentials or production data were used.
- Full-gate failures revealed required constraint fixtures and API image closure entries; both were added. Final `npm run gate:greenfield` passed: typechecks, lint, 6,815 tests passed and 16 existing skips. API route and desktop traffic inventories were updated for the new endpoints.
- This is a local implementation, not a production release. Migration 0046 must accompany the server release before desktop publishing.

## Remaining sourcing roadmap
1. Bounded direct source fetching and verification: URL/DNS/redirect limits, dated evidence and explicit uncertainty.
2. Discovery adapters evaluated on supported evidence, not raw lead count; enforce provider search and spending budgets outside model prompts.
3. Scheduled discovery and rechecks through existing jobs, with deduplication and freshness tracking.
4. Admission to callable firms only after fit/evidence and existing stop/ownership rules pass; measure signal quality against actual outcomes.
