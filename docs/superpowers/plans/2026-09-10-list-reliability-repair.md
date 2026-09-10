# List reliability repair execution plan

> **For agentic workers:** use the writing-plans/executing-plans workflow only after parent GO. Exactly one implementation task at a time, with independent review and parent-controlled acceptance. This documentation approval authorizes no implementation, commands or commits.

**Goal:** F05 complete local Inbox paging/counts/startup badge/availability, F06 Leads continuation, F07 exact selected-set mutation, and only Leads inline/bulk pending/error retention from F14.
**Architecture:** chosen full-projection snapshot-fingerprint cursor, existing list/mutation names, transactional writes and authority gates. Complete source-scoped Inbox metadata travels through existing IPC. Request generations, controlled input and synchronous pending fences preserve work.
**Tech stack:** TypeScript, React, Zod, synchronous encrypted SQLite, existing Electron preload/validated IPC, Vitest and parent-run Playwright.
**Spec:** [List reliability repair](../specs/2026-09-10-list-reliability-repair.md). Binding [program](../2026-09-10-product-repair-program.md) and [audit](../../engineering/2026-09-10-adversarial-product-audit.md).
**Source checkpoint:** user base `base14e5fa7`, parent-reported root `2b01261`; source reads confirm PresentationRoot above App's health branch, focusable main and dirty OverlayProvider inside PresentationRoot. No clean-tree or overlay-completion certification. Re-read handed-off files before editing.
**Approval:** parent accepted B1-B7 on 2026-09-10 for this documentation. Implementation remains **HOLD** while shared files are active. Accepted decisions do not satisfy H1-H3 or authorize runtime work.

## Global constraints and mandatory handoffs

- No rollback, history deletion, schema downgrade, suppression bypass, inferred contact route, weakened recovery/authority, provider activation, installation, push or real-profile use. Preserve organization assignment repair and retained review records.
- One implementation worker at a time. Source-only review may overlap. Parent exclusively schedules native/browser/Swift/package/full-suite jobs. No native dependency rebuild in response to failure. Use disposable fictional workspaces only.
- Every future npm/npx invocation starts with `export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"`. Existing ABI137 remains unchanged. Commands below are future recipes, not planner executions.
- Preserve PresentationRoot, OverlayProvider, modal ownership, theme/density, route content and focus restoration. `App.tsx`, `PresentationRoot.tsx`, overlay helpers, CSS and NativeDeskRoute are read-only to these workers. No root/overlay/style refactor.
- **H1, before Task1:** parent releases presentation root/shell and frozen six Inbox UI paths plus corresponding tests, naming accepted checkpoint. Preserve unsupported-action removal, neutral empty copy and supported Promote from [mutation/review repair](2026-09-10-mutation-and-review-repairs.md). Release includes shared FounderApp/NavigationRail/test consumers.
- **H2, before Task2:** [shared-presentation plan](2026-09-10-shared-presentation-repair.md) **Task3** finishes and hands off LeadsBulkBar.tsx and its tests. Underlying-route Escape/modal guards are prerequisites, not work to race or redo. At planning read the handler was unconditional; do not presume guards landed. Parent conditionally grants the exact LeadsBulkBar.test.tsx path after this handoff.
- **H3, strict fixtures:** parent owns `tests/fixtures/applicationPresentationBrowser.tsx`, `tests/fixtures/nativeDeskBrowser.tsx`, `tests/fixtures/nativeDeskCompositionBrowser.tsx`, and locked acceptance metadata changes while presentation acceptance is frozen. Task1 supplies exact metadata changes; parent integrates at agreed checkpoint. No worker edits escrow paths or frozen baselines to make typecheck pass.
- Each repair requires maintained behavioral RED, minimal implementation, focused GREEN, exact-file freeze, independent review and parent-authorized isolated commit. No commits under docs-only GO. Task3 validates actual joins; mock-only tests cannot close findings.

## Accepted source-grounded decisions and remaining operational gates

| ID | Source evidence | Parent-accepted disposition |
| --- | --- | --- |
| B1 | `FounderSalesDomainErrorCode` is exported in `src/main/domain/founderSalesDomain.ts:184-195`. No shared cursor-error union exists. `src/preload/ipcClient.ts` parses success and propagates invoke rejection. | Add codes to existing main union and a helper error. Renderer never relies on Electron preserving `.code`. No public error envelope or shared security subsystem. |
| B2 | Required ReviewSnapshot additions invalidate seven observed snapshot fixture consumers; some are frozen parent acceptance. | Strict metadata stays required. Parent escrow integration precedes Task1 full typecheck/acceptance. No fabricated zeros, optional defaults or knowingly broken GREEN. |
| B3 | Existing LeadsBulkBar.test.tsx was unlisted in initial design and asserts Escape clears anywhere with void callbacks. | Parent grants `src/renderer/features/leads/LeadsBulkBar.test.tsx` to Task2 **only after shared-presentation Task3 handoff**. Existing overlay helpers/tests remain outside reliability ownership. |
| B4 | Full projection/hash costs O(N) rows/memory per request plus SQL ranking; mutable ranks/name/membership invalidate continuation. | Accepted tradeoff, not speed claim. Measure208 and a larger bounded fictional fixture before release. If unacceptable, stop for redesign, not offset fallback/cache/hidden cap. |
| B5 | Review fixtures include unsupported kinds though production emits only unmatched/system. ReviewRoute.test.tsx fabricates an ambiguous row for Open person. | Preserve explicitly synthetic read-only branch coverage, moving assertions within owned tests to direct ReviewDetailPanel rendering where needed. Do not claim source integration or lifecycle-backed availability. |
| B6 | package.json test:e2e enumerates files and omits proposed reliabilityWorkflow.spec.ts. | Parent owns exact-spec invocation and any maintained package/release wiring. Task3 worker has no package.json permission. |
| B7 | Existing packaged fixture helper is not a general lifecycle-review seeder. | Nonempty208-review startup uses actual public-route/preload/registrar/domain composition with labeled in-process Electron transport. Package Leads and empty Inbox still run. No production seed hook or widened recovery fixture. |

**Strict snapshot consumers observed:** `src/renderer/app/FounderApp.test.tsx`; `src/renderer/features/review/ReviewPage.test.tsx`, `ReviewRoute.test.tsx`; `tests/fixtures/applicationPresentationBrowser.tsx`; `tests/integration/reviewService.test.ts`; `tests/main/registerReviewIpc.test.ts`; `tests/renderer/noMachineEnums.test.tsx`. `tests/main/founderSalesDomain.test.ts:900-903` currently asserts only items and remains Task1 behavioral coverage.
**Badge consumers observed:** `src/renderer/app/AppShell.test.tsx`, `NavigationRail.test.tsx`, `src/renderer/design/bauhaus.test.tsx`, `tests/fixtures/nativeDeskBrowser.tsx`, `nativeDeskCompositionBrowser.tsx`. LeadDetail transcript reviewCount is unrelated and unchanged.
**Re-inventory at handoff:** search ReviewSnapshot, reviewSnapshotSchema, totalOpenCount:, reviewCount=, onReviewCountChange and changed prop types. New/unlisted consumers require parent ownership disposition, not arbitrary worker edits.

## Frozen proposed interfaces and data semantics

### Lists and complete metadata

Leads request/response remain `{query,stages,priorities,sort,cursor,limit}` and `{rows,nextCursor,total,revision}`. Sort remains priority/person_name/last_contact; limit1..200. Keep escaped search and all existing ordering/tie-break rules.
Extend reviewListRequestSchema with `cursor: z.string().max(1024).nullable().optional()`. Omitted/null is page1; new callers pass null or returned cursor. Required snapshot additions:
```ts
type ReviewQueueAvailability =
  | {source:'lifecycle_review_items'; openCount:number}
  | {source:'not_integrated'; openCount:null};
type ReviewQueueCounts = Record<ReviewKind, ReviewQueueAvailability>;
// Existing items, totalOpenCount, revision retained.
// New nextCursor:string|null; matchedCount:number; queues:ReviewQueueCounts;
// countScope:'lifecycle_review_items'; observedAt:offset-aware ISO string.
```
Strict schemas explicitly require six keys, safe nonnegative integer counts and consistent source/null. Total counts every open lifecycle row; matchedCount counts selected kinds before paging. Unmatched/system counts are complete. Four other sources are not_integrated/null, not zero or an adapter-health statement.

### Full-projection cursor, no new architecture
```ts
type ListCursorErrorCode = 'LIST_CURSOR_INVALID'|'LIST_CURSOR_STALE';
type ReadCursor = {v:1; scope:'leads'|'review'; queryHash:string;
  snapshotHash:string; index:number};
// src/main/domain/support/listCursor.ts
export function pageFromSnapshot<T>(input:{
  scope:ReadCursor['scope']; queryKey:string; snapshotKey:string;
  rows:readonly T[]; cursor:string|null; limit:number;
}):{rows:T[]; nextCursor:string|null};
// Export ListCursorError with readonly code:ListCursorErrorCode for facade conversion.
```
- QueryKey deterministic JSON includes scope, exact search, sorted/deduplicated filters, sort and limit. SHA-256 both key strings using existing Node crypto. Strict base64url JSON rejects >1024 chars, invalid/noncanonical encoding, extra fields, wrong version/scope/query hash, unsafe/negative/out-of-range index, numeric legacy cursor and trailing junk. Snapshot mismatch STALE, malformed/query mismatch INVALID.
- Leads executes full ordered strict projection without LIMIT/OFFSET, hashes rows excluding revision/time, derives total from length, then slices. Preserve CUME_DIST/cloud timing and unique cycle-ID tie-break.
- Review reads all open lifecycle rows ordered created_at/id including version. Safely classify unknown-handle payloads unmatched, others system_error. Snapshot key includes complete ordered source rows plus availability version. Malformed JSON/object shape becomes safe system_error, never disappears. Metadata precedes kinds filtering/page slice.
- Projection/count/fingerprint/page use one synchronous deferred read transaction, reusing existing transaction snapshot rather than nesting BEGIN. No write UoW, awaiting inside transaction or transaction across requests. total_changes revision is informational, not freshness proof.
- Helper never imports facade. Facade catches ListCursorError and throws `new FounderSalesDomainError(error.code,error.code)` after extending existing union. Other errors remain failures. Fixed renderer messages never echo raw text or parse Electron strings. Existing sender/preload validation and ready-domain gates remain.
- Content/order/membership changes reject continuation, including external connection commits. UI retains last-loaded view/checks/controls with safe error, Retry more and Refresh list. Null-cursor restart recovers. This is not historical snapshot retention.

### Renderer contracts
```ts
type LeadSaveResult = {status:'saved'}|{status:'failed';message:string};
// route -> page -> grid/meta/inline, or page -> bulk bar:
// onUpdateField(input:LeadFieldUpdateRequest):Promise<LeadSaveResult>
// onBulkSetOrganization(value:string|null):Promise<LeadSaveResult>
// LeadsBulkBar keeps onSetOrganization(value:string|null):Promise<LeadSaveResult>
type ReviewBadgeState = {status:'loading'}|{status:'failed'}
  |{status:'ready';count:number;observedAt:string};
// useReviewSummary(api:ReviewApi) -> {state:ReviewBadgeState;
//   refresh():void;accept(snapshot:ReviewSnapshot):void}
// RouteContext/ReviewRouteProps.onReviewSnapshot(snapshot:ReviewSnapshot):void
// replaces numeric callback. AppShell/NavigationRail retain reviewCount prop name,
// now ReviewBadgeState rather than number.
```
- Separate initial loading/failure from append states. Append returned cursor only for identical controls/current generation, never duplicate IDs. Show Showing X of Y, Load more/retry/refresh. Changed query hides old result counts while page1 loads, not checked-ID set.
- Capture exactly `[...checkedPersonIds].sort()`, label N selected/M outside view. Above200: zero calls, retain work, `Select 200 or fewer people for one update. No records submitted.` No chunking or pruning.
- Route owns inline `{personId,field,personLabel,draft,status:'editing'|'pending'|'failed',error:string|null}` and bulk editor/draft/status above virtualized cells. Hidden cells retain an Unfinished edit recovery form outside grid. No persistence promise after leaving Leads.
- Synchronous route ref lock before invoke, one mutation at a time. Capture targets/value; disable other mutation/selection/Clear controls. Enter/blur/repeat cannot duplicate. Only confirmed success closes/clears submitted work. Idle/failed Cancel may discard; pending Escape/blur may not.
- Receipt affectedPersonIds set must equal captured targets. Rejection/scope mismatch keeps draft/editor/checks: `The change could not be confirmed. Your input is kept. Review the records before retrying.` No automatic retry. Confirmed save plus refresh failure says `Saved; list refresh failed`.
- **Modal integration:** retain handed-off shared Task3 guard for defaultPrevented/composing/repeated Escape and active overlays. Existing useOverlayLayers returns hasOpenLayer/hasModal under PresentationRoot/OverlayProvider. No competing provider/dispatcher. Pending guard supplements modal guard; palette/Import Escape cannot clear underlying selected set/draft.
- Inbox server-filters selected kind, pages with same filter, uses metadata for tabs/header/system alert. Four tabs remain Not available in this Inbox. Labels say open local reviews with scope/time, not health assurance. Preserve frozen Promote and key detail by reviewId.
- Summary owner mounts in FounderWorkspace before Inbox; fetch `{kinds:[],cursor:null,limit:1}` on healthy mount, route entry, focus/import completion and successful resolution. accept invalidates older reads; teardown invalidates replies. Loading/failed never numeric zero. No root/overlay/inspector lifetime or startup/recovery bypass.

## Task1: Snapshot-safe public reads and truthful Inbox/startup

**Depends on explicit GO and H1/H3. One worker; B1/B2/B5 are accepted, not outstanding design questions.**
**Production ownership:** `src/main/domain/founderSalesDomain.ts`; create `src/main/domain/support/listCursor.ts`; `src/shared/contracts/reviewContract.ts`; `src/main/review/registerReviewIpc.ts` only if existing fixed error handling is needed; `src/renderer/features/review/{ReviewRoute.tsx,ReviewPage.tsx,ReviewTabs.tsx,ReviewQueue.tsx,reviewKindMeta.ts}`; `src/renderer/app/{FounderApp.tsx,AppShell.tsx,NavigationRail.tsx,routeRegistry.tsx}`; create `src/renderer/app/useReviewSummary.ts`.
**Test ownership after release:** `tests/integration/{leadsService.test.ts,reviewService.test.ts}`; `tests/main/{founderSalesDomain.test.ts,registerReviewIpc.test.ts}`; create `tests/main/listCursor.test.ts`; `src/renderer/features/review/{ReviewPage.test.tsx,ReviewRoute.test.tsx}`; `src/renderer/app/{FounderApp.test.tsx,AppShell.test.tsx,NavigationRail.test.tsx}`; `src/renderer/App.lifecycle.test.tsx`; `src/renderer/design/bauhaus.test.tsx`; `tests/renderer/noMachineEnums.test.tsx` (fixture metadata only).
**Parent escrow, not worker ownership while frozen:** `tests/fixtures/{applicationPresentationBrowser.tsx,nativeDeskBrowser.tsx,nativeDeskCompositionBrowser.tsx}`. Parent may retain FounderApp/bauhaus acceptance fixture updates until release. No fourth implementation task or CSS/frozen detail-action ownership.

1. [ ] Add RED in real encrypted service tests:205 older system reviews +3 later unmatched and reverse order. Filter later kind returns3 immediately; metadata205/3,total208; every paged ID reachable once. Exercise empty/all/one/multiple kinds, limits1/200, created_at ties, malformed payload fallback and unchanged source/status rows.
2. [ ] Add cursor RED:208 Leads per sort/filter; after page1 mutate name/membership/cloud rank or insert earlier row. Stale rejects; fresh walk reaches exact membership once. Repeat committed second-connection mutation. Invalid/query-changed/cross-scope cursor rejects; read total_changes unchanged.
```ts
const first = domain.listLeadRows({...request,cursor:null,limit:200});
domain.updateLeadField({personId:targetId,field:'person_name',value:'AAA moved'});
expect(() => domain.listLeadRows({...request,cursor:first.nextCursor,limit:200}))
  .toThrowError('LIST_CURSOR_STALE');
```
3. [ ] Renderer RED: Today badge208 before Inbox mounts; initial/refresh failure unavailable, not zero; later-kind tab3; append failure keeps rows/retry/refresh; old-tab/old-summary replies cannot overwrite. System alert appears with no loaded system rows. Four unavailable tabs stay neutral, unsupported actions absent.
4. [ ] Observe behavioral RED under parent test lease before production edits. Implement exact helper/facade/schema. Classify full snapshot before filtering, extend only main error union, preserve transaction/resolution authority. Example empty metadata:
```ts
{items:[],totalOpenCount:0,revision:0,nextCursor:null,matchedCount:0,
 countScope:'lifecycle_review_items',observedAt:'2026-09-10T00:00:00.000Z',
 queues:{unmatched_communication:{source:'lifecycle_review_items',openCount:0},
   system_error:{source:'lifecycle_review_items',openCount:0},
   ambiguous_identity:{source:'not_integrated',openCount:null},
   transcript_suggestion:{source:'not_integrated',openCount:null},
   import_problem:{source:'not_integrated',openCount:null},
   adapter_failure:{source:'not_integrated',openCount:null}}}
```
5. [ ] Wire filtered ReviewRoute, metadata tabs/system alert and startup summary. Give parent exact fixture metadata/prop changes. Preserve unsupported-detail branch tests without source-integration claims. No schema defaults/missing-key acceptance.
6. [ ] Focused GREEN, parent-integrated fixture typecheck and owned ESLint. Measure208 and larger bounded fictional reads without speed claims. Freeze/report limits, independent review, then parent-authorized exact-path commit. F05 does not certify whole-ingestion health.

**Future focused command after lease, repeated for RED/GREEN:**
```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"
npx vitest run tests/main/listCursor.test.ts tests/integration/leadsService.test.ts tests/integration/reviewService.test.ts tests/main/founderSalesDomain.test.ts tests/main/registerReviewIpc.test.ts src/renderer/features/review/ReviewPage.test.tsx src/renderer/features/review/ReviewRoute.test.tsx src/renderer/app/FounderApp.test.tsx src/renderer/app/AppShell.test.tsx src/renderer/app/NavigationRail.test.tsx src/renderer/App.lifecycle.test.tsx src/renderer/design/bauhaus.test.tsx tests/renderer/noMachineEnums.test.tsx --maxWorkers=1 --minWorkers=1
```

## Task2: Leads continuation, exact scope and input retention

**Depends on Task1 and completed H2. One worker.**
**Production ownership:** `src/renderer/features/leads/{LeadsRoute.tsx,LeadsPage.tsx,LeadsGrid.tsx,leadColumns.tsx,LeadsBulkBar.tsx,useLeadGridState.ts}`; optional extraction only at `src/renderer/features/leads/useLeadMutations.ts`.
**Tests:** `src/renderer/features/leads/{LeadsRoute.test.tsx,LeadsGrid.test.tsx}`; create `src/renderer/features/leads/LeadsMutationRetention.test.tsx`; parent-granted `src/renderer/features/leads/LeadsBulkBar.test.tsx` **only after shared-presentation Task3 handoff**. No domain/contract/shell/review/overlay/CSS ownership.

1. [ ] Re-read/record handed-off bulk guards and protect their tests. RED first200/total208, Load more final8, keyboard traversal/open row208, checked identities across pages. Delayed responses/query/filter/sort cannot mix; append failure retains200.
2. [ ] Exact-scope RED: select Kevin/Maya, filter Kevin, submit Organization for2, expect exact sorted two-ID payload. Repeat checked second-page row, >200 selection zero calls, zero targets and mismatched receipt no clearing.
```ts
expect(api.bulkUpdate).toHaveBeenCalledWith({
  personIds:['person-kevin','person-maya'],field:'organization_label',value:'New Org',
});
```
3. [ ] Deferred-save RED for inline name/organization/null and bulk: Enter twice, blur, Escape, Clear/other submit, exactly one call and text/checks remain. Reject, assert safe alert/same input; explicit retry succeeds once. Filter/virtualize pending/failed cell and recover draft. Confirmed save/list rejection must not invite resubmission.
4. [ ] Overlay regression after H2: selection/draft, real palette or Import within PresentationRoot, Escape closes only top layer. Pending editor cannot cancel; composing/repeated/defaultPrevented events preserve policy. Do not claim jsdom mocks prove native inertness; parent checks actual modal behavior.
5. [ ] Observe RED then implement controlled sessions/promise callbacks/ref lock and generation-bound paging. Payload from Set, not loaded rows. Verify receipt before clearing submitted IDs. Preserve guards and inspector review-advance; loaded boundary is not end-of-data.
6. [ ] GREEN, typecheck after escrow integration, owned lint, freeze/review, parent-authorized exact-path commit. F06/F07/Leads F14 await Task3 actual joins.

**Future focused command after lease and H2 handoff:**
```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"
npx vitest run src/renderer/features/leads/LeadsRoute.test.tsx src/renderer/features/leads/LeadsGrid.test.tsx src/renderer/features/leads/LeadsMutationRetention.test.tsx src/renderer/features/leads/LeadsBulkBar.test.tsx --maxWorkers=1 --minWorkers=1
```

## Task3: Actual public-boundary and route acceptance

**Depends on Tasks1-2. One test implementation worker; parent alone runs package/native/browser acceptance.**
**Exclusive new paths:** `tests/integration/reliabilityPublicRoutes.test.tsx`, `tests/fixtures/reliabilityDomainFixture.ts`, `tests/e2e/reliabilityWorkflow.spec.ts`. May modify `tests/e2e/founderWorkflow.spec.ts` only for obsolete zero-badge expectation. No production/package.json ownership; parent owns B6 wiring.

1. [ ] Disposable encrypted-domain fixture uses existing openDatabase/migrateToLatest/createDomainServices/createFounderSalesDomain and lifecycle patterns in `tests/integration/reviewService.test.ts:86-109`. Unique valid person/prospect/cycle/activation IDs, existing test keys only. No production seed hook or real profile.
2. [ ] Actual FounderApp/routeRegistry under PresentationRoot. Production preload createIpcClient/createLeadsApi/createReviewApi, validated registrars and createLeadsProvider/createReviewProvider from registerApplicationIpc.ts backed by real domain. Label in-process Electron invoke transport; never stub list/mutation results or replace destinations. Existing sender-rejection tests remain; FoundationRuntime readiness coverage is separate, not proven by fixture gate delegation.
3. [ ] Record RED against old behavior and GREEN at repaired head: Today badge208, actual Inbox later-kind count/all208 reachable, actual Leads row208/open, exact cross-filter mutation plus persisted readback/receipt. Real ambiguous-organization rejection leaves DB unchanged and draft retained. Deferred component timing tests cannot substitute for persistence checks.
4. [ ] Parent packaged scenario via launchFounderWorkspace: CSV UI208 fictional people, Load more, keyboard-open last person, cross-page/filter selection, mutation and preload readback. Real clean Inbox verifies unavailable/known-empty labels/startup. Preserve actual More navigation, overlays and root composition.
5. [ ] Parent checks palette/Import over pending/error bulk editor with actual keyboard/modal isolation. Topmost Escape leaves input/IDs. No route proxy, renderer API monkey-patch claiming production, live grants or installed-profile mutation.
6. [ ] Report evidence per finding. Nonempty208-review startup is real-domain/in-process transport, not packaged208-review coverage. B7 limitation stays explicit. No unobserved pass; freeze/review then parent-authorized isolated commit. Parent wires exact spec into maintained release invocation.

**Future public-join command after lease:**
```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"
npx vitest run tests/integration/reliabilityPublicRoutes.test.tsx --maxWorkers=1 --minWorkers=1
```
**Parent-only exact-spec invocation after separate package/artifact approval:**
```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"
npx playwright test --workers=1 tests/e2e/reliabilityWorkflow.spec.ts tests/e2e/founderWorkflow.spec.ts
```
These are future recipes only. Future typecheck is existing npm run typecheck with the same PATH prefix. Parent holds cross-task acceptance fixture edits and full-suite execution.

## Acceptance ledger and stopping rule

| Finding | Required observed evidence |
| --- | --- |
| F05 | Complete lifecycle counts/pages despite later-kind order; four unavailable sources; nonempty badge before Inbox through actual public join; stale/out-of-order/failure handling; packaged scoped empty state; no unsupported actions restored. |
| F06 | Cursor rejects stale pages including external writes; actual UI reaches208 with controls/keyboard/open intact; no silent truncation. |
| F07 | Exact captured IDs equal payload/receipt/persisted changes despite pages/filters; >200 explicit no-submit; nonselected rows unchanged. |
| Leads F14 | Pending duplicate fence, retained input through rejection/virtualization, safe error/explicit retry, save-versus-refresh distinction, topmost modal Escape preserves underlying work. |

Documentation completion is not implementation acceptance. B1-B7 are decided; H1-H3, explicit implementation GO, observed RED/GREEN, benchmarks, independent review and actual acceptance remain mandatory. Blocked packaged checks stay open. If O(N) cost proves unacceptable, stop for approved redesign. Do not expand cursor architecture, weaken metadata, silently acquire consumers or absorb continuity/health/first-use repairs.
