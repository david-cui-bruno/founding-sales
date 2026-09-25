# all_sequences_held

**Metrics:** `HeldEnrollments` over `ActiveEnrollments` · **Severity:** critical · **Spec:** 4.3, 11.2, 13.3

## What the metrics say

The worker publishes both gauges on every metric pass, once a minute. They have no
dimensions and are summed over every workspace (lane g72; `collectSequenceMetrics` in
`packages/domain/sequences/metrics.ts`,
`docs/decisions/g72-enrollment-gauges.md`).

- **`ActiveEnrollments`**: live enrollments, meaning `active` or `review_required`.
  Completed and stopped enrollments are not counted.
- **`HeldEnrollments`**: live enrollments whose next work is blocked now by a hold
  nobody chose. That means one of:
  - the enrollment is in long-hold review;
  - its step was held by the worker with a counted reason;
  - an open hold with a counted reason covers its workspace, firm, opportunity, owner
    or the enrollment itself, for the next step's channel or for `enrollment_advance`.

**Not counted**, because somebody chose them or the clock clears them:

- `scoped_pause`. This covers an admin pause at any scope, a salesperson's Today delay,
  and sending switched off (the deployment flag, the workspace attestation, the domain's
  automated-sending switch, or no sending domain).
- `daily_cap`, `domain_cap`, `outside_email_window` and `send_unknown_reconciling`.

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
2. `GET /diagnostics`: the restore generation (a mismatch means Appendix E is in force),
   every mailbox's status and coverage state, and open critical alerts.
3. `GET /pauses?open=true`. A pause does **not** cause this alarm. If one is open, the
   alarm is about a different reason underneath it.

## Diagnosis

Read the reason codes first. They are a closed set and they name the cause. The usual
ones, most likely first:

- `mailbox_disconnected` / `coverage_incomplete`: an owner-scoped mailbox-health hold
  blocks every automated step kind for that owner, and with one salesperson that is the
  whole workspace. See `mailbox_disconnected` and `mailbox_heartbeat_missed`.
- `restore_in_progress`: Appendix E is in force, as a workspace hold blocking every
  action kind. See `restore_generation_mismatch`.
- `provider_refusal` on every firm: Gmail is refusing sends, for example because of a
  rate limit or a suspended account.
- `send_unknown_terminal` / `dead_job`: sends nobody can account for, or failed jobs.
  See `dead_job_unresolved`.
- `long_hold_review`: holds whose union passed seven days. These never resume without
  the salesperson's review, by design.
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
- If the union is longer than seven calendar days, the enrollment stays held for
  salesperson review and an explicit resume. That is not a fault to fix.
- `HeldEnrollments` drops on the first metric pass after the hold is released or the
  review resumed. A step the worker held for a person to clear keeps its held state until
  it is resumed.

## Escalation

Escalate if no reason code explains it, if holds are being opened faster than they are
cleared, or if `HeldEnrollments` equals `ActiveEnrollments` while none of the open holds
or held steps carries a counted reason.

## What must stay held

- Do not delete `active_holds` rows. Clearing one hold never clears another, and nothing
  will reopen a deleted hold.
- Do not pause automation to "quiet" the alarm. A pause is not counted, but it does not
  hide a counted hold either, and it adds a second hold to clear.
- Do not release a long-hold review without the review. The salesperson has to see the
  rendered future steps first.
- Do not resume by switching opportunities to automated. Automation never reverses
  manual mode; an opportunity is manual because a person replied.
- Do not enable sending to clear it. Sending switched off is not what this alarm reads.
