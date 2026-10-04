# Meeting notes and tasks (M6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Native execution in this chat is already selected; one independent whole-branch review after implementation, not reviews per task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce correctable meeting notes from transcripts or debriefs, and automatically create tasks for David's clear, dated promises.

**Architecture:** Add meeting-specific source revisions, analysis and tasks to the existing Postgres domain. Reuse Bedrock transport, reservations, jobs, authenticated API commands, Today and the firm meeting panel. M7 consumes the versioned outcomes read defined here; M6 sends no mail.

**Tech Stack:** Node 24, TypeScript, Postgres, Zod, Vitest, Electron/React/shadcn/Tailwind; existing Bedrock Haiku transport.

**Spec:** [Approved meeting outcomes and follow-through design](../specs/2026-10-03-meeting-outcomes-follow-through-design.md), approved by David after its plain-language summary.

## Global Constraints

- React, shadcn and Tailwind remain. Today shows actionable work; meeting detail lives on the firm page.
- Sending remains paused. This work does not enable meeting transcription, call-suggestion automatic application, cold email or automatic deal-stage changes.
- A clear promise by David creates a task with its stated deadline automatically. An uncertain owner, promise or deadline goes to review. A task does not itself send an email or fulfill the promise.
- Typed or dictated debriefs are labelled **Your notes**, not transcript evidence.
- Process long meetings in blocks of at most 32 KiB of source text at utterance boundaries, up to 16 blocks per analysis.
- Bound each block's output to 4,096 tokens and the merge to 8,192 tokens; reserve against the full serialized request, including instructions and evidence metadata.
- Each extraction block or merge request has at most two paid attempts and six reservation rows. A full source snapshot has at most 34 paid attempts, all subject to the credit allowance.
- The approved $0.50/day allowance is specifically for meeting transcription. M6 has an independent, initially disabled credit-only analysis setting with a zero runtime allowance.
- Development checks remain within the already approved $50 of credit-covered API use per slice. No cash fallback.

## Review Focus

1. A transcript arrives after an edited debrief: preserve the human correction, surface disagreement, and prevent duplicate promises (Tasks 2, 4).
2. A repeated participant name, mixed track or echoed speech must not assign the prospect's promise to David (Tasks 2, 4).
3. A deadline near midnight or a DST transition retains the correct date and precision (Task 4).
4. A meeting fold/deletion races with model completion: settle spend without reviving content or resetting paid limits (Tasks 3, 5).
5. An older desktop must never send a meeting-task ID to the call-task completion command (Tasks 1, 6).

## Starting point and shared interfaces

Use the existing clean worktree on `codex/meeting-follow-through`, based on main `6fc1a0a7`, with the design commit preserved. Check branch/status and current main before implementation. The next migration at this baseline is `0043_meeting_outcomes.sql`; if another schema release lands first, change this plan's migration number and `REQUIRED_SCHEMA` together before creating it. Do not edit released migrations.

No dependency installation or baseline suite was run for this documentation-only planning turn. Before product edits use Node 24 (`/opt/homebrew/opt/node@24/bin`), existing dependencies and `npm run gate:greenfield`; investigate a real baseline failure before attributing it to this work. Do not launch native apps to test.

Task 1 defines these exported Zod-backed types in `packages/contracts/src/meetingOutcomes.ts`:

| Type | Fields/meaning |
|---|---|
| `MeetingEvidence` | Discriminated transcript reference `{recordingId, transcriptId, transcriptVersion, utteranceId, quote, startMs, endMs}` or debrief reference `{revision, quote, startOffset, endOffset}`; offsets are Unicode code points. |
| `MeetingDeadline` | `{precision:'date', localDate, zone}` or `{precision:'instant', at, zone}`; no unknown/guessed date accepted here. |
| `MeetingNoteItem` | Stable `id`, kind `need/workflow/objection/material/commitment/next_step`, text, stated/inferred provenance, evidence array, resolved owner `you/prospect/unknown`, nullable deadline, and review reasons. |
| `MeetingNotesRevision` | `meetingId`, `revision`, debrief text, confirmed speaker mappings, item overrides and any explicit notes-sufficiency confirmation. |
| `MeetingOutcomesView` | `meetingId`, `firmId`, notes revision, nullable analysis ID, source hash, current/stale/partial state, attendance state, validated items, overview, tasks and holds. No email body. |
| `MeetingTaskView` | ID, meeting/firm IDs, source `{kind:'promise', commitmentId}` or `{kind:'follow_through', planId}`, label, owner, deadline, open/done/cancelled state, version and user-edited flag. M6 creates only promise tasks; both kinds use the same edit/completion command. |
| `SaveMeetingNotes` | `meetingId`, `expectedRevision`, debrief text, speaker mappings, item overrides and sufficiency choice. |
| `ChangeMeetingTask` | `taskId`, `expectedVersion`, action complete/cancel/edit; edit carries label and deadline. |

All public commands also use the existing `commandId` and `clientVersion` envelope. Reuse `RepositoryContext`, `JobHandler` and `JobSpecification`. Define `MeetingResult<T>` in `meetings/outcomeTypes.ts` as `{ok:true,value:T} | {ok:false,reason:string}`; each command's public schema enumerates the actual refusal codes it uses. Define `MeetingAnalysisSetting` in `contracts/src/settings.ts` with the enabled flag, daily ceiling and nullable coverage record specified in Task 1. Do not pass raw model JSON as a validated contract.

## Task 1: durable notes and authorized revision reads

**Files:** Create `packages/contracts/src/meetingOutcomes.ts`, `packages/domain/meetings/{outcomeTypes,notes,outcomes}.ts`, `packages/domain/db/migrations/0043_meeting_outcomes.sql`, `packages/domain/test/meetings/support/meetingOutcomesFixture.ts`, `packages/domain/test/meetings/meetingNotes.test.ts`, `packages/contracts/test/meetingOutcomes.test.ts`, `packages/domain/test/db/support/meetingOutcomesCases.ts`. Modify `packages/contracts/src/{index,settings}.ts`, `packages/domain/db/schemaRange.ts`, `packages/domain/test/db/migrations.test.ts`.

**Consumes:** M5's `meetingTranscriptionFixture` and current meeting/firm authorization.

**Produces:** `saveMeetingNotes(context, input:SaveMeetingNotes):Promise<MeetingResult<MeetingNotesRevision>>`; `readMeetingOutcomes(context, {meetingId}):Promise<MeetingOutcomesView|null>`; `readMeetingAnalysisSetting(context):Promise<MeetingAnalysisSetting>` with disabled/zero defaults and service-specific Bedrock coverage.

- [x] Write tests first. Extend the existing fixture with helpers to save notes, insert transcript speech and read task rows. Pin optimistic concurrency and isolation:
  ```ts
  expect((await saveMeetingNotes(user, { ...input, expectedRevision: 0 })).ok).toBe(true);
  expect(await saveMeetingNotes(user, { ...input, expectedRevision: 0 })).toMatchObject({ ok: false, reason: 'notes_changed' });
  expect(await readMeetingOutcomes(otherWorkspace, { meetingId })).toBeNull();
  expect(await readMeetingAnalysisSetting(user)).toMatchObject({ enabled: false, dailyCeilingCents: 0 });
  ```
- [x] Run `npm test --workspace packages/domain -- test/meetings/meetingNotes.test.ts test/db/migrations.test.ts` and `npm test --workspace packages/contracts -- test/meetingOutcomes.test.ts`; confirm new assertions fail for the missing behavior.
- [x] Add immutable `meeting_note_revisions`, `meeting_analyses`, `meeting_analysis_requests` and `meeting_tasks`. Use workspace/firm/meeting composite references, explicit system creator vs human assignee, unique source/request and commitment identities, a single current notes revision, nullable evidence pointers for settled accounting only, and database checks for states/deadline precision. Store analysis/request versions separately from input text. Source text is never a job payload or log field. Add the `meeting_analysis` reservation subject and priced-token shape. Add `meeting_analysis` settings with `enabled:false`, `dailyCeilingCents:0`, nullable `{accountId,service:'bedrock',evidenceRef,verifiedAt,validUntil,status}`; allowance bounds 0–500 cents, independent of transcription.
- [x] Implement authorized read/CAS save. A save neither confirms attendance nor invokes a model. Invalidate old current analysis atomically; retain historical revisions. Limit debrief text to 32 KiB UTF-8, speaker mappings to 200 and user overrides to 100; refuse oversized input without truncating it. Add negotiated task/read vocabulary but keep new fields absent from legacy responses. M6 persistence permits only promise tasks; reserve the follow-through source in the public view without adding a foreign key to M7's future table. Rendering and completion use task ID, label and deadline independently of source kind.
- [x] Rerun the focused tests and package typechecks, including wrong-firm references and unchanged schema-42 seed data across the migration. Commit `feat: persist versioned meeting notes`.

## Task 2: evidence-preserving model input and validation

**Files:** Create `packages/domain/meetings/{analysisInput,analysisModel,analysisAdapter}.ts`, `packages/domain/test/meetings/{meetingAnalysisInput,meetingAnalysisModel}.test.ts`, and synthetic fixtures under `packages/domain/test/meetings/fixtures/outcomes/`.

**Consumes:** Task 1 contracts; `readMeetingTranscript`; existing Bedrock Messages transport interface.

**Produces:** `assembleMeetingAnalysisInput(context,{meetingId}):Promise<MeetingResult<MeetingAnalysisInput>>`; `buildMeetingAnalysisBlocks(input):MeetingResult<readonly MeetingAnalysisBlock[]>`; `validateMeetingAnalysisAnswer(text,input):MeetingResult<ValidatedMeetingAnalysis>`; `meetingAnalysisPort({transport}):MeetingAnalysisPort`. Define `MeetingAnalysisInput` (source hash, revision vector, date/zones, ordered per-source evidence, human overrides and completeness), `MeetingAnalysisBlock` (stable hash, purpose and source evidence), `ValidatedMeetingAnalysis` (overview/items/review reasons) and `MeetingAnalysisPort.run({model,purpose,maxOutputTokens,input})` returning accepted/refusal/malformed/schema_invalid/provider_refused/provider_error, validated content and nullable token usage.

- [x] Write tests for 201+ utterances, revision changes midway through pagination, 2-hour fixtures, source-track order changes, hallucinated references, quoted prompt injection and absent/unknown speakers:
  ```ts
  expect(input.utterances).toHaveLength(401);
  expect(blocks.every(b => b.sourceBytes <= 32768)).toBe(true);
  expect(validateMeetingAnalysisAnswer(inventedQuote, input)).toMatchObject({ ok: false });
  expect(result.items[0]).toMatchObject({ owner: 'unknown' });
  ```
- [x] Run `npm test --workspace packages/domain -- test/meetings/meetingAnalysisInput.test.ts test/meetings/meetingAnalysisModel.test.ts`; observe the relevant failure.
- [x] Assemble all pages against one source revision; restart assembly on a changed revision before paying. Split only at utterance boundaries, max 16 blocks, keeping per-source timing. Hash transcript blocks separately from debrief blocks and include their actual speaker mapping in each key. Validate exact evidence quotes, finite timestamps and source ownership. Bound a complete serialized provider request to 1 MiB and 180,000 counted input tokens; if unavailable, use the conservative UTF-8 byte token bound. Oversize input/result holds, never truncates. Retain source conflicts and human overrides; never infer global turn order.
- [x] Use the existing mapped `claude-haiku-4-5` model and JSON-schema validation. Apply 4,096/8,192 output-token limits; merge only validated blocks. One-block input may use its validated result without an extra merge call. A schema-valid promise still needs Task 4's owner/deadline/action checks.
- [x] Rerun these tests and domain typecheck. Commit `feat: validate evidence-backed meeting analysis`.

## Task 3: bounded, credit-only analysis jobs

**Files:** Create `packages/domain/meetings/{analysisPaid,analysisJobs}.ts`, `apps/worker/src/handlers/meetingAnalyze.ts`, `packages/domain/test/meetings/{meetingAnalysisBudget,meetingAnalysisJobs}.test.ts`, `apps/worker/test/meetingAnalyze.test.ts`. Modify `packages/domain/jobs/jobKinds.ts`, `apps/worker/src/bootstrap/{main,config}.ts`, `packages/domain/meetings/notes.ts` and the successful-completion path in `meetings/transcription.ts`.

**Consumes:** Task 2 port/blocks; existing reservations and settings locks.

**Produces:** `scheduleMeetingAnalyses(session,at):Promise<readonly JobSpecification[]>`; `meetingAnalyzeJobHandler(options):JobHandler`; `meetingAnalysesSource(enabled):DueWorkSource`; `beginMeetingAnalysisRequest(context,{requestId,at},deps)` and `completeMeetingAnalysisRequest(context,{requestId,attemptId,result,at})`, returning done/held/reserved and accepted/stale/retry/failed respectively. `deps` supplies account, Bedrock route, port, clock and abort signal; it cannot supply a direct cash transport.

- [x] Add tests proving zero provider calls while disabled, zero allowance, expired/wrong-service/wrong-account coverage, unsupported model or direct route; two paid attempts/six reservations maximum; unchanged cached blocks reused after a debrief edit; expiry/restart/poison job bounded:
  ```ts
  expect(fakeProvider.calls).toHaveLength(0);
  expect(request.paidAttempts).toBeLessThanOrEqual(2);
  expect(request.reservations).toHaveLength(6);
  expect(transcriptBlockRequestIdsAfterEdit).toEqual(transcriptBlockRequestIdsBeforeEdit);
  ```
- [x] Run `npm test --workspace packages/domain -- test/meetings/meetingAnalysisBudget.test.ts test/meetings/meetingAnalysisJobs.test.ts` and `npm test --workspace apps/worker -- test/meetingAnalyze.test.ts`; observe new failures.
- [x] Implement chunked reserve → final eligibility check/mark calling → request/settlement. Preserve token estimates for unknown outcomes, no cash fallback, and no model/prompt-only mass rerun. Reserve full input/output bounds with the existing provider price table. Worker leases are 120 seconds, provider requests time out at 60 seconds, and each scheduler job permits 3 infrastructure attempts. A persisted request deadline of 120 minutes is enforced by the scheduler independently of a crashing handler; disabled/budget-held requests wait for a setting change or next budget day without busy-loop paid retries. New data materializes analysis work; it does not pay while disabled.
- [x] Keep paid accounting transactions separate from task publication: setting read lock → analysis budget → firm → meeting → request/reservation. Re-read current ownership after locks. Completion persists results and queues a separate task-reconciliation job; it must not acquire Today's lock while holding a firm. No model HTTP request holds Today or the send gate.
- [x] Rerun the focused tests including a simultaneous setting-off and final request boundary, then typecheck. Commit `feat: run bounded meeting analysis through Bedrock`.

## Task 4: clear promises become correctable tasks

**Files:** Create `packages/domain/meetings/{outcomeCorrections,tasks,taskDeadlines}.ts`, `packages/domain/test/meetings/{meetingOutcomeCorrections,meetingTasks,meetingTaskDeadlines}.test.ts`. Modify `packages/domain/meetings/{notes,outcomes,analysisJobs}.ts`.

**Consumes:** Validated current outcome/evidence and notes revisions, current firm ownership and existing local-clock helpers.

**Produces:** `reconcileMeetingTasks(context,{meetingId,analysisId,expectedSourceHash}):Promise<MeetingResult<{created:number,changed:number,review:number}>>`; `changeMeetingTask(context,input:ChangeMeetingTask):Promise<MeetingResult<MeetingTaskView>>`; `resolveMeetingDeadline({text,anchorAt,zone,sourceKind}):MeetingResult<MeetingDeadline>`; `saveMeetingOutcomeCorrections(context,input:SaveMeetingNotes)` delegates the CAS notes contract while reconciling affected tasks.

- [x] Add source-backed tests for clear promises, negation/hypotheticals, prospect-owned promises, missing zones, repeated names, dates near midnight/DST and debrief/transcript duplicates:
  ```ts
  expect(tasksFor('I will send the guide tomorrow', confirmedDavid)).toHaveLength(1);
  expect(tasksFor('I might send the guide', confirmedDavid)).toHaveLength(0);
  expect(tasksFor('I will send the guide tomorrow', prospect)).toHaveLength(0);
  expect(dateOnly).toEqual({ precision: 'date', localDate: '2026-11-01', zone: 'America/New_York' });
  expect(replayedTask.id).toBe(originalTask.id);
  expect(replayedTask.status).toBe('done');
  ```
  `tasksFor` is a test-fixture wrapper around real reconciliation, not a string-matching production implementation.
- [x] Run `npm test --workspace packages/domain -- test/meetings/meetingTasks.test.ts test/meetings/meetingTaskDeadlines.test.ts test/meetings/meetingOutcomeCorrections.test.ts`; confirm the new behavior is absent.
- [x] Require confirmed owner, positive explicit commitment, resolvable deadline and current/sufficient notes. Enforce exact-date resolution in code, not by trusting a model-produced timestamp. Use a stable commitment identity attached to evidence; possible cross-source duplicates go to review. Date-only task storage retains local date/zone and computes overdue after local day-end; Today sorting uses a derived instant but UI does not show a fabricated time.
- [x] Reconciliation takes send gate shared → Today shared → firm → meeting → current analysis/tasks. Human edits/corrections take send gate exclusive → Today shared → firm → meeting → notes/tasks. Completed/user-edited tasks survive automatic reruns; cancel only untouched tasks explicitly invalidated by source correction and audit the cause. Uncertain corrections create review work; do not automatically retract a sent message or change a deal.
- [x] Rerun tests, including concurrent corrections/completion and task-owner reassignment. Commit `feat: create meeting tasks from clear promises`.

## Task 5: lifecycle, retention and merge correctness

**Files:** Modify `packages/domain/meetings/calcom.ts`, `packages/domain/crm/merges.ts`, `packages/domain/retention/{coverage,deletion}.ts`, `packages/domain/restore/{holds,index}.ts` and new outcome modules. Create `packages/domain/test/meetings/meetingOutcomeLifecycle.test.ts`; extend existing retention/restore tests.

**Consumes/produces:** Preserve Task 1–4 interfaces; expose `foldMeetingOutcomes(context,{sourceMeetingId,targetMeetingId})` and `deleteMeetingOutcomeContent(context,{meetingIds})` in `meetings/outcomeCorrections.ts`, used only inside the existing owning transaction. They never acquire Today after a firm lock; outer callers needing immediate task refresh take Today before firm locks, otherwise enqueue a refresh after commit.

- [x] Write real two-session tests for fold during model request, fold during task reconciliation, deletion before late completion and restore of pending work:
  ```ts
  expect(taskIdsAfterFold).toEqual(taskIdsBeforeFold);
  expect(providerAttemptsAfterFold).toBe(providerAttemptsBeforeFold);
  expect(contentAfterDeletedSubjectCompletion).toHaveLength(0);
  expect(restoredWork.canDispatchWithoutCurrentChecks).toBe(false);
  ```
- [x] Run `npm test --workspace packages/domain -- test/meetings/meetingOutcomeLifecycle.test.ts test/retention test/restore`; observe the new failing scenario, not just an invalid fixture.
- [x] Preserve original request/task/evidence identities through folds and union inherited attempt accounting. Never reset paid limits on canonicalization. Cascade subject content under retention rules; retained sanitized accounting has no speech/labels. Late results settle without publishing deleted/stale content. Restore revalidates sources, funding and settings before work resumes.
- [x] Audit existing outer lock order against the new helpers; test fold vs correction vs Today build and settings-off vs final provider dispatch with concurrent database sessions. Make narrowly scoped caller adjustments rather than introducing a global lock.
- [x] Rerun lifecycle tests and domain typecheck. Commit `fix: preserve meeting outcome identity across lifecycle changes`.

## Task 6: API, meeting panel, Today and acceptance

**Files:** Create `apps/api/src/routes/meetingOutcomes.ts`, `apps/desktop/src/renderer/meetings/{MeetingOutcomes,MeetingDebrief}.tsx`, `apps/desktop/src/renderer/meetings/outcomesMemory.ts`, `apps/desktop/src/renderer/settings/MeetingAnalysisSection.tsx`. Modify API `routes/{modules,settings,today}.ts`; desktop `shared/operations.ts`, `main/operationHost.ts`, `renderer/meetings/FirmMeetings.tsx`, `renderer/settings/CallingCalendarSection.tsx`, `renderer/today/TaskRow.tsx`; domain `crm/firmActivity.ts`, `meetings/brief.ts`, `today/{build,dto,types}.ts`; contracts `today.ts`, `crmSurface.ts`. Create `apps/api/test/meetingOutcomes.test.ts`, `apps/desktop/test/meetingOutcomes.component.test.tsx`, `apps/desktop/test/e2e/meetingOutcomesScreens.spec.ts`.

**Consumes:** Task 1 read/save, Task 4 correction/task commands. **Produces:** `meetings.outcomes` read; `meetings.saveNotes`, `meetings.changeTask` commands through the existing operation registry; explicit `include=meeting_tasks` capability. Old `include=tasks` and `/today/tasks/complete` retain call-task semantics. Settings reads negotiate `include=meeting_analysis`.

- [x] Write endpoint/desktop tests for authorization on repeated command receipts, version conflicts, cross-firm navigation, retained unsaved debriefs, collapsing controls, real task completion and legacy clients:
  ```ts
  expect(oldToday.items.some(x => x.sourceKind === 'meeting_task')).toBe(false);
  expect(callsToCallTaskCompletion).toHaveLength(0);
  expect(debriefAfterLeaveAndReturn).toBe(unsavedText);
  expect(settings.meetingAnalysis.setting).toMatchObject({ enabled: false, dailyCeilingCents: 0 });
  ```
- [x] Run the new API and component suites with `npm test --workspace apps/api -- test/meetingOutcomes.test.ts` and `npm test --workspace apps/desktop -- test/meetingOutcomes.component.test.tsx`; observe the failure.
- [x] Implement authenticated read/CAS command routes and the thin bridge, with exact current command-replay authorization checks. Add Notes/Tasks to the existing meeting panel, inline evidence and one speaker-mapping editor. Show partial/stale/disabled explanations only where useful. Debrief drafts are workspace/user/meeting keyed and cleared on sign-out. Normal editable text supports macOS Dictation; no new audio service. Add due task and uncertainty sources to Today without a dashboard row. The new settings card exposes credit coverage, independent allowance and off state; never enables itself during migration or release.
- [x] Run focused tests, then `npm run test:desktop:e2e -- meetingOutcomesScreens.spec.ts`; inspect normal/partial/empty/error states at desktop and narrow widths. Use the existing headless harness. Native Dictation and actual Zoom input remain separately reported acceptance checks, not inferred from screenshots.
- [ ] Run the full `npm run gate:greenfield`, secret scan and schema upgrade/rehearsal required by `docs/greenfield/release.md`. Run a small labelled Bedrock evaluation only after checking applicable development credit coverage; assert precision for commitments and owner/date extraction, not only JSON shape. Preserve all results, including omissions. One independent whole-branch review; fix reproducible findings and rerun affected tests plus the final gate. Commit `feat: surface meeting notes and tasks in the desktop`.
- [ ] Open the normal PR, attach it to this chat, and follow the existing protected release process with model processing off, zero analysis allowance, sending paused and automatic call suggestions off. Report native/real-recording acceptance separately. Do not redesign the release machinery.

## Handoff

M6 is ready for release when notes, corrections, tasks and lifecycle tests pass, older clients are protected, review findings are resolved, and shipped settings remain off. A real Zoom recording is needed to accept the full audio path, not to implement or test synthetic/manual notes. M7 starts from the resulting approved M6 interfaces and its separate plan; no M7 sender change belongs in this branch before the M6 release boundary.
