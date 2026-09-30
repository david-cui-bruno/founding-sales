# Meetings: Cal.com bookings move the pipeline

Call-to-booking slice W (migration 0028). A demo booked through Cal.com becomes a
`meetings` row, moves the firm's opportunity to **Demo booked**, and stops cold
outreach to the firm. Off by default: with `calendar_integration` off the webhook
answers 404 and nothing reads the Cal.com secret.

## The switch

`calendar_integration` `{"integration": "off" | "calcom"}`, written with
`POST /settings/update` (not in the `GET /settings` snapshot; see
[calling.md](calling.md)). The webhook serves **the one workspace** with the switch on:
Cal.com's webhook carries no workspace, so with two workspaces switched on the route
answers 503 rather than guess.

## The webhook

`POST /integrations/calcom/webhook`, JSON, at most 64 KiB.

* `X-Cal-Signature-256` must be the hex HMAC-SHA256 of the **raw body** under the
  webhook secret, compared in constant time. A body re-serialised by anything in
  between does not verify; that is intended.
* Every delivery is recorded in `calcom_events`, keyed by the sha256 of the raw body,
  so a redelivery is answered `duplicate: true` and applied once.
* Handled triggers: `BOOKING_CREATED`, `BOOKING_RESCHEDULED`, `BOOKING_CANCELLED`,
  `MEETING_ENDED`, `BOOKING_NO_SHOW_UPDATED`. Anything else is recorded as `ignored`.
* A delivery older than the meeting's last applied event is recorded as `stale` and
  changes nothing. Cancelled is terminal.

## What a booking does

1. **Match the firm** by the attendee's e-mail address (a contact's address), then by
   the e-mail domain against a firm's website domain. No match, or more than one, opens
   a stage review item (`firm_unmatched` / `firm_ambiguous`) and the meeting stays
   unlinked; nothing else happens.
2. **Stage evidence** `meeting.booked` through `applyStageEvidence`: the open
   opportunity moves forward to Demo booked (never backward, never over a person's pin
   to a later stage, never reopening a closed one, which opens a review item instead).
   A firm with no opportunity at all gets one opened at Demo booked.
3. **Manual control** for the firm (origin `engaged_call`, reason "meeting booked").
4. **Stop prospecting**: live `prospecting` and `cold_legacy` enrolments at the firm
   stop, with an audit row. A `follow_up` enrolment the prospect agreed to on the call
   is left running.
5. Funnel fact `meeting.booked` (keyed by the booking uid); `MEETING_ENDED` records
   `meeting.held`.

A reschedule updates the times and the current booking uid; a no-show mark remembers
the state it replaced so an unmark restores it.

## The secret

Secrets Manager entry `<prefix>/calcom`, injected into the API task as the variable
`calcom`: `{"webhook_secret": "..."}` (at least 16 characters). Missing or misshapen
means 503 and `integration_unconfigured`. As with `twilio-voice`, put a value (`{}` is
enough) in the entry **before** the apply that adds it to the API task, because ECS
refuses to start a task whose secret has no value.

Cal.com console: a webhook to `<public origin>/integrations/calcom/webhook` with the
five triggers above and the same secret.

## The pipeline these moves land in

0028 replaced the default stages with Interested (`new`), Demo booked
(`demo_booked`), Decision pending (`qualified`), Onboarding (`onboarding`), Live
(`won`) and Lost (`lost`). Open opportunities in the retired `contacting` and
`engaged` moved to Interested, and `proposal` to Decision pending, each with a stage
event (reason `stage_remap_20260930`). `fss admin pipeline stage-counts` prints each
workspace's stages with their counts, pins and remap moves, read only, for the before
and after of the release.

Automatic moves follow `stage_rules` (evidence kind to stage): `meeting.booked` →
Demo booked, `call.interested` → open at Interested if none, `subscription.accepted` →
Onboarding, `customer.live` → Live. A person's move pins the opportunity at that stage;
evidence for a later stage clears the pin.
