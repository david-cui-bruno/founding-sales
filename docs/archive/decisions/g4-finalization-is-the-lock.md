# G4: the finalization row is the lock

**Date:** 20 September 2026 · **Lane:** G4 policy, suppression, dialing · **Spec:** 10.2, Appendix A, Appendix C

## What the specification asks for

"At the deadline, an idempotent finalizer locks the event and enrollments and performs
terminal stops. A concurrent correction or finalizer has one winner."

Appendix C names the protection for `suppression-finalize:{event}` as "event lock and
terminal marker".

## Why the obvious implementation is impossible

`SELECT ... FOR UPDATE` on `suppression_events` does not work, and not for a subtle
reason: PostgreSQL requires the `UPDATE` privilege on a table to take a row lock on
it, and migration 0001 revokes `UPDATE`, `DELETE` and `TRUNCATE` from `app_runtime`
and `migration` to make "insert-only" true. A row lock on that table is refused with
`42501` for exactly the role the application runs as.

Nor can the event carry a status column. It is insert-only; a status that could change
is the thing the privilege exists to prevent.

## Decision

`suppression_finalizations`, primary key `(workspace_id, event_id)`, one row per
decided event, `outcome` either `finalized` or `corrected`. Both the correction and
the finalizer begin with:

```sql
INSERT INTO suppression_finalizations (workspace_id, event_id, outcome, ...)
VALUES (...)
ON CONFLICT ON CONSTRAINT suppression_finalizations_pkey DO NOTHING
RETURNING outcome
```

A returned row means this caller won. No returned row means the other one did, and a
second `SELECT` says which — a read that cannot see a torn state, because the
conflicting insert already waited on the winner's row lock before deciding to do
nothing.

The table is append-only by privilege for the same reason `suppression_events` is: the
winner of the race is a fact about what happened, and a second writer must not be able
to rewrite it into a different answer.

## The ordering this forces, and the deferred foreign key

The correction has to claim *before* it writes the supersession event. A correction
that wrote its event first and then lost the race would have lifted a suppression the
finalizer had already made terminal — the worst possible direction to fail in.

But the claim row names the correction event in `correction_event_id`, and that event
does not exist yet. So `suppression_finalizations_correction_fkey` is `DEFERRABLE
INITIALLY DEFERRED`: the reference is checked at commit, by which time the event is
there. Naming an event that does not exist yet is legal for exactly the window the
claim needs, and no longer.

One consequence for anyone writing a test: `recordCorrection` must be called inside a
transaction, the way `runCommand` and the job runner call it in production. In
autocommit the claim's implicit transaction ends before the event is written and the
deferred check fires. `packages/domain/test/policy/appendixG.test.ts` has an
`inTransaction` helper and a comment saying why.

## What the marker means to a later lane

An event with an `outcome = 'finalized'` row is one whose terminal enrollment stops are
owed. No enrollment table exists yet, so the sequences lane subscribes to this marker
rather than to a hook this lane would have had to invent. A prospect-originated
suppression writes the same marker in its own transaction, because 10.2 makes it
terminal immediately and there is no window to race for.
