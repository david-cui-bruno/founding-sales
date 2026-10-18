# Lean booking boundary

AI booking interpretation, standing policy execution, appointment creation/change, conversation orchestration and booking-only message sending are removed. Their API routes, worker handlers, desktop actions, model/calendar-write clients and dedicated behavioral tests are no longer shipped. No replacement booking channel is introduced.

## Retained compatibility and history

Installed desktop 1.0.51 was built from `d49dda37`. Its existing `/meetings/booking-capacity` API and wire contract remain unchanged. Capacity is read-only configuration/retained-booking evidence, not appointment creation or available-slot inference. Keep its current desktop display, API client and tests until an explicit desktop compatibility transition.

Cal.com webhook/reconciliation, existing meetings, unmatched-booking matching, meeting details, attendance/notes, Today projections and recording sync remain. In particular, worker `calcom/bookingClient.ts` reads an existing booking for automatic recording setup. It is not the removed create client.

All historical migrations, tables, settings/audit history and financial/uncertain-dispatch records remain. The reduced `contracts/src/bookingPolicy.ts` validates only the persisted setting so ordinary settings reads and historical values stay readable. The generic settings command still excludes this key, and no dedicated booking writer remains. Historical job-kind names remain recognizable, but no booking handler registers or producer schedules them. Pending historical jobs cannot execute through the current registry. Existing source-deletion database triggers, retention coverage and schema constraint tests remain because retained private provenance still needs erasure.

The outbound gate unconditionally refuses `standing_booking` origins with `step_ineligible: booking_automation_removed` before readiness or token/provider work. No standing-booking fence minting export remains. Existing sequence and explicitly approved human-reply paths keep their safeguards and conservative reconciliation.

## Local verification

`apps/api/test/leanBookingRemoval.test.ts` covers real mounted retired-route refusal, retained legacy reads, registered-worker absence and historical-origin refusal. Existing `bookingCapacity`, `crmBookingProgressJourney`, domain meeting/reconciliation/retention, worker Cal.com/recording and desktop operation/timeline tests cover retained seams. These are local source checks, not production smoke, provider acceptance or an installed desktop release.

Root owns review, integration and production. This branch must not merge before the root-owned actual schema116 smoke gate. No release infrastructure, migration, production setting or provider operation is changed by this deletion.
