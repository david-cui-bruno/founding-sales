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

## Independent review repairs and integration checkpoint, October 14, 03:56 UTC

The earlier ownership-lane results above remain dated evidence. Independent review of the frozen `983b3355` source identified six material gaps. The isolated integration checkpoint `c645c232e70bf3f7fc3a018be68a14c79d9f42c7` contains these bounded corrections:

| Review gap | Correction and observed behavioral evidence |
|---|---|
| A cropped affirmative could hide an authored instruction not to book | The canonical interpretation outcome now withholds whole-authored booking negation. The standing-create authority reader also checks the current canonical authored passage, so a historical persisted positive cannot bypass the producer correction. Public-path regressions retain unique prior-offer affirmative and quoted-negation controls. The historical proposal regression explicitly uses fixture SQL only to represent an old persisted result, not to claim a supported mutation command. |
| Retained target references could block scoped subject deletion | Source redaction and a meeting-deletion trigger detach the target meeting and provider UID together while preserving the body-free aggregate and irreversible submission evidence. Normal firm/contact retention preview and commit now complete for cancellation and rescheduling targets. |
| A queued local fence retained its copied private source subject | Before erasing source references, the owning redaction function replaces the copied subject only on unattempted standing-booking fences. Attempted/unknown/sent evidence and receipt identity remain conserved. Normal explicit source-copy deletion verifies the canned subject and zero dispatches. |
| Reinterpreting the same agreement reset the shared two-touch maximum | A workspace/owner/canonical incoming-source episode key reuses the original aggregate across model reruns, preserving its original provenance, shared manual/automatic counter and terminal stop. A different incoming source can establish a different episode. |
| A signed booking did not stop an approved-link nudge | Current aggregate eligibility observes the canonical matching booking, including its attendee, organizer, firm/contact and post-agreement timing. Both due-work discovery and terminal message permission refuse the now-booked episode. No enrollment state or invented human decision substitutes for booking evidence. |
| Importing automation's own Sent metadata interrupted its next nudge | Exact owned fence/provider/RFC identity distinguishes this episode's own automated Sent messages from later incoming replies, manual outgoing activity and unrelated fences. Registered mail-sync regressions verify day-three/day-seven continuation and the negative stop controls. |

The checkpoint also incorporates the reviewed interpretation admission/private-read repair and stable command identity after an unknown desktop response. The normal mounted test forwards an actually committed, financially settled request before losing or corrupting its response, then retries the same command and observes one request/model invocation. Current-session and captured-expiry checks cover source waits, final authorization and transaction-response waits without adding a second provider observation.

Main integration retains the reviewed current-revision-only posting-policy fence and keyset queue discovery, while preserving the recurring worker's additional freshness checks. The source checkpoint does not itself attest a live booking, Gmail send, model quality or native acceptance.

Integrator observations on that exact source checkpoint:

- `048711e22z`: full `typecheck:greenfield`, root lint and **153 selected API tests** passed. These include normal lifecycle, scoped deletion, historical negation, shared stops, mail sync, message delivery, interpretation admission/replay, posting-policy and route inventory paths. Working tree and diff checks were clean.
- `056942vszt`: actual retained-schema **88-to-116 upgrade passed**, including startup range refusal, registered controlled workflow checks and failed-migration rollback. The strict constraint/catalog suite and migration tests passed **2,802 tests**. Evidence is retained in `founding-sales-lifecycle-repaired-upgrade-116-20261014`; this executed upgrade is not a production rollout.

The newly reviewed parent create slice still requires its effective-stop, post-dispatch subject-deletion and ordinary read/create lock-order corrections to be integrated and revalidated here. Complete-source independent reviews, final exact-head gates/CI and the final all-ref secret scan remain integrator work. Actual scope activation and provider/usefulness evidence remain held under #625 and the relevant release controls.

## Subsequent frozen-review repairs, October 14, 05:19 UTC

The independent combined review of `21ae7f7a` found additional ordinary-path races and episode/readback gaps. These are distinct from the earlier corrections and are not a claim that the prior checkpoint was fully accepted.

| Gap | Frozen correction and behavioral evidence |
|---|---|
| Exact-session loss during conversation request, event or message admission could still commit work | `a6a50888` performs current exact-principal authorization inside the ordinary command transaction after the owned waits, rolling back unauthorized receipts, jobs and counters. Final conversation/message reads and command replay also reauthorize after transaction completion. Six durable admission races and ten private read/replay races genuinely failed before repair. Two additional isolated captured-expiry cases crossed the forwarded COMMIT-response wait and now refuse the stale observation without another provider evidence read. Three active replay controls remain positive. |
| Cancelling a booking could restart its original approved-link chasing episode | `69148d27` observes applied canonical booking/rescheduling history with the existing exact attendee, organizer, owner, subject and post-agreement restrictions. A later cancellation does not erase the episode's booking stop. Public signed-event tests cover cancellation before a read, after an observed stop and after a nudge is queued, plus unrelated-booking controls. |
| Retained-original metadata refresh erased the partial episode-index key and reset shared counters/stops | `69148d27` and the owning schema change use a stable opaque SHA-256 workspace/owner/canonical-source episode key, independent of the erased provenance array. Registered `crm.mail_backfill` refresh tests genuinely reproduced renewed admission after two manual touches, mixed manual/automatic touches, refusal and opt-out. Re-admission now retains the original stale aggregate and its counters/stops, without restoring erased references. A new canonical incoming source remains a distinct episode. |
| Public source deletion and standing sender claim could acquire source and outbound-fence rows in opposite orders | `e608cd5b` takes the existing stop-fact gate before direct source deletion/restoration acquires its canonical closure. A real PostgreSQL `40P01` was observed before repair. Sender-first, deletion-first, source-only restore and indeterminate-acceptance controls preserve irreversible evidence and prohibit replay. The separate registered metadata-writer interaction is still undergoing bounded source-order validation, so this row is not a blanket lock-order acceptance claim. |
| A reused server-canonical episode became unreadable from its newer interpretation | `f4443515` binds subsequent reads to the admitted canonical conversation and original interpretation identity within the current renderer epoch, rather than inventing a new provenance ID. A real PostgreSQL mounted journey reinterprets the same source, reuses the original episode and preserves counters and reply stops. Wrong identity, scope change and stale-response controls remain fail-closed. |

The episode schema requires a 64-character lowercase hexadecimal `episode_key` and a workspace/owner/key uniqueness constraint. Source erasure keeps this opaque identity only to preserve limits and stops. It does not restore source authority, copied content or permission.

Integrator checks on the composed `f4443515` source plus the owning episode schema changes:

- `678280c8u2`: full `typecheck:greenfield`, **60 API tests** across six affected suites, **one real PostgreSQL mounted reused-episode journey**, and **20 renderer component tests** passed. These counts describe that selected run, not the complete project suite.
- `2389646ith`: the complete **2,783-test constraint/catalog suite** passed after updating all conversation prerequisites for the required episode key.
- `740735ajri`: the actual retained-schema **88-to-116 upgrade passed**, including ordinary controlled workflow checks, startup compatibility refusal, idempotent migration rerun and failed-migration rollback. Evidence is retained in `founding-sales-stable-episode-upgrade-116-20261014`.

These checks do not cover the forthcoming metadata-writer/sender followthrough or final booking-change parent composition. Those changes, final combined independent reviews, exact-head full gates/CI and secret verification remain pending. No live provider operation, paid model call, release, deployment or Enable follows from this source evidence.

At 05:23 UTC, the metadata-writer followthrough was frozen separately in `b8a61c4834b31bf921f4b1a969eeb98d850c1a79`. A registered `crm.mail_backfill` worker and the standing sender genuinely reproduced both PostgreSQL blocking edges and `40P01` before repair. The standing sender now acquires the existing canonical source/identity closure before locking its fence. The prelock decision is explicitly ignored as a grant. The locked full permission, current source/sender/policy, shared counter consumption, captured deadlines and dispatch marker remain the actual admission boundary. Generic step/draft origins retain their existing lock path. The ownership lane reported 127 selected passing test executions, a final five-control rerun, domain/API type checks, scoped lint and diff checks. These are bounded repair observations, not final combined gates or live provider evidence.

## Full integration gates and final-review followthrough, October 14, 05:56 UTC

The clean integration checkpoint `c248362ba3b283dc340ffba3764ac653047af0d7` incorporates the frozen source-order followthrough, guarded booking-change parent `5143c780`, and the reviewed database-clock-relative commitment-deletion fixture correction. Integrator checks on that exact checkpoint passed:

- Full greenfield type checks and root lint.
- All contracts: **105 passed**. All domain: **5,781 passed, five skipped**. All worker: **856 passed, one skipped**.
- All API: **2,287 passed, one skipped**. The first local command exceeded its ten-minute tool deadline, without a reported assertion failure. The unchanged renewed full command completed successfully in 562 seconds.
- All desktop: **2,071 passed, 30 skipped**. Operations: **733 passed**. Ask evaluation: **16 passed**. Dedicated real PostgreSQL mounted policy: **eight passed**. Dedicated real PostgreSQL reused-episode mount: **one passed**.
- Actual retained-schema **88-to-116 upgrade passed**. Evidence is retained in `founding-sales-final-lifecycle-c248-upgrade-116-20261014`.
- The unchanged all-history secret verifier passed with **zero findings** across 23,877 historical file versions, 6,080 paths, 154 scan batches and 3,531 current-context files. A prior history-consistency refusal during shared Git-ref changes was not a secret finding and was not bypassed. The unchanged retry ran without concurrent ref mutation.

Independent full-feature Spec, Standards and authorization/privacy/money reviews of `5143c780` to `c248362b` still requested three bounded corrections. Passing full suites did not override those findings. The isolated code successor `ed74d4c9d0071dad4bd399afd5f9fd3e67a4be58` contains:

| Final-review finding | Bounded correction and observed evidence |
|---|---|
| A cropped affirmative could still conceal authored attendance/time negation | `1c40463d` extends the existing withholding-only canonical negation helper used by both candidate production and standing-create revalidation. Six public controlled journeys genuinely made one unauthorized provider write before repair. Seventeen new standalone cases now cover zero-write refusals, historical persisted proposals against unchanged current sources, and positive/quoted-history controls. No new model grammar, permission or authority port was added. |
| No-show logistics depended exclusively on an accepted create submission | `ed74d4c9` resolves the same admitted source episode through existing exact operational matching, current UID and applied lifecycle history. Current signed-link bookings and accepted attendee-reschedule episodes can use David's explicit manual attendance confirmation. Native timestamp equality, known UID, source/owner/organizer/attendee scope and one-use consumption remain required. Accepted change receipts and their historical original-target pair are not rewritten. Two original public cases genuinely refused with `accepted_booking_required`; 26 new cases and 73 affected regressions now pass. A further genuine delayed-callback refusal test proves a provider event created before the manual stamp but received afterward cannot reuse that predecessor UID's attendance. Both native event-time and received-time boundaries are checked. |
| Actual booking-message success DTOs were checked only with tolerant parsing | `46d3e215` adds independent `wireDrift` assertions to real authenticated POST, GET and subsequent deduplicated command responses. The actual one-send registered-worker journey passes, while an extended-answer detector control confirms desktop-compatible stripping cannot conceal undeclared route fields. This is test-only coverage, not a previously observed production wire defect. |

The contradiction owner reported 552 passing selected executions across 18 suite files, including its 17 new standalone cases. Some existing suites re-register imported tests, so this is not a claim of 552 unique behaviors. Both repair owners passed scoped domain/API/worker type checks, owned lint and diff checks. The successor changes only five source/test paths, with no schema or public-input expansion.

These final bounded repairs still require integrator exact-head revalidation and independent affected-delta closure attached to the preserved complete reviews, followed by required CI and ordered integration. The full `c248362b` counts above must not be relabeled as full-suite results for the later successor. Source merge, controlled original-thread sends and controlled booking acceptance do not authorize or attest release, deployment, actual provider/model usefulness or Enable. Those operational gates remain separate under #625.
