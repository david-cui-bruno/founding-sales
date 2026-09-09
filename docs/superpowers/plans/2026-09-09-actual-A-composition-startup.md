# Actual A Composition and Startup Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved A composition in actual components, with real identity/context bindings and honest empty states, and select startup work from measured evidence rather than weakening verification.

**Architecture:** Add optional main-owned display context beside saved daily answers, never inside immutable drafts or commands. Recompose the existing editor/session components using that context and preserve every execution gate. Startup profiling and preservation analysis is an independent deliverable. Any optimization must demonstrate preservation and explicitly review intentional admission differences rather than claim universal error equivalence.

**Tech Stack:** TypeScript, React, Zod, Electron, SQLCipher, Vitest and isolated Chromium acceptance.

**Spec:** `docs/prototypes/2026-09-09-today-studies.html` (approved A composition), `docs/superpowers/specs/2026-09-08-meeting-first-fss-design.md`, and the source-grounded composition map recorded during this task.

## Global Constraints

- Baseline: `a697d10b6d2a1db28124337105a3eda836884822`.
- Prefix every npm/npx command with `export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"`.
- No new dependencies, schema migration, persistent workspace identity, permissions, worker connection, outreach, grant, live network, automatic sync, draft generation or provider action.
- Preserve `requestedDraftSession.ts`, `linkedInSession.ts`, `dailySessionScope.ts`, immutable draft/command bytes, approval/receipt interpretation and all scope/authority holds.
- Display names come only from exact stored person bindings. Never infer a person from an email address, URL, salutation, company claim, or a different call contact.
- Human-reported call narrative is labeled as such. Never fabricate or present it as an authenticated prospect quotation.
- Use actual contact/company fallback and unknown states rather than fictional prototype facts. Account-call allocations do not select a person or route.
- Root, Lambda, package and native work is coordinator-owned and serial. Workers run only their focused tests and owned-file lint/typecheck.
- No installed app/profile mutation during implementation. Any later replacement requires a fresh normal-quit verified backup and exact candidate verification.

## Acceptance matrix

| Requirement | Concrete check |
|---|---|
| Named saved requested/manual work | Real encrypted source joins plus actual React and Chromium show the same exact contact/company/role in row and header |
| Unknown/foreign/deleted/historical identity | Exact binding negative controls never borrow a person; owner-supplied email remains literal email |
| Original call note/time | Pinned command/event/handoff validation, mismatched hashes/scope omitted, human-note label, missing-note fallback |
| Optional metadata safety | Corrupt annotation preserves valid saved answer; serialized drafts, approval payloads and command identities unchanged |
| Actual A composition | Full-screen comparable-content view: type/header, identity, recipient/context, message and integrated action/feedback; evidence secondary |
| Lifetimes | Same input DOM marker/caret/text across refreshed metadata, stale/read failures, preferences, disclosure toggles and width changes |
| Operations | Existing exact-save approval, permission/expiry, manual report/retry and held reply/call/meeting assertions unchanged |
| Empty/unpaired | One coherent setup explanation, no fabricated records, unknown not zero, local retained work independent and stale holds visible |
| Startup | Stage timing with provenance; no performance claim from static reasoning; no changed safety pipeline without differential and recovery tests |

### Task 1: Exact read-only answer presentation

**Files:**
- Modify `src/shared/contracts/dailyContract.ts`.
- Create `src/shared/contracts/dailyAnswerPresentationContract.ts` for bounded display schemas and pure identity comparison if this keeps the daily contract focused.
- Create `src/main/domain/today/dailyAnswerPresentation.ts`.
- Modify `src/main/domain/today/dailyReadService.ts` only at saved requested/manual answer construction.
- Create focused contract and real encrypted reader tests alongside existing daily tests.

**Interfaces:**
- Consumes existing `RequestedFollowupDraft`, `LinkedInDraft`, `OriginalCallRef`, exact route history, non-deleted stored people, applicable evidence-backed person-role links and validated immutable manual outcome evidence.
- Produces optional `presentation` on requested/manual `DailyAnswer` only, with a matching immutable draft binding, nullable stored contact and nullable original-call context. Contact role may be absent. Call note and observed time must be sourced. The binding must compare against the session's retained draft, not only the incoming item.
- Publish the final exported schemas/types/helper signature to the coordinator before renderer implementation. No capability or permission fields.

- [x] Write failing real-reader tests for an exact named route, old route version, owner-supplied recipient, missing/deleted/foreign person, ambiguous/unsupported role and exact original-call note/time.
- [x] Observe behavioral RED, not only missing exports/type errors.
- [x] Implement bounded exact-key reads inside the existing deferred daily transaction. Reuse pure `validateRequestedOriginalCall`, never runtime requested preflight/readContext.
- [x] Make optional annotation failure local to its field. A valid saved draft still returns with unchanged draft/approval bytes.
- [x] Add schema/binding tests: metadata changes are not draft revisions, incoming metadata cannot label retained different-identity text, malformed or unrelated annotations cannot claim a match.
- [x] Run focused reader/contract regressions, typecheck, owned ESLint and diff check. Freeze and report exact source before independent review.
- [x] Commit only owned source/tests after coordinator review. Completed at `459c79f`, including independently verified manual route-hash binding and field-local malformed-role repair.

### Task 2: Complete A component composition

**Files:**
- Modify `src/renderer/features/today/NativeDeskRoute.tsx`, `DailyAnswers.tsx`, `RetainedWork.tsx`, `UpcomingMeetings.tsx`, `nativeDesk.css`.
- Modify `src/renderer/features/linkedin/LinkedInStep.tsx` for stable presentation props/slots only.
- Add small module-scope presentation components/helpers and focused tests next to these components as needed.
- Do not edit navigation, global themes, sessions, shared/backend files, browser fixtures or coordinator acceptance tests.

**Interfaces:**
- Consumes Task 1's frozen optional presentation and matching helper, plus existing account/name, retained TodayItem and action/session state.
- Produces one stable requested/manual detail surface following A's header → identity → recipient/context → editor → action/feedback hierarchy.

- [ ] Write failing actual-component tests proving contact/company/header/context ordering, fallback identity and one unpaired explanation.
- [ ] Observe RED against current generic account form and repeated unavailable paragraphs.
- [ ] Keep the existing keyed answer/editor slot and input handlers. Move account diagnostics into an accessible disclosure rather than ahead of the message. Do not key on presentation, revision or preferences.
- [ ] Render names/initials only when matched to the session's actual draft. Use literal recipient or company with neutral glyph otherwise.
- [ ] Render original call note as human-reported context, or recorded connected outcome/time, or a single missing-context fallback.
- [ ] Integrate primary action, save and feedback. Keep explicit permission/expiry and their disabled reason understandable. Keep preflight discoverable and recovery controls prominent when needed. No renamed operation that implies sending or automatic recovery.
- [ ] Render retained company/action/due context without reclassifying, scheduling or changing order. Keep account-only calls and meetings honest.
- [ ] Consolidate global unavailable/empty copy without hiding local retained failures, stale holds, unknown outcomes or per-item errors. Unknown lane counts are not zero.
- [ ] Apply structural CSS for header/body/footer and overflow. Preserve existing A palette and rail.
- [ ] Verify component DOM/caret/lifetime, unchanged recovery tests, typecheck and owned lint. Freeze for coordinator whole-screen review before committing.

### Task 3: Comparable-content real-browser acceptance

**Coordinator-owned files:**
- `tests/fixtures/nativeDeskBrowser.tsx` and a dedicated fictional composition fixture under `tests/fixtures/`.
- `tests/browser/nativeDesk.spec.ts` or a dedicated spec using the same isolated actual-component harness.
- A real encrypted-reader → React composition integration test.

- [ ] Create clearly fictional Nora/Riverton and Marcus/Cedarline records with typed exact presentation bindings. Keep the older stateful fixture unchanged for existing regression coverage.
- [ ] Observe RED on actual production components for missing person header/context/grouping and repeated empty-state copy.
- [ ] Check 1440×900 and 1050×700, light/dark, compact/comfortable, missing-source, empty/unpaired and populated states. Inspect screenshots directly against A's inner app structure.
- [ ] Exercise refresh while typing, metadata change, incoming identity conflict, details toggles, permission/expiry, manual begin/open/copy/report/retry, keyboard navigation and Axe.
- [ ] Assert no fixture API command on selection/presentation and block every browser network request. Fixture data does not establish real backend provenance; the encrypted integration test does.
- [ ] Freeze reviewed source and commit only coordinator tests.

### Task 4: Startup measured decision

**Investigation source:** `src/main/db/plaintextDatabaseUpgrade.ts`, storage readiness, domain initialization and normal window startup.

- [x] Record separate fingerprint, integrity, stabilization, readiness and domain timing on disposable production-schema encrypted fixtures, with Node/native provenance and unchanged semantic data.
- [x] Analyze normal encrypted WAL/DELETE, sidecars and recovery artifacts. Do not remove the middle fingerprint around mutation, use metadata caching, or trust sidecar absence as fresh admission.
- [x] Determine whether normal stabilization is semantically required absent recovery/promotion, with source/tests and race analysis. See the reviewed boundary below.
- [ ] Any accepted optimization receives its own failing preservation/performance tests, independent review and separate commit before inclusion. Recovery paths retain strict comparisons.

**Reviewed startup boundary:** Ordinary artifact-free encrypted opening need not produce a standalone DELETE-mode database, because normal opening and readiness require WAL. Retain full initial keyed fingerprint/integrity/supported-schema/file-shape checks. Only when the marker and both complete alternate artifact families are absent, and no canonical rollback journal is present, omit the entire application-driven stabilization/cleanup unit. Before returning, freshly reject a missing, nonregular or symlink canonical path. Do not cache content validity or compare stale inode/mtime/size as an admission proof.

Normal open, migration, readiness and health remain authoritative. Current-schema pinned WAL readers and legitimate intervening committed updates may now coexist with startup. This is an intentional admission difference, not universal error equivalence. Older-schema verified backup still requires its original stabilization and can reject pinned readers. All plaintext conversion, artifact recovery, promotion and backup verification remain unchanged. The final shape-check-to-open pathname race is not solved by this change, and inspected-inode continuity is not claimed.

Baseline profiling used synthetic encrypted schema-24 fixtures, not the real profile. A 172,654,592-byte warm-cache proxy spent approximately 4.4–5.1 seconds in preparation, with roughly 3.1–3.5 seconds in stabilization on the final instrumented runs. These are baseline measurements, not a realized speedup. The candidate must be measured separately with immutable source/native provenance and exact semantic preservation.

### Task 5: Integrated delivery

- [ ] Independent review of read-only identity bridge and component lifetime/action boundaries.
- [ ] Coordinator verifies every explicit acceptance row above. Report unavailable capabilities as unavailable, not passed.
- [ ] Run exact clean-head root, unchanged Lambda, actual-browser, secret, signed-candidate and genuine packaged gates serially.
- [ ] If releasing, normally quit and verify a fresh full profile/prior-app backup, install only the exact signed candidate into `/Applications`, and preserve old canonical output untouched.
- [ ] Inspect installed populated/empty presentation where actual data permits. Never seed the live profile with fictional work. Measure one normal warm restart honestly if startup changed, and distinguish main-window time from ready-to-work time.
