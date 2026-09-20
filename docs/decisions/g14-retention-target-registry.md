# G14: a target registry, and two guards that cannot be forgotten

**Date:** 20 September 2026 · **Lane:** G14 retention · **Spec:** 10.3, Appendix C

## The problem

Section 10.3 is a table of ten horizons. Three of those rows were about tables that
did not exist when this lane started: lane G7-2 brings the outbound fences a
cancelled draft lives on, lane G8 brings enrollments and step executions, lane G7b
brings the classifier's stored output. This lane could not sweep them and could not
wait for them.

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

## The guard was paid twice

**Once, mid-branch.** `canceled_drafts` shipped as `declared_pending`, naming
`outbound_messages` as lane G7-2's. G7-2 merged while this lane was still open, the
guard test failed with the sentence it was written to print, and the target was
implemented before the branch was published.

**Once at the final merge.** Migrations 0011, 0012 and 0013 landed together from
this lane's point of view, and the guard printed all thirteen remaining sentences at
once: G7b's `mail_classification_calls` and `mail_reply_confirmations`, G8's ten
sequence tables, G9's `workspace_settings`. Each one named the work, and each one was
done:

* dispositions for all fifteen new tables in `TABLE_RETENTION_COVERAGE`, including
  two new disposition values — `deletion_stops` and `departure_holds` — because
  "stopped but not removed" and "held but not touched" were outcomes the original
  six could not express honestly;
* `commitDeletion` removes `enrollment_linkedin_results` (a prospect's own words) and
  `mail_reply_confirmations` (before the callbacks they reference), terminally stops
  live enrollments with 11.2's existing `admin_stop`, and cancels unexecuted
  `step_executions`;
* `commitDeparture` opens an enrollment-scoped `reassignment` hold per live
  enrollment the departed member was running, which a firm-scoped hold would not
  reach — see `g14-departure-holds-firms.md`;
* and the `deletion_tombstone` source, which G9's entry carried as a second
  obligation — see `g14-deletion-tombstone-source.md`.

That is the mechanism working across a context boundary, which is the case it was
built for: the lane that wrote the list was not, in any useful sense, the lane that
worked it off.

## What remains pending

Nothing. `PENDING_RETENTION_TABLES` is empty, and the mechanism is kept — exported,
typed, and with its shape still asserted — because the next lane to add a table with
a 10.3 obligation it cannot yet satisfy needs somewhere to put it. The assertion that
used to read `length > 0` now reads `toEqual([])`; that is not a weakening, because
`TABLE_RETENTION_COVERAGE` is the guard that needs no foresight and it covers every
table in the catalog whether anyone predicted it or not.
