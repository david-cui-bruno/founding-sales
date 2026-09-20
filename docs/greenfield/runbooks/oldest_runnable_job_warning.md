# oldest_runnable_job_warning

**Metric:** `OldestRunnableJobAgeSeconds` · **Severity:** warning · **Spec:** 13.2, 13.3

## Symptoms

The oldest job that is runnable — `queued` or `retryable`, `run_at` and `not_before`
both passed, attempts remaining — has been waiting more than five minutes.

## First checks

1. `GET /diagnostics`: runnable, running and dead job counts, worker heartbeat age.
2. Which kind the oldest job is. One slow kind starving the rest looks the same from
   the metric as a dead worker.
3. Worker task count and CPU. The reserved concurrency is pinned in Terraform; a
   single task cannot be scaled by wishing.

## Diagnosis

- **Worker down or flapping:** `worker_heartbeat_missed` is also firing. Work that.
- **Throughput:** more work is arriving than the claim loop can finish. Common after a
  research batch or an import.
- **One poisoned kind:** a handler that fails slowly consumes claims and backs off,
  and the ladder — 30 s, 60 s, 120 s, 240 s, capped at fifteen minutes — keeps the row
  runnable-but-waiting for a long time.
- **A long-held lease:** a job whose lease has not expired is `running`, not runnable,
  so it does not raise this metric; if the count of running jobs is high and static,
  look at the lease expiry instead.

## Safe recovery

- Let bounded backoff run. A warning is not an outage; the fourth failure becomes a
  dead job and is visible to admins.
- If throughput is the cause, scale the worker service task count. Claims use
  `FOR UPDATE SKIP LOCKED`, so a second task takes different rows rather than waiting.
- If one kind is poisoned, fix the handler and deploy. Requeue its dead jobs after,
  not before.

## Escalation

Escalate when the critical threshold follows, or when the queue is growing rather than
draining after a scale-out.

## What must stay held

- Do not delete queued rows to clear the backlog. A job row is often the only record
  that work is owed; the business effect behind it does not disappear with the row.
- Do not shorten the retry ladder as a hotfix. It exists so a failing external service
  is not hammered.
