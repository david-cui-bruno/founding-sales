# G14: the deletion tombstone is a prospect opt-out

**Date:** 20 September 2026 · **Lane:** G14 retention · **Spec:** 10.3, 10.2
**Status:** the decision below was *overruled*. Read the last section first.

## The requirement

A deletion retains "a minimal normalized suppression tombstone where needed to
prevent renewed contact". Three properties are load-bearing:

* it must be **effective** — research may rediscover the same address tomorrow;
* it must be **terminal** — a deletion is not a ten-minute correction window;
* it must be **not salesperson-reversible** — the person asked to be erased.

Effective means it has to be a row in `suppression_events`, because
`effective_suppressions` is "the one authoritative view for email and dialing"
(10.2). Nothing outside that view can prevent contact.

## The constraint

`suppression_events.source` is a closed CHECK with six values, four of which a new
event may carry: `prospect_opt_out`, `prospect_do_not_call`, `salesperson_manual`
and `import`. The same list is a zod enum in `packages/contracts` and a
`TERMINAL_SOURCES` set in `packages/domain/suppression/events.ts` — three files in
two other lanes' territory, with G7-2, G8 and G9 in flight against them.

## Decision

**Reuse `prospect_opt_out` rather than widen the vocabulary.**

It has exactly the three properties, and it has them already proved:
`TERMINAL_SOURCES` includes it, so the suppression is terminal on commit with no
review window; and Appendix G scenario 30 — "a prospect opt-out cannot use the
salesperson correction path" — is an existing passing test that a salesperson cannot
undo one.

It is also not a fiction. A documented deletion request *is* prospect-originated:
somebody asked Callie to stop holding their data and, implicitly, to stop contacting
them. `prospect_opt_out` is the closest true statement in the vocabulary.

**The provenance lives where provenance belongs.** The deletion is recorded in
`deletion_requests` with the event ids it inserted, and in a `deletion.committed`
audit event. A reader asking "why is this handle suppressed" finds the suppression
event; asking "which command made it" finds the deletion record by its id.

**The firm scope is used too.** A firm deletion inserts a firm-scoped tombstone as
well as one per handle, because the firm row survives redaction and a rediscovered
firm with a new address would otherwise be contactable.

## What was rejected

Adding a `deletion_tombstone` source would have been more precise and would have
required editing `packages/contracts/src/dial.ts`,
`packages/contracts/src/foundationRows.ts` and
`packages/domain/suppression/events.ts` — a closed cross-lane vocabulary, mid-flight,
for a distinction nothing currently reads. If a later release wants the finer
provenance, the migration is a widened CHECK and a backfill of the events this
command wrote, which `deletion_requests.tombstone_event_ids` makes findable.

## Overruled, 20 September 2026

The deviation was reported and the coordinator rejected it, in the right terms: **the
audit trail must not say `prospect_opt_out` for an admin deletion.** The reasoning
this lane used — that the vocabulary is closed, cross-lane and mid-flight — is a
statement about *when* the change can be made, not about whether it should be. It
should be, and it is the coordinator's to schedule rather than this lane's to decide.

So `prospect_opt_out` is an interim and is marked as one. The replacement is
`deletion_tombstone`, a source with the same three properties — effective, terminal,
never salesperson-reversible — and its own name in the audit trail. It lands in this
lane's migration 0014 at the final merge, once 0011, 0012 and 0013 are on main and
every lane touching the vocabulary has therefore landed. Five places change together:

1. the `suppression_events_source_known` CHECK, by `ALTER` inside 0014;
2. `SUPPRESSION_SOURCES` and `suppressionEventSchema` in `@fss/contracts`;
3. G4's `SuppressionSource` type and its canonicaliser handling;
4. `TERMINAL_SOURCES` and the effective-suppression read, so the new source is
   terminal on commit and the salesperson correction path refuses it exactly as
   Appendix G 30 requires of `prospect_opt_out`;
5. `commitDeletion`, to record it, and `scenario41.test.ts`, to assert the source
   rather than only the effect.

The trigger is mechanical rather than remembered. `PENDING_RETENTION_TABLES` carries
G9's `workspace_settings` with this change named in what it owes, so the moment 0013
is on main the guard test fails and prints the list above.

Until then, `deletion_requests.tombstone_event_ids` is what makes the interim events
findable, which is also what makes the backfill a one-statement `UPDATE` rather than
an archaeology exercise.
