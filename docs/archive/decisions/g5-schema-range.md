# G5: why both services declare schema range 2–2

**Date:** 20 September 2026 · **Lane:** G5 jobs and scheduler · **Spec:** 4.2, Appendix G 22

## What changed

`packages/domain/db/schemaRange.ts` before this lane:

```
CURRENT_SCHEMA_VERSION         = 1
PREVIOUS_RELEASE_SCHEMA_RANGE  = { 1, 1 }
API_SCHEMA_RANGE               = { 1, 1 }
WORKER_SCHEMA_RANGE            = { 1, 1 }
```

and after:

```
CURRENT_SCHEMA_VERSION         = 2
PREVIOUS_RELEASE_SCHEMA_RANGE  = { 1, 2 }
API_SCHEMA_RANGE               = { 2, 2 }
WORKER_SCHEMA_RANGE            = { 2, 2 }
```

## The widening of the previous release's range

`docs/greenfield/migrations.md`: "The deployment order is: widen the range, ship that
release, then ship the migration. So `PREVIOUS_RELEASE_SCHEMA_RANGE.maximum` must
already cover the version the next migration produces." The compatibility test asserts
it, and the assertion is the gate.

Widening it to `{1, 2}` in the same pull request as migration 0002 is what the lane
brief instructs, and it is honest here for one reason: nothing has been deployed. G0's
`{1, 1}` was never a promise made to a running production binary. From the first real
deployment onwards the widening must genuinely precede the migration by a release, and
the test will keep saying so.

G2 ships migration 0003 in parallel and widens the same constant to include 3.

## Why the minimum is 2 and not 1

A range with minimum 1 would say "this binary runs against a version-1 database". It
does not. The worker's claim writes `fencing_token`, and the API's dead-job list reads
`dead_at` and `requeued_count`; on a version-1 database the first statement either
service runs fails with an undefined column.

Specification 4.2 gives the worker one job in that situation: "The worker exits
non-zero when the database is outside its range rather than writing rows another binary
cannot read", and the API "reports `degraded` on `/health` with the reason". A minimum
of 2 is what makes a version-1 database `database_behind_binary` — a clear refusal at
startup — instead of a healthy-looking task that throws on its first claim.

Where the specification is silent the conservative option wins, and failing closed at
startup is the conservative option.

## The consequence for the next lane

A binary whose range is `{2, 2}` refuses a version-3 database. That is correct for
*this* release and it is the reason the expand/migrate/contract order exists: the
release that ships migration 0003 runs beside binaries whose declared previous range —
`{1, 2}` widened to `{1, 3}` by that same pull request — covers it. Two lanes adding
migrations in parallel both widen the constant, and the compatibility test fails for
whichever one forgets.
