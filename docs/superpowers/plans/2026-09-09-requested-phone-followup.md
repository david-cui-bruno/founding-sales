# Requested Phone Followup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Root assigns serialized owners. No subagents in the current C3 session.

**Goal:** Complete the already-approved call → information requested → editable email → individual approval → permitted first email workflow without requiring an inbound email.

**Architecture:** Add one distinct threadless account-draft and phone-request permission variant, backed by the original completed call receipt and an explicit owner attestation in the same meaningful action that approves exact content. Reuse C4's execution owner, reservation, Gmail sender, limits and uncertain-send reconciliation, plus C3's full-account intake. Only provider-observed identity establishes subsequent mail-thread linkage.

**Tech Stack:** Existing TypeScript/Zod, encrypted SQLite/Kysely, AWS SDK DynamoDB transactions, Vitest and injected Gmail/model HTTP transports. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-08-meeting-first-fss-design.md`, especially §5 line74, §6 lines94/98 and §7 lines123–127.

## Global Constraints

- “Public contact information is not proof of recipient consent.”
- “Warm/important messages and substantive replies stay editable and individually approved.”
- “Use Gmail for permitted correspondence and requested follow-ups.”
- “Unknown send/create results are reconciled, never blindly retried.”
- “No prospects are contacted merely to make an automated test pass.”
- Preserve existing IDs, historical schemas, drafts, approvals, receipts and paused/unknown execution. No fabricated Person, inbound message, mailbox sentinel or provider thread.
- This is required existing-spec acceptance, not cold-email expansion. Do not add a separate routine permission wizard or ask for permission twice.
- **Engineering proposal only:** root must approve this contract and exact ownership before code. Humpback consumes it after the current desktop freeze. Camel alone owns additive migration/readiness changes. Product presentation and live activation remain separately unapproved.
- Prefix every npm/npx command with `export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH";`. No installs, full/package/native/build gates, real network/accounts/profiles/OS actions or broad refactor in these tasks.

---

## Source-grounded gap and chosen boundary

C3 `mailThreadContract.ts:48` and `replyDraftService.ts:40–80` require a real thread and derive the recipient from its incoming message. C4 `dispatchRepository.ts:91–106,197–205` requires inbound source evidence even with `account_route` binding. C6 `ownerCommandCoordinator.ts:299–325` repeats that requirement and emits In-Reply-To. Legacy `emailService.ts:40–59` is Person/salesCycle-based. None implements a first account email after a phone request.

**Recommendation:** a distinct `phone_requested_followup` intent, not optional thread fields added to `standalone_reply`. Dromedary confirmed this read-only proposal. Reject alternatives of manufacturing an inbound thread or loosening all existing reply permissions. A separate sender would duplicate authority/reconciliation and is also rejected.

### Proposed public contracts

Create `src/shared/contracts/requestedFollowupContract.ts`, exporting `originalCallRefSchema`, `requestedFollowupDraftSchema`, `approveRequestedFollowupSchema` and the corresponding types below. Leave existing reply DTO/wire hashes unchanged.

```ts
type OriginalCallRef = {
  commandId: string; handoffId: string; actionId: string;
  commandFingerprint: string; outcomeEventId: string; outcomeEventHash: string;
};
type RequestedRecipient =
  | { kind:'account_route'; routeId:string; routeVersion:number; email:string }
  | { kind:'owner_supplied'; email:string; originalCall:OriginalCallRef };
type RequestedFollowupDraft = {
  kind: 'requested_phone_followup'; id: string; accountId: string;
  revision: number; mailboxSubject: string; sender: string; recipient: string;
  recipientBinding: RequestedRecipient; accountVersion: number;
  researchRevision: number; contextRevision: string; originalCall: OriginalCallRef;
  mailContext: { scopeRevision: number|null; scopeFingerprint: string|null;
    inboundContextRevision: number|null; inboundContextFingerprint: string };
  subject: string; body: string; evidenceIds: string[];
  generation: 'model' | 'edited'; updatedAt: string;
};
type ApproveRequestedFollowup = {
  draft: RequestedFollowupDraft; expectedRemoteDraftRevision: number | null;
  approvalId: string; actionId: string; intentCommandId: string;
  request: { statement: 'recipient_requested_information_by_email'; recipient: string };
  expiresAt: string;
};
```

Use existing account ID/email/header bounds, positive safe revision integers and SHA256 hashes. Strict schemas reject `threadId`, `inReplyTo`, `references`, `sourceMessageId` and unknown fields on the new variant. `contextRevision` hashes the actual accountVersion, researchRevision, recipientBinding (including actual route version only for account_route), original-call fingerprints and pinned mailContext. Changes invalidate approval, not editable text. Provider identities are not members of a pre-send draft. A draft may retain null scope/revision bindings while preparation is unverified; get returns stale:true and no executable approval is admitted from that state. Its inbound fingerprint still comes from actual owner thread records, not a guessed empty inbox. The same pending owner approval action may establish the requested processing scope and complete preflight, but may finalize only if that observed evidence fingerprint and the exact reviewed content/recipient/account/call are unchanged; final approval requires every mailContext binding nonnull.

The authenticated `approve-requested-followup` owner command wraps `ApproveRequestedFollowup` in the existing versioned owner-command base. The owner explicitly confirms “They requested this information at [exact email]” while approving the exact recipient/subject/body. The server derives attestation ID from that commandId, principal, recordedAt and hashes, rather than accepting an arbitrary proof or `allowed` flag. The resulting immutable permission has `basis:'phone_request'`, originalCall, exact recipient binding/account context, sender, recipient, mailboxSubject, attestationCommandId/hash and expiry. The approval snapshots draft, permission and intent together. Draft preparation or a `connected` outcome alone grants nothing.

**Receipt validation:** load the original applied `COMMAND#<commandId>` and referenced outbox event, not just mutable `MANUAL_HANDOFF.lastOutcome`. Check workspace/account, applied receipt, exact command/event fingerprints, channel `call`, reported outcome `connected`, handoff/action correspondence, original reservation and no contradiction/opt-out. Preserve the distinction between a human-reported connection and provider-proven connection. Reuse C1's existing original-generation evidence rules, never synthesize a new call under the current generation. Later permission remains independently revocable.

**Recipient binding:** use either an existing actual account email route or an explicit owner-supplied email grounded in this original call/request. The latter remains `owner_supplied` evidence, never a manufactured research source, published route or Person. No generic contact mutation is proposed. The same authenticated owner request/approval action supplies the evidence for permission and unioning this address into the full account mail-processing scope, without deleting existing participants or lifting retained suppression. Existing-route freshness is checked only in the account_route branch.

If scope must expand, the backend retains that exact approval submission as pending, admits the trusted union, resets checkpoint/poll, and performs the complete bounded preflight before creating executable approval. It may rebind only the intentional scope-only revision change when the actual inbound evidence fingerprint and account/call/recipient/content snapshots are unchanged. Any newly discovered/changed relevant mail holds the submission for useful review. Missing scope/proof never authorizes sending. This is one meaningful owner action, not a second consent prompt or a fabricated pre-send thread.

### First-email semantic context fence

Dromedary's source check found no existing account-wide semantic mail revision. AUTH.version changes for configuration/approval too, and cursor envelope rev changes on every poll. Neither is a stable draft-context substitute.

Propose `MailCursorEnvelope.inboundContextRevision: positive-safe-integer|null` and `inboundContextFingerprint: sha256|null`, with missing legacy JSON parsed as null. The fingerprint is canonical sorted `{providerThreadId,revision,contextRevision}` tuples from the actual retained account/mailbox thread projections, including the actual empty set; callers cannot supply an asserted digest. Capture the existing AUTH/cursor fence before reading those records and condition-check it in the final transaction so concurrent changed intake cannot be omitted. C3 initializes the revision to1 on authenticated scope admission, increments it on subsequent scope mutations and exactly once per committed page that changes any relevant thread projection. The fingerprint changes only when those actual thread tuples change. Empty/duplicate pages, beginPoll and failure preserve both semantic values. Intake/context/checkpoint/suppression stay atomic in the existing SQL row/Dynamo item; no additional table/item. Legacy null blocks this new first-email flow until current scope admission plus complete bounded rescan. Existing threaded reply behavior remains unchanged.

The draft/approval pins the current semantic revision/fingerprint and scope revision/hash. Final C4 compares those pinned values, plus freshly complete/current poll evidence, then CAS-checks the **current** envelope rev. New inbound mail invalidates the draft even when accountVersion is unchanged; a harmless refreshed poll does not. C6 exposes this bounded owner proof through the authenticated checkpoint/read path for local preparation, and the remote draft save/admission rechecks it. Do not treat a local-only cursor as current worker proof.

### Minimal additive storage

`0022MailPersistence.ts` gives `delegated_reply_drafts.thread_id` a real thread FK. Do not rebuild/weaken it. Propose exactly **one new table**, `delegated_requested_followup_drafts`, in camel-owned `0024RequestedPhoneFollowup.ts` after the current schema23:

```sql
CREATE TABLE delegated_requested_followup_drafts (
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES pm_accounts(id),
  id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  context_revision TEXT NOT NULL,
  draft_json TEXT NOT NULL CHECK(json_valid(draft_json)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, account_id, id)
);
```

Verified existing migration directory and `0022MailPersistence.ts`/`0023Campaigns.ts`; `0024RequestedPhoneFollowup.ts` does not yet exist and is a proposed Create path, not an implemented migration. Camel reserves the next migration number at root approval if another additive migration has already landed. Do not modify historical21/22/23. Reuse local immutable owner command/event storage for attestation/approval evidence. Remote drafts use `MAIL_REQUESTED_DRAFT#<encodedAccount>#<encodedDraft>` in the existing workspace partition. Reuse existing `DISPATCH_PERMISSION`, `DISPATCH_APPROVAL`, `DISPATCH_INTENT`, `COMMAND` and accepted-send evidence records with strict new variants. No extra consent ledger, mailbox table or synthetic `MAIL_THREAD` is needed.

## Task 1: Freeze contracts and durable threadless drafts

**Proposed owners:** C3 contract/adapters/tests; camel migration/schema/readiness, serialized with root.

**Files:** Create `src/shared/contracts/requestedFollowupContract.ts`, `src/main/outreach/requestedFollowupRepository.ts`, `cloud/lambdas/delegated-worker/src/requestedFollowupRepository.ts`, `tests/main/requestedFollowupRepository.test.ts`, `cloud/lambdas/delegated-worker/test/requestedFollowupRepository.test.ts`. C3 also modifies `src/shared/contracts/mailThreadContract.ts`, `src/main/outreach/threadIntakeRepository.ts`, `cloud/lambdas/delegated-worker/src/threadIntakeRepository.ts` and their existing focused intake tests for the semantic envelope revision. Camel creates `src/main/db/migrations/0024RequestedPhoneFollowup.ts` and modifies `src/main/db/schema.ts`, `src/main/db/migrate.ts`, plus root-allocated migration/readiness fixtures.

**Interfaces:** Both adapters expose `get(accountId,draftId): {draft:RequestedFollowupDraft,stale:boolean}|null` and `save(draft,expectedRevision:number|null):RequestedFollowupDraft`; remote methods return Promises. Immutable identity includes account, draftId, mailbox, originalCall and recipientBinding. Save compares current context/suppression and CAS revision, without granting permission.

- [ ] Write strict-schema and actual SQL-restart/SDK-CAS tests. Assertion sketch only, not a runnable fixture: bind draft/repo/reopened to actual createPmFixture SQL setup and restart in the named test file:
  ```ts
  expect(requestedFollowupDraftSchema.safeParse({...draft, threadId:'invented'}).success).toBe(false);
  expect(() => repo.save({...draft, revision:2}, 0)).toThrow();
  expect(reopened.get(draft.accountId,draft.id)?.draft.body).toBe(draft.body);
  ```
- [ ] Run the two exact new test paths with Node24 `npx vitest run`; observe missing adapter/schema or missing table failures before implementation.
- [ ] Implement the DTO above, one additive table and real adapters. SQL uses an immediate transaction. Dynamo checks current account/recipient-binding/context/AUTH/suppression with the draft put in one transaction. Changed context retains text and returns `stale:true`; saving a draft never mutates scope or authority. Implement the semantic envelope revision rule above in intake/admission, preserving it during no-change polling.
- [ ] Run GREEN tests covering first save/edit/reopen, wrong account/recipient/mailbox/call, stale revision, context change, suppression and ambiguous remote commit. Prove new inbound mail increments semantic revision, duplicate/empty polls do not, scope mutation increments and forces rescan, and concurrent page/approval cannot retain stale permission. Camel separately proves actual current23→24, historical upgrade and future-version refusal under root's gate allocation.
- [ ] Run focused TypeScript/lint and commit only this task's exact allocated paths. Inspect commit names. Do not commit camel's files from C3.

## Task 2: Prepare an editable first draft from actual call/account evidence

**Proposed owner:** C3. **Files:** Create `src/main/outreach/requestedFollowupService.ts`, `tests/main/requestedFollowupService.test.ts`; reuse `providers/openAiDraftProvider.ts` and `emailPlaybook.ts` without broad changes.

**Interfaces:** `prepareRequestedFollowup(PrepareRequestedFollowup,signal):Promise<SavedRequestedFollowup>` and repository `save/get` from Task1. Constructor receives actual receipt/account/mail-context readers, approved product facts, private model transport, clock/id and durable store. These readers return persisted records, not asserted booleans.

- [ ] Write RED tests where a real connected receipt exists but no inbound email/Person exists. Verify the injected actual model request contains approved product/account facts and bounded owner-supplied call evidence, never fabricated mail evidence. Assertion sketch only: modelRequest is captured from the injected HTTP transport, saved is the actual service result, and providerSendCalls is its recording transport counter:
  ```ts
  expect(modelRequest).not.toContain('mail:invented');
  expect(saved.draft.kind).toBe('requested_phone_followup');
  expect('threadId' in saved.draft).toBe(false);
  expect(providerSendCalls).toBe(0);
  ```
- [ ] Run Node24 `npx vitest run tests/main/requestedFollowupService.test.ts` and observe RED.
- [ ] Implement evidence assembly through the existing private OpenAI boundary. Ground recipient in the strict existing-route or owner-supplied request binding and sender in the actual mailbox, never model output. Recheck receipt/context/suppression before and after generation, then call durable `save(draft,null)`. Missing/cancelled/unapplied/wrong-account receipts fail closed. When model is absent, create a durable blank editable draft with generation edited, then accept bounded subject/body edits through the same receipt/context/suppression checks. Blank content is allowed for saving, never for executable approval. No model credential or model-success result is required to edit/save.
- [ ] Prove GREEN generation, editing/reopen, hallucinated evidence rejection, stale context during generation and zero send/permission creation. Commit this task's exact paths after scoped TypeScript/lint.

## Task 3: One meaningful attestation and exact-content approval action

**Proposed owners:** C4 permission/approval admission; C6 authenticated coordinator; camel shared local command replay only under root serialization.

**Files:** Modify `cloud/lambdas/delegated-worker/src/dispatchRepository.ts`, `cloud/lambdas/delegated-worker/src/ownerCommandCoordinator.ts`, `src/shared/contracts/ownerCommandContract.ts`, `src/shared/contracts/delegationContract.ts`, `src/main/delegation/delegationRepository.ts`; tests `cloud/lambdas/delegated-worker/test/ownerCommandCoordinator.test.ts` and new `cloud/lambdas/delegated-worker/test/requestedFollowupAdmission.test.ts`.

**Interfaces:** New `approve-requested-followup` command from the contract above, and explicit `phone_requested_followup` dispatch intent. Keep existing reply and campaign branches unchanged. Admission derives immutable phone-request permission from the same authenticated approval command. A declared account-route binding never substitutes for the actual call and request attestation.

- [ ] Write RED cases for connected-alone, missing attestation, altered recipient, copied receipt from another account, cancelled/unknown/unapplied receipt, duplicate command with changed content and stale route (existing-route branch), ungrounded owner-supplied address and suppressed supplied address. Assertion sketch only: result is the actual owner-command receipt, execution is the SDK-backed repository and sendCalls is the injected provider counter:
  ```ts
  expect(result.status).toBe('rejected');
  expect(await execution.readDispatch(accountId, actionId)).toBeNull();
  expect(sendCalls).toBe(0);
  ```
- [ ] Run the exact admission/coordinator tests and confirm failure because the new command/permission is absent.
- [ ] Add the strict new variant. In the existing owner-command transaction, bind applied original receipt, saved draft revision/context, derived request attestation and immutable approval/intent to current AUTH and command receipt. Partial admission must not leave an executable action. Build admission transaction items for the existing owner-command commit and require final reservation to verify the applied approval command before consuming them. Replay must return the same receipt, not recreate permission after revocation.
- [ ] Prove GREEN one-click attestation+approval, distinct generation provenance, immutable replay, scope broadening/reset, paused/revoked/conflicting receipt holds and no automatic send by mere preparation. Commit only each owner's exact serialized allocation.

## Task 4: Reuse C4 dispatch/reconciliation and bind real replies

**Proposed owner:** C4, C3 only if an explicit accepted-evidence association hook is needed. **Files:** Modify `cloud/lambdas/delegated-worker/src/dispatchRepository.ts`, `cloud/lambdas/delegated-worker/src/dispatchService.ts`, `cloud/lambdas/delegated-worker/src/sendReconciler.ts`, `cloud/lambdas/delegated-worker/src/intakeBarrier.ts`; tests `cloud/lambdas/delegated-worker/test/dispatchService.test.ts`, `cloud/lambdas/delegated-worker/test/sendReconciler.test.ts`, plus new `cloud/lambdas/delegated-worker/test/requestedFollowupDispatch.test.ts`. Reuse `src/main/outreach/providers/gmailProvider.ts` unchanged unless its existing first-message serializer test reveals a concrete gap.

**Interfaces:** The intent's `kind:'phone_requested_followup'` selects strict `{commandId,from,to,subject,body}` frozenMessage. Existing `standalone_reply` retains required thread/reference fields and original hashes. Reuse `createDispatchService(...).dispatch(commandId,signal)` and `createSendReconciler(...).reconcileSend(commandId,signal)`.

- [ ] Write RED end-to-end SDK/HTTP cases with no MAIL_THREAD and an actual admitted phone permission. Assertion sketch only: capture gmailBody/decodedMime/sendCalls from the actual injected Gmail request in the named test, not a hand-built success fixture:
  ```ts
  expect(gmailBody.threadId).toBeUndefined();
  expect(decodedMime).not.toMatch(/^(In-Reply-To|References):/m);
  expect(sendCalls).toBe(1);
  ```
- [ ] Run exact new dispatch tests and confirm the existing thread prerequisite holds them.
- [ ] Branch only the prerequisites and evidence projection. Phone first-mail uses current account/recipient-binding/call/request/draft context and exact pinned inboundContextRevision/scope instead of a fabricated thread context. Require exact recipient in full admitted mailbox scope and complete fresh account poll, but no invented requiredThreadId. Reuse the same final C1 reservation/caps/action race transaction and synchronous prepared sender. Apply current campaign/enrollment conditions if linked to the original campaign; do not duplicate or silently bypass campaign consumption. Full-account reply/context changes invalidate prepared first-email approval.
- [ ] Add first-mail sent verification requiring absence of In-Reply-To/References as well as existing exact RFC Message-ID/from/to/no-extra-routing/subject/MIME/body checks. Timeout/ambiguous result stays unknown and never resends. Persist returned real message/thread identity through existing accepted evidence. Before observing a real inbound message, store no synthetic thread projection. A later authenticated scope update may union the accepted thread identity only, preserving the account participant set and resetting poll proof. Correlate later incoming references/participants with that exact accepted evidence, not subject text.
- [ ] Prove GREEN two-client single dispatch, all final fence races, B-contact optout blocking A's first email, missing read grant, no scope narrowing, no thread headers, forged Sent headers, ambiguous lookup, no resend, accepted real identity and subsequent true inbound association. Commit exact owned paths after scoped checks. SDK interpreter tests are synthetic, not live Dynamo proof.

## Task 5: Normal desktop/owner acceptance without another permission prompt

**Proposed owner:** humpback/C6 after desktop freeze, shared command wiring serialized by root. **Files:** Modify `src/main/delegation/delegationRuntime.ts`, `src/main/ipc/registerOutreachIpc.ts`, `src/preload/createCallieApi.ts`, and `src/main/delegation/executionClient.ts` for the bounded owner-proof read. Contracts are in Task1's `src/shared/contracts/requestedFollowupContract.ts`. Test `tests/integration/delegatedWorkflow.test.ts` and create `tests/integration/requestedPhoneFollowup.test.ts`. All named backend files exist. No renderer/composer/layout edits are included before D3.

**Exact typed backend interfaces** (the service overload additionally accepts AbortSignal from its operation lease):
```ts
type PrepareRequestedFollowup = {
  accountId:string; originalCall:OriginalCallRef;
  recipientBinding:RequestedRecipient; expectedAccountVersion:number;
  mode:'manual'|'model';
};
type GetRequestedFollowup = {accountId:string; draftId:string};
type EditRequestedFollowup = GetRequestedFollowup & {
  expectedRevision:number; subject:string; body:string;
};
type SavedRequestedFollowup = {draft:RequestedFollowupDraft; stale:boolean};
// In runtime and createCallieApi().delegation, validated at both IPC ends:
prepareRequestedFollowup(input:PrepareRequestedFollowup):Promise<SavedRequestedFollowup>;
getRequestedFollowup(input:GetRequestedFollowup):Promise<SavedRequestedFollowup|null>;
editRequestedFollowup(input:EditRequestedFollowup):Promise<SavedRequestedFollowup>;
approveRequestedFollowup(input:ApproveRequestedFollowup):Promise<CommandReceipt>;
```
Export matching strict request/response schemas. IPC channels are respectively `outreach:requested-followup-prepare`, `outreach:requested-followup-get`, `outreach:requested-followup-edit`, `outreach:requested-followup-approve`. Reuse the existing trusted-renderer IPC registration and operation leases. `CommandReceipt` is the existing delegation contract type. Existing approved-send submission routes the resulting intent to Task4. In manual mode prepare/get/edit require no model but still verify actual original receipt, recipient identity, context and suppression; stale/missing owner proof is never represented as ready.

- [ ] Write RED acceptance using real encrypted SQL, actual local→owner command serialization, production SDK adapters with synthetic transport, and injected real model/Gmail HTTP. Start with human call outcome, select an actual route or enter the owner-supplied requested email, prepare/edit/restart, confirm the request and exact content once, submit through the sole owner, then ingest a real-shaped reply.
- [ ] Run Node24 `npx vitest run tests/integration/requestedPhoneFollowup.test.ts` and record the missing normal entrypoint failure.
- [ ] Wire the bounded runtime methods, preserving operation-lease invalidation, full selected-account source/scope derivation and immutable original receipts. The normal user action is the already-required exact email approval with explicit request attestation, not an extra routine consent workflow. No inline local-send fallback or permission inferred from freeform call recap.
- [ ] Prove GREEN restart/offline-pending/reconnect, retained edits, optout/context changes, duplicate approval submission, worker pause and unknown send. Repeat reply-only regression tests unchanged. Root owns packaged/normal activation acceptance separately.
- [ ] Commit only root-approved exact C6 paths and report test relevance honestly. Stop at engineering handoff until root approves code ownership. Do not activate live mailbox, model, phone or deployment to satisfy this plan.

## Self-review and approval checklist

- Spec74/98: Tasks2–5 implement the missing requested first-email path, not a cold-mail permission.
- Spec76/94/167: editable durable draft, one exact approval, context invalidation and factual grounding are Tasks1–3.
- Spec123–127/168/173: original receipts, one owner, full-account intake, suppression, replay/recovery and uncertain-send safety are Tasks1/3/4/5.
- Existing reply permissions and historical migrations remain strict and unchanged. Proposed new APIs/types are named above, and C4's read-only proposal is incorporated.
- **Root engineering decisions requested:** approve the distinct contract and semantic envelope revision; assign camel's one-table migration; serialize C4/C6/shared command files; approve the four exact backend/IPC contracts in Task5; renderer integration remains D3-owned. These are engineering allocations, not a reopened product interview or a new normal user approval gate.
- Execution is inline/serialized using executing-plans after root approval. This document authorizes no source edits or live actions.
