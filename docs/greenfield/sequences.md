# Sequences: versions, enrollments, due work and the LinkedIn handoff

Specification revision 3, section 11 in full, 4.3 (holds shift schedules), 8.2 (lane 3
is due sequence work), 12.2 and 12.5 (what the send needs from here), Appendix A rows
*Enroll*, *Complete manual or LinkedIn step*, *LinkedIn undo*, *Migrate enrollments*
and *Stage change*, Appendix C `step-execution:{id}`, Appendix D, and Appendix G 9, 18,
26, 28, 31, 32 and 33.

## The short version

A **sequence** is a name. A **sequence version** is an ordered plan of steps, and once
published neither it nor its steps can change — a trigger refuses the edit, and editing
a published sequence creates a new draft instead. An **enrollment** binds one contact
to one published version and freezes three things with it: the version, the firm's
actual time zone, and the holiday calendar version. A **step execution** is one step of
one enrollment, and there is exactly one per pair.

The worker claims a due execution, re-reads eleven eligibility questions inside the
claiming transaction, places an email in the firm's own sending window, renders it, and
hands finished bytes to the sending lane. A call task and a LinkedIn task are completed
by a person. Anything that refuses holds the step with the reason section 15 gives it.

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

packages/domain/templates/templates.ts   create, approve, retire, render
packages/domain/sequences/types.ts       the vocabulary and the refusal codes
packages/domain/sequences/rows.ts        every SELECT in the lane, once
packages/domain/sequences/definitions.ts create, draft, publish, retire
packages/domain/sequences/calendars.ts   the versioned holiday calendar
packages/domain/sequences/enrollments.ts enrol, and the terminal stop
packages/domain/sequences/executions.ts  run a due step; dispatch it; complete it
packages/domain/sequences/eligibility.ts the eleven questions, composed
packages/domain/sequences/sendHandoff.ts the seam with G7-2, and its recording fake
packages/domain/sequences/linkedin.ts    open-and-copy, undo, replied / no engagement
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
ways. See `docs/decisions/g8-which-holds-this-lane-opens.md`.

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

### 6. The send gets finished bytes, and the fence is G7-2's

`SendHandoff.prepare` takes an `OutboundEmailRequest` carrying a rendered subject and
body, the template version id and its content hash, the frozen route, the placed
`sendAt`, the rule version that produced it and the workspace business date the cap
counts against. G7-2 re-checks the hash, freezes the envelope, and owns the state
machine from `prepared` onwards.

Owning the state machine is not the same as driving it. Appendix C has no send job
kind, so `sequence.action` calls `dispatch` too — after its own transaction commits,
and only while the fence still reads `prepared`
(`docs/decisions/g8-this-lane-dispatches.md`). A fence that comes back `held` is a cap
that has not cleared yet, not a step that is over: `CLOCK_CLEARING_HOLDS` pushes
`not_before` forward and the scheduler asks again.

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

### 7. FSS never claims a LinkedIn message was sent

`result = 'handed_off'`, `completion_source = 'open_and_copy'`, and the successor gets a
ten-minute `not_before` — a grace period, not a delay, so the cadence the salesperson
reviewed is unchanged. Undo reopens the step and cancels the successor inside those ten
minutes, measured against *database* time, and fails visibly if the successor's fence is
already dispatching (Appendix G 9).

"They replied" and "No engagement" live as long as the enrollment does. A reply is
terminal and firm-wide: it switches the opportunity to manual and ends every live
enrollment of the firm, because a prospect who answered on LinkedIn has answered on
behalf of the firm exactly as much as one who answered by email.

There is no LinkedIn automation of any kind, and there is no unsubscribe link anywhere
— `sequence_steps_no_unsubscribe_link` refuses one in a LinkedIn message the same way
`template_versions_no_unsubscribe_link` refuses one in an email.

## The job

Appendix C: `sequence.action`, key `step-execution:{id}`, protection `outbound_fence`.
The protection is not cosmetic — the runner runs an `outbound_fence` handler *outside*
the completion transaction, because `prepared → dispatching` and the Gmail call after
it cannot be rolled back.

The source is one indexed query over `step_executions_runnable`, and both comparisons
are PostgreSQL's, so no worker's clock decides whether a step is due and the ten-minute
LinkedIn grace survives a scheduler in another region.

A `held` execution is materialized only for the four reasons in
`CLOCK_CLEARING_HOLDS` — `daily_cap`, `domain_cap`, `outside_email_window`,
`send_unknown_reconciling` — because those clear with the clock and nobody is going to
press anything. Every other hold waits for the person or the lane that owns it, and a
job claiming one of those every minute would make the `oldest runnable job` alarm mean
nothing. `not_before` is what keeps the four from spinning.

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

The cursor is a `(occurred_at, id)` keyset rather than a timestamp, because two events
written in one transaction share `now()` to the microsecond. It is only an
optimisation: stopping is idempotent, so a replay stops nothing twice. See
`docs/decisions/g8-outbox-cursor.md`.

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
`docs/decisions/g15-the-worker-drains-what-the-lanes-left.md`.

## Adding a step channel, or a terminal condition

1. Add the word to the CHECK in `sequence_steps_channel_known` and to `StepChannel`.
2. Give it an entry in `CHANNEL_ACTION_KINDS`, so its holds are found.
3. Give it a `TodayItemKind` in `todaySource.ts`, so it reaches the morning list.
4. Decide in `runDueStepExecution` whether it is automated or `awaiting_manual`.
5. A terminal condition additionally goes in `sequence_versions_stop_conditions_known`
   **and** its `_complete` twin, because a version may not opt out of one
   (`docs/decisions/g8-stop-conditions-are-mandatory.md`).
6. `npm run gate:greenfield`.

## Running the tests

```
npm run gate:greenfield
npm --workspace @fss/domain run test -- test/sequences      # G 9, 18, 28, 31, 32, 33
npm --workspace @fss/api run test -- test/sequences.test.ts # the routes and the receipts
npm --workspace @fss/worker run test -- test/sequenceAction.test.ts  # G 1 and G 2
npm --workspace @fss/desktop run test -- test/sequences.test.ts      # the editor
```

Nothing in any of them opens a socket, and no fixture contains a real person, firm,
address or number. `example.test` is reserved by RFC 6761 and the phone numbers are in
the NANP 555-01XX fictional block.
