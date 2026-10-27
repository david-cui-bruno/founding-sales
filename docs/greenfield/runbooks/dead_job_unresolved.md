# dead_job_unresolved

**Metric:** `DeadJobOldestAgeSeconds` · **Severity:** warning · **Spec:** 13.2, 13.3

## Symptoms

A job exhausted its attempt budget and has been dead for more than an hour. A dead
queue state does not establish whether an external effect occurred.

## First checks

1. `GET /admin/jobs/dead` as an admin: kind, payload identifiers, attempt count and the
   bounded redacted error detail.
2. Whether the failures share a kind — one broken handler, or one broken row.
3. `GET /diagnostics` for anything else failing at the same time.

## Diagnosis

Read the actual kind, attempt budget and recorded error before anything else: the
detail is redacted but names the stage. Do not assume every kind uses the default
retry policy; some external operations deliberately permit only one attempt.

Common causes: an external provider refusing, a business precondition that changed
between materialization and execution, and a handler bug on one payload shape.

## Safe recovery

- Fix the cause and establish the owning operation's permitted recovery first.
  `POST /admin/jobs/requeue` is admin-only and audited, but that does not make every
  job safe to replay. See [jobs and recovery](../jobs.md).
- An unchanged queue idempotency key is not proof of external-effect safety. For
  dispatched, UNKNOWN or possibly accepted work, reconcile the same attempt through
  the supported operation-specific path, never reset it for an automatic retry.
  Single-attempt phone discovery must not be re-fetched to clear a dead-job alarm.
  A pre-dispatch failure may be requeued only when its owning contract and current
  authority permit it, with current source/access/hold checks preserved.
- A dead job is never archived, precisely so a requeue has something to run.

## Escalation

Escalate if the same kind dies repeatedly after a requeue, or if the dead job is a
`mail.sync`, `mail.recover` or suppression finalizer — those three have safety
consequences rather than convenience ones.

## What must stay held

- Do not requeue a suppression finalizer to "make it apply sooner". The finalizer is
  idempotent and races a legitimate ten-minute correction; the winner must be decided
  by the database, not by an operator's timing.
- Do not delete a dead job to clear the alarm. The row is the record that work is owed.
- Do not raise `max_attempts` globally to avoid dead jobs.
