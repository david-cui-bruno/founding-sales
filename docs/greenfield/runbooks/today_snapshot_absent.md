# today_snapshot_absent

**Metric:** `TodaySnapshotMissing` · **Severity:** critical · **Spec:** 8.2, 13.3

## What the metric says

The worker publishes `TodaySnapshotMissing` on every metric pass (once a minute), with no
dimensions, as the maximum over workspaces (lane g67; `collectTodayMetrics` in
`packages/domain/today/metrics.ts`):

- **1** when some workspace is at or past **05:10** in its own business zone
  (`workspaces.business_time_zone`) and the `today.build` job for that business date,
  under the current algorithm version, is not `done`. The key is
  `today:{workspace}:{business_date}:{algorithm}`, the one the scheduler materializes, so
  queued, running, retryable, dead and "no job at all" all read 1, and a job completed
  for yesterday's date never counts for today.
- **0** otherwise: before 05:10 local, once the day's job is `done`, or with no
  workspace at all.

The signal is the job, not `today_snapshots`. A workspace with no firms, callbacks or due
work is built and writes no snapshot row, so "no rows" is not "no list". The alarm is
`Maximum >= 1` over five minutes, one period, missing data ignored: one datapoint of 1
fires it, and while the worker publishes it reads OK rather than INSUFFICIENT_DATA. If it
is INSUFFICIENT_DATA, the worker's metric loop is not publishing at all (see
`worker_heartbeat_missed`).

## Symptoms

At 05:10 workspace time or later, the day's Today list has not been built. The
salesperson opens the Mac and sees an empty or stale list at the start of their day.

## First checks

1. `GET /diagnostics`: scheduler and worker heartbeats, oldest runnable job age.
2. The `today.build` job for today's business date and the current algorithm version,
   and its state: absent, `queued`, `running`, `retryable` or `dead`, and the error code.
3. The workspace business zone in Settings. The business date and the 05:10 deadline are
   computed in that zone, and a zone changed yesterday moves both the build and the
   deadline.
4. Whether a release went out after 05:10 that changed `TODAY_ALGORITHM_VERSION`, or a
   workspace was created after 05:10 (see Diagnosis).

## Diagnosis

The list is built by a job the scheduler materializes with the key
`today:{workspace}:{business_date}:{algorithm}`, from the first pass at or after 05:00
local. The metric reads 1 at 05:10 or later when that job is not `done`, which is one of:

- the scheduler did not run at 05:00 (see `scheduler_heartbeat_missed`): no job exists;
- the job was materialized but nobody claimed it (see `worker_heartbeat_missed` and
  `oldest_runnable_job_*`): it is `queued`;
- the job is failing: `retryable` with an error code, or dead after its four attempts
  (see `dead_job_unresolved`);
- the business zone changed, so the workspace's 05:10 is not the one you expected.

Two events on a healthy system read 1 for about a minute, and a single such datapoint
fires the alarm, which then returns to OK on its next period: a release that changes
`TODAY_ALGORITHM_VERSION` after 05:10 (the new key has no `done` job until the next
scheduler pass and a runner complete it), and a workspace created after 05:10. If the
job is `done` by the time you look and the alarm is OK again, that is what happened.

## Safe recovery

- Fix the underlying scheduler or worker fault; the next pass materializes the job
  again under the same key, so no duplicate snapshot can result.
- If the job is dead, use `POST /admin/jobs/requeue`. The idempotency key is unchanged
  by a requeue, so it cannot produce a second snapshot.
- The list is derived: promotions from replies and callbacks commit with their source
  events, so a late build still contains everything that happened while it was missing.
- The metric returns to 0 on the first metric pass after the job is `done`.

## Escalation

Escalate if the list is still absent an hour into the business day. This is not a data
loss — it is a lost morning of prioritized work.

## What must stay held

- Do not write `today_snapshots` or `today_items` rows by hand. The card is derived by
  trigger from unfinished items; a hand-written card is a card no writer maintains, and
  it would not clear this alarm, which reads the job.
- Do not mark a `today.build` job `done` by hand to silence the alarm. The metric would
  read 0 over a list that was never built.
- Do not lower the algorithm version to force a rebuild; job identity includes it, and
  changing it materializes a second snapshot for the same day.
