# FSS Verification and Residue Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the release contract reproducible, repair the real CSV import path, and remove proven retired renderer/tooling residue before extending the company workflow.

**Architecture:** Retain existing application and domain boundaries. Use one runner-owned artifact selection across packaging, verification, scans and E2E. Make the current import provider call one parser, preserving parser errors and original record identity across preview/remap/commit. Delete only independently proven view/tool islands.

**Tech Stack:** Node 24.20.0, TypeScript, Vitest, Playwright, Electron Forge, SQLCipher, React, existing Swift helper tests. No new dependencies.

**Spec:** `docs/engineering/2026-09-09-codebase-audit.md`, approved by David at 2026-09-09T21:51:19Z: “ok yes do the recommended”. This is the first three independently testable tasks of the approved roadmap. Startup presentation and the company vertical slice follow after this cleanup checkpoint, with separate source-grounded task plans rather than one oversized cross-subsystem patch.

## Global Constraints

- Baseline `d7f8db8ab34fdd792f59abd57195550efa774a08`; application source equals `005a11e2e5ad897f4a436469d93a0db28c66081b`.
- Every npm/npx/node command starts with `export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH";`.
- Work in the existing release-task12-continuation checkout. No worktrees, reset, broad staging or amendments. Stage only accepted owned files.
- Never open the real profile, invoke the installed app, repeat its workflow transition, grant access, send/call, deploy, purchase or push. No real-provider tests.
- Never launch old canonical `out` against the real profile. The coordinator builds a fresh separate candidate for final acceptance. Preserve existing canonical/installed app copies.
- Preserve Node ABI137 binding `2a30fc9357cc21951b18781fa75062d81459b1a99b9d6253f2d9dfb2015da531`; no worker native rebuild or packaging.
- Heavy/native/build/package jobs run serially under the coordinator. Task 2 may run its small real encrypted import suite while Tasks 1/3 use no-native focused tests. Explicit Electron-host/Swift/full suites wait for coordinator scheduling.
- No migration SQL, persisted receipt/history, lifecycle/suppression/authority, safe native filesystem or production session-lifetime changes in these tasks.
- Regression-first fixes. Existing behavior-preserving deletion uses current characterization tests plus active-route assertions, not artificial tests requiring filenames to remain absent.
- Freeze owned source and report tests/hashes for independent review before committing. Fix only reproduced issues in scope.

---

## Task 1: One artifact and owned release test lanes

**Files:**
- Create `scripts/releaseArtifact.mjs`, `scripts/verifyRelease.mjs`, `test/releaseArtifact.test.mjs`, `test/verifyRelease.test.mjs`.
- Modify `package.json`, `forge.config.ts`, `scripts/verifySecrets.mjs`.
- Modify `tests/support/packagedApplication.ts`, `tests/support/packagedAppSelection.test.ts`, `tests/support/founderWorkspace.ts`, `tests/e2e/foundation.spec.ts`, `tests/e2e/appleBridgeSmoke.spec.ts` for a shared pre-spawn identity assertion only.
- Modify `test/releaseDocumentation.test.mjs`, `test/preReleaseElectronHost.test.mjs`, and directly affected release/scanner tests.
- Modify `README.md`, `cloud/README.md`, `.github/workflows/ci.yml`, `.github/workflows/release.yml` only where required to document/own lanes. Do not rewrite historical plans.

**Interfaces:**
- `resolveReleaseArtifact({ root, env })` returns `{ outDirectory, appPath, asarPath, executable }` using the existing Darwin ARM64 bundle layout.
- Canonical runner output override: `CALLIE_RELEASE_OUT_DIR`; default remains `<root>/out`. Resolve once before child commands. If inherited `CALLIE_E2E_OUT_DIR` points elsewhere, reject before any build/test process. Preserve that override for standalone E2E candidate use.
- `readArtifactIdentity(appPath)` returns `{ appPath, commitSha, builtAt, asarSha256 }`, with a validated embedded release marker and actual ASAR SHA256. `assertArtifactIdentity(executable, expectedIdentity)` checks selected application path and all identity fields. Use existing `validateReleaseMarker` and ASAR extraction, not GUI/runtime injection.
- `assertPackagedApplicationIdentity(executable)` in the support boundary validates expected runner-supplied commit/build marker/hash before each actual spawn. No new production/preload API. Runner assertion data stays in the test process and is not added to isolated child app env.
- Extend package secret scanning with explicit `outDirectory` without changing history/context scanning or expanding allowlists. Keep existing default callers compatible.

- [ ] **1. Add genuine RED tests.** Exercise two real tiny synthetic ASAR artifacts with distinct markers/hashes. A verified expected identity must reject selection of B. Assert default and candidate selection match in Forge, scanner and E2E. Record subprocess requests with injected runners, but use real path resolution and actual ASAR reading, not mocked marker success.

```js
const artifact = resolveReleaseArtifact({ root: fixtureRoot, env: { CALLIE_RELEASE_OUT_DIR: candidateA } });
expect(artifact.outDirectory).toBe(candidateA);
expect(() => resolveReleaseArtifact({ root: fixtureRoot, env: {
  CALLIE_RELEASE_OUT_DIR: candidateA, CALLIE_E2E_OUT_DIR: candidateB,
} })).toThrow();
// Package A's actual embedded marker/hash cannot admit executable B.
expect(() => assertArtifactIdentity(binaryB, identityA)).toThrow();
```

The local test fixture supplies actual private temp directories and tiny ASAR files. The shared assertion has the exact signature above. No test-only bypass enters production app code.

- [ ] **2. Observe RED before implementation.** Run only the new pure tests with Node24 Vitest. Missing exports or baseline mismatch behavior are expected. Then implement the shared resolver, identity check and serial runner. Do not use arbitrary sleep or a marker copied onto an old bundle.

- [ ] **3. Build once using the existing package script and marker/hooks.** Forge `outDir` consumes the resolved canonical override. Existing Forge CLI has no `--out-dir` flag; do not invent one. The runner passes a scoped child environment, and both verifier invocations receive the exact directory. Package scanning uses that same directory. Abort immediately on every failed stage.

Required serial stages:
```text
typecheck -> lint:tracked -> root tests -> NativeDesk browser tests
-> Swift tests -> node:test helper build/verifier tests
-> explicit synthetic Electron backup-host test -> independent Lambda verification
-> package once -> verify exact package -> source/history secrets
-> extracted candidate secrets -> E2E with expected artifact identity
-> verify same package again -> confirm unchanged identity and clean HEAD
```

Use existing commands where present. Add named commands for the two Node helper tests and explicit host test, rather than collecting them under the wrong runner. The host test flag is process-local to its command. Full acceptance is coordinator-owned.

- [ ] **4. Repair stale current-contract assertions.** Backup host must still prove two real synthetic Electron processes acquire the single-instance lock before path/key/DB access, close resources and produce a linked receipt. Expect current24 from the authoritative runtime/fixture contract, not stale17. Current README must say24 and eleven Lambda packages. Keep historical15 audit semantics and historical plans labeled historical. Correct UI-only fixture seeding claims to distinguish actual UI imports from owned encrypted migration/transition fixtures.

- [ ] **5. Verify focused tests and review.** Test every stage's short-circuit, mismatch-before-build, alternate/default path, actual marker/hash mismatch, and all existing scanner/assembly policy behavior. Check type/lint on owned files without launching native tasks. Return file hashes and proposed final commands. Commit only after review:
```bash
git add -- <reviewed Task-1 files>
git commit -m "fix(release): bind verification to one candidate and own test lanes"
```

## Task 2: Consolidate the active import parser without losing source identity

**Files:**
- Modify `src/main/imports/csvParser.ts`, `src/main/domain/founderSalesDomain.ts` only in imports, stored-preview shape and CSV preview/remap/commit implementation.
- Modify `tests/main/csvParser.test.ts`, `tests/integration/importService.test.ts`; add focused parser fixtures only if needed.
- Do not change shared import request/response contracts, source-service identity normalization, migrations, lifecycle or unrelated facade methods.

**Interfaces:**
- Keep exported `parseCsvSource(content, kind): ParsedCsvSource`. It becomes the one production parser, not an own-test-only alternate.
- Preserve original nonblank record numbers, trimmed unique header mapping, CSV delimiter detection and explicit tab paste, bounded renderer-safe errors, quoted/BOM/newline handling.
- Stored preview retains immutable `parseErrors` separately from mapping/row-validation errors. Remapping cannot erase parse/header errors. Commit rejects any parse errors before source/domain writes.

- [ ] **1. Add REDs through actual `createImportService` over the existing real encrypted fixture, not a copied method.** Cases: blank records preserve rows2/5, duplicate headers reject, blank headers reject, malformed quoted/uneven rows reject without runtime `.trim` crashes, remap retains parse errors, attempted commit writes zero people/source events on malformed input.

```ts
const preview = await service.preview({ kind: 'csv', sourceName: 'fixture.csv',
  content: 'Name,Email\nNora,nora@fixture.invalid\n\n   \nMarcus,marcus@fixture.invalid\n' });
expect(preview.sampleRows.map(row => row.rowNumber)).toEqual([2, 5]);
const invalid = await service.preview({ kind: 'csv', sourceName: 'duplicate.csv',
  content: 'Name,Name,Email\nNora,Other,nora@fixture.invalid\n' });
expect(invalid.errors.some(error => error.code === 'DUPLICATE_HEADER')).toBe(true);
const remapped = await service.remap({ previewId: invalid.previewId,
  contentHash: invalid.contentHash, mapping: invalid.suggestedMapping });
expect(remapped.errors.some(error => error.code === 'DUPLICATE_HEADER')).toBe(true);
await expect(service.commit({ previewId: invalid.previewId, contentHash: invalid.contentHash,
  mapping: invalid.suggestedMapping, source: { channel: 'registry', referredByPersonId: null },
  duplicateDecisions: [] })).rejects.toMatchObject({ code: 'IMPORT_VALIDATION_FAILED' });
expect(countPersons()).toBe(0);
```

- [ ] **2. Run RED suite alone using the existing ABI137 binding.** No rebuild. Preserve logs in assigned scratch. Prove failures are actual behavior, not fixture/schema mistakes.
- [ ] **3. Integrate one parser.** Remove private duplicated parsing logic and the facade Papa import. Map indexed cells to validated unique headers. Preserve parse errors through stored previews and combine with fresh row errors for preview/remap. Commit fails before duplicate decisions or intake conversion if parsing failed. Keep receipt/contentHash and existing command idempotency semantics unchanged.
- [ ] **4. Verify GREEN and regressions.** Existing real import end-to-end, remap, source channel, skip decisions, contentHash/expiry/replay and atomic-row rejection tests must pass. Test semicolon/tab detection where previously supported; do not silently narrow CSV parsing while removing duplication. No invented physical-line claim for multiline quoted records.
- [ ] **5. Freeze, independent review, commit exact paths.**
```bash
git add -- src/main/imports/csvParser.ts src/main/domain/founderSalesDomain.ts tests/main/csvParser.test.ts tests/integration/importService.test.ts
git commit -m "fix(import): use one parser and retain blocking parse errors"
```

## Task 3: Remove only proven retired renderer and capture-tool residue

**Files:**
- Delete `src/renderer/features/today/{BacklogCard,NextUpCard,TodayLane,TriageMode}.tsx`.
- Delete `src/renderer/features/discovery/DiscoverySection.tsx` and its own test after mapping relevant assertions to active consumers.
- Modify `src/renderer/features/today/TodayPage.tsx`, `TodayRoute.tsx`, `today.css`, affected Today/SuggestedContacts tests for obsolete `onStartTriage` props and exclusively unused selectors.
- Delete `scripts/designV2Screenshots.mjs`, `scripts/polishScreenshots.mjs` only after mapping their useful route/palette/import/theme captures to current browser/Bauhaus tests. Add any missing capture assertions to active tests rather than retain an unsafe launcher.
- Add a short retirement record at `docs/engineering/2026-09-09-retired-views.md` listing replacements and preserved API/data boundaries.

**Interfaces:** Existing routes, APIs, visible behavior and editor identities remain unchanged. No new interface is produced. Keep ManualQuickAdd, worker adapters and unsupported-platform declarations deferred, not accidentally included in this deletion.

- [ ] **1. Recheck references and characterize active consumers.** Read all removed modules/tests and their CSS selectors. Verify the finite registry, no lazy/dynamic consumer and test-only DiscoverySection. Compare old assertions with SuggestedContacts and provider-owned ContactPreparation/DiscoveryBrief. Run focused no-native component tests before deletion.
- [ ] **2. Add missing active-consumer behavior assertions before removing old tests.** Ensure suggestion selection is explicit/read-only, one selected contact workspace opens, refresh failures remain honest and no retired triage control is visible. Do not assert only that files are absent.
- [ ] **3. Delete exact modules/obsolete prop and exclusive CSS blocks.** Keep selectors used by TodayQueueRow, RowContextMenu, shared controls, current NativeDesk and contact detail. Do not delete dependencies transitively. Do not touch `nativeDesk.css` or new company intake files in this task.
- [ ] **4. Retire two old screenshot launchers after replacement mapping.** Their captures have no production consumer. Preserve historical images/studies and native teardown/environment harness. Record replacement commands and no intended application behavior change.
- [ ] **5. Verify focused components, type/lint and compiler reachability.** Coordinator reruns the existing audit graph and full browser suite after integration. Freeze owned paths, review then commit narrowly:
```bash
git add -- <reviewed Task-3 files>
git commit -m "refactor(renderer): remove retired Today views and capture tools"
```

## Coordinator integration checkpoint

- [ ] Verify accepted file hashes and each commit scope, then run serial root/type/lint/browser/native helper/Swift/host/Lambda tests through the corrected runner stages.
- [ ] Read final diffs for imports, authority/session lifetime, output-path and error-retention regressions. No feature is declared complete solely from a worker report.
- [ ] Continue the approved roadmap with a bounded startup-presentation task and a source-grounded company intake/identity task. Neither broad CSS replacement nor new research/backend ownership is justified by this cleanup.
- [ ] Final package built once into a new scratch candidate from clean exact HEAD. Verify marker/signature/native/secret/E2E identity through the new contract. No install or live walkthrough in this authorization.
