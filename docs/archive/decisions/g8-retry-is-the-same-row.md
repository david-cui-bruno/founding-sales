# G8: `retry_call` re-arms the execution rather than creating a second one

**Date:** 20 September 2026 · **Lane:** G8 sequences · **Spec:** 9.1, 11.2, Appendix C

## The tension

11.2: "`step_executions` are unique by enrollment and step." 9.1's no-answer row: "Record
the attempt and follow the step's configured `advance | retry_call` behavior."

A retry that inserted a second execution of the same step would violate the uniqueness.
Relaxing the uniqueness would take the protection out from under Appendix C's
`step-execution:{id}` key, whose whole job is that there is one row per step of an
enrollment to build a key from — and therefore one job, and therefore at most one
email.

## Decision

The uniqueness stands, `UNIQUE (workspace_id, enrollment_id, step_id)`, and a retry
moves the existing row's `due_at` forward and increments `attempt_count`. The move is
recorded in `step_execution_shifts` with `reason = 'retry_call'`, so "how many times did
we try this firm" is answerable from the history rather than from a count of rows that
do not exist.

`attempt_count` is bounded at 20 by a CHECK: a call step configured to retry for ever
is a configuration mistake, and the bound is where it shows up.

## Why not relax the uniqueness for call steps only

A partial unique index over email steps would have been possible. It was rejected
because the invariant it protects is the one at the top of the specification's priority
list, and an index with an exception is an index somebody will widen later for a second
good reason.
