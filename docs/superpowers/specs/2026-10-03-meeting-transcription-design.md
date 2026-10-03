# Meeting transcription (M5): design for review

Status: design prepared; no product code, migration, deployed setting or paid transcription has changed.

Baseline: main 48559f4236c5deef1f80af6b8b4a852c6df9cdc1, schema 41, desktop 1.0.39. Working branch: codex/meeting-transcription, in the reused crm-navigation worktree. This spec follows David's approved roadmap and the decision record at /Users/davidcui824/conductor/scratch/callie-shared/DECISIONS.md.

## Purpose and scope

Turn a Callie demo's imported Zoom audio into a readable, attributed transcript that later outcome extraction can cite. Keep the normal path automatic after configuration; ask David only about missing evidence, ambiguous identities or recovery that needs a local file.

M4 already discovers, matches, uploads and registers audio. M5 adds processing and transcript reading. M3's automatic recording setup is independent: manually started recordings can exercise M5. M6 owns meeting summaries and commitments; M7 owns emails and follow-through. M5 sends no email, changes no deal stage and makes no attendance determination.

David's constraints remain: local Zoom recording, audio-only cloud processing, separate participant files preferred, AWS credits where eligible, no silent cash fallback, sending paused and call-suggestion automatic application off. Class recordings stay outside the importer. Existing call budgets and the $25 additional-cash ceiling stay unchanged.

## Approach

Use a meeting-specific domain flow and AWS adapter on the existing Postgres job runner, S3 bucket and provider-reservation ledger. One imported audio file is the durable processing unit. A meeting read assembles available file transcripts and explicitly reports incomplete coverage.

Alternatives considered:

| Approach | Decision |
|---|---|
| Process the separate participant files and preserve source attribution | Selected: matches the configured Zoom recording mode, supports more than two people and keeps each quote traceable to a source file. |
| Transcribe one mixed recording with diarization | Supported only when the import actually contains mixed audio; speaker labels remain provisional. It is not a silent cost-driven substitution for existing participant files. |
| Generalize the Twilio two-channel pipeline into one universal media engine | Defer. Reuse small provider/job/accounting primitives without restructuring the stable call flow. |

AWS batch transcription accepts M4A and supports mono/two-channel media, not arbitrary multi-channel files. Separate files avoid pretending that an N-person meeting is one two-channel call. Sources: https://docs.aws.amazon.com/transcribe/latest/dg/how-input.html and https://docs.aws.amazon.com/transcribe/latest/dg/diarization.html.

## Existing integration points

- packages/domain/meetings/recordings.ts: registerMeetingRecordings stores uploaded files; the M5 enqueue hook is currently empty.
- packages/domain/db/migrations/0041_meeting_recordings.sql: unique recording identity is workspace + meeting + source SHA-256; uploaded/transcribing/transcribed/failed states already exist.
- apps/desktop/src/main/recordings/importer.ts: completed entries currently stop scanning their upload state. Expired-source recovery needs an explicit server request, not an assumption that rediscovery will re-upload.
- apps/worker/src/handlers/callTranscribe.ts and packages/domain/calls/transcription.ts: examples for chunked paid work, durable provider job names, bounded collection and reservations. Do not copy the Twilio/session assumptions.
- apps/worker/src/transcription/awsTranscribeClient.ts: existing pricing and SDK configuration; its result parser requires two channels and cannot parse meeting files unchanged.
- infra/modules/cluster/main.tf: worker can currently read meetings/* but can write transcription output only under calls/*. M5 needs narrowly scoped meeting-processing/output permissions.
- packages/domain/retention/deletion.ts and coverage.ts: new content and job state must follow existing deletion and retention behavior.

## Data and processing

Add a new migration after rechecking current main. Do not edit the deployed 0041 migration.

The recording remains the identity. Add persisted processing details and a bounded transcript record with a foreign key to that recording. Store provider attempts separately, tied to the existing provider reservation ledger. Required facts include source digest, current meeting association, processing revision, preparation result/duration, provider job name, input/output keys, reservation, next check/deadline, terminal reason and transcript version.

New imports carry an explicit source kind: participant, mixed or unknown, based on the importer's selected source layout rather than the participant's name. Old records are unknown and use provisional diarization, like mixed audio. A display label from Zoom remains source metadata, not a verified host/prospect identity. Preserve the original digest identity during preparation and re-upload.

Registering a new file and enqueueing its meeting.transcribe work happen in one transaction. Repeated registration finds the existing row and job. Existing uploaded rows become eligible through a bounded scheduler scan only after meeting transcription is explicitly configured; enabling the feature must not create an unbounded burst.

The worker flow is:

1. Read current association, authorization-relevant state, setting, funding status and source availability. A deleted/unmatched/cancelled meeting cannot start new paid work. No provider request occurs while configuration is disabled or incomplete.
2. Prepare and validate the audio with bounded resource use. Measure the actual submitted duration before reserving spend. An invalid/oversized file gets an actionable failure without a paid request.
3. Reserve the file attempt under the workspace's meeting-transcription daily lock, reusing provider_reservations and its settlement rules. Commit the deterministic provider job identity before requesting AWS work.
4. Immediately before StartTranscriptionJob, recheck the setting, reservation and current meeting association. Use one SDK attempt. A timeout or lost response triggers collection by the same job name, not a new paid job.
5. Collect through short job claims, backoff and a persisted 120-minute deadline. The scheduler also resolves a check-up job that repeatedly crashes before executing. Collect already-started work after disablement without starting new work.
6. Validate and store the bounded transcript and settle once. Failed or ambiguous paid outcomes remain accounted for. No transcript text, labels, signed URLs or audio enter ordinary logs or job payloads.

Use at most two automatic paid attempts per recording. Re-uploading the same bytes, changing a parser/processing version, moving a meeting through a fold, or restarting a worker does not reset that allowance. A retry requiring fresh spend must pass the current budget again. An explicit paid reprocessing feature is outside this slice.

## Audio preparation

Use a bounded FFmpeg/ffprobe-based preparation adapter in the worker image instead of growing the handwritten desktop container parser into a duration/decoding engine. Use the distribution's packaged tools, record their versions, and validate their output using generated test media. No new service is introduced.

Read only the authorized S3 object into a private temporary directory, bounded by the existing 300 MiB file limit. Invoke tools with argument arrays, file/pipe-only protocol access, no shell evaluation and a two-minute process deadline. Decode to mono audio for a participant file, or the mixed recording for diarization, preserving its sample-relative timing. Bound decoding to the existing four-hour transcription maximum; detect and refuse longer input instead of silently truncating it. Bound the prepared output to 300 MiB as well. Temporary files are removed on success and failure.

Price the measured audio submitted to AWS, including the provider's per-request minimum. Never trust a client-supplied duration or the booking's scheduled duration for paid-work authorization. Do not truncate audio merely to fit today's budget. A file that cannot fit is held with the reason visible.

## Timing and attribution

Each utterance includes recording ID, transcript version, file-relative start/end milliseconds, text and speaker attribution provenance. Provider speaker labels on mixed audio are local to that recording, not cross-file identities.

M4's segment number and file creation times do not prove common audio time zero. When alignment is not established by reliable recording metadata or acceptance evidence, show transcripts grouped by source/segment with relative timestamps and a quiet timing-unverified indication. Do not interleave them into a fabricated conversation chronology. Do not infer that a display name proves a non-host participant attended.

A meeting transcript view reports how many known recordings are ready, held, failed or unavailable. New recordings increment the source-set revision. M6 must consume that revision and coverage status so a later-arriving file cannot silently leave a supposedly complete summary unchanged. Completion means all currently known files are accounted for, not a guarantee that Zoom captured the entire meeting.

## One-day expiry and recovery

The existing one-day S3 lifecycle remains. Store durable transcripts in Postgres under the meeting's access/retention rules; temporary source, prepared media and provider JSON expire in the private bucket.

Before starting work, check the actual source object. Missing source becomes needs re-upload; its metadata/digest does not count as audio availability. Recovery issues a new authorized upload receipt for the same recording and digest, rechecks checksum/size/uploader binding, and resumes its processing revision without creating a second recording or resetting paid-attempt limits.

The desktop shows Re-upload when the source is still available in the configured folder. It rechecks account, current firm/meeting authority and file identity before reading or hashing. A different Mac offers manual file selection for the expected digest. A changed source is a new recording, never silently substituted. An already persisted successful transcript never triggers re-upload only because its original audio expired.

Also handle missing provider output after collection delays. Do not call that success or repeatedly buy new jobs; surface the bounded retry/recovery state and its spend consequence.

## Settings, funding and price evidence

Add a meeting_transcription setting separate from call_transcription. Default disabled with a zero daily allowance. Neither migration nor deploy enables it or writes the proposed $0.50 allowance. The existing call cap and monthly cash ceiling are unchanged.

The proposed meeting allowance is $0.50/day funded by eligible AWS credits, with the day determined by the workspace's business timezone. It remains a user decision before activation. Use an audited funding verification record (account, covered service, evidence reference, verification date, validity end and status) for new meeting work. Credit expiry or a recorded exhaustion/revocation invalidates it; it is evidence of coverage terms, not a promise of real-time credit balance. If coverage is unverified or no longer valid, hold new meeting work; do not automatically relabel it credit-funded because the provider is AWS, and do not fall back to cash. Collection and accounting of already-started jobs continue.

Read-only evidence gathered on 3 Oct:

- The current US East (N. Virginia) price list, published 11 Sep 2026, lists operation TranscribeAudio, SKU XG5JYDUXJ2JRGBD9, at $0.0001/second = $0.006/minute, range 0 to infinity. Source: https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/transcribe/20260911124646/us-east-1/index.json.
- Two full 20-minute participant tracks therefore have $0.24 of base transcription charges before request rounding/storage. This is a public price, not proof of credit coverage.
- Cost Explorer filtered to Amazon Transcribe for 1 Sep through 2 Oct returned no September usage and estimated October Usage of $0, with no Credit row. This does not establish whether credits will cover future meeting charges.

Persist the price used on each reservation. A later configuration or price change cannot rewrite the accounting basis of an already-started attempt. Use the same business timezone and cent-rounding conventions as the existing ledger, and show gross credit usage separately from cash.

## Reads, access and UI

Add an authorized meeting transcript read, accessible to the firm's assignee or workspace administrator. Follow existing not-found behavior for inaccessible meetings. Do not leak whether another workspace's recording exists.

Extend the existing meeting/recording panel with a Transcript action and quiet progress/coverage text. Keep details out of the Today calling queue except an actionable recovery item. Render provider text as text, with bounded pagination and stable transcript/utterance identifiers. There are no new mandatory notes or outcome forms.

Expose a plain explanation for disabled, awaiting allowance/credit verification, daily limit reached, processing, partial, ready, source expired and failed states. Keep existing clients compatible through additive fields; use the established minimum-client process if a strict existing contract must change. Never make older clients parse an unknown recording state as success.

Meeting folds preserve recording/transcript identities and accounting. Late provider completions resolve the recording's current association before storing content. A deletion cancels or neutralizes pending work and prevents late responses from recreating content. Sanitized provider accounting can remain as existing retention policy allows; speech and speaker labels follow the deleted subject.

## Verification and release

Meaningful tests must cover:

1. Per-participant, mixed, silent and malformed media; resource/duration limits; punctuation and unknown speakers; multiple segments with unverified timing.
2. Duplicate register/replay, concurrent claims, lost Start response and worker restart produce one accepted transcript and no duplicate paid job.
3. Disabled configuration, unverified funding and concurrent budget exhaustion prevent new paid requests; a mid-preparation disable is honored at dispatch; existing jobs still collect.
4. Expired source, expired output, correct and incorrect re-upload digests, lost local file and duplicate recovery do not lose identity or reset attempts.
5. Cross-workspace/assignee reads, revoked access during recovery, meeting fold/deletion/cancellation and late completion preserve authorization and retention behavior.
6. Partial results and new source-set revisions remain visible; filename labels are never promoted to confirmed attendance.
7. Real Postgres migration/upgrade checks, worker/API/desktop tests, narrow IAM/rehearsal checks and a small synthetic-media AWS test before claiming the pipeline works in production. Paid validation waits for verified funding/allowance or a separately authorized test budget.

The real-recording importer acceptance remains outstanding and can run when David provides a test recording. Synthetic fixtures do not prove this account's actual Zoom folder layout or alignment assumptions.

Release using the existing schema and desktop process. Keep meeting transcription disabled after deployment until the funding/allowance and acceptance gates are met. M5 completion does not lift email sending, enable call-suggestion automation, enable account-wide recording, or move deals.

## Implementation boundaries after design review

1. Schema/contracts, source-kind metadata, settings and transcript reads.
2. Bounded audio preparation and AWS meeting adapter.
3. Reservation/job/collection flow and bounded resume source.
4. Expiry/re-upload recovery across API and desktop.
5. Transcript/coverage UI, retention/folds, integration verification and release preparation.

Each task should have a focused test/review boundary. Keep these changes in the meeting slice; avoid unrelated call-engine refactors, release-system rewrites and new infrastructure services.
