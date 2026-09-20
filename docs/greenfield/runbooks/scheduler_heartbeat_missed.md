# scheduler_heartbeat_missed

**Metric:** `SchedulerHeartbeat` · **Severity:** critical · **Spec:** 13.1, 13.3, 4.2

## Symptoms

Three consecutive one-minute windows with no scheduler heartbeat. No new due jobs are
being created (4.2). Existing queued jobs still run, so the system looks alive from the
worker's side; `canary_stale` usually follows within fifteen minutes.

## First checks

1. `GET /diagnostics`: heartbeats by component, oldest runnable job age, canary age.
2. Worker service task count and recent stopped tasks — the scheduler runs inside the
   worker process.
3. `pg_stat_activity` for a session holding the scheduler advisory lock, and for long
   transactions on the same connection.

## Diagnosis

The pass records its heartbeat inside the same transaction that takes
`pg_try_advisory_xact_lock`, so a missing heartbeat means one of:

- **No worker process is running.** Then `worker_heartbeat_missed` is also firing.
- **The pass cannot take the lock.** It uses `try`, not the blocking form, so a pass
  that loses returns quietly. A stuck transaction elsewhere holding the same key —
  usually a session that began a pass and never committed — starves every later pass.
- **The pass is timing out.** `statement_timeout` and
  `idle_in_transaction_session_timeout` are both `SET LOCAL`, so a pass that exceeds
  them aborts and writes nothing, including its heartbeat.
- **The schema range check refused.** Step 1 of the pass: a scheduler that does not
  understand the database does not materialize work into it.

## Safe recovery

- Restart the worker service. The lock is transaction-scoped, so a dead task releases
  it; a *live* task in a stuck transaction does not, and that one has to be terminated
  with `pg_terminate_backend`.
- If the pass is timing out, look at which `DueWorkSource` is slow before raising any
  timeout. A slow indexed query is usually a missing index on a table a later lane
  added.
- Missed passes need no catch-up: the sources are queries over business state, so the
  next successful pass materializes everything still due. Job keys are idempotent, so
  nothing duplicates.

## Escalation

Escalate after one failed restart. A scheduler down for more than an hour during a
business day means missed sending windows; those sends move to the next valid window
rather than being lost, but the day's plan is gone.

## What must stay held

- Do not insert jobs by hand to "catch up". Job identity includes the algorithm
  version and the idempotency key; a hand-written row can materialize work the fence
  would otherwise have deduplicated.
- Do not take the advisory lock manually to test it.
- Do not disable the schema-range check to get a pass through.
