# G8: the enrollment half of the recovery floor is the first touch, not the start

**Date:** 20 September 2026 · **Lane:** G8 sequences · **Spec:** 12.3, 4.2

**In one line:** `enrollmentFloor()` returns the earliest `completed_at` among the
completed steps of live enrollments assigned to the mailbox's owner — the first
instant FSS actually touched somebody — and `null` when there is none.

## The sentence

12.3: "On expired history cursor ... recover from the earlier of watermark minus one
hour and the oldest unresolved outbound message or active enrollment."

G7-1 shipped `RecoveryFloorSource` as a port with `NO_RECOVERY_FLOOR` behind it. G7-2
implemented the outbound half against `outbound_messages` and left a note in
`MailWorkerOptions` saying the enrollment half was this lane's, combined with
`combinedRecoveryFloor`, which takes the earlier of the two.

## What the floor is for, and therefore what it is

A recovery answers one question: what has this mailbox seen that FSS has not? Nothing
can have been *seen* before FSS touched the prospect. So the instant that matters is
the first completed step of a live enrollment — the email that went out, the LinkedIn
message handed off, the call logged. A reply to any of them can only postdate it.

That is G7-2's reasoning for `dispatch_started_at` over `created_at`, applied to the
other table. The enrollment's `started_at` would drag every recovery back through
however long the first step waited for its sending window, which on a Friday-evening
placement is three days of pages for nothing.

## The reading that would have been wrong

"The earliest not-yet-completed step" is the other tempting answer, and it fails the
one way that matters. A reply to step one arrives while step two is still pending, so
a floor at step two's due instant starts the recovery *after* the evidence — and a
recovery that misses evidence proves coverage FSS does not have, which is the failure
4.2 and 12.3 both exist to prevent. The asymmetry G7-2 stated holds here: too early
costs pages, too late costs the truth.

## Only live, only this mailbox

12.3 says "active enrollment", so `ended_at IS NULL`. An enrollment that has ended
ended because something was read — a reply, a stop, a closed opportunity — and its
evidence is already in the database.

The port is per mailbox, so the enrollments that count are the ones whose assigned
salesperson owns it. Another salesperson's conversation was never going to arrive
here, and including it would widen every recovery by the whole workspace's history.

## Where it is

`packages/domain/sequences/recoveryFloor.ts`, one query, exported from
`@fss/domain/sequences`. `apps/worker/src/handlers/mail.ts` composes it:
`options.recoveryFloor ?? combinedRecoveryFloor(outboundRecoveryFloor(), enrollmentFloor())`.
`packages/domain/test/sequences/recoveryFloor.test.ts` asserts the six cases against a
real database, including the two negative ones — an enrollment that has touched nobody
and an enrollment that has ended — and the composition taking the earlier of two.
