# Meeting recap and follow-through (M7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Native execution in this chat is already selected; one independent whole-branch review after implementation, not reviews per task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare routine meeting recaps with a 30-minute editing window and send bounded, relevant follow-ups through Callie's existing delivery system when enabled.

**Architecture:** A small meeting follow-through record binds current M6 notes, recipient, scope, approved templates and immutable draft revisions to existing permissions, enrollments, steps and send fences. Extend current eligibility and delivery checks rather than creating another sender. Use actual send results to advance follow-through and fulfill tasks.

**Tech Stack:** Existing Node 24/TypeScript/Postgres domain, Zod contracts, durable worker jobs, Gmail delivery path and React/shadcn/Tailwind desktop.

**Spec:** [Approved meeting outcomes and follow-through design](../specs/2026-10-03-meeting-outcomes-follow-through-design.md).

**Dependency:** [M6 plan](2026-10-03-meeting-outcomes.md). Start implementation only after M6 is shipped; reconcile any M6 interface changes before editing M7 code. The next migration after the baseline M6 schema 43 is `0044_meeting_follow_through.sql`; rebase that number to current main if another release intervenes.

## Global Constraints

- Routine recaps are prepared when usable notes are ready, then wait 30 minutes for editing or cancellation.
- The sender remains `david@usecallie.com`. One active outreach contact per firm; no automatic emailing of all meeting attendees.
- Sending remains paused. This work does not enable meeting transcription, call-suggestion automatic application, cold email or automatic deal-stage changes.
- A booking label or invented `agreed_sequence` permission is insufficient.
- The routine completed-demo plan permits only the recap and up to two related nudges to the one resolved prospect contact.
- An explicit agreed follow-up date replaces the default nudge schedule. A single promised reminder stays a single reminder.
- A never-submitted, overdue draft gets a fresh 30-minute window after resuming; it must still be relevant.
- A recap more than two business days past the meeting needs review.
- All messages use the existing sequence executions, send windows, daily caps, domain and workspace controls, mailbox state, suppression checks, provider fence and reconciliation.
- Replies or edits that commit before the final dispatch boundary win; already accepted provider messages cannot be recalled.
- No new LLM authoring agent, subscription, sending transport or paid API is introduced by this release.

## Review Focus

1. An edit, stop, reply or reassignment commits after fence preparation but before claim: the old message must not send (Tasks 2, 3).
2. Pause/resume or a crashed editor must not cause an immediate stale recap or a lost draft (Tasks 1, 3, 5).
3. Booking aliases, a second attendee and merged firms must never change the intended recipient or multiply active plans (Tasks 2, 4).
4. An unknown provider result or manual Gmail recap must not generate duplicate mail or falsely complete a task (Tasks 3, 4).
5. DST/weekend/calendar changes and a late first nudge must not collapse two follow-ups into the same send window (Task 4).

## Interfaces and delivery boundary

Reuse M6 `readMeetingOutcomes` and its `MeetingOutcomesView`, `MeetingEvidence`, `MeetingDeadline`, `MeetingResult` and task APIs. Task 1 creates `packages/contracts/src/meetingFollowThrough.ts` with:

- `MeetingFollowThroughView`: meeting/firm/contact IDs, plan ID/version, source hash and notes revision, status `draft/held/scheduled/awaiting_reply/completed/cancelled/needs_review`, nullable current draft, planned steps, blocker reasons and sent-message references.
- `MeetingRecapDraft`: ID/version, immutable subject/body/rendered hash, template version, source hash, allowed material/offer versions, created time, `notBefore`, held/editing/cancelled/superseded/sent state.
- `MeetingFollowThroughScope`: recipient/contact, basis meeting/booking IDs, purposes, max messages 1–3, expiry and nullable explicit agreed reminder deadline with evidence.
- `MeetingDraftEdit`: plan ID, expected plan/draft versions, action `begin_edit/save/discard/cancel`, nullable subject/body for save; existing command-ID/client-version envelope applies.

Keep delivery through `runDueStepExecution` → `prepareOutboundMessage` → `dispatchOutboundMessage` and the existing final `decideStepPermission`. No new direct Gmail call is permitted. New source/content metadata lives on the meeting plan and references existing enrollment/execution/fence IDs; those systems remain authoritative for delivery and counters.

## Task 1: versioned recap preparation and editing

**Files:** Create `packages/contracts/src/meetingFollowThrough.ts`, `packages/domain/meetings/{followThroughTypes,recapDrafts,followThrough}.ts`, `packages/domain/db/migrations/0044_meeting_follow_through.sql`, `packages/domain/test/meetings/{meetingRecapDrafts,meetingFollowThroughRead}.test.ts`, `packages/domain/test/db/support/meetingFollowThroughCases.ts`. Modify `packages/contracts/src/{index,sequences}.ts`, `packages/domain/db/schemaRange.ts`, `packages/domain/test/db/migrations.test.ts`.

**Consumes:** M6 outcomes read, approved templates and existing rendered-content hashing.

**Produces:** `prepareMeetingRecap(context,{meetingId,expectedSourceHash,at}):Promise<MeetingResult<MeetingFollowThroughView>>`; `editMeetingRecap(context,input:MeetingDraftEdit):Promise<MeetingResult<MeetingFollowThroughView>>`; `readMeetingFollowThrough(context,{meetingId}):Promise<MeetingFollowThroughView|null>`.

- [x] Add tests for sourced routine content, unavailable material, unapproved promises, conflicting facts, source changes and edit-window versioning:
  ```ts
  expect(Date.parse(draft.notBefore) - Date.parse(draft.createdAt)).toBe(30 * 60_000);
  expect(savedDraft.version).toBe(originalDraft.version + 1);
  expect(await prepareWithMissingMaterial()).toMatchObject({ ok: true, value: { status: 'needs_review' } });
  expect(cancelledPlan.contactSuppressed).toBe(false);
  ```
- [x] Run `npm test --workspace packages/domain -- test/meetings/meetingRecapDrafts.test.ts test/meetings/meetingFollowThroughRead.test.ts test/db/migrations.test.ts`; confirm new failures.
- [x] Add `meeting_follow_through` and append-only `meeting_follow_through_drafts`, with references to M6 sources and existing sequence/delivery IDs. Extend `meeting_tasks` with a workspace/meeting-scoped `follow_through_plan_id` foreign key, exactly-one-source checks (promise commitment or follow-through plan) and one task per plan; preserve all M6 task IDs and promise identities. Drafts hold exact bytes/hash and template/material versions; plan changes use optimistic versions. Use existing approved plain-text templates with a new explicitly allowlisted meeting-recap variable. No model output may invent a product or offer fact. At this baseline there is no proven normalized asset/offer catalog: require each automated material URL and claim to come from the referenced approved template version; missing content is review work, not a new asset-management subsystem.
- [x] `begin_edit` sets a durable hold before the UI offers editable content. A crashed editor stays held with Resume editing/Discard, never expires into an automatic send. Save changed bytes creates a new revision and 30-minute window; discard restores the current unedited draft with a fresh window when overdue. Automatic source/content changes supersede the prior draft and restart the window. Cancel cancels the recap and any dependent default nudge schedule; it never sets a communication stop.
- [x] Rerun tests/typecheck and commit `feat: prepare versioned meeting recap drafts`.

## Task 2: real meeting-backed permission and plan enrollment

**Files:** Create `packages/domain/meetings/followThroughEligibility.ts`, `packages/domain/test/meetings/meetingFollowThroughEligibility.test.ts`. Modify `packages/domain/sequences/{followUpPermissions,eligibility,enrollments,variables}.ts`, `packages/domain/outbound/stepPermission.ts`, `packages/contracts/src/followUps.ts` and vocabulary/schema tests.

**Consumes:** Task 1 plan/scope and M6 current notes. **Produces:** `resolveMeetingFollowThroughScope(context,{meetingId,contactId,sourceHash}):Promise<MeetingResult<MeetingFollowThroughScope>>`; `verifyMeetingFollowThrough(context,{planId,executionId,draftVersion,at}):Promise<MeetingResult<{planId:string,planVersion:number}>>`; `enrollMeetingFollowThrough(context,{planId,expectedVersion,at}):Promise<MeetingResult<{enrollmentId:string}>>`.

- [x] Add tests for missing/unknown attendance, alias-only booking reference, cancelled meeting, unmatched/other-firm recipient, narrower request, three-message maximum and one active contact:
  ```ts
  expect(await eligibilityForUnconfirmedAttendance()).toMatchObject({ ok: false });
  expect(await eligibilityForSecondAttendee()).toMatchObject({ ok: false });
  expect(await eligibilityForOldAliasOfSameMeeting()).toMatchObject({ ok: true });
  expect(await eligibilityForFourthMessage()).toMatchObject({ ok: false });
  ```
- [x] Run `npm test --workspace packages/domain -- test/meetings/meetingFollowThroughEligibility.test.ts test/sequences/followUpEligibility.test.ts test/outbound/permissionSpend.test.ts`; confirm new failures.
- [x] Replace only the reserved `booking_communications` cases with actual persisted-meeting validation, including booking aliases, current firm/contact, confirmed attendance, complete/sufficient current notes, source scope and expiry. Bind exact plan/sequence version and max messages. The existing 30-day booking scope is not silently extended; a reminder beyond it remains drafted/reviewable until supported by a separately recorded valid scope. A rejection or narrower request wins over defaults.
- [x] Enroll under existing firm exclusivity and supersession rules, retaining historical rows. Do not forge a call, create an agreed-sequence permission or enroll every attendee. New automated work cannot commandeer a human takeover. Test the same permission at prepare time and final dispatch, including source correction and contact reassignment between them.
- [x] Rerun tests/typecheck and commit `feat: verify meeting-backed follow-through eligibility`.

## Task 3: connect drafts to the existing send fence

**Files:** Modify `packages/domain/sequences/{executions,sendHandoff,variables}.ts`, `packages/domain/outbound/{fence,stepPermission,send,reconcile}.ts`. Create `packages/domain/meetings/followThroughDelivery.ts`, `packages/domain/test/meetings/meetingRecapDispatch.test.ts`; extend existing outbound race tests.

**Consumes:** Task 2 live permission and Task 1 immutable draft. **Produces:** `meetingDraftForExecution(context,{executionId,at}):Promise<MeetingResult<{draftId:string,draftVersion:number,subject:string,body:string,renderedHash:string,notBefore:string}>>`; `verifyMeetingFence(context,{fenceId,at}):Promise<MeetingResult<{planId:string}>>`; `recordMeetingDelivery(context,{executionId,messageId,sentAt}):Promise<void>`.

- [x] Write tests using the real dispatcher with a fake external adapter: pause, edit/save/cancel, notes revision, suppression, reply and reassignment between prepare and claim; unknown send outcome:
  ```ts
  expect(adapter.sends).toHaveLength(0); // every committed pre-claim hold wins
  expect(sentEnvelope.renderedHash).toBe(currentDraft.renderedHash);
  expect(adapter.sends).toHaveLength(1); // retry after ambiguous submission reconciles
  expect(taskAfterDraftOrQueue.status).toBe('open');
  ```
- [x] Run `npm test --workspace packages/domain -- test/meetings/meetingRecapDispatch.test.ts test/outbound/dispatchRace.test.ts test/outbound/dispatchRecheck.test.ts`; observe failures.
- [x] Attach plan/draft identity through the execution's existing source link. Freeze the current rendered bytes and approved template hash in the normal fence, then verify current plan/draft/source versions again before claim. Old prepared fences are held/superseded using existing fence operations; dispatching/reconciling fences are immutable. A newer draft cannot send until an older ambiguous submission resolves. Keep template approval, postal/footer presentation, mailbox health, route checks and ramping intact.
- [x] Draft mutations, notes invalidation and stop facts take the exclusive send gate before firm/meeting/plan rows; final send claims use its shared gate and existing row order. Never nest Today's lock inside dispatch. Successful/reconciled delivery schedules post-commit task fulfillment and plan progression. Mark a promised-material task done only on a successful message linked to that exact task/material, not on queued status or a recap that merely mentions the promise.
- [x] Rerun tests/typecheck and commit `feat: deliver meeting recaps through existing send controls`.

## Task 4: follow-up timing, interruptions and lifecycle

**Files:** Create `packages/domain/meetings/{followThroughSchedule,followThroughJobs,followThroughTasks}.ts`, `apps/worker/src/handlers/meetingFollowThrough.ts`, `packages/domain/test/meetings/{meetingFollowThroughSchedule,meetingFollowThroughLifecycle}.test.ts`. Modify domain `meetings/{attendance,calcom,tasks,outcomes}.ts`, `mail/effects.ts`, `outbound/sentFolder.ts`, sequence terminal-stop/resume paths, `crm/merges.ts`, retention/restore paths; worker bootstrap and job kind registry.

**Consumes:** Task 3 actual delivery outcomes, existing calendars/windows and M6 task views/completion. **Produces:** `nextMeetingFollowThroughAction({plan,deliveryHistory,at,calendar,zone}):FollowThroughAction`; `scheduleMeetingFollowThrough(session,at):Promise<readonly JobSpecification[]>`; `invalidateMeetingFollowThrough(context,{meetingId,reason,eventId}):Promise<void>`; `ensureUnresolvedMeetingTask(context,{meetingId,planId,ownerUserId,dueAt}):Promise<{taskId:string,created:boolean}>` in `followThroughTasks.ts`. Define `FollowThroughAction` as wait/until, nudge/index/dueAt, task/dueAt, review/reason or complete; the pure function submits nothing. The task helper accepts a `MeetingDeadline`, creates an audited system task with source `{kind:'follow_through',planId}`, and never manufactures a commitment.

- [x] Pin date arithmetic and interruptions in tests:
  ```ts
  expect(localNudgeDates).toEqual(['2026-10-12', '2026-10-19']); // Oct 5 recap; fixture calendar has no holidays
  expect(agreedPlan.reminders).toHaveLength(1);
  expect(restartedDraft.notBefore).toBe('2026-10-05T15:30:00.000Z'); // resume at 15:00Z
  expect(afterReply.pendingNudges).toHaveLength(0);
  expect(taskIdsAfterRepeatedFinalization).toHaveLength(1);
  expect(taskAfterRepeatedFinalization.status).toBe('done'); // previously completed through M6 command
  expect(taskAfterRepeatedFinalization.source).toEqual({ kind: 'follow_through', planId });
  ```
- [x] Run `npm test --workspace packages/domain -- test/meetings/meetingFollowThroughSchedule.test.ts test/meetings/meetingFollowThroughLifecycle.test.ts test/outbound/replyAfterEligibility.test.ts`; confirm new failures.
- [x] Anchor default nudges to actual recap delivery: +7 and +14 local calendar days, then existing allowed send windows/calendar. Never schedule from draft creation. An agreed single reminder overrides both default nudges. If a delayed first nudge and the second land in the same permissible send window, omit the second. If a proposed nudge is obsolete or outside permission expiry, hold/review rather than extending scope. After the last actual nudge, create one unresolved-conversation task +2 business days using the existing calendar.
- [x] Hold pending nudges on an incoming human reply before classification; existing automated-reply handling remains separate. A new booking cancels old nudges. Takeover/stops use existing semantics. Link fulfilled manual Gmail sends using current attribution/relevance checks; ambiguity holds rather than sending a potential duplicate. Read live pause/window/eligibility at every due event and final claim. Resume overdue never-submitted recaps with a fresh 30-minute window; after >2 business days from meeting, require review. Allow reviewed stale drafts only after new content/version and a new window, never by mutating historical sent state.
- [x] Preserve plan/draft/message/task identities across aliases and firm/meeting folds. Source deletion removes content and holds work; sanitized send/accounting history follows existing policy. Restore does not make historical held plans immediately sendable. Task finalization runs after delivery commits in its own send gate shared → Today shared → firm → meeting transaction, rechecking current plan, reply and stop state. `ensureUnresolvedMeetingTask` returns the existing task on replay without changing a completed or user-edited task. Extend M6 reads to map the new source; completion remains the M6 task command. Reuse existing scheduler materialization and step deadlines; no second polling loop for delivery.
- [x] Rerun focused suites and commit `feat: schedule bounded meeting follow-through`.

## Task 5: complete desktop workflow and release acceptance

**Files:** Create `apps/api/src/routes/meetingFollowThrough.ts`, `apps/desktop/src/renderer/meetings/MeetingFollowThrough.tsx`, `apps/api/test/meetingFollowThrough.test.ts`, `apps/desktop/test/meetingFollowThrough.component.test.tsx`, `apps/desktop/test/e2e/meetingFollowThroughScreens.spec.ts`. Modify API route modules, desktop shared operations/main host, `FirmMeetings.tsx`, M6 draft-memory helpers and the Today exception source; extend `docs/greenfield/meetings.md`.

**Consumes:** Tasks 1–4 read/edit commands and delivery state. **Produces:** `meetings.followThrough` read and `meetings.editRecap` command; meeting-panel draft/time/edit/cancel controls and actionable holds in Today.

- [x] Write user-flow tests for an empty/partial meeting, eligible recap, paused sending, an edit racing with due time, browser/desktop navigation loss and source conflicts:
  ```ts
  expect(screen.getByText('Sending paused')).toBeVisible();
  expect(screen.queryByText(/sending in/i)).toBeNull();
  expect(draftTextAfterNavigation).toBe(editedText);
  expect(outdatedEditorSave.status).toBe(409);
  expect(todayMetricsRowsAdded).toBe(0);
  ```
- [x] Run `npm test --workspace apps/api -- test/meetingFollowThrough.test.ts` and `npm test --workspace apps/desktop -- test/meetingFollowThrough.component.test.tsx`; verify the new behavior fails before implementation.
- [x] Wire the existing command receipt/version and current-authorization checks. Wait for `begin_edit` acknowledgement before enabling editing; show submitted/reconciling states honestly without pretending cancellation can recall sent mail. Keep drafts keyed to workspace/user/meeting and clear at sign-out. Explain holds in plain language; link to the evidence or task needing action. Do not add a status bar or metrics to Today.
- [x] Run focused suites and `npm run test:desktop:e2e -- meetingFollowThroughScreens.spec.ts`; inspect narrow/desktop screen states. Run full `npm run gate:greenfield`, secrets verification and the existing schema upgrade/rehearsal checks. Test the full desktop → scheduler → dispatcher path with fake delivery and paused production posture, including no provider calls under pause. One independent whole-branch review; resolve findings and verify final head.
- [ ] Commit `feat: complete meeting follow-through workflow`, open/attach the normal PR and release through existing protected mechanics with sending paused. A real delivery check to David's designated test address is a separate controlled acceptance action; this plan does not lift a global/domain sending switch. Report what was simulated, what was exercised end to end, and what remains disabled.

## Handoff

M7 is complete when current meeting evidence and recipient govern every send, editing/cancellation races are tested, actual delivery drives follow-ups and task fulfillment, all existing stop/pause rules hold, and the desktop clearly distinguishes ready, held and sent work. Keep cold email, social publishing, lead sourcing and automatic deal stages out of this release.
