# G6: lane 4 is a firm at the first pipeline stage, or with no opportunity at all

**Date:** 20 September 2026 · **Lane:** G6 Today list · **Spec:** 8.2, 8.1, 7.4, 10.2

## The question

Section 8.2's fourth lane is "New firms". The specification never defines one. Section
8.1's default stages begin with New, and section 7.4 says research "creates candidate
firms" that nobody has opened an opportunity on.

## What was chosen

`newFirmSource` returns a firm when all of these hold:

* `firms.status = 'active'` — a merged firm is history;
* it has no open opportunity, **or** its open opportunity is at the stage with
  `position = 1`;
* no effective firm-wide suppression names it.

Its sort instant is `firms.created_at`, so the lane is oldest first.

## Why each clause

**Position 1 rather than `key = 'new'`.** Section 8.1 lets admins "rename, reorder, add,
or retire nonterminal stages", so `new` is a default key and not a contract. The first
stage is whatever the workspace put first, which is what "not started" means in a
pipeline somebody reordered. (Stage administration itself is unowned; see
`docs/greenfield/crm.md`. This reads the table either way.)

**No opportunity counts.** 7.4: "Research never initiates outreach ... enrollment and
first contact are deliberate salesperson actions." A discovered firm with no opportunity
is exactly the thing this lane is for, and leaving it off the list would make research
results invisible until somebody went looking.

**The suppression check is not optional.** 10.2 makes a firm-wide do-not-contact
"effective immediately and database-enforced", and putting that firm on somebody's
morning list is the one outcome it exists to prevent. The check is `NOT EXISTS` against
`effective_suppressions`, which is the view 10.2 makes authoritative, so a supersession
puts the firm back without this query knowing what a supersession is.

**`created_at` as the sort instant.** A new firm has no due instant, and 8.2 orders
within a lane by "due instant, firm name, and firm ID". Creation time is the only
instant the row has, it is stable, and it makes the lane oldest-first, which is the
order a person working a backlog wants. It is also *data*, which matters for the
determinism property: two databases holding the same firms hold the same creation
instants however the rows were written.

## What is given up

* An unassigned firm is on the admin's list and on nobody else's, because the card's
  assignee is the firm's and a salesperson sees their own (8.2). That is the honest
  state — nobody has been asked to work it — and assigning it is one command away.
* A firm that has been contacted but whose stage was moved back to the first stage
  reappears in lane 4. The pipeline says it is at the beginning; disagreeing with the
  pipeline would be this lane inventing a second notion of progress.
