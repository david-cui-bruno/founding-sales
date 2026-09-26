# G6: a callback's Today entry lands on its due date, or on today if that has passed

**Date:** 20 September 2026 · **Lane:** G6 Today list · **Spec:** 8.2, 9.1, Appendix D

## The question

Section 8.2 builds "one workspace snapshot per workspace business date" and promotes a
callback "with its source event". A callback confirmed on Monday for Thursday at 2pm is
one source event and at least two candidate dates. Which snapshot does it join?

The specification does not say, and the two obvious answers are both defensible:
*today's*, because promotion is about the list a person is looking at; or *the due
date's*, because that is when the work is.

## What was chosen

`greatest(due_date, today)`, in the workspace's business zone, where both are computed
by PostgreSQL from `workspaces.business_time_zone`.

So: a callback due today or in the past lands on today's card. A callback due Thursday
lands on Thursday's card, and a row for Thursday exists from Monday.

## Why

**One rule, applied by both writers.** The promotion trigger and the 05:00 build have to
agree about a callback, or the build would create a second entry beside the promoted
one. `callbackSource` enumerates every open callback due on or before the date it is
building, and `today_callback_changed` uses the same expression. A rule that said
"today's list" would have needed the build to re-home the entry every morning and the
trigger to know which mornings had already passed.

**An overdue callback is today's problem.** The `greatest` is what moves a Thursday
callback nobody worked onto Friday's list rather than leaving it on a day that is over.
Without it the entry would sit on a snapshot date nobody reads, and 8.2's lane 2 would
quietly lose work.

**Appendix D says the instant is stored four ways.** The card sorts on the resolved UTC
instant and the date is derived from it in the workspace zone, which is the zone
Appendix D names for "Today snapshot date". The callback's own `source_time_zone` is the
firm's and is what renders "Thursday at 2pm"; it is deliberately not what decides which
list the task is on, because two firms in two zones would then be on two different days
of the same salesperson's week.

## What is given up

**`today_snapshots` holds future dates.** A callback confirmed for next month creates a
card for next month today. Nothing reads it until that date — every read names one
business date — and the 05:00 build for that date finds the row already there and
upserts over it. The alternative, promoting only when the date arrives, needs something
to notice the date arriving, and that something is the build, which would make the
"promotion" a daily job rather than an event.

**A workspace that changes its business zone re-homes callbacks near midnight.** The
date is recomputed from the zone each time a callback row is touched, so a callback due
at 23:30 in one zone may be a different date in another. That is the same exposure every
zone-dependent date in the system has, and `daily_counters` records the zone beside the
date for the same reason. The Today snapshot does not, because it is rebuilt daily and
has no history to re-date.
