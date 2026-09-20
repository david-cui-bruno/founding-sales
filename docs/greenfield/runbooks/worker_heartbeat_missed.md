# worker_heartbeat_missed

**Metric:** `WorkerHeartbeat` · **Severity:** critical · **Spec:** 13.2, 13.3, 4.2

## Symptoms

Three consecutive one-minute windows with no worker heartbeat. Queued jobs wait in
PostgreSQL (4.2); nothing is lost, but nothing is sent, synchronized or built either.
`oldest_runnable_job_warning` follows within five minutes.

## First checks

1. `GET /diagnostics`: worker heartbeat age, runnable and running job counts, oldest
   runnable job age.
2. ECS worker service: desired versus running count, recent stopped tasks and reasons.
3. Worker logs for a startup refusal — schema range, missing configuration, or a
   secret it could not read.

## Diagnosis

- **No tasks running:** deployment, image or task-role failure. Read the stopped-task
  reason before redeploying.
- **Tasks running, no heartbeat:** the database is unreachable, or the process is
  refusing to start because the applied schema version is outside
  `WORKER_SCHEMA_RANGE`. That refusal is deliberate: a `business_uniqueness` handler on
  a database without its unique index is an at-least-once handler with nothing behind
  it.
- **Tasks restarting:** an unhandled error in the claim loop. The per-job failures are
  bounded and become dead jobs; a crash loop is the loop itself.

## Safe recovery

- Redeploy the previous known-good digest, or scale the service back up.
- Jobs whose leases expired while the worker was down return to the runnable set
  through `reclaimExpiredLeases`; the next claim increments the fencing token, which is
  what makes the dead worker's token stale. No manual requeue is needed and none should
  be performed.
- An outbound fence left in `dispatching` is **not** retried. It reconciles through the
  Sent-folder search (Appendix B), and a replacement worker may reconcile but never
  send it again.

## Escalation

Escalate immediately if the worker cannot be brought back within fifteen minutes: mail
synchronization stops, so replies and opt-outs are not being read, and every automated
step is unsafe until coverage is proved again.

## What must stay held

- Do not reset `dispatching` fences to `prepared`. The transition is irreversible by
  design and this is the single action that produces a duplicate email.
- Do not clear mailbox coverage holds to "unblock" sending. Coverage clears only after
  the full interval is processed, never after one successful API call (4.2).
- Do not requeue dead jobs in bulk while the cause is unknown.
