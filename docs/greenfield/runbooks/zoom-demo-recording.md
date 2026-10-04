# Local recording for verified Callie demos

M3 ships disabled. `meeting_auto_recording` is independent of meeting uploads, transcription, analysis, follow-through, calling, sending and their budgets. No setting change creates a recording file: the host must join with the Zoom desktop app, then allow Zoom to convert the recording after ending the meeting.

## Secure setup

1. Confirm the existing Cal.com API key can GET the exact demo booking and event type. Record the observed event type ID; do not infer it from a URL slug. The singular booking client pins `cal-api-version: 2026-02-25`; the existing catch-up list client is unchanged.
2. Use the existing Zoom server-to-server OAuth app, with only meeting read/update admin scopes. Keep event subscriptions off. The unused webhook token is not used by this integration. Activate the app only at the controlled setup step.
3. Put `{account_id,client_id,client_secret}` directly into `fss-prod/zoom-meetings` through the approved hidden-input/Secrets Manager path. Do not put credentials in chat, files, process arguments or Terraform values. The secret container is worker-only. An inert `{}` allows a disabled deployment; it does not report readiness. Restart the worker after saving valid credentials.
4. In Calling & calendar, set the actual business Zoom host email and verified Cal.com demo event ID. Only an administrator may save. Enabling requires unique workspace calendar routing, no restore hold, and a fresh worker reporting both provider clients. This readiness check confirms configuration, not successful provider authentication.
5. Enable only for the designated controlled demo. Use a separate non-demo control to prove it remains unchanged. Do not enable email sending or paid processing as part of this setup.

## What the worker does

The scheduler considers matched active-firm bookings within 60 days, at most 20 new targets per pass. Each operation has immutable booking identity and settings version. It validates a fresh single-host, single-attendee Cal.com booking against the configured event, host, attendee, times and Zoom meeting ID. It then GETs Zoom and accepts only a scheduled, non-recurring, non-PMI meeting with matching host, time and duration. Reused IDs, cloud/unknown modes and ambiguous identities require manual setup.

The only mutation is `PATCH /v2/meetings/{id}` with `{"settings":{"auto_recording":"local"}}`. Provider origins are pinned; redirects are refused; token/GET requests are limited to 10 seconds and PATCH to 5 seconds, with bounded streamed bodies. Persisted intent precedes PATCH. A timeout, crash or lost acknowledgement is reconciled by GET, never by blindly issuing another PATCH. Only verified local readback produces **Auto-recording set**.

There are at most four attempts within two hours of the first job claim, or until the meeting starts, whichever is earlier. The first claim survives lease recovery; crashes before handler reservation also count. Expired operations require manual attention. Retry creates an audited generation using a retained command ID and reconciles unresolved writes first. A known manual disable is respected across same-ID rescheduling unless the person explicitly retries. Cancelling, unlinking, changing identity, merging or deleting invalidates pending work. Restore disables the integration and marks uncertain work for review.

## Acceptance and rollback

Check: demo PATCH/readback, non-demo unchanged, reschedule to same and new IDs, cancellation and disable. Then David hosts the designated meeting in Zoom desktop. Verify an actual converted local file, importer match and both participants' audio. API readback alone is not full recording acceptance; record the native test separately if pending.

The firm page shows **Setting up auto-recording**, **Auto-recording set**, or **Start recording manually**, with expandable reason, checked time and a versioned Retry when applicable. Previously enabled settings are noted after cancellation/replacement. Disabling prevents future writes but does not undo settings on individual Zoom meetings; review those manually if their links will be reused. No provider error body or credential enters the public status.
