# FSS Functional Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A playbook-driven contact workspace with supported portfolio context and durable explicitly sent intelligent email.

**Architecture:** Reuse encrypted SQLite, lifecycle transaction writer, cadences and trusted IPC. Restore dated actions with a forward migration, add a separate content-bound email ledger, keep model/mail behind main-only interfaces.

**Tech Stack:** Node24, TypeScript, Electron44, React19, Zod4, encrypted SQLite, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-08-functional-redesign.md`

## Global Constraints

- No live mail/model calls, account changes, real-profile access or app replacement during implementation/tests.
- No Next button. Cold: Call primary, Email secondary.
- Person-wide opt-out wins.
- Private local-only notes never leave the machine.
- Build separate package, never canonical out while real app runs.
- Observe intended red test, implement minimal behavior, focused green checks, review and commit owned files.

## Task 1: Dated actions and warm-priority Today (cadence worker)

**Files:** `src/main/db/migrations/0018PlaybookDueActions.ts`, `src/main/db/migrate.ts`, `src/main/domain/startup/storageReadiness.ts`, existing domain cadence/lifecycle/today repositories and services, shared common/today contracts, corresponding main/integration tests.
**Interfaces:** Preserve TodayApi/LifecycleService. PrimaryAction gains nullable/defaulted dueAt for fixtures, populated in production. Queue candidates add segment and actual promise evidence. Worker registers root's0019 after it exists.

- [ ] Write failing migration/invariant/ordering tests: active Unreviewed dated internal action; data/history preserved; one serial bundle action; warm idles automatic cold nudges but preserves actual callbacks/post-stage work regardless of dial cap; post_interview/onboarding accepted; RI weekend/18:00 blocked; day2 weekend booking does not throw.
```ts
expect(queue.map(item => item.personId)).toEqual(['due-callback','warm-intro']);
expect(currentAction.dueAt).not.toBeNull();
```
- [ ] Run focused `npm test -- tests/main/todayOrdering.test.ts tests/main/lifecycleService.test.ts tests/main/cadenceScheduler.test.ts`, retain intended failure.
- [ ] Forward migrate with backfill provenance, wire scheduler dates to persistence, fix queue families and policy. Do not use workIntent alone as promise evidence.
```ts
const eligible = isActualCommitment(candidate) ||
 (candidate.segment === 'warm' ? isDue(candidate) : !hasActiveWarm && isDue(candidate));
```
- [ ] Focused green tests, typecheck, migration self-review, commit owned files.

## Task 2: Protected external providers (provider worker)

**Files:** `src/main/outreach/providers/{providerTypes,credentialStore,openAiDraftProvider,gmailProvider,googleOAuth,outreachProviders}.ts`, `tests/main/outreachProviders*.test.ts`, `docs/outreach-setup.md`.
**Interfaces:** Exact provider types/factory frozen in spec. Native fetch, no extra dependencies.

- [ ] Write failing tests: bounded structured Responses/store:false, invalid evidence rejection; encrypted credential roundtrip/corruption/Keychain refusal; OAuth state/path/PKCE cleanup; token preparation; invalidation; MIME injection; one Gmail request with unknown on timeout.
```ts
expect(await prepared.sendOnce(email)).toEqual({status:'unknown',reasonCode:'network_uncertain'});
expect(observedSendRequests).toHaveLength(1);
```
- [ ] Run focused Vitest and observe intended failures with fixture HTTP only.
- [ ] Implement0600 encrypted envelope in0700 directory, atomic writes, explicit OAuth, fixed endpoints, bounded responses, stable errors, no retry or secret logging.
```ts
const allowed = new Set(context.facts.map(f => f.id));
if (result.evidenceIds.some(id => !allowed.has(id))) throw new Error('ungrounded_output');
```
- [ ] Green provider tests/typecheck, document user setup and no live verification, commit owned files.

## Task 3: Durable drafts and explicit send ledger (root)

**Files:** shared `outreachContract.ts`; migration `0019EmailDrafts.ts`; `src/main/outreach/{emailRepository,emailService,emailEvidence}.ts`; `registerOutreachIpc.ts`; preload outreach factory/createCallieApi/declarations; runtime/startApplication wiring; main email tests and integration emailWorkflow tests.
**Interfaces:** Exact OutreachApi in spec. `createEmailService({databaseGate,providers,now?,id?})` returns OutreachApi plus dispose. Gate exposes withDatabase/withDomain. Main owns lifecycle cancellation/IPC disposal.

- [ ] Write red contract/repository/service tests: edits survive reopen, stale saves reject, no draft stage advancement, repeated/new command on sending/unknown never sends, stale contact/account/optout refuses, accepted evidence exactlyonce, matching action only advances, intent crash stays unknown.
```ts
const edited = await service.saveDraft({draftId:draft.id,expectedRevision:draft.revision,subject:'Portfolio',body:'My edited message'});
expect((await service.openDraft({personId,contactMethodId})).body).toBe(edited.body);
await service.sendDraft({draftId:edited.id,expectedRevision:edited.revision,commandId});
await service.sendDraft({draftId:edited.id,expectedRevision:edited.revision,commandId});
expect(sentMessages).toHaveLength(1);
```
- [ ] Run `npm test -- tests/main/emailRepository.test.ts tests/main/emailService.test.ts`, observe intended red.
- [ ] Implement durable drafts/reservations/results with optimistic revision and contact snapshot, grounded generation (no notes), previewed footer. Prepare token before final authorization. Reserve exact content/account, immediately invoke once, persist receipt/evidence.
```ts
const prepared = await providers.prepare(signal);
const reservation = await gate.withDatabase(db => authorizeAndReserve(db,request,prepared.accountEmail));
const result = await prepared.sendOnce(reservation.email);
return gate.withDatabase(db => persistResultAndEvidence(db,reservation,result));
```
- [ ] Strict trusted IPC with safe fixed errors; compose provider safeStorage in main; invalidate on lock/wake/shutdown without auto-send/reconnect.
- [ ] Green focused tests including real encrypted DB/transaction writer, commit owned files.

## Task 4: Portfolio-first contact UI (UI worker)

**Files:** renderer Today page/route/cards/rows/CSS; inspector overview/composer/provider/fullpage; Settings connections; leadDetailContract extension; new domain/portfolio/portfolioContext.ts; ONLY facade getLeadDetail projection; renderer and portfolio tests.
**Interfaces:** Consume exact window.callie.outreach contract. Portfolio shape frozen in spec. No renderer queue policy duplication.

- [ ] Red tests: no generic questions/refresh/judgment/Next, supported known portfolio, dedupe owned/managed/linked; composer stale-response isolation, persistence, explicit send after save, honest setup; preserve keyboard/focus.
```tsx
expect(screen.queryByText('Do you handle maintenance yourself or use a property manager?')).toBeNull();
expect(screen.queryByRole('button',{name:'Next'})).toBeNull();
expect(screen.getByText(/known portfolio/i)).toBeVisible();
```
- [ ] Run focused renderer/portfolio tests and observe intended failures.
- [ ] Compact prioritized list; default overview only core context/actions; diagnostics in details. Persistent composer with recipient binding and save race guards. Setup disclosure and user-owned credentials, explicit connect/disconnect. Unknown has check-Sent guidance, not Retry.
```tsx
<Button onClick={send} disabled={busy || draft.status !== 'draft'}>Send</Button>
```
- [ ] Green tests/typecheck and light/dark/narrow legibility review, commit owned files.

## Task 5: Review and isolated package acceptance (root)

**Files:** existing Today/discovery/Bauhaus e2e tests updated to approved surfaces; new emailWorkflow e2e; plan ledger evidence.
- [ ] Review each task/spec diff, fix load-bearing findings; full `npm run verify` using Node24. Inspect privacy/authorization boundaries.
- [ ] Build final clean committed HEAD with separate Forge outDir and ad-hoc signing.
- [ ] Run isolated fictional packaged light/dark/narrow, keyboard/person-switch, persisted email/unconfigured setup workflows. Distinguish fixture provider tests from live connectivity.
```ts
await expect(page.getByText('Prepared conversations')).toHaveCount(0);
await page.getByRole('button',{name:'Email',exact:true}).click();
await expect(page.getByLabel('Subject')).toBeVisible();
```
- [ ] Record requirement-to-check matrix, honest live setup boundary; deliver candidate/use instructions. Normal Quit handoff only when ready and authorized, never send real test email.

## Self-review

Spec requirements1–3 map Task1, provider/privacy Task2, persistence/send Task3, portfolio/UI Task4, safe delivery Task5. Types and factory names match spec. No placeholder interfaces. User already approved implementation; use existing specialists without another execution poll.
