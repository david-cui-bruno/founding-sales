# Cal.com sync, meeting records and recordings

Callie retains Cal.com meeting synchronization and related business history. AI booking lifecycle, interpretation/policy and create/change booking clients were removed. A recorded meeting, booking link or capacity observation is not authority to book, reschedule, cancel or contact an attendee.

## Existing calendar integration

`packages/domain/meetings/calcom.ts`, `reconcile.ts`, `match.ts`, `attendance.ts` and `bookingDetails.ts` own retained webhook/reconciliation and meeting association. Provider callbacks are authenticated and routed to the correct workspace. Event identity/version and current association determine publication. Duplicate or out-of-order events must not overwrite newer state. Ambiguous firm matching remains unresolved until a supported human action.

The Cal.com integration switch remains under Settings → Advanced. Disabling integration does not delete recorded business history. Existing installed clients and live Cal.com compatibility still require the `bookingCapacity.ts` domain/API read, even though its Settings mount was removed. That read distinguishes configured preference, actually observed provider settings and recorded meetings. Missing/invalid credentials or provider responses stay unavailable; a local preference is not provider enforcement. Do not recreate booking automation to make a capacity card appear complete.

## Retained meeting work

Recordings, transcription, analysis, outcomes, recap drafts and supported follow-through have independent configuration and authority boundaries. Current worker startup conditionally registers adapters such as meeting transcription/analysis and automatic recording setup. The presence of a source module does not establish deployed provider availability or owner permission.

Original audio/transcripts, derived suggestions and human-confirmed outcomes remain distinct. Current source access, assignment, membership, cancellation and spending checks must survive external waits and retries. A generated recap is not sent merely because it exists. An uncertain recording or provider attempt cannot be safely repeated by clearing its evidence. Retention/deletion closes dependent work and private copies through the normal workflow.

## Operational checks

For daily work use the [selling guide](../operations/how-to-sell.md). For recording setup use the protected [Zoom recording runbook](runbooks/zoom-demo-recording.md), not an archived implementation plan. [Current state](../operations/current-state.md) distinguishes actual deployment from source readiness.

Existing meeting/API/worker tests cover callback identity, duplicate/reordered events, manual matching, recording/transcription, cancellation and privacy. Installed1.0.51 capacity compatibility is a retained boundary, not permission to expand its response. Controlled fixtures do not prove a real calendar account, meeting, recording or attendee consent.
