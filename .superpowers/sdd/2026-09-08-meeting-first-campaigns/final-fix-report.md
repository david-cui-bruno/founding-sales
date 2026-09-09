# Final bounded D3 fix report

## Scope and disposition

- Requirements: `final-fix-brief.md`, with I1/I2 evidence in `final-review.md`.
- Base: `d00c3a8271fd85a91b472515984ec5dc328d8957`.
- Implementation commit: `7a11b60a5e1b05bbfb12418e0bdc9467978dd28b`.
- Source is frozen. I1 and I2 are addressed by the narrow renderer changes below. This is not a whole-branch, package, pairing, release, installation, or live-outreach approval.

## Cause and ruling

### I1: explicit reconciliation, not a general pending-hold exemption

The real daily reader includes the unresolved operation itself in `ownerStatus.pendingCommands`. Both existing renderer hold evaluators intentionally block work while that list is nonempty. Local refresh does not synchronize, so there was no renderer path to settle the durable outbox after refresh.

Added **Reconcile queued commands** under connection details. It calls only the existing `api.delegation.sync`, and explicitly discloses that reconciliation may retry already-queued commands **across the workspace**. This matches the existing API's workspace-wide scope rather than claiming account-only behavior. The existing owner remains responsible for replay eligibility, pause/stop policy, exact command identity, and applied event validation. Neither existing pending-work hold evaluator nor either editor session implementation was relaxed.

The control requires a successful local read, stored meeting-first mode, matching non-null workspace, active configured delegation, pending commands, and active worker authority for every account represented by pending commands. A ref prevents overlapping clicks. Lifecycle/configuration/authority changes invalidate continuations, including a later return to the same workspace. Only successful actual sync completion in the still-valid scope triggers the existing canonical daily/status reload. Sync counts and transport acceptance never clear pending state. Failure leaves pending work held and permits an explicit retry. Mount, selection, focus, and Refresh never enter sync.

For manual reports, canonical owner reconciliation releases the global pending hold only when the repository says it is settled. The existing **Retry retained outcome** can then retrieve the exact retained report receipt, with unchanged command ID, draft/revision, outcome, timestamp, and payload. It is not a new report or inferred send. Requested approvals use the canonical saved status reread after sync.

The browser-safe fixture now reflects pending report/approval receipts into owner status. Its default sync only records the call and returns no fabricated settlement. Tests needing settlement must supply an authoritative fixture snapshot or actual repository events.

### I2: saved reply identity

Reply keys now encode kind, account, provider, mailbox, provider thread, and a tagged saved draft ID. The no-draft placeholder has a separate tagged identity, including when a real saved draft is literally named `no-draft`. Revisions are not identity, so refresh preserves selection. All valid saved drafts remain in the queue. No reply editing or sending capability was added.

## Exact owned implementation files

1. `src/renderer/features/today/DailyAnswers.tsx`
2. `src/renderer/features/today/NativeDeskRoute.tsx`
3. `src/renderer/features/today/nativeDesk.fixture.ts`
4. `src/renderer/features/today/NativeDeskFinalFix.test.tsx` (new)
5. `src/renderer/features/today/NativeDeskComposition.test.tsx` (new)

This report is a separate documentation-only follow-up commit. Coordinator-owned `tests/browser/nativeDesk.spec.ts`, `tests/fixtures/nativeDeskBrowser.tsx`, package scripts, and global configuration were not edited, staged, or reverted by this implementer.

## RED evidence

All Node commands used this required prefix:

```sh
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"
```

Before production changes:

```sh
npx vitest run src/renderer/features/today/NativeDeskFinalFix.test.tsx
```

Observed **2 product failures**: the reconciliation disclosure/control was absent, and the three reply identities collapsed to one (`expected 1 to be 3`). An earlier first harness invocation used the wrong exported fixture name. That harness error was corrected before the product RED run and is not counted as I1 evidence.

During composition-test development, the initial manual setup used an instant before account creation, then used an incorrect button name for the actual outcome select form. These were harness errors, corrected by a Date-only fake clock aligned with the fixture and by using the real Manual outcome select plus Record outcome button. They are not product RED claims.

## GREEN evidence and commands

Final scoped regression command:

```sh
npx vitest run \
  src/renderer/features/today/NativeDeskFinalFix.test.tsx \
  src/renderer/features/today/NativeDeskComposition.test.tsx \
  src/renderer/features/today/NativeDeskRoute.test.tsx \
  src/renderer/features/today/NativeDeskNavigation.test.tsx \
  src/renderer/features/today/requestedDraftSession.test.ts \
  src/renderer/features/linkedin/LinkedInStep.test.tsx \
  src/renderer/features/linkedin/linkedInSession.test.ts \
  tests/main/dailyReadService.test.ts \
  tests/main/dailyReadServiceReview.test.ts \
  tests/main/dailyLifecycle.test.ts \
  tests/main/linkedInService.test.ts \
  tests/main/delegationRepository.test.ts \
  tests/main/delegationRuntime.test.ts \
  tests/main/requestedFollowupRepository.test.ts \
  tests/main/requestedFollowupService.test.ts
```

Observed **15 files, 150 tests passed**, no failures. This includes all existing scoped timer, hold, recipient/context, workspace, teardown, and retained-recovery regression files. The two new files contribute **22 tests**.

Final static checks:

```sh
npx tsc --noEmit
npx eslint \
  src/renderer/features/today/NativeDeskRoute.tsx \
  src/renderer/features/today/DailyAnswers.tsx \
  src/renderer/features/today/nativeDesk.fixture.ts \
  src/renderer/features/today/NativeDeskFinalFix.test.tsx \
  src/renderer/features/today/NativeDeskComposition.test.tsx
git diff --check
```

All passed. Earlier typechecking found owned test-spy typing errors, which were fixed, and four coordinator-owned browser-fixture implicit-any errors. Those were reported by DM and fixed by the coordinator, not this implementer. The final typecheck passed with the coordinator's updated working file.

## Requirement-to-evidence mapping

| Requirement | Observed evidence |
| --- | --- |
| Real pending manual report, applied and rejected reconciliation | Encrypted fixture, real LinkedInRepository and LinkedInService report, real DelegationRepository queue/events/status, real DailyReadService and actual React route. Both outcomes passed. |
| Exact retained manual identity | After explicit owner sync, the existing retained retry returns the applied/rejected receipt. Both API payloads and persisted command remain deeply equal. |
| Lost requested approval response | Actual UI approval queues a real persisted owner command and deliberately loses its response. Refresh observes pending state, and explicit sync applies real repository status/rejection events. Both applied and rejected variants pass without a second approval submission. |
| New work stays held | Pending manual copy/retry and requested approval/preflight controls are disabled. A real unrelated pending stop remains after settling the requested command, and new-work controls stay disabled despite a large returned applied count. |
| Pause/revoke/foreign scope/failure | Real-reader composition cases preserve pending commands and disabled new-work controls. Additional renderer cases cover unknown authority and a revoked unrelated pending account. |
| No automatic network-command entry | Mount/focus/Refresh tests assert sync remains uncalled. Unrequested command APIs throw and remain uncalled. |
| Completion and lifecycle sequencing | Deferred sync proves no premature daily reread and no duplicate sync. Remount, pause/return, and foreign-scope/return discard old continuations. Failure does not reread or clear pending state. |
| Two saved replies on one thread | Two real persisted draft rows reach the reader and React. Second detail is exact, one row is selected, keyboard navigation reaches it, Escape restores focus, and refresh preserves it without duplicate-key warnings. |
| Placeholder-to-saved transition | A real thread-only placeholder is replaced by a distinct saved draft row. No accidental selection alias occurs, and the saved content is selectable. |
| Read-only daily mount | Every composition `daily.get` compares SQLite `total_changes()` before/after the real reader. No read allocates IDs. Existing legacy-route tests remain green. |

## Integration limits and residual risks

- These are source integration tests with encrypted temporary fixture repositories and actual React, not packaged IPC or authenticated worker acceptance. Sync is an explicit no-network test adapter applying schema-validated synthetic owner events through the real repository. Requested edit/approval command APIs are test adapters, not a live runtime. The manual report path uses the real LinkedInService with a no-network owner client adapter.
- Existing owner policy is deliberately unchanged. Workspace-wide sync can retry eligible already-queued commands, as the UI discloses. A pending command remains pending if the owner cannot settle it. Paused/revoked or unavailable scopes are not bypassed from this new control.
- The default browser fixture cannot prove settlement. Its sync intentionally does not manufacture applied receipts. The coordinator owns browser overrides and browser acceptance updates for those scenarios.
- No full root suite, subagents, native rebuild, package/build/app/browser launch, live profile, credential/keychain access, live network operation, push, or deployment was performed by this implementer. No main source, contract, migration, worker, native, style, packaging, or global-config changes were made.
- Genuine paired-package positives and release trust/fuse constraints remain blocked as previously documented. This report makes no release claim.
