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

## The remaining two, at the final merge

Directed by the coordinator on 20 September 2026, once 0011 (G7b) was on main and
0012 (G8) was next: **wire both remaining methods at the final merge, so that no
figure is left declared-unavailable unless it truly has no source.** The bar moved
from "the lane that lands the table wires it" to "the last window lane leaves the
dashboard whole", which is the right bar now that this lane is the last one in.

`classifier` reads G7b's `mail_classification_calls` and `mail_reply_confirmations`
(migration 0011). It must carry the model, the prompt version, the cost, and the
corrected-versus-accepted rates — "drift" in 13.4 is not a vibe, it is how often a
person changed the disposition the model proposed, and that only means anything
beside how often they accepted it.

`enrollments` reads G8's tables (migration 0012), which also retires the two
breakdowns above: `bySequence` becomes real once a fence's `enrollment_id` can be
joined to a sequence, and `bySegment` becomes real if G8's enrolment records a
segment — and stays `Unavailable` if it does not, because a figure with no source
says so rather than rendering as zero. That is the rule, not an exception to it.

Both follow the same rules the sending source set: counts over the firms the caller
may see at row-two visibility, anything that is not a firm fact placed by Appendix F
instead, and every key an opaque identifier or a member of a closed set, never a
name.
