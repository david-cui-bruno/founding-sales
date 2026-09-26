# G14: the deletion tombstone has its own suppression source

**Date:** 20 September 2026 · **Lane:** G14 retention · **Spec:** 10.3, 10.2
**Status:** decided and implemented in migration 0014.

## The requirement

A deletion retains "a minimal normalized suppression tombstone where needed to
prevent renewed contact". Three properties are load-bearing:

* it must be **effective** — research may rediscover the same address tomorrow;
* it must be **terminal** — a deletion is not a ten-minute correction window;
* it must be **not salesperson-reversible** — the person asked to be erased.

Effective means it has to be a row in `suppression_events`, because
`effective_suppressions` is "the one authoritative view for email and dialing"
(10.2). Nothing outside that view can prevent contact.

## Decision

**Migration 0014 adds a seventh value to `suppression_events.source`:
`deletion_tombstone`.** `commitDeletion` writes it for every handle it removes, and
for the firm itself when the target is a firm.

The three properties are inherited rather than newly written, which is the point of
choosing an existing mechanism over a new rule:

* **Effective** — it is a row in `suppression_events` like any other, and
  `SUPPRESSING_SOURCES` in `packages/domain/research/suppression.ts` counts it.
* **Terminal** — `TERMINAL_SOURCES` in `packages/domain/suppression/events.ts`
  includes it, so no ten-minute review hold opens. There is nothing for a window to
  protect: the handles were deleted a statement earlier.
* **Not salesperson-reversible** — `mayCorrectSuppression` allow-lists
  `salesperson_manual` and nothing else, so it refuses this source with
  `not_salesperson_originated` **without being edited at all**. Appendix G 30 already
  proves that path for `prospect_opt_out`; `scenario41.test.ts` now proves it for
  this source too.

**The firm scope is used as well as the handle scope.** A firm deletion inserts a
firm-scoped tombstone in addition to one per handle, because the firm row survives
redaction and a rediscovered firm with a new address would otherwise be contactable.

**The source is deliberately absent from `recordSuppressionCommandSchema`.** Only
`commitDeletion` may mint one; no client may claim a deletion tombstone through the
ordinary suppression endpoint.

## Where the change lands

Six files, not the five that were planned — the sixth is the interesting one.

1. `packages/domain/db/migrations/0014_retention.sql` — `ALTER TABLE
   suppression_events` drops and re-adds `suppression_events_source_known` with the
   widened list. Widening a CHECK is additive, so it is safe to ship with the code
   that writes it rather than a release ahead of it.
2. `packages/contracts/src/dial.ts` — `SUPPRESSION_SOURCES`.
3. `packages/contracts/src/foundationRows.ts` — `suppressionEventSchema.source`.
4. `packages/domain/suppression/events.ts` — `TERMINAL_SOURCES`.
5. `packages/domain/retention/deletion.ts` — the two `recordSuppression` calls.
6. **`packages/domain/research/suppression.ts` — `SUPPRESSING_SOURCES`.** This one
   was not on the list and had to be found. It is the read that decides whether a
   firm may be researched again. Omitting the new source would have left a deleted
   firm rediscoverable by the next research run, which is precisely the outcome
   "prevent renewed contact" names — a widened vocabulary that one reader does not
   know about is worse than no widening at all.

`mayCorrectSuppression` in `packages/domain/src/rules/suppressionCanonicalization.ts`
needed **no** change, and that is the check that the shape is right: a source whose
irreversibility has to be specially written is a source that could be forgotten
somewhere else.

## The first answer, and why it was wrong

This lane's first draft reused `prospect_opt_out`. The argument was that the
vocabulary is a closed CHECK shared across three lanes then in flight, that
`prospect_opt_out` already had all three properties with tests to prove them, and
that a documented deletion request is in some sense prospect-originated.

The coordinator rejected it on 20 September in the right terms: **the audit trail
must not say `prospect_opt_out` for an admin deletion.** The reasoning about the
closed vocabulary is a statement about *when* the change can be made, not about
whether it should be — and scheduling is the coordinator's, not a lane's.

Two things are worth keeping from how the interim was handled. The overrule was
recorded rather than quietly fixed, so this file shows the wrong answer above the
right one. And the follow-up was wired into the build rather than into a memory:
`PENDING_RETENTION_TABLES` carried G9's `workspace_settings` with this change named
in what it owed, so the moment 0013 landed the guard test failed and printed the work
to do. It is implemented here because a test demanded it, which is the only kind of
follow-up that survives a context boundary.
