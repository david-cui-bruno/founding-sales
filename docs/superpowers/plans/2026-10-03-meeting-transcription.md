# Meeting Transcription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Native execution in the current chat is recommended; execution-method confirmation is pending.

**Goal:** Turn imported Callie demo audio into readable, attributed meeting transcripts, with bounded spending and recoverable failures.

**Architecture:** Extend the shipped meeting-recording flow with a meeting-specific worker adapter, durable attempts and transcript reads. Reuse Postgres jobs, the private audio bucket, workspace settings and provider reservations. Keep the existing Twilio transcription implementation intact.

**Tech Stack:** TypeScript on Node 24, PostgreSQL 16, AWS SDK/S3/Transcribe, packaged FFmpeg, Electron/React/shadcn, Vitest and existing desktop Playwright tests.

**Spec:** ../specs/2026-10-03-meeting-transcription-design.md — David approved the design in chat after its plain-language explanation. Approval does not activate paid processing or change budgets.

## Global Constraints

- Start from branch `codex/meeting-transcription` in the existing `worktrees/crm-navigation` checkout, currently based on main `48559f4236c5deef1f80af6b8b4a852c6df9cdc1` plus the approved spec. Preserve unrelated work.
- Recheck main and migration numbering before implementation. The planned next migration is `0042_meeting_transcription.sql`; never edit deployed migrations.
- Meeting transcription defaults to disabled and a zero daily allowance. The proposed $0.50/day is not approved; existing call and cash ceilings remain unchanged.
- Verified AWS credit coverage is required before new meeting jobs start. No automatic cash fallback. Collect already-started jobs after disablement.
- Audio limits: 300 MiB input and prepared output, four hours maximum duration, two-minute subprocess deadline. No silent truncation to fit a budget.
- At most two automatic paid attempts per recording, including attempts on aliases created by a meeting fold. Upload recovery, processing-version changes and restarts do not replenish that allowance.
- Persist provider identity before dispatch; use one SDK request attempt. Collect ambiguous starts by the same job name. Collection deadline is 120 minutes, including check-up jobs that crash before running.
- Preserve one-day bucket expiry. No speech, participant labels, local paths, audio or signed URLs in ordinary logs/job payloads.
- File-relative timestamps only unless alignment is proved. Participant labels and diarized speakers are provisional; never infer attendance or deal stage.
- Sending stays paused; call-suggestion automatic application stays off; no summaries, emails, stage moves, account-wide recording or new services in M5.

## Review Focus

- Both sides of a meeting fold contain the same digest, but only one has a transcript or an in-flight provider job: preserve content, identities and all charges; Task 1 and Task 3 test this.
- A budget hold lasts beyond source expiry, then the user retries from another Mac: require the authorized matching file without resetting attempts; Task 4 tests this.
- A switch changes or a firm is reassigned while media preparation runs: reauthorize at dispatch/recovery and prevent stale-client disclosure; Tasks 3–5 test this.
- The provider job was accepted but its response was lost, and its output later expires: do not silently buy replacements or call the result complete; Tasks 2–3 test this.
- Long silence, punctuation-only output, delayed participant files or repeated display names: honest coverage, bounded parsing, stable evidence IDs and no invented chronology; Tasks 2 and 5 test this.

## Implementation structure and conventions

Use five testable tasks below, each with a local commit. All changes are one feature release unless a task is explicitly separated later. Do not deploy an intermediate schema/worker combination.

`RepositoryContext`, `SessionQueryable`, `JobHandler`, `DueWorkSource` and `JobSpecification` below are existing repository types. All new public data types and Zod schemas live in `packages/contracts/src/meetingTranscription.ts`; provider-only types live in `packages/domain/meetings/transcriptionTypes.ts`. Domain writes run in the caller's transaction. Use the existing committed-chunk job protocol: preparation has no firm/meeting/reservation row locks, and provider dispatch happens in a later chunk after the job identity was committed. Do not introduce a new job-runner transaction mode.

Shared public types:

```ts
type RecordingSourceKind = 'participant' | 'mixed' | 'unknown';
type MeetingProcessingStatus = 'disabled' | 'funding_unverified' | 'budget_held' |
  'queued' | 'preparing' | 'transcribing' | 'ready' | 'needs_reupload' | 'failed';
type MeetingCoverage = { sourceRevision: number; total: number; ready: number;
  held: number; pending: number; failed: number; unavailable: number };
type MeetingUtterance = { id: string; recordingId: string; transcriptId: string; transcriptVersion: number;
  startMs: number; endMs: number; text: string; speaker: string | null;
  attribution: 'source_label' | 'provider_label' | 'unknown' };
type RecordingProcessingView = { recordingId: string; meetingId: string; participantLabel: string; segment: number;
  sourceKind: RecordingSourceKind; status: MeetingProcessingStatus;
  reason: string | null; transcriptId: string | null; transcriptVersion: number | null; durationMs: number | null };
type MeetingTranscriptPage = { meetingId: string; coverage: MeetingCoverage;
  recordings: RecordingProcessingView[]; utterances: MeetingUtterance[];
  nextCursor: string | null; timing: 'file_relative' };
type MeetingTranscriptionSetting = { enabled: boolean; dailyCeilingCents: number;
  creditCoverage: null | { accountId: string; service: 'transcribe';
    evidenceRef: string; verifiedAt: string; validUntil: string;
    status: 'verified' | 'revoked' } };
```

Limits fixed for implementation: 500 cents maximum configurable daily ceiling, 200 utterances/page, 20,000 utterances/transcript, 4,000 characters/utterance, 4 MiB stored transcript text and 16 MiB provider JSON. Oversized results fail explicitly, never silently truncate. Cursors identify the source revision, recording/transcript and next utterance; changing the revision throws `MeetingTranscriptChangedError`, mapped to HTTP 409 `transcript_changed` for a refresh. Opaque cursors grant no authorization. Increment the source revision on registration, fold, or a change in the selected transcript, so a newly completed source cannot be skipped by a cursor from an incomplete read.

### Task 1: durable transcript identity, settings and authorized reads

**Files:**
- Create `packages/domain/db/migrations/0042_meeting_transcription.sql`.
- Create `packages/contracts/src/meetingTranscription.ts`, `packages/domain/meetings/transcriptionTypes.ts`, `packages/domain/meetings/recordingIdentity.ts`, `packages/domain/meetings/transcripts.ts`, `packages/domain/meetings/transcriptionSettings.ts`.
- Modify `packages/contracts/src/{index,settings,meetingRecordings}.ts`, `packages/domain/meetings/recordings.ts`, `packages/domain/retention/{coverage,deletion}.ts`, and schema-range/upgrade metadata according to the established release convention.
- Create `apps/api/src/routes/meetingTranscription.ts`; register it in `apps/api/src/routes/modules.ts`.
- Tests: new `packages/domain/test/meetings/{meetingTranscripts,meetingRecordingFolds,meetingTranscriptionSettings}.test.ts`, `packages/contracts/test/meetingTranscription.test.ts`, `apps/api/test/meetingTranscription.test.ts`; extend `packages/domain/test/db/migrations.test.ts` with new `support/meetingTranscriptionCases.ts`.

**Interfaces:**
- `readMeetingTranscription(context: RepositoryContext): Promise<MeetingTranscriptionSetting>` defaults to `{ enabled: false, dailyCeilingCents: 0, creditCoverage: null }`.
- `resolveMeetingRecording(context: RepositoryContext, recordingId: string): Promise<{ recordingId: string; meetingId: string; aliasIds: readonly string[] } | null>` resolves current identity inside the workspace.
- `readMeetingTranscript(context: RepositoryContext, input: { meetingId: string; cursor?: string }): Promise<MeetingTranscriptPage | null>`; `null` means absent or unauthorized, with identical 404 behavior.
- `GET /meetings/transcript?meetingId=&cursor=` returns that page. Keep the existing strict M4 recording response unchanged; new status fields use this new endpoint.

- [ ] **Write failing tests.** `legacy_defaults_off` asserts missing/invalid settings are disabled with zero allowance; `transcript_read_is_assignee_or_admin` asserts the same 404 for another workspace and another assignee; `late_source_invalidates_cursor` asserts a new file changes the source revision; `fold_preserves_completed_and_inflight_sources` asserts stable transcript IDs, resolvable old recording IDs and retained reservation references. Constraint tests reject cross-workspace FKs, invalid bounds and duplicate transcript versions.
- [ ] **Run the focused tests and verify relevant failures.** `npm run test --workspace packages/contracts -- test/meetingTranscription.test.ts`; `npm run test --workspace packages/domain -- test/meetings/meetingTranscripts.test.ts test/meetings/meetingRecordingFolds.test.ts test/meetings/meetingTranscriptionSettings.test.ts test/db/migrations.test.ts`; `npm run test --workspace apps/api -- test/meetingTranscription.test.ts`. The domain harness starts real PostgreSQL 16; failures must name absent behavior, not missing infrastructure.
- [ ] **Implement persistence and reads.** Add recording source-kind/processing metadata, a meeting source revision, `meeting_transcription_attempts`, `meeting_transcripts` and a small `meeting_recording_aliases` mapping for folded duplicate identities. Attempts link to provider reservations; transcripts have immutable IDs/version and a current canonical recording FK. Version uniqueness is on original recording identity plus version, so moving transcripts during a fold does not collide or renumber evidence. The public read returns the current canonical recording ID and immutable transcript/utterance IDs. Composite workspace FKs and cascading subject deletion are mandatory. Expand the reservation subject/priced-shape and settings-key checks for this feature only. Do not change old four-value recording-state contracts.
- [ ] **Implement fold/registration behavior.** Serialize on firm then meeting locks in the existing order, using an exclusive meeting lock before incrementing source revision. Preserve nonduplicate recording rows. On a duplicate, transfer its attempts/transcripts and alias identities before deleting the duplicate row; ledger subject IDs remain original and are included through alias lookup. Preserve both successful transcript versions when both exist; choose the earliest completed result, then ID, for the default read. No provider job is restarted by a fold. Update registration atomically, but leave enqueueing to Task 3.
- [ ] **Implement settings/access/retention.** Reuse the audited admin settings command for the nested coverage record; validate dates, 12-digit account ID and bounded evidence reference. Store metadata, never credentials. Read all transcripts through current meeting/firm authority, with bounded pagination and plain-text fields. Register all new tables with retention coverage and prove deletion does not leave participant content.
- [ ] **Rerun the focused commands.** Expected: all named tests pass on PostgreSQL 16, old recording contract tests still pass. Run `npm run typecheck:greenfield` after adding the exports/routes.
- [ ] **Commit** only Task 1 files with `feat: add meeting transcript storage and reads`.

### Task 2: bounded audio preparation and meeting-specific AWS adapter

**Files:**
- Create `apps/worker/src/transcription/{prepareMeetingAudio,meetingAudioStore,awsMeetingTranscribeClient}.ts`.
- Modify `Dockerfile.worker`, `infra/modules/cluster/main.tf` and its applicable policy tests; add only the meeting processing/output object prefixes needed.
- Tests: `apps/worker/test/{prepareMeetingAudio,awsMeetingTranscribeClient}.test.ts` and generated media/provider fixtures under `apps/worker/test/fixtures/meetingTranscription/`.

**Interfaces** (declare these provider-only types in `transcriptionTypes.ts`):

```ts
type PreparedMeetingAudio = { inputKey: string; durationMs: number;
  sizeBytes: number; sha256: string; mediaFormat: 'flac' };
type MeetingProviderResult = { kind: 'pending' } |
  { kind: 'complete'; language: string; utterances: Omit<MeetingUtterance,
      'id' | 'recordingId' | 'transcriptId' | 'transcriptVersion'>[] } |
  { kind: 'failed'; code: string };
interface MeetingTranscriptionProvider {
  start(input: { jobName: string; inputKey: string; outputKey: string;
    sourceKind: RecordingSourceKind }): Promise<'started' | 'ambiguous' | 'refused'>;
  collect(input: { jobName: string; outputKey: string }): Promise<MeetingProviderResult>;
}
interface MeetingMediaPreparer {
  prepare(input: { sourceKey: string; expectedSha256: string; expectedSizeBytes: number;
    preparedKey: string }, signal: AbortSignal): Promise<PreparedMeetingAudio>;
}
```

- [ ] **Write failing tests.** `duration_comes_from_decoded_samples` checks exact billable duration including long silence; `bounds_apply_during_streaming` aborts above 300 MiB; `no_external_media_protocols` refuses a network reference; `deadline_kills_child_and_cleans_temp` verifies process termination and cleanup; `long_audio_is_refused_not_trimmed` rejects over 14,400 seconds. Parser tests cover per-participant, mixed/unknown with provisional speaker labels, punctuation, silence, malformed timestamps, output size limits and HTTP/SDK ambiguity without a second Start call.
- [ ] **Run** `npm run test --workspace apps/worker -- test/prepareMeetingAudio.test.ts test/awsMeetingTranscribeClient.test.ts`; verify failures correspond to missing adapters.
- [ ] **Implement preparation.** Package FFmpeg/ffprobe in the Debian ARM64 runtime image. Validate source byte count/digest while streaming to private temporary storage, invoke with argument arrays and file/pipe protocols only, one thread and a two-minute deadline. Decode audio to 16 kHz mono FLAC, with streaming/output-size and duration bounds; reject video/multiple unexpected streams or malformed input. Participant mode preserves its source label; mixed/unknown mode asks AWS for provisional diarization. Count decoded samples; provider timestamps do not determine the reservation duration. Remove local artifacts in `finally` and on abort.
- [ ] **Implement AWS adapter.** Use the existing region/bucket and workload IAM role, deterministic caller-supplied job name, `MediaFormat: flac`, English (`en-US`), and own-bucket output. Configure the SDK with `maxAttempts: 1`. Use `ShowSpeakerLabels`/`MaxSpeakerLabels: 30` for mixed/unknown only; no Twilio two-channel parser. Fetch output through the authorized expected S3 key, never an arbitrary provider URL. Bound JSON/text and emit only typed results/codes. Preserve punctuation without manufacturing timestamps for punctuation-only items.
- [ ] **Implement narrow storage permissions.** Use `meetings-processing/<recordingId>/...` for prepared input/output. Allow only the necessary worker Get/Put/Delete and Transcribe output-prefix condition, keeping source uploads under existing `meetings/*` permissions. All objects inherit the one-day bucket lifecycle. Record FFmpeg version and generated-fixture checks in the build verification.
- [ ] **Rerun focused tests and worker typecheck.** Expected: tests pass, one Start per invocation, all malformed/over-limit cases fail without provider work. Build the ARM64 worker image using the existing CI image workflow before release; local tests must exercise the packaged media adapter where supported.
- [ ] **Commit** Task 2 files with `feat: prepare and transcribe meeting audio with AWS`.

### Task 3: budgeted jobs, dispatch and bounded collection

**Files:**
- Create `packages/domain/meetings/{transcriptionBudget,transcription,transcriptionJobs}.ts` and `apps/worker/src/handlers/meetingTranscribe.ts`.
- Modify `packages/domain/meetings/recordings.ts`, `packages/domain/jobs/jobKinds.ts`, `apps/worker/src/bootstrap/{main,config}.ts`, and the worker environment in `infra/modules/cluster/main.tf`.
- Tests: `packages/domain/test/meetings/{meetingTranscriptionBudget,meetingTranscriptionJobs}.test.ts`, `apps/worker/test/meetingTranscribe.test.ts`; extend bootstrap/scheduler/retention tests.

**Interfaces:**
- `meetingTranscriptionCents(durationMs: number, unitPriceMicros = 6000): number` prices `max(15, ceil(durationMs / 1000))` seconds, rounded upward once to integer cents per attempt.
- `beginMeetingTranscription(context: RepositoryContext, input: { recordingId: string; prepared: PreparedMeetingAudio; at: string; accountId: string }): Promise<{ kind: 'reserved'; attemptId: string; reservationId: string; jobName: string; outputKey: string } | { kind: 'held'; reason: string }>`.
- `dispatchMeetingTranscription(context: RepositoryContext, input: { attemptId: string; at: string; accountId: string }): Promise<{ kind: 'dispatch'; jobName: string; inputKey: string; outputKey: string; sourceKind: RecordingSourceKind } | { kind: 'held'; reason: string }>` records the paid boundary, with final checks, before the worker calls the provider.
- `completeMeetingTranscription(context: RepositoryContext, input: { attemptId: string; result: MeetingProviderResult; at: string }): Promise<'pending' | 'complete' | 'failed' | 'gone'>` stores/settles once using the reserved decoded duration, not a model's reported duration.
- `scheduleMeetingTranscriptions(session: SessionQueryable, at: string): Promise<readonly JobSpecification[]>` supplies bounded starts/resumes and collection wakes.
- `meetingTranscribeJobHandler(options: { preparer: MeetingMediaPreparer; provider: MeetingTranscriptionProvider; accountId: string }): JobHandler` integrates the above through short claims.

- [ ] **Write failing tests.** Assert two 1,200-second files reserve 12 cents each, a minimum-duration file reserves 1 cent, and reservations use the business date. With 50 cents available, concurrent 30-cent requests accept only one. Disabled/zero/expired/revoked/wrong-account funding makes zero Start calls. A lost response/restart uses the same job identity; folds include all alias attempts; the third automatic paid attempt is refused. Late completion after deletion cannot recreate speech. A permanently crashing check-up reaches the same 120-minute terminal deadline.
- [ ] **Run** `npm run test --workspace packages/domain -- test/meetings/meetingTranscriptionBudget.test.ts test/meetings/meetingTranscriptionJobs.test.ts`; `npm run test --workspace apps/worker -- test/meetingTranscribe.test.ts`. Verify each failure is behavioral before implementation.
- [ ] **Implement the budget boundary.** Use the existing provider-reservation ledger and settlement primitives; subject kind `meeting_transcription`, provider key `aws_transcribe.standard`, immutable price/duration per attempt. Acquire a workspace meeting-budget advisory lock, then current firm/meeting/recording locks in the documented order; count reserved, calling, settled and estimated charges for the business date. Permit only current verified coverage for the worker's configured AWS account. Inject that account as `FSS_AWS_ACCOUNT_ID` from Terraform's caller identity. Do not alter existing call funding behavior in this slice.
- [ ] **Implement jobs and registration.** Add `meeting.transcribe` as bulk/business-uniqueness; job keys include canonical recording ID and persisted wake revision, never content. Register-and-enqueue atomically. Preparation precedes spend reservation, without retained subject/budget locks; bound download and upload to 60 seconds each, preparation to 120 seconds, and give this handler a 300-second lease. Abort media work on shutdown and verify existing connection timeout behavior against this bound without loosening unrelated job limits. Final dispatch rereads state and current association. Mark ambiguous starts as pending collection. Preserve original attempt keys through folds and settle paid work even if the associated subject is later deleted, without preserving speech. On cancellation, stop new work and finish accounting for already-started work.
- [ ] **Implement bounded scheduling.** Scan at most 50 eligible rows per scheduler pass, ordered with a stable cursor to avoid starvation. Every held item has a reason and next wake; daily-budget holds wake at the next business-date boundary, and settings changes can wake them sooner. Terminal attempts/invalid media are not restarted by scans. Collection has persisted next-check/look sequence and a 120-minute deadline; recovery sees overdue rows independently of the success of any previous check-up job. Record at most six reservation rows per recording, including released-before-dispatch rows, matching the existing call bound.
- [ ] **Rerun focused tests, scheduler/bootstrap tests and `npm run typecheck:greenfield`.** Expected: zero duplicate paid jobs across concurrent/restart cases; accounting is unchanged by replay. Verify logs contain codes/counts only.
- [ ] **Commit** Task 3 files with `feat: run budgeted meeting transcription jobs`.

### Task 4: expired-source recovery and desktop source metadata

**Files:**
- Create `packages/domain/meetings/recordingRecovery.ts`.
- Modify `apps/api/src/routes/meetingTranscription.ts`, `apps/api/src/integrations/meetingAudio.ts` only as needed for stored-key recovery, and the contracts from Task 1.
- Modify `apps/desktop/src/main/recordings/{importer,store,files}.ts`, `apps/desktop/src/shared/{operations,recordings}.ts`, `apps/desktop/src/main/operationHost.ts` and the existing native-dialog bridge.
- Tests: `packages/domain/test/meetings/recordingRecovery.test.ts`, `apps/api/test/meetingTranscription.test.ts`, `apps/desktop/test/{recordingImport,integrationsBridge}.test.ts`.

**Interfaces:**
- `authorizeRecordingRecovery(context: RepositoryContext, recordingId: string): Promise<{ recordingId: string; meetingId: string; key: string; sha256: string; sizeBytes: number } | null>` resolves the current association and follows the existing upload authorization rule.
- `completeRecordingRecovery(context: RepositoryContext, input: { recordingId: string; commandId: string }, verify: (key: string) => Promise<RecordingCheck>, binding: UploaderBinding): Promise<'resumed' | 'already_ready' | 'refused'>` validates the fresh receipt/checksum/size and queues the same processing identity.
- New commands: `POST /meetings/recordings/recovery-url` and `/recovery-complete`, with existing command ID/client-version conventions. Never add fields to M4's old strict upload response.
- Desktop operation `recordings.reupload({ recordingId })` performs recovery from a retained local source. `chooseRecordingRecoveryFile(recordingId)` uses the existing picker pattern for a file on another Mac; the renderer never receives arbitrary filesystem access.

- [ ] **Write failing tests.** `expired_source_uses_same_identity` keeps recording ID and paid-attempt count; `wrong_file_does_not_upload` rejects a different digest; `revoked_authority_precedes_local_read` blocks reading after logout/reassignment; `folded_source_uses_original_object_key` respects the stored key; `registered_success_does_not_reupload` leaves a completed transcript alone. Replayed completion and a receipt from another uploader must not create a new recording or bypass binding.
- [ ] **Run** `npm run test --workspace packages/domain -- test/meetings/recordingRecovery.test.ts`; `npm run test --workspace apps/api -- test/meetingTranscription.test.ts`; `npm run test --workspace apps/desktop -- test/recordingImport.test.ts test/integrationsBridge.test.ts` and confirm the intended failures.
- [ ] **Implement recovery.** HEAD the real object before starting paid work. Issue a fresh signed upload receipt for the stored source key, bound to uploader, digest, size and current authority. A successful upload resumes the existing item, not a fresh attempt allowance. Validate ownership before local hashing/reading and again before upload/completion; cancel stale work on identity changes. Persist digest-to-local-file association in the main-process store so a completed import can recover later; restrict automatic recovery to the configured demo folder, and require an explicit picker for any other file.
- [ ] **Carry source-kind metadata.** Derive participant/mixed from M4's `FileRole`, not participant-name parsing; send optional source kind with new registrations. Missing fields from older clients become unknown. Wait until the API supports the new field before publishing that desktop. Keep uncertain timing file-relative; do not add speculative alignment metadata.
- [ ] **Rerun focused tests.** Expected: expired and mismatched source paths produce distinct recoverable/actionable outcomes; another workspace/Mac cannot use an old receipt to read or overwrite content. Existing import and upload restart cases still pass.
- [ ] **Commit** Task 4 files with `feat: recover expired meeting audio uploads`.

### Task 5: transcript UI, integration acceptance and release preparation

**Files:**
- Create `apps/desktop/src/renderer/meetings/MeetingTranscript.tsx` and `apps/desktop/src/renderer/settings/MeetingTranscriptionSection.tsx`.
- Modify `apps/desktop/src/renderer/recordings/FirmRecordings.tsx`, `apps/desktop/src/renderer/settings/CallingCalendarSection.tsx`, `apps/desktop/src/shared/operations.ts`, `apps/desktop/src/main/operationHost.ts`, and the Today review-item path only for a real recovery action.
- Tests: `apps/desktop/test/meetingTranscript.component.test.tsx`, `apps/desktop/test/e2e/meetingTranscriptScreens.spec.ts`, plus existing recordings/settings/access tests.
- Add the feature's operator/acceptance notes to `docs/greenfield/meetings.md`; update the established shared backlog with actual evidence.

**Interfaces:**
- Desktop operation `meetings.transcript({ meetingId, cursor? })` validates `MeetingTranscriptPage` from Task 1; stale identity/read generation cannot update another firm/account's UI.
- `MeetingTranscript({ meetingId }: { meetingId: string })` renders source groups, provisional attribution, relative timestamps, coverage and incremental pagination.
- `MeetingTranscriptionSection()` edits the existing audited setting; exposes enable/allowance and a coverage explanation, without fabricating a credit verification. Runtime remains off after release preparation.

- [ ] **Write failing UI tests.** `partial_meeting_is_not_complete` displays ready/total plus held/missing reason; `late_participant_refreshes_revision` discards the old cursor and refreshes; `repeated_names_stay_distinct` keeps recording IDs separate; `second_click_collapses_transcript` closes the panel; `stale_account_read_is_discarded` prevents content leakage. `zero_allowance_is_clear` explains setup, and `reupload_is_actionable_once` produces one recovery action rather than progress noise in Today. Render script-like transcript strings as inert text.
- [ ] **Run** `npm run test --workspace apps/desktop -- test/meetingTranscript.component.test.tsx test/recordings.component.test.tsx` and verify the missing behavior fails.
- [ ] **Implement the UI.** Keep the firm-page recording/meeting context, plain typography and existing shadcn primitives. The normal path requires no notes/outcome clicks. Show Transcript, coverage and useful errors; settings use dollars/day and separate credit/cash wording. Expand/collapse predictably and preserve Back to Firms/navigation. Group by source/segment with a brief timing caveat; no fabricated interleaving or attendance confirmation.
- [ ] **Verify components and screenshots.** Rerun the focused tests, then `npm run test:e2e --workspace apps/desktop -- --grep 'meeting transcript'`. Inspect ready, partial, unavailable, funding-held and narrow-window screenshots. Fix layout/interaction failures before calling UI complete.
- [ ] **Run the full existing gate once after feature completion.** `npm run gate:greenfield` must pass. With the verified schema-41 baseline still at its recorded commit, run `npm run upgrade:test -- --from 41 --to 42 --base /Users/davidcui824/conductor/scratch/fss-prod --evidence /tmp/callie-m5-upgrade.txt`; adjust both versions/base to the freshly verified release baseline if main has advanced. The harness creates a disposable test database; apply no migration to production here. Run `infra/scripts/offline-gate.sh` for mocked policy tests, and the existing worker-image build workflow; do not redesign release mechanics or publish PR images as a side task.
- [ ] **Perform acceptance where authorized.** A synthetic audio run against real AWS requires verified applicable credits/approved allowance (or a separately approved test budget). Check real upload → register → transcript, replay, hold and re-upload. Separately inspect one user-provided real Zoom recording for the importer assumptions; synthetic media cannot establish the actual account's file layout. Record either passed evidence or the exact unexercised boundary, never substitute mocks for a production claim.
- [ ] **Commit** Task 5 files with `feat: show meeting transcripts and recovery in Callie`. Prepare a feature PR with actual test/rehearsal results and any outstanding activation-only checks; attach the PR to this chat when created. Use one whole-branch review under native execution. Follow the established schema/desktop release procedure, preserving the feature-off setting and existing pauses; activation needs the outstanding funding/allowance confirmation.

## Completion and handoff

Code-complete means the feature, meaningful tests and required local/CI checks pass with a reviewable branch. Shipped means the existing release process confirms the backend and desktop. Enabled means the funding/allowance and real acceptance checks are satisfied and the setting is deliberately switched on. Report these separately.

This plan contains no new subscription, cash authorization, live email activation or Zoom-account configuration. M3's account check and M4's real-recording acceptance can proceed independently when the browser login/recording is available.
