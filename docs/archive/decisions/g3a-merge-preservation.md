# G3a: what a merge does with the things it cannot move

**Date:** 20 September 2026 · **Lane:** G3a CRM core · **Spec:** 7.2, 10.2, Appendix A, Appendix G 37

Section 7.2 says a merge preserves "suppressions, aliases, evidence, stage events,
messages, notes, callbacks, enrollments, and external IDs; conflicts are shown for
resolution". Four of those cannot simply be re-pointed, and the specification does not
say what to do instead. These are the four decisions.

## 1. Suppressions are re-asserted, never moved

`suppression_events` is insert-only by privilege (10.2): `UPDATE` and `DELETE` are
revoked from both application roles. A firm-scoped suppression on the source therefore
*cannot* be updated to name the target, and that is correct — the event is the record
of what a prospect asked for, and rewriting its scope key would make it a record of
something they did not.

So the merge **inserts a new event** for the target, with the source event's
canonicalizer version and source, and a deterministic id `'merge:' || <source event
id>`. Replaying the merge inserts nothing twice, because the id is derived rather than
generated, and a `NOT EXISTS` guard makes the insert a no-op the second time.

Handle-scoped suppressions need no work at all: section 10.2 makes a handle
suppression "global across the workspace", so it already covers the target.

The conservative direction here is one-way on purpose. A merge can only ever *add* a
suppression to the target; it can never remove one, and it never touches the source's.

## 2. A row whose twin already exists stays on the source

The same number at the same contact, the same provider result at the same firm: the
target already has one, and the uniqueness constraint will not take a second. Three
options, and the first two are both lossy:

* delete the source's — loses a retrieval time, a source and a verification;
* overwrite the target's — loses the same things on the other side;
* leave it on the source.

The third is chosen. The source is a *merged* record, not a deleted one: its row
survives with `status = 'merged'` and a pointer at the target, so its children remain
readable and attributable. Nothing is lost, and the target keeps the value it had
verified.

`record_merge_events.preserved` records how many rows each table moved, so the
difference between "moved" and "left behind" is visible in the audit rather than
having to be reconstructed.

## 3. The source's open opportunity is closed, not moved

Only one open opportunity per firm. If both records have one, moving the source's onto
the target would break the partial unique index mid-merge.

The source's is closed as **Lost** with the reason `merged into another firm`, with its
stage event and its `opportunity.terminal_stop` signal like any other close. A recorded
outcome, in the pipeline history, rather than a row that quietly disappears or a
merge that refuses.

The target's open opportunity is untouched. If only the source has one, it moves.

## 4. Contacts merge only within a firm

`mergeContacts` refuses `merge_cross_firm` rather than cascading into a firm merge.
Moving a person between firms would move their routes across the semantic composite
key, which is the thing that key exists to prevent; and a person who is at a different
firm is usually a different person, or a person who changed jobs, and neither is a
duplicate. The answer is to merge the firms first, and then the contacts, which is two
audited commands instead of one that does something the caller did not ask for.

## Conflicts

`website`, `address_line`, `locality`, `region_code` and `postal_code` for firms;
`title` and `linkedin_url` for contacts. A value only the source has is **not** a
conflict — it fills a blank on the target. Two *different* values are, and the merge
refuses with the field names and both values so the person can post again with
`resolutions`.

The API returns the conflicts on a fresh refusal only. A replayed refusal answers from
the command receipt, which records the reason and not the conflicts; recomputing them
on replay would mean re-running a merge the command middleware has already decided the
answer to.

## Concurrency (Appendix G 37)

The merge takes the source firm's row lock before it reads anything else. A concurrent
uncommitted `INSERT` into any child table already holds `FOR KEY SHARE` on that row
through its foreign key, so the two serialize: either the merge waits and carries the
enrichment over, or the enrichment lands after the merge, on a firm every subsequent
command refuses as `firm_merged`. Both orders are correct and neither loses a row.
`test/crm/commands.test.ts` runs the first order against two real connections.
