# G10: a merge does not move suggestions; the reads follow the pointer instead

**Date:** 20 September 2026 · **Lane:** G10 research · **Spec:** 7.2, Appendix G 37

## What happened

Appendix G 37 asks for "firm/contact merge preserves suppressions, correspondence,
opportunity history, aliases, and uniqueness **under concurrent research enrichment**",
and the lane's acceptance list asks for that scenario's enrichment half. Writing it
found something: `mergeFirms` re-points the children G3a knows about, and
`research_suggestions` is not one of them, because the table did not exist when
`merges.ts` was written.

So a suggestion recorded against a firm that is later merged stays on the source row.
Nothing is lost — the source keeps `status = 'merged'` and a pointer at the target, and
its children remain readable — but the suggestion would not appear in the target's
review queue, and `reviewSuggestion` would refuse it as `firm_merged` to a person who
had done nothing wrong.

## The options

1. **Edit `merges.ts`** to re-point `research_suggestions` and `firm_locations` and
   `research_firm_runs`. Correct, and outside this lane's ownership list; `merges.ts` is
   G3a's and G3b is working beside it.
2. **Add a `ON UPDATE CASCADE` trick.** There is none: the cascade fires on an update
   of `firms.id`, and a merge never changes an id.
3. **Follow the pointer on read.**

## Decision

Option 3. `research_suggestions` rows are never moved, and:

* `listSuggestions` joins the suggestion's own firm to
  `COALESCE(own.merged_into_firm_id, own.id)` and filters and authorizes on *that*, so a
  merged source's suggestions appear under the canonical firm and are visible to its
  assignee;
* `reviewSuggestion` resolves the suggestion's firm through `canonicalFirmOf` — G3a's
  own chain-following helper — and authorizes against, and writes the field of, the firm
  the source became.

This is the same shape `docs/archive/decisions/g3a-merge-preservation.md` chose for everything a
merge cannot move: *"the source is a merged record, not a deleted one … its children
remain readable and attributable"*. Nothing is rewritten, and the read is where the
merge is resolved.

`firm_locations` and `research_firm_runs` need no equivalent, for different reasons.
A coordinate belongs to the place the source firm named, and the target has its own; a
run is a historical record of a research pass over a record that existed. Neither is
something a person reviews.

## What the test proves

`packages/domain/test/research/commands.test.ts`, "serializes: the merge waits for the
enrichment and carries its rows over", runs two real `app_runtime` connections:

1. the enrichment records a suggestion, which holds `FOR KEY SHARE` on the firm row
   through its foreign key;
2. the merge's first statement is `SELECT … FOR UPDATE` on that row, so it blocks — the
   test asserts it is still unsettled 200 ms later;
3. the enrichment commits, the merge proceeds and succeeds;
4. the suggestion's `firm_id` is still the source, it appears in a read of the *target*,
   and reviewing it succeeds.

The other order is the sibling case: a merge that commits first leaves the enrichment's
next command reading a firm whose status is `merged`, and `firmIsResearchable` refuses
it. Both orders are correct and neither loses a row.

## For the coordinator

If a later lane consolidates the merge's child re-pointing — and it probably should,
because by then there will be enrollments, executions, messages and Today entries in
the same position — `research_suggestions` should move with them, and these two reads
should go back to being plain joins. They are marked in `suggestions.ts` with a pointer
at this file.
