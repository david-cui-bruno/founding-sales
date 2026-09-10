# Shared presentation and overlay repair execution plan

> **For agentic workers:** use subagent-driven-development to execute task-sized work with independent source review. The user authorized this repair, not a new design exercise. Do not stop for duplicate approval.

**Goal:** make the existing Native Today identity, theme and navigation application-wide, preserve each real route's content, and repair overlay close/focus behavior without moving workflow authority or editor state.

**Design:** [source-grounded contract](../specs/2026-09-10-shared-presentation-repair.md). [Whole-program scope](../2026-09-10-product-repair-program.md). F02/F03/F13 and presentation/route F17 are in scope. F14 dialog retention is an explicit dependency below.

**Execution boundaries:** one implementation worker at a time. Parent may independently own acceptance fixtures. No worker native/browser/build/package/full-suite or app/profile/provider operations. Parent grants serial execution leases. Every npm/npx invocation exports `PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"`. No native rebuild. Freeze exact files and hashes before review. Commit accepted paths only. No installation/push/deployment/live actions.

## Task 1: One presentation root and common shell

**Production files:**
- Create `src/renderer/app/PresentationRoot.tsx`.
- Modify `src/renderer/App.tsx`, `src/renderer/app/AppShell.tsx`, `src/renderer/app/NavigationRail.tsx`, `src/renderer/app/shell.css`, `src/renderer/app.css`, `src/renderer/design/tokens.css`, `src/renderer/design/themes.css`, `src/renderer/features/today/nativeDesk.css`.
- Tests: create `src/renderer/app/PresentationRoot.test.tsx`; modify `src/renderer/App.lifecycle.test.tsx`, `src/renderer/app/NavigationRail.test.tsx`, `src/renderer/features/today/NativeDeskPresentation.test.tsx`, `src/renderer/design/bauhaus.test.tsx`, `tests/renderer/cssWiring.test.ts` only where assertions encode replaced ownership.

**Interface:** `PresentationRoot({children}: {children: ReactNode})`. No route, API, authority, workflow or preference props. Stable `.presentation-root[data-presentation="native-a"]` above the health branch. Task 1 does not create an unused overlay provider scaffold. Task 2 adds that provider inside the same stable root.

1. Add behavioral REDs for root existence across health loading/error/ready, one Callie wordmark and invariant More navigation regardless of descendant/workflow. Tests use real components, not source-string stand-ins. Preserve health gating and local/worker holds.
2. Observe focused RED before implementation. The signed pre-repair route audit is supplementary evidence, not a substitute for the new maintained checks.
3. Introduce the root without new keys or reparenting the selected-person provider. Make `main#main-content` focusable. Keep useTheme/useDensity storage and lifecycle unchanged.
4. Move the existing final Native font, semantic colors/aliases, rail142/124px, brand, navigation44/36px, More, gutter and breakpoint rules to app/design ownership. Remove replaced feature-owned ancestor rules rather than append another override cascade. Keep local card/editor/queue layout intact. Shared headings use the Native page token. Do not globally redesign control corners or route layouts.
5. Preserve literal colors in design/ only. No root `data-workflow-mode`. Feature markers may remain for feature composition but no global selector consults a feature descendant.
6. Run focused component tests, owned ESLint, typecheck and diff-check. Parent adapts browser fixtures and executes actual CSS/route acceptance. Do not weaken mismatching checks to claim completion.
7. Freeze owned hashes and report. Independent source review and parent visual acceptance precede commit/release claims.

## Task 2: Stable layer ownership and contact Close controls

**Files:**
- Create `src/renderer/app/overlayLayers.tsx`, `useModalDialog.ts`, `overlays.css` and corresponding `overlayLayers.test.tsx`, `useModalDialog.test.tsx`.
- Modify `PresentationRoot.tsx`, `app.css`, `app/commandPalette/{CommandPalette.tsx,useCommandPalette.ts,commandPalette.css}`, `features/import/ImportDialog.tsx`, `features/leadInspector/{LeadInspector.tsx,LeadFullPage.tsx,InspectorHeader.tsx,LeadInspectorProvider.tsx,leadInspector.css}`.
- Extend `tests/renderer/commandPalette.test.tsx`, `features/import/ImportDialog.test.tsx`, `features/leadInspector/LeadInspector.test.tsx` and existing full-page/provider test files as inventoried before edits.

**Interfaces:** use the exact `DismissibleLayerOptions`, `useDismissibleLayer`, `useOverlayLayers`, and `useModalDialog` signatures in design section1. Latest callbacks/policies live in refs. Registration follows open lifetime, not render frequency. Modal class outranks nonmodal contact even if effects register out of tree order.

1. RED: palette over contact Escape closes only palette; blocked top layer consumes Escape; callback/state rerender does not reorder layers; StrictMode cleanup; loading/error contact always has operable Close.
2. Add shared topmost dispatcher. Respect composing/repeated/defaultPrevented input. Never fall through a blocked top layer. Keep nonmodal contacts nonmodal, no trapped rail focus.
3. Migrate palette to real native dialog, preserve search/commands. Import remains native with its existing committing guard. Remove old competing lifecycle/focus effects. Native cancel and keydown use the same guard.
4. Stable contact frame/header accepts nullable detail, never displays stale identity while loading, always renders Close. Preserve person/cycle/command keys and all provider selection/unknown-command maps. Any focus-origin ref is not a second selection owner.
5. Focus restore after real close: connected non-inert opener, stable-ID replacement, parent layer control, visible active route link/More, then main. Do not steal focus from a newly opened replacement modal. Palette-to-Import handoff must not focus the background.
6. Focused no-native RED/GREEN and static checks. Parent tests actual native-modal isolation and multiple Tab/Shift-Tab cycles. jsdom showModal mocks are not proof of inertness.
7. Freeze, independent review, exact-path commit after acceptance. Underlying route keyboard guards are integrated in Task3.

## Task 3: Remaining modal consumers and mutation-close integration

**Files:**
- `features/conversations/{AttachTranscriptDialog.tsx,conversations.css}`
- `features/learnings/{CaptureLearningDialog.tsx,learnings.css}`
- `features/today/{LogPastActivityDialog.tsx,today.css,TodayPage.tsx,TodayRoute.tsx,NativeDeskRoute.tsx}`
- `features/discovery/DiscoveryBrief.tsx`, `features/leadInspector/leadInspector.css`
- `features/leads/LeadsBulkBar.tsx` plus the existing corresponding component tests.

1. Inventory current feature-owned pending/unknown outcome semantics before edits. Write behavioral RED for close paths preserving busy/failed input and no duplicate submit. Capture learning/manual activity currently lose pending state, so their minimal F14 outcome repair is part of this task, not a generic-overlay responsibility. Exact callback types are frozen in the task brief before implementation.
2. Adopt native dialog/shared lifecycle in transcript, learning, manual activity and discovery. Keep interior fields/layout/date semantics and request identifiers unchanged. No new backdrop dismissal for forms that did not support it.
3. Busy or unresolved submission blocks every close path consistently. Rejection keeps input and exposes a fixed safe actionable error. Only accepted success closes, and duplicate Enter/Save cannot submit again while pending. Preserve existing idempotency or uncertain-command identity rather than fabricate success from refresh.
4. Bulk/Native route Escape ignores handled events and active overlays. Command-K does not open under another feature modal. Preserve Select/menu-first Escape behavior and contact call shortcuts' existing target boundary.
5. Test all six modal consumers, not only palette. Rejection, pending, nested Select, repeat/composition Escape, close/reopen and provider late reads have concrete checks.
6. Freeze and review. No claim of all F14 repairs: Leads edits and any unrelated captures remain in the reliability stage ledger until exercised.

## Task 4: Parent-owned real-destination acceptance

**Files:**
- Create `application-presentation.html`, `tests/fixtures/applicationPresentationBrowser.tsx`, `tests/support/presentationOracle.ts`, `tests/browser/applicationPresentation.spec.ts`.
- Update `tests/fixtures/{startupPresentationBrowser.tsx,nativeDeskBrowser.tsx,nativeDeskCompositionBrowser.tsx}` and `tests/browser/{startupPresentation.spec.ts,nativeDesk.spec.ts}`.
- Update `src/renderer/app/FounderApp.test.tsx` to a complete typed API and explicit legacy DTOs without losing its just-repaired native Import event coverage.
- Update `tests/e2e/bauhausWorkflow.spec.ts`, add a separately named real-route packaged spec if needed, and wire maintained specs in `package.json`.

1. Mount production App, actual route registry and app.css. Complete typed synthetic API, explicit read inventory and commands log-and-reject unless a case intentionally grants one. Do not omit daily to force legacy, substitute Today for a destination, or cast an incomplete API as complete.
2. Exhaustive destination map for all10AppRoutes asserts actual component content and read path, not merely current link/hash. The existing isolated desk fixture must reject unsupported destinations rather than pretending they rendered.
3. Core matrix:10routes×2themes×2densities×2sizes=80asserted observations. Include explicit legacy and meeting-first routing, transitions, and pending/error/unknown authority samples. Compare shared shell tokens/font, Callie brand, rail edge/width, appropriate primary/secondary nav geometry and overflow. No legacy exclusion.
4. Palette/Import from actual routes and full-page/docked contact across route changes inherit root tokens. Contact edge equals rail edge within1CSSpx. Preserve the selected person. Test real Tab/Shift-Tab/background isolation and topmost dismissal for each modal consumer.
5. Preserve existing Native editor DOM identity, text/caret/focus, command identity, narrow message reachability and card geometry. Other routes retain their content/workflows. Test native Import exact production payload through the real complete API fixture and later signed app.
6. Replace the exact contradictory acceptance listed in design section6, preserving underlying data/authority/no-command tests. Never update snapshots to preserve the old split or count captures as assertions.
7. Parent runs serial browser and final signed exact-artifact tests after frozen source review. Package workflow uses only disposable fictional profiles. These checks do not authorize installation or live configuration.

## Completion rule

F02/F03/F13/presentationF17 close only when real route and overlay checks pass, the old contradictory contracts are removed, and the new source is independently reviewed. Full release remains program stage6. F05/F06/F07/F08-F11/F14-F16/F18 remain individually tracked rather than absorbed into a visual pass.
