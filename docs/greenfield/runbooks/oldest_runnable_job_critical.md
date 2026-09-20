# oldest_runnable_job_critical

**Metric:** `OldestRunnableJobAgeSeconds` · **Severity:** critical · **Spec:** 13.2, 13.3

## Symptoms

The oldest runnable job has been waiting more than fifteen minutes. Sends are missing
their windows, mail synchronization is lagging, and replies are being seen late.

## First checks

Everything in `oldest_runnable_job_warning`, and then:

1. Is the warning alarm also firing, and for how long? A critical that arrived without
   the warning means the queue filled suddenly.
2. `GET /diagnostics` running-job count against the worker task count: a running count
   stuck at the concurrency limit with a static oldest-lease age is a hung handler.
3. RDS connections, CPU and lock waits.

## Diagnosis

At fifteen minutes the cause is rarely throughput. It is usually one of:

- no worker claiming at all;
- every claim slot occupied by a handler blocked on an external call with a lease long
  enough to hide it;
- PostgreSQL contention — a long transaction holding a row every claim wants.

## Safe recovery

- Restore or scale the worker. Expired leases return to the runnable set; the fencing
  token increments on the next claim, so the previous owner's writes affect zero rows
  and it is told `lease_lost`.
- Terminate a genuinely hung backend with `pg_terminate_backend` only after confirming
  which statement it is running.
- After recovery, check the outbound fences. Anything in `dispatching` reconciles
  through the Sent-folder search; nothing is resent.

## Escalation

Page immediately. Fifteen minutes of unclaimed work during a business day means the
sending window arithmetic is already wrong for the rest of the day.

## What must stay held

- No resend of a `dispatching` fence, whatever the backlog says (Appendix B).
- No bulk requeue of dead jobs while the queue is already behind.
- Automated sending stays subject to its window: a job that became due during the
  outage moves to the next valid window rather than being released late in the evening.
