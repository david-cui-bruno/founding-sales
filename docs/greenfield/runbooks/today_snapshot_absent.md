# today_snapshot_absent

**Metric:** `TodaySnapshotMissing` · **Severity:** critical · **Spec:** 8.2, 13.3

## Symptoms

No Today snapshot exists for the workspace business date at 05:10 workspace time. The
salesperson opens the Mac and sees an empty or stale list at the start of their day.

## First checks

1. `GET /diagnostics`: scheduler and worker heartbeats, oldest runnable job age.
2. Whether a `today.build` job for today's business date is queued, running, retryable
   or dead.
3. The workspace business zone in Settings. The snapshot date is computed in that zone,
   and a zone changed yesterday moves the 05:00 build.

## Diagnosis

The snapshot is built by a job the scheduler materializes with the key
`today:{workspace}:{business_date}:{algorithm}`. Absence at 05:10 is one of:

- the scheduler did not run at 05:00 (see `scheduler_heartbeat_missed`);
- the job was materialized but nobody claimed it (see `worker_heartbeat_missed` and
  `oldest_runnable_job_*`);
- the job ran and failed to exhaustion and is now dead (see `dead_job_unresolved`);
- the business zone changed and the alarm's idea of 05:10 no longer matches the
  workspace's.

## Safe recovery

- Fix the underlying scheduler or worker fault; the next pass materializes the job
  again under the same key, so no duplicate snapshot can result.
- If the job is dead, use `POST /admin/jobs/requeue`. The idempotency key is unchanged
  by a requeue, so it cannot produce a second snapshot.
- The list is derived: promotions from replies and callbacks commit with their source
  events, so a late build still contains everything that happened while it was missing.

## Escalation

Escalate if the list is still absent an hour into the business day. This is not a data
loss — it is a lost morning of prioritized work.

## What must stay held

- Do not write `today_snapshots` or `today_items` rows by hand. The card is derived by
  trigger from unfinished items; a hand-written card is a card no writer maintains.
- Do not lower the algorithm version to force a rebuild; job identity includes it, and
  changing it materializes a second snapshot for the same day.
