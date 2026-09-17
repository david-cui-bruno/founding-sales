# First-use Workflow Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task, only after coordinator GO. The coordinator chooses execution mode and owns commits. This documentation assignment authorizes neither implementation nor subagents.

**Goal:** connect one selected local company to inspectable research, a reviewed saved contact and a first unsent local draft, with truthful setup/capacity and capability-preview starts.

**Architecture:** extend the existing local-workspace IPC with selected reads/research/link admission and capacity CAS. Reuse the bounded researcher with an exact selected claim, existing import/contact/email owners, phone confirmation and worker pairing. Preserve all execution gates and classify incomplete campaign/reply/worker starts as previews/history, not working approval flows.

**Tech Stack:** TypeScript, React, Zod, Electron validated IPC/preload, encrypted SQLite, existing Vitest/Testing Library and coordinator-run public/packaged acceptance.

**Spec:** [First-use workflow repair](../specs/2026-09-10-first-use-workflow-repair.md). Read it together with the [program](../2026-09-10-product-repair-program.md), [list-reliability plan](2026-09-10-list-reliability-repair.md) and [shared-presentation plan](2026-09-10-shared-presentation-repair.md).

## Global Constraints

- No production edits, execution, tests or commits under documentation-only GO.
- Coordinator owns implementation/runtime GO, acceptance scheduling and commits. One implementation worker at a time.
- Use disposable fictional workspaces for future acceptance. No installed app, real profile, keys, real-data research, grants, deployment, send, call or calendar write is authorized.
- No offline product mode, new security framework, new provider, new queue, scheduler or generic execution endpoint.
- Preserve identity, aliases, history, suppression, consent, account/contact versions, CAS, fingerprints, OriginalCallRef, command receipts and exact authority/approval gates.
- Never infer a person's direct route from a company office phone, team mailbox or company LinkedIn publication. Role/title is not decision-making authority.
- No queue-wide prepare/runNext shortcut for selected-company research. No automatic research, import, pairing, configuration, sync, bootstrap, generation, approval or execution on route mount/refresh.
- Preserve common presentation and modal ownership. Preserve the global contact/import owners and existing durable draft/unknown-command sessions.
- Future npm/npx invocations require `export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"`. Preserve existing ABI137. Never rebuild native dependencies to hide a failure.

---

## 0. Decisions, leases and evidence before execution

**All tasks below are unchecked planned work. No RED/GREEN or public acceptance has been executed by this planner.** The spec records source checkpoint hashes, not a clean tree. `FounderApp.tsx` currently has the native Import listener already. Preserve it.

Coordinator must disposition spec section 10 before implementation: minimum real importer-admitted contact route versus independently verified person/PM route, F10 preview alternative versus full starts, draft-bound authority-read contract, continuity owner/API, and external capability limits. No task below silently implements the optional worker/campaign/reply extension.

**Mandatory handoffs:**

- **H-M:** current modal owner releases accepted `NativeDeskRoute.tsx`, `TodayRoute.tsx`, `LeadInspectorProvider.tsx`, `InspectorOverview.tsx`, Import/modal consumers and corresponding tests. Root/overlay helpers/global CSS stay read-only to first-use workers. New first-use panels are inline.
- **H-L:** list owner releases `founderSalesDomain.ts`, `FounderApp.tsx`, `routeRegistry.tsx` and cursor behavior. Preserve complete review metadata, startup badge, exact bulk set, and cursor invalid/stale handling. Selector does not implement another cursor algorithm.
- **H-C:** continuity owner names and releases selected-account/unknown-command owner and refresh invalidation contract above route keys. This plan proposes `src/renderer/features/today/localCompanyContinuation.ts` as the adapter location. It is not known to exist. If the owner chooses another path, coordinator amends Task 4 before execution. Never create both owners.
- **H-A:** coordinator owns `package.json`, release metadata and frozen `tests/fixtures/applicationPresentationBrowser.tsx`, `tests/fixtures/nativeDeskBrowser.tsx`, `tests/fixtures/nativeDeskCompositionBrowser.tsx`. Typed public additions require an inventory and an explicit fixture integration checkpoint, not optional fake defaults. Any newly discovered shared consumer requires a lease, not opportunistic edits.

Every task ends with focused checks, exact owned-file hash freeze, independent review and coordinator-controlled isolated commit. Suggested commit subjects are handoff metadata, not worker permission to commit. One reviewer can reject a task without forcing unrelated settings/copy work into the same patch.

### Future command convention, never executed during planning

For an explicitly authorized task, the coordinator can run its exact tests from the inventory below using:

```bash
first_use_check() {
  export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"
  npx vitest run "$@"
}
```

Exact future invocations, each requiring separate coordinator execution GO:

```bash
# Task 1
first_use_check tests/main/accountRepository.test.ts tests/main/localWorkspaceIpc.test.ts tests/main/registerApplicationIpc.test.ts
# Task 2
first_use_check tests/main/selectedCompanyResearch.test.ts tests/integration/companyResearchRestart.test.ts
# Task 3
first_use_check tests/integration/companyResearchStartup.test.ts tests/main/localWorkspaceIpc.test.ts tests/main/registerApplicationIpc.test.ts
# Task 4
first_use_check src/renderer/features/today/LocalCompanyResearchPanel.test.tsx src/renderer/features/today/LocalWorkspace.test.tsx src/renderer/app/FounderApp.test.tsx src/renderer/features/today/localCompanyContinuation.test.ts
# Task 5
first_use_check tests/main/reviewedCompanyPersonLink.test.ts tests/main/localWorkspaceIpc.test.ts
# Task 6
first_use_check src/renderer/features/today/LocalCompanyContactLink.test.tsx src/renderer/features/today/LocalWorkspace.test.tsx src/renderer/app/FounderApp.test.tsx
# Task 7
first_use_check tests/main/emailService.test.ts tests/main/registerOutreachIpc.test.ts src/renderer/features/leadInspector/OutboundComposer.test.tsx
# Task 8
first_use_check src/renderer/foundation/PhoneSetupSection.test.tsx src/renderer/foundation/settingsNavigation.test.ts src/renderer/foundation/SettingsScreen.test.tsx
# Task 9
first_use_check src/renderer/foundation/WorkerSetupSection.test.tsx src/renderer/foundation/SettingsScreen.test.tsx
# Task 10
first_use_check tests/main/localCallSettings.test.ts tests/main/localWorkspaceIpc.test.ts src/renderer/foundation/CallCapacitySection.test.tsx src/renderer/foundation/SettingsScreen.test.tsx
# Task 11
first_use_check src/renderer/features/today/firstUseCapabilities.test.ts src/renderer/features/campaigns/CampaignReview.test.tsx src/renderer/features/today/LocalWorkspace.test.tsx
# Task 12 public composition only, packaged acceptance separately scheduled
first_use_check tests/integration/firstUseWorkflowComposition.test.tsx
```

Coordinator selects/runs SQL/native-dependent, browser, full-suite, typecheck, build/package and exact-head release jobs. Tests involving encrypted SQLite are not described as pure no-native tests. No dependencies or native bindings are rebuilt by this plan.

## File and interface map

| Unit | Exact primary files | Responsibility |
| --- | --- | --- |
| Shared local contract | `src/shared/contracts/localWorkspaceContract.ts` | Strict selected detail/research/link/settings requests and bound responses |
| Selected repository | `src/main/domain/accounts/accountRepository.ts` | Complete detail, exact queue status/claim, reviewed link with original receipt/CAS |
| Local bridge | `src/main/workspace/localWorkspaceProvider.ts`, `src/main/workspace/registerLocalWorkspaceIpc.ts`, `src/preload/apis/localWorkspaceApi.ts` | Real leased/validated public path |
| Runtime composition | `src/main/startApplication.ts`, `src/main/ipc/registerApplicationIpc.ts` | Current capability getter, existing research lifetime and bounded ports |
| First-use UI | `src/renderer/features/today/LocalAccountLibrary.tsx`; new `LocalCompanyResearchPanel.tsx`, `LocalCompanyContactLink.tsx` | Inline evidence/research and exact saved-person relationship review |
| Continuity join | proposed `src/renderer/features/today/localCompanyContinuation.ts`; `src/renderer/app/FounderApp.tsx`, `routeRegistry.tsx`, `features/today/NativeDeskRoute.tsx` | Adapter into H-C owner, not a second session store |
| Email hold | `src/shared/contracts/outreachContract.ts`, `src/main/outreach/emailService.ts`, `src/main/ipc/registerOutreachIpc.ts`, `src/preload/apis/outreachApi.ts`, `src/renderer/features/leadInspector/OutboundComposer.tsx`, `InspectorOverview.tsx` | Exact saved-draft ownership read and truthful UI only |
| Settings | `src/renderer/foundation/SettingsScreen.tsx`; new `settingsNavigation.ts`, `PhoneSetupSection.tsx`, `WorkerSetupSection.tsx`, `CallCapacitySection.tsx` | Separate reachable setup and capacity sections |
| Capacity facade | `src/main/domain/founderSalesDomain.ts`, `src/main/domain/workspace/workspaceSettingsRepository.ts` | Existing repository CAS under its matching write scope |
| F10 truth | `src/renderer/features/campaigns/CampaignReview.tsx`, `src/renderer/features/today/DailyAnswers.tsx`, `NativeDeskRoute.tsx`; new `firstUseCapabilities.ts` | Read-only history/previews, no execution backend |

`CallieApi` is inferred from `src/preload/createCallieApi.ts`. `CalliePreloadApi` combines it with AppleSpike. Do not invent a separately maintained handwritten DelegationApi. Re-inventory structural fixtures whenever required APIs change.

### Public channel additions

| Channel | Request | Response | Safe error |
| --- | --- | --- | --- |
| `local-workspace:get-company` | `SelectedCompany` | `LocalCompanyDetail` | `LOCAL_COMPANY_READ_FAILED` |
| `local-workspace:research-company` | `SelectedResearch` | `LocalCompanyResearchStatus` | `LOCAL_COMPANY_RESEARCH_FAILED` |
| `local-workspace:company-research-status` | `SelectedResearch` | `LocalCompanyResearchStatus` | `LOCAL_COMPANY_RESEARCH_STATUS_FAILED` |
| `local-workspace:link-company-person` | `LinkCompanyPersonRequest` | `AccountEvidenceReceipt` | `LOCAL_COMPANY_LINK_FAILED` |
| `local-workspace:get-call-settings` | none | `MeetingFirstAccountCallSettings` | `LOCAL_CALL_SETTINGS_READ_FAILED` |
| `local-workspace:update-call-settings` | `UpdateCallSettingsRequest` | `MeetingFirstAccountCallSettings` | `LOCAL_CALL_SETTINGS_UPDATE_FAILED` |
| `outreach:inspect-local-authority` | `DraftRevisionRequest` | `LocalEmailAuthorityRead` | `EMAIL_AUTHORITY_READ_FAILED` |

Schema exports use names `selectedCompanySchema`, `selectedResearchSchema`, `localCompanyDetailSchema`, `localCompanyResearchStatusSchema`, `linkCompanyPersonRequestSchema`, `accountEvidenceReceiptSchema`, `meetingFirstAccountCallSettingsSchema`, `updateCallSettingsRequestSchema`, `localEmailAuthorityReadSchema`. Add the receipt schema next to the local bridge schema, do not duplicate its runtime shape across layers. Every response refinement checks exact input identities. Semantic holds are data, unexpected transport/database failures remain safe rejections. No generalized IPC error/security framework.

## Task 1: Complete selected-company detail through the public bridge

**Dependencies:** coordinator GO, H-L facade/registrar lease and H-A fixture inventory.

**Modify:** `src/shared/contracts/localWorkspaceContract.ts`, `src/main/domain/accounts/accountRepository.ts`, `src/main/workspace/localWorkspaceProvider.ts`, `src/main/workspace/registerLocalWorkspaceIpc.ts`, `src/preload/apis/localWorkspaceApi.ts`.
**Tests:** modify `tests/main/accountRepository.test.ts`, `tests/main/localWorkspaceIpc.test.ts`, `tests/main/registerApplicationIpc.test.ts`.

**Consumes:** `snapshot(accountId, asOf): AccountEvidenceSnapshot`, `listLinks(accountId, asOf): AccountLink[]`, existing runtime `withDatabase/withDomain` and validated IPC lifecycle.
**Produces:** `AccountRepository.readLocalCompanyDetail(accountId: string, asOf: string): LocalCompanyDetail`; `LocalWorkspaceApi.getCompany(input: SelectedCompany): Promise<LocalCompanyDetail>` exactly as spec section 3.

- [ ] Write behavioral REDs: selected detail excludes another account's sources/links; displays complete admitted records rather than source IDs alone; read failure is rejection, not empty available; no table changes. In existing account fixture, add this minimal API behavior check, then richer two-account source/link fixtures using existing source-attestation setup:

```ts
it('reads one real saved account without changing it', async () => {
  const f = await createPmFixture();
  try {
    const a = f.repo.create({ commandId: randomUUID(), name: 'Selected', domain: 'selected.invalid' });
    const before = f.repo.snapshot(a.id, PM_NOW);
    const detail = f.repo.readLocalCompanyDetail(a.id, PM_NOW);
    expect(detail).toEqual({ scope: 'local_database', generatedAt: PM_NOW,
      snapshot: before, sources: [], links: [] });
    expect(f.repo.snapshot(a.id, PM_NOW)).toEqual(before);
  } finally { f.close(); }
});
```

- [ ] Coordinator observes RED in the three exact test files above. Missing API failure is only the first RED, retain cross-account and no-write behavioral assertions after wiring.
- [ ] Implement strict schemas and complete read in the repository's existing `readSnapshot` transaction. Read `pm_account_sources` for the selected account and parse each stored source. Never add `.limit(50)` to a selected evidence read. Use `snapshot/listLinks` inside the same read transaction. Add real provider/registrar/preload functions and all rollback disposers:

```ts
// Import SystemClock from '../domain/support/clock' and UuidGenerator
// from '../domain/support/idGenerator' in localWorkspaceProvider.ts.
const domainClock = new SystemClock();
const domainIds = new UuidGenerator();
// Body of the new provider method, using the existing runtime lease:
getCompany: input => {
  const { accountId } = selectedCompanySchema.parse(input);
  return runtime.withDatabase(database => {
    const repo = new AccountRepository({ database, clock: domainClock, ids: domainIds });
    return repo.readLocalCompanyDetail(accountId, domainClock.now());
  });
}
```

`SystemClock` and `UuidGenerator` are actual production support exports. `domainClock/domainIds` above are local instances, not exports from startup. Constructors do not fetch, create accounts or read credentials.
- [ ] GREEN includes wrong-account responses rejected by both registrar/preload, untrusted sender refusal, registration rollback and disposal. Coordinator integrates strict fixture consumers before full typecheck. Freeze/review. Commit subject: `feat: expose selected local company evidence`.

## Task 2: Scope queue claiming and read-only research status

**Dependencies:** Task 1. No renderer or cloud-store changes.

**Modify:** `src/main/domain/accounts/accountRepository.ts`, `src/shared/contracts/localWorkspaceContract.ts`.
**Tests:** create `tests/main/selectedCompanyResearch.test.ts`; extend `tests/integration/companyResearchRestart.test.ts`.

**Consumes:** existing `ResearchJob`, `ResearchLimits`, account receipt/claim/settlement machinery.
**Produces:** `claimSelected(asOf: string, input: SelectedResearch): ResearchJob | null`; `readSelectedResearch(input: SelectedResearch): LocalCompanyResearchStatus`. Both are main-only repository methods.

- [ ] Write exact-selection RED using the existing PM fixture and real repository. Imports are `AccountRepository` from its production path, `createPmFixture/PM_NOW` from `tests/fixtures/pmAccounts`, and `randomUUID/it/expect` as in Task 1:

```ts
it('never claims the older unrelated queued job', async () => {
  const f = await createPmFixture();
  try {
    const repo = new AccountRepository({ database: f.db,
      clock: { now: () => PM_NOW }, ids: { next: randomUUID },
      research: { maxBudgetMicros: 1000 } });
    const a = repo.create({ commandId: randomUUID(), name: 'Older', domain: 'older.invalid' });
    const b = repo.create({ commandId: randomUUID(), name: 'Selected', domain: 'selected.invalid' });
    const older = { commandId: randomUUID(), accountId: a.id };
    const selected = { commandId: randomUUID(), accountId: b.id };
    const limits = { maxCompanies: 1, maxPages: 3, maxBytes: 10000, maxCostMicros: 100 };
    repo.enqueue({ ...older, limits }); repo.enqueue({ ...selected, limits });
    const job = repo.claimSelected(PM_NOW, selected);
    expect(job?.accountId).toBe(b.id);
    expect(repo.readSelectedResearch(older).state).toBe('queued');
    expect(repo.readSelectedResearch(selected).state).toBe('running');
    expect(job?.receiptCommandId).not.toBe(selected.commandId);
  } finally { f.close(); }
});
```

- [ ] Add separate REDs for unrelated expired running row left untouched, unrelated committed receipt not recovered, selected committed receipt recovered without HTTP, global exhausted/unknown spend still blocking selected work, and wrong account for same command rejected. Observe RED in the two named files.
- [ ] Refactor claim internals without nested transactions. An internal optional scope may be used only inside the SQL repository, not added to the cross-cloud `AccountResearchStore` interface. Apply exact predicates before mutation in each path:

```sql
-- Append to selected receipt recovery, expired parking and queued selection.
AND j.command_id = ? AND j.account_id = ?
-- Global spend intentionally remains unscoped:
SELECT COALESCE(SUM(COALESCE(cost_micros,reserved_cost_micros)),0) AS total
FROM pm_account_research_jobs;
```

For the update without alias use `command_id`/`account_id`. Preserve current attempt cap, receipt-before-budget recovery, claim tokens and uncertainty parking. Status first detects existing command with another account, then follows job `receipt_command_id`/job `id` to the exact evidence command and account. Validate receipt payload, never conflate UI command with evidence command.
- [ ] GREEN requires repeated status reads produce no `total_changes` delta, replay does not change limits, old claim cannot admit/settle after fencing, and restart recovers committed selected work without additional HTTP. Freeze/review. Commit subject: `fix: bind local research claims to selected company`.

## Task 3: Wire selected research into the existing runtime and IPC

**Dependencies:** Tasks 1-2 and coordinator startup/registrar lease.

**Modify:** `src/main/startApplication.ts`, `src/main/ipc/registerApplicationIpc.ts`, `src/main/workspace/localWorkspaceProvider.ts`, `src/main/workspace/registerLocalWorkspaceIpc.ts`, `src/preload/apis/localWorkspaceApi.ts`, `src/shared/contracts/localWorkspaceContract.ts`.
**Tests:** extend `tests/integration/companyResearchStartup.test.ts`, `tests/main/localWorkspaceIpc.test.ts`, `tests/main/registerApplicationIpc.test.ts`.

**Consumes:** Task 2 claim/status and unchanged `createCompanyResearchWorker`, startup config, fetched receipts and lifetime invalidation.
**Produces:** `SelectedCompanyResearchPort`, startup `researchCompany(input: SelectedResearch): Promise<LocalCompanyResearchStatus>`, local bridge `researchCompany/getCompanyResearchStatus` and optional current-capability getter from spec section 3. Define/export `SelectedCompanyResearchPort` in `localWorkspaceProvider.ts` as a main-only structural type. Registration options take `selectedCompanyResearch?: {current(): SelectedCompanyResearchPort | null}`.

- [ ] RED: real startup/provider/preload action researches only selected saved company, no discovery/create calls; missing capability holds before enqueue; current getter replacement/lock is honored; status remains available without research capability. Existing startup injected `companyResearchHttp`/resolve provide deterministic bytes, not a replacement parser or admission policy.
- [ ] Observe RED in the three listed files, including no implicit work during application registration.
- [ ] Extend startup `stores(active, selected?)` locally so its adapter scopes claiming before the worker runs:

```ts
claimNext: at => account(repo => selected
  ? repo.claimSelected(at, selected)
  : repo.claimNext(at)),
```

The selected method uses existing `invoke` single-flight/lifetime machinery with an internal signal, checks current saved status first, and enqueues only an absent explicit command using approved `config.researchLimits`. Existing jobs use their saved limits, not current configuration's fingerprint. Run the unchanged worker over the selected adapter and read back exact status. Do not expose startup audience `prepare` or global `runNext` on the renderer API. Provider handles absent capability as held for a new request but still returns persisted completed/running/parked state when present. No status call invokes settle.

Explicit `researchCompany(originalFrozenRequest)` replay is the execution recovery path, not another status endpoint. With restored capability, an existing queued request enters selected claiming without a replacement UUID or enqueue fingerprint. Unknown/not_recorded eventually permits explicit same-command replay through the same single-flight guard: if the original is still in flight, reject/hold as busy without concurrent acquisition; if it never enqueued and no flight remains, enqueue that same command once under current approved limits. Preserve existing saved limits when a row exists. Unexpired running work cannot reacquire, expired uncertain running work parks, and already parked ambiguous work is never reset/retried by replay. A running row with committed evidence may reconcile through selected receipt recovery without HTTP, even if the read-only projection already reports completed. Never invoke any of this on capability restoration, mount, polling or status-read completion.
- [ ] GREEN includes denied URL/private IP/redirect/page-budget failure, changed account version during fetch, lost response, cancellation/lock and receipt recovery. Maintain HTTP outside SQL write transactions and per-callback runtime leases. Freeze/review. Commit subject: `feat: expose guarded selected company research`.

## Task 4: Compose research UI with the continuity owner

**Dependencies:** Tasks 1-3, H-M/H-L/H-C/H-A. Stop if continuity contract is not released.

**Create:** `src/renderer/features/today/LocalCompanyResearchPanel.tsx`, `LocalCompanyResearchPanel.test.tsx`.
**Modify:** `src/renderer/features/today/LocalAccountLibrary.tsx`, `NativeDeskRoute.tsx`, `src/renderer/app/FounderApp.tsx`, `routeRegistry.tsx`; proposed continuity adapter `src/renderer/features/today/localCompanyContinuation.ts` only with H-C owner approval.
**Tests:** modify `src/renderer/features/today/LocalWorkspace.test.tsx`, `src/renderer/app/FounderApp.test.tsx`; create `src/renderer/features/today/localCompanyContinuation.test.ts` at H-C's accepted adapter path.

**Consumes:** exact account ID and Task 1/3 API. **Produces:** inline `LocalCompanyResearchPanel({accountId, api, continuation})` with `accountId: string`, `continuation: FirstUseContinuation` and `api: Pick<LocalWorkspaceApi,'getCompany'|'researchCompany'|'getCompanyResearchStatus'>`. Continuity adapter contract for this and Task 6:

```ts
export type FirstUseState = {
  selectedAccountId: string | null;
  research: { request: SelectedResearch; outcome: 'pending' | 'unknown' | 'known';
    status: LocalCompanyResearchStatus | null } | null;
};
export interface FirstUseContinuation {
  snapshot(): Readonly<FirstUseState>;
  subscribe(listener: () => void): () => void;
  update(next: FirstUseState): void;
}
```

The H-C owner supplies this adapter from its workspace-scoped state, not a module singleton. Task 6 extends `FirstUseState` with reviewed-link fields after Task 5 exports their types. Add `firstUse: FirstUseContinuation` to `RouteContext` and `NativeDeskRouteProps` at the coordinated handoff. This is proposed interface work, not a claim that the owner currently exports it.

**Narrow review correction:** prechange spec SHA-256 `db1d760ac036700cd489391348a025e3bba9d82cb1cc5c6e9a230e45ed873fe8`, prechange plan SHA-256 `ba530985cec55cde6d465cb203923c55c0b0124f085b542c914782d61c2ba02a`. Retain the new-command guard below. Add a separate explicit Resume action, not a relaxation that mints another UUID.

- [ ] RED: select account, click Research twice before promise resolves, navigate to Campaigns/back and import-refresh, then show same pending request. A Check status that finds the receipt can display completion without fetching; a Check status that finds queued/running/not_recorded does not itself resume work. Another account's late response cannot replace the selected detail.
- [ ] Add recovery REDs in Task 4's component tests and `tests/integration/companyResearchStartup.test.ts` from Task 3: (a) persisted selected command queued, capability unavailable then restored, repeated checks/mounts perform no execution, explicit Resume calls `researchCompany(originalFrozenRequest)` and completes the same command; (b) lost response becomes unknown, Check status returns not_recorded, later explicit Resume replays the original UUID when the prior UI invocation is no longer genuinely pending; (c) late original request versus replay and double Resume cannot acquire concurrently; (d) unexpired running and parked ambiguous work do not refetch or release reservations. Keep an older unrelated job unchanged in every recovery case. Assert same account, UUID, saved limits for an existing row, one selected job/receipt and no automatic work.
- [ ] Observe RED in the four listed component/continuity tests. Test `getCompany` failure separately from truly empty sources.
- [ ] Use `useSyncExternalStore` with H-C adapter. Event handler reserves request in the owner synchronously before awaiting IPC. Only explicit Research creates its UUID. Return-to-view displays/rechecks known request, never runs research from an effect:

```ts
const previous = continuation.snapshot().research;
if (previous && (previous.outcome !== 'known'
  || !previous.status || !['completed', 'parked', 'held'].includes(previous.status.state))) return;
const request = Object.freeze({ accountId, commandId: crypto.randomUUID() });
continuation.update({ ...continuation.snapshot(), research: { request, outcome: 'pending', status: null } });
try {
  const status = await api.researchCompany(request);
  if (continuation.snapshot().research?.request !== request) return;
  continuation.update({ ...continuation.snapshot(), research: { request, outcome: 'known', status } });
} catch {
  if (continuation.snapshot().research?.request !== request) return;
  continuation.update({ ...continuation.snapshot(), research: { request, outcome: 'unknown', status: null } });
}
```

Render source excerpt as `{source.excerpt}` in `<pre>`, hash/time/URL alongside it, and preserve fact/hypothesis/unknown/conflict labels. A returned `queued` or `running` status is known state, not permission for a new command. A later `not_recorded` read cannot prove an in-flight request never started, so retain the unknown request for same-command recovery. Task 6 adds active-link replacement guards. Workspace epoch checks come from H-C and must invalidate stale closures even if a new workspace reuses the same account ID. Do not store secrets in this owner.

- [ ] Add separate **Check status** and **Resume research** controls. Check calls only `api.getCompanyResearchStatus(originalFrozenRequest)` and may update displayed status, but must preserve `outcome: 'pending'` while an actual execution invocation is pending. Status responses never trigger Resume. Resume copy says “May fetch permitted sources or reconcile this existing attempt.” Only its explicit click handler executes the following same-request path:

```ts
async function resumeResearch() {
  const current = continuation.snapshot().research;
  if (!current || current.outcome === 'pending' || current.status?.state === 'parked') return;
  const originalFrozenRequest = current.request;
  continuation.update({ ...continuation.snapshot(), research: { ...current, outcome: 'pending' } });
  try {
    const status = await api.researchCompany(originalFrozenRequest);
    if (continuation.snapshot().research?.request !== originalFrozenRequest) return;
    continuation.update({ ...continuation.snapshot(), research: {
      request: originalFrozenRequest, outcome: 'known', status,
    } });
  } catch {
    if (continuation.snapshot().research?.request !== originalFrozenRequest) return;
    continuation.update({ ...continuation.snapshot(), research: {
      request: originalFrozenRequest, outcome: 'unknown', status: current.status,
    } });
  }
}
```

Retain the synchronous pending fence above route remounts through H-C. Show Resume for retained queued/running/held or unknown/not_recorded requests, and allow explicit receipt reconciliation if a completed projection still needs it. A component unmount or status response is not grounds to declare a still-live request no longer pending. Existing runtime lifetime invalidation or settled invocation can transition it to recoverable unknown. Main's independent single-flight/lifetime/selected-claim gates remain authoritative when IPC uncertainty hides an original live invocation. A busy rejection preserves request identity for another explicit check, not an automatic retry. Do not invoke this handler in effects, timers or after successful Check status. Disable Resume for known parked work; if its parked state was not yet known, main still refuses re-acquisition and returns the existing parked result. A separately reviewed new attempt is not a Resume and cannot release prior ambiguous spend.
- [ ] GREEN includes source HTML displayed as text, invalid source links not launched automatically, no eager API mutations, modal keyboard guards intact, selected-account retention through actual keyed route remount. Freeze/review. Commit subject: `feat: add selected company research review`.

## Task 5: Admit one reviewed saved-person relationship atomically

**Dependencies:** Tasks 1-2, H-L domain ownership if facade is touched. Import remains a separate transaction and unchanged.

**Modify:** `src/shared/contracts/localWorkspaceContract.ts`, `src/main/domain/accounts/accountRepository.ts`, `src/main/workspace/localWorkspaceProvider.ts`, `src/main/workspace/registerLocalWorkspaceIpc.ts`, `src/preload/apis/localWorkspaceApi.ts`.
**Tests:** create `tests/main/reviewedCompanyPersonLink.test.ts`; extend `tests/main/localWorkspaceIpc.test.ts`.

**Consumes:** Task 1 sources/links and real saved persons/contact routes from existing import.
**Produces:** exact `LinkCompanyPersonRequest`, `ReviewedPersonLink`, `admitReviewedPersonLink` and `linkCompanyPerson` from spec section 4.

- [ ] RED: two imported fictional people share an organization, review one quoted named person, admit only its link and preserve both identities/organizations/contact methods/history. Reject cross-account source, nonexact quote, absent/deleted/suppressed person, future validity, mismatched evidence set, confirmed authority and stale account version. Replayed committed request succeeds after later account changes, changed payload with same UUID refuses.
- [ ] Observe RED in both listed files. Use production importer/domain admission in fixtures, not raw replacement objects advertised as real person admission. Direct SQL fixtures remain explicitly scoped negative storage tests only.
- [ ] Implement the narrow command through existing `mutate` and a private link-insertion helper shared with `admitLinks`. Do not wrap the self-transactional `admitLinks` method:

```ts
const command = linkCompanyPersonRequestSchema.parse(input);
return this.mutate(command, 'reviewed_person_link', command, at => {
  this.requireEvidence(command.accountId, command.link.evidenceIds, at);
  if (command.link.validFrom > at) throw new Error('Future relationship validity');
  const person = this.raw.prepare(`SELECT 1 FROM persons p WHERE p.id=?
    AND p.deleted_at IS NULL AND p.opted_out=0
    AND NOT EXISTS(SELECT 1 FROM opt_out_tombstones t WHERE t.person_id=p.id)`)
    .get(command.link.personId);
  if (!person) throw new Error('Person unavailable for reviewed relationship');
  if (this.raw.prepare('SELECT 1 FROM pm_account_suppression_tombstones WHERE account_id=? LIMIT 1')
    .get(command.accountId)) throw new Error('Account suppressed');
  const quoted = new Set(command.sourceQuotes.map(item => item.sourceId));
  if (quoted.size !== command.link.evidenceIds.length
    || command.link.evidenceIds.some(id => !quoted.has(id))) throw new Error('Relationship evidence mismatch');
  for (const item of command.sourceQuotes) {
    const source = this.raw.prepare('SELECT excerpt FROM pm_account_sources WHERE account_id=? AND id=?')
      .get(command.accountId, item.sourceId) as { excerpt: string } | undefined;
    if (!item.quote.trim() || !source?.excerpt.includes(item.quote)) throw new Error('Relationship quote mismatch');
  }
  this.insertLink(command.accountId, command.link, at);
});
```

Define main-only `private insertLink(accountId: string, link: AccountLink, at: string): void` by extracting the unchanged insert body currently inside `admitLinks`, with `command.accountId` replaced by its `accountId` argument. Its three statements insert `pm_account_links`, the link's `pm_account_link_evidence` relationship rows, and any authority evidence rows for existing nonminimal callers. Existing `admitLinks` retains its own `requireEvidence` checks and calls this helper inside `mutate`. The new caller's strict schema fixes unconfirmed authority/empty authority evidence, and validates duplicate source IDs, quote/source lengths and exact field sets before the shown body. This extraction preserves existing insertion behavior without nested transactions. Do not infer identity semantics, authority, ownership or route verification from quote matching. Fingerprint the entire immutable request. No person/contact/route mutation.
- [ ] GREEN includes registrar/preload account-binding refusal, duplicate receipt rather than duplicate link, no nested domain/account transaction, unchanged historical contact rows and source-attestation rules. Freeze/review. Commit subject: `feat: admit reviewed local company person links`.

## Task 6: Use global import and paginated exact-person selection

**Dependencies:** Tasks 4-5 and H-M/H-L/H-C. This task is the real F08 contact/route admission join, not a new importer or PM route generator.

**Create:** `src/renderer/features/today/LocalCompanyContactLink.tsx`, `LocalCompanyContactLink.test.tsx`.
**Modify:** `src/renderer/features/today/LocalAccountLibrary.tsx`, `NativeDeskRoute.tsx`, `src/renderer/app/routeRegistry.tsx` and H-C continuation adapter only as leased.
**Tests:** extend `src/renderer/features/today/LocalWorkspace.test.tsx`, `src/renderer/app/FounderApp.test.tsx`.

**Consumes:** `leads.list`, `leadDetail.get({personId})`, `getCompany/linkCompanyPerson`, Task 4 continuation, existing `onOpenImport(): void`/`onOpenLead(personId: string): void`.
**Produces:** `LocalCompanyContactLink({detail, api, continuation, onOpenImport, onOpenLead})`, where `detail: LocalCompanyDetail`, `continuation: FirstUseContinuation`, callbacks have the signatures above, and `api` is `Pick<CalliePreloadApi,'leads'|'leadDetail'> & {localWorkspace: Pick<LocalWorkspaceApi,'getCompany'|'linkCompanyPerson'>}`. Widen NativeDeskApi only for `leads/leadDetail`, not generic IPC. Extend Task 4's `FirstUseState` with these fields after Task 5 provides `LinkCompanyPersonRequest`:

```ts
link: { request: LinkCompanyPersonRequest; outcome: 'pending' | 'unknown' | 'known' } | null;
review: { accountId: string | null; personId: string | null; role: string; relationship: string;
  sourceQuotes: { sourceId: string; quote: string }[] };
```

Initialize `link` to null and review to null account/person, empty text/quotes. Preserve a dirty review for its exact account on account switching by requiring explicit discard/return before editing a different account's review. A pending/unknown link cannot be discarded. Navigation away retains it under H-C. This is intentionally one reviewed intent at a time, not a new per-account draft database.

- [ ] RED: Import button opens the one global dialog, no local copy. Complete named-person import, return to same account, find person beyond first page, select exact ID, review quote and admit one link. Changing query while a response is pending cannot select stale result. Generic company mailbox/phone is never prefilled. No “verified person” badge is derived from import defaults.
- [ ] Observe RED in the three exact test files. Include failed detail read with stable close/back controls, and a source containing only office details that stays “Contact not established.”
- [ ] Query with exact public shape, append only matching-generation pages, and retain explicit selected person ID:

```ts
await api.leads.list({ query: '', stages: [], priorities: [],
  sort: 'person_name', cursor: null, limit: 50 });
// Load more repeats the same query/filter/sort/limit with returned nextCursor.
// Stale cursor keeps current review input and offers an explicit fresh search.
```

Show the selected person's real contact-method labels/ownership/validation plus source quote. Explicit review creates the immutable link request once, with `authority: 'unconfirmed'`, `authorityEvidenceIds: []`, `validTo: null`. Unknown result retains it and offers exact replay. Confirmed saved links expose `onOpenLead(link.personId)` only. Actual email method is selected inside the global inspector, not copied from company routes.
- [ ] GREEN includes shared organization unchanged, duplicate/import mapping review still intact, link update cannot create/rename people, and import refresh retains selected account. Freeze/review. Commit subject: `feat: connect account research to saved contact workspace`.

## Task 7: Read exact draft authority and retain first-draft behavior

**Dependencies:** Task 6, H-M inspector lease, coordinator approval of spec section 5's draft-bound read.

**Modify:** `src/shared/contracts/outreachContract.ts`, `src/main/outreach/emailService.ts`, `src/main/ipc/registerOutreachIpc.ts`, `src/preload/apis/outreachApi.ts`, `src/renderer/features/leadInspector/OutboundComposer.tsx`, `InspectorOverview.tsx`.
**Tests:** extend `tests/main/emailService.test.ts`, `tests/main/registerOutreachIpc.test.ts`, `src/renderer/features/leadInspector/OutboundComposer.test.tsx`; coordinator inventories required `OutreachApi` fixture consumers.

**Consumes:** `DraftRevisionRequest`, actual saved `EmailRepository` row/contact snapshot, unchanged `assertLocalEmailAuthority` and `emailDraftSession`.
**Produces:** `OutreachApi.inspectLocalAuthority(input: DraftRevisionRequest): Promise<LocalEmailAuthorityRead>` exactly as spec section 5. No raw contactSnapshot added to public `EmailDraft`.

- [ ] RED: linked account without paired local rights shows Send hold even with desktop Gmail ready; unassociated saved contact passes ownership-only read; draft revision/identity mismatch holds; stale successful read cannot enable another draft. API read does not mutate interrupted send state or call providers. First unconfigured-model draft still saves/reopens manually.
- [ ] Observe RED in the three listed test files. Maintain current unknown-send, serialized-save, sender-identity and recipient-change tests.
- [ ] Implement a synchronous read transaction under the existing database gate. Load exact draft revision, current contact row and snapshot, then evaluate the existing authority fence. Preserve epoch/invalidation checks and do not invoke `ready()` because it repairs interrupted sends. Return state/reason bound to draft/revision/person/contact. Reuse safe rejected errors for missing draft, not a made-up allowed status.

```ts
// Existing final Send authorization remains unchanged.
const blocked = sendBlockedReason ?? (
  authority != null && draft != null
    && authority.draftId === draft.id && authority.expectedRevision === draft.revision
    && authority.state === 'allowed' ? null : 'Local account send authority is not established.'
);
```

Read after draft open/save revision changes and focus/settings refresh, guard response generations, hold before read completion. Do not make Save depend on authority. Add visible pre-Email disclosure in `InspectorOverview` that configured AI may generate on first open. Do not disable generation silently to make provider-free assertions pass.
- [ ] GREEN includes configured first-open generation behavior unchanged, no authority writes/bootstrap, sender/contact/suppression final fences unchanged and failed read never mislabeled permission. Freeze/review. Commit subject: `fix: show exact local draft authority holds`.

## Task 8: Add real phone Settings and destination navigation

**Dependencies:** H-M/H-L route/settings lease. Can be reviewed independently after earlier task freezes, not concurrent implementation.

**Create:** `src/renderer/foundation/settingsNavigation.ts`, `settingsNavigation.test.ts`, `PhoneSetupSection.tsx`, `PhoneSetupSection.test.tsx`.
**Modify:** `src/renderer/foundation/SettingsScreen.tsx`, `src/renderer/app/routeRegistry.tsx`, `src/renderer/features/today/NativeDeskRoute.tsx` for phone-specific hold links only.
**Tests:** extend `src/renderer/foundation/SettingsScreen.test.tsx`.

**Consumes:** existing `PhoneSetupApi`, no backend change.
**Produces:** `PhoneSetupSection({api}: {api?: PhoneSetupApi})`; optional Settings prop `phoneSetupApi?: PhoneSetupApi`; `openSettingsSection(section: 'connections'|'phone'|'worker'|'call-capacity'): void`.

- [ ] Write a concrete phone RED in the new component test:

```tsx
it('reads status without confirming or calling', async () => {
  const api = { status: vi.fn(async () => ({ state: 'needs_confirmation' as const,
    candidateFingerprint: 'candidate_A', confirmedAt: null })),
    confirm: vi.fn(), clear: vi.fn() };
  render(<PhoneSetupSection api={api} />);
  await screen.findByText('candidate_A');
  expect(api.confirm).not.toHaveBeenCalled();
  expect(api.clear).not.toHaveBeenCalled();
});
```

Add explicit Confirm sends `candidate_A` exactly once while pending, changed/stale fingerprint displays returned refusal, Clear does not call any handoff. Imports are Vitest, Testing Library and the new component.
- [ ] Observe RED in `PhoneSetupSection.test.tsx`, `settingsNavigation.test.ts` and `SettingsScreen.test.tsx`.
- [ ] Reuse navigation convention: helper stores `callie.settings.section`, dispatches `callie:open-settings-section` CustomEvent with the narrow section ID, and links still use `href="#/settings"`. Settings validates stored/event section against known IDs and clears stored intent. Existing `callie:open-connections` listener remains supported. Mounted Settings updates without a route reload. Render exact four phone states, explicit Confirm/Clear with synchronous busy fence, no AppleSpike or test-call fallback.
- [ ] GREEN navigates actual hold link into Phone controls, not merely Settings heading. Missing API is unavailable, not unconfigured success. Native signature/candidate behavior remains coordinator-only external acceptance. Freeze/review. Commit subject: `feat: expose guarded phone handoff setup`.

## Task 9: Add worker status and explicit pairing without activation

**Dependencies:** Task 8 destination helper, H-L/H-M route/settings handoff.

**Create:** `src/renderer/foundation/WorkerSetupSection.tsx`, `WorkerSetupSection.test.tsx`.
**Modify:** `src/renderer/foundation/SettingsScreen.tsx`, `src/renderer/app/routeRegistry.tsx`, `src/renderer/features/today/NativeDeskRoute.tsx` worker hold links only.
**Tests:** extend `src/renderer/foundation/SettingsScreen.test.tsx`.

**Consumes/produces:** `WorkerSetupSection({api}: {api?: Pick<CalliePreloadApi['delegation'],'status'|'pair'>})`; Settings prop `delegationApi` has that same optional narrow type. Existing pair request/result and status schemas remain authoritative. No configure/sync controls in the minimum.

- [ ] RED: worker hold lands on Worker connection, desktop email links still land on Connections. Mount and Refresh invoke only status. Pair success causes no configure/configureResearch/configurePolicy/bootstrap/submit/sync; local active status never claims mailbox/calendar grants. Missing API/error is unavailable, not zero queues/healthy.
- [ ] Observe RED in `WorkerSetupSection.test.tsx` and `SettingsScreen.test.tsx`.
- [ ] Render endpoint/workspace/configuration revision/state plus unknown remote owner/grants. Pair handler validates via existing schema and freezes exact request before awaiting. Clear code in `finally`, retain nonsensitive endpoint/workspace on failure, show fixed safe error. No code persisted/logged; no native OAuth or provider call initiated by reading status:

```ts
const request = { endpoint, expectedWorkspaceId, code };
if (pendingRef.current) return;
pendingRef.current = true;
try { await api.pair(request); /* Then read status only. */ }
finally { setCode(''); pendingRef.current = false; }
```

An uncertain pairing outcome is not automatically resubmitted. Read status and ask the user to review current connection before a fresh explicit attempt.
- [ ] GREEN includes double click pending fence, late unmounted response ignored, lock/unavailable state, no activation cascade. Real pairing credentials and grants remain outside fictional acceptance. Freeze/review. Commit subject: `feat: expose truthful worker connection status`.

## Task 10: Expose call-capacity CAS and preserve obligations

**Dependencies:** Task 8, H-L facade lease and H-C refresh owner.

**Create:** `src/renderer/foundation/CallCapacitySection.tsx`, `CallCapacitySection.test.tsx`.
**Modify:** `src/shared/contracts/localWorkspaceContract.ts`, `src/main/domain/workspace/workspaceSettingsRepository.ts`, `src/main/domain/founderSalesDomain.ts`, `src/main/workspace/localWorkspaceProvider.ts`, `src/main/workspace/registerLocalWorkspaceIpc.ts`, `src/preload/apis/localWorkspaceApi.ts`, `src/renderer/foundation/SettingsScreen.tsx`.
**Tests:** create `tests/main/localCallSettings.test.ts`; extend `tests/main/localWorkspaceIpc.test.ts`, `src/renderer/foundation/SettingsScreen.test.tsx`.

**Consumes:** existing `readMeetingFirstAccountCallSettings()` and `updateMeetingFirstAccountCallSettingsCas` on the real repository.
**Produces:** shared settings/update types in spec section 6, facade `getCallSettings(): MeetingFirstAccountCallSettings` and `updateCallSettings(input: UpdateCallSettingsRequest): MeetingFirstAccountCallSettings`, Promise equivalents on `LocalWorkspaceApi`. Component props `{api?: Pick<LocalWorkspaceApi,'getCallSettings'|'updateCallSettings'>; onSaved(): void}`. H-C supplies refresh invalidation through this callback, never worker sync.

- [ ] RED: read starts null, Save zero persists zero and increments revision once, second editor's old revision refuses without lost inputs. Invalid negative/fractional/unsafe numbers rejected at boundary. Lost response followed by matching read does not claim command receipt. Due obligations above capacity remain visible with workload conflict.
- [ ] Observe RED in the four listed files. SQL tests use real domain services and its matching UOW, not a fake transaction wrapper.
- [ ] Share the existing settings type through the local contract, then facade invokes repository CAS under its actual service `unitOfWork.immediate`, passing main clock timestamp. Keep it synchronous:

```ts
// Inside the facade, with its existing repository and matching service UOW:
return this.services.unitOfWork.immediate(() =>
  this.services.workspaceSettings.updateMeetingFirstAccountCallSettingsCas({
    ...updateCallSettingsRequestSchema.parse(input), updatedAt: this.clock.now(),
  }));
```

The exact facade members are verified in `createDomainServices.ts`: `services.unitOfWork`, `services.workspaceSettings`, and facade `this.clock`. Do not create another UOW. Null and zero use distinct explicit controls/copy. Save only, no onChange write. Stale/unknown shows current persisted values beside retained edits, requiring new review. `onSaved` runs only after confirmed response.
- [ ] GREEN verifies no phone, authority, consent, campaign or due-obligation mutation. Actual daily planner projection must observe capacity change, no handwritten substitute allocation formula. Freeze/review. Commit subject: `feat: expose meeting-first call capacity CAS`.

## Task 11: Classify first-use capability previews and saved reply history

**Dependencies:** Tasks 6-10, H-C F16 count contract and explicit coordinator F10 preview disposition.

**Create:** `src/renderer/features/today/firstUseCapabilities.ts`, `firstUseCapabilities.test.ts`.
**Modify:** `src/renderer/features/campaigns/CampaignReview.tsx`, `src/renderer/features/today/DailyAnswers.tsx`, `NativeDeskRoute.tsx`.
**Tests:** extend `src/renderer/features/campaigns/CampaignReview.test.tsx`, `src/renderer/features/today/LocalWorkspace.test.tsx`.

**Consumes:** existing `DailyAnswer[]`, current campaign snapshots, Task 8 Settings navigation, actual local contact entrypoint.
**Produces:** `partitionFirstUseAnswers(answers: readonly DailyAnswer[]): {continuations: DailyAnswer[]; history: Extract<DailyAnswer,{kind:'reply'}>[]}`. The helper classifies saved replies out of action/approval counts without claiming all continuations are currently executable.

- [ ] RED: saved reply must be in history, not under “Needs your approval”; campaign has no inert Approve control; empty requested/LinkedIn lane explains real preparation prerequisites and links to appropriate setup/local account preparation. Preserve exact campaign-bound samples and saved continuation editor behavior.
- [ ] Observe RED in the three named files. Use pure fixture arrays for classification only, not as proof of worker first-use.
- [ ] Implement explicit partition and headings, leaving execution sessions untouched:

```ts
export function partitionFirstUseAnswers(answers: readonly DailyAnswer[]) {
  return {
    continuations: answers.filter(answer => answer.kind !== 'reply'),
    history: answers.filter((answer): answer is Extract<DailyAnswer, {kind: 'reply'}> => answer.kind === 'reply'),
  };
}
```

Keep selection keys/keyboard traversal aligned with the displayed groups via H-C owner. Campaign is “Saved campaign versions / capability preview”; audience hash is not a definition. Requested text states saved eligible owner call, exact recipient request and mailbox proof. LinkedIn text states actual enrollment/current step and provider. No new prepare/approve/submission calls from this task. Do not broadly recalculate F16 unavailable queue counts.
- [ ] GREEN includes nonempty reply retained, no recorded history deletion, exact saved requested/LinkedIn editors still reachable, no auto-enrollment or raw approval form. Freeze/review. Commit subject: `fix: make first-use capability gaps explicit`.

## Task 12: Coordinator-owned public journey acceptance

**Dependencies:** all accepted task freezes, H-A fixture integration, fresh exact source checkpoint. Worker has no independent runtime GO.

**Create (only under separate coordinator test-file lease):** `tests/integration/firstUseWorkflowComposition.test.tsx`, `tests/e2e/firstUseWorkflow.spec.ts`.
**Reuse read-only:** existing PM/temp database fixtures, `tests/integration/localWorkspaceComposition.test.tsx` patterns, current production menu payload and route registry.
**Coordinator-only conditional edits:** `package.json` exact-spec maintenance wiring and frozen acceptance fixtures. No widening production seed/recovery/profile hooks.

**Consumes:** actual FounderApp, routeRegistry, production createCallieApi/validated registrars, real domain/import/research/email repositories, deterministic external HTTP/DNS/phone/worker adapters.
**Produces:** finding-to-check results A1-A8 with fixture/proxy labels, exact file hashes and residual holds. No live-conversation or independent-verification claim.

- [ ] Write maintained public RED from an empty fictional workspace. Seed only necessary workspace infrastructure, not a person/link/email draft. Configure the test's existing main-only research dependency with allowlisted fictional `selected.invalid` root/services/team URLs and deterministic HTTP bytes. Actual page provider must issue attestation and actual repository must admit it. Unrelated queued job is real SQL/domain-created work.
- [ ] Coordinator observes each failure before corresponding patch acceptance, retaining task-local REDs when integrated test timing differs. Never claim an imported scratch test or copied source body is the production join.
- [ ] Exercise real public sequence with accessible controls: Accounts Review/Create, Research this company, inspect source, Import named contact with separate person email, mapping/duplicate review, return to account, exact-person selection/review/link, Open contact workspace, Email, edit/Save, close/route/reopen. Assert saved recipient/text and local authority hold. Assert no owner/grant/bootstrap/send/call/outcome/provider generation writes, and company route `personId` stays null. Add office-only negative case, cross-account/stale quote rejection, lost response, and more-than-one-page selector case.
- [ ] Exercise actual Settings hold destinations, fake exact phone confirmation mismatch/clear, worker status/pair no cascade, capacity null/zero/stale/obligation conflict and campaign/reply preview/history. Real route composition is mandatory, not redirecting all fixtures to Today. Existing draft fixtures are continuation-only checks, never first-use proof.
- [ ] Coordinator runs public composition plus genuine packaged route/UI checks only when separately authorized. In-process Electron transport is labeled synthetic transport. Mocked native dialog/phone success does not certify native focus isolation, signed candidate or real phone proof. Fake worker replies do not certify mailbox/calendar grants. Record unavailable live prerequisites as external gates, not failed tests to bypass.
- [ ] Freeze/review the final exact files and have coordinator commit only accepted paths. Proposed subject: `test: cover guarded first-use public workflow`. Documentation, source inspection and a green mock suite alone cannot close F08/F09/F10.

## Traceability and stop rules

| Spec requirement | Tasks | Maintained behavioral target | Public acceptance |
| --- | --- | --- | --- |
| Selected account/source completeness | 1,4 | actual one-account read, stale/unavailable UI, no source truncation | A1-A2 |
| No queue-wide shortcut, spend/receipt fences | 2-3 | exact three claim paths, global spend, distinct command/job IDs, restart no HTTP | A1-A2,A5 |
| Real importer contact route + reviewed link | 5-6 | one exact saved person, quote/account/CAS/receipt checks, no inferred direct route | A3,A5 |
| First unsent draft and correct local hold | 7 | revision-bound ownership read, preserved manual saves/unknown send | A4 |
| Continuity and ownership handoff | 4,6,11 | pending exact request survives route/import refresh, no competing modal/store | A5 |
| Distinct phone/worker setup | 8-9 | exact candidate, pair without cascade, unknown grants | A6 |
| Capacity null/zero/CAS/obligations | 10 | real settings writer and actual planner projection | A7 |
| F10 previews/history without false starts | 11 | no inert approval, replies partitioned, continuation retained | A8 |
| Actual public joins/evidence limits | 12 | real renderer/preload/registrar/domain composition | A1-A8 |

Stop for coordinator decision if selected research would call global startup `prepare/runNext`, a route/person would be inferred from generic office data, source attestation would become allow-all, authority/consent/OriginalCallRef would be manufactured, a receipt would be replaced by row resemblance, a source hash or strict fixture would be weakened, or an unreleased owner file would be edited. Preserve completed useful sub-slices and honest holds rather than activating services to hide missing capability.

**Planning self-review:** spec sections 3-7 map to Tasks 1-11; ownership to section 0 and Task 4; public claims to Task 12. New APIs are explicitly proposed and exact response binding is specified. Deliberate unresolved decisions are listed in the spec, not disguised as completed code. Implementation details must be rechecked against the shared checkout at each file handoff. Only source reads, document writing/review and hashes were performed in this assignment.
