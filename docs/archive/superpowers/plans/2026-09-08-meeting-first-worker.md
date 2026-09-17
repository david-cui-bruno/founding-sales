# C: Delegated Mail and Meetings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run approved correspondence and agreed calendar booking with a durable single execution owner while the Mac is asleep, preserving exact approvals and truthful unknown outcomes.

**Architecture:** An isolated Lambda/DynamoDB worker owns delegated account execution. The Mac submits authenticated, versioned commands and applies durable events. Relevant Gmail threads and Google Calendar are concrete adapters; no whole-mailbox mirror, local sender fallback or S3 object name is an execution lock.

**Tech Stack:** TypeScript/Zod, existing Google HTTP adapter patterns, AWS SDK v3, Lambda/DynamoDB transactions/PITR, API Gateway, EventBridge, SSM SecureString/KMS, Terraform; local encrypted SQLite projections. No enterprise auth platform or always-on VM is needed for this single-user plan.

**Spec:** `docs/superpowers/specs/2026-09-08-meeting-first-fss-design.md`, §§2,5–8,10. Read the [coordination plan](2026-09-08-meeting-first-fss.md).

## Global Constraints

- “For delegated campaigns, the worker is the authoritative execution and suppression owner.”
- “A pause made while offline is visibly **pending**, not falsely confirmed.”
- “Unknown send/create results are reconciled, never blindly retried.”
- “Do not copy the whole local database, private notes, entire mailbox or OS-encrypted credential envelope to a server.”
- Gmail is for permitted correspondence. Campaign approval and a published email are not recipient consent.
- All coordination-plan constraints apply. This plan owns migration 0021, not 0020/0022. AWS resource code remains disabled by default. Deployment/grants/live operations require separate authorization.

## File structure

Create the independent package `cloud/lambdas/delegated-worker/` following existing Lambda package scripts/lockfiles. `src/main/delegation/` owns Mac synchronization and routing. Shared strict wire schemas live under `src/shared/contracts/`. Provider modules used in both runtimes must have no Electron, local SQLite or safeStorage import in the worker bundle; extract only the shared HTTP/MIME logic, not the whole desktop credential manager.

### Task C1: Durable ownership, commands and local projections

**Files:**
- Create: `src/shared/contracts/delegationContract.ts`
- Create: `src/main/db/migrations/0021DelegatedWork.ts`
- Create: `src/main/delegation/delegationRepository.ts`
- Create: `cloud/lambdas/delegated-worker/package.json`, `tsconfig.json` and generated `package-lock.json`
- Create: `cloud/lambdas/delegated-worker/src/executionRepository.ts`
- Create: `cloud/lambdas/delegated-worker/src/commandService.ts`
- Create: `cloud/lambdas/delegated-worker/src/workerAccountRepository.ts`
- Create: `cloud/lambdas/delegated-worker/test/commandService.test.ts`
- Create: `cloud/lambdas/delegated-worker/test/workerAccountRepository.test.ts`
- Create: `tests/main/delegationRepository.test.ts`
- Modify: `src/main/db/migrate.ts`, `src/main/db/domainSchema.ts`, `src/main/db/schema.ts`
- Modify: `src/main/domain/startup/storageReadiness.ts`, `src/main/domain/domainRuntime.ts`

**Interfaces:** use the coordination plan's exact `ActionState`, `AuthorityState`, `CommandReceipt`. `DelegationCommand` carries `{commandId,workspaceId,accountId,expectedAuthorityGeneration,expectedVersion,kind,payload}`. Its schema is a strict discriminated union: C1 supplies delegate/pause/revoke/manual-outcome payloads; C3/C4 add exact email-approval/send payloads; C5 adds the meeting payload. Unknown kinds/keys are rejected, not generic JSON execution. `WorkerEvent` carries `{id,workspaceId,accountId,authorityGeneration,aggregateVersion,kind,payload}` with matching strict event schemas. `ApprovalSnapshot` binds recipient, sender/footer, subject/body hashes, route version, thread/context revision, campaign revision and permission-evidence ID.

`ExecutionRepository.applyCommand(command):Promise<CommandReceipt>`, `reserveDispatch(input):Promise<Reservation>`, `appendOutcome(input):Promise<void>`, `eventsAfter(cursor):Promise<EventPage>`. Reservation contains stable action ID, authority generation, immutable content/target hash and `dispatching` state. `EventPage` contains events and the next durable cursor. `applyWorkerEvent(event):'applied'|'duplicate'|'gap'` updates the local ledger and projection in one transaction.

`WorkerAccountRepository` implements B2's `AccountResearchStore` asynchronously with DynamoDB conditional transactions and the same B1 evidence validators. Create/research/receipt events have strict account/evidence schemas and per-account research revisions, separate from execution authority generation. Receiving a researched account on the Mac never implies delegation, enrollment or permission to contact it. Research jobs can run under an explicitly approved audience/budget without granting that account outbound rights.

- [ ] **RED:** replay an identical pause returns the same receipt; changed payload under the same command ID conflicts. A newer authority generation rejects the old client. Apply one event twice and assert one local row; a sequence gap does not advance the cursor.

```ts
expect(await repository.applyCommand(pause)).toEqual(await repository.applyCommand(pause));
expect(local.applyWorkerEvent(event)).toBe('applied');
expect(local.applyWorkerEvent(event)).toBe('duplicate');
expect(local.applyWorkerEvent({...event,id:'later',aggregateVersion:event.aggregateVersion+2})).toBe('gap');
```

Build `pause`/`event` as strict fixture values for a B1 account. Local tests use the real encrypted DB. Worker unit tests use an injected DynamoDB command adapter, and separately exercise the actual expression/transaction construction.

- [ ] **Run RED:**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/delegationRepository.test.ts
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm test --prefix cloud/lambdas/delegated-worker -- test/commandService.test.ts test/workerAccountRepository.test.ts
```

- [ ] **Implement:** DynamoDB transactional CAS writes account authority/state, idempotent command receipt and event outbox together. No TTL on suppression, unresolved intents or replay-critical outcomes. Publish/read events only after commit and retry publication without repeating the domain mutation. S3 may export evidence, never own claims. Set up package typecheck/test/build scripts like sibling Lambda packages and bundle imported shared schema/ranking modules explicitly. Add local owner markers, command outbox, applied-event ledger, approvals, thread/meeting projection storage and append-only reconciliation in 0021; include fields required by C3/C5, with provider-specific data in strictly validated payloads. Preserve existing schema-19/20 unknown sends as local, never implicitly delegated.

```ts
// One transaction, not claim-then-publish:
await dynamo.send(new TransactWriteItemsCommand({TransactItems:[
  accountVersionUpdate, commandReceiptPut, durableEventPut,
]}));
```

These items are constructed inside `applyCommand`: condition on workspace/account/generation/version, condition absent command ID, and unique event identity. On transaction cancellation, strongly read the prior command and return it only if its fingerprint matches; otherwise reject. No automatic authority takeover after lease expiry.

- [ ] **GREEN:** replay/conflict/out-of-order/version/race/crash-before-publication tests, actual DynamoDB expression checks and local migration preservation. Run B2's admission/restart assertions against both local and remote account-store bindings, and prove research-only events leave outbound authority absent. A separately authorized ephemeral DynamoDB test must later prove two real clients racing one reservation. In-memory tests alone do not close distributed acceptance.
- [ ] **Commit:** only C1 files/schema gates, message `feat: add durable delegated execution ownership`.

### Task C2: Authenticated pairing, explicit Google grants and disabled infrastructure

**Files:**
- Create: `cloud/lambdas/delegated-worker/src/workerAuth.ts`
- Create: `cloud/lambdas/delegated-worker/src/remoteGoogleAuthorization.ts`
- Create: `cloud/lambdas/delegated-worker/src/googleGrantCapabilities.ts`
- Create: `cloud/lambdas/delegated-worker/src/handler.ts`
- Create: `cloud/lambdas/delegated-worker/test/workerAuth.test.ts`
- Create: `cloud/lambdas/delegated-worker/test/remoteGoogleAuthorization.test.ts`
- Create: `cloud/terraform/delegated-worker.tf`
- Modify: `cloud/terraform/variables.tf`
- Modify: `src/main/outreach/providers/providerTypes.ts`
- Modify: `src/main/outreach/providers/googleOAuth.ts`
- Modify: `src/main/outreach/providers/credentialStore.ts`

**Interfaces:** `redeemPairing(code):Promise<PairingGrant>` returns a one-time workspace-scoped 256-bit bearer credential and allowed scopes. Remote storage retains only its hash, workspace, scopes and revocation generation. `beginGoogleGrant(pairingId,capabilities):Promise<{authorizationUrl}>` and `completeGoogleGrant(state,code):Promise<GrantStatus>` bind one-use state/PKCE to the pairing/workspace and approved capabilities. `GoogleGrant` contains provider subject, email, actual granted scopes, owner and purpose; `requireCapabilities(grant,required):void` rejects missing powers.

- [ ] **RED:** expired/reused pairing or OAuth state, wrong workspace, revoked device, mismatched subject and scope downgrade fail before any provider action. Old send-only credentials cannot read mail or create events. Cancelling reauthorization preserves the old valid local credential instead of replacing it with a partial record.

```ts
expect(() => requireCapabilities(sendOnlyGrant,['relevant_read'])).toThrow('grant_missing_capability');
await expect(redeemPairing(consumedCode)).rejects.toThrow('pairing_unavailable');
```

- [ ] **Run RED:**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm test --prefix cloud/lambdas/delegated-worker -- test/workerAuth.test.ts test/remoteGoogleAuthorization.test.ts
```

- [ ] **Implement:** one-use expiring operator bootstrap code, rate-limited redemption, hashed bearer credentials, HTTPS Authorization headers, no token-bearing query URLs/logs. Check revocation on every mutating command, not a stale authorizer cache. Create a separate pause/revoke-only credential and small authenticated emergency endpoint usable without the Mac; never an unauthenticated stop URL. Use a separate remote Google OAuth setup with secure-parameter credentials and verified subject/scopes. The Mac sees status, not remote refresh tokens. Callback can only finish its grant, never pair a device or dispatch mail.

```ts
const wanted = {
  send:'https://www.googleapis.com/auth/gmail.send',
  relevant_read:'https://www.googleapis.com/auth/gmail.readonly',
  availability:'https://www.googleapis.com/auth/calendar.freebusy',
  event_write:'https://www.googleapis.com/auth/calendar.events.owned',
} as const;
```

Use only confirmed capabilities for the selected owned calendar/conflict-calendar configuration. If shared-calendar needs require an additional availability scope, request it explicitly, not full Calendar/ACL access. Explain restricted Gmail read scope, app-limited processing, model transfer/retention and Testing-token lifetime before activation. Do not claim verification exemptions without checking the actual private/personal deployment.

Terraform defaults `delegated_worker_enabled=false`, scheduled polling disabled and no existing resource/schedule changes. Define dedicated least-privilege table/secure-parameter paths, encryption/PITR, redacted bounded logs, API throttling and a reviewed cost envelope. No `terraform apply`, ambient AWS reads or live OAuth while implementing source/tests. Prepare remote revoke semantics distinct from local disconnect.

- [ ] **GREEN:** real loopback/local callback fixtures, OAuth replay/race/cancel tests, auth scope isolation, log-secret tests and package graph check excluding Electron. Validate Terraform syntax only without accessing remote state. Cost/deployment/user grant acceptance remains explicit.
- [ ] **Commit:** stage C2 files only, message `feat: add scoped worker pairing and Google grant setup`.

### Task C3: Relevant Gmail threads and editable reply intelligence

**Files:**
- Create: `src/shared/contracts/mailThreadContract.ts`
- Create: `src/main/outreach/providers/gmailThreadProvider.ts`
- Create: `src/main/outreach/threadIntake.ts`
- Create: `src/main/outreach/replyDraftService.ts`
- Create: `src/main/outreach/replyClassification.ts`
- Modify: `src/main/outreach/providers/gmailProvider.ts`
- Modify: `src/main/outreach/providers/openAiDraftProvider.ts`
- Modify: `src/main/outreach/emailPlaybook.ts`
- Create: `tests/main/gmailThreadProvider.test.ts`
- Create: `tests/main/replyDraftService.test.ts`
- Create: `cloud/lambdas/delegated-worker/src/mailPoller.ts`

**Interfaces:** `ThreadReadRequest={accountId,knownThreadIds,participantAddresses,since,cursor,maxPages,maxBodyBytes}`; `ThreadPage={threads,nextCursor,complete}`; each `RelevantThread` stores Gmail IDs, RFC message IDs/references, exact participants, dates and bounded selected body parts separately. `readRelevantThreads(request,signal):Promise<ThreadPage>`, `ingestThread(thread):Promise<{changed,revision,signals}>`, `prepareReply(threadId,expectedRevision):Promise<EmailDraft>`. `ReplyClassification` is substantive/scheduling/mixed/opt_out/rejection/out_of_office/delivery_failure/ambiguous with supported evidence references, never an execution instruction.

- [ ] **RED:** same subject with different participants/references must not join a sales thread. Duplicate message leaves revision unchanged. Unrelated message bodies are not retained or sent to the model. A reply arriving while approval is open invalidates that approval.

```ts
expect(associateThread({knownReferences:['<sales@fixture.invalid>'],
  incomingReferences:['<other@fixture.invalid>'], participantsMatch:false})).toBe('unmatched');
expect(await intake.ingestThread(existingMessage)).toMatchObject({changed:false});
```

`associateThread` is a pure helper in `threadIntake.ts`; valid association requires provider thread identity or appropriate RFC references plus validated participant/account binding. Define fixture values locally in the new suites.

- [ ] **Run RED:**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/gmailThreadProvider.test.ts tests/main/replyDraftService.test.ts tests/main/emailService.test.ts
```

- [ ] **Implement:** start with two-minute worker polling, bounded initial window and known/authorized account contacts. Use `history.list` with durable cursor and pagination, metadata/header filtering before retaining relevant bodies, message-ID dedupe and transactional intake/cursor updates. An expired history cursor triggers a bounded rescan, not full mailbox import. Do not assume replies stay in INBOX. Apply observed reply/opt-out context before dispatch. Extend actual MIME/send request with exact Gmail `threadId`, RFC `In-Reply-To` and `References`, keeping deterministic outgoing Message-ID and strict CRLF bounds.

```ts
const page = await provider.readRelevantThreads(request, signal);
await store.transaction(async tx => {
  for (const thread of page.threads) await tx.ingestThread(thread);
  if (page.complete) await tx.saveCursor(page.nextCursor);
});
```

`store.transaction`, `ingestThread` and `saveCursor` are task-owned adapters to C1's transactional intake ledger; cloud and local bindings must preserve atomicity, not literally run a SQL transaction in Lambda. Token refresh happens before the final dispatch fence, not in a send retry loop. Treat incoming text as untrusted content. Draft with approved Callie facts, scoped account/thread evidence and explicitly provided style examples. No invented integrations/pricing, automatic pilot commitment or whole-mailbox style training. Substantive/mixed/ambiguous replies require approval; out-of-office is not interest. Add held-out fictional examples and edit-pair metrics without reading personal mail.

- [ ] **GREEN:** paginated replay, checkpoint crash, expired cursor, base64/MIME/HTML bounds, participants, forwarded/changed subject, opt-out/reply races, missing grant, CRLF headers, content-policy and model hallucination fixtures. Verify actual provider adapter HTTP requests, not only a fake reply service.
- [ ] **Commit:** stage C3 files only, message `feat: prepare truthful thread-aware email replies`.

### Task C4: One-shot approved dispatch and reconciliation

**Files:**
- Create: `cloud/lambdas/delegated-worker/src/dispatchService.ts`
- Create: `cloud/lambdas/delegated-worker/src/sendReconciler.ts`
- Create: `cloud/lambdas/delegated-worker/src/intakeBarrier.ts`
- Create: `cloud/lambdas/delegated-worker/test/dispatchService.test.ts`
- Create: `cloud/lambdas/delegated-worker/test/sendReconciler.test.ts`
- Modify: `src/shared/contracts/delegationContract.ts`

**Interfaces:** `dispatch(commandId):Promise<DispatchOutcome>`, `reconcileSend(commandId):Promise<ReconciliationOutcome>`. Outcome is held/not_sent/provider_accepted/unknown with bounded reason and optional provider identity. Consume C1 approval/authority/context and C3 real Gmail adapter. `intakeBarrier.check(subject,signal)` enumerates known enabled/relevant adapters, verifies their committed checkpoints and manual-outcome dependencies, and returns ready/blocked with revision evidence.

- [ ] **RED:** pause during token preparation yields zero sends; changed thread/route/campaign revision rejects approval; reserve then crash leaves unknown that no second worker resends. Provider acceptance arriving after pause is still recorded without advancing the campaign.

```ts
expect(await service.dispatch(staleApprovalId)).toMatchObject({status:'held'});
expect(sender.sendOnce).not.toHaveBeenCalled();
await service.reconcileSend(unknownId);
expect(sender.sendOnce).not.toHaveBeenCalled(); // Absence in Sent is not resend permission.
```

- [ ] **Run RED:**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm test --prefix cloud/lambdas/delegated-worker -- test/dispatchService.test.ts test/sendReconciler.test.ts
```

- [ ] **Implement:** prepare token/provider operation first, then transactionally recheck authority, current approval/context, permission basis, suppression, observed-inbound freshness, campaign state and caps, and reserve one immutable dispatch intent. Immediately invoke the one-shot sender. A committed reservation is treated as in flight; a later pause cannot guarantee unsending it. No TTL/lease-based takeover of unknown work. Authoritative pause blocks all not-yet-reserved work and late results never revive acquisition.

```ts
const prepared = await sender.prepare(signal);
const reserved = await repository.reserveDispatch(currentIntent);
if (reserved.kind !== 'reserved') return {status:'held',reason:reserved.reason};
let outcome: DispatchOutcome;
try { outcome = await prepared.sendOnce(reserved.frozenMessage); }
catch { outcome = {status:'unknown',reason:'provider_result_unknown'}; }
await repository.appendOutcome({actionId:reserved.actionId,outcome});
```

`Reservation` is the C1 strict union `{kind:'reserved',actionId,frozenMessage}` or `{kind:'held',reason}`. `prepare` comes from the extracted real Gmail provider and may refresh tokens; `sendOnce` never does hidden retries. C1 checks/work claims persist account serialization. Reconciliation looks up deterministic message identity and verifies participants/content association; one unambiguous sent match appends acceptance evidence. No match or ambiguous matches stay unknown. No result row is overwritten. Log safe state/reason IDs, not message text/tokens.

- [ ] **GREEN:** two-worker race, duplicate command, caps, expiry, opt-out/reply/pause before reservation, late acceptance, timeout, process restart, unknown/multiple sent matches, and no automatic resend. Real DynamoDB contention acceptance runs only in an approved isolated namespace.
- [ ] **Commit:** C4 files only, message `feat: fence delegated sends and reconcile uncertain outcomes`.

### Task C5: Actual rule-bound calendar booking

**Files:**
- Create: `src/shared/contracts/meetingContract.ts`
- Create: `src/shared/meetings/schedulingRules.ts`
- Create: `src/main/meetings/calendarProvider.ts`
- Create: `cloud/lambdas/delegated-worker/src/meetingCoordinator.ts`
- Create: `tests/main/calendarProvider.test.ts`
- Create: `tests/main/schedulingRules.test.ts`
- Create: `cloud/lambdas/delegated-worker/test/meetingCoordinator.test.ts`

**Interfaces:** `SchedulingRules` contains confirmed revision, IANA timezone, weekly windows, duration, buffers, minimum notice, horizon, conflict calendar IDs, owned target calendar and location policy. `MeetingIntent` binds command/account/thread revision, explicit agreed slot or delegated-choice evidence, UTC start/end, timezone and stable meeting ID. `CalendarPort` implements `availability(query,signal)`, `create(intent,signal)`, `get(identity,signal)`, `update(intent,signal)`, `cancel(identity,signal)` returning explicit confirmed/absent/unknown provider results. `coordinateMeeting(intent):Promise<MeetingOutcome>` returns held/booked/unknown/cancelled, not attendance.

- [ ] **RED:** interest without slot agreement creates nothing; two overlapping intents serialize; DST nonexistent/ambiguous local time requires clarification unless an explicit valid offset resolves it; a timed-out create found by deterministic ID becomes one booked event.

```ts
expect(validateMeetingIntent({...intent,agreementEvidenceId:null}, rules)).toEqual({allowed:false,reason:'slot_not_agreed'});
const first = await coordinator.coordinateMeeting(intent);
expect(first.status).toBe('booked');
expect((await coordinator.coordinateMeeting(intent)).providerEventId).toBe(first.providerEventId);
expect(provider.create).toHaveBeenCalledTimes(1);
```

- [ ] **Run RED:**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/calendarProvider.test.ts tests/main/schedulingRules.test.ts
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm test --prefix cloud/lambdas/delegated-worker -- test/meetingCoordinator.test.ts
```

- [ ] **Implement:** UTC instants plus explicit IANA timezone, never host-local parsing. Validate local representation/offset against `Intl.DateTimeFormat` and reject unresolvable local times. Require confirmed rules and evidence of an agreed slot or permission to choose, not merely positive sentiment. Serialize founder-calendar intents in C1; recheck all conflict calendars and fail on per-calendar errors. Persist a stable Google-valid event ID before `events.insert`, use deliberate attendee invitations and verify any requested Meet link rather than fabricating it. Timeout → `events.get` reconciliation before any new insert.

```ts
const existing = await calendar.get(identity, signal);
if (existing.kind === 'confirmed') return recordProviderMeetingState(existing);
if (existing.kind === 'unknown' || storedIntent.state === 'unknown') return holdForReconciliation();
const busy = await calendar.availability(query, signal);
if (overlapsWithBuffers(slot, busy, rules)) return holdForAnotherSlot();
return createReservedMeeting(intent);
```

The coordinator owns these helper methods: `recordProviderMeetingState` appends provider-confirmed status including cancellation and attendee state, never turning an existing cancelled event back into a booking; `holdForReconciliation` and `holdForAnotherSlot` append held reasons; `createReservedMeeting` performs one C1-reserved provider creation then outcome recording. `validateMeetingIntent` and `overlapsWithBuffers` are pure exports of `schedulingRules.ts`. Use ETags for update/cancel. Preserve meeting ID during reschedule/cancel and reconcile webhook/poll updates. Post-create detection handles external-calendar races; do not promise free/busy is atomic. Booked, invited, accepted, cancelled, held and pilot-start evidence are distinct.

- [ ] **GREEN:** actual HTTP/MIME-free Calendar adapter fixtures, per-calendar errors, timezones/DST, buffer/notice/horizon, duplicate/timeout/ETag races, cancellation/rescheduling and mixed-reply approval. Live create/invite/cancel requires explicit safe test calendar/attendee authorization.
- [ ] **Commit:** C5 files only, message `feat: coordinate agreed meetings with real calendar identities`.

### Task C6: Integrate Mac sync, ownership transfer and overnight recovery

**Files:**
- Create: `src/main/delegation/executionClient.ts`
- Create: `src/main/delegation/delegationSync.ts`
- Create: `src/main/delegation/executionRouter.ts`
- Modify: `src/main/outreach/emailService.ts`
- Modify: `src/main/startApplication.ts`
- Modify: `src/main/ipc/registerOutreachIpc.ts`
- Create: `tests/integration/delegatedWorkflow.test.ts`
- Create: `tests/e2e/delegatedMeetings.spec.ts`
- Modify: `tests/e2e/functionalEmail.spec.ts`
- Modify: `docs/outreach-setup.md`

**Interfaces:** `ExecutionClient.submit(command):Promise<CommandReceipt>`, `sync(signal):Promise<SyncReport>` where report has applied/gap counts, cursor and owner freshness. `executionRouter.routeSend(request)` dispatches locally only for an unambiguously local account, otherwise submits to the worker. Local status `delegating` blocks both old local dispatch and new worker execution until handoff commits.

- [ ] **RED:** delegate while a local send is unresolved and prove neither side sends a duplicate. Disconnect a delegated send and assert zero local fallback. Apply duplicate/out-of-order events, pause offline, restart and reconnect without changing a draft's unsaved text or pretending pause was applied.

```ts
await router.routeSend(delegatedRequest);
expect(localSender.sendOnce).not.toHaveBeenCalled();
expect(await executionClient.sync(signal)).toMatchObject({gaps:0});
expect(await drafts.get(draftId)).toMatchObject({body:editedBody});
```

- [ ] **Run RED:**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/integration/delegatedWorkflow.test.ts tests/main/emailService.test.ts
```

- [ ] **Implement:** authenticated transport, idempotent command outbox, owner-applied receipts, gap reconciliation and transactional local event application. Compose B2's actual discovery/page/research worker with C1's remote account store, using remote scoped model credentials, approved audience/budget and no Electron/SQLite imports. Sync its durable evidence events into B1's local projections without creating execution rights. Transfer execution in two stages: block local execution and resolve old in-flight intents, then confirm worker generation. Never upload the whole DB or credential envelope. Bootstrap only selected account/campaign/context/grant state, including current suppression. Local edits remain local until their approved exact revision is submitted. Register C3 mail/worker freshness with A1's subject-aware barrier. On lock, stop local operations but do not silently revoke separately authorized worker automation. Explicit pause/revoke remains available with correct pending/applied wording.

```ts
const owner = await authorities.read(request.accountId);
if (!owner) return held('authority_unavailable');
if (['delegating','paused','revoked'].includes(owner.state)) return held('authority_inactive');
if (owner.owner === 'worker' && owner.state === 'active') return executionClient.submit(toApprovedCommand(request, owner));
if (owner.owner !== 'local' || owner.state !== 'local') return held('authority_unavailable');
return localExecution.send(request);
```

`toApprovedCommand` validates and binds exact draft/context/authority; `held` returns a non-dispatched status. Both are task-owned router helpers, not unsafe fallback code. Add explicit tests for absent, paused, revoked and inconsistent owner/state pairs, all with zero local sends. Restore rehydrates projections only after reconciling worker generation/suppression; it never restores old execution rights, resumes paused campaigns or retries unknown sends.

- [ ] **GREEN and live gate:** run source/fixture assembled tests and real adapter HTTP fixtures. After cost/deployment/grant/endpoint authorization, prove real relevant email reply → approved response → agreed Calendar event while Mac asleep, then reconnect and verify one result. Verify remote pause/revoke without the Mac. Keep permanent negative controls for a missing reader, duplicate dispatcher and disabled booking adapter. If a real prerequisite is absent, report it separately and do not claim end-to-end acceptance.
- [ ] **Commit:** C6 files only, message `feat: integrate delegated mail and meeting recovery with Mac`.
