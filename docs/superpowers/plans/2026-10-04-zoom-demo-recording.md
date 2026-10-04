# Demo-only Zoom local recording (M3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Preserve native execution in this chat, then one independent whole-branch review. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically enable and verify local recording on matched Callie demo meetings, with a clear manual fallback.

**Architecture:** The existing scheduler creates durable, revision-bound operations. A worker validates the current Cal.com booking and Zoom meeting before a narrow external write, then reconciles through readback. Existing settings, locks, authorization, Secrets Manager and the firm meeting UI own their usual responsibilities.

**Tech Stack:** Node 24, TypeScript, PostgreSQL, Zod, native fetch, Vitest and Electron/React/shadcn/Tailwind. No new package or service.

**Spec:** [Approved M3 design](../specs/2026-10-04-zoom-demo-recording-design.md).

**Status:** Proposed implementation plan; design approved, plan review pending. No application implementation is included in this commit.

## Global Constraints

- Business host is `david@usecallie.com`; configure the exact observed Cal.com demo event ID, never infer it from a title or slug.
- Zoom scopes remain `meeting:read:meeting:admin` and `meeting:update:meeting:admin`; demo-only eligibility is Callie's responsibility.
- Use only `{"settings":{"auto_recording":"local"}}` as the Zoom PATCH body. Require readback before reporting ready.
- Process scheduled, future, non-recurring, non-PMI demos matched to a firm. Cloud or unknown recording modes require manual action.
- The Zoom start may differ by at most 60 seconds; duration must match the booking's whole-minute duration.
- Future scan horizon: 60 days. Candidate limit: 20 per scheduler pass. Four attempts and two hours from first attempt, or meeting start, whichever comes first.
- Single-booking Cal.com version is `2026-02-25`; existing list version remains `2026-05-01`.
- Never repeat an ambiguous PATCH blindly. Persist write intent before the request and reconcile unknown outcomes by GET.
- Lock order: calendar routing → workspace gate → setting read lock → firm → meeting → operation. A settings write uses compatible routing/gate ordering before its existing setting lock.
- Publish disabled. Zoom activation, secure credential configuration and controlled acceptance follow the release. Sending, meeting processing budgets, call suggestions and deal stages are unchanged.
- Native desktop actions remain David's responsibility. No global recording toggle, Zoom webhook, meeting creation, cloud-recording download or M8 UI redesign.

## Review Focus

1. A worker dies after persisting write intent but before receiving the PATCH result: a replacement reads back and never manufactures a second write (Task 3).
2. A disable, cancellation, reassignment or fold lands between provider validation and dispatch: the final boundary rejects the stale target (Tasks 3–4).
3. A fixture-like Cal.com response has conflicting event IDs, a successor UID, multiple hosts or seated/recurring metadata: it cannot qualify through a convenient fallback (Tasks 1–2).
4. Existing ready/manual rows occupy the first 20 upcoming meetings: they must not starve new eligible demos, and a manual Zoom change must not be undone by a settings save or reschedule (Tasks 3–4).
5. An old desktop, stale worker heartbeat or late response after navigation makes setup look successful for the wrong meeting: contracts stay compatible and the UI binds every response to its meeting/session (Task 5).

## Starting point and file map

Reuse the clean `worktrees/crm-navigation` checkout on `codex/zoom-demo-recording`, based on main `d1d7e844`, with design commit `529f7925`. Confirm current main and cleanliness before implementation. Schema is 44; planned migration is `0045_meeting_recording_setup.sql` unless another release advances main. Use Node 24 (`PATH=/opt/homebrew/opt/node@24/bin:$PATH`) for the listed npm commands; the local Terraform executable is `/Users/davidcui824/.local/bin/terraform`.

| Responsibility | Files to create | Existing integration points |
|---|---|---|
| Public contracts and defaults | `packages/contracts/src/meetingAutoRecording.ts` | contracts `index.ts`, `settings.ts` |
| Pure target/provider validation | `packages/domain/meetings/autoRecordingTypes.ts`, `autoRecordingEligibility.ts` | booking URL parser and attendee canonicalizer |
| Durable operations and reads | `packages/domain/meetings/autoRecording.ts`, `autoRecordingLifecycle.ts`, `autoRecordingSettings.ts` | meeting folds, settings, retention, restore |
| Provider HTTP | `apps/worker/src/zoom/meetingsClient.ts`, `apps/worker/src/calcom/bookingClient.ts` | existing Cal.com secret parser; worker bootstrap |
| Scheduling and execution | `packages/domain/meetings/autoRecordingJobs.ts`, `apps/worker/src/handlers/meetingAutoRecording.ts` | job kinds, registry composition, scheduler, heartbeats |
| API and desktop | `apps/api/src/routes/meetingAutoRecording.ts`, `apps/desktop/src/renderer/meetings/MeetingAutoRecording.tsx`, `apps/desktop/src/renderer/settings/MeetingAutoRecordingSection.tsx` | routes/modules, shared operations, operation host, FirmMeetings, CallingCalendarSection |
| Runtime and acceptance | `docs/greenfield/runbooks/zoom-demo-recording.md` | secrets/cluster Terraform, rehearsal fixtures, meetings documentation |

## Task 1: contracts, settings and the eligibility boundary

**Files:** Create the contracts, types, eligibility and settings files above; `packages/domain/db/migrations/0045_meeting_recording_setup.sql`; tests `packages/contracts/test/meetingAutoRecording.test.ts`, `packages/domain/test/meetings/meetingAutoRecordingEligibility.test.ts`, `packages/domain/test/db/support/meetingRecordingSetupCases.ts`. Modify contracts exports/settings, `packages/domain/settings/store.ts`, `packages/domain/jobs/{jobKinds,jobStore}.ts`, `packages/domain/db/schemaRange.ts`, `packages/domain/test/jobs/queue.test.ts`, and `packages/domain/test/db/migrations.test.ts`.

**Interfaces produced:**
- `MeetingAutoRecordingSetting = {enabled:boolean, hostEmail:string|null, calcomEventTypeId:number|null}`; default `{enabled:false,hostEmail:null,calcomEventTypeId:null}`. Enabling requires a canonical email and positive safe-integer event ID.
- `RecordingSetupState = 'pending'|'verifying'|'ready'|'manual'|'obsolete'` and `RecordingSetupReason = 'disabled'|'unconfigured'|'routing_ambiguous'|'unmatched'|'not_future'|'expired'|'attempt_limit'|'booking_mismatch'|'zoom_mismatch'|'unsupported_meeting'|'unsupported_recording_mode'|'provider_refused'|'provider_unreachable'|'auth_failed'|'rate_limited'|'ambiguous_write'|'target_changed'|'manual_override'`.
- `RecordingSetupTarget`: workspace/meeting/firm IDs, nullable contact ID, current booking UID, Zoom ID, canonical attendee/organizer emails, ISO start/end, and settings version. `recordingSetupTargetHash(target):string` hashes a fixed ordered tuple of those values; notes are excluded.
- `CalcomDemoBooking`: UID, status, authoritative event type ID, host/attendee emails, start/end, Zoom ID, nullable successor UID, recurring/seated flags. `ZoomMeetingSnapshot`: meeting ID, host email, numeric type, nullable `usePmi`, start, integer duration and automatic-recording mode. Types live in `autoRecordingTypes.ts`; provider data is validated before entering them.
- `recordingSetupEligibility({target,setting,booking,zoom,at,reusedZoomId}): {ok:true,action:'observe'|'set_local'}|{ok:false,reason:RecordingSetupReason}`.
- `readMeetingAutoRecordingSetting(context:RepositoryContext):Promise<{setting:MeetingAutoRecordingSetting,version:number}>`.

- [ ] Write `requires_exact_demo_identity_and_future_time`, `rejects_unsupported_zoom_targets`, `uses_stable_target_revision` and schema tests. Pin representative assertions:
  ```ts
  expect(recordingSetupEligibility(valid)).toEqual({ok:true,action:'set_local'});
  expect(recordingSetupEligibility({...valid,at:valid.target.startsAt}).ok).toBe(false);
  expect(recordingSetupEligibility({...valid,reusedZoomId:true}).ok).toBe(false);
  expect(recordingSetupTargetHash({...target})).toBe(recordingSetupTargetHash(target));
  expect(DEFAULT_MEETING_AUTO_RECORDING.enabled).toBe(false);
  ```
  Table cases cover all eligibility rules in the spec, exactly ±60 versus ±61 seconds, fractional-minute or conflicting duration, missing identity, and local/cloud/unknown recording modes.
- [ ] Run `npm test --workspace packages/contracts -- test/meetingAutoRecording.test.ts` and `npm test --workspace packages/domain -- test/meetings/meetingAutoRecordingEligibility.test.ts test/db/migrations.test.ts`; confirm failures for the new behavior before implementation.
- [ ] Implement these interfaces. Reuse email and URL normalization; never compare a topic as identity. Reject multiple Cal.com hosts/attendees for this first version rather than choosing the first; reject contradictory `eventTypeId` / `eventType.id` values and mismatched location/meeting URL IDs.
- [ ] Add the scoped operation table: operation UUID, meeting FK, immutable target JSON plus hash, current operation version, retry generation, state/reason, attempts, first-attempt/deadline/next-attempt times, write-intent timestamp and owner token, write certainty, pre-write mode, verified timestamp and whether this operation changed Zoom. Use `(workspace_id,id)` primary key and `(workspace_id,meeting_id,target_hash,retry_generation)` uniqueness. Add checks for valid shapes/states, scoped references/grants, due index and cascading deletion. No existing row becomes ready or enabled. Add nullable `jobs.first_claimed_at` without backfilling history; Set `first_claimed_at = COALESCE(first_claimed_at, now())` in the existing atomic job claim; never reset it on retry/reclaim. Add a two-connection queue test proving a crash immediately after claim preserves that time and increments attempt_count exactly once. Add job kind `meeting.recording_setup`, class `bulk`, protection `outbound_fence` to existing kind maps now, so Task 3 can exercise the real runner before production wiring. Add the setting key to database vocabulary and schema range.
- [ ] Make `meeting_auto_recording` settings writes take calendar-routing shared and workspace gate exclusive before the existing setting lock, so they serialize with the final writer without reversing lock order. Rerun focused suites and typecheck; commit `feat: define demo recording eligibility and state`.

## Task 2: narrowly scoped provider adapters

**Files:** Create worker `zoom/meetingsClient.ts`, `calcom/bookingClient.ts`, `apps/worker/test/zoomMeetingsClient.test.ts`, `apps/worker/test/calcomBookingClient.test.ts`. Extend Task 1's internal types for provider ports; keep the existing list adapter and version unchanged.

**Consumes:** Task 1 booking/Zoom shapes and `readCalcomSecret`.

**Produces:** `ProviderRead<T> = {kind:'ok',value:T}|{kind:'retry'|'refused',code:string,retryAfterMs:number|null}`; `ZoomWriteResult = {kind:'acknowledged'|'refused'|'unknown',code:string|null,retryAfterMs:number|null}`. `CalcomDemoClient.readBooking(uid:string,signal:AbortSignal):Promise<ProviderRead<CalcomDemoBooking>>`; `ZoomMeetingsClient.readMeeting(id:string,signal:AbortSignal):Promise<ProviderRead<ZoomMeetingSnapshot>>`; `ZoomMeetingsClient.setLocalAutoRecording(id:string,signal:AbortSignal):Promise<ZoomWriteResult>`. Factories `calcomDemoClient({apiKey,http?})` and `zoomMeetingsClient({accountId,clientId,clientSecret,http?,now?})`; `http` is a fetch-compatible injectable function and `now` returns epoch milliseconds. `readZoomMeetingsConfiguration(environment)` returns either `{client,problem:null}` or `{client:null,problem:<field-name-only>}`.

- [ ] Write tests `patches_only_local_recording`, `uses_endpoint_specific_cal_version`, `never_leaks_provider_secrets`, `rejects_ambiguous_booking_shapes`, and `bounds_headers_and_body_reads` with fake HTTP:
  ```ts
  expect(JSON.parse(patch.body)).toEqual({settings:{auto_recording:'local'}});
  expect(calRequest.headers['cal-api-version']).toBe('2026-02-25');
  expect(patch.redirect).toBe('error');
  expect(serializedFailure).not.toContain(secretSentinel);
  expect(patchRequestsAfterTimeout).toHaveLength(1);
  ```
- [ ] Run `npm test --workspace apps/worker -- test/zoomMeetingsClient.test.ts test/calcomBookingClient.test.ts test/calcomReconcile.test.ts`; confirm new failures and preserve the existing list-header test.
- [ ] Implement token acquisition with `account_credentials`, an in-memory cache and a 60-second expiry margin. Read operations may refresh on 401 once. The final PATCH uses the token already obtained by validation; it does not fetch/refresh a token while holding database locks. If no sufficiently live token remains, return a definite pre-request refusal. A rejected PATCH may become retryable only when the provider definitively reports no effect; timeout/disconnect/uncertain 5xx is `unknown` and goes to readback.
- [ ] Pin `https://zoom.us/oauth/token`, `https://api.zoom.us/v2/meetings/{validatedId}` and `https://api.cal.com/v2/bookings/{validatedUid}`. Set 10-second token/GET and 5-second PATCH bounds, plus a 1 MiB streamed response limit; an AbortSignal covers body consumption as well as headers. Reject redirects and unsupported response arrays/seated/recurring data. Sanitize all exceptions and discard unused sensitive fields. Parse Retry-After with a deadline-aware cap in the caller.
- [ ] Rerun provider tests/typecheck; commit `feat: add narrow Zoom and Cal.com recording adapters`.

## Task 3: durable execution, reconciliation and lifecycle

**Files:** Create domain `autoRecording.ts`, `autoRecordingLifecycle.ts`, worker `handlers/meetingAutoRecording.ts`, domain tests `meetingAutoRecordingOperations.test.ts`, `meetingAutoRecordingLifecycle.test.ts`, worker test `meetingAutoRecording.test.ts`, and fixture `packages/domain/test/meetings/support/meetingAutoRecordingFixture.ts`. Modify `packages/domain/meetings/calcom.ts`, `packages/domain/crm/merges.ts`, retention/deletion and restore holds only where operation ownership/lifecycle requires it.

**Consumes:** Task 1 target/state and Task 2 provider ports.

**Produces:** `runMeetingRecordingSetup(session:SessionQueryable,{workspaceId,operationId,jobId,fencingToken,calcom,zoom,now}):Promise<void>`; `meetingAutoRecordingJobHandler({calcom,zoom,now?}):JobHandler`; `invalidateMeetingRecordingSetup(context,{meetingId,reason,at}):Promise<void>`; `foldMeetingRecordingSetup(context,{sourceMeetingId,targetMeetingId,at}):Promise<void>`. The operation runner owns its short transactions and uses the job runner's existing `outbound_fence` execution mode, not the email outbound-fence table. `now` is an injected ISO-string clock; the final write also checks database wall-clock time.

- [ ] Add fixture-driven tests `reconciles_a_crash_after_patch`, `cancel_or_disable_before_boundary_prevents_patch`, `old_lease_cannot_dispatch`, `manual_disable_survives_reschedule`, `fold_never_transfers_readiness_to_a_new_zoom_id`, and `deletion_during_readback_does_not_resurrect_data`:
  ```ts
  expect(patchesAfterCrashAndRecovery).toHaveLength(1);
  expect(patchesAfterCommittedDisable).toHaveLength(0);
  expect(operationAfterUncertainNonLocalReadback.state).toBe('manual');
  expect(operationAfterNewZoomId.state).not.toBe('ready');
  expect(recreatedDeletedMeetings).toHaveLength(0);
  ```
- [ ] Run `npm test --workspace packages/domain -- test/meetings/meetingAutoRecordingOperations.test.ts test/meetings/meetingAutoRecordingLifecycle.test.ts` and `npm test --workspace apps/worker -- test/meetingAutoRecording.test.ts`; verify the new cases fail.
- [ ] Record attempts as the maximum of the operation count and the current job attempt count (never their sum), and persist its original deadline from `jobs.first_claimed_at` before provider I/O. Validate current booking and Zoom through Task 2, then commit a write intent owned by this claim before PATCH. A subsequent claim seeing unresolved intent can only reconcile. Immediately before writing, lock in the global order, recheck current routing/configuration/identity/job ownership/deadline and gate against cancellation or deletion. Never hold the job-row lock before routing/gate/meeting locks. Keep only the bounded PATCH in this final critical section; GET/token work stays outside.
- [ ] Persist acknowledgement/refusal/unknown classification, then GET readback. Verified `local` with matching identity becomes ready; an unresolved write followed by another mode becomes manual. Definitively refused/no-effect attempts may retry within the same deadline and attempt limit; ambiguous attempts never re-PATCH automatically. Any DB rollback after dispatch leaves the previously committed intent available for recovery. A expired/stolen claim must not settle another claim's result.
- [ ] Invalidation cancels pending work but never resets Zoom settings. A same-ID reschedule preserves prior applied/manual-change history; a new ID gets fresh validation. Preserve operation history through folds without violating uniqueness; mark moved operations obsolete and have the survivor schedule fresh validation, carrying any unresolved write/history for the same Zoom ID. Firm merges invalidate target hashes. Delete operation content with its meeting; restore marks nonterminal operations for fresh checks and disables this integration under existing restore holds. No deletion or restore directly calls Zoom.
- [ ] Rerun operation, lifecycle, worker and affected retention/restore/fold suites; commit `feat: reconcile demo recording setup safely`.

## Task 4: scheduling, health and deployment configuration

**Files:** Create `packages/domain/meetings/autoRecordingJobs.ts`, test `packages/domain/test/meetings/meetingAutoRecordingJobs.test.ts`. Modify worker `runner/jobRunner.ts` and bootstrap `main.ts`, `autoRecordingSettings.ts`, settings tests, `infra/modules/{secrets,cluster}/main.tf`, `infra/scripts/rehearsal.sh`, `test/ops/{terraformCrossChecks,providerCallBoundaries,rehearsalSecretFill}.check.ts` and relevant worker bootstrap tests.

**Consumes:** Task 3 operation runner/handler.

**Produces:** `scheduleMeetingRecordingSetup(session:SessionQueryable,at:string,{providerConfigured:boolean}):Promise<readonly JobSpecification[]>`; job kind `meeting.recording_setup`, class `bulk`, protection `outbound_fence`, 90-second lease; payload only `{operationId}`. `readMeetingAutoRecordingConfiguration(context):Promise<{setting:MeetingAutoRecordingSetting,version:number,configured:{ready:boolean,workerFresh:boolean}}>` uses the existing heartbeat freshness convention.

- [ ] Write tests `twenty_terminal_rows_do_not_starve_new_work`, `expired_jobs_cannot_restart_their_deadline`, `a_crash_before_handler_reservation_is_bounded`, `stale_worker_cannot_appear_configured`, and `disabled_integration_makes_no_provider_calls`:
  ```ts
  expect(newJobs.length).toBeLessThanOrEqual(20);
  expect(queuedMeetingIds).toContain(eligibleMeetingAfterTwentyReadyRows);
  expect(jobAfterFourthAttempt).toBeUndefined();
  expect(jobAtFirstAttemptPlusTwoHours).toBeUndefined();
  expect(configurationFromStaleHeartbeat.configured.workerFresh).toBe(false);
  ```
- [ ] Run `npm test --workspace packages/domain -- test/meetings/meetingAutoRecordingJobs.test.ts test/jobs/kindClasses.test.ts`, `npm test --workspace apps/worker -- test/startup.test.ts test/workerWiring.test.ts test/meetingAutoRecording.test.ts`, and the targeted ops checks; verify new failures.
- [ ] Materialize one revision/generation once. Order due candidates by meeting start then ID; exclude current terminal/ready revisions in SQL before applying the 20-row limit. Compute target hashes from the current configuration and meeting, not an old job snapshot. Use Task 1's persisted `jobs.first_claimed_at` and `attempt_count` when enforcing limits, so failures before the domain reservation still count. Test a real runner crash before handler reservation and prove the scheduler uses the original claim time. Do not generate new time-bucket jobs to evade four attempts. Set `next_attempt_at` using existing backoff/Retry-After, capped by the fixed deadline; terminalize expired work independently of handler health. Within the same attempt/time limits, recovery reads may settle an unresolved effect without authorizing another PATCH. After expiry, retain the unknown outcome as manual review; only an explicit retry generation can initiate another read.
- [ ] Report a `meeting_recording_setup` boolean in the existing runner heartbeat detail, derived from registration of the handler with both provider clients. A missing/stale heartbeat cannot say setup is usable. Keep per-provider field-name diagnostics in startup logs; a desktop readiness boolean is not proof that credentials have authenticated successfully. Reject an enabling settings write server-side unless the calendar is uniquely routed and fresh worker readiness plus the non-secret setting fields are present; a disabled save always remains available. Add `<prefix>/zoom-meetings` to empty secret containers and worker injection only, with inert rehearsal values and cross-check updates. Keep values out of Terraform state, API configuration and logs. Add field-name-only startup diagnostics. No new AWS permission beyond access to this specific secret container under the existing key arrangement.
- [ ] Rerun focused suites, `npm run typecheck:greenfield`, `npm run test:ops -- terraformCrossChecks providerCallBoundaries rehearsalSecretFill`, and `TERRAFORM=/Users/davidcui824/.local/bin/terraform bash infra/scripts/offline-gate.sh`; commit `feat: schedule and configure demo recording setup`.

## Task 5: authorized reads, retry and quiet desktop controls

**Files:** Create API/desktop components from the file map and tests `apps/api/test/meetingAutoRecording.test.ts`, `apps/desktop/test/meetingAutoRecording.component.test.tsx`, `apps/desktop/test/meetingAutoRecordingSettings.component.test.tsx`, `apps/desktop/test/e2e/meetingAutoRecordingScreens.spec.ts`. Modify API `routes/{modules,settings}.ts`, desktop `shared/operations.ts`, `main/operationHost.ts`, `renderer/meetings/FirmMeetings.tsx`, `renderer/settings/CallingCalendarSection.tsx`; add state/read helpers to domain `autoRecording.ts`.

**Interfaces produced:**
- `MeetingRecordingSetupView = {meetingId,operationId:string|null,version:number,state:RecordingSetupState|'disabled'|'not_applicable',reason:RecordingSetupReason|null,checkedAt:string|null,canRetry:boolean,previouslyEnabled:boolean}` in the public contract file. No provider credentials, URLs or raw payloads.
- `readMeetingRecordingSetup(context,{meetingId}):Promise<MeetingRecordingSetupView|null>`; `retryMeetingRecordingSetup(context,{meetingId,expectedVersion,at}):Promise<MeetingResult<MeetingRecordingSetupView>>`, reusing `MeetingResult` from `meetings/outcomeTypes.ts`.
- `GET /meetings/recording-setup?meetingId=...` and `POST /meetings/recording-setup/retry`; desktop operations `meetings.recordingSetup` and `meetings.retryRecordingSetup`. Retry uses existing command ID/client version, receipts and audit; public request adds `meetingId` and `expectedVersion` only. Time comes from the server.

- [ ] Add tests `other_firm_and_other_workspace_return_not_found`, `retry_is_idempotent_and_versioned`, `retry_cannot_bypass_unresolved_write`, `late_response_cannot_change_another_meeting`, and `old_client_integrations_shape_is_unchanged`:
  ```ts
  expect(otherWorkspaceResponse.status).toBe(404);
  expect(operationCountAfterReplayedCommand).toBe(operationCountAfterFirstCommand);
  expect(staleRetryResponse.status).toBe(409);
  expect(screen.getByText('Auto-recording set')).toBeVisible();
  expect(screen.queryByText('Recording complete')).toBeNull();
  ```
- [ ] Run focused API and the two desktop component tests and observe the missing behavior fail.
- [ ] Use existing firm read/mutation authorization (including audited administrator access); missing, inaccessible and unmatched meetings share the not-found result. Retry is available only for an eligible future meeting and a current operation version; it creates an audited generation once. An unresolved previous write is reconciled first. Explicit retry may reapply after a known manual mode only after the displayed reason and user command, never just because the scheduler saw a changed setting.
- [ ] Add `include=meeting_auto_recording` to newer desktop settings requests and an optional corresponding response field. Omit it for old callers; keep old setting-key enumerations compatible. Enabling uses Task 4's server-side check for configured IDs/host, calendar routing and a fresh worker reporting both clients. Keep the existing settings admin gate. Render **Automatically record Callie demos locally** and the three spec labels, checked time, expandable reason and Retry. Ready does not claim a local file exists. Cancellation/replacement history notes previously enabled settings without undoing them. Switching firm/session clears obsolete view state; retry preserves command IDs across a lost response.
- [ ] Run the API/component suites, `npm run test:desktop:e2e -- meetingAutoRecordingScreens.spec.ts`, inspect ready/pending/manual/disabled states at desktop and narrow widths, and run typecheck. Commit `feat: show demo recording setup and recovery`.

## Task 6: end-to-end verification, review and disabled release

**Files:** Create `docs/greenfield/runbooks/zoom-demo-recording.md`, `apps/api/test/meetingAutoRecording.integration.test.ts`; extend `docs/greenfield/meetings.md`, migration support/upgrade fixtures and the artifact evidence log outside the repository. Use existing CI/release workflows; no release-system rewrite.

**Consumes:** Tasks 1–5. **Produces:** a reviewed release with the feature disabled and an explicit record of what live acceptance remains.

- [ ] Write an integration test `booking_to_setup_to_readback` through the real authenticated API, scheduler and runner with fake provider HTTP. Exercise create, reschedule with same/new Zoom ID, cancel, disable, lost response and replay; assert the real command path cannot widen target identity:
  ```ts
  expect(patchBodies).toEqual([{settings:{auto_recording:'local'}}]);
  expect(nonDemoPatches).toHaveLength(0);
  expect(sendingSwitchAfter).toEqual(sendingSwitchBefore);
  expect(processingBudgetsAfter).toEqual(processingBudgetsBefore);
  ```
- [ ] Run `npm test --workspace apps/api -- test/meetingAutoRecording.integration.test.ts`; repair any uncovered wiring defect under a failing regression test, then pass it.
- [ ] Run `npm run gate:greenfield`, `npm run verify:secrets`, browser acceptance screens, and the populated schema 44→45 upgrade using the existing upgrade workflow and fixtures. Verify the new table's grants and restore/deletion behavior. Run infrastructure validation/rehearsal for the added inert worker secret. Preserve actual artifacts; do not call skipped tests executed.
- [ ] Obtain one independent whole-branch review on the completed change using the established workflow. Fix actionable findings with regression evidence, rerun affected checks and verify the final head. Commit, open and attach the PR, merge only through protected checks, and perform the existing schema/desktop release with auto-recording disabled. Read back the production integration setting and existing sending/processing controls.
- [ ] Document secure setup and acceptance: verify the existing Cal.com key and exact demo event ID; place Zoom credentials directly in the dedicated secret via the approved secure path; activate the already-created app at the action step and enable Callie only for the controlled test. No credentials in chat, files or process arguments. The unused webhook token is not part of this feature.
- [ ] With a designated test demo and a non-demo control, prove narrow settings/readback, then have David host from Zoom desktop. Validate actual converted local files/importer behavior; report separately if that native recording test remains pending. Do not claim end-to-end readiness from the API readback alone. Rollback/disable stops future changes and leaves already-set individual meeting settings documented for manual review.

## Plan self-review and handoff

Coverage: Task 1 owns exact identity/configuration; Task 2 owns provider parsing and secret boundaries; Task 3 owns durable external-effect/lifecycle semantics; Task 4 owns deadlines/fairness/runtime; Task 5 owns access and compatibility; Task 6 owns production evidence and acceptance. Review Focus cases are assigned above. Provider calls never occur in migration, settings saves or the API retry route.

Preserve native implementation and one whole-branch review. Ask David to review this plan before implementation, as required by the writing-plans workflow. Approval of the design is recorded separately from this plan's approval. Runtime activation and the real desktop test remain concrete rollout steps, not prerequisites for writing/test-driving the implementation.
