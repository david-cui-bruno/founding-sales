# Workspace continuity repair specification

**Scope:** F11 in-session local-company continuity, F15 truthful diagnostic refresh and reachable fatal-startup failure, F16 source-correct retained/worker queue labels and counts, the Friday portion of F14, F18 production-adapter parity before duplicate-body removal, and retirement of stale Settings shortcut instructions.
**Authority:** [Approved product repair program](../2026-09-10-product-repair-program.md), [audit](../../../engineering/2026-09-10-adversarial-product-audit.md), coordinator's 2026-09-10 docs-only GO, and the prior source-only `continuity-design.md`. The user already approved repair-only implementation. No additional user design gate is introduced.
**Status:** documentation only. Implementation remains subject to parent GO, explicit file handoffs and independently observed acceptance. Source inspection is not a runtime, performance or clean-tree result.
**Plan:** [Exact ownership and execution](../plans/2026-09-10-workspace-continuity-repair.md).

## Invariants and exclusions

- Preserve stable PresentationRoot/OverlayProvider, native modality, Native appearance/preferences, editor identity, pending fences, domain/receipt/identity/authority/recovery checks and all retained obligations.
- Preserve the accepted live R4 legacy-ancestor/input-retention repair (`NativeDeskRoute.tsx:235-250`): retained workflow-mode evidence keeps established legacy composition at the same fragment position, Workspace status stays a sibling, and transient read holds separately block new writes. Re-read that accepted handoff. Do not replace it with a fresh-read-only condition or move pending forms under a different ancestor.
- No Offline mode, new security framework, public schema, local workspace/profile/key change, generic command subsystem, rollback, data deletion, provider activation, grants, sends/calls, installation, push or deployment.
- Company continuity is memory-only within one mounted workspace owner. No crash, reload, restart or disk persistence claim. No plaintext journal, localStorage or module-global command cache.
- Parent owns implementation GO, test/resource scheduling, frozen acceptance integration and every commit. One implementation worker at a time. Native/browser/Swift/build/package/app/profile/provider work remains parent-controlled and separately gated.
- Every future npm/npx invocation starts with `export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"`. Preserve the existing ABI137 binding. Never rebuild native dependencies as a response to failure.

## Source-grounded boundaries

1. `FounderApp.tsx:36-79` keeps the inspector/global Import outside a route-and-refresh-keyed subtree. `NativeDeskRoute.tsx:191-209` owns company intake inside that subtree. `LocalCompanyIntake.tsx:20-53,83-132` has the correct frozen request, bounded wait, busy fence and receipt checks, but route unmount destroys its owner.
2. Public intake follows `createLocalWorkspaceApi` -> validated `workspace/registerLocalWorkspaceIpc.ts` -> `workspace/localWorkspaceProvider.ts:5-14` -> `runtime.withDomain` for review/create/status/commitments. Local overview alone uses `withDatabase`. Preserve that distinction. The existing request is `{commandId,name,domain}`. Status `not_recorded` is not proof a pending create never reached main.
3. `useFoundationHealth.ts:29-55` replaces ready with loading/failed on every read. `App.tsx:23-31` consequently removes FounderApp, and currently treats a fulfilled blocked health object as admission. `HealthService.getHealth` reads live sourcing/database metadata but retains the startup audit. `FoundationRuntime.getHealth/ensureInitialized` reuse established state; refreshing is not a migration/audit/recovery command.
4. `main.ts:182-275` currently quits on the outer startup-chain rejection. Only the raw `startApplication` rejection has its cleanup guarantee (`startApplication.ts:760-763,938-964`): shutdown is awaited, and cleanup failure becomes AggregateError. `main.ts:257-266` also assigns `runningApplication` and then calls `installDockBadge`; `dock.setBadge` can throw after successful startup. That post-success rejection does not prove cleanup, even when it is not AggregateError. `main.ts:278-317` separately owns normal quit/shutdown. Preserve that ownership, cancellation and `main.ts:88-111` failed-window destruction.
5. `localWorkspaceContract.ts:24-30` contains six retained kinds with strict cycle/action identity. `RetainedWork.tsx:5-23` already labels them correctly. `NativeDeskRoute.tsx:582-589,660-685` incorrectly adds them to Calls; worker Accounts/Campaigns use raw lengths despite unavailable scope. Daily freshness is only a local snapshot with remote freshness unknown.
6. `registerApplicationIpc.ts:83-214` owns the shipped nine provider mappings. The nine direct-domain factory bodies remain test adapters; their files also contain useful live types/helpers. Their deletion must follow tests of the shipped mappings and actual readiness boundary, not merely a rename of test imports.
7. `FridayRoute.tsx:95-100,125-128` receives already-started mutation Promises and refreshes identically after success/rejection. `JobRequestForm.tsx:69-92` creates a new job ID and clears input before acknowledgement. Fill is an inline flex panel (`friday.css:312-320`), not a native modal, despite its current alertdialog role. `founderSalesDomain.ts:2376-2417` already owns create/fill/cancel semantics; its MutationReceipt contains no job ID. `JobRepository.enqueue:233-272` returns the canonical duplicate-key record without reapplying changed payload, so uncertain retry must keep the exact original request.
8. `SettingsScreen.tsx:293-300` still advertises retired E/H/P. Current `TodayPage.tsx:30-44` uses J/K/arrows, row Enter, S for tomorrow09:00-local snooze and X for Skip today. `NativeDeskRoute.tsx:535-579` uses scoped row movement/Enter/detail Escape with overlay/field guards. Native menu accelerators are fixed in `applicationMenu.ts:58-66,83-88`; Accounts/Campaigns have no numeric accelerator there.

## 1. F11: workspace owner, route view binding

### Chosen design and alternatives

Lift the existing company state machine into a workspace provider while keeping its current form controller. A navigation confirmation would preserve neither a freely navigable unresolved operation nor an accepted result arriving while away. Keeping every route mounted would retain unrelated effects and authority-sensitive owners. A persisted command journal expands scope unnecessarily. Therefore use one memory owner, with short-lived Accounts view bindings.

```ts
type IntakeApi = Pick<LocalWorkspaceApi,
  'reviewCompany' | 'createCompany' | 'getCompanyCreateStatus'>;
// New LocalCompanyIntakeProvider.tsx:
// LocalCompanyIntakeProvider({api, children}: {api?: IntakeApi; children: ReactNode})
// LocalCompanyIntake.tsx retains useLocalCompanyIntake(options)
// and its existing LocalCompanyIntakeController form-facing return type.
type IntakeView = Pick<LocalCompanyIntakeOptions,
  'available' | 'localRead' | 'onOpenAccount' | 'onRefreshLocal'>;
// Internal owner bindView(view: IntakeView): () => void
// Unbinding disposes the view token only, never the command owner.
```

- Place a provider in FounderApp above FounderWorkspace's keyed route subtree without moving/keying LeadInspectorProvider. F15 also places the same provider inside PresentationRoot above App's diagnostic/ready branch. A matching nested provider reuses the enclosing owner by exact localWorkspace API identity. Different API identity creates an isolated owner and invalidates old settlement.
- Extract one state-machine implementation, not two reducers or command caches. For existing isolated hook/component callers without a provider, retain the current local-lifetime fallback using that same implementation. Only provider-backed production composition promises route continuity. Tests must prove the real App/FounderApp path uses one owner.
- Keep LocalCompanyIntakeOptions and controller methods. Only `scopeKey === 'local-company:accounts'` binds a production Accounts view. Today/Campaigns hooks cannot replace its callbacks or availability. Route scope keys do not reset the workspace owner. Standalone fallback scope changes keep their existing invalidation meaning.
- A binding has a unique token. Cleanup removes only its own token, never a newer remount's binding. Render-time callbacks from an unmounted route are never retained as active navigation authority. An unbound owner accepts no new UI command, but continues settlement of an already submitted request.
- Leaving Accounts or Import's refreshKey remount retains open/form fields/review/request/phase/busy status and the existing 15-second logical deadline. Returning performs no automatic review/create/status/retry. Draft is restored as form state, not a promise of the same input DOM across actual route unmount.
- A saved response while away stores the verified saved ID but never navigates or invokes stale refresh callbacks. Returning shows the accepted result and existing explicit **Refresh saved company** recovery. If the submitting binding is still active, current open/refresh behavior remains.
- Preserve exact UUID/input, duplicate review, synchronous busy fence, safe copy, response identity checks and all current state transitions. `not_recorded` stays unknown. Explicit **Retry create** uses the same request. Conflict stays held. Only a verified `needs_review` response permits the existing return-to-review transition. No exactly-once execution claim.
- Deliberate Close keeps its current policy: it cannot dismiss unresolved creation; ordinary editing/review state can close. Do not equate route departure with Close, automatically cancel a save, or reset a genuinely unknown request.
- Provider teardown/API replacement cancels local timers and suppresses stale UI settlement, not the underlying remote/main operation. It neither migrates nor replays work into another database. A replacement API is the available session boundary; worker workspaceId/revision/workflow mode must never become a substitute local identity.

## 2. F16: source-correct queue presentation

- Keep worker **Calls** for `snapshot.calls.accountIds` only. Add a separate **Local commitments** lane immediately before it using existing RetainedWork and its six labels: retained callback, post-stage follow-through, onboarding, inbound response, existing relationship and founder resurface.
- Retain every `retainedKey = JSON.stringify(['retained', salesCycleId, action.id])`, detail, due time, reason/channel/lane and explicit contact-open behavior. Preserve retained-first keyboard order across lane boundaries. Do not infer a call from the retained kind, convert an action or omit non-call obligations.
- Local-only fallback uses **Local commitments**. Its worker Calls/Needs your approval/Upcoming meetings headings say **Unavailable**, not a measured zero. Preserve existing local evidence and stale contact-open holds.
- Label worker company/campaign counts **Worker accounts** / **Worker campaigns**, beside the separate existing local account library. Its contents remain local companies, not evidence of worker pairing or permission.

```ts
export type VisibleCount =
  | {kind:'known'; value:number} | {kind:'unavailable'}
  | {kind:'partial'; value:number} | {kind:'last_known'; value:number}
  | {kind:'checking'; value:number|null};
export function formatVisibleCount(count: VisibleCount): string;
// known: '0'/'N'; unavailable: 'Unavailable'; partial: 'N+ · partial'
// last_known: 'N · last known'; checking: 'Checking'/'N · checking'
// Existing partial/last_known qualification wins over pending/checking.
// Numeric checking is only for retained complete, non-stale evidence.
```

Local commitments use this exact precedence: no value means **Checking** while pending, otherwise **Unavailable**; retained value plus error means **N · last known**, even while pending; otherwise positive reviewErrorCount means **N+ · partial**, even while pending; otherwise retained complete evidence plus pending means **N · checking**; otherwise known. This matches `localWorkspaceRead.ts:13`, which preserves both the prior value and error while starting a refresh. Pending alone never upgrades partial or last-known evidence to an apparently complete count.

Worker counts keep their existing source gate first: missing/mismatched scope means **Unavailable** regardless of array length or pending. With retained same-scope evidence, failed/held/last-known qualification precedes incomplete/partial qualification, and both precede any checking display. Only prior complete, non-stale evidence may become **N · checking**; no prior value may say **Checking** only when its source scope is valid and a read is pending. Apply this ordering to existing pending evidence, without inventing a worker pending API. Zero retains the same qualifications. Keep existing incomplete-source and refresh-status messages separately, including an incomplete-source warning when stale evidence is also partial. Do not widen VisibleCount or add a composite-status framework. Never aggregate independent local/worker uncertainty into one total.

Required combined cases: partial+pending keeps **N+ · partial**, stale+pending keeps **N · last known**, complete-known+pending becomes **N · checking**, and no-value+pending is **Checking**. Include partial0+pending and stale0+pending. Exercise the actual read-to-count projection, not only the formatter with a preselected discriminant.

Keep snapshot generatedAt and remote freshness unknown visible in existing connection details. Count formatting never enables an action, overrides localHold/readError/configuration/owner/version checks, changes a pending command or suppresses incomplete-source warnings. Existing DailyAnswers and meeting behavior are not redesigned.

## 3. F15: observation, admission and fatal startup are distinct

### Readonly health observation

Keep `health.get(): Promise<AppHealth>` and the strict wire schema unchanged. Add renderer-only observation metadata:

```ts
export type HealthObservation = {
  checkedAt:string|null; refreshing:boolean; refreshFailed:boolean;
};
// FoundationHealth retains its discriminated status/health and retry():void.
// Add observation?: HealthObservation for existing explicitly injected fixtures.
// The production hook always supplies it.
// DiagnosticsScreenProps and SettingsScreenProps accept observation?: HealthObservation.
```

- Initial read still uses loading/failed. After an accepted ready observation, refresh keeps the same ready subtree and health object until a newer valid result arrives. Pending/rejected/hung reads show a nonmodal, non-focus-stealing status/alert with **Refresh diagnostics**, retaining forms/selection/editor DOM. A diagnostic read failure is not proof the database failed to open.
- Read health every 60 seconds while the document is visible, on focus, and on explicit refresh. Deduplicate to one logical in-flight read. Preserve generation/API guards, impose a 15-second logical deadline, and clean listeners/timers on teardown. No health timers before mount or after API replacement. Late timed-out results cannot overwrite newer observations. Timeout does not claim cancellation of IPC, and there is no automatic mutation retry.
- `checkedAt` is the renderer time of a successfully validated response, not the main startup audit time or provider health. Missing injected metadata says **Last read time unavailable**. A failed refresh retains the last checkedAt and labels it stale. Use fixed safe messages, never raw exceptions.
- Refresh invokes only `health.get`. It does not call sourcing.retry/pollNow, initialize/repair a domain, open a database, change recovery material or manufacture a ready authority state. Existing main gates continue to reject commands independently of cached renderer data.
- Settings replaces broad **Operations ready/degraded** with **Sourcing monitor**. Degraded is a warning; healthy without lastCompletedAt is neutral **Not checked**; otherwise **No sourcing degradation reported** with the sourcing completion time. Display startup audit evaluation separately. No whole-product health guarantee or startup-speed claim.

### Admission and initialized blocked state

Normal routes require a successful health object with both `domainReady === true` and `domainStatus === 'ready'`. Initial blocked/inconsistent health renders diagnostics, not an apparently usable sales workspace. Explain the immutable audit timestamp and that Refresh reads diagnostics only, not startup checks/repair. Keep accepted initial-failure and ready displays distinct.

A later valid blocked response deliberately removes normal product routes so hidden effects cannot initiate new work, but the matching company provider remains above that conditional. This is distinct from transient read failure, which never removes the ready app. The root presentation and preference lifetimes do not change. Existing RecoverySection may be shown for this already-initialized blocked state, labeled as recovery-material setup/backup verification, with no automatic operation and no claim of in-place repair. Fatal pre-initialization failure cannot use those renderer APIs.

### Fatal startup surface after cleanup

```ts
// New src/main/startupFailureDialog.ts
export function showStartupFailureDialog(input: {
  canRestart:boolean;
}): Promise<'quit'|'restart'>;
```

Show a fixed native error dialog only after the applicable owned cleanup attempt has actually settled: **Callie could not start**, code `APPLICATION_STARTUP_FAILED`, and startup-did-not-complete guidance. **Quit** is default/cancel; **Restart Callie** is available only with cleanup confirmed. No raw exception, private path, key material, error cause or unsupported Restore/Reset action reaches the dialog.

- **Raw startup rejection:** distinguish the result of `startApplication(...)` itself from all later orchestration. Its rejected Promise settles only after its internal shutdown attempt. A non-AggregateError rejection from that exact boundary permits confirmed cleanup under the existing contract. Treat any AggregateError from that boundary conservatively as cleanup-unconfirmed, without parsing nested causes. A failure before the raw startup call has been established is also Quit-only.
- **Post-success orchestration failure:** once raw startup fulfills, main owns the returned RunningApplication. If adoption/post-start setup fails, including `installDockBadge` throwing after assignment, synchronously stop normal application admission, claim that owned application, and await its `shutdown()` before any fatal dialog or restart offer. A non-AggregateError outer rejection, an established startupPromise, or merely starting shutdown is never cleanup evidence. Only successful resolution of this owned shutdown confirms cleanup. Rejected shutdown settles the attempt but leaves cleanup unconfirmed, so the dialog offers Quit only.
- **One lifecycle owner:** normal before-quit, startup abort after raw fulfillment, and post-success failure must join the same main-owned shutdown Promise instead of invoking shutdown again. Keep that Promise reachable after detaching `runningApplication`; before-quit must await it rather than bypass cleanup or wait on a fatal dialog's user choice. While cleanup is unresolved, do not show a dialog, set allowQuit, quit early or relaunch. A failed cleanup may finish quitting only after its rejection is observed. Never convert failure to a successful-cleanup flag.
- **Terminal action:** suppress the dialog for intentional abort/quit, installer/single-instance exit and pre-release backup host. Recheck abort/quit both after cleanup and after dialog resolution. Explicit permitted Restart calls `app.relaunch()` once and then quits through a once-only terminal path; it does not retry a stopped runtime. Concurrent/repeated quit cannot double-shutdown or schedule a late restart. Dialog failure safely quits after the same cleanup barrier. Preserve failed-window destruction and normal startup checks. No startup initializer or key/recovery implementation change is needed.

Maintained main tests must specifically make raw startup succeed, then make `app.dock.setBadge` throw. A deferred owned shutdown proves no dialog/quit/relaunch before cleanup settles. Resolution permits the explicit one-time restart path; rejection permits Quit only. Concurrent before-quit joins that same shutdown and suppresses dialog/relaunch. Keep raw-startup cleanup/cancellation tests separate so a mocked raw rejection cannot stand in for post-success ownership coverage.

### Retire stale Settings shortcut guidance

Keep this a Settings copy repair, not a new keyboard dispatcher or mode-read API. Present explicit scope labels rather than suggesting every key works on every route: application menu Cmd/Ctrl+1..7 maps Today, Leads, Pipeline, Conversations, Learnings, Friday, Inbox; Cmd/Ctrl+, opens Settings; Cmd/Ctrl+I opens Import; Cmd/Ctrl+K opens the existing palette only when permitted. Legacy Today focused rows use J/K or arrows, Enter opens contact, S snoozes to tomorrow09:00 local and X skips today. Native Desk focused queue rows use J/K or arrows, Enter reviews, and Escape closes selected detail only when no higher layer owns it. Leads focused rows retain their actual movement/open instructions. State that editing fields and open overlays own their keys. Remove E/H/P and the obsolete Review label. Do not invent Accounts/Campaigns numeric shortcuts, imply permission to call/send, or show legacy mutation keys as Native actions. Re-read accepted R4 handlers before freezing copy.

## 4. Friday F14: retain each captured job intent through outcome

```ts
// Export the three internal UI types from FridayRoute.tsx.
export type FridayIntent =
  | {kind:'create'; input:CreateJobRequest}
  | {kind:'fill'; input:FillJobRequest}
  | {kind:'cancel'; input:CancelJobRequest};
export type FridayMutationView = {status:'idle'} | {
  status:'pending'|'unconfirmed'|'saved'; intent:FridayIntent; message:string|null;
};
export type FridaySaveResult =
  | {status:'saved'}
  | {status:'unconfirmed'; message:string}
  | {status:'not_started'};
// FridayRoute -> FridayPage -> JobRequestForm:
// onCreateJob(input:CreateJobRequest):Promise<FridaySaveResult>
// onFillJob(input:FillJobRequest):Promise<FridaySaveResult>
// onCancelJob(input:CancelJobRequest):Promise<FridaySaveResult>
// Page/Form also require mutation:FridayMutationView,
// onRetryMutation():Promise<FridaySaveResult>, and
// onRefreshJobs():Promise<FridaySaveResult>. Route owns error/outcome state.
// Form clears only the matching captured fields after a saved result.
// Route private runCommand(inputOwner, invoke:()=>Promise<MutationReceipt>)
// invokes only AFTER synchronously claiming the shared route ref lock.
```

Preserve current manual-job fields, optional cycle, local date/time conversion, domain-calculated metrics and all cancelled/history rows. Freeze `{jobId,salesCycleId,requestedAt}` once for create and `{jobId,contractorAcceptedAt}` once for fill. No new idempotency scheme, public receipt field or generated replacement ID on retry. Local validation failure preserves editable fields and makes zero calls.

The route owns one captured mutation session and immediate admission lock before invoking a thunk, never an already-started Promise. Pending disables competing create/fill/cancel, selection of another fill target, Keep requested and week navigation. Keep the existing JobRequestForm mounted using the last accepted report during refresh/error so its raw fields survive. Do not add a new timeout that unlocks an unresolved write. After rejection, retain the captured request and form with fixed copy: **The change could not be confirmed. Your input is kept. Review the job before retrying.** Explicit Retry reuses the frozen request, never automatically resubmits. Unconfirmed requests are not silently editable into a different payload under the same ID.

Provide explicit **Refresh jobs** through existing getCurrent. Match by jobId and the captured fields/status before using readback to reconcile an uncertain result. Missing/contradictory readback remains unconfirmed; it is not proof the mutation never executed. Verified same-request create existence, filled accepted timestamp or cancelled status may resolve the held intent. A successful mutation receipt is acknowledged independently of report refresh; clear only that submitted form after acknowledgement, show **Saved; scoreboard refresh failed** when reread fails, and never invite mutation retry for that read failure. Do not claim MutationReceipt carries a job identity or that existing fill/create deduplication proves exact-payload idempotency.

Preserve fill's inline layout and change its misleading `role="alertdialog"` to a labeled group. There is no Friday modal to register or trap. Keep requested can dismiss an idle pre-submit fill editor, but not pending/unconfirmed work. No new document Escape listener. Palette/Import remains the real shared modal layer above Friday, and its close cannot clear underlying fields. This task promises retention during submission/report refresh within the mounted Friday route, not crash or cross-route Friday draft persistence. API replacement/unmount suppresses stale UI settlement without claiming cancellation of main execution. Friday acceptance is required before claiming F14 complete, alongside the separate modal and Leads slices.

## 5. F18: production mapping first, nine bodies second

Remove only these direct-domain factory bodies after their tests target `src/main/ipc/registerApplicationIpc.ts` exports:

| Body module/factory | Shipped replacement | Existing direct test callers |
| --- | --- | --- |
| `leads/leadsService.ts:createLeadsService` | createLeadsProvider | integration/leadsService.test.ts |
| `leads/leadDetailService.ts:createLeadDetailService` | createLeadDetailProvider | integration/leadDetailService.test.ts; renderer/features/leadInspector/LeadInspectorProvider.test.tsx |
| `today/todayService.ts:createTodayProvider` | createTodayProvider | integration/todayService.test.ts; integration/leadTriageReportService.test.ts |
| `pipeline/pipelineService.ts:createPipelineService` | createPipelineProvider | integration/pipelineService.test.ts |
| `review/reviewService.ts:createReviewService` | createReviewProvider | integration/reviewService.test.ts |
| `friday/fridayService.ts:createFridayService` | createFridayProvider | integration/fridayService.test.ts |
| `imports/importService.ts:createImportService` | createImportProvider | integration/importService.test.ts; integration/leadOrganizationAssignment.test.ts |
| `conversations/conversationsService.ts:createConversationsService` | createConversationsProvider | integration/conversationsService.test.ts |
| `learnings/learningsService.ts:createLearningsService` | createLearningsProvider | integration/learningsService.test.ts |

Body paths are under `src/main`; integration paths are under `tests`; the renderer test is under `src`. Keep Provider/DTO/invoker types and `EnrichmentRequester`/`unavailableOutboundCapabilities`. Remove only imports made unused by deleting those bodies. Do not delete modules wholesale or touch live `src/main/domain/today/todayService.ts:TodayService`, domain behavior, daily/local-workspace/discovery/account/campaign/research services.

Characterize every shipped provider method's exact argument forwarding/return/rejection. Preserve detail exceptions: absent outbound records the fixed refusal through withDomain; injected outbound owns begin/capabilities; missing enrichment yields credentials_unavailable; injected enrichment owns its request. Do not wrap these exceptional services in a new universal gate.

Migrate real encrypted-domain tests to production factories through a minimal domain-gate test adapter containing no method mappings. That adapter is not evidence of actual readiness. Separately exercise real FoundationRuntime with pending initialization, ready, blocked and stopping/stopped states, and production validated registrar/preload reads and writes. Preserve sender/schema checks and exact receipts.

This is behavior-preserving removal. Baseline mapping tests may already pass. Record baseline GREEN and before/after equivalence rather than inventing a behavioral RED. Parent must explicitly accept that refactor-gate disposition before deletion. Behavioral F11/Friday F14/F15/F16 and stale-shortcut changes still require maintained observed RED then GREEN.

## Acceptance, conflicting assertions and limits

- F11: actual Accounts -> Campaigns/Leads -> Accounts and Import refresh preserve fields/review/exact unknown request. Delay only a real committed create response, verify same-command status recovery and one persisted account/command receipt for that fixture. No global exactly-once or crash claim.
- F15: actual App's ready editor DOM survives visible timer/focus/manual refresh rejection/hang, with no write calls; blocked health admits no normal routes. Fatal orchestration separately proves raw-startup cleanup and post-success dock-badge failure ownership, awaited actual cleanup before dialog, failed cleanup -> Quit only, one shared shutdown, one explicit relaunch and concurrent quit/abort suppression/redaction. A mocked native dialog proves ordering/options, not a physical macOS display.
- F16: returned complete stable-key set equals rendered Local commitments set, all six kinds and mixed channels remain inspectable, worker Calls exclude them, unavailable/partial/checking/stale are not unqualified zero. Actual source-to-count tests retain partial/last-known qualifications during pending refresh, including qualified zero; only complete prior evidence uses numeric checking. Preserve accepted live R4, real destination content, keyboard/focus and both theme/density presentations.
- Friday F14: create/fill/cancel synchronously admit once, keep original fields/IDs through pending/rejection, distinguish acknowledged save from reread failure, and verify exact persisted job state through production Friday API. Actual fill remains inline; palette/Import does not dismiss its work.
- Settings: no E/H/P claim, correct Inbox/menu mapping, and explicit Legacy Today versus Native/Leads target scope, traced to current handlers with no new shortcuts.
- F18: all nine migrated real-domain suites exercise shipped mappings; actual readiness and registrar/preload cases pass before bodies disappear; no direct-factory callers remain.
- Replace, do not bypass, `LocalWorkspace.test.tsx:36-45` retained-inside-Calls/all-lanes-unavailable assertions and `ActualAComposition.test.tsx:153-161` combined Calls count matrix. Preserve their non-call evidence, no-command, stale-read, selection, scope and keyboard checks.
- Split LocalCompanyIntake.test's unmount/scope tests between true owner disposal and detached view. A detached view cannot navigate, but a living workspace owner must keep settlement. Retain API replacement/conflict/duplicate protections.
- Replace App.test.tsx and SettingsScreen/App.lifecycle failure copy equating health-fetch rejection with database-open failure. Keep raw-error redaction. Parent adjusts frozen route/modal/startup fixture read inventories for periodic health reads, never weakens default-deny commands or substitutes routes.
- Replace `tests/main/main.test.ts:501-560` immediate auto-quit after renderer-load failure with cleanup-before-dialog and explicit/default Quit expectations. Retain its exact destruction/unregister/close checks and the pending-startup before-quit test at425-499. Add post-success dock-badge/failed-cleanup coverage rather than reusing a raw rejection or weakening those existing lifecycle assertions.
- Migrate FridayPage/JobRequestForm test callbacks from void mocks to explicit async results, preserving request/date/cancelled-history assertions. Any immediate-clear expectation must wait for accepted acknowledgement. Keep the current idle **Keep requested** no-write test and add blocked pending/unconfirmed cases. Settings shortcut tests must stop preserving E/H/P or unscoped mode claims.

The execution plan contains all grants and parent escrow paths. Documentation completion is not implementation acceptance. Any newly discovered consumer or public-boundary gap requires coordinator disposition before acquiring that file. Physical startup-failure/package checks, benchmarks or user-profile operations not performed remain explicitly unverified. No additional user approval is requested for these already-authorized repairs.
