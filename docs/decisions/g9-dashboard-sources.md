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

## The follow-up

When G7-2, G8 and G7b are on main, one lane implements the three methods against their
tables and passes the implementation at the single call site in
`apps/api/src/routes/dashboard.ts`. Nothing else changes.
