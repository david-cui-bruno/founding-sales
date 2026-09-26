# G5: what "completed payloads are archived" means

**Date:** 20 September 2026 · **Lane:** G5 jobs and scheduler · **Spec:** 13.2, 10.3

## The sentence

Specification 13.2: "Completed payloads are archived after the operational window;
durable business dedupe remains for its required horizon."

It does not say where they are archived to, how long the operational window is, or what
happens to the job row afterwards. Three things had to be chosen.

## Decision

**Archival is redaction in place, not a copy.** `archiveCompletedPayloads` sets
`payload = '{}'::jsonb`, clears `error_detail`, and stamps `payload_archived_at`. The
row stays.

Copying the payload into a `job_archives` table would have kept exactly the data the
sentence asks us to stop keeping, in a second place, under a second retention policy.
A job payload names a step execution, a mailbox, a firm or an import row; section 10.3
retains *business* records and *operational logs*, and a queue payload is neither — it
is a pointer to a business record that is still there. What is worth keeping is the
fact that the work ran, and the row carries that: kind, key, attempts, timings,
terminal state.

**The dedupe key is untouched.** `(workspace_id, kind, idempotency_key)` is what stops
a second materialization of the same work, and it survives archival. That is the
"durable business dedupe remains for its required horizon" half of the sentence.
Deleting the row is a separate decision belonging to the retention lane, which owns
`retention_policies` and knows each kind's horizon.

**A dead job is never archived.** `jobs_payload_archived_only_when_done` is a database
constraint, not a query predicate: an audited admin requeue has to have a payload to
run, and a requeue of an emptied job would silently run different work.

**The window is the caller's, defaulting to seven days.** `olderThanSeconds` is a
parameter rather than a constant, because specification 13.3 says thresholds are
configuration versioned with the release. Seven days matches the shortest operational
horizon in the retention table (raw MIME and temporary mailbox content), which is the
conservative choice when the spec is silent.

## What this does not do

It does not sweep on a schedule yet. `archiveCompletedPayloads` is a function with a
bounded `limit`; the `retention.batch` job kind that calls it on a cadence belongs to
the retention lane, which will also decide when a `done` row is deleted outright. Until
then the payloads simply stay, which is the conservative failure: keeping data too long
is a retention finding, and dropping a dedupe key too early is a duplicate send.
