# G8: `stop_conditions` is a column the database refuses to let you weaken

**Date:** 20 September 2026 · **Lane:** G8 sequences · **Spec:** 11.2, 7.3, Appendix G 18, 26

## The tension

The brief asks for `sequence_versions (draft, published, retired; stop conditions)`.
11.2 lists five terminal conditions — confirmed human email reply, user-recorded
LinkedIn reply, engaged call outcome, opt-out or firm suppression, Won or Lost — and
does not describe any of them as optional.

A column called `stop_conditions` invites a screen with five checkboxes. A sequence
with "confirmed human email reply" unticked would keep emailing somebody who answered.

## Decision

The column exists and carries the set, with two CHECK constraints:

* `stop_conditions <@ ARRAY[...the five...]` — nothing outside the closed vocabulary;
* `ARRAY[...the five...] <@ stop_conditions` — every one of the five is present.

So the column is a record of what stops the sequence, and a row that opts out of any of
them is unrepresentable rather than merely discouraged.

## Why keep the column at all

Two reasons. It documents the contract where somebody reading the schema will find it,
beside the version the contract applies to. And it is where a genuinely optional
condition would live if one is ever added — a per-version "stop on a bounce", say —
without a migration that has to invent the vocabulary from nothing.

## The deviation, named

This is stricter than the brief's phrasing, which implies configurability. It is not
stricter than the specification, which lists the five as facts about sequences rather
than as settings. Under COMMON-G's rule — where the brief and the spec differ, the spec
wins and the lane reports it — this is the report.
