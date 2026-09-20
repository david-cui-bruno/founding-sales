# dead_job_unresolved

**Metric:** `DeadJobOldestAgeSeconds` · **Severity:** warning · **Spec:** 13.2, 13.3

## Symptoms

A job exhausted its attempt budget and has been dead for more than an hour. Whatever it
was going to do has not been done.

## First checks

1. `GET /admin/jobs/dead` as an admin: kind, payload identifiers, attempt count and the
   bounded redacted error detail.
2. Whether the failures share a kind — one broken handler, or one broken row.
3. `GET /diagnostics` for anything else failing at the same time.

## Diagnosis

The default budget is four attempts with bounded exponential backoff, so a dead job has
failed four times over roughly eight minutes. Read the recorded error before anything
else: the detail is redacted but names the stage.

Common causes: an external provider refusing, a business precondition that changed
between materialization and execution, and a handler bug on one payload shape.

## Safe recovery

- Fix the cause first. `POST /admin/jobs/requeue` is admin-only and audited, and it
  writes its state transition and its audit event in one transaction.
- The idempotency key is **unchanged** by a requeue, so a requeue can never materialize
  a second copy of work that already exists. Requeueing a job whose effect already
  happened is safe for exactly this reason.
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
