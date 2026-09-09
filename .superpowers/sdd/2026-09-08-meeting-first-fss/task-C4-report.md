# Task C4 report: one-shot dispatch and reconciliation

Status: **DONE_WITH_CONCERNS** for the source-only standalone-reply and concrete D1 campaign integration slice. Review repairs and real campaign transaction integration are implemented. This is not live acceptance or activation approval. See the follow-up evidence below, which supersedes the original baseline counts and held-D1 statements.

Source commit: `6f5aa93` (`feat: fence delegated sends and reconcile uncertain outcomes`). Committed file list was inspected and contains only the nine paths below. No push.

## Scope and ownership

Read the full brief including the appended actual C1 contract ruling. No subagents were spawned. Root approved the extra focused `dispatchRepository.ts` and test, then explicitly released `executionRepository.ts` and narrow `commandService.test.ts` fixture edits at 01:09 UTC after unicorn's C1 review. Shared `delegationContract.ts` remained camel-owned and was not edited. No renderer, startup, handler, build configuration, native dependency, or other owner file was changed.

Owned/released source and focused tests committed:

- `cloud/lambdas/delegated-worker/src/dispatchRepository.ts`
- `cloud/lambdas/delegated-worker/src/dispatchService.ts`
- `cloud/lambdas/delegated-worker/src/intakeBarrier.ts`
- `cloud/lambdas/delegated-worker/src/sendReconciler.ts`
- `cloud/lambdas/delegated-worker/src/executionRepository.ts` (released mechanical integration and durable reads)
- `cloud/lambdas/delegated-worker/test/dispatchRepository.test.ts`
- `cloud/lambdas/delegated-worker/test/dispatchService.test.ts`
- `cloud/lambdas/delegated-worker/test/sendReconciler.test.ts`
- `cloud/lambdas/delegated-worker/test/commandService.test.ts` (explicit C1 mechanics-only policy fixture)

## Implemented behavior

- Actual C1 `Reservation` identity/hash contract is preserved. Stable action identity still excludes live `expectedVersion`. Trusted prepare/queue remain preparation, not send permission.
- `reserveDispatch` now requires a persisted dispatch policy. Its real Dynamo conditions and cap/flight writes join the existing **single AUTH/ACTION/outbox transaction**. No parallel execution repository or second reservation algorithm.
- Standalone replies require immutable individual approval of the full real `AccountReplyDraft`, exact frozen content and target hashes, current draft/thread/context, actual inbound source-message identity and hash, current permitted-correspondence evidence, no durable suppression or revocation, configured sender/day cap, relevant intake currency, and C2 grant/pairing conditions.
- Thread-participant-bound standalone replies do not fabricate route, Person, or cycle IDs. Route-bound replies consume the actual B1 `ACCOUNT#account` projection and exact account/route versions, not a second mutable route catalog.
- Permission admission is a trusted owner-composition capability citing an actual source message and one of `requested_followup` / `ongoing_correspondence`. It is not a public command, model assertion, publication result, or Google grant. C3 opt-out/rejection signals and `MAIL_SUPPRESSION` hold dispatch.
- Approval and permission records are immutable. Separate irreversible revocation tombstones cannot be removed by re-admission.
- `DISPATCH_ACCOUNT` serializes unresolved account mail flight. An unknown prior action cannot be bypassed with a distinct action ID and newer authority version. Unknown retains its cap consumption. Terminal evidence only releases the mail flight; it never advances or resumes a campaign.
- Service runs the real C3 preflight poller, then C2 access preparation and the real Gmail one-shot sender preparation, then final reservation. There is **no awaited publication, refresh, or other operation between successful reserve and `sendOnce`**.
- Pause during token preparation sends zero messages. A late acceptance after pause is persisted while authority stays paused. No local fallback.
- Ambiguous reservation response, timeout, process restart, absent Sent match, and multiple Sent matches never authorize a resend.
- Reconciliation performs a bounded Gmail Sent query for deterministic `<commandId@callie.invalid>`, checks exactly one SENT-labeled result, sender, recipient, no CC, thread, exact References/In-Reply-To, subject and complete body association. It supports the UTF-8/base64 subject encoding emitted by the real sender and transport CRLF normalization. Unsupported MIME/ambiguous evidence stays unknown.
- Unknown and accepted evidence are separate immutable records committed with the C1 outcome transition. Reconciliation preserves the original unknown record and caps. Provider-accepted is not claimed as delivery.

## Interfaces and exact persisted bindings

### Services

```ts
createDispatchService({ execution, policy, authorization, fetch })
  .dispatch(commandId: string): Promise<DispatchOutcome>

createSendReconciler({ execution, policy, authorization, fetch })
  .reconcileSend(commandId: string): Promise<ReconciliationOutcome>

createIntakeBarrier(store).check(
  { accountId, mailboxSubject }, signal
): Promise<IntakeResult>
```

Dispatch statuses: `held | not_sent | provider_accepted | unknown`, bounded runtime reason IDs, optional `{messageId,threadId}` provider identity. Reconciliation returns unknown or provider acceptance, never send permission.

Intake ready result includes actual `TransactWriteItem[]` checks, `{key,revision}[]`, and `validUntil`. Blocked results identify unavailable/incomplete/stale intake or pending manual outcome. Configured enabled/relevant adapters are enumerated. Unknown relevant adapter kinds hold. Gmail evidence requires a complete C3 poll, history checkpoint without page token, matching account/mailbox, no future times and **age strictly below 300000 ms measured from poll start**. New pending/failed poll cannot reuse old success. Manual dependencies read exact applied C1 COMMAND receipt and correlated immutable EVENT, both rev-fenced. Unknown/reply/opt-out manual outcomes do not resume dependent work.

### C1 mechanical extensions

```ts
type ExecutionRepositoryOptions = RepositoryOptions & {
  dispatchPolicy?: DynamoDispatchRepository;
};
reserveDispatch(input: ReserveDispatchInput, evidence?: GoogleAccessEvidence);
appendOutcome(input: AppendOutcomeInput, evidence?: SendEvidence): Promise<void>;
currentVersion(accountId: string): Promise<number>;
readDispatch(accountId: string, actionId: string);
```

Missing policy holds before reservation. Policy/store workspace, table and Dynamo adapter binding must match. `readDispatch` validates persisted reservation identity against the stable action input. The shared interface and strict Reservation schema are unchanged.

### Trusted admission and policy reader

`DynamoDispatchRepository(options, authorization)` provides:

- `admitIntent`, `admitApproval`, `admitPermission` (immutable trusted admission)
- `revokeApproval`, `revokePermission` (append-only revocation tombstones)
- `configureCaps(input, expectedRevision)` and `configureIntake(input, expectedRevision)` (CAS, no volume defaults)
- `loadIntent`, `reservationPlan(input,evidence)` with synchronous `finalize()` producing actual conditions
- `outcomeItems`, `sendEvidence` for immutable evidence integration

The exact strict DTO schemas are exported from `dispatchRepository.ts`; intake registry schema is exported from `intakeBarrier.ts`.

| Namespace | Binding |
|---|---|
| `DISPATCH_INTENT#command` | UUID command, stable C1 action identity/hashes, discriminated standalone/campaign kind, real draft ID/revision, pairing/mailbox, complete frozen threaded message, thread-participant or account-route binding |
| `DISPATCH_ACTION#account#action` | Immutable command index |
| `DISPATCH_APPROVAL#id` | Command, full draft snapshot, fingerprint of full intent, permission evidence ID, approval/expiry times |
| `DISPATCH_PERMISSION#account#id` | Exact sender/recipient/thread/source message/hash, explicit conversation/request basis, recorded/expiry times |
| `REVOKED#<record-key>` | Immutable revocation tombstone |
| `DISPATCH_INTAKE#account` | Explicit enabled/relevant adapters and exact manual dependencies |
| `DISPATCH_CAP_POLICY#sender` | Explicit sender/day limit, no unapproved default |
| `DISPATCH_CAP#sender#UTC-day` | Used count, CAS consumed with reservation; unknown never refunds |
| `DISPATCH_ACCOUNT#account` | Current command/action and dispatching/unknown/terminal mail-flight state |
| `DISPATCH_EVIDENCE#command#fingerprint(evidence)` | Immutable command, original Reservation, state, observed time, evidence kind/reason, deterministic RFC identity and optional provider message/thread identity |

C3's actual keys are read and conditioned directly: `MAIL_DRAFT#account#draft`, `MAIL_THREAD#account#thread`, `MAIL_CURSOR#account#mailbox`, and absence of `MAIL_SUPPRESSION#account`.

C2 uses actual `authorizedAccess(pairingId,['send','relevant_read'])` evidence. Its synchronous `accessChecks(evidence,{pairingId,subject,requiredCapabilities})` is called at finalization and contributes exactly one pairing and one grant check. Do not wrap this transaction in `WorkerAuth.fencedDynamo`, which would duplicate the pairing target. Tests mint evidence through C2's real fictional OAuth/encrypted-token flow, not manufactured tokens or a boolean gate.

C5 received the exported frozen-intent and send-evidence shapes for accepted offered-slot binding. C4 does not own calendar rules, meeting approval, offers, or calendar caps.

### Frozen D1 consumption contract and held binding

`campaignDispatchBindingSchema` requires `{campaignId,campaignRevision,enrollmentId,enrollmentRevision,stepId}`. `campaignDispatchStateSchema` adds `{accountId,state:'active',approvedRevision,allowedContentHash,allowedTargetHash,capsRevision}`. This is a required consumption DTO, **not a permit or implemented D1 store**.

D1 must supply real campaign/enrollment state, current approved version/content/target and campaign-cap consumption in the same final transaction. Until then `campaign_step` is explicitly `campaign_binding_unavailable`. It cannot omit campaign fields to become a standalone reply. The separate standalone variant requires an existing relevant thread and individual approval.

## TDD and validation

Every npm/npx invocation used:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH";
```

Observed RED phases:

1. `npm test --prefix cloud/lambdas/delegated-worker -- test/sendReconciler.test.ts`: missing reconciliation implementation.
2. Same focused run with `test/dispatchService.test.ts`: missing intake implementation; reconciliation 11 passed.
3. Add `test/dispatchRepository.test.ts`: missing persisted policy implementation; existing 18 passed.
4. Service integration RED: missing dispatch service.
5. Account-flight RED: distinct action incorrectly reserved after an unknown predecessor. One assertion failed, 25 passed. Added actual flight CAS to reservation/outcome.
6. Identity/MIME RED: missing References fence, raw encoded-subject association and loaded-content validation. Three assertions failed, 36 passed. Corrected and reran GREEN.
7. Registry/read identity RED: missing trusted configuration method and mismatched durable reservation accepted. Two failed, 35 passed. Corrected and reran GREEN.

Final focused test command:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH";
npm test --prefix cloud/lambdas/delegated-worker -- test/dispatchRepository.test.ts test/dispatchService.test.ts test/sendReconciler.test.ts test/commandService.test.ts
```

Result: **4 files, 86 tests passed, exit 0**. Counts: policy/service integration 37, intake/manual dependencies 10, reconciliation association 12, C1 mechanics 27.

Coverage includes actual produced transaction targets/conditions, grant and approval revocation races, draft/context/cursor/cap/suppression races, actual B1 route-version changes, cap single consumption under two contenders, no default policy, permission identity/expiry refusal, pause during preparation, late acceptance, crash/restart, two immutable reconciliation records, provider rejection, failed preflight, unknown/multiple matches and no resend.

`npm run typecheck --prefix cloud/lambdas/delegated-worker`: **exit 0**.

`npx --no-install eslint --no-ignore --max-warnings 0` on all nine committed TypeScript paths: **exit 0, no errors/warnings**. The initial lint command without `--no-ignore` reported cloud paths ignored and was not counted as verification. Effective lint initially found one unused variable and a duplicate import warning; both were fixed before the final run.

`git diff --check` passed. Commit used `git commit --only` with exact paths; `git show --name-only` was inspected.

C1's narrow test fixture deliberately isolates original transaction mechanics with a test-only policy subclass. This is not production fallback and is not C4 permission evidence. All C4 integrated policy/dispatch tests use the actual persisted policy and C2 proof. `ConditionalCommandHarness` is an offline interpreter of actual SDK requests, **not live DynamoDB contention acceptance**.

## Held gates and follow-up

- **D1 real campaign/enrollment/campaign-cap binding is missing**, so campaign dispatch is intentionally held. Do not mark whole C4 campaign acceptance complete.
- C6 authenticated command/bootstrap/approval admission integration is not implemented here. C6 received source composition and was told existing `/commands` cannot send; public payloads must not self-attest permission. This task explicitly excluded handler/startup changes.
- Root/coordinator review is still required. No review subagent was spawned, as instructed. The implementer reviewed the exact C1 diff and exercised the focused feedback loop.
- Live isolated DynamoDB contention, actual consenting-mailbox delivery/Sent reconciliation, provider permissions and cloud activation require separate bounded authorization. None was performed.
- No real sends, mailbox operations, grants, network/provider requests, cloud operations, installs, builds, native suites or root suites were executed. HTTP in tests was explicitly fictional and rejected unconfigured paths.
- The reconciler intentionally holds unsupported or ambiguous MIME evidence rather than guessing delivery or retrying. Real Gmail acceptance must verify the supported payload shapes.


## Review repairs and D1 integration follow-up (2026-09-09 01:30 UTC)

Commits: `12498c0` (scope/Sent/replay review repairs), `d0fcade` (concrete campaign transaction splice). Both used exact-path `--only` commits and inspected committed lists. Original source commit remains `6f5aa93`. No shared C3/C6/D1 file was edited by C4.

### Review RED to GREEN

Read the full task-C4-review.md. Actual C1/persisted-policy/C2/C3 fixture reproduced nine failures: seven raw Sent Bcc/header/MIME variants, definitive-not-sent replay, and account participant B opt-out missed while sending A. Strict raw participant/content handling and terminal replay repairs left only I1 failing. C3's persisted full-scope producer and C4 consumer made the suite green. Added absent/narrowed/changed scope, same-envelope final CAS, and bounded expanded-scope rescan tests. C6's new owner command formerly returned a false applied receipt, reproduced RED and fixed with the explicit C1 command allowlist. Result before D1: **101 focused tests GREEN**, worker typecheck and nine-path lint passed.

Scope is inside the existing MailCursorEnvelope. The barrier requires nonnull MailAccountScope, exact account/mailbox, nonfuture approvedAt/since, both poll/checkpoint scopeRevision and canonical mailScopeFingerprint, exact checkpoint.since and scope membership for requiredRecipient/requiredThreadId. One cursor revision CAS fences all of these. Service preflight uses the identity-only C3 poller loading persisted participant/thread scope, never a recipient-derived query. New scope invalidates prior checkpoint/poll and requires bounded rescan. C3 owns admission and producer provenance. C5 consumes this shared barrier.

Sent reconciliation now refuses Bcc, resend/alternate participant headers, unsupported Content-Type charset, Content-Disposition attachments, non-base64 transfer semantics, extra content headers, attachment IDs, filename/parts and incomplete UTF-8 data. It accepts only the narrow emitted sender representation. Definitive provider_not_sent immutable evidence replays not_sent rather than unknown, with zero resend.

### Concrete D1 binding and atomic outcomes

`DynamoDispatchRepository(options, authorization, campaignExecution?)` now accepts the actual concrete CampaignExecution. Adapter/table/workspace must match the C4 store. Missing binding still holds campaign sends. The old frozen campaignDispatchStateSchema is documentary, not an authorization source.

For campaign_step, account_route is mandatory. The policy derives CampaignExecutionInput from the persisted immutable intent, actual approved draft context, authority generation, exact selected route and message hashes. D1's prepareDispatchChecks reads real version/approval/enrollment/cohort/action-content approval/route/cap records. Its synchronous finalize items join the C1 AUTH/ACTION/outbox transaction. There is no second reservation transaction. Identical complete ConditionChecks on ACCOUNT may coalesce; different expected revisions or any other duplicate operation fail with dispatch_condition_conflict. C2 checks remain synchronous and distinct.

`outcomeItems` was replaced with `outcomePlan(outcome,evidence): Promise<{items,campaign?}>`. Campaign prepareOutcomePlan items join the SAME C1 outcome transaction. C6's strict top-level action.outcome.campaign carries the typed CampaignEventPayload through the existing single outbox stream. A deterministic per-SendEvidence UUID provides separate immutable D1 evidence identity for unknown and accepted records. No second EVENT_HEAD. Accepted outcomes move reserved capacity to sent and cannot reopen or advance paused/conversation/held enrollments. Unknown retains reserved capacity. Cancelled capacity is conservatively retained by current D1 policy, not refunded. Sender/day used count is never refunded.

D1 TDD: two RED tests demonstrated blanket campaign hold and missing conflicting-ACCOUNT handling, then concrete reservation integration reached 56 GREEN. A separate RED demonstrated acceptance left reserved=1/sent=0. Atomic outcome splice fixed it. Tests additionally exercise unknown-to-accepted reconciliation retaining two original immutable D1/C4 records, no resend, late paused/conversation/held acceptance, exact cap/outbox/action transaction targets, and enrollment/cap/version-approval/action-approval final CAS races.

Final validation with required Node24 export:

- `npm test --prefix cloud/lambdas/delegated-worker -- test/dispatchRepository.test.ts test/dispatchService.test.ts test/sendReconciler.test.ts test/commandService.test.ts`: **115 passed**, four files (65/10/12/28).
- `npm run typecheck --prefix cloud/lambdas/delegated-worker`: exit 0.
- `npx --no-install eslint --no-ignore --max-warnings 0` on the nine owned/released TypeScript paths: exit 0, no warnings/errors.
- Exact-path diff whitespace check passed.

These tests execute actual produced SDK transaction conditions against the synthetic ConditionalCommandHarness, not live DynamoDB. The former missing-D1 binding gate is resolved at source level when actual CampaignExecution is composed. C6 public command/bootstrap/normal dispatch composition and local campaign projection remain C6-owned integration gates. C6 schema changes were present during GREEN validation, with their commit owned by C6. Root independent re-review of both repair and campaign splice commits remains required. No real network, provider, grants, sends, mailbox access, deployment, build/install/native/root-suite operation occurred. All live/external acceptance gates above remain held.

### Isolated `12498c0` repair evidence trace for re-review

This subsection concerns repair-only evidence, not D1 acceptance. The original 86-test section is historical. The report already contained the 101-test repair result in `8249d19` before this clarification.

| Requirement | Observed RED | Repair-only GREEN evidence |
|---|---|---|
| I1 complete persisted account intake | Sending A skipped B's actual opt-out under recipient-narrow preflight | Full stored A+B scope causes B suppression and zero sends; changed scope resets cursor, bounded rescan precedes send; final cursor CAS rejects scope race |
| I2 exact Sent identity | Seven raw Bcc/alternate-header/unsupported MIME variants falsely accepted | Those variants remain unknown; exact emitted UTF-8 MIME still accepts; no resend |
| Terminal replay | Definitive provider-not-sent became unknown on replay | Same immutable cancelled evidence returns not_sent and send count stays one |
| C6 owner-command boundary | submit-approved-reply returned fake applied authority receipt | Explicit legacy command allowlist throws owner_command_requires_coordinator |

Exact repair verification command executed before `12498c0`:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH";
npm test --prefix cloud/lambdas/delegated-worker -- test/dispatchRepository.test.ts test/dispatchService.test.ts test/sendReconciler.test.ts test/commandService.test.ts &&
npm run typecheck --prefix cloud/lambdas/delegated-worker &&
npx --no-install eslint --no-ignore --max-warnings 0 cloud/lambdas/delegated-worker/src/dispatchRepository.ts cloud/lambdas/delegated-worker/src/dispatchService.ts cloud/lambdas/delegated-worker/src/executionRepository.ts cloud/lambdas/delegated-worker/src/intakeBarrier.ts cloud/lambdas/delegated-worker/src/sendReconciler.ts cloud/lambdas/delegated-worker/test/dispatchRepository.test.ts cloud/lambdas/delegated-worker/test/dispatchService.test.ts cloud/lambdas/delegated-worker/test/sendReconciler.test.ts cloud/lambdas/delegated-worker/test/commandService.test.ts
```

Observed result: 101 tests (51 policy integration, 10 barrier, 12 reconciliation, 28 C1), typecheck exit 0, lint exit 0. The historical repaired test tree used the contemporaneous C3 producer and C6 schemas. Current shared source additionally contains D1 integration, so rerunning current source yields a different count, not an isolated re-execution of the old commit. All HTTP fixtures were fictional, and Dynamo condition acceptance was through the SDK interpreter only.

D1 is separate: C4 source splice `d0fcade` reached 115 focused GREEN after repair; end-to-end integration/re-review remains in progress across C6 and guppy's subsequent internal route/context evidence changes. Do not attribute D1 completeness to the 101-test repair result or infer any live send authorization.

## Separate final source-configuration fence (01:36 UTC)

Root separately released this narrow delta after frozen repair review: `3db307b`, two paths (`dispatchRepository.ts`, `dispatchRepository.test.ts`). It does not alter the historical `12498c0` repair snapshot or rewrite the `d0fcade` campaign splice.

Uses C6 canonical `ownerSourceKey(accountId)` and `ownerSourceConfigurationSchema` from `ownerCommandContract.ts`, with no duplicated schema/table/scheduler permission. Final policy requires a real nonmissing active config whose workspace/account/pairing/mailbox exactly match the immutable dispatch intent. Exactly one `store.check(key,row.rev)` joins the existing final transaction. Config grants no message permission, and AUTH, approved draft, correspondence, intake, suppression, caps and grants remain independent requirements.

Positive fixtures now call the real `OwnerCommandCoordinator.apply(configure-owner, Bearer credential)` using actual WorkerAuth commands:write principal and the fictional real-C2 grant flow. Active admission validates canonical selected ACCOUNT plus actual thread participants and matching full C3 scope. The fixture has no per-message scheduler flag. Explicit individually approved standalone reply remains reachable and sends once. Admission advances AUTH version; test expectations now use the resulting version rather than mutating AUTH backward.

Observed RED: five new checks failed while the preceding 65 integration tests passed. Missing config, authenticated owner pause and mailbox deselection all still produced reservation plans. The separate exact command below then demonstrated both stale plans actually committed after real owner changes, not merely missing an inspected field:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH";
npm test --prefix cloud/lambdas/delegated-worker -- test/dispatchRepository.test.ts -t 'final source config CAS'
```

Two RED failures were resolved promises instead of expected transaction cancellation. After the canonical final check, 70 integration tests passed. Added four persisted identity-corruption refusal checks and a real authenticated selective source pause during credential preparation: active AUTH did not bypass source pause, zero provider sends and zero cap consumption. Final four-file command from the earlier report passed **125 tests (75/10/12/28)**. All HTTP fixtures remained fictional, and CAS execution remained the SDK interpreter, not live DynamoDB.

## Separate root-compatible TypeScript narrowing

`c600b30` changes only `sendReconciler.ts` accepted-evidence return projection to `{messageId, threadId: threadId ?? null}`. No Sent matching condition changed. Reproduced TS2322 at line60 with root-compatible noImplicitAny / strictNullChecks-off compilation before fixing. The initial test-entrypoint check also exposed existing unannotated-null/empty-array fixture errors in that mode, so this was not counted as passing test compilation. Strict worker compilation includes all worker tests and passed.

Root-compatible **production source** check, exit0 after the fix:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH";
npx --no-install tsc --noEmit --skipLibCheck --esModuleInterop --target ESNext --module ESNext --moduleResolution node --noImplicitAny cloud/lambdas/delegated-worker/src/dispatchRepository.ts cloud/lambdas/delegated-worker/src/dispatchService.ts cloud/lambdas/delegated-worker/src/sendReconciler.ts cloud/lambdas/delegated-worker/src/intakeBarrier.ts cloud/lambdas/delegated-worker/src/executionRepository.ts
```

`npm run typecheck --prefix cloud/lambdas/delegated-worker` and scoped `eslint --no-ignore --max-warnings 0` on the three changed TS paths passed. The final 125-test rerun happened after the nullable projection fix. Exact-path diff check and committed file lists passed inspection. C6 owns admission implementation and shared contract commits. Subsequent C6/D1 integration changes require their own rerun/re-review; no live/end-to-end activation claim is added here.

## Separate durable campaign cap snapshot delta (01:39 UTC)

`1167d5f` adds typed `DispatchReservationPlan.campaign?: CampaignEventPayload`. For real campaign reservations the payload includes the exact concrete D1 `CampaignExecutionPlan.cap` snapshot `{campaignVersionId,channel,revision,reserved,sent}` from the same planned cap Put. C1 carries it in the existing dispatching action.outcome event. No second event, AUTH increment, reservation algorithm, or asynchronous publication was added. Outcome payloads already flow through the same integration and now receive D1's actual current cap snapshot too, including a cap CAS for unknown/no-write outcomes. Schema and producer are D1/C6-owned.

Observed RED: actual successful campaign dispatch produced no reservation cap snapshot. Focused `-t 'cap snapshots'` failed on the missing property. Frozen contract uses singular `campaign.cap`. After the concrete D1 producer and C6 cap-only event refinement landed, tests verified reservation revision2/reserved1/sent0, accepted revision3/reserved0/sent1, one event per action transition, and unknown retaining current envelope revision/reserved1/sent0 with no resend. No absent snapshot is converted into zero/current in C4.

Fresh four-file C4 command with the required Node24 export: **127 passed (77/10/12/28)**. Worker strict typecheck, the earlier exact root-compatible five-production-source tsc command, and scoped ESLint on dispatchRepository.ts/executionRepository.ts/dispatchRepository.test.ts all exited0. Exact-path whitespace/diff inspection passed before `--only` commit; three-file commit list inspected. Local cap projector acceptance is guppy/C6-owned, not claimed by these SDK-interpreter event tests. No live operations occurred.
