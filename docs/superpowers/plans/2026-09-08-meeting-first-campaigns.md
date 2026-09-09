# D: Campaigns and the Daily Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver small coordinated calls/LinkedIn/permitted-email campaigns, a quiet daily workspace and truthful meeting/pilot reporting, then retire misaligned defaults without deleting history.

**Architecture:** A pure account-level sequence planner produces conditional work. Local repositories preserve drafts/manual outcomes; delegated changes execute through C's authority service. React consumes account, reply and meeting projections rather than inventing integration success. Reuse Kith's concepts, not its browser bot or recruiter data.

**Tech Stack:** Existing TypeScript/Zod/Kysely/React, Vitest/Testing Library, packaged Playwright fixtures and C's worker command/event contracts.

**Spec:** `docs/superpowers/specs/2026-09-08-meeting-first-fss-design.md`, §§3,5,7–10. Read the [coordination plan](2026-09-08-meeting-first-fss.md).

## Global Constraints

- “For v1, allow one active acquisition enrollment per account.” Paused/held enrollment is still nonterminal.
- “Copying/opening is not sending.” “Absence of a recorded reply is not confirmed silence.”
- “Exact layout and navigation are not yet approved” and require D3's focused review before renderer changes.
- Preserve Bauhaus, light/dark/system, density, keyboard/focus, stable selection and edits.
- Shared Node 24, scope/activation, safety, migration and commit constraints apply. D1 owns migration 0022. No Kith app/runner access, browser bot, scraping, paid LinkedIn product, outbound send or invitation is part of offline implementation.

## File structure

`src/main/domain/campaign/` owns immutable strategy/enrollment/planning/reporting. `src/main/linkedin/` owns editable manual-step state and safe open/copy/report operations. `src/main/domain/today/dailyProjection.ts` composes the three daily lanes. Renderer changes wait for a reviewed static mockup. `legacyWorkflowTransition.ts` changes scheduling mode with provenance, not destructive catalog edits.

### Task D1: Versioned campaigns and truthful conditional progression

**Files:**
- Create: `src/shared/contracts/campaignContract.ts`
- Create: `src/main/db/migrations/0022Campaigns.ts`
- Create: `src/main/domain/campaign/campaignRepository.ts`
- Create: `src/main/domain/campaign/sequencePlanner.ts`
- Create: `src/main/domain/campaign/campaignService.ts`
- Create: `cloud/lambdas/delegated-worker/src/campaignExecution.ts`
- Create: `cloud/lambdas/delegated-worker/src/workerCampaignRepository.ts`
- Create: `cloud/lambdas/delegated-worker/test/workerCampaignRepository.test.ts`
- Create: `tests/fixtures/campaignWorkspace.ts`
- Create: `tests/main/campaignRepository.test.ts`
- Create: `tests/main/sequencePlanner.test.ts`
- Create: `tests/integration/concurrentCampaignEnrollment.test.ts`
- Modify: `src/main/db/migrate.ts`, `src/main/db/domainSchema.ts`, `src/main/db/schema.ts`
- Modify: `src/main/domain/startup/storageReadiness.ts`, `src/main/domain/domainRuntime.ts`

**Interfaces:**

```ts
export type CampaignVersion = {
  id:string; campaignId:string; version:number; audienceHash:string; offer:string;
  objective:'meeting'; cohortAccountIds:string[]; approvedAt:string|null;
  steps:{id:string; channel:'call'|'email'|'linkedin'; condition:'initial'|'requested_info'|'no_reply'; delayHours:number}[];
  channelCaps:{call:number; email:number; linkedin:number}; contentPolicyHash:string;
};
export type Enrollment = {
  id:string; accountId:string; selectedRouteId:string; personId:string|null;
  campaignVersionId:string; currentStepId:string|null; version:number;
  state:'active'|'held'|'paused'|'conversation'|'completed'|'stopped';
};
export type StepEvidence = {
  stepId:string; routeId:string; outcome:string; observedAt:string;
  observation:'unknown'|'no_reply'|'replied'; source:'provider'|'human'; contextRevision:number;
};
export type CampaignDecision = {kind:'wait'|'prepare'|'stop'; stepId:string|null; reason:string};
```

`CampaignRepository.enroll({commandId,accountId,selectedRouteId,campaignVersionId}):Enrollment`, `planNext(version,enrollment,evidence,now):CampaignDecision`, `evaluateNoReply({channel,observation}):'eligible'|'wait'|'stop'`. C1 `ActionState` tracks delivery separately from enrollment state. `workerCampaignRepository` provides the asynchronous counterparts on DynamoDB with account-wide conditional enrollment uniqueness, immutable approved versions and transactional outcome/event writes. Delegated mutations go through C1 commands; the local repository is their projection, not a second campaign owner. `campaignExecution` adapts decisions into C4 authorization, never performs its own sends.

- [ ] **RED:** two approved versions cannot enroll the same account, including while first is held/paused. Changed strategy requires reapproval. Queueing a step does not advance it; unknown LinkedIn inbox state waits.

```ts
expect(evaluateNoReply({channel:'linkedin',observation:'unknown'})).toBe('wait');
expect(evaluateNoReply({channel:'linkedin',observation:'replied'})).toBe('stop');
expect(() => repo.enroll(secondCampaignForSameAccount)).toThrow('account_already_enrolled');
```

Create `createCampaignFixture()` returning real SQL repositories plus a B1 account/two routes/two approved versions in `campaignWorkspace.ts`. IDs are valid fixture UUIDs, not invalid one-character substitutes.

- [ ] **Run RED:**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/campaignRepository.test.ts tests/main/sequencePlanner.test.ts tests/integration/concurrentCampaignEnrollment.test.ts
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm test --prefix cloud/lambdas/delegated-worker -- test/workerCampaignRepository.test.ts
```

- [ ] **Implement:** 0022 adds immutable campaign versions/approvals, enrollment, step/outcome receipts and manual LinkedIn draft tables. Partial uniqueness covers active/held/paused/conversation accounts until the enrollment is terminal. Approval freezes cohort boundaries, offer, steps, caps and allowed content; recipient/thread approvals remain C4's separate gate. Every mutation has idempotency and CAS. Preserve account coordination when switching people/routes. Use existing versioned date/window primitives without mutating historical cadence definitions.

```ts
if (!version.approvedAt) return {kind:'wait',stepId:null,reason:'campaign_unapproved'};
if (enrollment.state !== 'active') return {kind:'wait',stepId:null,reason:'enrollment_inactive'};
if (evidence.some(e => e.observation === 'replied'))
  return {kind:'stop',stepId:null,reason:'conversation_started'};
```

Complete `planNext` by selecting the current approved step, checking delay, exact route/context evidence, caps and condition. Human no-reply evidence is scoped to a step, route, context revision and observed time; it is never a perpetual claim about an unread inbox. No observation means wait, not eligible. Replies move to conversation handling, bookings stop acquisition, opt-outs suppress according to person/account scope. Reservations consume scheduling capacity without incrementing sent counts. Delegate interrupt commands through C; offline local blocks show pending until acknowledged.

- [ ] **GREEN:** simultaneous real SQL writers, replay/conflict, contact switch, changed audience/content, unknown/late outcomes, reply/opt-out/booking interruption, worker generation changes, cap/time-window boundaries and pause/resume without another enrollment. Verify C4's actual worker adapter refuses missing/old campaign authorization.
- [ ] **Commit:** D1 files/schema gates only, message `feat: coordinate versioned account campaigns across channels`.

### Task D2: Durable AI-prepared, manually sent LinkedIn steps

**Files:**
- Create: `src/shared/contracts/linkedInContract.ts`
- Create: `src/main/linkedin/linkedInService.ts`
- Create: `src/main/linkedin/linkedInRepository.ts`
- Create: `src/main/linkedin/registerLinkedInIpc.ts`
- Create: `src/preload/apis/linkedInApi.ts`
- Create: `tests/main/linkedInService.test.ts`
- Create: `tests/integration/linkedInDraftPersistence.test.ts`
- Modify: `src/preload/createCallieApi.ts`
- Modify: `src/shared/preload.d.ts`
- Modify: `src/main/startApplication.ts`

**Interfaces:** `LinkedInService.prepare({stepId,expectedVersion})`, `save({draftId,expectedRevision,body})`, `open({draftId,expectedRevision})`, `copy({draftId,expectedRevision})`, `reportOutcome({commandId,draftId,expectedRevision,outcome,observedAt,replyText?})`. Drafts bind account, route/person, campaign/step and content revision. Open/copy results are not send receipts. `reduceManualStatus(state,event):ActionState` uses C1's state vocabulary.

- [ ] **RED:** save/reopen preserves text and person isolation. Copy/open never mark sent. Invalid scheme/host/redirect targets never reach the shell. A report for an old draft revision cannot mark the newly edited draft sent.

```ts
expect(reduceManualStatus('prepared','copied')).toBe('prepared');
expect(reduceManualStatus('prepared','opened')).toBe('prepared');
expect(reduceManualStatus('prepared','reported_sent')).toBe('human_reported_sent');
```

- [ ] **Run RED:**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/linkedInService.test.ts tests/integration/linkedInDraftPersistence.test.ts
```

- [ ] **Implement:** generate from approved product facts and B1 source context using the configured draft provider, without scraping LinkedIn or treating a title as authority. Store editable draft revisions through the existing conflict-aware persistence pattern. Validate saved HTTPS `linkedin.com`/`www.linkedin.com` profile or messaging-thread paths; reject arbitrary hosts, non-HTTPS schemes and redirect query payloads. Safe shell open and clipboard calls are injected; no browser automation, API sender, acceptance detector or inbox poller exists in this lane.

```ts
const draft = repository.requireRevision(input.draftId, input.expectedRevision);
await clipboard.writeText(draft.body);
return {draftId:draft.id, revision:draft.revision, status:'copied'};
```

`clipboard` is the injected main-process clipboard adapter. `repository.requireRevision` is implemented by this task; it never updates transport state. Explicit human sent/reply/no-reply/opt-out reports append attributed evidence and synchronize to C before dependent steps resume. Do not infer no reply from elapsed time. Preserve edits during failed IPC/close/reopen; use one primary context action in the later D3 UI.

- [ ] **GREEN:** strict IPC/preload parsing, wrong-workspace/draft binding, late saves/reports, cancellation, safe URL validation, unavailable profile, opt-out, duplicate report and process restart. Fixtures capture shell/clipboard calls and must not open LinkedIn or touch the user's clipboard.
- [ ] **Commit:** D2 files only, message `feat: add persistent manual LinkedIn campaign steps`.

### Task D3: Review the layout, then compose the daily workspace

**Files:**
- Create after approval: `src/shared/contracts/dailyContract.ts`
- Create after approval: `src/main/domain/today/dailyProjection.ts`
- Create after approval: `src/renderer/features/today/DailyAnswers.tsx`
- Create after approval: `src/renderer/features/today/UpcomingMeetings.tsx`
- Create after approval: `src/renderer/features/linkedin/LinkedInStep.tsx`
- Create after approval: `src/renderer/features/campaigns/CampaignReview.tsx`
- Modify after approval: `src/renderer/features/today/TodayRoute.tsx`, `src/renderer/features/today/TodayPage.tsx`
- Modify after approval: `src/renderer/app/navigationItems.ts`, `src/renderer/app/routeRegistry.tsx`
- Create: `tests/main/dailyProjection.test.ts`
- Create after approval: `src/renderer/features/today/DailyAnswers.test.tsx`
- Create after approval: `src/renderer/features/today/UpcomingMeetings.test.tsx`
- Create after approval: `src/renderer/features/linkedin/LinkedInStep.test.tsx`
- Create after approval: `src/renderer/features/campaigns/CampaignReview.test.tsx`
- Create: `tests/e2e/meetingFirstWorkspace.spec.ts`

**Interfaces:** `buildDailySnapshot({accounts,calls,approvals,meetings,ownerStatus,issues}):DailySnapshot`. Snapshot exposes three lanes plus revision/freshness and bounded operational issues. It consumes B3's call allocation, C's exact draft/event identities and D2's manual-step state. No duplicate independent status store in React.

- [ ] **Layout gate:** offer the brainstorming visual companion when presenting this genuine visual choice. Show one recommended static design and one meaningful compact alternative, not another large prototype gallery. Include calls/answers/meetings, company portfolio/context, campaign review, manual LinkedIn and connection/offline states in light/dark and 1050/1440 widths. Record David's chosen artifact revision before renderer implementation. Continue backend work while this review is pending, not unapproved UI edits.
- [ ] **RED:** projected meetings come only from C5 identities, approvals bind exact drafts, routine research failures aggregate operationally, and daily new-call allocation survives warm work. After layout approval, tests exercise stable editor DOM/focus and account selection through refresh.

```ts
expect(buildDailySnapshot(fixture).meetings.map(m => m.id)).toEqual([confirmedMeetingId]);
expect(buildDailySnapshot(fixture).answers.some(a => a.kind === 'routine_research_review')).toBe(false);
```

`fixture` combines actual B/C/D fixture repositories, including a legacy interview-booked activity that must not become a calendar meeting.

- [ ] **Run RED:**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/dailyProjection.test.ts src/renderer/features/today src/renderer/features/linkedin src/renderer/features/campaigns
```

- [ ] **Implement approved layout:** use existing shell/theme/density primitives, one primary action, on-demand details and owner-scoped preserve-view refresh. Reuse conflict-aware email sessions; do not force an editor remount or failed flush before recovery. Campaign approval displays audience/offer/steps/caps/sample drafts and records a frozen version. LinkedIn says manual and requires explicit outcome. Connection status distinguishes configured, pending, owner-applied, unavailable and unknown. Queue capacity is not fake completed-call progress.

```tsx
<DailyAnswers items={snapshot.answers} />
<UpcomingMeetings items={snapshot.meetings} />
```

These task-owned components consume only their typed lane items and existing session/selection context. Calls still use A/B authorization, sends use C's execution owner, meeting edits use C5. Route/focus changes alone perform no outreach. Put transient saving/error feedback where it cannot move a pressed action between mouse-down and mouse-up.

- [ ] **GREEN:** actual components, keyboard/modifiers/Escape, light/dark/system/density, narrow overflow, contrast during animation, first-click behavior, draft autosave/close/reopen, recipient changes, pending offline pause, real meeting states and process restart. Run packaged fixture acceptance on the coordinator's exact candidate.
- [ ] **Commit:** approved D3 paths only, message `feat: focus the daily workspace on calls replies and meetings`.

### Task D4: Truthful acquisition reporting and explicit legacy transition

**Files:**
- Create: `src/main/domain/campaign/accountPipelineProjection.ts`
- Create: `src/main/domain/campaign/acquisitionReport.ts`
- Create: `src/shared/contracts/acquisitionReportContract.ts`
- Create: `src/main/domain/workspace/legacyWorkflowTransition.ts`
- Create: `tests/main/acquisitionReport.test.ts`
- Create: `tests/integration/meetingFirstUpgrade.test.ts`
- Modify: `src/main/domain/lifecycle/lifecycleTransactionWriter.ts`
- Modify: `src/main/domain/founderSalesDomain.ts` only delegates/projections
- Modify: `src/main/outreach/emailPlaybook.ts`
- Modify: `README.md`

**Interfaces:** `countMilestones(events,window):AcquisitionReport`, `projectAccountPipeline(accounts,events)`, `transitionWorkflow({commandId,expectedMode,manifestId})`. `canScheduleLegacy({mode,kind}):boolean` gates new enrollment and continuation/reactivation. Transition manifest records preserved promises, parked unresolved legacy identities, canceled superseded automatic tasks and the responsible mode/catalog revision.

- [ ] **RED:** legacy interview-booked, queued sends, connection acceptance and generated pilot suggestions do not count as new real meetings/pilots. Transition preserves callbacks/history/unknown sends and cannot revive old automatic acquisition on restart.

```ts
expect(countMilestones([{id:'legacy-1',accountId:'a',kind:'legacy_interview_booked'}], window))
  .toMatchObject({meetingsBooked:0,meetingsHeld:0,pilotStarts:0});
expect(canScheduleLegacy({mode:'meeting_first',kind:'automatic_acquisition'})).toBe(false);
expect(canScheduleLegacy({mode:'meeting_first',kind:'recorded_promise'})).toBe(true);
```

- [ ] **Run RED:**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/acquisitionReport.test.ts tests/integration/meetingFirstUpgrade.test.ts
```

- [ ] **Implement:** count deduplicated actual account/event facts over equal observation windows: manual calls/conversations, positive responses, calendar booked/held, pilot willingness/actual starts, time/edit burden and cost/model usage. Unknown costs stay unknown. Cancellations/reschedules preserve meeting identity; no double count. Retain historical pipeline/fulfillment data separately. Evidence is required for a pilot start or held meeting, not a model guess.

```ts
const realBookings = events.filter(e => e.kind === 'calendar_booking_confirmed');
const uniqueMeetingIds = new Set(realBookings.map(e => e.meetingId));
```

`AcquisitionReport` uses those identities plus separate held/start evidence. Update default copy to Callie's actual maintenance-agent positioning, keeping old draft text/history intact. Apply meeting-first mode through an explicit idempotent transition, preserving genuine promises and stopping superseded automatic acquisition. Hide/demote old discovery homework, parcel defaults and contractor scoreboards only after dependency/route review; no deletion-first cleanup. Update README's obsolete UI/schema behavior as demonstrated, not by relabeling old functionality.

- [ ] **GREEN:** duplicate events, account merge candidates, rescheduling/cancel, unknown metrics, pilot evidence, transition replay, restore, old catalog hashes and no auto-enrollment of legacy owner rows. Do not change existing source adapters' live schedules as a side effect of local migration.
- [ ] **Commit:** D4 files only, message `feat: report meeting outcomes and retire legacy acquisition defaults`.

### Task D5: End-to-end release and data-safe rollout

**Files:**
- Modify: `package.json` packaged workflow list
- Modify: `tests/integration/migrationBackup.test.ts`, `tests/integration/restoreDrill.test.ts`
- Create: `docs/acceptance/meeting-first-release.md`
- Existing new acceptance sources: `phoneHandoff.spec.ts`, `accountPreparation.spec.ts`, `delegatedMeetings.spec.ts`, `meetingFirstWorkspace.spec.ts`

**Interfaces:** Consumes all four subsystem deliverables and the approved layout. Produces an exact-source/package acceptance record, not an assertion derived from aggregate test counts.

- [ ] Run the coordination plan's fresh full source, all Lambda, secret and exact-package gates under the required Node PATH. Fixture tests must exercise real production services/HTTP adapters, actual SQLite migrations, actual React/preload and restart. New package tests join the existing critical workflows rather than replacing them.
- [ ] Execute permanent negative controls: disable company discovery → prepared-account assertion fails; omit reply intake → dispatch freshness blocks; duplicate dispatcher → single-owner test fails; fake legacy interview-booked → real meeting assertion remains false; LinkedIn copy → no sent count. Never weaken these to obtain green runs.
- [ ] After explicit bounded approval, complete A4/C6 real-device/provider/overnight checks in isolated test accounts/resources. Record actual effect counts and failure/recovery observations, excluding secrets/private content. A test-gated build without these is an implementation candidate, not unrestricted daily-use readiness.
- [ ] Before touching the real workspace, obtain fresh normal-quit/backup/restore authorization and verify protected copies including current connection recovery material. Migrate a copy first, inspect named historical rows and new invariants, then coordinate one installation owner. Do not overwrite installed/canonical apps during package tests or run old code blindly against a new schema.
- [ ] Verify real reopening, account/history/draft/suppression preservation, truthful worker authority and pending work. No paused campaigns or unknown sends may reactivate from restored state. Keep the old app and compatible backup for the documented recovery path; rollback restores compatible state rather than pretending a Git revert reverses migrations.
- [ ] Launch only the separately approved bounded campaign. Measure useful conversations, meetings booked/held, pilot starts, founder effort and cost over a defined observation window. No invented conversion target. Stop rollout on data loss, duplicate external action, consent/suppression failure, unsupported product claim or demonstrated budget breach.
- [ ] Commit acceptance/docs/fixture corrections only after fresh checks, message `test: validate meeting-first FSS release workflow`. Publication, deployment and campaign sending are separate from that commit.
