# Candidate Source Check Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. Review the full change once complete.

**Goal:** Let David check a candidate's cited page through the existing bounded worker fetcher and inspect dated source text without treating retrieval as qualification.
**Architecture:** Add one optional source-check snapshot to each candidate, an idempotent admin enqueue command, and one bulk job. Keep the last successful snapshot if a later check fails. Reuse research settings, daily counter, source protections and parser; no AI or search provider calls.
**Tech Stack:** TypeScript, PostgreSQL, React, existing worker/job runner.
**Spec:** `docs/superpowers/specs/2026-10-04-targeted-lead-sourcing-design.md`

## Global constraints
- No sending, admission, automatic deals or production deployment.
- One cited page per explicit check; existing robots, DNS pinning, redirect, deadline and byte limits apply.
- Shared daily research count consumed before enqueue; no new cash spend. Research disable/hold stops requests.
- A page and matching text do not establish the firm's identity, unmet need, publication date or buying intent.
- Raw HTML never stored; bounded parsed text only, with hash and retrieval time. Audit/jobs contain IDs and codes only.

## Review focus
- Late job cannot overwrite a newer check or recreate a deleted candidate.
- Failed refresh retains the previous snapshot and marks it historical.
- Source text is escaped and never interpreted as instructions.
- Dismissed candidates, disabled research, exhausted counts and cross-workspace requests do no network work.
- Poison/dead jobs are visible and can be explicitly retried; no permanent Checking state.

## Tasks
1. [x] Write failing domain tests; add 0047 source_check JSON constraint, contracts and scoped request/complete functions. Versioned check IDs separate from candidate review revision. Request holds the row only while enqueueing. Fetch holds no candidate lock; completion compare-and-sets check ID. One attempt per job, explicit retry creates new job and consumes another count. Dead/missing job is shown as unavailable on reads.
2. [x] Add worker handler using PageFetchProvider (one URL, one page, max 30 seconds). Store source hash, time, first-party flag, bounded excerpt and literal evidence-text match. Catch provider failure without storing exception text. Register and package the domain module in the worker. Extend research link discovery to resident/maintenance/emergency/FAQ paths and prioritize discovered navigation before guessed paths, within unchanged limits.
3. [x] Add `/sourcing/candidates/check`, `sourcing.check`, and Check source UI with request time, checked snapshot, quote-match limitation and failure state. Extend API/operation inventories and behavior tests.
4. [x] Run affected tests, full gate, independent review, and browser preview; update the draft PR. Record remaining scheduled discovery/admission work.

## Execution rulings
The approved architectural spec and user's explicit continuation authorize inline implementation. This plan refines source verification only; no provider selection or scheduling decision is needed. Existing worktree and draft PR are retained.


## Evidence and limitations
- Domain, API, UI and worker tests were observed failing before implementation. Review findings received regression tests before fixes.
- Independent review found entity handling, navigation promotion, and failed snapshot-validation gaps. Fixed all three. Live source probes additionally exposed raw JavaScript swallowing subsequent page text; parser now skips raw text to its closing tag, decodes entities once, and rejects invalid Unicode scalar references safely.
- Fetching now bounds DNS waits and absolute HTTP duration, checks the shared deadline across redirects, and handles interrupted responses. Published navigation promotes existing guessed URLs without duplicate fetching.
- The real two-page probe returned readable text from Stonelink, but no usable text from J&W through the conservative parser. Empty extraction is unavailable, never evidence that a firm has no need. No lead-quality or buying-intent claim follows from this probe.
- The source-check UI was visually inspected with real component/styles and fixture data in an isolated browser. No desktop credentials used.
- Documented provider-boundary exception: candidate checks cannot call firm enrichment without first creating a CRM firm. The new fetch site retains research settings/hold checks, consumes the shared count before enqueue, checks active request identity and uses the existing bounded adapter. It has no extraction/search model port.
- Source checks are explicit requests in this slice. Scheduled monitoring, continuous discovery, qualification and automatic admission remain future work. No deployment or sending change performed.
- Final repository gate: passed (Node 24); typecheck, lint and all six test suites passed: 6,834 tests, 16 existing skips.
