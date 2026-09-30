# all_sequences_held

**Metrics:** `HeldEnrollments` over `ActiveEnrollments` · **Severity:** critical · **Spec:** 4.3, 11.2, 13.3

## What the metrics say

The worker publishes both gauges on every metric pass, once a minute. They have no
dimensions and are summed over every workspace (lane g72; `collectSequenceMetrics` in
`packages/domain/sequences/metrics.ts`,
`docs/archive/decisions/g72-enrollment-gauges.md`).

- **`ActiveEnrollments`**: live enrollments, meaning `active` — the only live state since
  migration 0021. Completed and stopped enrollments are not counted.
- **`HeldEnrollments`**: live enrollments whose next work is blocked now by a hold
  nobody chose. That means one of:
  - its step was held by the worker with a counted reason;
  - an open hold with a counted reason covers its workspace, firm, opportunity, owner
    or the enrollment itself, for the next step's channel or for `enrollment_advance`.

**Not counted**, because somebody chose them or the clock clears them:

- `scoped_pause`. This covers an admin pause at any scope, a salesperson's Today delay,
  and sending switched off (the deployment flag, the workspace attestation, the domain's
  automated-sending switch, or no sending domain).
- `daily_cap`, `outside_email_window` and `send_unknown_reconciling`.
- `cold_outreach_mailbox_required` (since send-path v2, 30 September 2026): a
  prospecting e-mail step held because no cold-outreach transport exists yet. It is the
  expected state of every prospecting enrollment until one does.

Every other reason counts. A counted hold under a pause still counts.

The alarm is `IF(active > 0, held / active, 0) >= 1`. Each gauge is read at `Maximum`
over five minutes, and the alarm needs three periods of three, with missing data not
breaching. With nothing enrolled both gauges are 0, so the expression is 0 and the alarm
is OK. If the alarm is INSUFFICIENT_DATA, the worker's metric loop is not publishing at
all (see `worker_heartbeat_missed`).

## Symptoms

For fifteen minutes, every live enrollment has been blocked by a counted hold.
Automated sequence work has stopped: nothing is sending, and no call step is moving
forward on Today.

With only a few enrollments the fraction is coarse. With one enrollment, one uncertain
reply on it is enough.

## First checks

1. `GET /dashboard`: the hold panel, with open holds by reason code and the age of the
   oldest, and held step executions by reason.
2. `GET /diagnostics`: every mailbox's status and coverage state, `schema.appliedVersion`
   and whether the running images accept it, and open critical alerts. Its `restore`
   object is a compatibility field with neutral values and says nothing: the
   system-generation pin went with lane W3-S8 and the table with migration 0021, so a
   restore is never a generation mismatch. **A restore is not visible here at all**, and
   usually not in the holds either: `runbooks/restore.md`'s protocol opens no blanket
   hold. It opens `restore_in_progress` holds only on the one path that needs them —
   step (d) rerun with `--hold-unattached`, for a send in the old instance's Sent folder
   that no single step can be named for — so their absence says nothing about whether a
   restore is under way. Ask the running log and `restore.md`.
3. `GET /pauses?open=true`. A pause does **not** cause this alarm. If one is open, the
   alarm is about a different reason underneath it.

## Diagnosis

Read the reason codes first. They are a closed set and they name the cause. The usual
ones, most likely first:

- `mailbox_disconnected` / `coverage_incomplete`: an owner-scoped mailbox-health hold
  blocks every automated step kind for that owner, and with one salesperson that is the
  whole workspace. See `mailbox_disconnected` and `mailbox_heartbeat_missed`.
- `restore_in_progress`: **an unattached send from a restore** (`restore.md` step (d) with
  `--hold-unattached`, `fss admin mailbox reconcile-sent`). The reconcile found an FSS send
  in the old instance's Sent folder that the copy lost and that no single step execution
  can be named for, and held what it could belong to instead of abandoning the restore:
  one hold per firm the message names, or one on the workspace when its recipient was
  unreadable, each blocking **every** action kind, keyed by the message's hash so a rerun
  opens nothing twice. With one salesperson a workspace hold is the whole workspace, which
  is exactly this alarm. These holds outlive the restore on purpose.
  **Do not release one from here.** `restore.md`'s step (f) is the procedure, and it is a
  human decision recorded as `basis: human_attestation`: read the Sent message at the
  hold's `sentAt` to learn whom it went to and which step it was, end every enrollment of
  that contact that could send the same step again (the opening `hold.restore_opened`
  audit row lists the ones recorded, and there may be others), and decide what
  re-enrollment is allowed — a new enrollment starts at the first step. Then
  `fss admin holds release-restore --hold <id> --resolution checked-no-duplicate --note
  <what you verified>`, from an ECS task, after which `audit_launch` must find
  CloudTrail's RunTask naming the same caller. A hold with no matching passing
  reconciliation, or one older than the restore, is a no-go for `restore.md` step (e) and
  belongs to David, not to this runbook.
- `provider_refusal` on every firm: Gmail is refusing sends, for example because of a
  rate limit or a suspended account.
- `send_unknown_terminal`: sends nobody can account for. Failed jobs are
  `dead_job_unresolved`'s.
- `long_hold_review`: a step the worker held because the union of its holds passed seven
  days. It resumes on its own — since wave 2 (S4.1) the scheduler wakes it once no open
  hold blocks it, shifts the work by the union and runs the fresh eligibility check — so a
  step still carrying this reason means something else is still open, or eligibility
  refused it again. Read the other reasons rather than resuming this one by hand. Nothing
  writes the enrollment state `review_required` any more; migration 0021 removed it, and
  the API refuses to apply that migration while any row still holds it.
- `uncertain_reply` / `ambiguous_match` / `manual_suppression_review`: prospect-driven
  reviews. These trip the alarm only when every live enrollment has one, which usually
  means very few enrollments.
- `route_*`, `template_unapproved`, `missing_variables`, `reassignment`: data problems
  on the step itself. If every enrollment has one, look for a single cause, such as a
  retired template or a reassignment.

## Safe recovery

- Clear the cause, not the holds. Each hold is released by its own control. A control
  clears only its own hold and always runs a fresh eligibility check.
- When the last applicable hold clears, unexecuted work shifts by the **union** of the
  blocking intervals, so overlapping holds are not double-counted.
- A union longer than seven calendar days is not special any more (wave 2, S4.1): the
  work shifts once by the union and resumes after the fresh eligibility check, however
  long the hold ran. There is nothing for a person to confirm, and no route that would
  confirm it.
- `HeldEnrollments` drops on the first metric pass after the hold is released. A step the
  worker held for a reason only a person can clear — a missing route, an unapproved
  template, an owner with no connected mailbox — keeps its held state until that is
  fixed and its `not_before` comes round again.

## Escalation

Escalate if no reason code explains it, if holds are being opened faster than they are
cleared, or if `HeldEnrollments` equals `ActiveEnrollments` while none of the open holds
or held steps carries a counted reason.

## What must stay held

- Do not delete `active_holds` rows. Clearing one hold never clears another, and nothing
  will reopen a deleted hold.
- Do not pause automation to "quiet" the alarm. A pause is not counted, but it does not
  hide a counted hold either, and it adds a second hold to clear.
- Do not clear a `long_hold_review` step by hand. It is the scheduler's to resume, and
  it is still held because something else is open or eligibility refused it; forcing it
  skips the fresh eligibility check that suppression, coverage and the windows live in.
- Do not release a `restore_in_progress` hold to clear this alarm. It stands for a send
  that may already have gone to the prospect, and releasing it without `restore.md` step
  (f)'s three checks is how the same step gets sent twice.
- Do not resume by switching opportunities to automated. Automation never reverses
  manual mode; an opportunity is manual because a person replied.
- Do not enable sending to clear it. Sending switched off is not what this alarm reads.
