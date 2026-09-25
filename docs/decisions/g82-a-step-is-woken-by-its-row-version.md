# g82: a step is woken by its row's version, and settled from its fence

**Date:** 25 September 2026 · **Lane:** g82 sequence engine · **Spec:** 4.3, 11.2, 12.5,
13.1, 13.2, Appendix A, Appendix B, Appendix C · **Audit:**
`GPT6-ASTRA-EXHAUSTIVE-20260925.md` C02, C03, C05, C09, C10, C11 (C12 left, see below)

Amends `g8-this-lane-dispatches.md` (a held fence is now dispatched too) and
`g8-retry-is-the-same-row.md` (one execution per step still; no longer one job per step).

## What was wrong

All six were real in code at `0af4ce3c`, and still were after lane g79 merged.

* **C02.** The `sequence.action` key was `step-execution:{id}`. A step held by a cap, a
  window or a pause completed its job, and the job row stayed `done`. When the step was
  due again, the scheduler's insert collided with that row and nothing ran. The four
  "clock-clearing" reasons were materialized out of `held` every hour and never executed.
* **C03.** The step's transaction marks the execution `dispatched` in the same commit that
  prepares its fence, and the claim comes after it. A worker that died in between left a
  prepared fence. The retry read `dispatched`, answered `nothing_to_do` and completed.
  Nothing else ever looked.
* **C05.** Releasing a hold only stamped `released_at`. The scheduler never materialized a
  held step unless its reason was one of the four, and nothing but the salesperson's
  explicit long-hold resume called `resumeEnrollment`.
* **C09.** Every resume counted every hold interval since the enrollment started, so a
  second release shifted the steps by the first hold again.
* **C10.** The resume's hold query asked five scopes of seven (no mailbox, no channel).
  The scheduler's source asked about no hold at all.
* **C11.** The successor was always the start-anchored plan. The original dispatch time
  became `completed_at` and nothing read it, so 12.5's "next delay calculated from the
  original dispatch time" was not implemented. An email that went three days late was
  followed by a call due that same hour.

Two more defects surfaced on the way and are fixed because the wake needs them:

* A step whose dispatch was held by the cap sat behind the firm-scoped `daily_cap` hold
  its own fence opened. Its next run asked eligibility first, eligibility saw that hold,
  and the step was held again before the dispatch path could release the hold. It never
  ran again.
* An admin's `delivered` or `skipped` on an `unknown_terminal` fence changed nothing in the
  sequence. Appendix A's "Unknown mail resolution" row commits "delivered and successor,
  or skipped and terminal stop" together. The firm's terminal hold was never released
  either.

## Decision

### The wake: the job key carries the row's version

`step-execution:{id}:{wake}`. The wake is `step_executions.updated_at` in microseconds.
Every writer of that table sets `updated_at = now()` (checked: executions, resume,
enrollments, linkedin, migration, retention), so:

* a row nobody has written to since its last job ran is **not asked again**. The key is
  already there, `done` or `dead`;
* a row that has moved is **a new wake**. It may have been held with a new `not_before`,
  resumed, rescheduled, marked dispatched or reopened.

There is still exactly one execution per step (`step_executions_one_per_step`). The retry
of a call still moves the same row, and the outbound fence is still what makes one email
out of any number of jobs. What changes is that one step can have several job rows, one
per version it was asked about. The source (`listStepWakes`) never materializes a wake for
an execution that already has a `queued`, `running` or `retryable` job, so two jobs for one
step are never live together.

No migration. A per-execution counter column would have said the same thing and forced a
schema release; `updated_at` exists and is already written by every writer.

**Rejected:** re-arming the one `done` job row in place. It keeps Appendix C's key
literally, but the rule for *when* to re-arm needs the job's claim time compared with the
row's `not_before`. That comparison fails silently if a handler outlives the recheck
interval. It also overwrites the job's history and has to restore an archived payload.

### What is woken

`packages/domain/sequences/wake.ts`, one query over every workspace:

* due `pending` work, always. A blocked pending step runs once and is held with the reason
  that blocks it, so the card can show it;
* `held` work past its `not_before` that **no open hold blocks**. The blocking question
  (`BLOCKING_HOLD_SQL`) asks all seven scopes of migration 0001: workspace, firm,
  opportunity, owner, the owner's mailbox, the enrollment and the step's channel. It asks
  about the step's action kind and `enrollment_advance`, which is what `holdSource` asks
  through `listApplicableHolds` (C10). A released hold therefore wakes its steps on the
  next pass (C05);
* `dispatched` work that has not moved for `DISPATCH_RECOVERY_GRACE_SECONDS` (ten
  minutes), which is C03's stranded fence when the job's own retry is gone.

**A step's own fence's holds do not block its own wake.** They are dispatch attempt holds:
a cap, a window, a reconciliation in doubt. The dispatch path releases the stale ones
before it decides again (`g7-held-returns-to-prepared`). Counting them would be the
deadlock above. They still block every other step at the firm, which is what they are for.

One SQL builder, `holdAppliesSql`, serves the wake, `holdExecution` and the resume, so the
three cannot disagree about scope. `test/sequences/wake.test.ts` proves that, for every
scope, `holdSource` refuses exactly when the wake skips and the resume sees the hold open.

### How long a held step waits

`holdExecution` sets `not_before` inside the same statement that holds the step, using the
same blocking question:

* **blocked by an open hold:** `not_before` is left where it was. The wake skips the step
  while the hold is open and takes it on the first pass after the release;
* **otherwise:** `not_before` moves out by the reason's interval. `CLOCK_CLEARING_HOLDS` is
  unchanged (an hour for caps and windows, five minutes for a reconciling fence).
  `send_unknown_terminal` gets fifteen minutes. Every other reason gets an hour
  (`DEFAULT_HOLD_RECHECK_MILLISECONDS`): a missing route, an unapproved template, coverage
  that went stale, a mailbox never connected. Before this lane a step held for one of
  those waited for ever, because nobody releases a hold that was never a row.

Since the decision and the wake use the same SQL, a held step is either skipped until a
release or asked again later. It is never re-run every pass.

### What a run does with a step that has run before

`runDueStepExecution`, in order:

1. **An email step with a fence is driven from the fence.**
   * `sent`: complete it from the original dispatch instant.
   * `dispatching` or `reconciling`: hold `send_unknown_reconciling`.
   * `unknown_terminal`: hold until the admin answers. `delivered` then completes it and
     `skipped` stops the enrollment; either way the fence's terminal hold on the firm is
     released in the same transaction.
   * `prepared` or `held`: mark the step `dispatched` again and hand the fence back to
     `dispatchPreparedStep`, which now dispatches a `held` fence as well as a `prepared`
     one. `dispatchOutboundMessage` releases it, rechecks everything under the send gate
     (g77) and claims atomically. Appendix B: "Prepared, and Gmail request provably not
     started: retry same fence." Two looks at once are safe because the claim is one
     `UPDATE … WHERE state = 'prepared'`.
2. **A held step is resumed first** (`resumeEnrollment`, C05): 4.3's shift or the seven-day
   review, then the fresh eligibility check in the same transaction.
3. Then the eligibility check and the email or manual path, as before.

`SendHandoff.readOutcome` gains two optional fields, the fence's id and the admin's
resolution. `apps/worker/src/handlers/outboundSendHandoff.ts` passes them through from
`readOutboundOutcome`. A hand-off without them falls back to `prepare`, which reuses the one
fence.

### C09: a resume counts only what was not applied

The resume window starts at the later of the enrollment's start and the last `hold_union`
row in `step_execution_shifts`, which every applied resume writes at one instant. The
seven-day review is asked of that window, meaning the blocking episode that just ended,
not the enrollment's lifetime total. One limit remains: a resume that finds no unexecuted
step to move (the next step is `dispatched`) writes no row, so the next resume that does
counts that window again.

### C10: the resume asks what eligibility asks

It uses all seven scopes, for the next step's own action kind and `enrollment_advance`.
Holds this enrollment's own fences opened are not counted. 12.5 says a send confirmed
after reconciliation continues "from the original dispatch time", and a shift by the doubt
period would undo that.

### C11: the plan, unless the step ran late

`packages/domain/sequences/successor.ts`. The successor is due at the later of:

* **the plan**: the next step's delay from the enrollment's start, which the editor labels
  "N business days after enrollment";
* **the spacing floor**: the gap the plan leaves between the two steps, counted from when
  the previous step actually happened. For an email that is the fence's original dispatch
  time, never the moment a reconciliation or an admin settled it.

A business-day gap is counted in business days: those between the two planned dates,
starting from the business day the previous plan fell on. It is then resolved from the
completion's date in the firm's zone and calendar, so a weekend is never counted twice.
An elapsed gap is the difference between the two planned instants. On time, the floor
lands on the plan and changes nothing. A due instant the floor produced carries
`+after-completion` in its `rule_version`.

## C12 is left

David decided on 25 September to delete LinkedIn steps rather than fix undo (triage
decision 2, G09). Deleting them is not a lane-sized change inside this lane's files. It
reaches the step channel CHECK and `enrollment_linkedin_results` in migration 0012, the
contracts' channel and pause vocabularies, the API's LinkedIn routes, the desktop editor
and bridge, Today's `linkedin_due` kind, the dashboard's handoff counts and the release
checks. Several of those belong to other lanes. `linkedin.ts` is untouched, and the undo
defect stands until the deletion lane.

## What a reviewer should check

* Every `UPDATE step_executions` sets `updated_at = now()`. A writer that forgot would make
  its write invisible to the wake, which is exactly the old behaviour for every write.
* `BLOCKING_HOLD_SQL` and `listApplicableHolds` name the same seven scopes. `wake.test.ts`
  runs each scope through both.
* Nothing in the run calls Gmail. A woken step reaches Gmail only through
  `dispatchOutboundMessage`, with its precheck, its OAuth-first claim transaction under
  the send gate, and its atomic claim.
