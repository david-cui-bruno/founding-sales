# Workspace Continuity Repair Implementation Plan

> **For agentic workers:** use the executing-plans workflow only after parent GO. Exactly one implementation worker at a time. Parent controls source handoffs, native/browser/package resources, independent review and commits. This plan is docs-only preparation, not permission to implement now. No duplicate user design approval is required.

**Goal:** repair F11/F15/F16 and Friday F14, retire stale Settings shortcut copy, and consolidate F18 without losing in-session work, overstating health/counts, changing authority or damaging retained data.
**Architecture:** lift the existing company state machine into a workspace memory owner with transient view bindings; retain ready UI during readonly health refresh; add a cleanup-ordered fatal-startup dialog; separate local commitments from worker counts. Prove the shipped provider mappings/readiness boundary before removing nine test-only adapter bodies.
**Tech Stack:** existing TypeScript/React, strict Zod IPC contracts, Electron, encrypted synchronous SQLite, Vitest and parent-run Playwright. No new dependency.
**Spec:** [Workspace continuity specification](../specs/2026-09-10-workspace-continuity-repair.md). Also read the [program](../2026-09-10-product-repair-program.md), [audit](../../engineering/2026-09-10-adversarial-product-audit.md), [shared-presentation plan](2026-09-10-shared-presentation-repair.md), and [list-reliability plan](2026-09-10-list-reliability-repair.md).

### Pre-correction freeze archive, 2026-09-10 04:36 UTC

The 04:34 coordinator amendment corrects F15 cleanup provenance only. These SHA-256 values were read before this two-document correction and preserve the prior freeze, not the current contents or implementation acceptance. No separate archive file is created outside the two-document grant.

| Previous document | Prechange SHA-256 |
| --- | --- |
| `docs/superpowers/specs/2026-09-10-workspace-continuity-repair.md` | `18fc17d292801dc17ff82f465311dcb905086b6446438869fa5141648ca3f115` |
| `docs/superpowers/plans/2026-09-10-workspace-continuity-repair.md` | `899e8a19be0a0bc5410fc0234f8f596864ae5e5f288658d81b00dbd70534082f` |

**Second bounded amendment, 04:40 UTC:** preserve partial/last-known count qualifications during pending refresh and reference the accepted live R4 handoff. The completed F15 correction is unchanged. Before this amendment, the spec SHA-256 was `0bd74d65d8230ab9989413ad8b99167106e93d0f1add868832403e4273b0580c` and plan SHA-256 was `9651864eadff612a1315edbee3b687de84eb85d8fc4e31244b1cdfc66a55aae9`. These are prior-freeze evidence, not hashes of the amended documents.

## Global constraints and handoffs

- Preserve stable PresentationRoot/OverlayProvider, native modality, Native appearance/preferences, editor identity, pending fences, domain/receipt/identity/authority/recovery checks and all retained obligations.
- Preserve accepted live R4 (`NativeDeskRoute.tsx:235-250`): retained workflow-mode evidence keeps established legacy composition at a stable fragment position, Workspace status remains a sibling, and read-held admission independently prohibits new writes. Do not substitute a fresh-read-only branch or reparent pending forms. The accepted R4 handoff controls implementation.
- No Offline mode, security framework, public schema/profile/key change, generic command cache, rollback, data deletion, provider activation, grants, sends/calls, installation, push or deployment. No crash/disk continuity claim.
- Every future npm/npx invocation starts with `export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"`. Keep Node24.20.0/ABI137. No native rebuild to cure a failing test.
- Parent alone schedules native/browser/Swift/build/package/app/profile/provider work and all commits. Behavioral tasks require maintained RED, observed failure, minimal implementation, focused GREEN, exact-path freeze and independent review. Future recipes below are not planner executions.
- **C1 before Task1:** shared-presentation Task3 releases NativeDeskRoute with its accepted live R4 repair, associated local/modal tests and integration points. List-reliability Task1 releases FounderApp/FounderApp.test and parent acceptance fixtures. Preserve its startup review summary and refresh triggers.
- **C2 before Task2:** parent releases App/App.lifecycle, routeRegistry and Settings/diagnostics consumers after prior root, modal and reliability acceptance. Reuse Task1's owner, not another independent state machine.
- **C3 before Task4:** all list-reliability tasks and F01 organization assignment acceptance land, including their integration-test edits. Modal owner releases LeadInspectorProvider.test.tsx. Parent explicitly accepts baseline-GREEN/before-after equivalence for behavior-preserving F18 deletion.
- **C4 frozen parent escrow:** `tests/fixtures/{applicationPresentationBrowser.tsx,applicationModalScenario.ts,startupPresentationBrowser.tsx,nativeDeskBrowser.tsx,nativeDeskCompositionBrowser.tsx}`, `tests/browser/{applicationPresentation.spec.ts,applicationModals.spec.ts,startupPresentation.spec.ts,nativeDesk.spec.ts}`, `tests/support/presentationOracle.ts`, and maintained package/release wiring. Workers supply exact changes, never edit these frozen files to make tests pass.
- **Friday handoff before Task3:** parent grants only the Friday renderer/test paths below after current modal work finishes. No modal/reliability task owns this F14 slice. Its later integration suite `tests/integration/fridayService.test.ts` remains reserved for Task4's adapter migration, and real Friday UI persistence belongs to Task5.
- `tests/renderer/noMachineEnums.test.tsx` is shared with modal callback migration and reliability strict metadata. Keep it read-only here. Parent integrates any necessary display/fixture adaptation after those owners finish. Do not widen this repair into its Today/Leads callback contracts.
- The exact task file ledgers below are prospective grants, not permission to touch active files. New consumers require coordinator disposition. No worker modifies CSS, overlay helpers, main initialization/key/recovery implementations, domain behavior or public DTOs.

## Frozen interfaces

```ts
// Task1, new src/renderer/features/today/LocalCompanyIntakeProvider.tsx
type IntakeApi = Pick<LocalWorkspaceApi,
  'reviewCompany' | 'createCompany' | 'getCompanyCreateStatus'>;
// LocalCompanyIntakeProvider({api, children}: {api?: IntakeApi; children: ReactNode})
// Existing useLocalCompanyIntake(options: LocalCompanyIntakeOptions)
// and LocalCompanyIntakeController retain their public call shape.
type IntakeView = Pick<LocalCompanyIntakeOptions,
  'available' | 'localRead' | 'onOpenAccount' | 'onRefreshLocal'>;
// Internal bindView(view: IntakeView): () => void, cleanup owns one view token.

// Task1, new visibleCount.ts
export type VisibleCount =
  | {kind:'known'; value:number} | {kind:'unavailable'}
  | {kind:'partial'; value:number} | {kind:'last_known'; value:number}
  | {kind:'checking'; value:number|null};
export function formatVisibleCount(count: VisibleCount): string;
// Source selection preserves partial/last_known before considering pending.
// Checking: no prior value. N · checking: only prior complete non-stale evidence.

// Task2, exported by existing useFoundationHealth.ts
export type HealthObservation = {
  checkedAt:string|null; refreshing:boolean; refreshFailed:boolean;
};
// FoundationHealth, DiagnosticsScreenProps and SettingsScreenProps add
// observation?: HealthObservation. Production hook always supplies it.
// Existing health.get():Promise<AppHealth> and retry():void remain unchanged.

// Task3, exported by FridayRoute.tsx for the Page/Form type-only imports
export type FridayIntent =
  | {kind:'create'; input:CreateJobRequest}
  | {kind:'fill'; input:FillJobRequest}
  | {kind:'cancel'; input:CancelJobRequest};
export type FridayMutationView = {status:'idle'} | {
  status:'pending'|'unconfirmed'|'saved'; intent:FridayIntent; message:string|null;
};
export type FridaySaveResult =
  | {status:'saved'} | {status:'unconfirmed'; message:string}
  | {status:'not_started'};
// onCreateJob(CreateJobRequest), onFillJob(FillJobRequest),
// onCancelJob(CancelJobRequest) each return Promise<FridaySaveResult>.
// FridayPage/JobRequestForm additionally require mutation:FridayMutationView,
// onRetryMutation():Promise<FridaySaveResult>,
// onRefreshJobs():Promise<FridaySaveResult>. Route owns error/outcome state.
// ScoreboardHeaderProps adds disabled?:boolean, default false.
// Route invokes a ()=>Promise<MutationReceipt> only after its ref lock.

// Task2, new src/main/startupFailureDialog.ts
export function showStartupFailureDialog(input: {
  canRestart:boolean;
}): Promise<'quit'|'restart'>;
```

No new public command/receipt, workspace identity, startup retry IPC or health source is introduced. Optional renderer observation metadata preserves injected callers, but missing metadata must be displayed as unavailable, never fresh.

## Task1: Workspace company continuity and truthful lanes (F11/F16)

**Depends on C1.** One worker, no root/domain/API/CSS ownership.

**Production files:** modify `src/renderer/app/FounderApp.tsx`; modify `src/renderer/features/today/{LocalCompanyIntake.tsx,NativeDeskRoute.tsx,RetainedWork.tsx}`; create `src/renderer/features/today/{LocalCompanyIntakeProvider.tsx,visibleCount.ts}`.
**Tests:** modify `src/renderer/app/FounderApp.test.tsx`; modify `src/renderer/features/today/{LocalCompanyIntake.test.tsx,NativeDeskRoute.test.tsx,LocalWorkspace.test.tsx,ActualAComposition.test.tsx}`; create `src/renderer/features/today/{LocalCompanyIntakeProvider.test.tsx,visibleCount.test.ts}`. Run existing NativeDeskPresentation/Navigation tests unchanged unless parent grants an actual required assertion migration.
**Consumes:** stable `api.localWorkspace`, existing controller/state machine, local read availability, accepted R4 holds and shared modal guards.
**Produces:** provider-backed in-session owner, same form controller and command payloads, pure count formatter, separate Local commitments/worker lanes.

- [ ] **1. Add real-route RED before moving state.** Extend FounderApp's complete typed API harness under PresentationRoot and real routeRegistry. Open actual Accounts, type name/domain, navigate Campaigns then Leads then Accounts using real navigation. Assert same open form/fields/review. Repeat during reviewing, creating, unknown and conflict. Exercise Import's real committed callback/refreshKey path with its explicit fixture grant and assert no intake replay. Keep native Import producer/listener coverage.
- [ ] **2. Add owner/view RED.** Wrap the current controller in the new provider test boundary. Detach only the Accounts view while a deferred create is pending; returning must expose the same request and phase. Advance the existing15-second deadline while away, then explicitly Check save status. Assert exact `{commandId,name,domain}` equality for create/status/retry, `not_recorded` remains unknown, double actions invoke once, and saved-while-away never calls departed navigation/refresh. A stale old-API response cannot update a replacement owner. Test matching nested providers and StrictMode cleanup so there is one effective owner.
- [ ] **3. Add lane/count RED and replace contradictory assertions.** Seed all six retained kinds with unique strict cycle/action IDs and mixed call/email/internal actions. Assert each returned key is in Local commitments and none is counted in worker Calls. Replace `LocalWorkspace.test.tsx:36-45` retained-inside-Calls and all-lanes-Unavailable assertions with source-scoped expectations. Replace `ActualAComposition.test.tsx:153-161` combined Calls matrix with independent local and worker matrices, including known0, partial0, stale0/positive, checking and missing scope. Add actual read-to-count cases for partial+pending and stale+pending, including zero, so a pending-first projection cannot pass by testing only preselected formatter variants. Preserve every no-command, stale-detail, selection/caret, scope mismatch, accepted live R4 ancestor-retention and keyboard assertion.
- [ ] **4. Observe focused behavioral RED under parent lease.** Missing provider exports/type errors alone do not establish the navigation or count bug. Add the regression against existing composition first, record its behavioral failure, then implement the new boundary. Parent records native/pure import-graph classification before running tests.
- [ ] **5. Implement one owner and bind views.** Move existing Owner/FormState/submit logic once. Provider identity is exact localWorkspace API, never route/worker workspace/revision. Matching nested provider delegates to its parent. The hook uses that owner when matched, and the same implementation with current local lifetime for an isolated no-provider caller. Only `local-company:accounts` attaches a production view. Token cleanup cannot detach a newer binding. Owner settlement is independent of view lifetime; new actions require the current eligible binding. Keep all receipt/status checks, original deadline, busy fence, locked Close and deliberate retry. Saved-while-unbound stores state only.
- [ ] **6. Implement source-specific counts with unchanged detail/authority.** Local commitments precede worker Calls and retain key order. Keep existing LocalOnlyCalls export for compatibility, but change its visible semantics to Local commitments and unavailable worker sections. Worker account/campaign headings become Worker accounts/Worker campaigns. Do not change DailyAnswers, meeting UI, local account library, owner checks or localHold. Retain the VisibleCount union exactly. For a retained local value, error/last-known wins first, positive reviewErrorCount/partial wins next, pending/checking comes only after those, then known. No value is Checking only while pending, otherwise Unavailable. Worker missing/mismatched scope still wins as Unavailable; same-scope retained stale or incomplete evidence likewise wins over any existing pending indicator. No new worker pending API, wider union or composite-status framework. Keep existing refresh/incomplete-source status text separately. Formatter outputs are exact:

```ts
expect(formatVisibleCount({kind:'known', value:0})).toBe('0');
expect(formatVisibleCount({kind:'unavailable'})).toBe('Unavailable');
expect(formatVisibleCount({kind:'partial', value:0})).toBe('0+ · partial');
expect(formatVisibleCount({kind:'last_known', value:2})).toBe('2 · last known');
expect(formatVisibleCount({kind:'checking', value:null})).toBe('Checking');
expect(formatVisibleCount({kind:'checking', value:2})).toBe('2 · checking');
```

In the already-owned `LocalWorkspace.test.tsx`/`ActualAComposition.test.tsx` and NativeDeskRoute cases, drive the real retained-read projection through refresh (`localWorkspaceRead.ts:13` preserves prior value/error). `visibleCount.test.ts` verifies the exact selected-variant strings but is not a substitute for these precedence cases:

| Retained evidence while pending | Expected count |
| --- | --- |
| No prior value, valid local source | `Checking` |
| Complete, non-stale count2 | `2 · checking` |
| Partial count2, reviewErrorCount > 0, no read error | `2+ · partial` |
| Last-known count2 after read error | `2 · last known` |
| Partial count0, no read error | `0+ · partial` |
| Last-known count0 after read error | `0 · last known` |

For worker counts exercise the same precedence wherever an existing pending indication is available, retaining scope-first Unavailable and separate local/worker totals. Assert that pending refresh neither drops commitments nor relaxes action holds. No production read-hook change or additional file grant is implied.

- [ ] **7. GREEN, exact freeze and independent review.** Verify no remount create/status/review and no old binding callback. Verify keyboard crosses Local commitments -> Calls and Close details returns to the exact retained key. Parent integrates frozen copy/read expectations and performs typecheck/owned lint. Supply exact hashes and limits for parent commit, not a worker commit or F11/F16 closure claim before Task5.

**Future focused candidate recipe, only after parent classifies imports and leases the run:**
```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"
npx vitest run src/renderer/features/today/LocalCompanyIntake.test.tsx src/renderer/features/today/LocalCompanyIntakeProvider.test.tsx src/renderer/features/today/visibleCount.test.ts src/renderer/features/today/LocalWorkspace.test.tsx src/renderer/features/today/ActualAComposition.test.tsx src/renderer/features/today/NativeDeskRoute.test.tsx src/renderer/app/FounderApp.test.tsx --maxWorkers=1 --minWorkers=1
```

## Task2: Readonly observation and cleanup-ordered fatal startup (F15)

**Depends on Task1 and C2.** One worker. No FoundationRuntime/DomainRuntime/startApplication production changes, public health schema changes or recovery behavior changes.

**Production:** modify `src/main.ts`; create `src/main/startupFailureDialog.ts`; modify `src/renderer/App.tsx`, `src/renderer/app/routeRegistry.tsx`, `src/renderer/foundation/{useFoundationHealth.ts,DiagnosticsScreen.tsx,SettingsScreen.tsx}`.
**Tests:** modify `src/renderer/{App.test.tsx,App.lifecycle.test.tsx}`, `src/renderer/foundation/SettingsScreen.test.tsx`; create `src/renderer/foundation/useFoundationHealth.test.tsx`, `tests/main/startupFailureDialog.test.ts`; modify `tests/main/{main.test.ts,startApplication.test.ts,foundationRuntime.test.ts,healthService.test.ts}`. Keep the native-backed foundation/startApplication/health suites in a separate parent job, not an assumed pure UI run.
**Consumes:** Task1 matching provider, existing AppHealth and recovery API, current startup shutdown/cancellation guarantees.
**Produces:** renderer observation metadata and preserved ready subtree, blocked admission, fixed safe fatal dialog. No reinitialization function.

- [ ] **1. Add refresh/admission RED.** Start real App with valid ready health and an open intake or Native requested-email editor. Trigger manual/focus/visible60-second refresh with delayed/rejected/hung health reads. Assert the same editor node/text/caret during refresh, prior checkedAt retained on failure, and fixed stale/read-failure copy. Hidden-document ticks make no reads; a current flight is deduplicated;15-second expiry ignores later response. Replace API and prove old health cannot admit the new workspace. Actual blocked/inconsistent health never mounts normal routes. Ready -> blocked preserves the company owner but removes feature effects.
- [ ] **2. Add truthful-copy and shortcut RED.** Replace App.test.tsx:60-71/Settings failure expectations with diagnostic-fetch failure, not database-open failure. Keep secret/path sentinels absent. Test Sourcing monitor degraded, healthy-but-never-completed and completed cases, observation timestamp versus immutable startup evaluatedAt, and absent injected observation. Preserve preference/settings navigation and successful structured-health data checks. In SettingsScreen.test assert E/H/P is absent, Inbox replaces Review in the numeric-menu list, and shortcut sections explicitly distinguish Legacy Today rows, Native Desk rows, Leads rows and application-menu commands. Trace source to TodayPage:30-44, accepted R4 NativeDeskRoute keyboard and applicationMenu:58-66,83-88. No mode-read API or keyboard dispatcher is introduced.
- [ ] **3. Add startup orchestration RED.** Use current main/startApplication test dependency seams, not a production failure switch. Keep raw-startup failure and post-success orchestration failure as distinct maintained scenarios:
  - In `startApplication.test.ts`, retain/add delayed cleanup on key/open/init/window failure, rejection only after cleanup settles, cleanup failure surfaced as AggregateError, abort handling and repeated-shutdown resource disposal. In `main.test.ts`, assert that raw rejection reaches the dialog only after that boundary settles. A raw AggregateError or failure before raw startup is established is Quit-only. Never use the outer chain's exception type as a cleanup proxy.
  - Add `main.test.ts` coverage where raw startup succeeds and returns an owned application, then the real `installDockBadge` path calls a throwing `app.dock.setBadge`. Extend the existing Electron mock with explicit dock/relaunch/dialog controls and a test-only restored platform seam if needed. Do not replace this case with `startApplication.mockRejectedValue`. Supply a deferred owned shutdown and assert exactly one shutdown call and zero dialog, quit or relaunch calls while it is pending.
  - Resolve that shutdown and assert the fixed dialog appears only afterward. Explicit Restart calls relaunch once, then quits once without another shutdown. In a separate case reject shutdown with an ordinary Error and assert the later dialog offers Quit only, never Restart. This must fail an implementation that classifies cleanup from the non-AggregateError outer failure or merely starts cleanup without awaiting it.
  - During that same deferred shutdown invoke before-quit repeatedly. It prevents early quit, joins the same shutdown, and after settlement quits once without dialog/relaunch. Also cover intentional abort before raw startup settles, fulfillment after abort, quit while the dialog is pending, and repeated terminal events. No normal-quit path waits for a user dialog to settle or double-shuts down.
  - Replace `main.test.ts:501-560` automatic-quit-on-renderer-load-failure assertion with ordered window destruction/unregister/close, then dialog and explicit/default Quit. Preserve the existing pending-startup before-quit assertions at425-499. Keep installer/single-instance/backup-host suppression. Test default/cancel Quit, raw error/path/key sentinel redaction, and safe quit on dialog rejection only after the cleanup barrier.
- [ ] **4. Observe behavioral RED then implement the hook/root.** Retain last successful health while observation changes. On API replacement synchronously derive loading rather than momentarily displaying another API's old ready state. One generation-bound logical flight, visible60-second interval, focus/manual refresh and15-second deadline. Cleanup invalidates replies/timers without asserting IPC cancellation. Render the existing tree at a stable position:

```tsx
<PresentationRoot>
  <LocalCompanyIntakeProvider api={window.callie.localWorkspace}>
    {health.status === 'ready' && health.health.domainReady &&
      health.health.domainStatus === 'ready'
      ? <FounderApp api={window.callie} health={health} theme={theme} density={density} />
      : <DiagnosticsScreen state={diagnosticsState} observation={health.observation} onRetry={health.retry} />}
  </LocalCompanyIntakeProvider>
</PresentationRoot>
```

`diagnosticsState` is the current `health.status` projection, retaining the successful blocked health object for its structured blocked explanation. Put the nonmodal observation banner in App as an always-positioned sibling of this content slot, never wrap/re-key/reparent a live editor on refresh. Task2 does not reacquire FounderApp. Existing matching FounderApp provider reuses this outer owner. Pass observation through routeRegistry to Settings. Use existing RecoverySection only for an initialized blocked foundation, without automatic export/restore-drill or claims of repair. Replace stale shortcut copy in SettingsScreen with scoped, source-confirmed instructions: Legacy S snoozes until tomorrow09:00 local and X skips today; Native J/K/arrows/Enter/Escape are queue/detail-only; editing fields and higher layers own keys; numeric menu shortcuts remain the actual seven legacy destinations, not invented Accounts/Campaigns bindings.
- [ ] **5. Implement fatal dialog and keep lifecycle actions in main.** Electron message-box options are fixed, with buttons `['Quit','Restart Callie']` when canRestart and `['Quit']` otherwise, defaultId/cancelId0, noLink true, fixed title/code/startup-failure detail. The helper maps only allowed response1 to restart. Keep the following ownership decisions inside `src/main.ts`, with no new lifecycle service or production initializer changes:
  - Separate the raw `startApplication(...)` result/provenance from its subsequent adoption/setup chain (`main.ts:257-266`). A raw non-AggregateError rejection has confirmed cleanup only because the raw function awaits its own shutdown before rejecting. A raw AggregateError is conservatively unconfirmed. Pre-raw-start failure is Quit-only. Do not inspect nested causes or use `startupPromise !== undefined` as proof of cleanup.
  - After raw fulfillment, main owns the returned application. A post-success failure sets applicationStarted false and claims/detaches the owned application before awaiting shutdown. Preserve one main-owned shutdown Promise/outcome, reachable after `runningApplication` is cleared, and share it with before-quit and abort-after-fulfillment. Only resolved shutdown means confirmed cleanup. Rejection means cleanup-unconfirmed, not successful cleanup and not an invitation to retry shutdown.
  - Await actual cleanup settlement before invoking the fatal dialog, setting allowQuit, quitting or offering restart. While pending, repeated before-quit joins the owned shutdown Promise, not the fatal-dialog Promise or an outer chain containing user choice. Preserve normal pending-startup cancellation by awaiting the raw startup/cleanup path when no application has yet been returned. Prevent the outer catch from taking an early auto-quit shortcut.
  - After cleanup, suppress the dialog if quit/abort already owns termination. If cleanup rejected, offer Quit only. Recheck quit/abort and the confirmed-cleanup/explicit-choice conditions after the dialog resolves. Route completion through a once-only relaunch/quit guard so concurrent/repeated events cannot restart late, quit twice or shutdown twice. Dialog rejection follows the same cleanup-complete Quit path. Do not loop startApplication or change key/recovery services.
- [ ] **6. Verify public health semantics and GREEN.** Real initialized FoundationRuntime plus production HealthService observes changed sourcing state without repeating key/open/migration/startup audit. Blocked withDomain still rejects. Separate readiness/cleanup native suites from component tests. Parent integrates frozen fixture health call inventories, tests actual root/modal continuity and performs typecheck/lint. Freeze exact paths for independent review and parent commit.

**Future UI-focused candidate recipe:**
```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"
npx vitest run src/renderer/foundation/useFoundationHealth.test.tsx src/renderer/foundation/SettingsScreen.test.tsx src/renderer/App.test.tsx src/renderer/App.lifecycle.test.tsx --maxWorkers=1 --minWorkers=1
```
**Separate parent-owned startup/native gate:**
```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"
npx vitest run tests/main/startupFailureDialog.test.ts tests/main/main.test.ts tests/main/startApplication.test.ts tests/main/foundationRuntime.test.ts tests/main/healthService.test.ts --maxWorkers=1 --minWorkers=1
```

## Task3: Friday job mutation and input retention (Friday F14)

**Depends on Tasks1-2 and the Friday handoff.** One bounded renderer worker. No domain, public schema, service, CSS, global navigation or new modal ownership. This is the audit's still-unassigned Friday slice, not closure of all F14.

**Production:** modify `src/renderer/features/friday/{FridayRoute.tsx,FridayPage.tsx,JobRequestForm.tsx,ScoreboardHeader.tsx}`. Optional extraction only at `src/renderer/features/friday/useFridayMutations.ts`, with FridaySaveResult still exported by FridayRoute for stable type-only consumers.
**Tests:** modify `src/renderer/features/friday/{FridayPage.test.tsx,FridayRoute.test.tsx}`; create `src/renderer/features/friday/FridayMutationRetention.test.tsx`. Parent retains `applicationModalScenario.ts`/applicationPresentationBrowser/browser specs. Existing Friday service/integration and registrar tests remain read-only until Task4.
**Consumes:** existing FridayApi and strict CreateJobRequest/FillJobRequest/CancelJobRequest/MutationReceipt, current inline fill UI and global modal behavior.
**Produces:** the frozen FridayIntent/FridayMutationView/FridaySaveResult types and Page/Form mutation/retry/refresh props, route-level captured operation/ref admission fence, retained fields and honest acknowledged-save/report-error states. Route owns mutation/error state; JobRequestForm owns raw date/time/cycle fields and clears only matching captured fields after saved acknowledgement or exact readback. Header disabled combines pending/held state with existing week bounds.

- [ ] **1. Add create/fill/cancel behavioral RED.** Using real FridayRoute and deferred typed API promises, enter Requested date/time and optional Won sales cycle, submit repeatedly by button/Enter, then attempt Fill/Cancel/week controls. Assert only one API invocation, same raw fields and original jobId/requestedAt. Repeat fill with exact jobId/accepted date/time, then reject and assert retained fields and fixed unconfirmed copy. Cancel rejection retains the exact job row/ID. An unresolved Promise does not unlock controls or time out into a resubmission.
- [ ] **2. Add outcome/readback RED.** A rejected command causes no automatic report refresh that conceals failure. Explicit Retry uses the same frozen input; Refresh jobs only calls getCurrent. Missing/contradictory readback keeps unknown state. Matching create fields, filled acceptance timestamp or cancelled status reconcile only that held job. Receipt success plus getCurrent rejection leaves the accepted operation acknowledged, clears only submitted fields and shows Saved; scoreboard refresh failed. Test that Retry report cannot repeat the mutation. Current-week API input stays undefined, not an invented request shape.
- [ ] **3. Preserve inline semantics and modal underlay.** Current `.friday-jobs__confirm` is an in-flow flex panel, so replace the misleading alertdialog role with a labeled group while keeping layout and fields. Keep requested dismisses only idle pre-submit input. Pending/unconfirmed prevents Keep requested, switching fill target and competing mutation. No focus trap/layer registration or document Escape listener is added. Under real PresentationRoot, palette/Import Escape preserves Friday fields/selection. Parent validates native modal isolation rather than asserting that a role attribute proves modality.
- [ ] **4. Observe RED and implement exact capture before invoke.** Use one route ref lock before creating the transport Promise. Parse/capture each accepted input once, preserve its generation/API/week owner and invoke a thunk, never pass `api.createJob(...)` into a later guard. Local validation failures return not_started with local validation copy and no call. A competing event returns not_started and cannot clear a form. Keep raw form state mounted above transient report reads and retain last accepted report during refresh failures. Original jobId, requestedAt and contractorAcceptedAt never change during same-request retry:

```ts
// FridayIntent is the frozen union defined in the interface ledger.
// In the route's admitted branch, before invoke():
// flight.current = true; retainedIntent.current = structuredClone(intent);
// invoke is () => api.createJob(retained.input), fillJob or cancelJob.
// On rejection: keep retainedIntent and raw fields; return unconfirmed.
// On accepted receipt: mark acknowledgement before starting report reread.
```

Keep the current mintJobId mechanism but invoke it once per new create intent, not per retry. Do not permit a changed payload under a held job ID: JobRepository's conflict path returns a canonical row without reapplying payload. No new automatic retry/idempotency subsystem. Readback reconciliation compares actual jobs by ID and captured fields, not aggregate metric changes or receipt IDs that do not exist. API replacement/unmount suppresses stale UI updates, without claiming main execution was cancelled or promising cross-route Friday retention.
- [ ] **5. Migrate existing tests and GREEN.** FridayPage.test's void callbacks become explicit async saved/unconfirmed results, with required idle/mutation/retry/refresh props supplied by its existing renderPage and direct JobRequestForm fixtures. Keep optional-cycle-null, local timezone conversion, idle Keep requested zero-write, cancelled-history and exact payload assertions. FridayRoute success-refresh checks remain, supplemented by distinct rejection/refresh-error cases. Preserve unrelated metric/drilldown calculations. Parent runs focused tests/typecheck/lint, reviews exact frozen paths and commits. Real persisted Friday acceptance remains Task5.

**Future focused candidate recipe, after parent import-graph/resource lease:**
```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"
npx vitest run src/renderer/features/friday/FridayPage.test.tsx src/renderer/features/friday/FridayRoute.test.tsx src/renderer/features/friday/FridayMutationRetention.test.tsx --maxWorkers=1 --minWorkers=1
```

## Task4: Production parity, then nine duplicate-body removals (F18)

**Depends on Tasks1-3 and C3.** This refactor's evidence is baseline GREEN and before/after equivalence, not an invented behavioral RED. Parent must record that disposition before deletion.

**Production:** only `src/main/leads/{leadsService.ts,leadDetailService.ts}`, `src/main/today/todayService.ts`, `src/main/pipeline/pipelineService.ts`, `src/main/review/reviewService.ts`, `src/main/friday/fridayService.ts`, `src/main/imports/importService.ts`, `src/main/conversations/conversationsService.ts`, `src/main/learnings/learningsService.ts`. Remove only the direct factory bodies in the spec and newly unused imports; preserve all live types/helpers. `registerApplicationIpc.ts` is read-only.
**Tests:** modify `tests/integration/{leadsService.test.ts,leadDetailService.test.ts,todayService.test.ts,leadTriageReportService.test.ts,pipelineService.test.ts,reviewService.test.ts,fridayService.test.ts,importService.test.ts,leadOrganizationAssignment.test.ts,conversationsService.test.ts,learningsService.test.ts}`; modify `src/renderer/features/leadInspector/LeadInspectorProvider.test.tsx` and `tests/main/registerApplicationIpc.test.ts`; create `tests/fixtures/productionDomainGate.ts`, `tests/integration/productionProviderReadiness.test.ts`.
**Consumes/produces:** unchanged public Provider contracts and shipped mapping exports. Tests consume production implementations rather than a competing direct-domain implementation.

- [ ] **1. Inventory and characterize before deletion.** Search static/dynamic imports of all nine factory names, including the Today module path and dynamic detail import. In registerApplicationIpc.test, exercise all provider methods and original arguments/returns/errors. Exact inventory: Leads list/updateField/bulkUpdate; detail get/beginOutbound/getOutboundCapabilities/confirmTransition/dismissLead/overrideCloudScore/findContactInfo; Today get/complete/snooze/pin/logPastActivity/addLeadNote/logCallOutcome/markActivityInError/getLeadTriageSnapshot/getTriageQueue/setReviewPosition; Pipeline get; Review list/resolve; Friday getCurrent/getDrilldown/createJob/fillJob/cancelJob; Import preview/remap/commit/status; Conversations list/get/attachTranscript; Learnings list/capture/addEvidence/updateStatus. Test omitted Friday request without converting it to a new input.
- [ ] **2. Move real-domain suites to shipped factories.** The helper adapts a real existing facade without duplicating any method map:

```ts
import type { FounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import type { createLeadsProvider } from '../../src/main/ipc/registerApplicationIpc';
export function productionDomainGate(domain: FounderSalesDomain): Parameters<typeof createLeadsProvider>[0] {
  return {
    withDomain: async operation => operation(domain),
    getHealth: async () => { throw new Error('Unexpected fixture health read'); },
  };
}
```

Use each corresponding shipped factory with this adapter. Keep useful Provider types imported from the existing service modules. This helper is explicitly a test seam, not real FoundationRuntime readiness proof. Preserve F01 transaction/organization assertions and reliability pagination/strict metadata coverage.
- [ ] **3. Prove actual readiness and IPC boundaries.** New productionProviderReadiness tests use real FoundationRuntime/domain initialization in a disposable encrypted workspace. Delay an initialization dependency and prove callbacks do not run early. Ready permits representative real reads/writes from every factory; blocked/stopping/stopped reject without executing domain mutation. Exercise strict preload plus validated production registrar for at least one real list and write, preserving sender rejection and exact receipt parsing. Inject clocks/local transports only, never successful fake mutation/list results as public-boundary evidence.
- [ ] **4. Preserve exceptional detail semantics.** No outbound service means fixed refusal via withDomain; injected outbound receives the exact request and owns its readiness. Fixed unavailable capabilities and absent-enrichment credentials_unavailable still work. Injected enrichment retains its own request path. Do not assert every detail operation must pass through the domain gate or add a universal wrapper.
- [ ] **5. Record baseline, obtain parent refactor disposition, remove bodies.** Only after migrated real-domain suites and mapping/readiness tests pass, delete the nine bodies. Rescan every static/dynamic caller. Keep `unavailableOutboundCapabilities`, EnrichmentRequester, Provider/DTO/invoker types and the unrelated live domain TodayService. Do not rewrite domain or production mapping behavior to make parity tests green.
- [ ] **6. Compare after-deletion GREEN and freeze.** Parent runs the same explicit mapping/readiness/native suites, typecheck and lint. Report exact body/caller inventory, unchanged method semantics, hashes and limitations for independent review and parent commit. Do not claim safety or bundle-size improvement from line removal alone.

**Separate parent-owned actual-readiness recipe:**
```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"
npx vitest run tests/main/registerApplicationIpc.test.ts tests/integration/productionProviderReadiness.test.ts tests/integration/leadsService.test.ts tests/integration/leadDetailService.test.ts tests/integration/todayService.test.ts tests/integration/leadTriageReportService.test.ts tests/integration/pipelineService.test.ts tests/integration/reviewService.test.ts tests/integration/fridayService.test.ts tests/integration/importService.test.ts tests/integration/leadOrganizationAssignment.test.ts tests/integration/conversationsService.test.ts tests/integration/learningsService.test.ts src/renderer/features/leadInspector/LeadInspectorProvider.test.tsx --maxWorkers=1 --minWorkers=1
```

## Task5: Actual continuity/status acceptance and evidence closure

**Depends on Tasks1-4 and C4 integration.** One test worker. No production, package.json or frozen-fixture ownership. Parent alone runs package/native/browser acceptance.

**Exclusive new files:** `tests/fixtures/continuityDomainFixture.ts`, `tests/integration/continuityPublicRoutes.test.tsx`, `tests/e2e/continuityWorkflow.spec.ts`.
**Consumes:** actual App/FounderApp/routeRegistry under PresentationRoot, real local-workspace/health preload and validated registrars, production providers, real encrypted domain and current public schemas. Keep typed unrelated read fixtures explicit and default-deny writes; no substitute route.

- [ ] **1. Build bounded real-domain fixture.** Reuse existing openDatabase/migrate/createDomainServices/createFounderSalesDomain and fictional key conventions from current integration tests. Local intake commands flow through createLocalWorkspaceApi -> registerLocalWorkspaceIpc -> createLocalWorkspaceProvider -> actual domain. Its gate needs both withDomain and withDatabase, respecting the source distinction. Label only the in-process Electron transport seam. Use the production health service/runtime for freshness/admission cases. No general review seeder, production fixture switch or live credential.
- [ ] **2. Prove F11 persistence join.** Through actual Accounts form, review and create a fictional company. Commit in main, delay only delivery of the real create reply, navigate away, reach unknown by the existing deadline, return and explicitly Check save status. Assert the same commandId/input, the domain's saved account ID, one matching `pm_account_commands` record and one account for this fixture. Returning or status never auto-creates. Release the late reply and prove it cannot replace the newer same-request status decision or navigate away. Repeat unsaved fields/review and explicit conflict/retry component cases without calling a fake provider setter.
- [ ] **3. Prove F16 actual projection.** Construct valid bounded lifecycle fixtures using existing integration patterns, call production getCommitments, and compare its complete returned stable-key set to Local commitments rows across all six kinds. Worker Calls count only worker account IDs. Preserve due/channel/evidence and explicit contact open. Parent repeats scoped/unavailable/partial/stale/checking synthetic read scenarios with labeled fixture evidence, not a claim of live provider availability.
- [ ] **4. Prove F15 joins without inventing recovery.** A real health read after sourcing-state change updates its scoped label/timestamps without rerunning startup. Delaying/rejecting only transport delivery leaves the App's ready form DOM intact. Initialized blocked domain never runs route commands. Main/startApplication tests separately prove raw-failure cleanup and post-success dock-badge failure with deferred owned shutdown, failed cleanup -> Quit only, and concurrent quit joining one cleanup without relaunch. Physical dialog evidence, if authorized, uses approved disposable orchestration only, never a damaged key/profile or a production failure flag.
- [ ] **4a. Prove Friday F14 through its public boundary.** Actual FridayRoute uses createFridayApi -> registerFridayIpc -> shipped createFridayProvider -> real encrypted domain. Request a fictional job with captured ID/time, fill it with an explicit accepted time and cancel a separate requested job. Verify exact job records and history, not only metric counts. Delay/reject transport delivery for retained unknown input; repeat the exact create request and verify one job row with the original ID. Do not claim existing create/fill behavior checks a new payload fingerprint or infer save from an unrelated report refresh. Preserve no-extra-mutation counts after acknowledged-save/report-read failure. Parent drives the inline fill group and palette/Import on the real Friday route.
- [ ] **5. Parent packaged journey.** Use existing launchFounderWorkspace with disposable fictional data. Accounts form -> real Campaigns/Leads -> Accounts retains input, then review/create/read back through public API. Unpaired Worker accounts/campaigns say Unavailable beside local company evidence. Test normal startup, explicit diagnostic refresh, preserved Native editor DOM and palette/Import topmost Escape. Verify unchanged shared appearance/density and narrow reachability, not identical content heights after adding the truthful lane.
- [ ] **6. Close only observed outcomes.** Record F11/Friday F14/F15/F16/F18 evidence separately using the ledger below. Parent integrates the exact packaged spec into maintained release invocation. If native fatal injection, a six-kind packaged fixture or another check is unavailable, label that gap and retain its source/in-process evidence as such, not a substitute pass. Freeze/review and parent commit only after agreed coverage.

**Future public-join recipe, parent-controlled native environment:**
```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"
npx vitest run tests/integration/continuityPublicRoutes.test.tsx --maxWorkers=1 --minWorkers=1
```
**Future packaged exact-spec recipe, separate artifact/resource approval:**
```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"
npx playwright test --workers=1 tests/e2e/continuityWorkflow.spec.ts
```

## Acceptance ledger, remaining coordinator dispositions and stopping rule

| Outcome | Required maintained evidence |
| --- | --- |
| F11 | Actual route/Import-remount continuity; original command across pending/unknown/status/retry; no stale view callbacks or automatic replay; real committed-but-undelivered recovery/persisted IDs. |
| F15 refresh | Timer/focus/manual read-only updates; same ready editor DOM on transient failure; stale observation versus immutable audit; initial/confirmed blocked admission; no source retry/write/initializer call. |
| F15 fatal | Raw startup rejection and post-success dock.setBadge throw have separate tests; failed-window destruction and actual owned cleanup settlement precede the fixed dialog; unresolved cleanup allows no early quit/dialog; failed cleanup offers Quit only; normal quit/abort share one shutdown, suppress late dialog/relaunch, and explicit restart relaunches once; host suppression and raw sentinel redaction. Physical display remains a separately labeled parent check. |
| F16 | Complete returned retained keys and all six kinds remain visible/inspectable outside worker Calls; truthful local/worker known/partial/stale/checking/unavailable counts; partial+pending and stale+pending retain their qualified labels, including zero, while complete-known+pending alone uses numeric checking; unchanged accepted live R4, action holds, keyboard and modality. |
| Friday F14 | Exact captured create/fill/cancel input, admission before invoke, one pending invocation, rejection/unknown retention and same-request explicit retry/readback, accepted-save versus report failure, real job persistence and inline-fill/modal-underlay behavior. |
| Settings copy | Retired E/H/P absent; actual menu mapping and Inbox label; legacy S/X and Native/Leads navigation explicitly scoped to actual handlers and target guards, with no invented shortcuts. |
| F18 | All nine real-domain caller suites target shipped factories before removal; complete mapping characterization, real readiness and validated preload/registrar acceptance; no remaining duplicate-body caller. |

Coordinator dispositions needed are operational: accepted C1/C2/C3 checkpoints and exact shared-file release, C4 fixture/read-count integration and maintained package wiring, and F18's explicit behavior-preserving refactor gate. Newly identified exact test additions versus the old scratch draft are `App.test.tsx`, `LocalWorkspace.test.tsx`, `ActualAComposition.test.tsx` and the provider/count plus Friday retention test paths above. They contain real contradictory or lifetime assertions and must not be bypassed. No new user design approval is requested.

Stop after documentation self-review for this GO. During later implementation, stop on an ungranted file/public-schema need, missing native/resource lease or failed safety/authority check and return the concrete blocker to the coordinator. Never substitute broad casts, optional public DTO defaults, fake route mapping, silent input reset or weakened readiness for acceptance. No document or source hash is implementation/runtime acceptance.
