# Calling: a Twilio call from Callie, authorised per call

Call-to-booking slice W (migration 0028). Callie can place a recorded call from the
Mac through Twilio Voice instead of handing the number to the phone (`tel:`). The
number is never sent to the Mac: the Mac asks the API for a **call session**, hands
its id to the Twilio Voice SDK, and Twilio asks the API what to dial. The API answers
only after re-taking the whole dial decision at that moment.

Off by default. With the switch off, every route below answers 404 and nothing reads
the Twilio secret.

## The switch and the settings

Three workspace settings, versioned and audited like the others
(`packages/contracts/src/settings.ts`, `INTEGRATION_SETTING_KEYS`). They are written
with `POST /settings/update` and are deliberately **not** in the `GET /settings`
snapshot, because installed desktops parse that snapshot with a strict key list.

| Key | Value | Default |
|---|---|---|
| `calling_provider` | `{"provider": "tel" \| "twilio"}` | `tel` |
| `telephony_budget` | `{"dailyCeilingCents": 0..10000, "maxMinutesPerCall": 1..240, "unitPriceMicros": ...}` | ceiling 0, 30 minutes, 14000 micro-dollars a minute |
| `calendar_integration` | see [meetings.md](meetings.md) | `off` |

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
   *path* (never a signed URL). Transcription is a later slice (reservation subject
   `call_transcription` is already admitted).
6. The salesperson logs the outcome with `POST /calls/log` as before, adding
   `callSessionId`; the log is linked to the session. The Mac adds it itself: the
   outcome recorded next for the same firm and number names the session.

`sweepCallSessionReservations` releases the reservation of a session that expired
unused and estimates one whose call outlived its maximum by 15 minutes with no final
callback. It is a domain function; scheduling it as a worker job is not done yet.

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
variable `twilio-voice`, one JSON object:

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
bought and nothing bridges through his cellphone. With any other value — and whenever
the Mac cannot read the setting — the Call button is the `tel:` handoff exactly as
before.

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

A refusal is a sentence: the call-session codes from `CALL_SESSION_REFUSAL_SENTENCES`
(`packages/contracts/src/callSessions.ts`; the budget one reads "Calling paused: today’s
calling budget is used."), every dial refusal from `reasonSentence`. A microphone macOS
refused says where to allow it (System Settings → Privacy & Security → Microphone).

**Callbacks ring David's cellphone.** The caller ID is his own number, so a prospect who
calls back calls him. The access token has no incoming grant, nothing forwards, and
Callie keeps no voicemail box.

### The cadence

Decided in `createCallSession` (`readCallCadence`, `packages/domain/calls/sessions.ts`):

* an **unanswered attempt** is a placed session that ended no-answer or busy, or whose
  recorded outcome is `no_answer`, `busy` or `voicemail_left` (the recorded outcome wins:
  an answering machine is `in-progress` to Twilio);
* at most **4** in **14 days**; at most **one per business day** on the firm's clock, and
  the next at least **2 hours** of the clock from the previous one's time of day (the
  calling window itself is `authorizeDial`'s);
* the count starts again after a recorded `interested`, `referral_or_wrong_person`,
  `callback_requested`, `not_interested` or `do_not_call` (any call log, placed from
  Callie or not), and after a parked firm is resumed. A `callback_requested` outcome's
  callback is the next action, as it always was (the callback task on Today);
* the fifth attempt is refused `call_attempts_exhausted` and **parks the firm**: a
  firm-scoped `scoped_pause` hold on `dial_authorization`, source
  `call_cadence_parked`, recovery `resume_after_review`. While it is open every dial of
  the firm, `tel:` included, is refused `scoped_pause` ("Calling is paused for this firm.
  Resume it when you are ready."). **`POST /calls/cadence/resume`** `{firmId}` ("Resume
  calling" on the card) releases it, and its release instant starts the count again.

### Recordings

`<Dial record="record-from-answer-dual">` records every call. **`GET /calls/history?firmId=`**
lists the firm's placed calls with duration and whether a recording exists (no number,
no URL). **`GET /calls/recording?sessionId=`** reads the audio from Twilio's REST API
(`https://api.twilio.com` + the stored path + `.mp3`, basic auth with the `twilio-voice`
secret's API key) and answers `{ sessionId, contentType, audioBase64 }`. Only paths of
this account's recordings are fetched, at most 40 MiB. Both are the assigned
salesperson's or an admin's; another firm's or workspace's session is 404 and Twilio is
not asked. The bytes travel as base64 in JSON because every route of this API and every
read of the Mac's client is JSON; the Mac plays them through the Web Audio API, so the
renderer's CSP needs no `blob:` or `data:` source. The call history on the firm page is
`apps/desktop/src/renderer/calling/CallHistory.tsx`.

### The voicemail script

`{contactFirstName}`, `{firmName}`, `{callerName}` and `{callbackNumber}` (David's verified
number), rendered by `renderVoicemailScript`. The default is `DEFAULT_VOICEMAIL_SCRIPT`.
**Not yet editable:** a `voicemail_script` setting needs `workspace_settings_key_known`
widened, which is a migration; until then `readVoicemailScript` answers the default.

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
  https://media.twiliocdn.com https://sdk.twilio.com`. `default-src 'none'` stays; the
  SDK is bundled, so no `script-src` entry.
* While a call is live an update is not installed: a due install (a blocked build's, or
  Restart to update pressed during the call) waits and runs when the call ends
  (`callActivity.ts`, `Updater.callEnded`).
