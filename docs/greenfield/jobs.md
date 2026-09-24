# Jobs, the scheduler, and the things that watch them

Specification revision 3, section 13 and Appendices A, C and G. This is how background
work is materialized, claimed, retried and buried, and how an operator finds out when
any of that stops.

## The shape

```
packages/domain/jobs/     shared by both services
  jobKinds.ts             Appendix C: the kinds, their keys, their protections
  jobStore.ts             enqueue, claim, complete, fail, reclaim, archive, requeue
  backoff.ts              the retry ladder, pure
  handlerRegistry.ts      a handler declares its idempotency protection or is refused
  atLeastOnce.ts          the stolen-lease harness every later lane runs
  counters.ts             daily counters, increment-with-ceiling
  heartbeats.ts           api / scheduler / worker / mailbox
  canary.ts               one run per quarter hour, completed once
  criticalAlerts.ts       raise, acknowledge, resolve, and the age the alarm reads
  metrics.ts              the metric names, and the adapter that is a no-op locally

apps/worker/src/scheduler/  the one-minute pass and its due-work sources
apps/worker/src/runner/     the claim loop and the per-protection execution
apps/api/src/routes/admin/  the dead-job list, the requeue, the acknowledgement
```

## The queue

`jobs` (migration 0001, extended by 0002) is the queue. `UNIQUE(workspace_id, kind,
idempotency_key)` is what stops duplicate materialization, and it is per workspace, so
two workspaces may hold the same key.

**Claiming** is one statement: a CTE that selects runnable rows `FOR UPDATE SKIP
LOCKED` over the runnable partial index, and an `UPDATE` that takes the lease in the
same statement. There is no window in which a row is selected but not claimed, and no
transaction the caller has to remember to open. Two workers running it at the same
instant take different rows rather than waiting.

Runnable means `state IN ('queued','retryable')`, `run_at <= now()`, `not_before <=
now()` and `attempt_count < max_attempts`. Every one of those comparisons is made by
PostgreSQL. No worker's clock enters the decision.

**The lease is a hint. The fencing token is the fact.** `lease_expires_at` says a row
is probably being worked on. It proves nothing: a paused worker still believes it holds
its lease. `fencing_token` increments on every claim and never resets — not on a retry,
not on an admin requeue — and every write a worker makes to its own job row carries the
token it was handed. A worker that wakes after its lease was reclaimed affects zero
rows and is told `lease_lost`.

`attempt_count` cannot serve as the token, because a requeue resets it and a reset
fence is not a fence.

**Expired leases** are returned to the runnable set through the second partial index,
by `reclaimExpiredLeases`. The reclaim does not touch the token; the next claim
increments it, which is precisely what makes the old owner's token stale.

**Retries** use bounded exponential backoff: 30 s, 60 s, 120 s, 240 s, capped at
fifteen minutes, with optional jitter. The default attempt budget is four, so the
fourth failure is dead.

**Dead jobs** are visible to admins at `GET /admin/jobs/dead` and revived only by
`POST /admin/jobs/requeue`, which is admin-only and writes its audit event in the same
transaction as the state transition. The idempotency key is unchanged by a requeue, so
a requeue can never materialize a second copy of work that already exists.

**Archival** redacts the payload of a completed job after the operational window and
leaves the row, so the dedupe key survives its horizon. A dead job is never archived: a
requeue has to have something to run. See `docs/decisions/g5-payload-archival.md`.

## At least once, and what saves you

Specification 13.2: "Every handler is protected by business uniqueness, a monotonic
fencing token, or the outbound at-most-once fence." A handler declares which, the
registry refuses a declaration that disagrees with Appendix C, and the runner behaves
differently for each:

| Protection | How the runner enforces it |
|---|---|
| `fencing_token` | The handler runs in a transaction that first locks its own job row by `(id, fencing_token, lease_owner)`. A stolen lease finds no row and the handler never runs. |
| `business_uniqueness` | The handler runs in a transaction and the completion commits with it. A stolen lease rolls the handler's work back with the failed completion. |
| `outbound_fence` | The handler runs *outside* the completion transaction, because `prepared → dispatching` and the Gmail call after it cannot be rolled back (Appendix B). The fence is the guarantee; the completion is only bookkeeping. |

`runTwiceUnderStolenLease` in `atLeastOnce.ts` performs the theft for real — expires
the lease, reclaims, lets a second worker finish, then lets the first wake up and try —
and asserts one business effect. A lane that registers a new handler adds a probe and
runs it. That is Appendix G scenario 2, and it is not optional.

## The scheduler

One bounded pass per minute, on a dedicated connection:

1. Check the worker schema range. A scheduler that does not understand the database
   does not materialize work into it.
2. `BEGIN`, `SET LOCAL statement_timeout`, `SET LOCAL idle_in_transaction_session_timeout`.
   Both are `LOCAL`, so a pass cannot leave a short timeout on a pooled connection.
3. `pg_try_advisory_xact_lock(SCHEDULER_ADVISORY_LOCK_KEY)`. `try`, not the blocking
   form: a pass that cannot get the lock returns and lets the next minute try, rather
   than building a queue of passes that all want to insert the same work.
4. Ask each `DueWorkSource` for the work it sees, and enqueue it. Indexed queries only.
5. Record the scheduler heartbeat. `COMMIT`, which is also what releases the lock —
   including for a task that dies, which a session-scoped lock would not give you.

The pass performs no external action; its report says `externalActions: 0` and a test
asserts it. Everything that talks to the world is a job someone claims.

The lock key is a stable literal, not a hash of a version or a deployment, because
"overlapping deployments serialize on the same key" requires two different releases to
collide on it. It is deliberately not the migration runner's key.

A lane adds its source to `workerDueWorkSources()` in `apps/worker/src/bootstrap/main.ts`
and composes its key with `jobIdempotencyKey`; it does not touch the pass. The registered
list and the table in `docs/greenfield/processes.md` are compared by
`apps/worker/test/sourceRegistry.test.ts`, in both directions, because three domain
functions once sat exported and uncalled for a week with every package's suite green
(`docs/decisions/g15-the-worker-drains-what-the-lanes-left.md`).

Most sources materialize unconditionally and let their handler no-op — `retention.batch`
writes a "retained, deleted nothing" ledger row eleven times a workspace a day on
purpose. `terminal-stop` is the exception: it asks what is outstanding first and inserts
nothing for a workspace that owes nothing, because a job a minute per workspace would be
a queue of no-ops and an "oldest runnable job" figure that meant nothing. Its key is the
head of each stream it drains, so an exhausted job keeps its key and waits for the
audited requeue rather than filling the dead-job list with one row a minute.

## Counters, heartbeats, the canary

**Daily counters** are keyed by workspace, subject (owner, mailbox, domain or the
workspace itself), counter kind, and an explicit business date in the workspace's zone
— stored beside the zone that produced it, so changing the zone later cannot re-date
history. `incrementDailyCounter` raises and checks the ceiling in one statement,
because read-then-write is how the fifty-first message of a fifty-message day gets sent.

**Heartbeats** are an upsert per `(component, instance_key, workspace_id)` carrying
`expected_interval_seconds`, so the emitter and the alarm's "three missed checks" agree
through a configuration change. Mailbox is the only workspace-scoped component.

**The canary** is one `canary_runs` row per workspace per quarter hour, inserted by the
scheduler and completed by the worker. Neither heartbeat can prove scheduler-to-worker
liveness on its own: a scheduler inserting jobs nobody claims is alive, a worker with
an empty queue is alive, and the system between them is dead.

`CanaryCompletionAgeSeconds` is that pair read as a **latency**: for the newest run of
each workspace, `completed_at - inserted_at` once the worker has written it and
`now() - inserted_at` while it has not, and the worst of those, so one workspace whose
canary completes normally cannot hide another whose canary never completes. It is
deliberately *not* the time since the last completion — the canary is inserted once
every fifteen minutes, so that reading sawtooths to 900 on a perfectly healthy system
and sits above the five-minute threshold 13.3 names for about ten minutes in every
fifteen (`docs/decisions/g41-the-canary-age-is-the-newest-runs-latency.md`).

## Metrics and the repeating critical alert

`METRIC_OWNERS` in `metrics.ts` claims one of three things about every metric the
infrastructure alarms on: this lane emits it, a CloudWatch log filter derives it, or a
later lane owns it. A test reads `infra/modules/alerts/main.tf` and
`infra/modules/observability/main.tf` and fails when a name there has no owner, or an
owner names a metric no alarm reads. An alarm over a metric nobody emits never fires,
which is worse than no alarm.

The adapter takes a `putMetricData` function rather than importing an AWS SDK. Locally
none is supplied, so publishing validates the data and does nothing — a wrong unit or
an unknown name fails on a laptop rather than in production.

`UnacknowledgedCriticalAlertAgeSeconds` is the one G1 asked for
(`docs/decisions/g1-alert-repetition.md`). While a critical condition is open and
unacknowledged, the worker publishes its age; when none is, it publishes nothing and
the alarm's `notBreaching` treatment of missing data says so. An admin acknowledging
through `POST /admin/alerts/acknowledge` stops the publication immediately, and the
acknowledgement is audited, because "who silenced it" is the first question afterwards.

## Adding a handler

1. Pick the kind from `JOB_KINDS`, or add it to Appendix C's table in `jobKinds.ts`
   together with its key builder and its protection.
2. Write the handler, declare the protection Appendix C gives that kind, and register
   it. A mismatch is refused at registration.
3. Add a probe to the stolen-lease harness and prove one business effect.
4. If the scheduler materializes it, add a `DueWorkSource`.
5. `npm run gate:greenfield`.
