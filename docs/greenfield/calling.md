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
   * `call_attempt_limit`: three consumed sessions for the firm in the last 24 hours;
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
   `callSessionId`; the log is linked to the session.

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
