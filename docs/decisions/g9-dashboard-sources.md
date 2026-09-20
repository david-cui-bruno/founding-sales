# G9: the dashboard figures that need another lane's tables are behind an interface

**Date:** 20 September 2026 · **Lane:** G9 · **Spec:** 13.4

Section 13.4 asks for thirteen things. Six of them read tables that are being built in
parallel right now: the outbound fence and the sending ramp (G7-2), enrollments and
step executions (G8), and the model classification records (G7b).

Three options: leave them out, invent a table, or build against an interface.

## What was done

`DashboardSources` in `packages/domain/dashboard/sources.ts` declares three methods —
`sending`, `enrollments`, `classifier` — each answering facts or
`{ available: false, owner, reason }`. The API supplies
`unavailableDashboardSources()` until those lanes land.

Three consequences, all of them wanted:

* the DTO, the route and the Mac's rendering of those panels exist and are tested
  today against a fake, so the lane that lands the table wires one function rather
  than designing a surface at the end of its own budget;
* **a figure nobody can compute says so.** This is the point. Rendering a missing
  measurement as `0` tells an operator that nothing was skipped, when the truth is
  that nothing can tell them how many were skipped. The view renders "Not in this
  build (G7-2)" and `packages/domain/test/dashboard/dashboard.test.ts` and
  `apps/desktop/test/settings.test.ts` both assert it;
* the gap is greppable and owned, rather than a surprise in a rehearsal.

## Why not a table

A summary table would be a second copy of facts other tables already hold, and version
one's traffic is "modest and predictable" (section 1). The migration says the same
thing in its header. When a query is measured to be too slow the fix is an index or a
materialized view over the same rows, not a parallel truth that can disagree.

## The follow-up, half done

When G7-2, G8 and G7b are on main, one lane implements the three methods against their
tables and passes the implementation at the single call site in
`apps/api/src/routes/dashboard.ts`. Nothing else changes.

**G7-2 landed on 20 September 2026 and `sending` is now implemented**, in
`packages/domain/dashboard/sendingSource.ts`, and `liveDashboardSources()` is what
the route passes. It took one new file and one changed line, which is the whole
argument for the seam.

Three things the implementation had to settle, and they are worth stating because the
shape only works if each figure stays honest:

* **Each count is keyed to its own instant.** `sent` by `sent_at`, `held` by
  `held_at`, `unknown` by `unknown_terminal_at` with no resolution yet, and 12.5's
  two admin resolutions by `admin_resolved_at`. A fence can therefore appear in two
  counts across two windows, which is right: they are different events.
* **A reply is a thread match.** An incoming message in the same mailbox on the
  fence's `provider_thread_id` at or after the send; "positive" is the classifier's
  `interested`. Counted `DISTINCT` on the message, because a message carries up to
  two classification layers and a double-counted reply is a quietly doubled rate.
* **Two breakdowns stayed unavailable even though the table landed.** 13.4 asks for
  results by sequence and by segment. The fence carries `enrollment_id`, but the
  sequence it belongs to is G8's table, and a breakdown keyed by an enrollment id is
  not the breakdown 13.4 asks for; nothing in this build records a segment at all.
  So `bySequence` and `bySegment` are `Unavailable` with `owner: 'G8'` while their
  siblings are numbers. That is the shape working at a finer grain than a whole
  source, and it is why `Breakdown[] | Unavailable` is worth the union.
