# G14: a target registry, and two guards that cannot be forgotten

**Date:** 20 September 2026 · **Lane:** G14 retention · **Spec:** 10.3, Appendix C

## The problem

Section 10.3 is a table of ten horizons. Three of those rows are about tables that
do not exist yet: lane G7-2 brings the outbound fences a cancelled draft lives on,
lane G8 brings enrollments and step executions, lane G7b brings the classifier's
stored output. This lane could not sweep them and could not wait for them.

A `switch` over the kinds, with no case for those three, would have said nothing at
all. Worse, it would have looked complete.

## Decision

**A `RetentionTarget` per kind, with a state.** `implemented` sweeps; `retained` is
10.3 keeping the data on purpose; `external` is CloudWatch's or RDS's retention;
`declared_pending` is a table belonging to a lane in flight. Every kind has an entry
and a sentence, and the job writes a ledger row whichever state it is in.

`retained` exists as a state rather than as an absence because a kind nobody swept
because nobody wrote a target looks exactly like a kind somebody decided not to
sweep, and only one of those is safe.

**`PENDING_RETENTION_TABLES` is checked against the catalog.** Each entry names the
table, the lane that owns it and what it will owe. `targets.test.ts` asks PostgreSQL
whether the table exists and fails the build when it does. The follow-up cannot be
forgotten because the build stops at the moment it becomes possible — which is also
the moment somebody is looking at that area of the code.

**`TABLE_RETENTION_COVERAGE` catches the tables this lane could not name.** It
classifies every table in the schema, and the test compares its keys with
`pg_class`. A lane adding a table has to say what section 10.3 does with its rows
before the gate goes green. `PENDING_RETENTION_TABLES` is a guess about three known
lanes; this is a guarantee about all of them.

## The ledger vocabulary is a superset

`retention_runs.data_kind` accepts the ten policy kinds plus `job_payloads`.
Specification 13.2's "completed payloads are archived after the operational window"
is a sweep on a schedule with a boundary and needs a ledger row like any other, but
a queue payload is not one of 10.3's ten kinds of prospect data. Widening
`retention_policies`' closed list to hold it would have put the queue's housekeeping
into the table an auditor reads to find out what Callie keeps about people, and
would have meant editing a contracts enum this lane does not own.

So the policy table's vocabulary is untouched and the ledger's is the superset. A
test asserts the difference is exactly `['job_payloads']`, so the two cannot drift
apart silently.

## What this does not do

It does not sweep `canceled_drafts`. That is the point of `declared_pending`: the
horizon is recorded, the ledger says every day that the sweep did not happen and
why, and the build fails the moment it becomes writable.
