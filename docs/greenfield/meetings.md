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
  of those events over a confirmation. Folding duplicate rows keeps a confirmation any of
  them holds, whichever row is newest: a person's beats Cal.com's whatever the timestamps,
  and between two of the same kind the newest wins.
* **Cal.com's no-show applies only once the start has passed** — the start the same write
  leaves, so a successor still holding its predecessor's times is judged by its own. A flag
  before then is kept, not applied: `calcom_absent_pending` (the delivery's outcome is
  `ignored`; the state and the event ordering do not move). Once the start has passed, the
  next delivery of any kind or the next reconciliation run makes the meeting `no_show`
  (source `calcom_no_show`) — an end becomes `no_show` rather than `ended` — whatever the
  booking snapshot's freshness, unless a person confirmed it. Cal.com's unmark, a reschedule,
  a cancellation and a person's confirmation clear it
  (`meetings_absent_pending_unconfirmed`: only an unconfirmed, live meeting holds one).
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
  `ended`. A fold of duplicate rows (the reconciliation's or a reschedule's) leaves exactly one
  counted `meeting.held` for a held survivor — its own uid's first, else the earliest — and none
  for any other state, withdrawing the rest (`meeting_folded`) in the fold's transaction. A
  fold keeps the firm association (firm, contact, opportunity) of whichever row has one, before
  the facts are reconciled; two rows matched to different firms are not folded, and a person
  is asked as for two attendees (`meeting.fold_refused`, reason `firm_conflict`).
* **The firm page** shows an ended meeting as "Ended · attendance not confirmed" with quiet
  Attended and No-show actions on hover; a person's own Held or No-show has a small Undo. The
  board card says "Ended, not confirmed".
* **Desktop 1.0.36 is the minimum.** 1.0.35 reads a meeting past its end as `held` and has
  no way to confirm, so the API's client-version minimum is 1.0.36 from this release
  (`CONTAINER_CLIENT_VERSIONS`): publish desktop 1.0.36 before the API is deployed. A session
  opened by an older build keeps reading until it renews, so the meetings and board reads
  answer it in the shape it parses (`routes/meetingCompat.ts`: no `attendanceSource` or
  `stageSuggestion`, and `ended` reads `booked`), and its first command's 426 takes the running
  desktop to "Update now".
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

## What the booking says (lane M2, migration 0040)

Besides its times, a meeting keeps what its booking says (`meetings/bookingDetails.ts`):

| Column | From the webhook | From the API (reconciliation) |
|---|---|---|
| `event_title` (≤ 300) | `title` | `title` |
| `attendee_name` (≤ 200) | `attendees[0].name` | `attendees[0].name` |
| `booking_notes` (≤ 4,000) | `additionalNotes`, else `description`, else `responses.notes.value` | `bookingFieldsResponses.notes`, else `description` |
| `booking_answers` (question → answer, text, ≤ 1,000 each, ≤ 8,192 bytes as PostgreSQL prints the jsonb; the writer keeps 8,000) | `responses` by `label`, skipping hidden fields | `bookingFieldsResponses` by slug |
| `location_type` (≤ 80) | `videoCallData.type`, else `zoom_video` for `integrations:zoom` or a Zoom URL, else `integrations:…`, `link` or `other` | the same, `zoom_video` for a Zoom URL |
| `video_call_url` (https, no query or fragment) | `videoCallData.url`, else `metadata.videoCallUrl`, else `location` | `location`, else `meetingUrl` |
| `zoom_meeting_id` (digits) | `videoCallData.id` when `type` is `zoom_video`, else read from a Zoom join URL | read from the Zoom join URL |

Sources: Cal.com's webhook reference (https://cal.com/docs/developing/guides/automation/webhooks),
its API v2 bookings list (https://cal.com/docs/api-reference/v2/bookings/get-all-bookings) and
the Zoom app's adapter, which returns `{ type: 'zoom_video', id: String(zoom.id), password, url:
join_url }` (https://github.com/calcom/cal.com/blob/main/packages/app-store/zoomvideo/lib/VideoApiAdapter.ts).

| `details_observed_at` | the delivery's `createdAt` | the booking's `updatedAt`, else `createdAt` |

**Never stored:** the call's passcode (`videoCallData.password`, and a join URL's `?pwd=`), and
among the answers the booker's name, address, phone numbers, guests, location choice and
reschedule reason, and any custom question whose field or label asks for contact details
(a word, or two adjacent words joined, beginning `phone`, `mobile`, `email`, `whatsapp`,
`sms`, `address`, `street`, `zip`, `postal`, `firstname`, `lastname`, `fullname`,
`surname`, …; or the whole question `name`). Nor a question named `__proto__`,
`constructor` or `prototype`.

**Freshness** (review M2R). The details carry their own time, `details_observed_at`: the
source time of the delivery or the API read that last set them (0040's
`meetings_details_observed`: set exactly when a detail is). A source at least as new replaces
what it says (a null never clears a field); an older source — a late webhook, a delayed
reschedule, an older reconciliation snapshot — only fills empty fields. A source that names a
location describes all three conferencing fields together: when the kind of location changes
(Zoom → Google Meet, a video call → a street address), the stored type, URL and Zoom id are all
replaced, cleared where the source has none; when it names the same kind without the call's
data (a `MEETING_ENDED` says `integrations:zoom` and carries no `videoCallData`), the URL and
id are kept. A source silent on location keeps all three. A fold composes each field from the
row observed most recently, the three conferencing fields as one. They go with the meeting on
deletion.

## The meeting brief (lane M2)

`GET /meetings/brief?meetingId=` (`meetings/brief.ts`) gathers, on read and with no model call,
what Callie already knows for one meeting. Each item carries its source, its date and how far it
can be trusted: `stated` (the booking form), `observed` (a verbatim quote, a logged outcome, an
e-mail's subject), `inferred` (a model's summary or next step) or `unverified` (prepared
research, not verified by Callie). Each section carries at most 12 items and counts the rest.

* **Why this demo** — the booking's notes and answers (dated by `details_observed_at`); the `demo_request` quotes from the
  firm's recent calls' analyses; those calls' stored summaries' next steps.
* **Firm** — the prepared brief's first three lines (it is free text: its first lines are its
  headline), then the research quotes `software_evidence` and `maintenance_workflow`.
* **Previous conversations** — the last three calls (a logged call, or a placed call nobody
  logged yet: outcome and a one-line summary, the analysis's before the stored one) and the
  last two e-mail threads (subject and date only).
* **Objections** — from the analyses, one per category, the most recent quote.
* **Open commitments** — the summaries' commitments, de-duplicated.

Readable by whoever may read the firm page in full (the assignee or an administrator, whose
read of a colleague's firm is audited); anyone else, an unknown meeting and a meeting matched
to no firm get the same `not_found`. Calls are the firm's own: a call session of another firm
linked to one of this firm's call logs is skipped, with its summaries. The desktop opens it from the firm page's Meetings row
("Brief") for a meeting starting within seven days or past and unconfirmed. Today shows no
meetings, so it has no link there. A `not_found` forgets any brief the desktop kept for the
meeting and shows "Not available."; a read that failed otherwise keeps the last brief shown.

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

## Demo recordings (lane M4, migration 0040)

Zoom records each Callie demo **locally**, with one audio file per participant, into the
demo recordings folder (Settings › Demo recordings folder; default `~/Movies/Callie Demos`,
a setting of this Mac). The Mac imports them (`apps/desktop/src/main/recordings/`):

1. **Discovery.** `fs.watch` on the folder, a rescan every minute and a scan at start. Each
   session folder's start time comes from its name (`YYYY-MM-DD HH.MM.SS <topic> <number>`)
   or, failing that, the folder's own creation time. "Import a recording folder…" adds one
   folder to the same pipeline, held in memory until it is found to overlap a meeting. The
   folder rules are tables (`zoomFolder.ts`, assumptions A1–A6) until a real listing
   confirms them.
2. **Privacy.** `GET /meetings/recordings/candidates?from=&to=` answers the non-cancelled
   meetings starting in the window that this person may attach a recording to (an
   administrator: all; anybody else: meetings on firms assigned to them); at most 35 days and
   100 meetings, and `truncated` when there were more. Every name it carries (the firm's, the
   contact's, the attendee's address) goes through one minimiser: a value with an `@` is
   answered as its local part, and the contract refuses an `@` in any of them. A truncated
   answer decides nothing: each folder is read again on its own window, and one whose own
   window is still truncated waits. A folder whose start falls in no meeting's
   `[start − 30 min, end + 30 min]` is dropped from its name alone: never listed, hashed,
   uploaded or shown, and only a salted digest of its path is kept (once no meeting can still
   appear for it). No answer from the server decides nothing. Video is never read.
3. **Matching.** Exactly one meeting within ±30 minutes of the start, corroborated by the
   attendee's name (the linked contact's, else the words of the address's local part) as
   whole words of the topic or of one participant's file name (camel case, separators and
   digits split; "Ann Smith" is not in `audioJoannSmith1.m4a`), is matched. Anything else
   that overlapped is **Needs matching**: Today's quiet Recordings group offers the
   overlapping meetings, or "Not a Callie demo", which drops the folder for good.
4. **One writer.** Every read-modify-write of the import — the store load (once per session),
   a scan, a command, one upload step, the sign-out reset — is one turn of a single queue, so
   nothing is ever derived from state another write has replaced. Entry versions come from
   the person's persisted monotonic clock: a version is never reused, even by an entry
   removed and recreated. A sign-out abandons the turn under way at its next await (an upload
   in flight is dropped) and resets as the next turn.
5. **No cached authority.** Sniffing, hashing, uploading or registering any file of a folder
   needs, in the same turn, a complete candidates answer for that folder read in this
   session at most 60 seconds earlier (else read again then), under which it still overlaps a
   meeting and its meeting still holds (David's choice still overlapping; an automatic match
   still the matcher's answer). Without one nothing inside the folder is touched. A meeting
   that is gone (folded, deleted, cancelled, moved, its firm given to someone else) — or
   that the server refuses as such — puts the folder back to Needs matching; one that no
   longer overlaps anything removes it.
6. **Waiting.** A folder is ready when no `.zoom` or temporary file remains, its audio is
   there (the per-participant files, or the mixed `audio*.m4a` when there are none) and the
   listing is unchanged across two scans at least 20 seconds apart.
7. **Upload**, one step per turn. Per file: its box tree is walked (`audioSniff.ts`: sizes,
   largesize and to-the-end boxes, bounds-checked; `ftyp` first; only `moov > trak > mdia >
   hdlr` is descended, the handler read at its defined offset). It is audio only when a track
   is `soun` and every other is `hint`, `meta` or `text` — `vide` or any unknown handler is
   `not_audio`, never hashed or sent, and bytes in `free`, `skip` or `mdat` are never read as
   a handler. Then `POST /meetings/recordings/upload-url {meetingId, fileSha256, sizeBytes,
   participantLabel, segment}` answers `registered` (nothing to send) or a 15-minute
   presigned PUT to `meetings/<meeting>/<sha256>.m4a` in the call-audio bucket that binds
   `audio/mp4`, the size (≤ 300 MB) and the digest — S3 refuses any other body. The URL is
   signed per answer, a replay's too, after the permission is checked again, and never
   stored. Then `POST /meetings/recordings/register {meetingId, files}` under a command id
   saved before it is sent, so a restart replays it; each new file is checked by HEAD
   (present, size, digest) before any row is written. A person who is not an administrator
   registers only an object an upload URL was issued to them for (`recording_not_issued`),
   no later than S3's `LastModified` for it, compared in whole seconds as S3 gives it
   (`not_your_upload`): an object somebody else staged first is not theirs. An object that is
   not there (expired, or never arrived) is refused `object_missing` with its digests and no
   receipt: the Mac sends those files again. Each file's PUTs and each folder's registers are
   counted in the store across scans and restarts: a fourth of either fails the folder with
   Retry, which resets the counts.
8. **States**, kept in `recordings.json` per person and role class (workspace, user, admin or
   member: a downgraded person starts empty) and keyed by the folder path and the audio
   files' identity (inode, size, mtime). This Mac shows only what is not registered yet:
   Waiting for conversion, Uploading n/m, Needs matching, Failed (Retry / Not a Callie
   demo). A command answers its own item at its version, and the window applies nothing
   else from it. **Registered recordings are the server's:** the firm page reads
   `GET /meetings/recordings?firmId=` (the firm page's authorisation: any member, a firm of
   this workspace) and shows each meeting's files and their state from the rows — which a
   fold moves to the surviving meeting, and which another Mac's uploads add to.

Who may upload: an administrator, or the assignee of the meeting's firm (an unmatched
meeting is an administrator's). `meeting_recordings` holds one row per file, unique by
(workspace, meeting, sha256), removed with its meeting and moved to the survivor by a
Cal.com fold. The bucket's one-day expiry stays. Nothing is enqueued yet: slice M5 adds
`meeting.transcribe` at the hook in `meetings/recordings.ts`.

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
`POST /opportunities/open` at Demo booked for a firm with no deal — for the firm whose
suggestion was drawn, which the window names, never the page the bridge read last. The
suggestion carries the stage it was read at (`fromStageKey`), and the move sends it back as
`expectedStageKey`: a deal moved elsewhere since is refused (`stage_changed_elsewhere`) and
not moved. While the firm page's deal stage changes, the line is hidden until the read that
change caused lands.
