# G8: the two foreign keys on to `outbound_messages`

**Date:** 20 September 2026 · **Lane:** G8 sequences · **Spec:** 11.2, 12.5, Appendix B

## The situation

G7-2's migration 0010 creates `outbound_messages` with nullable `enrollment_id` and
`step_execution_id` columns and a partial unique index on
`(workspace_id, step_execution_id)`. That index is the database half of Appendix B's
first row — "uniqueness creates or reuses one fence" — and it is what makes the
hand-off in `packages/domain/sequences/sendHandoff.ts` idempotent by step execution.
The comment beside those columns says what was left undone: "Neither table exists yet;
G8's 0012 adds the foreign keys."

0010 was not on `origin/main` when this lane first finished, so this document was
written as an instruction to whoever merged the two branches. G7-2 merged the same day
(`origin/main` f0bba83e), this branch merged it, and migration 0012 now ends with:

```sql
ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_enrollment_fkey
    FOREIGN KEY (workspace_id, enrollment_id) REFERENCES sequence_enrollments (workspace_id, id),
  ADD CONSTRAINT outbound_messages_step_execution_fkey
    FOREIGN KEY (workspace_id, step_execution_id) REFERENCES step_executions (workspace_id, id);
```

Appending to 0012 rather than writing an 0013 is correct and not a rewrite of applied
history: 0012 is the last migration and has been applied nowhere.

## Two keys rather than one composite key

`step_executions_semantic_key` is `(workspace_id, id, enrollment_id)`, so a composite
key through it would have said something stronger — that a fence's enrollment and its
step execution agree. It was rejected because 0010 permits a fence with a step
execution and no enrollment (`enrollment_id IS NULL OR step_execution_id IS NOT NULL`),
and a composite foreign key with a NULL component is not checked at all under the
default `MATCH SIMPLE`. The stronger statement would therefore have silently stopped
enforcing the half that matters most. Two keys are checked independently and both
always apply.

## What it cost, which was not nothing

Three fixtures were minting step-execution uuids that named no row, which was lawful
until these keys existed and is not now. `packages/domain/db/testing/stepExecutions.ts`
is the one place that knows how to make a real one — a contact, an enrollment and one
execution against a published one-step sequence version that is created once per
workspace and reused — and `outboundFixtures.ts`, `outboundCases.ts`,
`outboundWorld.ts` and the worker's reconciliation probe all call it.

It lives in `db/testing` rather than in either lane's support directory because the
worker's test needs it too and `@fss/domain/db/testing` is the subpath apps already
import their harness from. That directory is deleted from both images
(`RUN rm -rf packages/domain/db/testing`), so nothing ships.

The two new constraints have their failing insert in `outboundCases.ts` beside the
other `outbound_messages` cases, not in `sequenceCases.ts`: the table they constrain is
that one, and a reader asking what `outbound_messages` refuses should find all of it in
one file. `constraints.test.ts`'s coverage tripwire is what makes that a rule rather
than a preference.

## The adapter

`apps/worker/src/handlers/outboundSendHandoff.ts`, wired into
`sequenceActionJobHandler` in the worker bootstrap:

| `SendHandoff` | G7-2 |
| --- | --- |
| `prepare(context, request)` | `prepareOutboundMessage(context, request)` |
| `dispatch(context, { outboundMessageId })` | `dispatchOutboundMessage(context, deps, { outboundMessageId })` |
| `readOutcome(context, stepExecutionId)` | `readOutboundOutcome(context, stepExecutionId)` |

`OutboundEmailRequest` matches field for field, including `businessDate`, which was
added to this lane's request for exactly that reason. The refusal vocabularies are
mapped by G7-2's own `holdReasonForRefusal`, so there is one table and not two.

`deps` is optional and absent in this release, because the change that reads a
deployment's Gmail client secret and KMS key is reviewed on its own — the same
boundary `mailHandlers(undefined)` respects. An absent `deps` refuses `dispatch` with
`mailbox_disconnected`, and in practice `prepareOutboundMessage` refuses first, because
a fence needs a mailbox to name.
