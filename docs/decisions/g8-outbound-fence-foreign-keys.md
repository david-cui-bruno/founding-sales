# G8: the two foreign keys on to `outbound_messages` are not in 0012 yet

**Date:** 20 September 2026 · **Lane:** G8 sequences · **Spec:** 11.2, 12.5, Appendix B

## The situation

G7-2's migration 0010 creates `outbound_messages` with, per the coordinator's relay,
nullable `enrollment_id` and `step_execution_id` columns and a partial unique index on
`(workspace_id, step_execution_id)`. That index is the database half of Appendix B's
first row — "uniqueness creates or reuses one fence" — and it is what makes the hand-off
in `packages/domain/sequences/sendHandoff.ts` idempotent by step execution.

0010 was not on `origin/main` when this lane finished (`origin/main` is 67c85622,
migrations 0001–0009). Migration 0012 therefore does **not** add:

```sql
ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_enrollment_fkey
    FOREIGN KEY (workspace_id, enrollment_id) REFERENCES sequence_enrollments (workspace_id, id),
  ADD CONSTRAINT outbound_messages_step_execution_fkey
    FOREIGN KEY (workspace_id, step_execution_id) REFERENCES step_executions (workspace_id, id);
```

## Decision

Leave them out rather than guess at G7-2's column names, and record the exact statement
here so that whoever merges the two branches adds four lines rather than re-deriving
them.

The coordinator's instruction was to write the adapter and the two keys at the final
merge if 0010 had landed, and to leave this document if it had not. It had not.

## What is lost until they are added

Nothing at runtime. The hand-off is an interface in this lane and an adapter in G7-2's;
neither reads a foreign key. What the keys buy is the same thing every other composite
key in this schema buys: a fence naming an enrollment that does not exist, or an
enrollment in another workspace, becomes unrepresentable rather than merely unlikely.

## What to do

When 0010 and 0011 are both on main, merge `origin/main` into `g8/sequences`, confirm
the column names against `0010_outbound.sql`, and add the `ALTER TABLE` above to the end
of `0012_sequences.sql` — it is the last migration and has not been applied anywhere, so
appending to it is correct rather than a rewrite of applied history. Then wire
`createOutboundSendHandoff` (G7-2's two functions, adapted to `SendHandoff`) into
`sequenceActionJobHandler` in `apps/worker/src/bootstrap/main.ts`, replacing
`unavailableSendHandoff`.
