# FSS Startup Presentation Continuity Plan

> **For agentic workers:** use subagent-driven-development and test-driven-development. This implements the approved codebase-audit roadmap, not a new visual direction.

**Approval:** David approved the recommended local cleanup on 2026-09-09T21:51:19Z. Source-grounded design: private `fss-approved-cleanup-20260909/startup-presentation-design.md`. Requirements: audit E and roadmap step 3 in `docs/engineering/2026-09-09-codebase-audit.md`.

**Goal:** The first React-rendered checking/failure frame and unresolved NativeDesk use the existing A appearance without inventing workflow readiness. Preserve actual legacy rendering, settings, held work and editor lifetimes. No startup-speed claim.

**Architecture:** Separate presentation from authoritative `data-workflow-mode`. Use a stateless `data-presentation="native-a"` marker for bootstrap/unresolved/actual NativeDesk appearance. Lift the existing theme and density owners to App above the health gate. No new context, cache, dependency, read loop, IPC or main-process change.

## Constraints and ownership

- Work in the existing release-task12-continuation checkout. Application baseline 005a11e, cleanup plan115efff. Tasks1/2/3 are separately owned and reviewed. Do not overwrite or stage their files.
- All npm/npx/node commands use `export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH";`.
- No installed app, profile, key, live provider, remote service, restart, deployment, push, new grants or paid operations. No native rebuild.
- Keep health/readiness gates, stale-response protection, localHold/session/action scope, route keys and explicit workflow branches unchanged.
- Do not consolidate active geometry overrides. Change only selector ownership and necessary initial wrapper/pending spacing. No palette/font redesign.
- Before authority is known, A is provisional checking chrome. Once real legacy is confirmed, the existing legacy appearance must return. No promise of unchanged provisional legacy appearance or native window paint before React.
- Worker may run focused no-native React/Vitest/type/lint. Parent owns browser/whole-screen acceptance, full suite, Swift, host and package jobs.
- Freeze exact owned source before review. No commit until coordinator acceptance.

## Task 1: Preserve appearance ownership across the health gate

**Production paths:** `src/renderer/App.tsx`, `src/renderer/app/FounderApp.tsx`, `src/renderer/app/useTheme.ts`, `src/renderer/app/useDensity.ts`, `src/renderer/app.css`.

**Tests:** `src/renderer/App.lifecycle.test.tsx`, `src/renderer/app/preferences.test.tsx`, `src/renderer/app/FounderApp.test.tsx`, directly affected App tests/fixtures only if required by the explicit prop change.

- [ ] Add behavioral RED tests through actual App with pending/rejected/retried/resolved health. Assert saved dark/light/system and compact/comfortable are applied before the first layout observation, checking/failure remains truthful, and no workspace APIs run before ready health.
- [ ] Call useTheme/useDensity unconditionally in App before its health branch. Pass the same existing `ThemeState` and `DensityState` objects as required FounderApp props. Remove workspace-owned calls, do not add fallback hooks or duplicate state owners.
- [ ] Move only document dataset mirroring to layout effects. Preserve accepted storage values, default behavior, best-effort persistence, media subscription/cleanup and setters.
- [ ] Wrap bootstrap DiagnosticsScreen only in `.startup-presentation[data-presentation="native-a"]`. Do not mount the actual workspace/navigation before health readiness. Reuse existing safe failure and Retry behavior.
- [ ] Paint the wrapper full viewport, opaque, using existing A background/text/font and appropriate existing semantic aliases for muted text, controls, border and focus. Preserve Settings' embedded DiagnosticsScreen styles by scoping to this wrapper.
- [ ] Verify throwing/missing/invalid storage, system-theme changes and StrictMode live-listener cleanup. Preserve health request sequencing and exact provider/inspector/route/editor lifetime behavior.

## Task 2: Select A on the pending presentation, not on asynchronous workflow data

**Production paths:** `src/renderer/features/today/NativeDeskRoute.tsx`, `src/renderer/features/today/nativeDesk.css`, `src/renderer/design/themes.css`, `src/renderer/design/tokens.css`.

**Tests:** `src/renderer/features/today/NativeDeskPresentation.test.tsx`, directly affected existing AppShell/NavigationRail/CSS marker assertions. Do not weaken workflow assertions.

- [ ] Add genuine REDs for unresolved/first-failed/unknown states and an actual confirmed legacy negative case.
- [ ] Pending/first-failure NativeDesk sections receive `data-presentation="native-a"` and an existing-token pending spacing class. Unknown mode may use A informational chrome. Confirmed legacy informational/actual legacy branches remain unmarked.
- [ ] Full NativeDesk receives the presentation marker while retaining its existing authoritative `data-workflow-mode={snapshot.workflowMode}`. Never stamp a fake meeting_first workflow mode to obtain styling.
- [ ] Replace every A workflow-based selector with equivalent presentation-based selectors, preserving specificity, responsive behavior and declaration order. This includes shell :has, brand, rail, compact type and later form/geometry overrides.
- [ ] Add startup wrapper to palette/type scopes only, not desk/rail layout selectors. Do not globally replace the legacy root palette.
- [ ] Preserve ready editor tree, scope keys and retained-state behavior. First-read/refresh errors and local/daily disagreements must retain the existing action holds. Appearance does not prove worker ownership or freshness.
- [ ] Focused regression tests must cover pending local records, unavailable versus zero, local/worker holds, stale snapshots, route changes and same-scope refresh/failure.

## Task 3: Parent-owned whole-screen acceptance

**Create:** `tests/fixtures/startupPresentationBrowser.tsx`, `tests/fixtures/startupPresentationBrowser.html`, `tests/browser/startupPresentation.spec.ts` using the actual App with isolated no-IO APIs. Exact HTML naming may follow current fixture convention.

**Modify after Task1 release owner commits:** `package.json` NativeDesk browser command includes this spec. Keep existing browser specs and all assertions. No live production API test fixtures.

- [ ] Hold health/daily promises independently, reject/retry with controllable responses, and capture first rendered frame plus subsequent states. Test actual App, not only a ready AppShell fixture.
- [ ] Check checking/failure/pending/ready appearance at 1440x900 and 1050x700, light/dark and both densities. Include system changes and invalid/throwing preferences.
- [ ] Assert full-viewport background/type/control styles, no beige intermediate A scope, existing A ready geometry, rail/wordmark, focus, overflow and accessible status/Retry. Check actual legacy negative scope and honest unknown/local disagreement states.
- [ ] Existing email/LinkedIn tests must retain editor node/text/caret/focus across appearance changes and same-scope refresh/failure. Do not promise continuity across intentional route unmounts.
- [ ] Verify fixture API call inventory: no command execution, pairing, reconciliation, send, approve or extra read loop. Keep StrictMode expectations aligned with baseline behavior.
- [ ] Independently review the frozen source and browser evidence. Run focused source regressions then full later release gate. Commit only reviewed owned files.

## Completion evidence

Map each requirement above to an observed component/browser check, record exact source hashes and actual results, and explicitly distinguish first React-frame continuity from pre-React native-window paint and measured startup time. Update current acceptance documentation. No installation is part of this slice.
