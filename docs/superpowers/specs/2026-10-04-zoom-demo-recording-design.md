# M3: automatic local recording for Callie demos

Status: proposed written design, awaiting David's review. No product code or runtime changes in this revision.

## Intent and agreed constraints

David wants to host demos normally in the Zoom desktop app without remembering to press Record. Callie should arrange local automatic recording for a matched Callie demo, then let the existing recording importer, transcription and follow-through features handle the resulting files. Unrelated meetings must not be selected.

Agreed account: `david@usecallie.com`, Zoom Basic. The **Callie demo recording** Server-to-Server OAuth app exists with only `meeting:read:meeting:admin` and `meeting:update:meeting:admin`; it is inactive. These permissions cover the business account, so Callie must enforce the narrower demo boundary. The saved local recording folder and separate-participant audio setting remain desktop responsibilities.

This is an architectural integration with an external write, not a UI redesign. It reuses the existing worker, PostgreSQL job queue, settings and Secrets Manager. No new service, subscription, Zoom webhook, recording-read scope, cloud recording, automatic attendance or deal movement is included. Sending and metered meeting processing remain controlled by their existing switches.

Success means a current eligible demo has Zoom's local automatic-recording setting read back as enabled, and a real desktop-hosted test produces files that the importer can use. A settings readback alone is not proof that a recording was produced.

## Baseline and the gap

Inspected main `d1d7e844`, schema 44, desktop 1.0.42:

- `packages/domain/meetings/bookingDetails.ts` and `calcom.ts` already retain a Zoom ID, a query-free join URL, booking aliases, organizer and attendee, timing, match and attendance state.
- `apps/worker/src/handlers/calcomReconcile.ts` and the scheduler provide durable background work and existing calendar-routing rules.
- Cal.com events are authenticated and ordered, but a stored Zoom ID or a firm match does not establish the exact demo event type. The current model does not persist that event type.
- `apps/worker/src/calcom/bookingsClient.ts` currently supports the bookings list only. There is no Zoom provider client, runtime credential or automatic-recording job.
- The configured recording folder contained zero files on this inspection. Real-recording acceptance remains outstanding and can proceed independently.

## Chosen approach

Use a worker job that validates the current individual booking with Cal.com, validates its Zoom meeting, changes one setting and reads it back. This adds a dependency on the existing Cal.com API key being usable, which must be verified before activation. It avoids inferring demo identity from titles or adding a second copy of booking provenance to the meetings table.

Alternatives considered: trusting only the stored webhook fields would require additional event-type provenance and careful backfill/freshness handling; manual per-meeting setup remains the fallback. Account-wide recording does not meet the agreed scope.

### Eligibility before a Zoom write

All of these must pass:

1. The integration is enabled and the calendar belongs unambiguously to this workspace. Credentials and explicit configuration exist for the business host and the exact Cal.com demo event type.
2. The Callie meeting is matched to an accessible firm, is `booked` or `rescheduled`, has a current booking UID and a Zoom ID, and starts in the future. Deleted, unlinked, ambiguous, cancelled, ended, held and no-show records do not qualify.
3. A fresh authenticated Cal.com read for that current UID returns one accepted booking. Its authoritative `eventTypeId` equals the configured demo event ID; its host is the business account; its attendee, time window and parsed Zoom ID match Callie's current record. Conflicting duplicate identity fields, arrays/recurring or seated bookings, successor UIDs and missing identity data stop processing rather than being guessed.
4. Zoom reports the same meeting ID and business host, a scheduled non-recurring meeting, no PMI usage, and a start time within 60 seconds of the current booking. Its duration must match the booking's whole-minute duration. Any known second Callie meeting reusing that Zoom ID is an ambiguity, unless already folded into this same meeting.
5. The job's target and settings revision remain current immediately before the external write. No write starts at or after the scheduled start.

Use the observed Cal.com demo event ID during secure setup; never derive it from the slug or invent a value. Existing future bookings may qualify through a fresh provider read; old database rows are not relabelled as demos.

### The provider action

Read `GET /v2/meetings/{id}`. If local automatic recording is already enabled, record that observation without a PATCH. If it is `none`, send only:

```json
{"settings":{"auto_recording":"local"}}
```

Do not send a full meeting object back. Preserve its topic, time, attendees, passcode, waiting room and other settings. If Zoom reports cloud recording or an unknown/locked mode, show manual action needed rather than replacing it. A successful write must be followed by GET readback; a 204 alone is not the final success state.

There is no account-settings call, meeting creation, join operation, browser bot or recording download. David hosts from his desktop app as already agreed.

## Components and state

### Configuration

Add a versioned `meeting_auto_recording` setting, default disabled, with the verified business host email and positive Cal.com demo event ID required to enable it. Keep credentials separate. Settings shows whether the worker recognizes the required Zoom and Cal.com configuration without returning their values.

Add a worker-only Secrets Manager entry `<prefix>/zoom-meetings` containing `account_id`, `client_id` and `client_secret`. Terraform provisions the container, never the value; seed an inert value before ECS starts referring to it. API and desktop do not receive the Zoom secret. Follow the existing heartbeat/configuration reporting pattern for health. The Zoom webhook verification token is neither used nor copied.

### Adapters

- A worker Zoom adapter requests an account-credentials access token, keeps it only in memory until shortly before expiry and exposes narrow `readMeeting` / `setLocalAutoRecording` methods. A 401 permits one token refresh; a PATCH is never blindly retried on an ambiguous network failure.
- Add a separate single-booking Cal.com read using its documented API version `2026-02-25`; do not replace the list endpoint's existing `2026-05-01` version. Parse an allowlist of needed fields and discard the rest.
- Pin HTTPS provider origins, reject redirects, bound request time and response size, and log only internal IDs, status categories and safe error codes. Do not log bodies, authorization headers, passcodes or Zoom host-start URLs.

### Durable work

Use the existing scheduler to consider future meetings within 60 days, at most 20 candidates per pass. Persist one operation per workspace, meeting and target revision. A revision includes current booking UID, Zoom ID, firm/attendee identity, timing and configuration version. Routine notes or unrelated provider events do not create new work.

An additive migration adds the setting key, job kind and a workspace-scoped `meeting_recording_setup` operation table. Keep the target identity, bounded attempt count, next-attempt time, state/reason, pre-write recording mode and last verification time; no raw provider payloads. States are `pending`, `verifying`, `ready`, `manual` and `obsolete`. Table constraints, scoped foreign keys, permissions, deletion cleanup, firm merges and meeting folds are part of the migration's acceptance coverage.

Use the runner's existing external-effect execution path with an operation-specific durable write intent. Mark the attempt before PATCH. A crash or uncertain PATCH outcome returns to readback, not another blind write. Readback finding `local` can settle an unresolved attempt as ready if identity still matches. Readback finding another mode after an ambiguous write requires manual review because a later human edit cannot be distinguished safely.

Checks and safe reads can retry with the existing backoff, respecting Retry-After. Bound an operation to four attempts and two hours from first attempt, or meeting start, whichever comes first. Both elapsed time and attempts are checked by the scheduler, so a handler that crashes before its normal check cannot retry indefinitely. A new target revision or an explicit audited retry may create new work; routine scheduler passes may not reset the deadline.

## Concurrency and lifecycle

Local lock order follows the existing calendar-routing lock, workspace gate, firm, meeting and operation order. Immediately before PATCH, reread the current target, setting, operation ownership and lease under those locks. Keep only the bounded final PATCH inside that critical section; provider validation and token acquisition happen beforehand. A stale worker must not commit a result for a successor operation.

This serializes changes observed by Callie. It cannot atomically lock Cal.com or Zoom: a provider-side cancellation or manual edit can occur between the final read and PATCH. Readback and the next booking event reveal discrepancies; the design must not claim that external race is eliminated.

- A cancellation, unlink or change of Zoom ID makes pending work obsolete. A reschedule creates a new target revision and must be verified again.
- A successful previous setup does not transfer to another Zoom ID or booking revision. A fold preserves history but re-evaluates the survivor; conflicting firm/attendee records never become eligible through a fold.
- Once ready, do not repeatedly force the setting back on. A later manual change in Zoom is respected. Rescheduling the same Zoom ID reads its current setting; a previously applied setting now turned off is shown for manual review rather than re-enabled automatically.
- Turning the integration off stops new writes. It does not undo settings already applied to individual demos. Cancellation does not delete or alter recordings, and Callie does not automatically reset an old meeting's recording mode: that could overwrite a human decision. For a cancelled/replaced meeting where Callie had applied the setting, show a quiet history note that it was previously enabled and may need checking if the old link is reused. Cal.com remains the booking/cancellation owner.
- A late job, missing setting, provider refusal, readback mismatch or manual mode leaves the normal demo usable. The fallback is to press Record in Zoom.

## User experience

Add a small state line to the existing firm-page meeting recording area: **Auto-recording set**, **Setting up auto-recording**, or **Start recording manually**, with a last-checked time and a concise reason on expansion. This is a statement about the meeting setting, not about the existence of a recording. Offer audited Retry only for eligible future meetings.

Settings → Calling & calendar gets an off-by-default **Automatically record Callie demos locally** control with configuration readiness. No persistent status bar, extra Today metrics, new page or dependency on the unanswered M8 tab-layout proposal.

## Verification and rollout

Tests must prove the boundary and real failure cases:

- The correct booking produces the one-field PATCH and verified state; already-local produces no write.
- Non-demo event, other host, missing/mismatched booking, wrong attendee, reused ID, PMI, recurring meeting, cancelled/unmatched/past meeting, cloud recording and missing credentials produce no PATCH.
- Changed targets, disable/cancel races, duplicate jobs, lost lease, folds and merges cannot apply a stale target or incorrectly transfer ready state.
- A crash after PATCH or a readback timeout reconciles without blind duplicate mutation; repeated handler crashes hit the same deadline.
- A manual disable remains respected, and old successes do not suppress valid work on a new Zoom ID.
- Provider errors and malformed/oversized bodies cannot reveal credentials; API keys stay out of desktop/API responses and Terraform state.
- Old desktops tolerate the optional fields; scoped reads, retry authorization, migration upgrade, retention/deletion and visible fallback states pass.

Run focused domain/adapter/worker/API/desktop checks, the repository gate, appropriate populated migration rehearsal, and one independent whole-branch review under the existing delivery workflow. Release with the integration disabled.

Then verify the Cal.com key, exact demo event ID and Zoom credentials through the secure setup path; activate the Zoom app and enable Callie only at controlled acceptance. Use a designated test demo and a non-demo negative control, check readback, start the demo in Zoom desktop and validate generated local files through the importer. Runtime transcription/analysis allowances and the sending pause are separate existing controls; this feature does not change them.

## Sources checked 4 October 2026

- [Zoom meeting API](https://developers.zoom.us/docs/api/meetings/): meeting read/update, granular scopes, host/type/PMI fields and automatic-recording modes.
- [Zoom Server-to-Server OAuth](https://developers.zoom.us/docs/internal-apps/s2s-oauth/): account credentials and token renewal.
- [Cal.com single-booking API](https://cal.com/docs/api-reference/v2/bookings/get-a-booking): current booking identity, event type and endpoint-specific version.
- [Zoom automatic recording](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0067954): local recording and desktop-host behavior.

Account evidence: the prior Zoom setup report and inactive-app screenshot in the Codex workspace's `artifacts/provider-feasibility-2026-10-04/` directory. No account credentials are included in this design.
