# G14: audit events have a horizon and no sweeper

**Date:** 20 September 2026 · **Lane:** G14 retention · **Spec:** 10.3, 5.2

## The apparent contradiction

Section 10.3 gives audit events seven years. Section 5.2 says "application and
migration roles cannot update or delete audit events", and migration 0001 revokes
`UPDATE, DELETE, TRUNCATE` on the table from both. So the retention table states a
horizon that no application code path can enforce.

## Decision

**Write the horizon down, and enforce nothing.** `retention_policies` carries
`audit_events → delete, INTERVAL '7 years'`, because a horizon nobody recorded is a
horizon nobody can audit. The `RetentionTarget` for the kind is `retained`: its
`sweep` is null, the daily job writes a ledger row saying `retained`, and the row
proves the job ran and removed nothing.

The same shape covers `database_backups` (35 days, the RDS instance's own retention)
and `operational_logs` (90 days, the CloudWatch log group's), which are `external`
rather than `retained` because somebody *is* enforcing them, just not this process.

`packages/domain/test/retention/targets.test.ts` reads
`infra/modules/observability/variables.tf` and asserts the default is 90, so the
number in the retention table and the number in the log group cannot drift apart
without the gate saying so.

## Why not make the job delete them

A privileged path that could delete audit events seven years old is a privileged
path that could delete audit events seven minutes old if its boundary arithmetic
were wrong, and the thing it would delete is the record of who did what. The
conservative option under spec silence is to fail closed, and "the application
cannot do this at all" is as closed as it gets.

Removing seven-year-old audit events is an operator action against a database with
the owner role, performed deliberately, and it belongs in a runbook rather than in a
job that runs every night. The ledger row is what tells an operator the horizon
exists and that nothing automatic is honouring it.

## A note on the interval arithmetic

PostgreSQL's `extract(epoch from INTERVAL '7 years')` counts a year as 365.25 days,
so the policy reads back as 2556.75 days rather than 2555. The stored value is
`7 years`; the day count is a derived convenience for the API and the test says so
rather than rounding it.

## The test that matters

`scenario41.test.ts` asserts the revoked privileges directly, under
`SET ROLE app_runtime` — the role the worker runs as — rather than asserting that no
current code path calls `DELETE`. The second is a grep, and a grep is not a
guarantee about the code somebody writes next month.

The same test also asserts the revoked `DELETE` on `retention_runs`,
`deletion_requests` and `departures`, because a retention ledger a retention job
could delete would not be a tombstone.
