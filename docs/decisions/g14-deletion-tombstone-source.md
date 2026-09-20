# G14: the deletion tombstone is a prospect opt-out

**Date:** 20 September 2026 · **Lane:** G14 retention · **Spec:** 10.3, 10.2

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

## Reported deviation

This is the one place where an honest reading of the spec would have preferred a new
vocabulary entry and the lane chose an existing one for coordination reasons. The
coordinator should know, because the audit trail says `prospect_opt_out` for events
no prospect sent.
