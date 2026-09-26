# The canary age is the newest run's latency, not the gap between canaries

**Lane:** g41 · **Date:** 23 September 2026 · **Spec:** 13.3, 16.2 · **Evidence:** the first production deploy, 23 September 2026, ~23:58Z, `scripts/productionSmoke.mjs` at release runbook 6.1

## What happened

The first production smoke ran six checks against `https://api.usecallie.com`. Five
passed. The sixth was

```
FAIL canary (age=359.441672s limit=300s)
```

and nothing was wrong with production. The scheduler was inserting canaries, the worker
was completing them within seconds of the insert, and the metrics publisher was
publishing every minute.

`FSS/CanaryCompletionAgeSeconds` was

```sql
SELECT extract(epoch FROM now() - max(completed_at)) FROM canary_runs
```

— **seconds since the newest completion**. The canary is one `canary_runs` row per
workspace per **quarter hour** (`apps/worker/src/scheduler/sources.ts`, `insertCanaryRun`,
13.3). Sampled every 60 seconds, those two facts make a sawtooth: 59, 119, 179, 239,
299, 359, 419, and back to 59 when the next canary completes. Two consequences, both
observed:

* **The smoke's `CANARY_MAXIMUM_AGE_SECONDS = 300` check fails most of the time.** The
  value is above 300 for roughly ten minutes of every fifteen on a perfectly healthy
  idle system. The eighth rehearsal's smoke passed only because it ran about two
  minutes after the workspace bootstrap (release.md 8.0p) — the one part of the cycle
  where the value is small.
* **`fss-prod-canary-stale` flapped.** Threshold `var.canary_stale_seconds` = 300,
  period 60, two evaluation periods, `treat_missing_data = "breaching"`
  (`infra/modules/alerts/main.tf`). It went OK→ALARM→OK three times in the first hour
  and e-mailed the operator on every transition. The operator ran
  `aws cloudwatch disable-alarm-actions --alarm-names fss-prod-canary-stale` to stop
  the mail; that is temporary, and the next `terraform apply` re-enables the actions
  without anybody having to remember, because the resource sets them.

The spec never asked for the gap between canaries. 13.3 and the runbook both say
"canary not completed within five minutes", the alarm variable's own description said
"the canary is inserted every 15 minutes and proves scheduler-to-worker completion", and
`docs/greenfield/jobs.md` says what the canary proves: "a scheduler inserting jobs nobody
claims is alive, a worker with an empty queue is alive, and the system between them is
dead". Every one of those sentences is about a **run** — an insert and its completion.
The query measured the interval between two different runs, which is a property of the
schedule, not of the system.

## The decision

**The metric keeps its name and changes its meaning to the one the specification's
sentence describes: the newest canary run's scheduler-to-worker latency.**

The name stays because it is a contract with four readers that a rename would have to
move in step: the alarm (`infra/modules/alerts/main.tf`), the dashboard runbook map
(`packages/domain/dashboard/runbooks.ts` and `docs/greenfield/runbooks/canary_stale.md`),
the smoke script and the release runbook's `get-metric-statistics` command, and the
diagnostics field the desktop renders. Renaming would also break the CloudWatch history
of a metric whose history is about to be the evidence that the first week of production
was healthy. What was wrong was the arithmetic, not the label.

```sql
WITH newest_per_workspace AS (
  SELECT DISTINCT ON (workspace_id) inserted_at, completed_at
    FROM canary_runs
   ORDER BY workspace_id, inserted_at DESC
)
SELECT max(extract(epoch FROM coalesce(completed_at, now()) - inserted_at)) AS age_seconds
  FROM newest_per_workspace
```

* **Completed:** `completed_at - inserted_at`, the latency of the run. A run completed
  twenty minutes ago three seconds after it was inserted reads 3, not 1200.
* **Not completed:** `now() - inserted_at`, which grows. A worker that stops now leaves
  the newest run uncompleted, and the value passes 300 five minutes later — exactly the
  alarm and exactly the smoke check.
* **No row at all:** null, unchanged. There is no datapoint, and the alarm's
  `treat_missing_data = "breaching"` is what says so. That is g39's finding and it is
  deliberately not touched.

Neither the threshold, the name, the period, the evaluation periods nor the smoke's
constant had to move. Five minutes of latency is what 13.3 asked for all along.

**The worst of the newest runs, not the newest run.** The canary is per workspace, so
`ORDER BY inserted_at DESC LIMIT 1` across the table would let one workspace whose
canary completes normally hide another whose canary never completes at all — and the
second workspace's canary never completing is precisely what this metric exists to
notice. `DISTINCT ON (workspace_id)` takes each workspace's newest run and `max` takes
the worst latency among them. The system has one workspace today; the schema has always
had several, the alarm is a `Maximum` statistic, and a metric that is right for one
workspace and silently wrong for two is a trap set for whoever adds the second.

## What this does not change

**The insert and the completion.** `insertCanaryRun` is still idempotent on
`(workspace_id, quarter_hour)` and `completeCanaryRun` still writes `completed_at` once,
under `completed_at IS NULL`. A replayed canary job still finds the completion already
written and leaves it alone — which matters more now, not less, because the timestamp it
would move is one half of the latency.

**The alarm, the runbook and the escalation.** "A stale canary with both heartbeats
fresh" is still the interesting case and still means the queue is not being drained. The
runbook's advice is unchanged; what it now says is that the alarm means *a run that was
inserted has sat uncompleted for longer than the threshold*, rather than that fifteen
minutes have gone by since the last one, which is normal.

**No migration.** `canary_runs.inserted_at` has existed since migration 0002 with
`DEFAULT now()`, so this is a read that was always available. Migrations are checksummed
and 0002 is applied in production, so its comment above `canary_runs_completed` — "reads
the newest completion" — is now stale and stays stale rather than being edited under a
recorded checksum. The partial index it describes no longer serves this query; nothing
replaces it, because the table holds one row per workspace per quarter hour and a
sequential scan of it is not worth a schema version. A later migration that has another
reason to exist can add `(workspace_id, inserted_at DESC)` and drop the old comment.

## How it is proved

Four cases against a real PostgreSQL in `packages/domain/test/jobs/observability.test.ts`:

1. a run **completed twenty minutes ago with a three-second latency** reads `3` — the
   case the old query could not pass, and the one a "complete it and assert it is small"
   test would pass under either meaning;
2. a run **inserted 400 seconds ago and not completed** reads at least 400 — the failure
   the alarm exists for;
3. **two workspaces**, one healthy newer run and one older stale uncompleted run: the
   stale one wins, which a single newest row would have hidden;
4. **no rows** reads null.

`test/release/canaryAge.check.ts` maps that behaviour to the things that depend on it:
the query contains the latency expression and not the reverted one, it takes the worst
of the workspaces, the smoke's constant and the Terraform default and the alarm's period
are the same five minutes, and the Terraform description an operator reads at plan time
says what the number means. `scripts/releaseMutationCheck.mjs` reverts the query to
`now() - max(completed_at)` and the release suite must go red.
