# F02 / F03 / F13 / F17 presentation repair design

**Status:** source-grounded execution design for the repair pass authorized on 2026-09-10. The design itself supplies no runtime or release evidence. Implementation and acceptance are tracked in the [execution plan](../plans/2026-09-10-shared-presentation-repair.md).

**Goal:** keep the current Native Today composition and the existing contents/compositions of every other route, while making application identity, navigation, theme inheritance and overlay interaction application-owned.

**Scope:** F02, F03, F13 and the presentation/route-coverage portion of F17 in `docs/engineering/2026-09-10-adversarial-product-audit.md`. Other repairs remain with their owners. The parent coordinator executes this bounded repair under the existing user approval. Installation and live-service changes remain separate gates.

## 1. Decision and interfaces first

**Choose one stable `PresentationRoot` in `src/renderer/App.tsx`, above the health branch, `FounderApp` and `LeadInspectorProvider`.** It has a fixed `data-presentation="native-a"`. It has no route, workflow mode, pairing, daily snapshot, permission or service API input. Theme and density remain the existing preferences, not new presentation preferences.

Proposed tree:

```text
App                                      existing useTheme / useDensity / health
└─ PresentationRoot                      fixed DOM ancestor and OverlayProvider
   ├─ DiagnosticsScreen                  when health is not ready
   └─ FounderApp                         when health is ready
      └─ LeadInspectorProvider           same selected-person/command owner
         ├─ FounderWorkspace
         │  ├─ AppShell
         │  │  ├─ NavigationRail
         │  │  └─ main → actual renderRoute(route, context)
         │  ├─ CommandPalette
         │  └─ ImportDialog
         ├─ LeadInspector
         └─ LeadFullPage                  includes its nested feature dialogs
```

`PresentationRoot` itself is the common presentation/overlay host. **No portal or duplicate portal container is necessary.** All current surfaces are DOM descendants of this root even when they remain siblings of `AppShell`. Native `dialog.showModal()` promotes rendering to the browser top layer without changing DOM inheritance. Do not portal to `body`, copy theme attributes to individual dialogs, or move the selected-person provider inside the keyed route.

Proposed presentation interfaces, with no domain state inside them:

```ts
PresentationRoot(props: { children: ReactNode }): ReactElement
OverlayProvider(props: { children: ReactNode }): ReactElement

type DismissReason = 'escape' | 'cancel' | 'close-button' | 'backdrop' | 'command';
type DismissibleLayerOptions = {
  open: boolean;
  kind: 'modal' | 'nonmodal';
  elementRef: RefObject<HTMLElement | null>;
  canDismiss(): boolean;                 // latest feature-owned state, not a copied busy flag
  onDismiss(reason: DismissReason): void; // request to owner, not an unconditional unmount
  returnFocus?: () => HTMLElement | null;
};
useDismissibleLayer(options: DismissibleLayerOptions): {
  requestDismiss(reason: DismissReason): boolean;
  isTopmost(): boolean;
};
useOverlayLayers(): {
  hasOpenLayer(): boolean;
  hasModal(): boolean;
};

useModalDialog(options: {
  open: boolean;
  dialogRef: RefObject<HTMLDialogElement | null>;
  canDismiss(): boolean;
  onDismiss(reason: DismissReason): void;
  initialFocus?: () => HTMLElement | null;
  returnFocus?: () => HTMLElement | null;
}): {
  onCancel(event: SyntheticEvent<HTMLDialogElement>): void;
  onKeyDown(event: React.KeyboardEvent<HTMLDialogElement>): void;
  requestDismiss(reason: DismissReason): boolean;
};
```

Create these in `src/renderer/app/PresentationRoot.tsx`, `src/renderer/app/overlayLayers.tsx`, and `src/renderer/app/useModalDialog.ts`. The last two are interaction utilities, not workflow providers. The dialog hook uses the layer hook. Hooks keep callbacks/current close policy in refs, so changing draft, busy, selection details or theme does not reorder/re-register the layer or call `showModal()` again. Registration is tied to actual open lifetime and stable element identity, with StrictMode-safe cleanup.

Rejected alternatives:
- Adding more `:has(.native-desk)` cases or copying Native classes into every route still delegates global identity to content and misses siblings.
- Wrapping only `AppShell` still excludes the inspector, full page, palette and Import. Wrapping only `FounderApp` leaves startup on a separate presentation contract.
- Replacing every route with `NativeDeskRoute`, or changing workflow authority to obtain a preferred appearance, violates both content and permission boundaries.

## 2. Source facts that determine the migration

- `App.tsx:16-36` owns preferences, performs the health gate, and currently adds a special Native wrapper only to diagnostics.
- `FounderApp.tsx:28-32` has the correct long-lived selected-person provider. Its workspace keys only the route subtree at `50-60`. Palette/Import at `62-75` and provider-rendered contact surfaces at `LeadInspectorProvider.tsx:456-490` are shell siblings, so shell-scoped tokens cannot reach them.
- `routeRegistry.tsx:32-103` is the real registry. Today uses `TodayRoute`, which selects Native or actual legacy content. Accounts/Campaigns use `NativeDeskRoute`. The other seven destinations render distinct production components. `routes.ts:1-12` contains all ten runtime route IDs.
- `themes.css:147-183`, `tokens.css:77-86` and `nativeDesk.css:279-321,479-517,639-643` let a descendant choose ancestor identity/geometry. The 142px/124px Native width does not reach full-page contact's `left: var(--nav-rail-width)` in `leadInspector.css:438-450`.
- Merely changing the theme selector is insufficient: palette uses `--surface-raised`, and aliases such as inherited `--muted` can already have resolved against the old root palette. `app.css:98-109` already repairs several such aliases, but only for startup.
- Palette Escape currently prevents default but bubbles. Inspector and full-page contact independently listen on `document` and close unconditionally. Leads bulk selection also has a document Escape listener. Fixing only the first pair leaves another underlying dismissal.
- Import already uses a real native modal, cancels native default dismissal, blocks close during commit, and restores focus through connected opener → same ID → active navigation fallback. Preserve these strengths.

## 3. Exact ownership: shared presentation and CSS

| File | Presentation owner's change | Boundary |
| --- | --- | --- |
| `src/renderer/app/PresentationRoot.tsx` **new** | Stable `.presentation-root[data-presentation="native-a"]` and `OverlayProvider` around children. | No API calls, routing, authority, persistence or editor state. |
| `src/renderer/App.tsx` | Return the same root in all health states. Remove the separate startup presentation ownership, not the diagnostics gate. | F15 owns health behavior. Integrate the wrapper around its result without changing readiness semantics. |
| `src/renderer/app/AppShell.tsx` | Keep its current props and layout regions. Make `main#main-content` programmatically focusable (`tabIndex={-1}`) for a safe final focus fallback. | No workflow mode prop and no inspector/provider relocation. |
| `src/renderer/app/NavigationRail.tsx` | Render one Callie wordmark using the current Native wordmark class/markup. Remove alternate FSS DOM. Preserve item order, Settings position, real hashes and the current More disclosure state. | Do not rebuild the route list or auto-expand/collapse More merely because authority changes. |
| `src/renderer/design/tokens.css` | Move shared Native size/font/rail declarations to the presentation-root selector. Define 142px rail, 124px at `max-width:1200px`, and the existing 30/27/25/26/10 Native type sizes there. | Keep density keys, 32/40px grid row tokens and 26/28px control-height behavior. Do not turn density into a second theme. |
| `src/renderer/design/themes.css` | Retarget Native light/dark declarations from `:has`/feature/startup selectors to the common root. Complete shared surface aliases at that root, as below. | Existing status semantics and route-specific decorative meaning remain intact. Literal colors stay in design/. |
| `src/renderer/app/shell.css` | Become the sole rail/brand/nav/common outer-gutter style owner. Replace baseline rail declarations with the current final Native values rather than append another override layer. | Keep Darwin traffic-light drag row, no-drag controls, skip link and native backing behavior. |
| `src/renderer/app.css` | Retain import order `tokens → themes → base → motion → shell`; move the startup-only alias/background block into common presentation ownership. Add shared modal geometry/reset import. | Startup must not depend on a route stylesheet being imported accidentally. |
| `src/renderer/features/today/nativeDesk.css` | Remove only ancestor shell, navigation, brand, shared font/rail rules after equivalent common ownership is in place. Keep feature composition selectors and their cascade order. | Do not edit queue/card/editor layout, message heights, sticky action area, responsive composition or local-company intake styling. Feature-local `:has` for composition is allowed. |
| `src/renderer/features/leadInspector/leadInspector.css` | Keep full-page `left:var(--nav-rail-width)` and its current inner layout. Update the misleading sibling-scope comment and discovery modal wrapper rules. | No 142/124/216px contact offset literals. No route-specific gap correction. |

**Preserved Native shell values:** main outer padding `12px 16px`; rail horizontal padding `10px`, `8px` at the narrow breakpoint; header bottom margin `30px`; primary navigation `44px` height/`6px` radius; secondary items `36px`; current selection soft accent fill and inset `3px` accent. Copy the existing final cascade, including hover and narrow-screen outcomes, before removing the feature rules. The current selected secondary row is 36px, not 44px. An oracle must compare the same item class, not incorrectly demand a primary-row height on Inbox.

**Route layout decision:** shared outer rail/gutters and UI font now apply everywhere. These are the intended common-frame changes. Keep each route's internal grid, panels, tables, filters, column widths, sections, controls and content. Do not convert Leads into a desk or remove Friday/Settings sections. Shared `PageHeader` typography uses the system UI/display family and existing Native page-title size through `.page-header__title { font-size: var(--text-native-page); line-height: 1.25; }` in shell.css. Explicitly bind both `--font-ui` and `--font-display` at the common root, rather than inheriting the old already-resolved display alias. Specialized internal/diagnostics/report heading sizes remain local composition, not a second font or brand. The cross-route oracle checks the shared title token and font contract, not equality of every arbitrary `h1` size.

**Palette decision:** copy the light/dark Native values in `themes.css:150-183` unchanged. At the same root declare:

```css
--surface-raised: var(--surface);
--surface-sunken: var(--native-queue);
--surface-navigation: var(--native-rail);
--text-faint: var(--text-muted);
--muted: var(--text-muted);
--faint: var(--text-faint);
--line-strong: var(--line-interactive);
--accent-strong: var(--accent);
--focus-ring: 0 0 0 2px color-mix(in srgb, var(--accent) 85%, transparent);
```

These aliases eliminate cream overlays and stale computed aliases. Keep the existing action/status tones unless an actual contrast check requires a targeted correction. Do not globally change every control radius or shared card shadow as part of this repair. Native composition does not reference the listed raised/sunken/muted/faint aliases directly, but nested shared controls must still be included in the Today regression check. Primary Native appearance preservation is not permission to retain incorrectly themed overlays.

Use `.presentation-root` in app-owned structural styles and `.presentation-root[data-presentation="native-a"]` in design token/palette ownership. Theme continues to inherit from `html[data-theme]`. Do not put `data-workflow-mode` on the presentation root. Existing feature `data-presentation` markers can remain for feature-local composition during this minimal migration, but no global rule may consult them. `--nav-rail-width` must have no feature override left.

## 4. Overlay interaction contract

### One Escape, one owner

`OverlayProvider` tracks visible **modal and contact nonmodal** layers. Modal layers always outrank nonmodal contact layers, regardless of parent/child effect registration order. Within the modal class, order follows actual `showModal()` opening order. Within nonmodal contact views, the existing single-selected-person invariant applies. Both `LeadInspector` and `LeadFullPage` register as nonmodal layers. A new read status, newly mounted background contact, or changed callback cannot push a contact above an already-open palette.

There is one document-level fallback Escape handler. It ignores composing/repeated/default-prevented events, consumes a handled event, and requests dismissal from only the current top layer. **A close-blocked top layer consumes Escape and stays open. It must never fall through to the next layer.** Remove the independent inspector/full-page document listeners.

The native modal hook also handles Escape at the dialog's bubbling boundary, after child controls have had their turn. It respects `defaultPrevented` from an open Select, then stops propagation so the event cannot reach route handlers underneath. Repeated/composing Escape is consumed without requesting dismissal, rather than being left for native default cancel. Otherwise it prevents default, stops propagation and makes one topmost dismissal request. Native `cancel` always prevents automatic close and uses the same guarded request. Thus keydown and native cancel cannot close twice. Close buttons/backdrop paths use that same guard, not raw `onClose`. Call all shared hooks before conditional `return null`, including in CommandPalette, so an open-state change cannot alter hook order.

Keep local popover semantics: Select Escape closes the listbox first, RowContextMenu Escape backs out of Snooze before closing the menu, and inline editing Escape cancels only that edit. `Select.tsx` already prevents default; preserve that behavior. `RowContextMenu.tsx` already stops propagation. They do not need a new modal state owner.

Necessary keyboard integration changes:
- `src/renderer/features/leads/LeadsBulkBar.tsx`: its document listener must ignore default-prevented Escape and any open registered layer. Preserve no-overlay selection clearing and the inline-editor exception. F07/F14 own selection and submission semantics.
- `src/renderer/features/today/NativeDeskRoute.tsx`: its keyboard handler must respect `defaultPrevented` and an active modal boundary before clearing its selected editor. Only this keyboard guard belongs to this plan. F08/F11/F16 own other modifications.
- `useCommandPalette.ts`: allow Cmd/Ctrl-K over a contact nonmodal, but do not open/toggle a palette underneath another feature modal. Closing the palette remains possible while it is the active modal. Do not let a global shortcut initiate background commands.
- `CallOutcomeSection.tsx` already restricts Cmd/Ctrl-Enter to events whose target is inside the section (`131-150`). Preserve that check. Test that palette focus/keystrokes cannot invoke it. No broad shortcut refactor is needed.

### Native modal isolation and focus

Migrate the five custom modal frames to native `<dialog>` plus the shared hook: palette, Attach transcript, Capture learning, Log past activity, and Discovery decision. Keep Import as a native dialog and share its lifecycle implementation rather than downgrade it to ARIA-only markup. Use native top-layer isolation, not manual `aria-hidden` toggles or a fragile application-wide inert implementation.

The hook calls `showModal()` only on opening, closes its own dialog during cleanup, and sets focus only after opening. Use the first meaningful field for each form, the palette input, and Import's existing initial control. Verify full forward and reverse Tab cycles in a real browser, including no enabled fields while busy. Native modality prevents background activation. Do not claim jsdom's mocked `showModal()` verifies inertness or browser focus traversal.

Focus restoration occurs **after actual dismissal/top-layer removal**, not eagerly in `useCommandPalette.closePalette`. Resolve: connected non-inert explicit opener → connected replacement with the same stable ID → surviving parent layer's safe control → visible active route link → More toggle when that link is collapsed → focusable main. Do not focus a hidden secondary link or stale DOM. Do not steal focus from a newly opened child/replacement modal. Palette → Import transfers the underlying return target to Import, or resolves the same logical route fallback, instead of restoring focus after Import has opened.

For nonmodal contact panels, do not trap Tab or inert the rail. On close, restore an opener only when focus was within the closing panel (or its just-dismissed child), otherwise preserve focus the user already moved elsewhere. Full-page contact still covers the workspace while leaving navigation available. Layer registration must not make either contact view modal.

### Stable asynchronous contact frame

`InspectorHeader.tsx` accepts `detail: LeadDetail | null`, renders the same visible Close control for loading, error and ready, and uses the neutral label “Lead details” until identity is known. Do not fabricate person name/stage from the previous request. Render this header unconditionally inside the stable `aside`/`article`; only its identity subcontent and the body vary by read state. Retry remains in the body. Keep ready-state header appearance and action placement.

Make `LeadFullPage.onClose` required in its props for actual dismissible full-page use. Its article must not disappear/lose Close in loading/error. Keep `InspectorTabs` person key, `ContactPreparation` person/cycle key, and `CallOutcomeSection` person/cycle/command key unchanged. No wrapper key may include theme, density, route, authority, `refreshKey` or loading status.

All close paths call the existing provider `closeLead`. Preserve `selectionEpoch`, request sequencing, API identity checks, `outbounds`, `preparationRecords`, selected reads and uncertain-command handling. Closing a read-only pending/error surface is allowed and invalidates its late read as it does now. It does not cancel a submitted external command, erase unknown execution or start a replacement command. Keep the provider mounted across route changes and preferences. If needed, add only a focus-origin ref in `openWith` and pass a return-target getter to contact frames. It must not become a second selected-person owner.

### Exact modal consumer ownership

| File | Minimal frame/interaction change | Close policy supplied by feature |
| --- | --- | --- |
| `src/renderer/app/overlayLayers.tsx` **new** | Layer registration, topmost guard and fallback Escape dispatcher. | Never interprets receipts or submits work. |
| `src/renderer/app/useModalDialog.ts` **new** | Native lifecycle, cancel/keydown boundary and delayed focus restoration. | Receives latest `canDismiss`. |
| `src/renderer/app/overlays.css` **new** | Shared native dialog reset and viewport-bound overlay geometry, without restyling form interiors. | No per-route offsets. |
| `src/renderer/app/commandPalette/CommandPalette.tsx` | Native dialog wrapper, shared hook, same search/list/command logic. Run command only after accepting palette close. | Always dismissible. Backdrop remains dismissible. |
| `src/renderer/app/commandPalette/useCommandPalette.ts` | Own open state/shortcut only. Remove its competing eager focus restoration and gate other modals. | No preference/route/editor ownership. |
| `src/renderer/app/commandPalette/commandPalette.css` | Adapt existing 560px/55vh/20vh geometry to native dialog and `::backdrop`. Preserve list layout. | Root aliases provide theme. |
| `src/renderer/features/import/ImportDialog.tsx` | Adopt shared hook with existing native dialog and initial focus. Preserve commit/result logic. | `state.step !== 'committing'`; all close/cancel paths agree. |
| `src/renderer/features/leadInspector/LeadInspector.tsx` | Register nonmodal layer, always render frame/header. | Existing `closeLead`, not a new async-command cancellation. |
| `src/renderer/features/leadInspector/LeadFullPage.tsx` | Same; required close callback and stable loading/error frame. | Same provider owner. |
| `src/renderer/features/leadInspector/InspectorHeader.tsx` | Nullable detail, persistent real Close node, ready appearance unchanged. | No mutation control logic. |
| `src/renderer/features/leadInspector/LeadInspectorProvider.tsx` | Optional focus-origin plumbing only. Leave long-lived data/command maps and keys intact. | Parent integrates adjacent changes, no provider relocation. |
| `src/renderer/features/conversations/AttachTranscriptDialog.tsx` and `src/renderer/features/conversations/conversations.css` | Native wrapper/hook and wrapper CSS adaptation only. | `!submitting`; existing text remains mounted on rejection. |
| `src/renderer/features/learnings/CaptureLearningDialog.tsx` and `src/renderer/features/learnings/learnings.css` | Native wrapper/hook and wrapper CSS adaptation only. | F14 owner provides its feature-owned pending/unresolved close-blocking state. Do not implement a competing pending latch here. |
| `src/renderer/features/today/LogPastActivityDialog.tsx` and `src/renderer/features/today/today.css` | Native wrapper/hook, same fields and date semantics. | `!busy` for Escape and Close, not Escape bypassing the disabled button. |
| `src/renderer/features/discovery/DiscoveryBrief.tsx` and `src/renderer/features/leadInspector/leadInspector.css` | Native wrapper/hook replacing the partial hand-written Tab loop. Retain explicit trigger and reason focus. | `!busy`; retain exact request/generation/fingerprint behavior and same-retry semantics. |

For non-palette dialogs, do not introduce backdrop dismissal if they did not offer it. Adapt only wrapper selectors, default dialog margins/border/padding and `::backdrop`; leave all interior form CSS intact. Do not change a wrapper type based on busy/theme state. Shared hook adoption must remove the old native lifecycle/focus effect, not leave two competing owners.

**Adjacent repair gate:** `TodayPage.tsx:54-55` currently unmounts Log past activity immediately on submit. Capture learning currently lacks a pending guard. F13 cannot promise unresolved-write retention while those owners still remove their dialogs. F14 owns retention/submission outcomes and must integrate before accepting pending-close tests. This is a named dependency, not permission for the generic overlay utility to own those mutations.

## 5. Preferences, identities and shared-file coordination

Leave `useTheme.ts`, `useDensity.ts` and their storage contracts unchanged: `callie.theme`, `callie.density`, `html[data-theme]`, `html[data-density]`, system preference listeners and before-paint updates. No new persisted presentation setting. Keep inspector persisted width/clamping unchanged.

`FounderApp.tsx` does not need a structural change for F02/F03 once the root is above it. The F11 owner may add workspace-scoped intake state, and F12 may connect the native Import event. Both should remain under `PresentationRoot`, outside the keyed route as appropriate, and reuse the existing global Import owner. Do not fix F11 by keeping all ten pages mounted or removing the current route key under this presentation task.

Parent integration order for contested files:
1. Land the shared root/interaction interfaces and CSS ownership decisions.
2. Merge App health work around the same root, not a second wrapper.
3. Let the workflow owner merge its `NativeDeskRoute` / `FounderApp` changes, then add the small keyboard guard and verify no feature-owned shell rules returned.
4. Let F14 own the pending/retained form state, then wire `canDismiss` to it in Capture learning and manual activity. Let F07/F14 own bulk targets/editor state, then add the Escape stack guard.
5. Acceptance owner replaces conflicting assertions in the same integration, not after a falsely green old suite.

## 6. F17: exact acceptance plan, not tests run here

### Actual-route browser fixture

Create `tests/fixtures/applicationPresentationBrowser.tsx` and root `application-presentation.html`. Mount the production `<App />` with a complete typed `CalliePreloadApi` fixture and real `app.css`. Reuse the explicit no-IO pattern in `startupPresentationBrowser.tsx`, but supply every mounted route's read APIs and safe disconnected status DTOs instead of intentionally throwing for all non-Today reads. Do not use `as unknown as CalliePreloadApi` or omit `daily` to select legacy accidentally. Default commands log and reject. Each interaction test explicitly grants only its synthetic command needs.

Create `tests/browser/applicationPresentation.spec.ts` and `tests/support/presentationOracle.ts`. Import the real `appRoutes` and navigation labels. The destination oracle is an exhaustive `Record<AppRoute, ...>` so a new route cannot silently be omitted. Drive actual rail clicks, opening More when needed, and hashes for deep-link/reload tests. Neither fixture nor spec may mock `renderRoute`, replace a destination with Today, or substitute a label for a real page.

Required destination proof after each navigation:

| Route | Actual content/component proof, in addition to current link/hash | Read path exercised |
| --- | --- | --- |
| today | Native Today queue and three lane containers in meeting-first; actual `today-route`/Contacts due in explicit legacy case. | `daily.get`, local workspace/delegation reads; `today.get` only for actual legacy content. |
| accounts | Accounts desk surface and account-library/fixture account content, not Today lanes. | Actual `NativeDeskRoute` account branch. |
| campaigns | Campaigns desk surface and frozen-campaign/fixture version content, not Today lanes. | Actual campaign branch. |
| leads | Leads PageHeader and seeded grid/empty-state controls. | `leads.list`. |
| pipeline | Pipeline PageHeader and real “Pipeline view” control plus board/table content. | `pipeline.get`. |
| conversations | Conversations PageHeader, “Search conversations”, list pane and “Conversation detail” pane. | `conversations.list`. |
| learnings | Learnings PageHeader and capture/filter or seeded learning content. | `learnings.list`. |
| friday | Actual scoreboard plus “Source funnel” and “Job requests”. | `friday.getCurrent`. |
| inbox | Inbox PageHeader and real review-kind tabs/queue. | `review.list`; do not encode the false health wording repaired by F05. |
| settings | Settings with actual Appearance controls and read-only capability/status sections. | Actual Settings component and its status readers. |

**Core matrix:** all ten routes × light/dark × comfortable/compact × 1440×900/1050×700 = 80 route observations. Record and assert every observation, not one final subset while calling the entire capture a pass. In every context compare a common shell/overlay oracle: one presentation root, one Callie wordmark, system shared font, root semantic tokens, workspace canvas, rail width and right edge, primary/secondary item geometry, persistent More behavior and no window overflow. Measure primary/secondary navigation separately. Sample both the transition frame and settled destination so a flash back to old globals cannot pass.

**Authority separation:** run the common-root checks for explicit legacy, pending, first-read failure, unknown/disagreement and meeting-first resolution. Authority assertions still verify held actions and truthful content; none may remove presentation. Keep existing startup no-command/exact-read inventory assertions. Full ten-route legacy and meeting-first passes are required before cross-authority consistency is claimed. Startup diagnostics has no rail, so assert its root/theme without inventing navigation before foundation readiness.

**Overlay matrix:** open palette and Import from each actual route in each core context, then compare computed background/font/line/foreground to the root. Open the real selected-person full page and docked inspector with a fictional person, navigate underneath it to all ten routes, and require full-page left edge equals rail right edge within one CSS pixel at both widths. Assert the same person remains selected. Do not replace contact content with a geometry-only rectangle.

**F13 behavioral cases:** palette over full-page contact → first Escape closes only palette, restores a connected contact control, preserves person/draft, second Escape closes contact. Repeat with docked inspector and Leads bulk selection underneath. Check a Select inside a dialog consumes first Escape without closing dialog. Exercise full Tab/Shift-Tab cycles and attempted background activation for all six modal consumers, not one Tab step. Check blocked Import/other writes consume Escape and keep both current and underlying layers. Test palette → Import focus handoff, disconnected/stable-ID opener fallback after route refresh, and repeated/composing Escape. Cover loading→error→retry→ready contact with a visible, operable Close throughout and no stale read reopening after close.

**Lifetime checks:** in the actual Native editor record input/textarea DOM identity, text, focus/caret and the feature's existing command identity. Change theme/density, open/close palette and rerender without changing semantic selection. Nodes/draft/command identity must remain unchanged. Existing intentional route/selection lifetimes are not silently extended or shortened by a presentation wrapper. Retain Native composer geometry/reachability tests, especially long draft/approval disclosures and 1050×700. Verify other routes' existing data workflows still operate after the shared frame change.

Add unit/component coverage in `src/renderer/app/PresentationRoot.test.tsx`, `src/renderer/app/overlayLayers.test.tsx`, `src/renderer/app/useModalDialog.test.tsx`, and extend the existing inspector/import/palette tests. Unit native-dialog mocks prove request/cancel sequencing only. Browser tests prove actual isolation/focus/computed CSS. Later packaged tests in `tests/e2e/bauhausWorkflow.spec.ts` must apply the same oracle to actual renderer/preload/main on a disposable fictional workspace. Signed/native/live acceptance remains a separate parent-authorized phase, not evidence this design supplies.

### Conflicting assertions that must be replaced

| Existing exact file/region | Invalid old contract | Replacement, preserving useful coverage |
| --- | --- | --- |
| `tests/browser/startupPresentation.spec.ts:201-214` | Legacy has zero Native presentation markers, cream canvas, visible FSS, and is filtered out of A samples. | Root persists in legacy; every sample including legacy uses common presentation. Keep actual legacy content and authority/read-inventory checks. |
| `tests/fixtures/startupPresentationBrowser.tsx:120-140` | Presentation sampled from desk/startup/shell rather than common root. | Sample `PresentationRoot` for presentation, actual feature for workflow and phase. Do not conflate the two. |
| `src/renderer/features/today/NativeDeskPresentation.test.tsx:62-105` | Feature owns presentation and confirmed legacy opts all three surfaces out at `85-89`. | Wrap in actual root. Assert root identity across pending/error/unknown/legacy and independent feature authority. Keep route-specific welcome/queue assertions. |
| `src/renderer/app/NavigationRail.test.tsx:113-163` | More hidden for legacy; fake Native descendant activates Callie and removing it restores FSS. | One Callie/More contract regardless of descendant/authority. Keep link order, platform drag geometry, focusability and in-window navigation, accounting for collapsed secondary links. |
| `tests/e2e/bauhausWorkflow.spec.ts:6,30-60` | Eight-route “all workspaces”, FSS, cream canvas, intentionally different display/body fonts and ≤2px selected-nav radius. | Canonical ten-route registry and common Native shell/overlay oracle. Retain theme persistence, real workflows, no overflow, accessibility and import-focus checks. |
| `src/renderer/design/bauhaus.test.tsx:93-170` | Detached legacy-only design fixture asserts Futura/Inter, cream surfaces and old action colors as product identity. | Mount root and shared stylesheet. Replace obsolete identity values; retain contrast, animation, drag-row, semantic status and geometry checks that remain valid. Ordinary 2px controls/3px panels are not themselves forbidden or globally redesigned. |
| `tests/fixtures/nativeDeskBrowser.tsx:17-35` | All non-Accounts/Campaigns destinations silently map to Today; Settings is a partial stub. | Stop this fixture from claiming route acceptance. Restrict it explicitly to isolated desk/workflow component scenarios, reject unsupported destinations instead of substituting, and move navigation assertions to the real-App fixture. |
| `tests/browser/nativeDesk.spec.ts:808-832` | Conversations checks only current link, then legacy restores expanded navigation and fake Today. | Replace the route/navigation scenario with real-App Conversations content and invariant More/brand behavior through explicit authority change. Do not merely delete the failing half or skip legacy. |
| `src/renderer/app/FounderApp.test.tsx:130-188` | Incomplete cast API omits `daily`, forcing a nonproduction branch. | Use a complete explicit API for App integration, including daily/delegation/local workspace. Explicit legacy DTOs select legacy tests. Keep single-inspector, command and refresh/lifetime assertions. |
| `tests/fixtures/nativeDeskCompositionBrowser.tsx`, remaining isolated Native fixtures/tests | CSS depended on a feature making its shell Native. | Wrap composition fixtures in real `PresentationRoot`; keep composition/command guards as component evidence, not all-route evidence. |

Also update `tests/renderer/commandPalette.test.tsx`, `src/renderer/features/import/ImportDialog.test.tsx`, `src/renderer/features/leadInspector/LeadInspector.test.tsx`, `src/renderer/features/discovery/DiscoveryBrief.test.tsx`, and `src/renderer/features/leads/LeadsBulkBar.test.tsx` to mount the shared interaction root and cover the changed close boundaries. Inspect source-level CSS wiring checks when migrating selectors, but retain their semantic-token/no-literal-colors boundary. Do not weaken contrast tests, replace actual pages with sentinels, snapshot-update the old split, or add legacy exclusions to make green results.

## 7. Minimal execution order and handoff gates

1. **Acceptance owner:** express failing actual ten-route/common-root and stacked-Escape cases, plus Today/editor preservation cases. Replace conflicting contracts above in the same repair branch. This document did not execute them.
2. **Presentation owner:** add stable root and migrate exact shared declarations. Keep route registry/content untouched. Verify Native Today preservation before removing all feature-owned ancestor rules. Alias/overlay fixes must be checked, not presumed from selector text.
3. **Interaction owner:** add topmost layer/native dialog utilities, stable contact header, then migrate the six modal consumers and underlying Escape guards. Preserve all feature request identities and wait for F14 retention integration.
4. **Acceptance owner:** verify the 80-observation core, explicit authority matrix, overlay geometry/focus and source-level ownership invariant. Re-run existing data/authority/recovery/signature tests under the parent's execution plan. Packaged/live claims need their own real authorized acceptance.

**Source review completed:** traced real App/FounderApp/AppShell/registry; preference hooks and global/native CSS; selected-person lifetime/close/request invalidation; palette/Import and the five custom modal paths; competing Escape handlers; the named contradictory acceptance fixtures/assertions. Self-review checked that this plan does not move workflow authority into presentation, reparent keyed editors, silently widen scope to other findings, or mistake fixture evidence for package acceptance.

**Open integration dependencies:** F14 pending/unresolved close state and parent integration of F11/F12/F15 shared files. No additional user clarification blocks this design. No runtime or test result is claimed.
