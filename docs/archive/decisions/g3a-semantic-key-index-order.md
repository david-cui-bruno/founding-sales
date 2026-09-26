# G3a: the semantic key's index is created before the primary key

**Date:** 20 September 2026 · **Lane:** G3a CRM core · **Spec:** 7.2; `docs/greenfield/migrations.md` step 3

## Spec silence

Section 7.2 requires the semantic composite keys `(workspace_id, contact_id, firm_id)`
and `(workspace_id, opportunity_id, firm_id)`. It does not say how they coexist with
the `(workspace_id, id)` primary key every scoped table has, and they do not coexist
comfortably: `(workspace_id, id)` is a **subset** of `(workspace_id, id, firm_id)`, so
every row that breaks the semantic key also breaks the primary key.

That matters because of a rule this repository already has.
`packages/domain/test/db/constraints.test.ts` requires a failing insert for **every**
enforced constraint, and asserts on the constraint the error *names*. PostgreSQL
inserts into indexes in OID order and reports the first one that fires — the same fact
`docs/archive/decisions/g2-command-id-uniqueness.md` records for `command_receipts`. Whichever
of the two indexes is younger can never be named by any error, so it can never have a
case, so the coverage test fails and there is no way to satisfy it.

## Decision

In migration 0004, `contacts` and `opportunities` declare the semantic key inside
`CREATE TABLE` and take their primary key from a following `ALTER TABLE`:

```sql
CREATE TABLE contacts (
  ...
  CONSTRAINT contacts_semantic_key UNIQUE (workspace_id, id, firm_id),
  ...
);
ALTER TABLE contacts ADD CONSTRAINT contacts_pkey PRIMARY KEY (workspace_id, id);
```

The semantic index is older, so:

* a duplicate contact id **at the same firm** breaks both, and the older index is
  named: `contacts_semantic_key`;
* a duplicate contact id **at a different firm** leaves the semantic key intact, so
  only the primary key can fire and it is named: `contacts_pkey`.

Both are demonstrable, and `test/db/support/crmCases.ts` has a case for each that says
in a comment which half of this it is exercising.

## Why not the alternatives

**Make the semantic key the primary key.** Then `(workspace_id, id)` is no longer
unique and two contacts at two firms could share an id — which breaks
`selectOne(context, 'contacts', { id })` and every foreign key that names the pair.

**Drop the `(workspace_id, id)` key and reference the semantic one everywhere.**
`FOUNDATION_LOOKUP_KEYS` and `scopedQueries.ts` would then have no way to fetch a
contact by id alone, and every caller would have to already know the firm. That is
strictly more friction for no safety: the cross-firm protection comes from the
*children's* references, not from the parent's own key.

**Accept that one constraint has no case and loosen the coverage test.** The coverage
test is the reason every constraint in this repository has a failing insert. Loosening
it for a naming artefact would be paying a real price for a cosmetic one.

## What a later reader should know

This relies on index checking order, which is an implementation fact about PostgreSQL
rather than a documented guarantee — exactly as `g2-command-id-uniqueness.md` notes for
`command_receipts`. It is load-bearing only for *which constraint an error names*,
never for whether the row is refused: both keys are enforced either way. If a future
PostgreSQL changed the order, two failing-insert cases would swap their expected names
and nothing about the data would be at risk.
