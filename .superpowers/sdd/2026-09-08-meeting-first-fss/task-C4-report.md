# Task C4 report: one-shot dispatch and reconciliation

Status: **DONE_WITH_CONCERNS** for the source-only standalone-reply slice. **Campaign dispatch remains held pending D1's real persisted binding.** This is not whole-C4 live acceptance or activation approval.

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
