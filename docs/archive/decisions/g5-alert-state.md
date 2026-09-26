# G5: where a critical alert lives, and why the API route is not mounted yet

**Date:** 20 September 2026 · **Lane:** G5 jobs and scheduler · **Spec:** 13.3 · **Follows:** `g1-alert-repetition.md`

## The table G1 implied but did not name

G1 decided that "repeated while critical and unacknowledged" is delivered by the
application: the worker publishes `UnacknowledgedCriticalAlertAgeSeconds` while a
critical condition is open and unacknowledged, and "acknowledgement itself is an FSS
admin command, not an AWS one, because *who acknowledged which alert* is business state
that belongs in the audit trail with the rest."

No table existed for that state. Migration 0002 adds `critical_alerts`, and three of
its properties are decisions rather than transcription:

**Workspace-scoped.** Some critical conditions are database-level — a restore
generation mismatch is not any workspace's. They are still recorded per workspace,
because the acknowledgement is an audited admin command and `audit_events` requires a
workspace. With one workspace this is free; with several, a database-level condition is
raised once per workspace, which is the right notification behaviour anyway.

**One open row per key.** A partial unique index on `(workspace_id, alert_key) WHERE
resolved_at IS NULL`. A recurring condition updates `last_observed_at` and leaves
`raised_at` alone, so the age the metric publishes is the age of the *condition* rather
than of the latest observation of it. Without this the metric would reset every period
and the alarm would never breach.

**Acknowledging is not resolving.** Acknowledging says a human has seen it and stops
the repetition; resolving says the condition is over and frees the key. A system that
conflated them would let an acknowledgement hide a condition that is still true.

## Why nothing raises an alert automatically yet

`raiseCriticalAlert` exists and is tested, but no code path calls it on a schedule. The
conditions in 13.3 are read by CloudWatch from the metrics this lane emits; the
`critical_alerts` table is for conditions the *application* knows about and wants to
repeat until acknowledged. Deciding which of the nine thresholds are application-raised
rather than alarm-raised needs the tables the later lanes build (Today snapshots, Gmail
watches, enrollments). The mechanism is here; the policy is theirs.

## Why `routeAdminJobs` is not wired into the router

`apps/api/src/server.ts` and `apps/api/src/index.ts` are outside this lane's ownership
list, and G2 is editing the API at the same time. `routeAdminJobs` is therefore a
complete, tested router function that returns `null` for a path it does not own, and
mounting it is one line in `route()`:

```ts
const admin = await routeAdminJobs({ method, path, principal, body, db });
if (admin !== null) return admin;
```

It needs a `VerifiedPrincipal`, which is G2's session and device verification. The
coordinator should land that line together with G2's authentication, and until it does,
the four admin paths are reachable from tests and from nothing else. This is the one
piece of G5 that is not end-to-end, and it is called out in the lane report rather than
left to be discovered.
