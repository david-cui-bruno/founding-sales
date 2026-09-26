# G4: the suppression journal is a port, and production must have a real one

**Date:** 20 September 2026 · **Lane:** G4 policy, suppression, dialing · **Spec:** 10.2, 4.1, Appendix E

## Where each piece lives

* `packages/domain/suppression/journal.ts` — the `SuppressionJournal` interface, the
  record shape, the deterministic id, the object key, and `recordingSuppressionJournal()`
  for tests.
* `apps/api/src/journal/index.ts` — the S3 client, the local no-op, and the resolver
  that chooses between them.

`@fss/domain` imports no AWS SDK and makes no cloud call; `createS3SuppressionJournal`
takes a `putObject` function rather than a client, so the SDK is loaded by the process
that has credentials and by nothing else.

The brief said `apps/api/journal/**`. Everything in that package is under `src/`,
which is what its `tsconfig.json` includes, so it is `apps/api/src/journal/**`.

## The append is inside the command transaction, before the INSERT

Not after it, and not in a step the route performs first. Specification 10.2: "written
to the object-locked S3 journal before acknowledgement. A lost journal write fails the
command." Putting the append in the one function that writes the event is the only
placement where a new caller cannot forget it.

The two failure modes that follow are both named by the specification:

* **Append throws.** The transaction rolls back. Nothing is suppressed, nothing is
  acknowledged, and the command id is still free.
* **Append succeeds, transaction rolls back.** The journal holds an event the database
  does not. 10.2 calls that safe — "a journal event that outlives a failed database
  transaction is safe to replay and may conservatively retain a suppression" — because
  replay only ever re-adds a suppression, and more suppressed is the safe direction.

## A lost write is a fault, not a refusal

`SuppressionJournalError` propagates out of `runCommand` rather than being returned as
a refusal. A refusal would be recorded in the command receipt, which would burn the
command id: every later retry, including the one after the bucket came back, would be
answered from the cached refusal forever. Propagating rolls the receipt back with the
mutation, and the route answers 503 with a free id.

## The put is conditional

`IfNoneMatch: '*'`. A replay of the same deterministic id does not overwrite the
object it already wrote, and a `412` is success — the event is already durable, which
is all the caller needed. Object Lock would refuse the overwrite anyway; saying so in
the request makes a replay safe rather than dependent on the bucket's retention
settings being right.

## The deterministic id excludes the clock

The digest covers the workspace, the scope, the canonical key, the source and
whichever of the command id or the superseded event id identifies this assertion.
Database time is deliberately absent: Appendix E replays the journal after a restore
and inserts every missing event "idempotently", which only works if the same
suppression hashes to the same id on both sides. An id that moved with the clock would
defeat the replay it exists for.

## The local no-op, and why it is not a hole

A development machine has no bucket and must still be able to record a suppression, so
`localNoopSuppressionJournal()` exists. It is a hole only if production can reach it,
so:

* `resolveSuppressionJournal` reports `durable` and a `description` for the readiness
  report and the structured log;
* `requireDurableJournal` throws `JournalConfigurationError`, and a production
  bootstrap calls it — a missing bucket is a refusal to start, not a silently
  discarded audit trail.

Invariant 4 makes suppressions "effective immediately and database-enforced";
Appendix E rebuilds them from the journal after a restore. A production API that
accepted opt-outs with nothing to replay from would satisfy the first and quietly
break the second.
