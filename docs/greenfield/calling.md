# Calling: a Twilio call from Callie, authorised per call

Call-to-booking slice W (migration 0028). Callie can place a recorded call from the
Mac through Twilio Voice instead of handing the number to the phone (`tel:`). The
number is never sent to the Mac: the Mac asks the API for a **call session**, hands
its id to the Twilio Voice SDK, and Twilio asks the API what to dial. The API answers
only after re-taking the whole dial decision at that moment.

Off by default. With the switch off, every route below answers 404 and nothing reads
the Twilio secret.

## The switch and the settings

Four workspace settings, versioned and audited like the others
(`packages/contracts/src/settings.ts`, `INTEGRATION_SETTING_KEYS`). They are written
with `POST /settings/update` and are deliberately **not** in the `GET /settings`
snapshot, because installed desktops parse that snapshot with a strict key list.

**David turns these on in Settings → Calling & calendar** (slice S1,
`apps/desktop/src/renderer/settings/CallingCalendarSection.tsx`): the in-app calling
switch, the daily budget in dollars (0 to 100, kept as cents; the longest call is under
"Advanced"), the voicemail script, and the Cal.com switch. The section reads
`GET /settings/integrations` (any signed-in member; the Mac asks only for an admin), which
answers the four values, `spentTodayCents` (today's settled plus reserved `twilio.voice`
cost, on the day boundary the budget check uses) and, for each integration, whether its
credentials are in place: `{ ok, missing }`, where `missing` holds field **names** only
(`auth_token`), never a value, length or prefix. The section itself does not list the
names; it says the account is not set up. Calling cannot be switched on while
credentials are missing or the ceiling is 0, and can always be switched off. Only an
admin may write these keys (`admin_only` for anyone else, the same rule as every setting).

| Key | Value | Default |
|---|---|---|
| `calling_provider` | `{"provider": "tel" \| "twilio"}` | `tel` |
| `telephony_budget` | `{"dailyCeilingCents": 0..10000, "maxMinutesPerCall": 1..240, "unitPriceMicros": ...}` | ceiling 0, 30 minutes, 14000 micro-dollars a minute |
| `calendar_integration` | see [meetings.md](meetings.md) | `off` |
| `voicemail_script` | `{"template": 1..2000 characters}` | `DEFAULT_VOICEMAIL_SCRIPT` |

A ceiling of 0 means telephony is disabled: every session is refused with
`telephony_budget_disabled`. Turning calling on therefore takes two writes, the
provider and a ceiling.

## One call, end to end

1. **`POST /calls/access-token`** (signed-in session) mints a Twilio Voice access
   token for `client:<userId>`, valid for an hour, carrying only the identity and the
   TwiML application's outgoing grant. It can place nothing by itself.
2. **`POST /calls/session`** `{firmId, contactId?, routeId, routeVersion, callingIdentityId}`
   is a policy command (`create_call_session`). In order it refuses:
   * the calling cadence (slice C1, below): `call_attempts_exhausted` (the firm is
     parked for review), `call_attempt_today`, `call_attempt_too_soon`;
   * `caller_id_mismatch`: the calling identity's number is not the configured
     Twilio caller id;
   * `telephony_budget_disabled` / `telephony_budget_exhausted`: today's telephony
     spend plus open reservations plus this call's maximum would pass the ceiling;
   * every refusal of the ordinary dial authorisation (window, posture, suppression,
     holds, route version).
   On success it writes a dial ticket, a `provider_reservations` row (subject
   `call_session`, priced by the minute for `maxMinutesPerCall`) and the session, and
   returns `{sessionId, expiresAt}` (60 seconds). No number.
3. The Mac connects with the token and the parameter `sessionId`. Twilio posts to
   **`/integrations/twilio/voice`**. The API verifies the signature, the account and the
   application, then, in one transaction, locks the session, checks it is unconsumed,
   unexpired and for the same `client:` identity whose membership is still active,
   consumes the dial ticket (which re-runs the dial decision), marks the reservation
   `calling` and answers `<Dial record="record-from-answer-dual" timeLimit=...>` to
   the number. Any refusal is heard as "This call was not authorized, and it has not
   been placed." and nothing is dialled.
4. **`/integrations/twilio/status`** (the `<Number>` status callback and the `<Dial>`
   action) moves the session forward only: ringing, in progress, then completed,
   failed or canceled. `busy` and `no-answer` count as completed calls that did not
   connect. On the terminal status the reservation is settled with Twilio's price when
   the callback carries one, or estimated from the duration (whole minutes times the
   unit price).
5. **`/integrations/twilio/recording`** keeps the recording SID, duration and the URL
   *path* (never a signed URL), and queues the call's transcription when it qualifies
   (slice C2, [Transcription](#transcription-slice-c2) below).
6. The salesperson logs the outcome with `POST /calls/log` as before, adding
   `callSessionId`; the log is linked to the session. The Mac adds it itself: the
   outcome recorded next for the same firm and number names the session.

`sweepCallSessionReservations` releases the reservation of a session that expired
unused and estimates one whose call outlived its maximum by 15 minutes with no final
callback. It is a domain function, and the worker runs it: `telephony.sweep`
(`apps/worker/src/handlers/telephonySweep.ts`, registered and sourced in
`apps/worker/src/bootstrap/main.ts`) is enqueued each quarter hour for every workspace
that owes a sweep, keyed `telephony-sweep:{workspace}:{quarter hour}`.

## Signature verification

Twilio signs `X-Twilio-Signature` = base64 HMAC-SHA1, keyed by the auth token, over
the full URL followed by each form parameter name and value in name order. The URL is
**the configured public origin (`FSS_PUBLIC_ORIGIN`) plus the request path and query**:
the `Host` and `X-Forwarded-*` headers are never used, so a request replayed against
another host name does not verify. The body must be
`application/x-www-form-urlencoded`, at most 64 KiB, with no repeated names. The
comparison is constant-time. A callback for an unknown call SID is logged and answered
with an empty `<Response/>`.

## The secret

Secrets Manager entry `<prefix>/twilio-voice`, injected into the API task as the
variable `twilio-voice` (and, since slice C2, into the worker's, which reads only the
account and API key fields, to fetch a recording for transcription), one JSON object:

```json
{
  "account_sid": "AC...",
  "api_key_sid": "SK...",
  "api_key_secret": "...",
  "twiml_app_sid": "AP...",
  "auth_token": "...",
  "caller_id_e164": "+1..."
}
```

A missing or misshapen field makes the whole entry "not configured": the routes answer
503 and log `integration_unconfigured`, and the deployment description at start-up
reports `twilio_voice_config` by field *name*, never by value.

**ECS refuses to start a task whose `secrets` block names an entry that has no
value.** Put a value in the entry before the apply that adds it to the API task:
`{}` is enough, and reads as "not configured".

Twilio console: the TwiML application's Voice URL is
`<public origin>/integrations/twilio/voice` (POST). The status and recording callback
URLs are written into the TwiML by the API and need no console setting.

The call ledger is `provider_reservations` (`provider_key = 'twilio.voice'`) with
`call_sessions`; both are removed with the workspace on deletion.

## In-app calling on the Mac (slice C1)

With `calling_provider = twilio` the Today card's Call button places the call from
Callie: David talks through the Mac's microphone and headphones, and the prospect sees
his verified personal number (the calling identity) as the caller ID. No number is
bought and nothing bridges through his cellphone. With the switch off (`/calls/calling`
answers `not_found`) the Call button is the `tel:` handoff exactly as before. **Only that
answer selects `tel:`**: while the read is pending the button is disabled with "Checking
how to place calls…", and on a 503, no answer or another refusal with "Calling is
unavailable right now." — an untracked phone-app call would bypass the session, the
cadence and the budget.

1. Opening a card reads **`GET /calls/calling?firmId=`** (404 while the switch is off,
   which the Mac reads as `tel`): the cadence ("Attempt N of 4", or parked), the
   voicemail template, the caller's name and their own verified number.
2. Call: the main process (`todayBridge.ts`, `startCall`) reads the cadence again, then
   `POST /calls/session` with the open card's route, version and calling identity, then
   `POST /calls/access-token`. The page is handed the session id and the Voice token —
   never the number — and the Voice SDK's `Device.connect` sends `{ sessionId }` and
   nothing else.
3. The call view, under the announcement (`CALL_ANNOUNCEMENT`): ringing, connected with
   a timer, mute, hang up. `<Dial answerOnBridge="true">` keeps the Mac's call ringing
   until the prospect answers, so the timer starts at the answer. On attempts 1 and 4
   the rendered voicemail script is shown; `voicemail_left` stays an outcome David records.
4. The call ends; the outcome form says the call is filed with its recording, and
   `/calls/log` carries `callSessionId`.

A refusal is a sentence from `reasonSentence` (`packages/contracts/src/reasonText.ts`),
the one map for dial and call-session refusals alike; the budget one reads "Calling
paused: today’s calling budget is used.". A microphone macOS
refused says where to allow it (System Settings → Privacy & Security → Microphone).

**Callbacks ring David's cellphone.** The caller ID is his own number, so a prospect who
calls back calls him. The access token has no incoming grant, nothing forwards, and
Callie keeps no voicemail box.

### The cadence

Decided in `createCallSession` (`readCallCadence`, `packages/domain/calls/sessions.ts`):

* **every placed (consumed) session is an attempt from the moment it is consumed**, and
  stays an unanswered attempt in the 14-day history until an outcome that says somebody
  was reached (below) is recorded; a call that rang out, reached a machine, failed or was
  never classified counts, and nothing expires it but the window;
* at most **4** in one **14-day window** `(t − 14 days, t]`; at most **one per business day** on the firm's clock, and
  the next at least **2 hours** of the clock from the previous attempt's time of day,
  measured from every counted session (the calling window itself is `authorizeDial`'s);
* the count starts again after a recorded `interested`, `referral_or_wrong_person`,
  `callback_requested`, `not_interested` or `do_not_call` (any call log, placed from
  Callie or not), and after a parked firm is resumed. A `callback_requested` outcome's
  callback is the next action, as it always was (the callback task on Today);
* the same cadence is read again at consumption, after slice W's shared send gate and
  the firm row lock (`consumeCallSession`), so sessions created together cannot all be
  placed; it counts every call placed up to `clock_timestamp()` read after those locks,
  not the transaction's start, so a call another consumption committed while this one
  waited is counted. A refusal there is heard as the generic TwiML sentence;
* the firm is **parked when its fourth attempt is recorded unanswered** — an outcome of
  `no_answer`, `busy` or `voicemail_left` (`logCallOutcome`), or Twilio's final
  no-answer/busy with no outcome yet (`recordCallStatus`) — through `parkIfCadenceSpent`,
  which takes the send gate before it looks for an open hold and counts the window that
  ends at the firm's latest placed call, kept as text at the database's microseconds (a
  late classification of an old call cannot park a firm whose attempts never fell four
  in one window). A no-answer/busy callback takes the gate and the firm row before the
  session row, the order consumption and Log outcome use; one whose SID the unlocked
  lookup does not find is answered as an unknown SID, without locking anything. A call request that finds
  the limit reached and no hold parks it only after `authorizeDial` accepts the caller,
  firm, route and identity; a refused request writes nothing. The hold is firm-scoped
  `scoped_pause` on `dial_authorization`, source `call_cadence_parked`, recovery
  `resume_after_review`. While it is open every dial of
  the firm, `tel:` included, is refused `scoped_pause` ("Calling is paused for this firm.
  Resume it when you are ready."). **`POST /calls/cadence/resume`** `{firmId}` ("Resume
  calling" on the card) releases it, and its release instant starts the count again; the
  Mac then reads the card's dial advice again.

### "Do not call": what it stops (migration 0037)

David, 2 October 2026 (P1): "Do not call" stops phone calls only; an explicit "don't
contact me again" stops both channels; keeping e-mail open grants no permission (a
`do_not_call` log is not a reached outcome, so it carries no agreement). The outcome form
and the after-call suggestions offer one four-way choice, sent as
`doNotCall: { scope, channel }` on `POST /calls/log` and in Apply's `edits.outcome`:

| Choice | `doNotCall` | Stops written |
|---|---|---|
| Calls to this person (default; absent means this) | `{ contact, phone }` | the dialled number, `phone` |
| All contact with this person | `{ contact, all }` | the dialled number, `all` |
| Calls to anyone at this firm | `{ firm, phone }` | the number, `phone`; the firm, `phone` |
| All contact with this firm | `{ firm, all }` | the number, `all`; the firm, `all` |

A stop on a number covers the person who holds it: dialling refuses that number and their
other numbers, and an `all` stop also refuses e-mail to their addresses. The installed
1.0.29 sends `doNotCallCoversAllContact` instead, which keeps its label's meaning: the
number for calls and the firm for everything. Needs review's firm stop offers "Stop calls to
this firm" (firm, `phone`) beside "Stop all contact with this firm" (firm, `all`). The firm
page shows "Email stopped", "Calls stopped" or "All contact stopped" on the firm and each
contact (`POST /crm/firm-page` with `include: ['stops']`). `docs/greenfield/suppression.md`
has the whole table of which stop blocks which action.

The outcome form records one call, resolved when it opens: a Needs review item's session, or
"the call just placed", which is the firm's last call as the main process holds it (its number,
person and, when Callie placed it, its session). Every field of the form, the stop choice
included, and the live call's note are kept under that call (`today:outcome:<firm>:<session or
none>:`), so another call at the same firm never inherits them; calls handed to the phone app
carry no session and share `none`. The form clears that call's fields, by key, only when the
server says the call was recorded: a refusal leaves the form as it was, and a lost answer locks it
and offers "Record again". The request names the resolved call and carries the form's own command
id, and the main process forwards such a request as it is, so "Record again" is byte for byte the
same request and the server answers it from its receipt. After recording the call just placed the
form stays open on no call, and takes the next call placed only while nothing is typed there. A
Needs review stop's answer is kept by item and waits beside it after David moves on; a late
success closes the confirm that sent it only if he has not touched the editors since.

### Correcting a logged outcome (slice S3X, lane X2)

David decided P3 and P4 on 2 October 2026. No migration and no new table: the outcome is
updated in place under the call log's row lock (with the agreement columns in the same
statement when the agreement is undone, so `call_logs_agreement_needs_interest` holds), and
each correction appends one `audit_events` row, `call.outcome_corrected` (subject the log), with
`{revision, from, to, reason, callSessionId, agreementCleared, decisions, applied, liftChosen}`.
The `call.logged` row and the log's own actor and time keep what was recorded first. Every
reader that derives from the outcome (cadence, dashboard, consent, Apply's callback choice,
Needs review, history) follows with no change; `scheduleCallbackForCall` re-reads the log after
the firm's lock, so a schedule that waited behind a correction refuses `call_log_unknown`.

- **`GET /calls?firmId=`** lists every log of the firm from the database alone (no provider
  gate), with `direction`, `durationSeconds` and `callSessionId`; `include=corrections` adds
  `corrections: [{from, to, at, byUserId, reason}]`. `/calls/history` is unchanged.
- **`POST /calls/logs/correction-preview {callLogId, outcome}`** (a read): the effects the
  correction meets, each `{kind, id, state, conflicts, decisions, appliedKey, facts}`,
  `outcomeAppliedKey`, `callbackTimeRequired` and the "Also happens" codes.
- **`POST /calls/logs/correct`** (a command with a receipt): `{callLogId, expectedOutcome,
  outcome, reason?, doNotCall?, callback?, effects: [{kind, id, state, decision}]}`, with
  `effects` exactly the conflicting set. Atomic: an inner refusal writes nothing.

| Effect | Found by | Conflicts when the new outcome… | Keep | Undo |
|---|---|---|---|---|
| Callback (open) | `callbacks.call_log_id` | is not `callback_requested` | stays | `cancelCallback` (`cancelled`, audited) |
| Call task (open) | `call_tasks.call_session_id` = the log's session | reached nobody | stays | `cancelCallTask` (audited) |
| Stop | `<command>:handle`/`:firm`, or an earlier correction's `applied.suppressionEventIds`; not directly superseded | is not `do_not_call` | Keep stop | **Lift stop…**: lifts nothing here; returned in `liftNext` |
| Permission (unrevoked) | `follow_up_permissions.call_log_id` | reached nobody | not offered | revoke; stop its live enrollment (`admin_stop`) |
| Agreement alone | the log's `agreed_*`, no unrevoked permission | reached nobody | not offered | cleared by the UPDATE |
| Automatic park | open `call_cadence_parked` hold at the firm (not the analysis's) | leaves `readCallCadence` with the override below the limit | stays | released, audited `call.cadence_resumed` |
| Retired number | the log's route, old outcome `wrong_number` | is not `wrong_number` | the only choice | — (re-add it in Basics) |

The analysis's "pause calling", a deal opened from the call, manual mode, ended enrollments
and the applied step are never changed. The new outcome's own meaning is applied as
`logCallOutcome` applies it: manual mode for an engaged outcome, the stop a `do_not_call`
names (`<correction command>:handle|:firm`), the retired route for `wrong_number`, the park if
an unanswered outcome spends the cadence, and for `callback_requested` the callback (required
when the log already had one or its needs-a-time task was fulfilled) or the needs-a-time task
back on Today (`reopenCancelledTodayItem` reopens a row an earlier refresh cancelled).

Refusals, in order: `invalid_input`, `call_log_unknown`, `not_assigned` / `not_call_actor`,
`stale_outcome`, `outcome_unchanged`, `outcome_not_correctable` (an incoming call to an
unanswered outcome), `route_not_named`, `effects_changed`, `reason_required` (a reason given
when not required is `invalid_input`), `stop_needs_admin`, `callback_time_required` /
`callback_instant_mismatch`, and the 503 of a lost journal write for a correction to
`do_not_call`.

**A correction never lifts a stop.** After it saves, the Mac opens the existing single-stop
lift for each stop marked "Lift stop…" as its own confirm (`POST /suppressions/supersede`,
reason `correction`, admin only). Cancelling or a failed lift leaves the stop in place.

**The reason and the trial (P4).** Apply records `detail.effectIds` on each applied
`call.proposal_decided` row. An effect came from a suggestion only if its exact id is there; an
older row without `effectIds` gives the outcome alone. The reason (`original_error` or
`new_information`) is required iff the outcome has an applied key, or David chose Undo or Lift
stop… on an effect that has one. For each distinct `(analysisId, key)` contradicted, the
correction appends one `call.proposal_corrected` row; the decision row is never rewritten, so
`/calls/proposals/acceptance` is unchanged and the trial counts the pair once.

**Lock order:** Today (shared) → the send gate → the dialled route (`FOR UPDATE`, only for a
new `wrong_number` or `do_not_call`) → the firm → `call_analysis:<session>` → the session row →
the call log row → effect rows: Apply's prefix plus the log.

**On the Mac**, "Change" sits beside the outcome on the firm page's call history (which also
shows every log no session row shows), in Today's previous interactions and on the after-call
"Logged:" line. One compact review: nothing preselected, unaffected effects collapsed, the
reason shown exactly when needed, Save once. The draft is kept under `correct:<logId>:…` and
dropped with "Changed elsewhere" if the outcome moved; the command, its answer and the pending
lift confirms live in the session's kept store by log id, and a lost answer offers Retry, which
resends the same request under the same command id.

### Recordings

`<Dial record="record-from-answer-dual">` records every call. **`GET /calls/history?firmId=`**
lists the firm's placed calls with duration and whether a recording exists (no number,
no URL). **`GET /calls/recording?sessionId=`** reads the audio from Twilio's REST API
(`https://api.twilio.com` + the stored path + `.mp3`, basic auth with the `twilio-voice`
secret's API key) and answers `{ sessionId, contentType, audioBase64 }`. Only paths of
this account's recordings are fetched, at most 40 MiB. Both are the assigned
salesperson's or an admin's; another firm's or workspace's session is 404 and Twilio is
not asked. The bytes travel as base64 in JSON because every route of this API and every
read of the Mac's client is JSON; the Mac plays them from a `blob:` URL through an
`<audio>` element (memory about the compressed size) and revokes the URL when playback
stops, ends or leaves the screen. The call history is on the firm page
(`apps/desktop/src/renderer/calling/CallHistory.tsx`, placed in `FirmPage.tsx`).

### Transcription (slice C2)

After a connected call of at least **20 seconds** Callie transcribes its recording and
shows the transcript, with two speakers, under the call in the firm page's call history.
Migration 0030 adds `call_transcripts` (one row per call session: provider, model,
language, duration, and the utterances as `{speaker, start, end, text}`), deleted with
the session, the firm or the person (a transcript is personal data).

**Off until David turns it on.** Setting `call_transcription` =
`{ "enabled": bool, "dailyCeilingCents": 0..500, "unitPriceMicros": ... }`, default off, $0 a
day, 4 300 micro-dollars a minute. It is an integration key like the four above: not in the
`GET /settings` snapshot; `GET /settings/integrations?include=transcription` answers it
with `{ setting, configured: {ok, missing}, spentTodayCents }` (only when asked for, because
a desktop built with slice S1 parses that answer strictly). Settings → Calling & calendar
has "Transcribe calls" (on/off) and "Daily transcription budget" in dollars; both are
disabled, with a sentence, while the key is missing (no live worker says it can
transcribe), and the switch stays off while the budget is $0.

**Which calls.** The final recording callback (`RecordingStatus=completed`, or none)
queues `call.transcribe` in its own transaction only when transcription is enabled with a
ceiling above 0, the key is in place, the call was **answered** (`answered_at` set) and the
recording lasts **at least 20 seconds**. A short or unanswered call is never transcribed
and never reaches a provider. The job is keyed `call-transcribe:{session}`.

**The primary provider since slice C3a (1 October 2026): Amazon Transcribe.** Standard
batch, en-US, `ChannelIdentification` on, paid from AWS credits (the account has an
AI-services opt-out policy). `apps/worker/src/transcription/awsTranscribeClient.ts`, selected
by `FSS_TRANSCRIPTION_PROVIDER=aws_transcribe` (both roots set it); no secret, the worker's
task role is the credential. In chunk 3, nothing waits for Transcribe, and no request runs inside a long transaction (slice C3a; reviews C3-R1 and C3-F). The first commit records the job's names in `transcription_provider_jobs` (`submitting`) before anything is sent. The next chunk puts the bounded recording in the private call-audio bucket at `calls/<session>/attempt-<n>.mp3`, does the final settings read (the pause boundary, with nothing between it and the request), and sends `StartTranscriptionJob` as `<prefix>-<session>-a<n>`, with its output written to the same bucket at `calls/<session>/attempt-<n>.json`. The client makes exactly one attempt (`maxAttempts: 1`), and `started` is committed right after. The task role may start a job only with that bucket and a `calls/` key as its output. The `call-transcribe-collect` source starts one `call.transcribe` per look at each recorded job that is due one, keyed `call-transcribe-collect:<row id>:<look>`. Each look is one status read and at most one S3 read of the output object, then the commit, about 40 s of a 240 s lease. Looks are spaced 20 s, then doubling up to 5 min. The source schedules each job's next look when it emits one, in the scheduler pass's transaction, so a look job that dies never blocks that job's next look or the 50-job window. The collector is the Transcribe adapter whenever the bucket is configured, whichever provider new attempts use, and even without the Deepgram key or the Twilio recording credentials: such a worker registers `call.transcribe` collect-only, and its heartbeat does not say it can transcribe, so the API queues no new attempts for it. A claim that is not continuing its own cursor collects first, so a crash or a lost lease after Start resumes collecting the recorded job instead of buying another. Completed: the transcript is stored and the attempt settled once, by id, at its reservation. FAILED, a refused Start, or no answer within 120 minutes: terminal, and no later claim buys another for the call. No such job (the request never left), or an output that is missing or unreadable: estimated, and retried once within the two paid attempts. Nothing is deleted at AWS and nothing is owed: the bucket's one-day lifecycle expires the audio and the transcript, no transcript is kept in service-managed storage, and `DeleteTranscriptionJob` is not used. When a call is deleted, the deletion workflow deletes its objects after its commit, best effort and detached from the answer: each delete is bounded at 5 s and all of them at 20 s.
The call-audio bucket (`infra/modules/recordings`) blocks all four kinds of public access,
uses SSE-S3 (AES256), refuses non-TLS requests, is unversioned, and expires every object
after one day.
Priced at $0.0001 a second ($0.006 a minute) by the started minute of the bound; the job
reports no media duration, so the attempt **settles at its reservation**.

**Channels, not diarization.** `<Dial record="record-from-answer-dual">` puts the parent call
in the first channel (https://www.twilio.com/docs/voice/twiml/dial), and the parent is the
Mac's Voice SDK leg, so channel 0 is David and channel 1 the prospect
(`RECORDING_CHANNEL_ROLES` in `packages/contracts/src/callSessions.ts`, the one place that
mapping is written). Both adapters label each utterance by its channel; Deepgram now asks for
`multichannel=true` instead of `diarize=true`, and a diarizer's speaker number never becomes
a role. The first real test call verifies the mapping.

**The comparison provider: Deepgram Nova-3, pre-recorded** (as slice C2 built it, with C3a's
multichannel change; `FSS_TRANSCRIPTION_PROVIDER=deepgram` or unset). Deepgram's pricing page
does not say whether multichannel audio is billed per channel, so its reservation counts both
channels (twice `unitPriceMicros`), and its transcripts are stored as model
`nova-3-multichannel`. `POST https://api.deepgram.com/v1/listen`
with the recording's bytes (read from Twilio by the worker, with the same authed fetch as
the playback proxy, `packages/domain/calls/twilioRecording.ts`) and `model=nova-3`,
`diarize=true`, `punctuate=true`, `utterances=true` and **`mip_opt_out=true` on every
request**, so Deepgram keeps the audio only as long as processing takes and never uses it
to train its models. The client (`apps/worker/src/transcription/deepgramClient.ts`) is built
from Deepgram's public documentation, cited there; it sits behind `TranscriptionProvider`
(`packages/domain/calls/transcription.ts`), so OpenAI's `gpt-4o-mini-transcribe` could
replace it with a second implementation. Bounded: the audio at most 40 MiB, two minutes a
request, an 8 MiB answer.

**The cost.** $0.0043 a minute (Deepgram's published Nova-3 pre-recorded rate, read 30
September 2026; `unitPriceMicros`, a setting so a price change is an edit, not a release).
A three-minute call is about 1.3 cents, rounded up to 2. The paid-call pattern, as research
and telephony apply it — `provider_reservations`, subject `call_transcription`, provider
`deepgram.nova-3`, priced by the minute — in three committed chunks:

1. reserve `ceil((recording seconds + 2) / 60)` minutes × `unitPriceMicros` against the
   day's transcription ceiling (settled plus open transcription reservations of the
   business date, serialised per workspace), or refuse `transcription_budget_exhausted`
   ("Transcription paused: today’s transcription budget is used…"). **These minutes are the
   bound**: the two seconds absorb Twilio's whole-second rounding;
2. mark the reservation `calling`, and nothing else; if transcription was turned off, set
   to $0 or lost its key since chunk 1, the reservation is released instead;
3. under the session's lock, ask again that the session exists, still qualifies and is
   still authorized (on, above $0, key); read the recording and **cut it to the reserved
   minutes at an MP3 frame boundary** (`packages/domain/calls/mp3Bound.ts`; audio that is
   not readable as MPEG Layer III is not sent at all); call Deepgram with what is left;
   store the utterances and settle by id at `min(Deepgram's duration, the reserved
   minutes)`. So the day's recorded spend never passes the ceiling that cleared it. A 4xx
   answer is a refusal Deepgram did not process: settled at 0, not retried. A timeout, a
   dropped connection, a 5xx or an unreadable answer is ambiguous: **estimated** at its
   reservation first, then **one** bounded retry, a fresh reservation cleared against the
   ceiling again. Two attempts at most.

A lost lease is finalised by the sweep: `telephony.sweep` also releases (`reserved`) or
estimates (`calling`) a transcription reservation still open 30 minutes after it was
written, skipping a session whose per-session lock a live claim holds, and, under the
lock, closing only the rows that are themselves that old (a fresh retry is left alone).

**Deletion** takes every targeted session's transcription lock and row lock right after the
send gate, before it measures anything, and holds them to the commit: a transcription that
has not begun waits and then finds the session gone, so no audio of a deleted call reaches
Deepgram.

**The key never leaves the worker's closure**: not in an outcome, an error, a job row or a
log line (failures are words like `deepgram_http_401`), and `apps/worker/test/callTranscribe.test.ts`
plants it in every failure the client can meet to prove it.

**Reading it.** `GET /calls/transcript?callSessionId=` (the firm's assigned salesperson or
an admin; anything else is 404, like a call with no transcript). The history row's
`hasTranscript` offers a "Transcript" disclosure. A channel-labelled transcript
(`aws_transcribe/standard`, `deepgram/nova-3-multichannel`) names its legs "You" and "Them";
a diarized one from before C3a keeps "Speaker 1", "Speaker 2", … in the order they first
speak, because diarization tells voices apart, not who is who; times are grey. A read that
fails is a sentence from `reasonSentence`.

**The secret.** Secrets Manager entry `<prefix>/transcription`, one JSON object,
`{"provider": "deepgram", "api_key": "..."}`. Only the worker is given it (and `twilio-voice`,
for the recording). The API never holds the key: a worker that has it registers
`call.transcribe`, and says so in its heartbeat (`detail.call_transcribe = true`); the
recording callback and Settings read "the key is in place" from a fresh worker heartbeat
(`transcriptionWorkerAvailable`). So Settings also reads "not set up" while no worker is
running. `{}` —
what the rehearsal fills and what the release puts in production before the deploy that
adds the entry to the worker task — reads as not configured, and nothing is transcribed.

### Pausing, and the month's cash ceiling (slice P1)

**A switch turned off (invariant I1).** When a sending switch (the attestation
`sending_enabled`, or the domain's `automated_sending_enabled` with its DNS checklist), the
research switch, or `call_transcription.enabled` is off, queued work is held and no new
provider request starts. The last check runs immediately before each provider call:

| Provider call | Final boundary | Final switch check |
| --- | --- | --- |
| Gmail send | `outbound/send.ts` `dispatchOutboundMessage` → `gmail.sendMessage` | `recheckAndClaim`: both switches and the attestation, under the send gate SHARED, in the claiming transaction. Every writer of either switch takes the gate EXCLUSIVE, so a turn-off waits for an open claim and every later claim reads it and holds the fence; a held fence sends exactly once when the switch is back on. |
| Research page fetch, token count, model call | `research/enrichment.ts` `finishFirmResearch` → `fetchPages` (each robots.txt and page request), `countInputTokens` (each pass of the trim loop), `extract` | `research_settings.enabled`, read again immediately before each request: the fetcher asks a `shouldContinue` predicate before every robots.txt and page request and stops there. Off releases the attempt (`released_not_called`) and closes the run `refused`/`research_disabled`; the sweep researches the firm again once research is back on. |
| Transcription | `calls/transcription.ts` `finishCallTranscription` → `provider.transcribe` | `call_transcription` (on, above $0), before the Twilio recording read and again immediately before the provider's request (for Amazon Transcribe, after the upload and immediately before `StartTranscriptionJob`). Off releases the attempt, and the call is held: see below. |
| Reply classifier | `classification/classify.ts` `finishClassification` → `classify` (chunk 3 of `classify.reply`) | `classifier_settings.enabled`, read in chunk 2 after the request is built and after the monthly lock, under the classifier switch lock (shared; every settings write takes it exclusive), in the transaction that marks the attempt `calling`. Chunk 3 sends before any database read. Off releases the attempt, records `disabled`, and the reply is held: see below. |

No paid SDK retries behind these checks: the Anthropic client is built with `maxRetries: 0`
for both the classifier and research, so one checked request is one HTTP request.

**Held, not completed.** A job that meets "off" completes (the job store ignores a
second enqueue of the same key), so held work is re-owed from the rows under a new revision
key once the switch is back on, and runs once:

* a transcription — `call-transcribe-resume` (registered only where `call.transcribe` is)
  owes `call-transcribe:{session}:r{n}` for an eligible call of the last seven days with no
  transcript, its earlier jobs finished, no open reservation, fewer than two paid attempts,
  and a `call_transcription` setting written after the last job finished. An attempt
  released before any provider request is not a paid attempt; six rows is the cap.
* a reply — `classify-reply` owes `classify-reply:{message}:resume-{hold}` for a reply whose
  LATEST attempt was held (recorded `disabled`, or a reservation released without a request)
  once `classifier_settings` was written after that hold, for replies of the last seven days,
  never with an open reservation and never past two paid attempts. The key names the hold,
  not the settings write, so a second save owes nothing new; and chunk 1 refuses, without
  paying, any obligation while the reply has an open attempt or after its latest attempt was
  paid.

A request already submitted may finish and its result is recorded; nothing recalls a sent
message or reverses a charge. `GET /settings/finishing` answers each switch and how much is
still finishing (fences `dispatching`; research runs under way, reservations `calling`;
transcriptions and reply classifications whose request may be in flight — their reservations
`calling`), and Settings shows "Sending is off. 1 message already submitted is finishing.",
"Research is off. 1 research run already under way is finishing." and, under Calling &
calendar, "Transcription is off. 1 transcription already sent is finishing." and "Reply
reading is off. 1 reply already sent to the model is finishing." while a switch is off and
something is.

**What the pause guarantees** (the boundaries, decided in the P1 final round). Each paid
path has one point after which a request counts as already submitted; a turn-off that
commits after that point lets that one request go, and one that commits before it stops it:

* Gmail — the claim's COMMIT. A turn-off that commits after it (it has waited on the gate for
  exactly that commit) lets that one message go. `dispatching` has no edge back to `held`
  (migration 0010), so there is no re-check after the commit.
* the reply classifier — chunk 2's COMMIT that marks the attempt `calling`, taken under the
  classifier switch lock. Between that commit and the request the runner issues nothing but
  the next chunk's `BEGIN` (its clock comes from the progress write, not a query) and chunk 3
  sends before any read.
* research and transcription — the final settings read immediately before each request. A
  turn-off that commits while that read is in flight is equivalent to one committed just
  after it: the request counts as already submitted.

A `calling` classifier attempt whose claim is gone (a lost lease, a requeue between chunk 2
and chunk 3) is estimated at its reservation by the job's next claim or by the sweep, by
design: nobody can know whether its request left. A reply holds at most two paid attempts,
so a reply loses at most two estimates this way and is then left with its deterministic
classification.

**The month's cash ceiling (invariant I2).** Daily ceilings are not a monthly guarantee:
$1.25 of calling and $0.50 of transcription a day already allow $38.50 over twenty-two
weekdays. `monthly_cash_ceiling_cents` (`{ "cents": 0..5000 }`, $25 by default, migration
0031; admin-written through `POST /settings/update`, not in the settings snapshot) is checked
when a call session, a transcription attempt or a research run reserves its cents, under a
workspace monthly lock taken last, inside that provider's own budget lock (telephony,
transcription, research), so it is atomic with the daily check and every path takes the
locks in one order.
Month-to-date spend is every **cash-funded** provider's settled cost plus its open
reservations, on the calendar month of the workspace business time zone (`readSpend`).
Credit-funded spend (Amazon Transcribe, slice C3a; `packages/domain/settings/funding.ts`) is
excluded from it and from every ceiling that reads it; it still counts against the day's
transcription cap, and Settings shows it as "Credits this month" (`creditsMonthCents` in
`month`, answered only with `?include=month&include=credits`, so a P1 desktop's strict parse
never meets it). A refusal is
`monthly_cash_ceiling` with a sentence. Settings → Calling & calendar shows "This month: $x
of $y" (`GET /settings/integrations?include=month`). Research keeps its own monthly ceiling and
is also refused by this one (`monthly_cash_ceiling`).

**The reply classifier on the paid-call pattern (fix round 2).** `classify.reply` is chunked
like `research.firm` and `call.transcribe`, with `provider_reservations` subject
`reply_classification` (0031), one row per attempt:

1. chunk 1 (`beginClassification`), committed — the switch, the lifetime bound (two paid
   attempts, six rows), the daily call cap (today's paid reservations), and the month's cash
   ceiling, then the attempt reserved at the request's upper bound: its UTF-8 bytes as input
   tokens at the cache-write price plus `max_output_tokens`, doubled when the server may fall
   back. One open reservation per reply (`provider_reservations_one_open_reply`). The daily
   count is the classifier's paid reservations dated today plus today's sent requests with no
   reservation for their reply (those made before 0031), both on the same business date.
2. chunk 2 (`ensureClassificationCalling`), committed — the request built, the month and the
   switch read last, the attempt marked `calling`; off or over the month releases it.
3. chunk 3 (`finishClassification`) — the request, then the settlement by id at the answer's
   cost (`anthropic_classifier` in the ledger). An ambiguous failure, or an answer that does
   not report its input and output counts, keeps the reservation as its estimate — never a
   computed zero (research's extraction applies the same rule; transcription settles only on
   a duration the answer reports). An ambiguous failure, under two paid attempts, goes back
   to chunk 1 for the one retry.

So spend is durable whatever the handler does after the request: a rolled-back chunk 3
leaves the attempt `calling`, which `readSpend` counts, and the job's next claim (or the
sweep, after half an hour) estimates it. There is no overshoot beyond the reservations.

**After-call summaries (slice C3b, migration 0032).** Once a call has a channel-labelled
transcript, `call.summarize` asks a model (Claude Haiku 4.5 by default; `FSS_CALL_SUMMARY_MODEL`
may name Claude Sonnet 5.5) for a summary of three to six sentences, up to five suggested next
steps and the commitments heard, quoted and checked against the side that said them. Suggestions
only: the Mac shows them under the call (`GET /calls/history?include=summary`) and on the Today
card, and nothing is sent or scheduled from them. The switch is transcription's own,
`call_transcription` (on, with a ceiling above 0); there is no second one. The job is the
classifier's shape with `provider_reservations` subject `call_summary`: chunk 1 the switch, two
paid attempts per call for life, forty a day (`call_summary_budget`), the month, and a
reservation at the request's byte bound (one open per call,
`provider_reservations_one_open_summary`); chunk 2 the month and then the switch's setting lock
SHARED, held to the commit that marks `calling`; chunk 3 the request, then the session row (KEY
SHARE), the monthly lock, and the settlement by id at the answer's usage — or its estimate when
the answer reports none or the transport threw. An unusable or ambiguous answer is retried once
within the two. Held summaries resume once per change of the setting (`call-summarize` source),
like transcriptions, and that includes a retry the switch held: a call with no summary and
fewer than two paid attempts is owed its remaining attempt by whichever job asks (C3 review,
finding 5), and the lock, the open check and the one-open index keep that to one obligation at a
time. A summary request in flight (`calling`) counts in transcription's "still finishing" line.

**Post-call analysis (slice 3a, migration 0035).** A channel-labelled transcript is read by a
model once per **version** (`call_analyses`): one structured reading of the call
(prompt `call_analysis.3`), checked against the transcript by
`readCallAnalysisAnswer`, and stored with the proposal set the pure policy computes from it
(`proposeEffects`, `call_policy.5`) and that set's hash. **A whitelist:** a stop, a buying
signal, an e-mail request, a callback and its agreement, an exact callback time and day, and a
promised task are offered for applying only when the speaker's whole line is built entirely from
a small set of complete, simple forms (`calls/analysisConfirm.ts`); anything else — a negation,
a condition, a contrast, a correction, a withdrawal later in the call, an unknown phrasing — is a
review item. Unknown is review; the confirmer never works out polarity or scope. Nothing in an analysis acts: every
proposal is applied only by David's click, checked against one exact version and its stored
hash. David's edited notes are a version of their own (origin `user`) and stay the current
notes whatever model version completes later. Every writer of one call's analysis
(`calls/analysis.ts`) takes the call's **firm row** (`FOR UPDATE`), then the advisory lock
**`call_analysis:<session>`** (`lockCallAnalysis`, keyed `<workspace>:call_analysis:<session>`),
then the session row (`FOR KEY SHARE`), then its own rows; an apply takes the same three in the
same order after its own earlier locks (Today, the send gate, a touched route).

**The analysis job (slice 3a, A2).** `call.analyze` (`calls/analysisPaid.ts`,
`analysisHandler.ts`) is the summary's paid-call shape with an analysis **version** as the
subject: `provider_reservations` subject `call_analysis`, keyed by the version's id, priced by
model and tokens (`anthropic_call_analysis` is cash; `aws_bedrock.call_analysis` credits). Chunk 1
takes the version (a pending one, or a new one), the switch, the caps — two paid attempts and six
rows per version, three model versions per call (`CALL_ANALYSIS_MAX_MODEL_VERSIONS`), forty a day
under `call_analysis_budget` — the month, and a reservation (one open per version,
`provider_reservations_one_open_analysis`); chunk 2 the month and the switch's setting lock
SHARED to the commit that marks `calling`; chunk 3 the request, then the settlement by id, then
A1's `completeCallAnalysis` in the same transaction — there is no second completion path. An
unreadable or ambiguous answer is retried once within the two. The switch is transcription's,
`call_transcription`: off, a version is created and held (pending, nothing reserved). A held
version resumes only on an **explicit** trigger, never by a periodic re-offer (review S3A2F): a
settings write that turns `call_transcription` on, or that raises `monthly_cash_ceiling_cents`,
is swept once (`call-analyze-sweep`, keyed by the write's own row), and the sweep queues every
held version that has no open reservation and no live job, naming it in the payload; or David's
Retry, keyed by its command and naming the held version. Chunk 1, under the analysis lock, does
nothing for a named version that is no longer pending, so a sweep and a retry racing buy at
most one reading. **A version held by the day's cap (forty) is not resumed the next day**: it
stays pending, shown as held with Retry, and resumes on Retry (or on the next qualifying
settings write). The model is the
deployment's (`FSS_CALL_ANALYSIS_MODEL`, Haiku 4.5 unless set; not set in the infrastructure).
David's `POST /calls/analysis/retry` (reason `retry` or `reanalysis`), under the call's analysis
lock: a live `call.analyze` job is `analysis_in_flight`; a held version is queued again; a
historical call, or one with a completed model reading of its current transcript, needs
`reanalysis` (`reanalysis_required`) — and chunk 1 enforces that too; otherwise one job, keyed
by the version and the command (`call-analyze:<session>:v<N>:c<command>`).
David's notes count for none of this, nor for the path below (review S3A2).

**The summary cutover.** `postCallModelPath(session)` is `analysis` for a call with a model
analysis version; `summary` for one with any `call.summarize` job, `call_summary` reservation or summary;
`analysis` otherwise. The summary handler refuses a call on the `analysis` path; the
`call-summarize` source is **legacy only** — it re-owes a summary the switch held for a call that
already has a `call.summarize` job (and no model analysis version), and never makes a first one. So
every obligation started before the release finishes as a summary, every new call is analysed,
and a historical call is analysed only by David's `reanalysis`. `GET /calls/history?include=summary`
maps the current analysis (David's notes, else the latest completed model reading) to the
summary's shape and falls back to the stored summary for a call with none. The deletion workflow
takes each targeted session's `call_analysis:<session>` lock beside its summary lock, after the
firm and before the sessions' own locks, finalises their open analysis attempts as the sweep
does, and removes and counts their versions (`removes.call_analyses`); the telephony sweep
finalises an analysis reservation half an hour on, skipping a call whose lock a live claim holds.

**Provider errors in the logs (C3 review, finding 6).** A request the API refuses with a 4xx
(not 408) is `provider_refused`: refused before generation, settled at 0, not retried; a 5xx,
408 or dropped connection is `provider_error`, estimated and retried once. The classifier and the
summary log failures through one helper (`classification/providerError.ts`): the status and the
error type always, and for a 400 `invalid_request_error` only the leading request-parameter
path (e.g. `output_config.format.schema`), and only when it starts with a Messages API
top-level parameter. No provider free text is ever logged, so a provider error that echoes
the request cannot copy an e-mail or a transcript into a log. The deletion workflow takes each targeted session's summary lock after the
firm and before the sessions' own locks.

**One lock order, ledger rows included (fix round 2, finding 4).** Every path takes:

routing → send gate → firm (and contact) → the subject's own lock (call summary, call analysis
`call_analysis:<session>`, call session row, transcription session, research run, reply) → its kind's budget lock (`telephony_budget`,
`transcription_budget`, research `RSCH`, `classifier_budget`, `call_summary_budget`, `call_analysis_budget`) → the
workspace monthly lock →
rows: reservations, ledger, and the rows that reference a message (classifier attempts).

The deletion workflow follows it whole (P1 final round): after the send gate it locks the
firm (and the contact), then every call session and its transcription, then every active
research run of the firm (running, or holding an open reservation), then the monthly lock —
all before it deletes or settles anything. Research chunk 3 takes the firm's KEY SHARE before
its run, so a page-only run and a firm deletion wait for each other in that order; the
classifier's chunk 3 takes the monthly lock before it records its attempt, as its chunk 2
already does. `packages/domain/test/retention/deletionLockOrder.test.ts` drives both of the
verification's interleavings (deletion against a paused classification, and against a
page-only research run); both now finish.

**Today's lock comes first for a change that refreshes Today (slice S2 review, finding 1).**
The morning build takes Today's advisory lock (`today.build:<workspace>`) exclusively and then
the firms' foreign-key locks as it writes their tasks. A transaction that ends in
`refreshTodayForFirm` therefore takes that lock, shared, before any firm or route row lock
(`lockTodayForFirmChange`): `createFirm` (Add firm and every import row that creates a firm)
before its insert, and `updateFirmBasics` before it locks the number it replaces and then the
firm (Today's lock → route → firm, `retireRoute`'s own route → firm order). A basics edit and
the build then wait for each other in one direction only;
`packages/domain/test/today/promptFirm.test.ts` drives that interleaving, and without the
early lock PostgreSQL picks a deadlock victim.

**Applying a post-call analysis, and the pending-review hold (slice 3a, lane B, migration
0036).** Every effect of an analysis happens only when David clicks, for the first time,
through an existing command, for the analysis he saw (`POST /calls/proposals/apply`,
`calls/proposalApply.ts`). One Apply carries any subset of the analysis's `apply` proposals
(`outcome`, `callback`, `follow_up`, `buying_signal`, `park`, tasks); opening a deal is one
of those ticks, with no dialog. Its transaction takes, in this order:

Today's lock (shared) → send gate → the dialled route, whenever an **outcome** is applied
(`FOR UPDATE` for `wrong_number` or `do_not_call`, `FOR KEY SHARE` otherwise — the call log's
insert takes that lock through its foreign key) → firm → `call_analysis:<session>` → the
session row

then checks freshness under them (the analysis is the newest completed model analysis on the
current transcript, else `stale_analysis`; the echoed hash is the stored one, else
`stale_proposal`), then the first-time rules in order (`call_already_logged`,
`outcome_required`, `callback_exists`; a `follow_up` more than seven days after the call —
the session's start, never the log's time — is `follow_up_expired`), and maps each key to its
command inside one savepoint. **The Apply is atomic**: any key refused, or a command that
fails (a selected follow-up whose permission is not granted is `follow_up_not_granted`; a
warning the outcome's command would keep as history on the form — `effects_not_applied`, a
selected callback it did not create or whose fields do not name its `dueAt` — is refused,
the callback's fields checked before anything is logged),
rolls the whole batch back and the 409 names the key (`keyReasons`, key → code); nothing is
applied or measured. Only `applied` keys write a `call.proposal_decided` row; the no-ops below write
none. `outcome` (with `callback`, `follow_up` and the stop choice — `doNotCall`, or the
1.0.29 "covers all contact" checkbox) is one `logCallOutcome`; `callback` on a logged call is `scheduleCallbackForCall` or
`createCallback`; `follow_up` on a logged call is `confirmCapturedFollowUp` (seven days, not
`recordCallFollowUp`'s sixty minutes); `buying_signal` is `applyStageEvidence('call.interested')`
then `setManualControlMode(engaged_call)`; `park` is a cadence park (`already_parked` when
this proposal's park was ever made — a Resume sticks — or any park hold, the automatic one
included, is open); a buying signal already applied for the call is `already_applied`; a task is a `call_tasks` row (`already_created` on a repeat). An overview
request's "Send overview" task is written once: by the task key with David's edits when he
selected it, otherwise beside the follow-up as proposed. A second outcome for one session — from the form or an
Apply — is `call_already_logged` in `logCallOutcome` itself.

An open call task is a Today item of kind `task` (due-work lane, key `call-task:<id>`,
carried until done). The installed desktop's contract has no such kind, so it is negotiated:
`GET /today?include=tasks` and `include: ['tasks']` on `POST /today/firm`. Without it a task
is in no card, count or expansion — a card's lane and instant come from its other open items,
and a firm with nothing else open has no card. `POST /today/tasks/complete {taskId}` marks
one done (Today → firm, then the firm's card refreshed).

`logCallOutcome` itself now takes the dialled route **before** the firm (gate → route →
firm), the order `retireRoute` and `updateFirmBasics` keep — `FOR UPDATE` when it retires or
suppresses the number, `FOR KEY SHARE` for every other outcome: taken after the firm (the
route's row for a wrong number since S2, the call log's foreign-key lock for any outcome), a
call logged while the same number was being replaced could deadlock with the basics edit.

**The pending-review hold.** Both Twilio callbacks take the send gate, then the firm (`FOR NO
KEY UPDATE`), before the session row — the status callback for **every** status now, not only
no-answer and busy, and the recording callback, which used to lock the session first. On
every delivery, duplicates included, `admitPendingHold` reads the session's accumulated facts
and opens a firm-scoped `scoped_pause` (source `call_analysis_pending`, source id the session,
recovery `review_call`, blocking `email_send`, `enrollment_advance` and `call_task`, never
dialling) when the call is terminal, answered (`answered_at` or a provider status of
`completed`), at least 20 seconds long, the transcription switch is on, it has no log, and the
session never had one (`active_holds_one_pending_review`). It is released at the call's first
log link, by `POST /calls/pending/dismiss`, or by the deletion that removes its session
(`commitDeletion`, after the gate, the firm and the sessions' locks), and is never reopened.
A firm merge carries every `call_tasks` row to the surviving firm, contactless ones included.

**Cadence parking stays automatic.** It is the one automatic writer left (`parkIfCadenceSpent`,
from the status callback and `logCallOutcome`); the "human click" rule covers analysis effects
only.

`packages/domain/test/calls/proposalApplyLocks.test.ts` (check C4) drives the Apply against
the status callback, the recording callback, the morning build, `updateFirmBasics` replacing
the dialled number, David's `logCallOutcome`, a reply opt-out and (in
`proposalApply.test.ts`) `completeCallAnalysis`, in both orders and with the Apply stopped
half-way; without the route pre-lock, the early Today lock, or either callback's gate prefix,
its interleaving deadlocks.

Every write to a `provider_ledger` row takes the monthly lock first (`lockMonthlySpend`,
inside `recordProviderCall`, the settlement and the correction), so a transaction that holds
a ledger row always holds the monthly lock and ledger rows cannot be part of a cycle; the
kind order among ledger rows then does not matter. The places that used to settle first and
lock later now lock first: transcription and research chunk 2 take their budget lock before
estimating an earlier attempt; the research sweep and the deletion workflow lock every run
before settling any; the telephony sweep locks its call sessions in one statement and takes
transcription and reply subjects only by try-lock. Research's page-fetch ledger row is
written at the end of chunk 3, so the monthly lock is never held across the model call. The
classifier switch lock is a leaf after the monthly lock (its exclusive holder, the settings
write, takes nothing else). `apps/worker/test/spendLockOrder.test.ts` drives the review's
three transactions (sweep, recovery, callback) into the interleaving that deadlocked; all
three now commit.

**A later telephony price.** Twilio's terminal callback may settle a call from its duration
(an estimate) before a later callback carries the final price. The price is the cost: the
session's `billed_price_cents` takes the latest one, and a closed reservation is corrected to
it (`settled`), with the ledger row of its own date moved by the difference, under the
monthly lock. The same price again changes nothing.

**Funding** (slice C3a, David's decision of 1 October 2026; `packages/domain/settings/funding.ts`,
by the provider key's kind, the part before the first dot). Credit-funded spend is left out of
the month's cash ceiling and shown apart; a kind not listed is cash.

| `provider_key` | What | Funding |
| --- | --- | --- |
| `aws_transcribe.standard` | transcription (primary) | credits (AWS) |
| `twilio.voice` | Twilio minutes | cash |
| `deepgram.nova-3` | transcription (comparison) | cash |
| `anthropic_extraction` | research model calls | cash |
| `anthropic_classifier` | reply classifier calls | cash |
| `anthropic_call_summary` | after-call summaries (slice C3b) | cash |
| `aws_bedrock.classifier`, `aws_bedrock.call_summary`, `aws_bedrock.extraction` | the same three model calls through Amazon Bedrock, for the models Bedrock serves this account (Haiku 4.5; slice BR1, `FSS_MODEL_TRANSPORT=bedrock`, production); any other model stays on the direct API's cash keys | credits (AWS) |

**Rolling back below BR1:** a worker without BR1 would settle an open `aws_bedrock.*` reservation through the direct API under that credit key, so before rolling back wait for, or release, every open (`reserved` or `calling`) `aws_bedrock.*` reservation.
| `company_page` | firms' own websites | free (a count, no cents) |

### The voicemail script

`{contactFirstName}`, `{firmName}`, `{callerName}` and `{callbackNumber}` (David's verified
number), rendered by `renderVoicemailScript`. The default is `DEFAULT_VOICEMAIL_SCRIPT`.
Editable in Settings → Calling & calendar (up to 2 000 characters): migration 0028 already
admits the key, and `readVoicemailScript` reads the stored value and falls back to the
default when none is stored or the stored value does not parse. `GET /calls/calling`
serves the edited template, so the next call card uses it.

### The Mac

* `NSMicrophoneUsageDescription` ("Callie uses the microphone for calls you place from
  Callie.") is kept in the packaged `Info.plist`, and the app is signed with
  `com.apple.security.device.audio-input`.
* The window's session allows `media` with audio only, for the app's own page
  (`callie-app://bundle`, `file://` in development), and refuses every other permission
  and origin (`src/main/mediaPermission.ts`).
* The renderer's CSP adds exactly Twilio's documented entries for the Voice JS SDK:
  `connect-src https://eventgw.twilio.com wss://voice-js.roaming.twilio.com
  https://media.twiliocdn.com https://sdk.twilio.com` and `media-src mediastream:
  https://media.twiliocdn.com https://sdk.twilio.com`, plus `blob:` in `media-src` only,
  for recording playback. `default-src 'none'` stays; the SDK is bundled, so no
  `script-src` entry.
* While a call is live an update is not installed: every install path — at launch,
  a blocked build's, or Restart to update — stops before the swap, and the staged,
  verified bundle is installed when the call ends (`callActivity.ts`, `Updater.callEnded`).
* Closing the card or pressing Hang up while a call is being set up cancels it; a Device
  or Call created afterwards is disconnected and destroyed at once, and the main process
  (`calling.cancel`) binds nothing of that start to the next outcome. Each press carries
  its own `requestId` through `calling.start` and `calling.cancel`: a cancel for an older
  press, arriving after a newer one started, changes nothing (`cancelled: false`). Every
  refusal of a press is a sentence (`call_cancelled` and `calling_off` included); a
  transport failure is "The call could not be connected…", never a code. Stop, or leaving
  the firm page, cancels a recording still being fetched.
