# List reliability repair design

**Scope:** F05 complete local Inbox paging/counts/startup badge/availability, F06 Leads paging, F07 exact selected targets, and only the Leads inline/bulk pending/error-retention portion of F14.
**Authority:** [Approved repair program](../2026-09-10-product-repair-program.md), [adversarial audit](../../engineering/2026-09-10-adversarial-product-audit.md), and [execution plan](../plans/2026-09-10-list-reliability-repair.md).
**Status:** Parent approved the design and B1-B7 dispositions for documentation on 2026-09-10. Implementation remains **HOLD** until explicit GO and file handoffs. This document is a proposal, not evidence of implemented or passing behavior.
**Source checkpoint:** User-supplied base `base14e5fa7`, parent-reported root `2b01261`, and current dirty presentation/overlay plus frozen review-action files were read. This is not a clean-tree certification. Re-read handed-off source before implementation.
**Invariant:** Every matching local record is reachable; counts disclose actual source and observation; every advertised selected ID is submitted or nothing is submitted with explicit scope guidance; failures retain intended input with safe errors; pending submissions cannot duplicate.
**Execution:** Exactly three sequential tasks, one implementation worker per task. Parent owns native/package/browser scheduling and frozen fixture integration. No new security, provider, migration, cursor-cache or generic command subsystem.

## Source facts and actual boundaries

- `src/shared/contracts/leadsContract.ts:37-76`: list accepts `{query,stages,priorities,sort,cursor,limit}` with limit 1..200 and returns `{rows,nextCursor,total,revision}`. Bulk accepts 1..200 `personIds` for `person_name` or `organization_label`, not arbitrary patches or stages.
- `src/main/domain/founderSalesDomain.ts:462-627`: Leads SQL uses active/onboarding cycles, escaped person-name search, stage/priority filters and three explicit sorts. Priority includes mutable within-source `CUME_DIST`, cloud timing and cycle-ID tie-breaks. Current cursor uses `parseInt` offset; count and rows are separate reads. Sort keys, membership and priority may change between pages.
- Same file `629-649`: single/bulk writes already use `unitOfWork.immediate`; bulk processes requested IDs in one transaction. Preserve the repaired organization assignment and receipt identities. Do not chunk >200 selections into separate transactions or rename shared organizations.
- Same file `3452-3463`: revision is connection-local SQLite `total_changes()`, not a durable workspace snapshot or other-connection change token.
- `src/renderer/features/leads/LeadsRoute.tsx:106-140`: drops nextCursor, intersects checked IDs with returned rows, clears all checked IDs after subset success, and refreshes after both success and rejection.
- `useLeadGridState.ts:35-80`: filters/sort retain checked IDs and request cursor null. `LeadsGrid.tsx` virtualizes loaded rows by person ID. `leadColumns.tsx` closes editing before acknowledgement; `LeadsBulkBar.tsx` clears text on submit.
- `src/shared/contracts/reviewContract.ts:19-28`: list has kinds/limit but no cursor; snapshot has items/totalOpenCount/revision but no complete kind counts or source coverage.
- `founderSalesDomain.ts:2018-2069`: only open `lifecycle_review_items` feed Inbox, with LIMIT before mapping/filtering. Unknown-inbound-handle payload maps to unmatched communication; other rows map to system error. Four other kind DTOs are not populated here. Counts do not describe external ingestion or adapter health.
- `src/main/domain/lifecycle/lifecycleReviewRepository.ts:72-139`: insert starts version 1; resolve uses expected-version/status CAS, increments version and retains the row. Preserve authority/evidence checks. Reads must never delete or resolve records to expose later pages.
- Frozen `ReviewDetailPanel.tsx` removes unsupported actions, retaining Promote and read-only evidence/navigation. `ReviewPage.tsx` no longer batch-accepts suggestions; `ReviewQueue.tsx` uses neutral empty copy. Preserve [mutation/review repairs](../plans/2026-09-10-mutation-and-review-repairs.md), not arbitrary repair text or privacy guarantees.
- `ReviewTabs.tsx` counts loaded items; `ReviewPage.tsx` derives its system alert from loaded rows. `ReviewRoute.tsx` fetches one 200-row snapshot. `FounderApp.tsx` starts the badge at numeric zero and relies on Inbox updates; NavigationRail hides nonpositive counts.
- Actual Leads boundary: `src/renderer/app/routeRegistry.tsx` leads destination → LeadsRoute → `api.leads` → `src/preload/apis/leadsApi.ts` → validated `leads:list/update-field/bulk-update` → production `createLeadsProvider` in `src/main/ipc/registerApplicationIpc.ts` → `runtime.withDomain` → domain SQL/transactions.
- Actual Inbox boundary: registry inbox destination → ReviewRoute → `api.review` → `src/preload/apis/reviewApi.ts` → validated `review:list/resolve` → production `createReviewProvider` → same ready-domain gate. `reviewService.ts` delegates; it is not another authority.
- `registerValidatedIpc.ts` validates sender and schemas and supports optional fixed `safeErrorCode`. `src/preload/ipcClient.ts` parses successful responses and propagates invoke rejection. There is no shared cursor-error union. The exported `FounderSalesDomainErrorCode` union is in the main domain facade around lines 184-195.
- Root checkpoint has PresentationRoot above App's health branch, focusable main, and dirty OverlayProvider inside PresentationRoot. At planning read, LeadsBulkBar still had unconditional document Escape. Shared-presentation Task 3 owns its replacement; completion must be handed off, not assumed.

## Proposed public contracts and consistency

### Complete review metadata

Keep Leads public shapes, names and sort/filter semantics. Extend review request with `cursor: z.string().max(1024).nullable().optional()`; omitted/null is first page, new callers send it explicitly. Keep limit 1..200. Retain existing snapshot fields and add required fields:
```ts
type ReviewQueueAvailability =
  | { source: 'lifecycle_review_items'; openCount: number }
  | { source: 'not_integrated'; openCount: null };
type ReviewQueueCounts = Record<ReviewKind, ReviewQueueAvailability>;
// ReviewSnapshot additions:
// nextCursor: string|null; matchedCount: number; queues: ReviewQueueCounts;
// countScope: 'lifecycle_review_items'; observedAt: offset-aware ISO string.
```
Use strict schemas with all six keys explicit/required, safe nonnegative integer counts and source/null consistency. `totalOpenCount` counts all open lifecycle rows; `matchedCount` counts the entire selected-kinds result before paging. Unmatched/system counts use the same complete projection. The other four entries are not_integrated/null, never fabricated zero. Availability describes this Inbox integration, not provider configuration or health.

### Chosen cursor: full-projection snapshot fingerprint

Stateless fingerprint-guarded continuation is the only approved architecture. It deliberately costs O(N) projection/memory per page plus existing SQL ranking. This is not a speed claim; measure 208 and a larger bounded fictional fixture before release. No hidden result cap, snapshot cache, persistent revision or offset-only fallback.
```ts
type ListCursorErrorCode = 'LIST_CURSOR_INVALID' | 'LIST_CURSOR_STALE';
type ReadCursor = { v:1; scope:'leads'|'review'; queryHash:string;
  snapshotHash:string; index:number };
// New main-only src/main/domain/support/listCursor.ts:
export function pageFromSnapshot<T>(input: {
  scope:ReadCursor['scope']; queryKey:string; snapshotKey:string;
  rows:readonly T[]; cursor:string|null; limit:number;
}): {rows:T[]; nextCursor:string|null};
// Export ListCursorError with readonly code: ListCursorErrorCode.
```
- Encode strict JSON as base64url, max1024 characters. Reject invalid/noncanonical encoding, extra fields, wrong version/scope/query hash, unsafe/negative/out-of-range index, numeric legacy cursors and trailing junk. Changed snapshot is STALE; malformed/query mismatch is INVALID.
- SHA-256 deterministic JSON using existing Node crypto. Canonical query includes scope, exact search text, deduplicated/sorted stage/priority/kind filters, sort and limit. Do not trim away search semantics. Hashes are not authorization.
- Leads: execute complete ordered strict LeadRow projection, exclude revision/time from hash, derive total from rows.length, validate fingerprint then slice. Preserve every SQL ordering key, ranking calculation and cycle tie-break.
- Review: read all open source rows ordered created_at/id including version. Snapshot key includes ordered id/person/reason/payload/created_at/version plus availability version. Safely parse/classify before filtering; malformed JSON/object shape becomes safe system_error rather than disappearing. Compute all metadata from that classification before slicing the filtered array.
- Read projection/count/fingerprint/page in one synchronous deferred `database.raw.transaction(read)()` scope. Reuse an existing transaction snapshot; never nest BEGIN, use write UoW for reads, await inside a transaction or keep a transaction between UI requests.
- Helper must not import the facade. Facade extends its existing error union, catches helper ListCursorError and throws `new FounderSalesDomainError(error.code,error.code)`. No shared/wire error envelope. Renderer must not parse Electron strings or depend on preserved `.code`; errors use fixed safe copy.
- Mutation/order/membership changes reject continuation, including commits from another connection. `total_changes()` remains informational. Every load-more error offers Retry more and Refresh list; rows/checks/controls stay, labeled as the last loaded snapshot. A null-cursor restart recovers. This is not historical snapshot retention.

### Leads continuation and retained mutations

```ts
type LeadSaveResult = {status:'saved'} | {status:'failed'; message:string};
// onUpdateField(input:LeadFieldUpdateRequest):Promise<LeadSaveResult>
// onBulkSetOrganization(value:string|null):Promise<LeadSaveResult>
// LeadsBulkBar retains onSetOrganization(value:string|null):Promise<LeadSaveResult>
```
- Append returned cursor only for identical controls/current request generation, without duplicate IDs. Show Showing X of Y, Load more, loading/retry/refresh. Separate initial and append failures. Filter/query/sort change starts page1 and hides old-query counts while loading; retain checked IDs and focused person.
- Label `N selected (M outside this view)`. Submit exactly `{personIds:[...checkedPersonIds].sort(),field:'organization_label',value}`, captured once, never intersected with visible rows. Above200, no calls and retain input/checks: `Select 200 or fewer people for one update. No records submitted.` No chunking or pruning.
- Synchronous route-level ref lock precedes invoke; freeze IDs/value and disable other mutation, selection and Clear controls while pending. Inline and bulk cannot overlap. No automatic mutation retry.
- Route owns inline `{personId,field,personLabel,draft,status:'editing'|'pending'|'failed',error:string|null}` and bulk editor/draft/status above transient cells. Enter/blur do not discard draft; only confirmed success closes. Idle/failed Cancel may discard. Pending Escape/blur may not.
- Virtualization/filtering retains the session and exposes `Unfinished edit for <person>` recovery outside the grid, with explicit Resume/Cancel. No promise of persistence after leaving Leads in this F14 slice.
- Verify receipt affectedPersonIds set equals captured targets. Rejection/scope mismatch retains all intended work with `The change could not be confirmed. Your input is kept. Review the records before retrying.` Success clears only submitted checks/input and refreshes page1. Confirmed save plus refresh failure says `Saved; list refresh failed`, not mutation failed.
- Preserve inspector review-advance on loaded IDs. A known post-review snapshot change requires explicit Refresh list before Load more can resume; a loaded boundary is never an all-done claim. The bounded synchronous join below does not change inline/bulk selected-set, draft, receipt or pending rules.
- Preserve shared Task3 overlay guards for defaultPrevented/composing/repeated Escape and active overlays. Existing `useOverlayLayers()` exposes hasOpenLayer/hasModal under PresentationRoot/OverlayProvider. Do not add a provider/dispatcher. Pending guards supplement modal guards; palette/Import Escape cannot clear underlying selection/draft.

### Loaded-review boundary continuation

`LeadsRoute.tsx:74-104` currently refreshes page1 after every review and returns null for both a missing reviewed ID and the last loaded row. `useLeadInspector.ts:37-56` calls null end; `LeadInspectorProvider.tsx:251-269,318-354` consumes the currently registered resolver after mutation settlement. These are separate from Inbox review records. A review write changes the fingerprinted Leads projection, so an old cursor cannot continue that snapshot. Replacing208 loaded rows with page1 after each review would also break loaded200 ->201 ->202.

Keep the join synchronous and confined to the existing hook/provider plus Task2 Leads files:
```ts
// Existing src/renderer/features/leadInspector/useLeadInspector.ts
export type ReviewAdvanceResult =
  | {kind:'next';personId:string}
  | {kind:'return_to_list';returnFocus:()=>HTMLElement|null};
export type ReviewAdvanceResolver = (personId:string)=>ReviewAdvanceResult;
// Existing LeadInspectorHandle property, with token-owned cleanup:
setReviewAdvance(resolver:ReviewAdvanceResolver):()=>void;
```

- On an acknowledged Mark ready/Dismiss with a current owner, retain the already loaded order as last-read navigation evidence, mark it requiresReload, invalidate pending list-read generations and quarantine its old cursor. Do not automatically replace it with page1 or fetch an old-cursor page. Guard Load more/Retry more handlers as well as their controls. Show **List changed after a review decision. Loaded rows are from the previous read. Refresh list to update.** Counts say **Last loaded: X of Y**, not a current remaining count. Inline/bulk success still follows the unchanged page1-refresh rule above.
- Resolve the next distinct loaded person, preserve inspector/full-page view, and call existing `openWith(nextId,capturedView,true)` for synchronous ref/epoch bookkeeping and fresh detail. If no next person is loaded, return_to_list stores an owned notice and closes through closeLead: **Decision saved. No next person is loaded in this order. Refresh the list to continue.** If the reviewed ID is missing, use **Decision saved. The loaded order changed. Refresh the list to continue.** Neither observed200/208 nor208/208 proves all matching work was reviewed. Never return the reviewed ID, wrap to the first row or retain dismissed detail as a placeholder.
- Put **Refresh list** (`id="leads-refresh-list"`) and the notice in the stable LeadsPage status/control slot outside conditional grid/loading/error content. Clear only the reviewed single selection if still owned, never the checked Set or controlled inline/bulk draft. Explicit refresh uses current controls/cursor:null/limit200 once, retires old reads/window/registration and carries the boundary reason into the new request's status until success. Failure preserves the explanation and safe retry; success accepts the fresh cursor/counts. No automatic filter change, first-person open, mutation replay, async resolver, full-list prefetch, ordinal-continuation or exactly-once traversal claim. Generic unknown append failures still offer Retry more + Refresh list.
- Register through the stable `inspector?.setReviewAdvance` setter, API identity, stable canonical controls key and browse/window epoch. Never depend on the whole inspector handle, row-array identity or rows.length. Read live loaded rows through refs. Token-specific disposal cannot clear a newer registration. Explicit user browse/refresh resets its epoch, but the resolver's programmatic next-row selection does not. Guard current route ownership synchronously, not only in later effect cleanup.
- Before invoking a review API capture API/person/cycle/selectionEpoch/view/resolver entry. Only a still-mounted identical action owner can affect selection after settlement, and it may invoke only its captured, still-current registration. Late A results cannot affect B, a reopened A, a replacement API or a new route. Without the captured resolver, preserve distinct fallbacks for a still-owned selection: Mark ready refreshes its current detail; Dismiss closes it. Pending/rejected commands do not report saved or advance. Domain/request/receipt semantics remain unchanged.
- Focus uses the existing nonmodal layer behavior, not a new focus policy. Both presentations receive a read-through callback from their first render: `() => boundaryReturnFocus.current?.() ?? focusOrigin.current`. Set the provider ref to result.returnFocus synchronously before closeLead. Keep it through selection-null render and outgoing cleanup, then reset only on the next openWith. The route getter reads current owner/notice refs and the committed stable button, never a prior render's null notice or an unrelated reused ID. If focus belongs to the closing inspector, existing cleanup can restore Refresh list. If it already moved to a connected underlay control or palette/Import, preserve that focus. No state-only/new-render callback, closeLead ref clearing, flushSync, focus timer, overlay predicate edit or new listener.

Required acceptance includes loaded199 ->200 and loaded200 ->201 ->202; boundary200/208 and208/208 without old-cursor requests or all-done copy; explicit null restart and failed refresh retaining checks/drafts; missing-current-ID; late first/append and selection/API/route/reset races; token cleanup versus replacement/StrictMode; stable-setter versus whole-handle/row-count rerenders; and actual provider plus real layer cleanup in both presentations. Focus tests start inside the submitting inspector, then separately move focus to an underlay or modal while pending. Test new openWith before cleanup and a departed getter returning null. A directly invoked getter stub is not cleanup evidence. Preserve accepted R4/overlay behavior and use the existing public registrar/domain path for mutation/cursor recovery proof.

### Inbox and startup summary

```ts
type ReviewBadgeState = {status:'loading'} | {status:'failed'}
  | {status:'ready'; count:number; observedAt:string};
// useReviewSummary(api:ReviewApi) -> {state:ReviewBadgeState;
//   refresh():void; begin():ReviewObservationToken;
//   accept(snapshot:ReviewSnapshot,token:ReviewObservationToken):void;
//   fail(token:ReviewObservationToken):void}
type ReviewObservationToken = symbol; // exported by useReviewSummary.ts
// RouteContext and ReviewRouteProps:
//   onReviewRequestStart():ReviewObservationToken
//   onReviewRequestFailed(token:ReviewObservationToken):void
//   onReviewSnapshot(snapshot:ReviewSnapshot,token:ReviewObservationToken):void
//   onReviewResolved():void
// replaces onReviewCountChange. AppShell/NavigationRail retain prop name reviewCount,
// now ReviewBadgeState rather than number.
```
- Selected tab requests `{kinds:[selectedKind],cursor:null,limit:200}`; continuation keeps filter. Tabs/header/system alert use complete metadata, never loaded lengths. System alert provides View system errors, not a partial list claiming completeness.
- Unsupported tabs remain reachable as `Not available in this Inbox`, not numeric zero. Header/badge say `N open local reviews`, disclose unavailable sources and observation time. No adapter-health claim or provider contact.
- Mount the summary owner in FounderWorkspace, including before Inbox is visited: request `{kinds:[],cursor:null,limit:1}` on healthy workspace mount, distinct route entry, focus/import completion and successful resolution. Before every page or summary read, `begin()` allocates the same owner's new symbol token. Capture callbacks/token at request start. Only the latest token of an active owner may settle through `accept(snapshot,token)` or `fail(token)`; completion never advances ownership. Begin is legal before the parent effect activates, but settlement is not. Cleanup invalidates tokens. No observedAt/revision ordering, new IPC, extra read trigger or root/startup-lifetime change.
- ReviewRoute keeps an independent request generation for page/append rendering. A current page may render even when a later-started summary owns the badge. Current-page rejection publishes its exact failure token, making the badge unavailable only if that token still owns it; obsolete page success/failure publishes nothing. FounderWorkspace passes summary.begin/fail/accept/refresh through onReviewRequestStart/onReviewRequestFailed/onReviewSnapshot/onReviewResolved respectively. Initial Inbox child page may start before the parent summary, and successful resolution starts a summary then the selected reload. Do not assume completion order or parent-before-child effects.
- This amendment aligns with current R2 source (`useReviewSummary.ts:7-45`, `ReviewRoute.tsx:14-21,40-69,78-119`, `FounderApp.tsx:41-49,73-76,89-92`, `routeRegistry.tsx:23-33,78-86`) and the bounded r2-grant/final-report. At the preparation checkpoint **2026-09-10 05:24 UTC**, R2 was source-frozen for parent verification. This historical statement does not assert its status after a later parent acceptance/commit. Preserve actual composition tests with independent deferred requests, both completion orders, old rejection, latest failure, child-before-parent/StrictMode, identical observedAt, exact token settlement and unchanged read counts. Replace the superseded shared-deferred/completion-time acceptance assertion, not the stale-result protections.
- Loading/failed summary is neutral visible/accessibility state, never numeric zero or unlabeled stale count. Metadata is observed, not a live health monitor.
- Preserve supported Promote request/CAS. Resolution starts a fresh generation, keeps selected kind and clears detail only if its record disappeared. Key detail by reviewId so pagination cannot transfer state to another record.

## Three-task ownership and handoffs

The [execution plan](../plans/2026-09-10-list-reliability-repair.md) is the exact file-ownership ledger; these boundaries are mandatory, not permission to touch active files.
1. **Task1:** snapshot-safe Leads backend plus strict review contract/Inbox/startup integration and their explicitly listed tests. Starts after parent releases shell/presentation and frozen Inbox paths. Parent retains three browser-fixture paths and locked acceptance metadata until escrow integration. No Leads renderer, root, CSS or overlay implementation.
2. **Task2:** Leads paging, exact mutations and input retention in the listed Leads files, plus only the bounded synchronous loaded-review join in `src/renderer/features/leadInspector/{useLeadInspector.ts,LeadInspectorProvider.tsx,LeadInspectorProvider.test.tsx}`. Depends on Task1, H2 bulk-bar handoff and the plan's H4 exact inspector handoff. No domain/Inbox-review/shell/overlay/CSS ownership or additional inspector presentation edits. The full provider test suite is known native/domain and parent-only; any worker pure exclusion requires a separate explicit lease.
3. **Task3:** new actual-public-route/domain acceptance fixture/test and packaged workflow spec, plus only the obsolete zero-badge assertion in founderWorkflow. No production ownership. Parent owns package.json/release wiring and all native/browser/package runs.

**Accepted dispositions:** B1 main union/helper errors, not wire. B2 strict metadata with parent escrow. B3 bulk-bar test grant only after shared Task3. B4 O(N) bounded fictional benchmark, no speed claim. B5 unsupported-kind DTO tests are synthetic branch coverage, not integration. B6 parent package wiring. B7 nonempty208-review acceptance through actual public-route/domain composition, not a packaged fake hook.
**Re-inventory at handoff:** all strict snapshot/badge consumers are listed in the plan. Newly discovered consumers block ownership until parent disposition; never weaken schemas or silently assign arbitrary paths. Unrelated LeadDetail transcript reviewCount stays unchanged.

## Regression-first acceptance and limits

- F05: seed205 of one mapped kind then3 of the other, also reverse order; filter the later kind immediately, walk all208 IDs once, verify complete counts/ties/limits/malformed-payload safety and unchanged retained source records. Startup badge208 on Today precedes Inbox. Reject stale/out-of-order replies; failed reads never imply zero; four sources remain unavailable and unsupported actions absent.
- F06:208 Leads across all sorts/filters; mutation including second-connection commit invalidates old cursor, restart walks exact membership. Actual grid loads final8, keyboard reaches/opens row208. No silent truncation or mixed generations.
- F07: selected IDs spanning pages/filters equal payload, receipt and persisted changed set; nonselected rows unchanged. >200 submits nothing explicitly. Missing receipt ID retains work.
- Leads F14: deferred failure proves one invocation under Enter/blur/repeat/other controls, same inline/bulk input retained through rejection/virtualization, safe error and explicit retry. Save/refresh distinction and actual overlay Escape preserve work.
- Actual public join uses encrypted fictional DB, production providers, validated registrars, preload APIs and actual FounderApp/routeRegistry under PresentationRoot. Label only the in-process Electron transport seam; do not mock list/mutation results or claim a fake readiness gate proves authority.
- Parent packaged acceptance uses launchFounderWorkspace and CSV UI208 Leads, real navigation/overlays, persisted public readback and clean Inbox source-aware empty states. No general packaged lifecycle seeder exists; nonempty208-review startup is public-domain route coverage, not a packaged claim or permission for a production seed hook.
- At the preparation checkpoint **2026-09-10 05:24 UTC**, Task1 R2 source was frozen for parent verification. This amendment does not certify reported worker RED/GREEN or mark parent mixed/browser/independent acceptance complete. Task2/Task3 behavioral checks and their later joins remain required after explicit handoff. Blocked package checks stay open. Preserve existing Node24.20.0/ABI137 and authority/data. If full-projection cost is unacceptable, stop for approved redesign, not an unauthorized fallback.
