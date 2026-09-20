# outbound_invariant_failure

**Metric:** `OutboundSafetyInvariantFailures` · **Severity:** critical · **Spec:** 12.5, Appendix B

## Symptoms

An outbound safety invariant failed: a fence in a state the state machine does not
allow, two fences for one origin, a duplicate deterministic Message-ID within a
mailbox, or an envelope column changed after dispatch began.

## First checks

1. The structured log event naming the invariant and the fence id. No message content
   is in it.
2. The fence row: state, origin (`step_execution_id` or `draft_id`), attempt token,
   dispatch timestamp, provider ids.
3. Whether any duplicate actually reached a prospect — the Sent folder of the sending
   mailbox is authoritative, searched by `rfc822msgid:`.

## Diagnosis

Invariant 1 is the highest-priority rule in the system: delivery is at most once, and a
held or skipped email is acceptable where a duplicate is not. A breach here is either a
code defect that got past the partial unique indexes, or a hand-edited row.

Establish first whether this is a *potential* breach caught by a check or an *actual*
duplicate delivery. They need different responses and only the Sent folder can tell
them apart.

## Safe recovery

- Stop automated sending: open an all-automation pause or an `email` channel pause,
  which blocks `email_send` and leaves synchronization, opt-out processing, Today and
  manual calling running (10.1).
- Reconcile the affected fences. If a fence ends `unknown_terminal`, an admin marks it
  delivered or skipped. Delivered continues the sequence from the original dispatch
  time; skipped stops that enrollment for salesperson review. Neither releases the step
  for resend.
- Fix the defect and deploy before releasing the pause.

## Escalation

Page immediately and tell the founder. If a prospect received a duplicate, that is a
product incident, not only an engineering one.

## What must stay held

- Sending stays paused until the cause is understood. This is not a "watch it for a
  while" alarm.
- Never move a fence backwards out of `dispatching`, and never clear an attempt token.
- Never delete a fence row to make the check pass. The row is the at-most-once
  guarantee.
