# G8: the lane that prepares the fence is the lane that dispatches it

**Date:** 20 September 2026 · **Lane:** G8 sequences · **Spec:** 11.2, 12.2, Appendix B, Appendix C

## The tension

Appendix C's job table has no send job kind. It has `sequence.action`, keyed
`step-execution:{id}` and protected by `outbound_fence`, and it has `mail.reconcile`.
Nothing in it claims a fence in state `prepared` and drives it to `dispatching`.

This lane's first shape assumed the sending lane would: `SendHandoff` had `prepare` and
`readOutcome` and no way to send. G7-2 built the other half on the same assumption in
reverse — `prepareOutboundMessage`, `dispatchOutboundMessage`, `readOutboundOutcome`,
and no job to call the middle one. A fence would have been prepared and left there.

## Decision

`SendHandoff` gains `dispatch`, and `sequence.action` calls it. The flow inside one job
is:

1. open a transaction, and inside it re-read eligibility, place the send, render it and
   `prepare` the fence — this is 11.2's "inside the claiming transaction";
2. commit;
3. `dispatchPreparedStep`: read the fence, and **only if it still reads `prepared`**
   call `dispatch`, then read again and move the step to what the fence became.

Steps 1 and 3 are separated because `prepared → dispatching` and the provider call
after it cannot be rolled back (Appendix B). The runner already knows this — it runs an
`outbound_fence` handler outside the completion transaction — so the handler opens the
narrow transaction it does need and commits it before sending.

## Why the `prepared` guard rather than trusting the fence

The fence refuses a second dispatch; that is its job, and it is the guarantee that
matters. The guard is the second lock, and it is cheap: a retry after a stolen lease
re-prepares the same fence (prepare is idempotent by step execution), reads a state that
is no longer `prepared`, and reports instead of sending. `apps/worker/test/sequenceAction.test.ts`
proves it against a real stolen lease and counts both fences prepared and dispatches
attempted.

## A held fence is not the end of the step

G7-2's `g7-held-returns-to-prepared` says a fence held by a cap returns to `prepared`
when the cap clears. So a step whose dispatch came back `held` is held with the cap's
own reason, and `CLOCK_CLEARING_HOLDS` pushes its `not_before` forward by an hour
(five minutes for a reconciling fence). The scheduler's source materializes exactly
those four reasons out of `held`, and no others: `daily_cap`, `domain_cap`,
`outside_email_window`, `send_unknown_reconciling`. Everything else in section 15 is
cleared by a person or by the lane that opened it, and the resume is what re-arms it.

`due_at` does not move and no shift row is written. The cadence still says what it
said; only the earliest moment the worker may look again has changed.

## What this costs

`step_executions_runnable` is now a partial index on `state IN ('pending', 'held')`
rather than on `'pending'` alone, so it covers rows that will mostly never be claimed —
a step held for an unapproved template sits in it until somebody approves the template.
That is a slightly larger index in exchange for one query instead of two, and the
alternative — a second partial index on the four reasons — would have to be rewritten
every time section 15 gains a code.
