# all_sequences_held

**Metrics:** `HeldEnrollments` over `ActiveEnrollments` · **Severity:** critical · **Spec:** 4.3, 13.3

## Symptoms

Every active enrollment is held. Automation has stopped across the workspace. The alarm
is metric math — the held fraction of active enrollments — and fires only when there is
active work to hold.

## First checks

1. `GET /diagnostics` and the dashboard's hold panel: hold counts by reason code, and
   the age of the oldest.
2. `GET /pauses?open=true`: an administrative pause over all automation, or over the
   email channel, produces exactly this shape.
3. `GET /diagnostics` restore generation, and every mailbox's coverage state.

## Diagnosis

Read the reason codes before anything else; they are a closed set and they name the
cause:

- `scoped_pause` — somebody paused automation. Check who and why; the pause row is the
  history.
- `restore_in_progress` — Appendix E is in force. See `restore_generation_mismatch`.
- mailbox health and coverage — see `mailbox_disconnected` and
  `mailbox_heartbeat_missed`. One unhealthy mailbox holds every automated step kind for
  its owner, and with one salesperson that is the whole workspace.
- `long_hold_review` — holds whose union exceeded seven days. These never resume
  without explicit salesperson review, by design.
- `uncertain_reply` / `ambiguous_match` — a burst of uncertain mail.

## Safe recovery

- Clear the cause, not the holds. Each hold is released by its own control, and a
  control clears only its own hold and always performs a fresh eligibility check.
- When the final applicable hold clears, unexecuted work shifts by the **union** of the
  blocking intervals, so overlapping holds are not double-counted.
- If the union exceeds seven calendar days the enrollment stays held for salesperson
  review and explicit resume. That is not a fault to fix.

## Escalation

Escalate if no reason code explains it, or if holds are being opened faster than they
are cleared.

## What must stay held

- Do not delete `active_holds` rows. Clearing one hold never clears another, and a
  deleted hold is one nothing will re-open.
- Do not release a long-hold review without the review. The rendered future steps have
  to be seen by the salesperson first.
- Do not resume by switching opportunities to automated. Automation never reverses
  manual mode, and a manual opportunity is manual because a person replied.
