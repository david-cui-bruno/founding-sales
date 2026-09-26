# G5: the job queue crosses workspaces, and where the scope goes instead

**Date:** 20 September 2026 · **Lane:** G5 jobs and scheduler · **Spec:** 6, 13.1, 13.2

## The tension

Section 6 and `docs/archive/decisions/g0-database-conventions.md` are unambiguous: "Every
repository operation uses a typed workspace scope; no method accepts a bare object ID."
`WorkspaceScope` is branded so that a repository function cannot be written without one.

But there is one worker and there are many workspaces, and the whole point of a claim
is to take the oldest runnable job *wherever it is*. A claim that required a scope
would require the worker to poll every workspace in turn, which is both slower and
wrong: the fairest order is by `run_at`, across everything.

The same is true of the scheduler's advisory lock, of `reclaimExpiredLeases`, and of
the archival sweep.

## Decision

The job queue's **operational** functions take a `SessionQueryable` and no scope:
`enqueueJob`, `claimJobs`, `completeJob`, `failJob`, `renewLease`,
`reclaimExpiredLeases`, `archiveCompletedPayloads`, `recordHeartbeat`,
`raiseCriticalAlert`, `resolveCriticalAlert`, and the metric collectors.

Every one of them either names `workspace_id` explicitly from a row it already holds,
or operates on the queue as infrastructure rather than as business data.

The job queue's **business-facing** functions take a `RepositoryContext` like every
other repository function, and get the workspace from the scope: `listDeadJobs`,
`requeueDeadJob`, `listOpenAlerts`, `acknowledgeCriticalAlert`,
`incrementDailyCounter`, `readDailyCounter`.

And the seam between the two is `scopeForJob(claim)`: the runner builds a
`WorkspaceScope` from the claimed row's own `workspace_id` and hands it to the handler,
so everything a handler then touches is scoped by construction. A handler never sees a
workspace id as a string it could mistype; it sees a scope it cannot forge.

## Why this is safe

The property section 6 is protecting is "a bare id cannot reach a row in another
workspace". The operational functions do not take ids at all — they take a claim
object the database itself produced, whose `workspace_id` came from the row. There is
no argument a caller could get wrong.

`requeueDeadJob` is the clearest case of the other half: its `jobId` is a bare id from
an HTTP body, so it goes through the scope, and `WHERE workspace_id = $1 AND id = $2`
is what makes another workspace's admin get `not_dead` rather than a requeue. There is
a test for exactly that.

## What would change this

Row-level security, which specification 6 makes "a mandatory release gate before any
second external workspace is created". Under RLS the worker's connection would need a
role that can see every workspace's jobs and a `SET LOCAL` per handler invocation. That
is a change to this file's first half and not to its second, which is the reason the
split is drawn here rather than somewhere more convenient.
