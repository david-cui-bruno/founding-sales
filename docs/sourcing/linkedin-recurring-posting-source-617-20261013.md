# #617 guarded recurring posting source acceptance, October 13, 2026

## Delivered boundary

A normal authenticated product input and saved exact #616 standing policy can feed the registered `social.linkedin_recurring` preparation worker. With an explicitly supplied trusted runtime composition, the worker derives a nonhuman standing admission and uses the existing post, approval snapshot, delivery queue, desktop claim/begin/final-check and Schedule/inspection path. No per-post human approval is fabricated or requested inside the standing scope. Manual approvals outside it retain a real approver and their existing behavior.

The internal preparation interval is the same day's Tuesday/Thursday `[09:30,10:00)` in America/New_York. The future publication target is unchanged, exactly 10AM. At or after the target, unattempted work is skipped, not rescheduled. Target identity is workspace/account/instant, not policy revision. Two NY calendar targets per week and durable unique target identity prevent cadence expansion and revision-driven retries. Missing input, funding, composition, account or policy stops the slot without filler.

Startup supplies no recurring runtime composition. Saved policy is not readiness, provider quality, live account setup or Enable. The composition factory observes the actual app_runtime database role, schema and connection and an adapter account observation, then rechecks the exact owner/account/policy/provider/data bindings. It is process composition, not an HTTP body, candidate flag or controlled-mode permission switch. Production provider and installed native acceptance remain operationally held under #618/#460/#552.

## Acceptance evidence

`apps/api/test/linkedinRecurringPosting.test.ts` exercises authenticated governed fact intake and approval, explicit shared funding and policy save, normal worker source and handler registration, paid-draft reservation/settlement with a controlled model, derived standing admission, existing desktop delivery ports and a controlled LinkedIn Schedule adapter, one durable submission marker and receipt, owner readback, and repeat-job refusal. The scheduling clock is explicitly controlled to a future 9:30 target. DB cost time, Date.now and native future-time validation are real and unchanged. This proves controlled scheduling and receipt behavior, not actual publication at 10AM.

`linkedinRecurringGuards.test.ts` checks absent input/runtime/funding, runtime expiry, unknown pre-call maximum, late preparation, invalid/unsupported generated output, and exact source/policy/account/funding/revoke losses across token counting, paid generation, desktop preparation and begin-response waits. Cost is retained after an attempted call, including estimated or over-bound usage. NY day/month posting ceilings remain within stricter shared limits. Physical source deletion is a negative external-loss fixture, never positive authority. Generic scheduling excludes recurring requests while ordinary manual requests remain selected.

Concurrent actual PG sessions schedule and run only one stable account/target. A real disposable app_runtime PG connection is terminated during the external model wait. Its committed calling reservation remains visible as unknown, and a fresh registered worker session cannot regenerate it. Existing unknown delivery inspection survives revoke with the original submission marker and controlled receipt, never a second submission.

Owner readback uses current unattempted source/budget/time fences, not historical command receipts or saved-policy-only predicates. It preserves receipts and unknown markers and reacquires active owner membership after the read's advisory wait. The owned renderer and trusted read operation clear stale answers across session replacement and failed reads. Existing Settings Disable/Revoke controls are unchanged. There is no new publisher, settings surface or Enable action.

The public calendar helper tests exact preparation endpoints, before/after US DST, month/year rollover and exactly two targets in a NY week. The catalog suite contains actual failing inserts for every additive constraint, including durable unique target, exact standing slot/post FK and manual versus nonhuman origin. Actual app_runtime negative mutation/deletion tests protect immutable audit bindings. The retention catalog records only retained body-free references/hash/target metadata. Existing source deletion continues to fence generation, queue and dispatch.

## Genuine development RED to GREEN

1. After normal governed product intake and policy save, the initial public recurring journey failed because `/social/linkedin-recurring/read` returned 404. The minimum real registered-worker journey then reached one controlled Schedule receipt without `/social/posts/approve`.
2. Current owner readback failed after source retirement, budget disable and target expiry because it still reported a queued item. The reader now applies canonical unattempted slot checks and reports review or skipped while retaining evidence.
3. Owned component and trusted operation boundaries initially returned no useful state. Behavioral component/host tests failed, then passed with current refresh, receipt/unknown state and session-generation fencing.
4. An authenticated read paused at its account advisory boundary exposed prior-owner ledger state after membership loss. A fresh active-admin share lock before reading the ledger now returns owner_unavailable without historical items.

## Persistence and integration mapping

Isolated additive migration `0110_linkedin_recurring_posting.sql` follows parent #616 schema109. Root's canonical mapping is migration113 after separate booking110/111/112. Root owns canonical renumbering, full combined gates, upgrade/secrets checks and independent review. Existing migrations are not modified. Parent #616 frozen UI/readback-only head `380f896eb3f5866f96a3674019a1b4e8bcd764fe` is integrated separately by root. This branch starts at immutable `8e0939cea30ec3e50626f9af597c0b6342d0d92c`.

The ledger stores exact workspace, durable actor owner, account/revision, policy revision, target, governed source selection/hash, existing draft/post IDs and coded outcome. Immutable policy revision FKs and the explicit approval discriminator preserve manual approved_by semantics. Standing approvals require null human approver plus the exact durable slot/post reference. No rebind or replay is used as a freshness repair.

## Honest limits

No live provider/cloud/account/browser/native action, credentials, paid calls, sends, GitHub mutation, push, PR, merge, release or Enable was performed. Controlled output passing structural guards is not semantic entailment, a quality verdict or installed acceptance. The final server check is fresh admission before adapter.submit, not an atomic distributed revocation guarantee through the adapter's subsequent native identity wait and click. Already submitted work cannot be unsent. Original durable markers, unknown allowances and receipts remain inspection-only.

Independent two-axis review and final combined upgrade/release gates belong to root. This worker had no children. Source-only local tests are not an activation claim.

## Final local validation

Pinned Node v24.20.0, normal npm ci, no engine bypass or new dependencies. Final combined command task `821256ip46` exited 0. All test commands used `--maxWorkers=2`:

```text
npm test --workspace @fss/api -- test/linkedinRecurringGuards.test.ts test/linkedinRecurringPosting.test.ts test/linkedinPostingPolicy.test.ts test/socialGroundedDrafts.test.ts test/socialPosts.test.ts test/socialAccounts.test.ts test/routeMounting.test.ts --maxWorkers=2
npm test --workspace @fss/domain -- test/social test/retention/targets.test.ts test/db/constraints.test.ts test/db/migrations.test.ts test/db/migrationChecksums.test.ts --maxWorkers=2
npm test --workspace @fss/worker -- test/socialDraft.test.ts test/socialDraftModel.test.ts test/jobLanes.test.ts test/jobRunner.test.ts test/schedulerPass.test.ts --maxWorkers=2
npm test --workspace @fss/desktop -- test/linkedinRecurringPosting.component.test.tsx test/linkedinPostingPolicy.component.test.tsx test/linkedinPostingPolicy.delivery.test.ts test/registryTraffic.test.ts test/operations.test.ts test/socialOperations.test.ts test/social.component.test.tsx test/socialDelivery.test.ts test/socialDeliveryApi.test.ts test/socialDeliveryRunner.test.ts --maxWorkers=2
npm run typecheck
npm run lint
git diff --check
```

Results: API 7 files/113 tests, domain 17 files/2780 tests, worker 5 files/26 tests, desktop 10 files/101 tests, all passed. Total 39 files/3020 tests. This includes 49 recurring public/guard checks, 4 owned UI/operation checks, 6 calendar checks and 25 additive constraint cases within the full 2676-case catalog suite. Seeded previous-schema upgrade, migration checksum, retention catalog, manual approvals and normal manual scheduler regressions passed. Full typecheck, zero-warning lint gate and diff hygiene passed. This is focused verification, not the root's full release gate.

## Exact source inventory relative to immutable base

```text
apps/api/src/routes/linkedinPostingPolicy.ts
apps/api/src/routes/linkedinRecurringPosting.ts
apps/api/src/routes/modules.ts
apps/api/src/routes/social.ts
apps/api/src/routes/types.ts
apps/api/src/server.ts
apps/api/test/linkedinRecurringGuards.test.ts
apps/api/test/linkedinRecurringPosting.test.ts
apps/api/test/routeMounting.test.ts
apps/api/test/support/linkedinRecurringFixture.ts
apps/desktop/src/main/operationHost.ts
apps/desktop/src/main/social/linkedinRecurringPostingOperations.ts
apps/desktop/src/renderer/social/LinkedinRecurringPosting.tsx
apps/desktop/src/renderer/social/SocialRoute.tsx
apps/desktop/src/shared/operations.ts
apps/desktop/test/linkedinRecurringPosting.component.test.tsx
apps/desktop/test/registryTraffic.test.ts
apps/worker/src/bootstrap/main.ts
apps/worker/src/social/draftJobs.ts
apps/worker/src/social/linkedinRecurringJobs.ts
packages/contracts/src/index.ts
packages/contracts/src/linkedinRecurringPosting.ts
packages/domain/db/migrations/0110_linkedin_recurring_posting.sql
packages/domain/db/schemaRange.ts
packages/domain/jobs/jobKinds.ts
packages/domain/retention/coverage.ts
packages/domain/social/delivery.ts
packages/domain/social/deliveryQueue.ts
packages/domain/social/draftRun.ts
packages/domain/social/linkedinPostingPolicy.ts
packages/domain/social/linkedinRecurringAuthority.ts
packages/domain/social/linkedinRecurringCalendar.ts
packages/domain/social/linkedinRecurringPosting.ts
packages/domain/social/posts.ts
packages/domain/test/db/constraints.test.ts
packages/domain/test/db/support/linkedinRecurringCases.ts
packages/domain/test/social/linkedinRecurringCalendar.test.ts
docs/sourcing/linkedin-recurring-posting-source-617-20261013.md
```

New recurring domain/contracts/worker/API/UI/tests/docs are owned by this worker. Every existing shared source/registry/catalog/fixture hunk was separately root approved before modification. Existing manual logic, native future-time checks and Date.now were preserved. No unrelated worker files or existing migrations changed.
