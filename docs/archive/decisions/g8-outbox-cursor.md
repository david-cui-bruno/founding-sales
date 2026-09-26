# G8: the terminal-stop subscription uses a keyset cursor, not a timestamp

**Date:** 20 September 2026 · **Lane:** G8 sequences · **Spec:** 8.1, 7.3, Appendix A

## The tension

G3a's `crm_domain_events` has no consumption column on purpose
(`g3a-domain-event-outbox.md`): "a subscriber's progress is its own business", which is
what lets two lanes read the same stream at different speeds. Its reader,
`readCrmDomainEvents`, takes a single `after` timestamp and compares with `>`.

Two events written in one transaction share `now()` to the microsecond. A stage change
that closes two opportunities, a merge that closes the source's, an import that closes
several — all produce events with identical `occurred_at`. A timestamp-only cursor
either skips every event after the first at that instant, or never advances past them.

## Decision

`packages/domain/sequences/terminalStops.ts` reads `crm_domain_events` directly with a
row-value comparison on the pair the table is already ordered by:

```sql
AND (occurred_at, id) > ($2::timestamptz, $3::uuid)
ORDER BY occurred_at, id
```

and stores both halves in `sequence_event_cursors`. That is the keyset form of the same
read `readCrmDomainEvents` performs, over the same index, with a total order instead of
a partial one.

Nothing about G3a's table changes, and nothing about its reader changes. A later lane
that wants the same guarantee can copy four lines or `readCrmDomainEvents` can grow an
`afterId`; either is a small change and neither is this lane's to make unilaterally.

## Why the cursor is only an optimisation

`stopEnrollments` touches enrollments whose `ended_at IS NULL`. Consuming the same
event twice stops nothing a second time, and the cursor advances in the *same
transaction* as the stops, so a crash between them is a replay rather than a loss.

That is the right way round: correctness comes from the idempotent operation, and the
cursor only keeps the read short.

## The end reason

The reason an enrollment stopped comes from the opportunity's own `status`, not from
the event's payload, because the status is the fact and the payload describes it. An
opportunity the signal says closed but the pipeline says is open is recorded as
`admin_stop` rather than as `stage_lost`: inventing a stage change that never happened
would put a lie in the business history the dashboard reads.
