# Meetings: Cal.com bookings, attendance, and the pipeline

Call-to-booking slice W (migration 0028). A demo booked through Cal.com becomes a
`meetings` row and stops cold outreach to the firm. Since lane M1 (migration 0039) it
**moves no deal**: deal-stage changes are manual (David, 3 October 2026), and the board and
the firm page offer "Move to Demo booked" as one click instead (below). Attendance is
confirmed by a person, never assumed from Cal.com's end (below). Off by default: with `calendar_integration` off the webhook
answers 404 and nothing reads the Cal.com secret.

## The switch

`calendar_integration` `{"integration": "off" | "calcom"}`. **David turns Cal.com on in
Settings → Calling & calendar**; the switch cannot be turned on while the Cal.com webhook
secret is missing. It is written with `POST /settings/update` (not in the `GET /settings`
snapshot; see [calling.md](calling.md)). The webhook serves **the one workspace** with the switch on:
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
* Which workspace a delivery lands in — the one with the switch on — is decided and
  applied in one transaction under the **calendar routing lock** (below), shared.

## What a booking does

1. **Match the firm** by the attendee's e-mail address (a contact's address), then by
   the e-mail domain against a firm's website domain. No match, or more than one, opens
   a stage review item (`firm_unmatched` / `firm_ambiguous`) and the meeting stays
   unlinked; nothing else happens.
2. **No stage change.** Until lane M1 the booking applied stage evidence `meeting.booked`
   (`applyStageEvidence`), which moved the open opportunity to Demo booked or opened one
   there. It does not any more, from the webhook, the reconciliation or a person's match;
   no evidence row is written either (an evidence row belongs to a stage event).
3. **Manual control** for the firm's open opportunity, if it has one (origin
   `engaged_call`, reason "meeting booked").
4. **Stop prospecting**: live `prospecting` and `cold_legacy` enrolments at the firm
   stop, with an audit row. A `follow_up` enrolment the prospect agreed to on the call
   is left running.
5. Funnel fact `meeting.booked` (keyed by the booking uid).

A reschedule updates the times and the current booking uid, and moves `booked`,
`rescheduled` and `ended` to `rescheduled`; it never changes `held` or `no_show`. A no-show
mark remembers the state it replaced so an unmark restores it.

## Attendance (lane M1, migration 0039)

Cal.com's `MEETING_ENDED` fires at the booking's **scheduled** end, so it is not attendance.

| State | Means | Set by |
|---|---|---|
| `ended` | the scheduled end passed; attendance not confirmed | `MEETING_ENDED` (webhook or the reconciliation's end) |
| `held` | confirmed attendance | a person (`manual`); later a recording (`recording`) |
| `no_show` | confirmed absence | Cal.com's no-show flag (`calcom_no_show`) or a person (`manual`) |

`attendance_source`, `attendance_confirmed_at` and `attendance_confirmed_by` (the member,
for `manual` only) are set exactly while the state is `held` or `no_show`.

* **A confirmation is never overwritten by Cal.com.** An end, a reschedule, a cancellation
  or Cal.com's no-show flag leaves `held` and `no_show` as they are (a reschedule still moves
  the times); Cal.com's unmark undoes only Cal.com's own mark. The reconciliation plans none
  of those events over a confirmation. Folding duplicate rows keeps the latest confirmation
  any of them holds, whichever row is newest.
* **A person confirms** with `POST /meetings/attendance { meetingId, attendance }`:
  `attended` → `held`, `no_show` → `no_show` (remembering `ended`), `unconfirmed` → back to
  `ended`. The assignee or an administrator; a meeting matched to a firm
  (`meeting_unmatched`), not cancelled (`meeting_cancelled`), whose start has passed
  (`meeting_not_started`). `unconfirmed` never undoes Cal.com's no-show
  (`attendance_from_calcom`) or a recording's confirmation (`attendance_from_recording`); a
  person may still choose Attended or No-show over Cal.com's flag. Idempotent per command id,
  audited (`meeting.attendance_set`: ids and codes only). It sends nothing.
* **The funnel.** `meeting.held` is written only on confirmed attendance, dated at the
  meeting's start, keyed by its original booking uid. Undoing it, or replacing it with a
  person's no-show, **withdraws** the fact (`withdrawn_reason attendance_unconfirmed`, see
  [funnel.md](funnel.md)); confirming again reinstates the same row. Nothing is written for
  `ended`.
* **The firm page** shows an ended meeting as "Ended · attendance not confirmed" with quiet
  Attended and No-show actions on hover; a person's own Held or No-show has a small Undo. The
  board card says "Ended, not confirmed".
* **M7** (the follow-through engine) gates on confirmed attendance: its hook is where a
  meeting becomes `held` in `meetings/attendance.ts`. M1 schedules nothing.
* **0039's correction.** Every `held` stored before it came from the scheduled end, so it
  became `ended` (and a no-show remembering `held` remembers `ended`); every stored no-show is
  Cal.com's; every `meeting.held` fact was withdrawn (`scheduled_end_not_attendance`) and
  re-dated to its meeting's start; one `meeting.attendance_corrected` audit row per workspace
  holds the counts. `fss admin meetings attendance-report` counts all of it read-only.

**Every uid a meeting has been** is kept in `meeting_booking_uids` (migration 0029:
workspace, uid, meeting; unique per workspace; removed with the meeting). A delivery
finds its meeting through that table, so a late event about an intermediate booking of
A → B → C still reaches the one meeting (and a late, older create of B is `stale`).
`meetings.booking_uid` and `current_booking_uid` stay as they were: the original and
the current uid. An alias is never dropped; when two meetings turn out to be one
booking they are folded and the loser's aliases move to the survivor.

**A fold never loses an attendee.** A survivor with no attendee takes the folded row's,
so a deletion that takes the meeting still measures and tombstones the person. Rows
booked by two different attendees (compared NFKC, trimmed, lower-cased) are **not**
folded, by the webhook or by the hourly read: each keeps its own uids, and one review
item `meeting.attendee_conflict` per membership asks a person. Its key is `c` plus the
sha256 of the sorted meeting ids. Its detail is the complete membership and nothing else
(`meetingIds`, comma-separated). Its reason is `firm_ambiguous`, because 0028's reason
list has no other fitting value. It is not a `meeting.booked` item, so **Bookings to
match** does not list it. A deletion that takes **any** member takes the item, found by
that list. A membership whose list would not fit 0028's 2,000-character detail is not
recorded; the rows stay apart all the same and the read counts it in
`conflictsUnrecorded`, never failing the run. A chain names at most 51 uids, which fit.
The webhook answers such a reschedule `unmatched` and changes neither row; the read
counts the chain as `conflicted`.

An event about the meeting's **current** booking that carries times sets them, whatever
its trigger: a meeting linked to a successor whose body was never read (below) takes
that booking's times from its first event, a cancellation included. As every event, it
applies only when the ordering lets it; a cancelled meeting stays as it is.

## Lock order: routing, then the send gate, then rows

Cal.com names no workspace, so "the one workspace with `calendar_integration =
calcom`" spans every workspace and has a lock of its own, across the deployment:
`pg_advisory_xact_lock(hashtextextended('fss.calendar-routing', 0))`
(`packages/domain/policy/calendarRouting.ts`).

* **Readers take it SHARED**, before the workspace's send gate: the webhook, around its
  routing decision and the apply, and the hourly read, around its last routing check
  and the apply. Two deliveries never wait for each other on it.
* **A write of `calendar_integration`, in any workspace, takes it EXCLUSIVE**, then that
  workspace's send gate, then the setting's own lock (`settings/store.ts`). Turning A
  off or B on either commits before a reader decides, or waits until the reader has
  applied.
* Everywhere: the routing lock, then the workspace's send gate, then rows (firm, then
  meeting, then what `applyStageEvidence` locks). Nothing takes the routing lock after
  the gate. A deletion takes the gate only.

## The secret

Secrets Manager entry `<prefix>/calcom`, a JSON object:
`{"webhook_secret": "...", "api_key": "cal_..."}`. The shape is read in one place,
`packages/domain/meetings/calcomSecret.ts`, by both processes.

* `webhook_secret` (required, at least 16 characters) is the API's: without it the
  entry is not configured, and the webhook answers 503 and `integration_unconfigured`.
* `api_key` (optional; a Cal.com key, `cal_` or `cal_live_`) is the worker's, for the
  reconciliation below. Without it reconciliation is simply off, which is not an
  error; a value that is not a Cal.com key is reported by name (`field:api_key`) on the
  worker's startup line (`calcom_reconcile`) and reconciliation stays off.

A problem is always reported as a field name, never a value. As with `twilio-voice`,
put a value (`{}` is enough) in the entry **before** the apply that adds it to a task,
because ECS refuses to start a task whose secret has no value.

Both the API task and the worker task are given the entry
(`infra/modules/cluster/main.tf`, `api_secret_names` and `worker_secret_names`). It
already holds a value in production (`{}`), so both tasks start; the worker's startup
line says `calcom_reconcile: absent` until an `api_key` is put in it. A rehearsal fills
the entry with `{}` (`greenfield-release.yml`), so a rehearsal worker never calls
Cal.com.

Cal.com console: a webhook to `<public origin>/integrations/calcom/webhook` with the
five triggers above and the same secret; and, for reconciliation, a Cal.com API key
in `api_key`.

## Reconciliation (slice M1)

A webhook Cal.com gave up on would leave a demo booked in Callie that was cancelled or
moved in Cal.com. So once an hour the worker's `calcom.reconcile` job reads Cal.com's
bookings and repairs the difference.

* **When.** Only in a worker with an `api_key`, and only for the one workspace with
  `calendar_integration = calcom` (the webhook's rule; with two, neither). One job an
  hour (`calcom-reconcile:{workspace}:{hour}`), in the bulk lane. The job asks again when
  it runs and once more just before it applies what it read: if its workspace is no
  longer the one switched on, it does nothing and logs `calcom_reconcile_skipped`. The
  last check — this workspace on, and no other — is made in the applying transaction
  **after** it takes the calendar routing lock (shared) and the workspace's send gate.
  Every write of `calendar_integration` takes the routing lock exclusive, so switching
  this workspace off **or another one on** either lands before the check (and nothing
  is applied) or waits until the run has committed.
* **What it reads.** Cal.com API v2 `GET https://api.cal.com/v2/bookings` with
  `Authorization: Bearer <api_key>` and `cal-api-version: 2026-05-01`, for bookings with
  `afterStart = now − 7 days` and `beforeEnd = now + 60 days`, every status, 100 a
  page, following `pagination.nextCursor` while `pagination.hasMore`
  ([get all bookings](https://cal.com/docs/api-reference/v2/bookings/get-all-bookings),
  [introduction](https://cal.com/docs/api-reference/v2/introduction)). At most ten
  pages and thirty seconds of fetching, and each request is given only what is left of
  the thirty seconds; a run cut short by either says `truncated` and applies what it
  read. Any other failed request fails the job, which the runner retries; nothing is
  applied until the read is over.
* **Chains, whatever the status.** Cal.com marks the old half of a reschedule
  `cancelled` and names the new one (`rescheduledToUid`; the new one names the old,
  `rescheduledFromUid`). The bookings are first joined into reschedule chains through
  those two fields regardless of status, and each chain is compared with its one
  meeting — found by any uid in it. If the chain's uids resolve to two or more meetings
  (a lost reschedule A → B, then B's cancellation webhook made a row of its own, say)
  they are **folded first**, even when the newest row is already cancelled: the
  meeting of the chain's oldest uid survives, takes the newest state, times, current
  uid and last event, the others' events and aliases, and a firm link if it had none;
  the others and their unresolved booking review items go (audit `meeting.folded`).
  Every uid of the chain is then an alias of the survivor.
* **What it does.** Every difference becomes a **synthesized event fed to the webhook's
  own path** (`receiveSynthesizedCalcomEvent` → `applyEvent`): the same `calcom_events`
  dedupe, the same ordering, the same folding of reschedules, the same matching, the
  same `applyBooked`.
  * A chain whose meeting is known must contain the meeting's current uid; otherwise the
    meeting has moved past what this read knows (a newer webhook) and nothing is done.
    Each link after the current uid is a `BOOKING_RESCHEDULED` (old → new), dated at the
    new booking's `createdAt`, then the newest booking's own state: `BOOKING_CANCELLED`,
    or for an accepted booking a `BOOKING_CREATED`/`BOOKING_RESCHEDULED` if its times
    differ.
  * A chain with no meeting is recorded from its newest booking — accepted, or
    **cancelled**: a cancellation Callie never saw is recorded as a cancelled meeting
    (matched or not, exactly as a cancel-first webhook is), so a late, older create is
    `stale` instead of booking a demo that is not happening — followed by each older
    link, newest first, so every original uid lands on the one row.
  * A chain whose newest booking was moved again to one this read does not list (beyond
    the window, `rescheduledToUid = B`) still records the link (review fold 3). B's
    uid becomes an alias of the chain's meeting, and a row B already has (its
    cancellation came first, say) is folded in. When the meeting stands at the moved
    booking and the snapshot is no older than its last event, its current uid becomes B
    and its state `rescheduled`; a held or no-show meeting keeps its state. Its times
    stay the old booking's until B's body arrives, by webhook or a later read. Its
    `last_event_at` is not moved, so B's own events still apply (`successors` in the
    counts). A booking whose `rescheduledFromUid` was not listed is already part of
    its chain.
  * Derived events — an end (`MEETING_ENDED`), a no-show mark (an attendee `absent`) or
    its reversal — come only from a snapshot whose `updatedAt` is no older than the
    meeting's last applied event, and only about the meeting's current booking. An end
    is dated at the later of the booking's `end` and just after the meeting's last event,
    so a meeting whose no-show mark was taken back after its end still becomes ended on
    the next run.
  * `pending`, `rejected` and `awaiting_host` are skipped, as the webhook ignores
    `BOOKING_REQUESTED` and `BOOKING_REJECTED`. A cancelled meeting is terminal.
* **Deleted people stay deleted.** A deletion (`retention/deletion.ts`) records a
  `deletion_tombstone` suppression for every address it removes, the attendee of every
  meeting it removes included. A chain with no meeting whose attendee has such a
  tombstone is not recorded (`tombstoned` in the counts), so the hourly read never
  brings the person's booking or address back.
  * One canonical form of an attendee address (`meetings/attendee.ts`): NFKC, trimmed,
    lower-cased. The webhook and the hourly read parse with it. An attendee the
    suppression canonicalizer refuses (`josé@law.example`) is tombstoned under that
    same form as a fallback key, and the hourly read looks the attendee up by it, so
    such an address cannot come back either.
  * The deletion takes the workspace's send gate **before** it measures and validates
    its preview. A booking committing meanwhile either commits first — the measure
    sees its meeting, the preview is `preview_stale`, and the next preview tombstones
    the attendee — or waits until the deletion has committed.
* **Identity of a delivery.** sha256 of
  `reconcile:{uid}[:{old uid}]:{trigger}[:{no-show flag}]:{status}:{instant}`, so a
  replayed run is a duplicate and applies nothing; its `createdAt` is the booking's own
  `updatedAt` (a link: the new booking's `createdAt`), so a webhook newer than the API's
  answer stays authoritative and the older event is recorded `stale`.
* **What it never does.** It never deletes a meeting, and a booking the API no longer
  lists leaves its meeting alone. It sends nothing to anybody.
* **What it leaves behind.** A log line `calcom_reconcile` with the counts (bookings,
  chains, unchanged, skipped, tombstoned, synthesized, applied, stale, duplicate,
  unmatched, successors, conflicted, conflictsUnrecorded, pages, truncated) and, when anything was synthesized, one audit event
  `meeting.reconciled` with the same counts. Never a booking's details.

## Matching a booking by hand (slice M1)

A booking Callie could not attach to a firm (`firm_unmatched`, `firm_ambiguous`) is
listed on the Pipeline screen under **Bookings to match**, with the attendee's address,
the time and a firm picker (the board's own firm search). Picking the firm and pressing
Match sends `POST /meetings/match { meetingId, firmId }`:

* the assignee of the firm or an administrator (`not_assigned` otherwise; a merged firm
  is `firm_merged`); a meeting already attached to a firm is `meeting_already_matched`;
* the meeting names the firm and the contact whose address the attendee booked with,
  or a new contact at the firm with that address (named by the address until somebody
  types a name) when nobody there has it;
* the meeting's review item is resolved by that person;
* unless the meeting is cancelled, the booking is then applied **exactly as a matched
  webhook applies it** (`applyBooked`): manual control, the stop owed to prospecting and
  cold_legacy enrollments (an agreed follow-up keeps running), the funnel fact. It moves
  no deal (lane M1); the answer's `stage` is always `none`.

Lock order, as every stop-fact writer: the send gate, then the firm, then the meeting,
then what `applyStageEvidence` locks. Every refusal reaches the window as its sentence
(`reasonText.ts`, `MEETING_MATCH_REFUSAL_SENTENCES`).

`GET /meetings/unmatched` (any active member) is the list; `GET /meetings/firm?firmId=`
(any active member: state and time are Appendix F's first row) is the firm page's
**Meetings** rows. None of the three reaches Cal.com or depends on the switch.

## Reminders

Callie sends no reminder of its own. Cal.com already sends the attendee the 24-hour
reminder and the calendar invitation, and a booking or a reschedule enqueues no e-mail,
no step and no job to the attendee (`apps/api/test/calcomDepth.test.ts`).

## The pipeline these moves land in

0028 replaced the default stages with Interested (`new`), Demo booked
(`demo_booked`), Decision pending (`qualified`), Onboarding (`onboarding`), Live
(`won`) and Lost (`lost`). Open opportunities in the retired `contacting` and
`engaged` moved to Interested, and `proposal` to Decision pending, each with a stage
event (reason `stage_remap_20260930`). `fss admin pipeline stage-counts` prints each
workspace's stages with their counts, pins and remap moves, read only, for the before
and after of the release.

Stage changes are manual (lane M1). What is left of `stage_rules`: `call.interested`
opens an opportunity at Interested only on a person's accept of the after-call suggestion
(`calls/proposalApply.ts`); `subscription.accepted` → Onboarding and `customer.live` → Live
have no emitter. The `meeting.booked` rule stays only because past evidence rows name it;
nothing applies it. A firm merge closes the merged firm's opportunity as Lost, inside a
person's merge. A person's move pins the opportunity at that stage.

**"Move to Demo booked"** (`meetings/stageSuggestion.ts`) is offered on the board card and
in the firm page's Meetings when the firm has a booked or rescheduled meeting that has not
ended, the workspace's Demo booked stage is live, and the firm's open deal is in an earlier
stage — or it has no deal at all (a closed one alone gets nothing). Only to a person who could
make the move. The click is the ordinary command: `POST /opportunities/stage`, or
`POST /opportunities/open` at Demo booked for a firm with no deal.
