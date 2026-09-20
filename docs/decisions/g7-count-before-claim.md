# G7-2: the daily cap is counted before the fence is claimed

**Date:** 20 September 2026 · **Lane:** G7-2 sending · **Spec:** 12.7, Appendix G 33

## The two irreversible things, in order

`dispatchOutboundMessage` does two things that cannot both be rolled back:

1. increments `mailbox_send_days.automated_sent`, conditionally on the cap;
2. claims the fence — the atomic `prepared → dispatching` that mints the attempt token.

A process can die between them. Whichever order they are in, one failure mode exists,
and they are not equally bad.

## Decision

Count first, claim second.

## Why

**Dying after the count and before the claim** leaves the day one send short. The fence
is still `prepared`, so the next attempt sends it and counts it again; the mailbox
sends four emails on a day it was allowed five. That is a lost slot, it is invisible to
the prospect, and it self-corrects tomorrow.

**Dying after the claim and before the count** leaves a fence in `dispatching` that was
never counted. The fence can never be sent again — `dispatching` is irreversible — so
the email is lost *and* the day's counter under-reports. Repeat that a few times and a
mailbox with a cap of fifty has sent sixty, because ten of them were never counted.
A cap that can silently lose count is not a cap, and 12.7's whole purpose is that the
number is true.

So the order is chosen by asking which failure is recoverable, and losing a slot is.

## Why the count is one statement

```sql
UPDATE mailbox_send_days
   SET automated_sent = automated_sent + 1
 WHERE workspace_id = $1 AND mailbox_id = $2 AND business_date = $3::date
   AND automated_sent < $4
```

The `WHERE automated_sent < $4` *is* the cap. Reading the counter, comparing it in
TypeScript and then writing it back would let two workers each read four, each decide
four is under five, and each send. That is Appendix G 33 — "mailbox caps hold excess" —
failing in the one way that matters, and it is a race no test that runs the two workers
sequentially would ever catch.

`rowCount === 0` means the cap is reached, and the fence is held.

## The refund, and its boundary

There is exactly one place the count is given back: between the count and the claim,
when refreshing the mailbox's access token fails. Nothing has been dispatched at that
point and "nothing was attempted" is still provable, so the slot returns.

After the claim there is no refund, ever, whatever Gmail said. The message may have
gone, and a cap that refunded a slot for a message that was actually delivered would
be a cap that could be exceeded by arranging for timeouts.

## The backstop nobody should need

`mailbox_send_days_within_cap` is `CHECK (automated_sent <= cap_granted)`, and
`cap_granted` never decreases — an admin lowering a cap mid-incident lowers
`mailbox_send_ramp.admin_daily_cap`, which the send path reads fresh, rather than the
day's high-water record. Without that rule the constraint would refuse the emergency
lowering because five emails already went out this morning, which is the opposite of
what an incident needs.
