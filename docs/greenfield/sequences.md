# Sequences: versions, enrollments and due work

Specification revision 3, section 11 in full, 4.3 (holds shift schedules), 8.2 (lane 3
is due sequence work), 12.2 and 12.5 (what the send needs from here), Appendix A rows
*Enroll*, *Complete manual step*, *Migrate enrollments* and *Stage change*, Appendix C
`step-execution:{id}`, Appendix D, and Appendix G 26, 28, 31, 32 and 33. The LinkedIn
channel (its task, handoff, undo and recorded reply, and Appendix G 9 and 18 with them)
was removed on 25 September 2026.

## The short version

A **sequence** is a name. A **sequence version** is an ordered plan of steps, and once
published neither it nor its steps can change — a trigger refuses the edit, and editing
a published sequence creates a new draft instead. An **enrollment** binds one contact
to one published version and freezes three things with it: the version, the firm's
actual time zone, and the holiday calendar version. A **step execution** is one step of
one enrollment, and there is exactly one per pair.

The worker claims a due execution, re-reads eleven eligibility questions inside the
claiming transaction, places an email in the firm's own sending window, renders it, and
hands finished bytes to the sending lane. A call task is completed by a person. Anything that refuses holds the step with the reason section 15 gives it.

Terminal conditions end enrollments and cancel everything unexecuted. Reversible holds
shift unexecuted work by the *union* of their intervals, and a union longer than seven
days makes the salesperson look at the remaining steps before resuming.

## Where everything is

```
packages/domain/db/migrations/0012_sequences.sql  eleven tables, four triggers
packages/domain/src/rules/cadence.ts              G0: the walk and the start anchor
packages/domain/src/rules/businessDays.ts         G0: elapsed and business-day delays
packages/domain/src/rules/sendingWindow.ts        G0: the window, the Monday rule, pacing
packages/domain/src/rules/holds.ts                G0: the union, and the seven-day rule
packages/domain/src/rules/templates.ts            G0: the content hash and the footer
                                                  (sign-off + stop line; G20 removed the address)

packages/domain/templates/templates.ts   create, approve, retire, render
packages/domain/sequences/types.ts       the vocabulary and the refusal codes
packages/domain/sequences/rows.ts        every SELECT in the lane, once
packages/domain/sequences/definitions.ts create, draft, publish, retire
packages/domain/sequences/calendars.ts   the versioned holiday calendar
packages/domain/sequences/enrollments.ts enrol, and the terminal stop
packages/domain/sequences/executions.ts  run a due step; dispatch it; complete it
packages/domain/sequences/eligibility.ts the eleven questions, composed
packages/domain/sequences/sendHandoff.ts the seam with G7-2, and its recording fake
packages/domain/sequences/resume.ts      the union shift and the long-hold review
packages/domain/sequences/terminalStops.ts the subscription to G3a's outbox
packages/domain/sequences/todaySource.ts lane 3 of the Today list
packages/domain/sequences/recoveryFloor.ts the enrollment half of 12.3's floor
packages/domain/sequences/migration.ts   the audited enrollment migration
packages/domain/sequences/variables.ts   deterministic variables from CRM data

apps/api/src/routes/{sequences,templates,enrollments}.ts
apps/worker/src/handlers/sequenceAction.ts   the job and its scheduler source
apps/desktop/src/renderer/sequence*.ts       the editor window
apps/desktop/src/main/sequenceBridge.ts      its half of the bridge
```

## The seven rules a reader should carry

### 1. Immutability is a trigger, not a convention

A draft may change in every way. A published version may make exactly one further
transition — to `retired` — and a retired one may not change at all. Its steps follow
it: `sequence_steps_only_on_a_draft` refuses an insert, an update *and* a delete once
the parent has left `draft`.

So `definitions.ts` is only about the two things a trigger cannot decide: what a draft
may contain, and what has to be true before it becomes publishable. Publication checks
three things a CHECK constraint cannot — at least one step, ordinals 1..n with no gap,
and an approved unretired template on every email step — and the third is deliberately
the strict reading: a draft may name an unapproved template and be saved, and cannot be
published until somebody approves it.

`template_versions` is migration 0009's, extended here and never recreated. The five
columns 11.1 reserves for AI personalization are nullable, `generated` is refused by
the CHECK beside the one that names it, and the approved-version immutability trigger
was replaced so that it covers them too.

The footer a version stores is its sign-off, and the block an approval requires the
body to end with is that sign-off and then `Reply "stop" and I will not email you
again.` There is no postal address between them and no column for one: migration 0015
dropped `footer_postal_address` under David's 22 September decision, recorded in
`docs/archive/decisions/g20-automated-email-carries-no-postal-address.md`. The footer is
inside the body rather than appended at send time, so the content hash covers it and
an edit to the footer leaves the approval behind exactly as an edit to the opening
does.

### 2. Enrollment and its first execution are one statement

Appendix A's *Enroll* row commits "the enrollment and first execution" together. That
is two writable CTEs in `enrollContact`, not two statements inside a transaction, so it
is atomic whether or not the caller opened one. An enrollment with no first execution
is a contact the salesperson believes is being contacted and who never will be.

Three things freeze at that moment and each has a reason:

* **the sequence version**, because 11.2 says so and a published version is immutable
  anyway, so the freeze costs nothing;
* **the firm's zone**, so a firm that moves mid-cadence does not re-time steps the
  salesperson has already seen rendered;
* **the holiday calendar version**, for the same reason — and because the `rule_version`
  stored on every due instant names it, so a later calendar change is distinguishable
  from a bug.

`sequence_enrollments_one_active_per_contact` is a partial unique index on
`(workspace_id, contact_id) WHERE ended_at IS NULL`. There is deliberately no index on
`(workspace_id, firm_id)`: 11.2 permits unlimited contacts at one firm to be enrolled
and to receive mail on the same day.

### 3. Eligibility is one read at one instant, in a fixed order

11.2 lists eleven questions the worker re-reads "inside the claiming transaction".
`composeEligibility` asks them in the order of `eligibility.ts`, first refusal wins:

```
suppression → control mode → holds → assignment → route → mailbox → template approval
```

Suppression before assignment for the reason `docs/greenfield/policy.md` gives about
dialing: an unassigned salesperson should be told the firm is suppressed rather than
that it is not theirs.

Caps, the domain guard and the window are deliberately *not* sources. They belong to
the sending lane and are re-read inside its own fence, where the answer that matters is
decided; asking them here as well would be a second answer that can disagree with it.
A refusal from the send is turned into the same hold this composition would have
produced.

### 4. This lane opens exactly one hold

`missing_variables`, and nothing else. Every other refusal already *is* a hold somebody
else wrote, or a cap re-read inside the fence, and a second row for it would match
nobody's release statement — "clearing one hold never clears another" (4.3) cuts both
ways. See `docs/archive/decisions/g8-which-holds-this-lane-opens.md`.

### 5. The union, never the sum

`resumeEnrollment` reads every hold that blocked this enrollment since it started —
open **and** released, which `listApplicableHolds` deliberately does not — composes
them with G0's `composeHolds`, and does what `decideResume` says. Three answers and no
fourth: something is still open, a person has to review, or the unexecuted steps shift
by the union.

Two holds that ran side by side for a day delayed the work by a day. A hold that opened
before this contact was enrolled counts only from the enrollment's own start, because
it did not delay work that did not exist.

Every move is a row in `step_execution_shifts`, which is append-only by privilege and
refuses a shift that would move work earlier. `original_due_at` never moves, so "what
did the cadence originally say" survives every later change.

Since lane g82 a resume counts only the window after the last applied one (the latest
`hold_union` row), so a second release never shifts by the first hold again, and it asks
the same seven scopes, for the same action kinds, as `holdSource`. It runs on its own:
a released hold wakes the steps it blocked on the next scheduler pass, and the run
resumes them before its eligibility check
(`docs/archive/decisions/g82-a-step-is-woken-by-its-row-version.md`).

### 6. The send gets finished bytes, and the fence is G7-2's

`SendHandoff.prepare` takes an `OutboundEmailRequest` carrying a rendered subject and
body, the template version id and its content hash, the frozen route, the placed
`sendAt`, the rule version that produced it and the workspace business date the cap
counts against. G7-2 re-checks the hash, freezes the envelope, and owns the state
machine from `prepared` onwards.

Owning the state machine is not the same as driving it. Appendix C has no send job
kind, so `sequence.action` calls `dispatch` too — after its own transaction commits,
and only while the fence reads `prepared` or `held`, neither of which ever reached
Gmail (`docs/archive/decisions/g8-this-lane-dispatches.md`, amended by g82). A fence that comes
back `held` is a cap that has not cleared yet, not a step that is over:
`CLOCK_CLEARING_HOLDS` pushes `not_before` forward, the scheduler asks again, and the
step's next run finds the fence it already has and hands it back to the dispatch path.
A step whose fence has gone further is settled from it: `sent` completes the step from
the original dispatch time, an admin's answer to `unknown_terminal` continues or stops
the sequence.

A successor is due at the start-anchored plan, unless the step before it ran late: then
the plan's gap between the two steps is counted from when that step actually happened —
for an email, the original dispatch instant (12.5; `successor.ts`).

The division is not arbitrary. 11.1 holds the step on a missing variable, so
substitution has to happen *before* a fence exists: a fence prepared for a body reading
"Hi ," would be a fence that must never dispatch, and the honest shape is that it is
never created.

The reverse direction is `completeEmailStep`, a function G7-2 calls rather than a port,
because Appendix B's "marked skipped stops and never resends" is not a rule another
lane should be able to supply a different version of.

`apps/worker/src/handlers/outboundSendHandoff.ts` is what is wired: G7-2's
`prepareOutboundMessage`, `dispatchOutboundMessage` and `readOutboundOutcome` behind
this interface, with their refusal codes mapped through their own
`holdReasonForRefusal`. `prepare` and the outcome read are real; `dispatch` needs the
Gmail configuration this release hands to nobody, so it refuses with
`mailbox_disconnected` — which is the truth in a deployment with no connected mailbox,
and in practice `prepare` says so first. `unavailableSendHandoff` remains as the
default for a caller that supplies no hand-off at all.

### 7. A LinkedIn row stored before 25 September 2026 is unknown

LinkedIn was removed from the code on 25 September 2026 and migration 0012 was not
changed, so the tables still admit its values. The code treats each one as unknown:

* a `linkedin_task` execution is held with `long_hold_review` by `runDueStepExecution`
  and never run, and Today does not list it (`isStepChannel`, `types.ts`); a person stops
  the enrollment or migrates it onto a version without one;
* nothing enrols into, publishes, copies into a draft or migrates onto a version that has
  a `linkedin_task` step;
* `linkedin_reply` in a version's `stop_conditions` (the column's default still puts it
  there, and `sequence_versions_stop_conditions_complete` requires it), and
  `linkedin_reply`, `open_and_copy` or `handed_off` on an enrollment or an execution, are
  dropped on read (`rows.ts`);
* `enrollment_linkedin_results` is never written; a deletion still removes its rows.

`packages/domain/test/sequences/removedLinkedIn.test.ts` writes each value with SQL and
proves each rule.

## The job

Appendix C: `sequence.action`, key `step-execution:{id}:{wake}`, protection
`outbound_fence`. The wake is the execution row's `updated_at` (lane g82): a row nobody
has written to since its last job is not asked again, and a row that has moved is a new
job instead of a collision with the `done` one. The protection is not cosmetic — the
runner runs an `outbound_fence` handler *outside* the completion transaction, because
`prepared → dispatching` and the Gmail call after it cannot be rolled back.

The source is `listStepWakes` (`packages/domain/sequences/wake.ts`), and its time
comparisons are PostgreSQL's, so no worker's clock decides whether a step is due. It
wakes due
`pending` work; `held` work past its `not_before` that no open hold blocks, asking all
seven hold scopes as `holdSource` does, so a released hold wakes its steps on the next
pass; and `dispatched` work that has not moved for ten minutes, whose worker died
between the step's commit and the claim. It never materializes a wake for a step that
already has a live job.

`not_before` is what keeps a held step from spinning. A step an open hold blocks keeps
it and sleeps until the release; any other held step waits out its reason's interval —
`CLOCK_CLEARING_HOLDS` for caps, windows and a reconciling fence, fifteen minutes for
`send_unknown_terminal`, an hour for everything else. A step's own fence's holds do not
block its own wake, because the dispatch path is what releases them. See
`docs/archive/decisions/g82-a-step-is-woken-by-its-row-version.md`.

The handler's shape follows from Appendix B: one narrow transaction that re-reads
eligibility, renders and prepares the fence, then a commit, then the dispatch. The
runner already refuses to wrap an `outbound_fence` handler in the completion
transaction, for the same reason.

## The terminal stop

G3a emits `opportunity.terminal_stop` into `crm_domain_events` in the transaction that
closes an opportunity, and `opportunity.manual_mode` in the transaction that makes one
manual. `consumeTerminalStops` reads both kinds after this lane's own high-water mark,
stops every live enrollment the event covers, cancels everything unexecuted, writes one
`enrollment.terminally_stopped` audit event per enrollment, and advances the cursor in
the same transaction.

What an event covers differs by kind, and matches the sentence each one comes from:
8.1's close is about one opportunity, while 7.3's manual paragraph is firm-wide —
"terminally stop every active enrollment for the firm across contacts", which Appendix
A's "Confirm human reply" row repeats as "all firm enrollments". Lane G22 widened the
manual arm to the firm accordingly.

The end reason for a manual-mode stop is the event's own `detail.origin`, through
`manualModeEndReason`: an engaged call ends its enrollments `engaged_call`, a direct
Gmail send `direct_send`, an explicit `POST /opportunities/manual` `admin_stop`. The
table is in `docs/greenfield/crm.md`. An event with no origin — every one written
before lane G22 — still reads as `human_reply`, which is what lane G15 recorded, so the
drain never refuses an old row and no reader changes its answer.

### The confirmed reply stops in its own transaction (lane G22)

7.3 does not describe this stop as background work: "A confirmed human reply performs
**one transaction**: record and classify the message; set manual; terminally stop every
active enrollment for the firm across contacts; cancel unclaimed executions; hold any
irreversible dispatch fence; create or promote the reply-lane Today entry; and write
the audit event." So `confirmReplyDisposition` calls `applyManualModeStop` itself,
inside the command's transaction, and the drain is the net rather than the mechanism.

Running both is safe, and that is the design rather than a tolerance:
`stopEnrollments` matches `ended_at IS NULL`, so the drain reads the same event through
its keyset cursor, finds nothing live, stops nothing and audits nothing. The idempotence
is keyed on the event — the cursor never re-reads a consumed row — and backed by the
enrollment's own end, which no replay can undo.

The confirmation gains no new `consequences` member for it.
`mail_reply_confirmations_consequences_known` is a closed list, widening it would need
a migration, and nothing is missing: `opportunity_manual` is the consequence 8.3 names,
the stop is what 7.3 says that consequence *is*, and `enrollment.terminally_stopped` is
the audited record of each enrollment it ended.

The cursor is a `(occurred_at, id)` keyset rather than a timestamp, because two events
written in one transaction share `now()` to the microsecond. It is only an
optimisation: stopping is idempotent, so a replay stops nothing twice. See
`docs/archive/decisions/g8-outbox-cursor.md`.

`consumeSuppressionStops` is the second stream. G4's `suppression_finalizations` marker
with `outcome = 'finalized'` is Appendix C's "terminal marker" — an event whose terminal
enrollment stops are owed — and it has no cursor, because the marker's event id is a
sha256 string and `sequence_event_cursors.last_event_id` is a uuid. What it uses instead
is stronger: the work *is* the set of live enrollments a still-effective suppression
covers, read through `effective_suppressions` with the same firm-and-handle query
`suppressionSource()` uses in `eligibility.ts`, so the enrollments a suppression stops
are the enrollments the eligibility read refuses. A marker whose stops have happened
offers nothing to do; an enrollment created after a suppression is stopped rather than
missed.

**Who calls them.** `apps/worker/src/handlers/terminalStop.ts`, as the
`sequence.terminal_stop` job, materialized by `terminalStopSource` when either stream
owes a workspace anything. Until lane G15 nothing called either function at all: closing
an opportunity Won stopped no enrollment, and a confirmed human reply set the control
mode and left the sequence running, which is invariant 3. See
`docs/archive/decisions/g15-the-worker-drains-what-the-lanes-left.md` and
`docs/archive/decisions/g22-the-manual-mode-origin.md`.

## Authoring and starting a sequence on the Mac (lane g88)

The editor window (`apps/desktop/src/renderer/sequenceEditor.ts`, decisions in
`sequenceView.ts`, commands in `apps/desktop/src/main/sequenceBridge.ts`) drives the
existing commands in the order a founder meets them. There is no authoring endpoint of
its own.

1. **New sequence** — a name. Two commands: `/sequences/create`, then an empty draft
   (`/sequences/versions/draft` with no steps), so the new sequence opens ready to type into.
2. **Write the email** — **New template**: a name, a subject, the email and the sign-off.
   The bridge appends the sign-off and 12.6's stop line, because the approval requires the
   body to end with them. The declared variables are the ones the text names. The form
   refuses, before sending, a variable Callie cannot fill (`TEMPLATE_VARIABLE_NAMES`, in
   `@fss/contracts`), an unsubscribe link, and more than 89 words. **Approve** is a separate
   press. A refused approval lists every issue, read from the refusal's body, because the
   Mac's transport cuts a reason code at 80 characters.
3. **Steps** — the draft's steps as typed controls: Call or Email, a delay in business
   days or hours after enrolment, the template an email sends or what a call does when
   nobody answers, with up, down and remove on hover. An empty draft offers **Start from
   the suggested plan** (call on day 0, email on day 2, call on day 4), which fills the
   editor and publishes nothing. Nothing is sent until **Save draft**, which numbers the
   steps 1..n in list order.
4. **Publish** — disabled while the editor holds unsaved changes. A published version
   offers **Edit as a new draft**.
5. **Enrol** — on the firm's page, not here (`docs/greenfield/crm-surface.md`, "The
   windows"). It needs an open opportunity, and the page offers **Add to pipeline** first.

The stop conditions read as one sentence. The codes, a template's content hash, its footer
and its declared variables are behind **Details**.

### Review and resume

`POST /enrollments/resume/preview { enrollmentId }` answers
`{ asOf, preview: { kind, unionMilliseconds, shiftMilliseconds, openHoldIds, firmTimeZone,
holds[], steps[] } }`. Each step has its
`dueAt` now and the `proposedDueAt` a confirmation gives it. `previewResume` and
`resumeEnrollment` share `resumeDecisionFor`: the same window since the last applied
shift, the same composition and decision, and the same `shiftDueInstant`. The preview
locks nothing and writes nothing, not even the `review_required` flag.

**Review and resume** on a held enrollment opens that review. It shows what held the
enrollment and each remaining step as *from → to* in the firm's zone, and **Resume with
these dates** is the only control that resumes. The bridge refuses to resume an
enrollment whose review is not on screen and opens the review instead. When a hold is
still open, the review says so and offers no confirmation. The confirmation decides again
under its lock. See `docs/archive/decisions/g88-founder-authoring-and-review.md`.

## Adding a step channel, or a terminal condition

1. Add the word to the CHECK in `sequence_steps_channel_known` and to `StepChannel`.
2. Give it an entry in `CHANNEL_ACTION_KINDS`, so its holds are found.
3. Give it a `TodayItemKind` in `todaySource.ts`, so it reaches the morning list.
4. Decide in `runDueStepExecution` whether it is automated or `awaiting_manual`.
5. A terminal condition additionally goes in `sequence_versions_stop_conditions_known`
   **and** its `_complete` twin, because a version may not opt out of one
   (`docs/archive/decisions/g8-stop-conditions-are-mandatory.md`).
6. `npm run gate:greenfield`.

## Running the tests

```
npm run gate:greenfield
npm --workspace @fss/domain run test -- test/sequences      # G 28, 31, 32, 33, and stored LinkedIn rows
npm --workspace @fss/api run test -- test/sequences.test.ts # the routes and the receipts
npm --workspace @fss/worker run test -- test/sequenceAction.test.ts  # G 1 and G 2
npm --workspace @fss/worker run test -- test/sequenceActionRearm.test.ts  # the wake, a killed worker, two wakes
npm --workspace @fss/desktop run test -- test/sequences.test.ts      # the editor
npm --workspace @fss/domain run test -- test/sequences/resumePreview.test.ts  # the review is the resume's arithmetic
npm --workspace @fss/desktop run test -- test/founderGaps.test.ts    # authoring and the review, as view models
```

Nothing in any of them opens a socket, and no fixture contains a real person, firm,
address or number. `example.test` is reserved by RFC 6761 and the phone numbers are in
the NANP 555-01XX fictional block.
