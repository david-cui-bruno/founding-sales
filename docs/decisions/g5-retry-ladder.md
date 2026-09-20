# G5: the retry ladder, the attempt budget, and what "dead" costs

**Date:** 20 September 2026 · **Lane:** G5 jobs and scheduler · **Spec:** 13.2, 13.3

## What the specification fixes and what it leaves open

Fixed: "Retryable failures use bounded exponential backoff. Exhausted jobs become dead,
are visible to admins, and are requeueable only by an audited admin command." And an
alarm: "dead job unresolved for one hour".

Open: the base delay, the factor, the cap, the jitter, and how many attempts are
"exhausted".

## Decision

`DEFAULT_BACKOFF` is base 30 s, factor 2, cap 15 minutes, jitter 20 %. From a first
failure that is 30 s, 60 s, 120 s, 240 s, 480 s, 900 s, 900 s …

`maxAttempts` defaults to **four**, declared per handler and written onto the job row at
enqueue time rather than read from a constant at failure time — so changing the default
does not retroactively resurrect or bury jobs already in the queue.

Four attempts over roughly four minutes, then dead, then an alarm one hour later.

## Why four and not ten

Migration 0001 defaults the column to ten. Nothing in this lane changes that default —
migration 0001 is immutable — but every enqueue path states the number explicitly, and
the number is four.

Ten attempts on the default ladder is a job that keeps retrying for about two hours
before anyone is told. For this system that is the wrong shape of failure. Almost
every job kind in Appendix C is either time-sensitive (a sequence action inside a
sending window, a mail sync behind a coverage watermark) or safety-relevant (a
suppression finalizer). A provider that has refused four times in four minutes is down,
and the useful thing is for a human to see it in the dead-job list while the window is
still open, not for the queue to keep trying quietly until the window has closed.

The cost of being wrong in this direction is a dead job an admin requeues with one
audited command. The cost of being wrong in the other direction is a send that was due
at 09:00 going out at 11:00 because nobody was told, or a mailbox held all morning.

Jitter exists because a provider outage makes every job of a kind fail at once, and a
deterministic ladder would then retry them all at once too.

## The reclaim counts as an attempt

A worker that dies mid-job leaves a `running` row whose lease expires.
`reclaimExpiredLeases` returns it to `retryable` **without decrementing
`attempt_count`**, because the claim already incremented it and the work may well have
half-happened. A crash loop therefore exhausts the budget rather than spinning forever,
and `error_code = 'lease_expired'` is what the dead-job list shows so an operator can
tell a crash from a refusal.

If the reclaim finds the attempts already exhausted it writes `dead` directly rather
than `retryable`, so a job cannot sit runnable-but-unclaimable.
