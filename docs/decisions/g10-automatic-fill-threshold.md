# G10: 0.9 to fill a canonical field, and only five fields may be filled

**Date:** 20 September 2026 · **Lane:** G10 research · **Spec:** 7.4

## Spec silence

> High-confidence non-contact facts may populate empty canonical fields. Lower-confidence
> or conflicting facts remain visible suggestions and never overwrite confirmed values.

The specification does not say what "high" is, and it does not say which fields are
canonical enough to be filled. It says elsewhere that a route needs 0.8 association
confidence to become usable, which is the only number of this shape it gives.

## Decision

`AUTOMATIC_FILL_CONFIDENCE = 0.9`, and the fields are exactly:

```
website · address_line · locality · region_code · postal_code
```

`FILLABLE_CANONICAL_FIELDS` in `packages/domain/research/types.ts`.

## Why 0.9 rather than 0.8

A route's threshold governs whether a person may be contacted through it, and it is
checked again at the point of contact: `authorizeDial` re-reads the route's eligibility
and version immediately before a handoff, and the send path re-reads everything inside
its claiming transaction. A wrong route is refused twice more before it does damage.

A canonical field written with no review is checked again by nobody. It sits on the firm
until somebody notices it is wrong — and because it was written automatically, nobody is
expecting to check it. The stricter number belongs to the unreviewed path, and 0.8 is
already the number a *reviewed* path uses.

The gap is deliberately small. Making it 0.99 would mean nothing is ever filled, which
turns the sentence in 7.4 into dead text and puts five more clicks on every discovered
firm.

## Why those five fields

Two rules produced the list.

**Non-contact.** Section 7.4's permission is for "non-contact facts". No field here is a
way to reach a person: an address and a locality are where a firm is, not a channel.
`name` is absent for a different reason (below), and every contact route is absent by
construction — they live in `phone_routes` and `email_addresses`, which this path
cannot write.

The test asserts the *set* has no field matching `email|phone|note|body|contact|assign`,
so a future widening has to come past that assertion.

**Empty is unambiguous.** A field that is `NULL` has never been decided by anybody, so
filling it takes nothing away. That is why the write is `UPDATE … WHERE <column> IS
NULL` rather than a read followed by a write: a value that arrived in between is not
overwritten, the update affects no row, and the suggestion stays `proposed` for a person
to compare. Section 7.4's "never overwrite confirmed values" is that `WHERE` clause.

### Why `name` is not fillable

A firm's name is never empty — `firms_name_present` refuses a blank one — so the
"empty field" case cannot arise. A provider that returns a better name is offering a
*replacement*, which is an overwrite, which is a person's decision.

### Why `assigned_user_id` is not fillable

Assigning a firm puts work on somebody's list. It is an admin command with a hold, a
domain event and an audit trail (Appendix A, "Reassign firm"), and a discovered firm
deliberately arrives unassigned — that omitted field is half of invariant 8.

## The three guards

1. `decideSuggestionEffect` is pure and is the only place that decides; it returns
   `propose` for every kind that is not `canonical_field`, every field outside the set,
   every present value and every confidence below the threshold.
2. The `WHERE <column> IS NULL` clause.
3. `research_suggestions_only_facts_apply` in migration 0005 refuses an `applied` row
   of any kind but `canonical_field`, so a future caller that tried could not record it
   even if the first two were bypassed.

A fill writes an audit event naming the field, the provider and the suggestion, so the
provenance of a value nobody typed is always readable.
