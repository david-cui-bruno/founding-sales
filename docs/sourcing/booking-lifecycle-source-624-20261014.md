# Guarded booking lifecycle source evidence, October 14, 2026

Ticket: #624. Controlled code checkpoint: `8ba712eb0b99f85b4e6220569ef9914f863beecb`, based on the preserved shared stack at `d9fe291f04c4ef3b8a7b3c77fcd7475c71183630` (stack base `68fa2c9bb8f089fa2840d113ba502a4176b235fe`). This is source/control evidence, not live completion, model usefulness, release, provider acceptance or Enable.

## Ordinary seam and evidence class

The lifecycle tests use authenticated API commands/readback, the registered `crm.mail_capture`, `crm.booking_interpretation`, `meeting.booking_conversation`, existing guarded create/change and `booking.message_send` workers, and real disposable PostgreSQL. External capture, model, calendar and Gmail adapters are controlled. Sender infrastructure reuses `apps/api/test/support/bookingMessageFixture.ts`; no positive booking, interpretation, attendance, policy grant or dispatch state is inserted to manufacture a lifecycle outcome.

The native incoming fixture opens an opportunity with `/opportunities/v2/open`, records supported original RFC metadata with `recordMessage`, derives native matching authority with `findMatchCandidates`, records it with `recordMatches`, then publishes through registered canonical capture. RFC metadata is established before capture, not rewritten onto an immutable previously captured row. Current business source readback verifies the actual copied passage. Provider time, original participants, account generation, thread and source revision/hash remain canonical provenance.

Controlled policy/sender observation clocks and existing queue timers are advanced explicitly for due work. The actual sender business window, caps, holds, source/policy checks, reservation and irreversible dispatch marker remain in force. No permission flag, positive booking state, shared nudge counter or no-show decision is seeded or bypassed.

## Behavioral mapping

| Requirement | Observed source/control proof |
|---|---|
| Supported prior-offer agreement and mixed sales content | Authenticated canonical interpretation/admission, registered standing create, meeting/Today readback, exactly one appointment and actionable `answer_sales_question` quote. No invented public human-confirmation literal. |
| Attendee-requested cancel/reschedule | Newly captured original-thread attendee request, normal interpretation/admission, private guarded change, exactly one controlled write and current cancelled/rescheduled readback with stopped/replaced reminder receipt. |
| Automatic approved link | Normal admitted call interest queues the registered lifecycle and existing sender; sent receipt and controlled Gmail envelope bind the original thread, RFC reply reference and verified correspondent. |
| Automatic day-three/day-seven | Due registered jobs deliver precisely two shared scheduling nudges, then durable `two_unanswered_booking_nudges` David handoff. Restart adds no send. |
| Manual activity shares the bound | A normal manual-nudge event consumes the first ordinal. Superseded day-three work does not send or stop the remaining eligible day-seven work; only one automated nudge remains. |
| Any later canonical reply | A new captured incoming message stops pending create and pending automatic nudges without an appointment or extra send. Historical capture and exact capture replay do not stop the current accepted offer. |
| Explicit no-show only | Booking alone cannot confirm no-show. Signed controlled webhook readback permits a normal manual attendance command, then a normal conversation event schedules exactly one next-New-York-business-day 10:00 rebooking job. Registered lifecycle/sender deliver once; receipt replay/restart creates no duplicate. |
| Human attendance correction | Normal `attended` correction after scheduling makes the queued rebooking ineligible, with zero Gmail dispatches and no consumed rebooking allowance. |
| Privacy and replay | Deletion during controlled availability prevents write, clears private conversation references/fingerprint/thread/handoff, and old command replay returns current stale/redacted state without the sales quote. |
| Terminal freshness | Controlled readiness expiry during final authorization returns stale readback with no private outcome/handoff. |
| Lease and duplicate safety | Wrong fencing token and lease stolen during readiness observation prevent admission; rollback leaves zero submissions. Valid repeated handler execution admits one submission and restarted registered create dispatches once. |
| Existing sender safeguards | Reused sender journey covers current holds/caps/window, before-due refusal, manual/reply stops, exact original-thread receipt, source deletion, policy/sender loss after OAuth, aggregate-row-lock wait and unknown acceptance without replay. |
| Durable schema | 23 targeted real PostgreSQL failing-insert cases cover the conversation checks, reference/owner/workspace boundaries, target pairing and uniqueness. |

## Genuine failures and repairs

The retained paused suite had five `mail_match_authority_missing` failures. Its shell exit zero was not passing acceptance. Repair used actual native opportunity matching authority, not a relaxed guard or production fixture mode. Subsequent full lifecycle execution exposed no-show authority timestamp equality failure: PostgreSQL microseconds were truncated through JavaScript `Date`. The authority stamp is now copied and compared inside PostgreSQL, preserving exact original manual confirmation. Public attendance correction still invalidates it.

New registered due-job coverage genuinely failed when an already-counted manual nudge made the old day-three job hand off prematurely. Minimal repair schedules the remaining day-seven ordinal from the manual event and makes superseded due ordinals inert. A new stolen-during-read lease test genuinely failed on the older silent early return; the same exact lease assertion now rolls back uniformly before admission.

## Focused checks

Pinned runtime: Node 24.20.0 from the existing local scratch runtime, with existing installed dependencies.

- API and worker type checks passed in the final focused run. Contracts and domain type checks also passed.
- `npm run test --workspace apps/api -- test/bookingConversation.test.ts test/bookingMessagesJourney.test.ts test/bookingMessages.test.ts`: **32 passed**, including **13 lifecycle cases** and **19 existing sender/product cases**. Retained successful task: `366993hc3n`.
- `npm run test --workspace packages/domain -- test/db/constraints.test.ts -t booking_conversation`: **23 passed**, unrelated cases skipped. Retained task: `235477ehbw`.
- ESLint on all seven owned TypeScript paths and `git diff --check` passed.

## Complete lifecycle ownership inventory

Previously committed owned route, unchanged during recovery:
- `apps/api/src/routes/bookingConversation.ts`

Eight paths in the controlled code checkpoint:
- `apps/api/test/bookingConversation.test.ts`
- `apps/worker/src/handlers/bookingConversation.ts`
- `packages/contracts/src/bookingConversation.ts`
- `packages/domain/db/migrations/0115_booking_conversations.sql`
- `packages/domain/meetings/bookingConversation.ts`
- `packages/domain/meetings/bookingConversationAuthority.ts`
- `packages/domain/meetings/bookingConversationChangeAuthority.ts`
- `packages/domain/test/db/support/bookingConversationCases.ts`

This evidence document is the only additional documentation path. The previously untracked change-authority and constraint dependencies required by root `ab247363` are included in the code commit. Parent shared create/change, bootstrap/jobs/routes registry/catalog/outcome/desktop and other-owner outbound/message paths were not edited during recovery. Preserved work was neither reset, stashed nor deleted.

## Remaining integrator and operational gates

Default composition remains unavailable and saved policy/view `enabled:false` remains unchanged. Actual LinkedIn capture/sender and provider confirmation/one-hour reminder capabilities remain visibly unverified; controlled change/reminder receipts do not establish actual provider behavior. No duplicate Callie reminder or SMS is introduced.

The integrator still owns full gates, actual retained-schema 88-to-116 upgrade, unchanged all-ref secret verification, independent combined medium-effort Spec/Standards/risk review, exact-head CI and publication. No children, full gates, upgrade, secret scan, shared edit, GitHub write, push, merge, deployment, Enable, account/provider access, real send/booking or paid call was performed by this ownership lane.
