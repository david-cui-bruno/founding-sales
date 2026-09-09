# Safe Local Native Desk Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the approved Native Desk reachable through an explicit local transition, retain existing due commitments, and show local PM-account evidence without claiming delegated authority.

**Architecture:** Add one lifecycle-gated `localWorkspace` IPC slice over the current encrypted database and existing transition command. Select retained work in main before the existing Today projection drops its evidence. Compose those reads separately from the unchanged workspace-scoped daily feed, using the approved Native Desk A layout and existing contact navigation.

**Tech Stack:** Electron, TypeScript, React, Zod, SQLCipher, Vitest, Playwright. No new dependency or schema migration.

**Spec:** `docs/superpowers/specs/2026-09-08-meeting-first-fss-design.md`, especially sections 2–4 and preservation requirements. This completes D3/D4 in `docs/superpowers/plans/2026-09-08-meeting-first-campaigns.md`. The A layout was approved September 9 at 04:46 UTC. David approved this local integration at 13:43 UTC after the installed sourcing repair passed.

## Global Constraints

- Build on the existing FSS, not a rewrite. Preserve data, evidence, durable drafts, truthful activity records and recovery.
- First audience: independent/regional residential PM firms, especially multifamily or mixed rental portfolios. Commercial is secondary. No invented portfolio cutoff or quota.
- Keep calls, approvals, upcoming meetings and small campaigns. Do not turn legacy property owners into researched PM accounts.
- Preserve selection, edits, focus, light/dark/system and density preferences. No new visual redesign.
- The transition is one-way and local. No automatic transition on mount. Do not change its lifecycle logic or use a raw-SQL mode flip.
- Local database scope is not worker identity. Do not invent persistent IDs, choose an authority row, change `expectedWorkspaceId`, or weaken `daily` scope validation.
- No network/provider calls, grants, calls, sends, calendar invitations, campaign activation, purchases, cloud deployment, publication or push in implementation/testing.
- Real-profile rollout follows a fresh normal-quit, closed-handle, hash-verified backup and exact-candidate checks. Never launch the old canonical `out` against the profile.
- Use owned disposable encrypted databases and browser-safe fixture APIs for every mounted component. Disabling buttons does not make a real API mount safe.
- Every npm/npx/Node command starts with `export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"` and runs from the explicit checkout.
- Coordinator owns serial full/native/package gates. Workers run focused tests only, do not spawn, and commit only owned files.
- Baseline is `c2c6b3108410af380be74b1431db2e9ae960c0a4` on `fix/release-task12-continuation`. Existing installed app and real profile remain untouched during implementation.

## Frozen public interface

Create `src/shared/contracts/localWorkspaceContract.ts`. Export strict schemas and inferred types named `localWorkflowTransitionSchema`, `localWorkflowReceiptSchema`, `localWorkspaceSnapshotSchema`, `localCommitmentsSnapshotSchema`, `LocalWorkflowTransition`, `LocalWorkflowReceipt`, `LocalWorkspaceSnapshot`, `LocalCommitmentsSnapshot`, and interface `LocalWorkspaceApi`.

```ts
interface LocalWorkspaceApi {
  get(): Promise<LocalWorkspaceSnapshot>;
  getCommitments(): Promise<LocalCommitmentsSnapshot>;
  transition(command: LocalWorkflowTransition): Promise<LocalWorkflowReceipt>;
}
type LocalWorkflowTransition = {
  commandId: string;
  expectedMode: 'legacy';
  manifestId: string;
};
type LocalWorkflowReceipt = {
  commandId: string; manifestId: string; mode: 'meeting_first';
  revision: number; occurredAt: string;
  cancelledActionIds: string[]; stoppedEnrollmentIds: string[];
  preservedActionIds: string[]; parkedPersonIds: string[];
  callbackEvidenceIds: string[]; unknownDraftIds: string[];
  parkedReviewActions: { id: string; cycleId: string; version: number }[];
  parkedActions: { id: string; supersededActionId: string; cycleId: string }[];
};
type LocalWorkspaceSnapshot = {
  scope: 'local_database'; generatedAt: string;
  workflowMode: 'legacy' | 'meeting_first';
  transitionReceipt: LocalWorkflowReceipt | null;
  accounts: { state: 'available'; snapshots: AccountEvidenceSnapshot[] }
    | { state: 'unavailable'; snapshots: [] };
};
type LocalCommitmentsSnapshot = {
  scope: 'local_database'; generatedAt: string;
  revision: number; reviewErrorCount: number;
  items: {
    kind: 'callback' | 'post_stage' | 'onboarding' | 'inbound_response'
      | 'warm_relationship' | 'founder_resurface';
    item: TodayItem;
  }[];
};
```

`TodayItem` means the existing **shared DTO**, not the internal repository type. `AccountEvidenceSnapshot` is the account/claims/routes/portfolio/unknowns/conflicts/fingerprint snapshot, not `AccountRecord`. Reuse existing structural schemas and constituent limits. Validate unique accounts, route-to-account ownership, exact Today cycle/action identity, safe integer counters and ISO times. IDs are nonempty strings, not UUID-only. Command IDs use domain-compatible trim/min validation. Both reads accept zero arguments. Channels are `local-workspace:get`, `local-workspace:get-commitments`, `local-workspace:transition`.

## Task 1: Strict local bridge and retained-work projection

**Files:**
- Create `src/shared/contracts/localWorkspaceContract.ts`.
- Create `src/main/workspace/localWorkspaceProvider.ts` and `src/main/workspace/registerLocalWorkspaceIpc.ts`.
- Create `src/main/domain/workspace/localWorkspaceReadService.ts`.
- Modify `src/main/domain/founderSalesDomain.ts` only to share the Today projection and add `getLocalCommitments()`.
- Modify `src/main/ipc/registerApplicationIpc.ts` and `src/preload/createCallieApi.ts`.
- Create `src/preload/apis/localWorkspaceApi.ts`.
- Test `tests/main/localWorkspaceReadService.test.ts`, `tests/main/localCommitments.test.ts`, `tests/main/localWorkspaceIpc.test.ts`.
- Update exact registration/preload fixture expectations in `tests/main/registerApplicationIpc.test.ts`, `tests/main/foundationRuntime.test.ts`, `tests/integration/preload.test.ts` and existing API-shape fixtures if required.

**Interfaces:** Consumes `FoundationRuntime.withDatabase/withDomain`, `FounderSalesDomain.transitionWorkflow`, `readWorkflowMode`, `AccountRepository.snapshot` and existing Today builder/DTO mapping. Produces the frozen `callie.localWorkspace` interface. No change to daily DTO or authority.

- [ ] **Step 1: Write behavioral failing read/transition tests.** Reuse `createTempDatabase`, real migration registry and production repositories from `meetingFirstUpgrade.test.ts`. Read with no pairing and with `PRAGMA query_only=ON`. Assert no added mode row, account writes, authority or receipts. Transition through the actual provider, then read/replay and reopen the same database. Include the raw domain return's extra `expectedMode` field so strict response rejection after commit is caught.

```ts
const before = database.raw.prepare('SELECT * FROM workspace_workflow_state').all();
const snapshot = await api.get();
expect(snapshot).toMatchObject({scope: 'local_database', workflowMode: 'legacy', transitionReceipt: null});
expect(database.raw.prepare('SELECT * FROM workspace_workflow_state').all()).toEqual(before);
const request = {commandId: 'local-command', expectedMode: 'legacy' as const, manifestId: 'local-manifest'};
const receipt = await api.transition(request);
expect(localWorkflowReceiptSchema.parse(receipt)).toEqual(receipt);
expect(Object.hasOwn(receipt, 'expectedMode')).toBe(false);
expect((await api.get()).transitionReceipt).toEqual(receipt);
expect(await api.transition(request)).toEqual(receipt);
```

- [ ] **Step 2: Observe RED** with Node24 `npx vitest run tests/main/localWorkspaceReadService.test.ts tests/main/localWorkspaceIpc.test.ts`. Resolve harness errors before counting behavioral RED.
- [ ] **Step 3: Implement the narrow reader/provider/registrar.** `get()` uses a current Foundation database lease and one deferred read snapshot. Enumerate `pm_accounts` in stable ID order and project all snapshots at one main clock instant. Do not silently truncate. A projection failure yields `accounts.state='unavailable'`, never partial success. Receipt/status failure rejects the whole read. `getCommitments()` separately enters `withDomain`; Today owns its transaction.

```ts
return {
  get: () => runtime.withDatabase(database => readLocalWorkspace(database)),
  getCommitments: () => runtime.withDomain(domain => domain.getLocalCommitments()),
  transition: command => runtime.withDomain(domain =>
    projectLocalWorkflowReceipt(domain.transitionWorkflow(command))),
};
```

`readLocalWorkspace` and `projectLocalWorkflowReceipt` are Task 1 exports from the new read-service file. Explicit projection emits only the 13 public receipt fields. The read validates persisted JSON and exact row command/manifest IDs, runtime `expectedMode:'legacy'`, SHA-256 of the existing canonical command serializer, state revision/time and row timestamp. Detect multiple receipts, do not choose arbitrary latest. Missing receipt with meeting-first mode is not exact-command proof. Inconsistent state fails closed. Do not insert a mode row while reading. Keep handlers lifecycle owned, trusted-sender checked, arity checked, response validated and rollback/disposal idempotent.

- [ ] **Step 4: Add failing evidence-based retained-feed tests.** Use actual callback activity linked to exact cycle/person, not only `due_source`. Cover callback, earlier non-call post-stage, onboarding, inbound, warm relationship and due founder snooze. Negative controls: unproven `promised_follow_up`, future due, opt-out/deleted, manifest parked, malformed record. Assert exact action ID/effective due, lane order, `later` metadata and diagnostic count. Compare before/after transition without mutating the source through reads.

```ts
expect(result.items.map(row => [row.kind, row.item.action.id])).toContainEqual(['callback', callbackActionId]);
expect(result.items.some(row => row.item.action.id === unprovenAutomaticActionId)).toBe(false);
expect(result.items.find(row => row.item.action.id === callbackActionId)?.item.action.dueAt).toBe(callbackAt);
expect(result.reviewErrorCount).toBe(expectedReviewErrors);
```

- [ ] **Step 5: Implement main classification before DTO mapping.** Share existing getToday projection instead of duplicating it. Preserve scheduler filtering/order/deduplication. Tag priority: onboarding, activity-proven callback, post-stage, inbound, due founder return, warm relationship. Membership is existing protected work (`commitment != null`, warm, onboarding, inbound), plus separately tagged due validated founder resurface. Never parse display reason or trust workIntent alone. Do not derive feed membership from transition receipt arrays.
- [ ] **Step 6: Add malformed/corrupt/lifetime tests and observe GREEN.** Reject extra args, arbitrary scope, foreign route ownership, invalid receipt fingerprint/time, duplicate state/receipt, unavailable gate and untrusted sender. Account corruption must not hide a valid committed receipt. Verify all three handlers unregister and no handle survives gate callbacks.
- [ ] **Step 7: Run focused tests, typecheck, owned ESLint, diff check. Commit only Task 1 files** as `feat: expose safe local workspace transition and retained work`. Report exact source SHA, RED/GREEN counts and frozen API to coordinator.

## Task 2: Settings transition and Native Desk local composition

**Files:**
- Create `src/renderer/foundation/WorkflowSection.tsx` and colocated tests.
- Modify `src/renderer/foundation/SettingsScreen.tsx`, `src/renderer/app/FounderApp.tsx` only for API injection.
- Modify `src/renderer/features/today/NativeDeskRoute.tsx`, `nativeDesk.css`, `nativeDesk.fixture.ts`.
- Create `src/renderer/features/today/RetainedWork.tsx`, `LocalAccountLibrary.tsx` and colocated tests.
- Update only affected route/component fixture types and Settings tests. Coordinator owns `tests/browser`, `tests/fixtures/nativeDeskBrowser.tsx`, `tests/e2e`, and packaged fixture builder.

**Interfaces:** Consumes Task 1 `api.localWorkspace`, unchanged `daily/delegation/linkedin` and explicit `onOpenLead(personId)`. Preserves `NativeDeskRoute({api,onOpenLead,surface?,legacy?})`. Browser-safe `nativeDeskFixture` gains deterministic local API records/setters without node/Vitest imports or I/O. Expose local snapshot/commitments fixture constructors for coordinator tests.

- [ ] **Step 1: Write failing actual React tests for Settings.** Mount under Data & storage. Mount performs reads only. Transition requires explicit one-way acknowledgement. Double click produces one immutable request. Simulate commit followed by lost response and recover through canonical `get()`, not invented applied status. Reopen with applied receipt must submit zero commands. Failed status leaves controls held. Same-view explicit retry uses exact command and manifest IDs.

```ts
expect(fixture.calls.filter(call => call.method === 'localWorkspace.transition')).toHaveLength(0);
fireEvent.click(screen.getByRole('checkbox', {name: /one-way local change/i}));
fireEvent.click(screen.getByRole('button', {name: 'Switch to Native Desk'}));
await screen.findByText(/Native Desk is active/i);
expect(fixture.calls.filter(call => call.method === 'localWorkspace.transition')).toHaveLength(1);
```

- [ ] **Step 2: Observe RED, then implement `WorkflowSection`.** Read mode/receipt before allocating a request. Keep request only in current component/session lifetime, never persistent storage. Main status determines applied state. On unknown result, offer read-only Check status and exact Retry same transition, not a fresh command. Prevent stale/unmounted responses updating a new view. Copy explains retiring superseded acquisition, preserving history/commitments, no worker activation. Do not call preservedActionIds count a count of due promises.
- [ ] **Step 3: Write failing Native Desk integration tests.** Unpaired meeting-first daily snapshot remains empty/scope_unknown while a separate local callback appears first inside Calls. Selection renders pure detail and invokes no outbound/preparation/getBrief command. Only explicit Open contact workspace calls navigation. Local account selection stays read-only and never changes daily/authority. Test unavailable reads separately from empty success.

```ts
expect(screen.getByText('Existing commitments and relationships')).toBeVisible();
fireEvent.click(screen.getByRole('button', {name: /Retained callback/}));
expect(openLead).not.toHaveBeenCalled();
expect(fixture.calls.every(call => !/prepare|approve|begin|sync/.test(call.method))).toBe(true);
fireEvent.click(screen.getByRole('button', {name: 'Open contact workspace'}));
expect(openLead).toHaveBeenCalledWith(retainedPersonId);
```

- [ ] **Step 4: Compose separate reads with honest failure states.** Local overview and retained feed never enter the scoped daily object. Retained work uses namespaced cycle/action keys and main tags. Keep effective action/lane metadata, including non-call and later work. Read failure retains any old view only as visibly stale and prevents stale navigation. Inconsistent mode snapshots show a refreshable hold, not an invented mode. Do not remount LegacyTodayRoute inside meeting-first, including hidden/collapsed mounts. Unknown worker scope copy must say not connected/unavailable, not zero stored records. Keep all three lanes, small Campaigns and existing approval/reconciliation gates.
- [ ] **Step 5: Preserve editor/selection lifetimes.** Local refresh must not replace selected email DOM or reset caret/text. Recompute keys deterministically and keep exact selection through unrelated local reads. Add race tests for late response after navigation, current read failure and recovery, account-unavailable with valid receipt, and daily/local mode mismatch. Account library is explicitly Local account library, with no execution controls or full-research claims.
- [ ] **Step 6: Run focused renderer tests, typecheck, owned ESLint and diff check. Commit** as `feat: connect Native Desk with retained local commitments`. Report exported fixture signatures and exact SHA for acceptance.

## Task 3: Real composition, Chromium and exact package acceptance

**Files:**
- Create `tests/integration/localWorkspaceComposition.test.tsx` using existing encrypted fixture patterns and real Task 1 reads.
- Modify `tests/browser/nativeDesk.spec.ts`, `tests/fixtures/nativeDeskBrowser.tsx` for local feed/status fault controls.
- Modify `tests/e2e/meetingFirstWorkspace.spec.ts`, `tests/support/packagedFixtureDatabase.ts` only for genuine owned-profile seeding and UI transition acceptance.
- Add `docs/acceptance/local-native-desk.md` with requirement-to-evidence map and explicitly blocked paired-worker boundary.

**Interfaces:** Consumes frozen Task 1 API and Task 2 actual components/fixture factory. No production-only acceptance bypasses. Existing exact signed app loads normal production repositories and real IPC.

- [ ] **Step 1: Add reader-to-React RED probes.** Seed genuine callback evidence and separate PM account. Unpaired source read composed into actual components must expose local records while all worker action controls remain held. Use before/after read snapshots of lifecycle, receipts and authority to prove no mount writes. Repeat after explicit transition and process/database reopen.
- [ ] **Step 2: Extend actual Chromium checks.** Drive explicit Settings acknowledgement, lost response/status recovery, same request retry, retained keyboard selection/CTA, unavailable/empty states, exact action IDs, local account isolation, stale-response cancellation. Preserve existing18 groups. Check1440x900 and1050x700, light/dark, both densities, all three lanes, no horizontal overflow and reachable controls. Preserve email node identity, caret and text across local reads.
- [ ] **Step 3: Extend packaged fixture setup.** Follow existing genuine mock-keychain-envelope pattern: bootstrap only an owned temp profile, obtain its synthetic recovery material by IPC, normally stop, offline seed its encrypted DB using production repositories, relaunch the same binary. Add PM-account and genuine callback fixture support without trusted-workspace injection, fake pairing credentials, trust-store changes, TLS disabling or fuse changes.
- [ ] **Step 4: Test the actual packaged UI path.** Unpaired legacy app → Settings/Data & storage → acknowledgement → Switch to Native Desk → Today retains callback → explicit read-only local account selection → restart preserves local mode/receipt/records. Verify daily still has null scope and worker operations stay held. Run accessibility with existing Electron-compatible `setLegacyMode(true)`.
- [ ] **Step 5: Run independent source review and close reproducible findings.** Pin exact commits, inspect producer/consumer composition, receipt recovery, pure mounts and lifetimes. Each fix has behavioral RED/GREEN and scoped re-review. Do not repeatedly expand a closed review into unrelated work.
- [ ] **Step 6: Run all final gates serially on clean exact HEAD.** `npm run verify`, `npm run verify:lambdas`, `npm run test:browser:native-desk`, source/history secrets, separate signed candidate build, extracted package secrets, full packaged E2E, strict parent/helper/native signature and fuse verification. Reuse inspected private release scripts with only new source/candidate labels. Record any flaky/retried result honestly and retain failed logs.
- [ ] **Step 7: Commit acceptance changes and evidence documentation.** Exact final candidate marker must match the commit verified by final gates, rebuild after any product/test source change that affects packaging. Do not claim paired execution passed: genuine paired worker acceptance is separate and blocked, not weakened.

## Task 4: Controlled local rollout and verification

**Files:** Private receipts/backup manifests under a new run directory in `$JCODE_SCRATCH_DIR`; delivery handoff in Downloads. No real profile content, keys or customer data committed.

**Interfaces:** Consumes exact signed candidate and verified Task 3 evidence. Uses installed application normal UI and the new supported transition command, never raw SQL or debug injection.

- [ ] **Step 1: Confirm exact candidate, installed process path and user-approved scope.** Source/test wiring and local transition were requested. Stop for any newly required grant, live outreach, purchase, deployment or destructive operation; none is part of this plan.
- [ ] **Step 2: Normally quit the installed app and verify handles closed.** Create a fresh full encrypted-profile and installed-app backup, restrictive permissions, before/copied/after hash manifests. Preserve the prior rollback app. Do not reuse an earlier backup from before newer sourcing receipts.
- [ ] **Step 3: Stage and install only the verified candidate into `/Applications`.** Check full candidate/installed manifest equality, signatures and marker. Leave old repo canonical output unchanged. Verify profile bytes untouched by installation before launch.
- [ ] **Step 4: Launch the exact installed app, observe supported status, then explicitly switch locally through Settings acknowledgement.** Recover lost responses from canonical receipt. Do not resubmit fresh commands on timeout. If Accessibility cannot reach the user's Space, report the exact visible step rather than moving Spaces or bypassing the app boundary.
- [ ] **Step 5: Observe real Native Desk, local retained-work status, account library and all three lanes.** Existing empty due queue may honestly remain empty. An unpaired worker remains visibly unavailable. Do not fabricate a filled demo dashboard or migrate parcel owners into accounts. Record exactly what is observed, what is fixture-proven and what is still blocked.
- [ ] **Step 6: Deliver concise handoff and next useful step.** Explain local workspace is connected, preserved work is accessible, and any genuine setup boundary remains. Keep the existing source-cited one-firm unsent artifact available. Do not turn that artifact into a requested-followup receipt without the actual request/call/authority evidence.

## Acceptance map

| Requirement | Concrete evidence |
|---|---|
| Local mode transition with exact recovery | Strict IPC roundtrip, real receipt read/reopen, actual Settings lost-response tests, packaged UI/restart |
| Preserved obligations visible, no legacy acquisition revival | Real main evidence fixture before/after transition, actual React and packaged retained row |
| Local account viewing without worker identity | Query-only source test, unpaired actual UI, null daily scope unchanged |
| Pure mounts, explicit navigation | Command-spy negative controls and actual reader table snapshots |
| Stable approved layout/editing | Real Chromium geometry, keyboard, editor DOM/caret/text across refresh |
| Unsupported execution remains held | Unpaired daily contract, disabled worker controls, zero fixture provider actions |
| Existing behavior preserved | Full root/Lambda/browser/package regression, invariant and source-intake fixtures |
| Installed outcome, not just source | Fresh verified backup/install receipts and supported real UI observations |

## Self-review

This scope completes approved local D3/D4 reachability, not the entire worker/campaign launch. Task 1's interface is consumed verbatim by Task 2. Task 3 owns browser/package files so workers cannot overwrite coordinator acceptance. No schema change, trusted-ID source, cloud action or release-security relaxation is needed. Warm relationships are labelled separately from promises. Account projection failures do not erase receipt recovery. Today reads retain their own transaction. The full immutable preservation manifest stays local rather than being widened into an unvalidated IPC payload.
