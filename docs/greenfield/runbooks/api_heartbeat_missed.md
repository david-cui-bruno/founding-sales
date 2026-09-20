# api_heartbeat_missed

**Metric:** `ApiHeartbeat` · **Severity:** critical · **Spec:** 13.3, 4.2

## Symptoms

Three consecutive one-minute windows with no API heartbeat. The Mac client shows its
expiring stale Today view and every mutation fails closed (4.2). Sign-in fails.

## First checks

1. `GET /healthz` and `GET /readyz` through the load balancer. `/readyz` fails closed
   and is what the target group reads; `/health` answers 200 even when degraded.
2. ECS service events for the API service: task count, recent stopped tasks, stop
   reasons.
3. `GET /diagnostics` if any API task is answering — schema version and restore
   generation are the two startup refusals that look like a crash loop.
4. ALB target health and the 5xx count.

## Diagnosis

The heartbeat is an upsert per `(component, instance_key)` written by the API itself,
so its absence means no API task is running, or every task is running and cannot reach
PostgreSQL. Distinguish them with the ECS task count:

- **No running tasks:** deployment failure, image pull failure, or the task role lost
  a permission. Read the stopped-task reason.
- **Tasks running, no heartbeat:** the database is unreachable or refusing the API's
  credentials, or the applied schema version is outside `API_SCHEMA_RANGE` and the
  process is refusing to serve rather than half serving (4.2, Appendix G 22).
- **Tasks flapping:** readiness is failing; the container is being killed by the
  target group before it writes a heartbeat.

## Safe recovery

- Redeploy the previous known-good image digest. Rollback is to an earlier compatible
  binary on the same database; there is no down migration (4.2).
- If the schema range is the cause, deploy the binary that accepts the applied
  version. Never widen a range as a hotfix to make a process start against a database
  it does not understand.
- If PostgreSQL is the cause, work the database first; the API has nothing to do until
  it is back.

## Escalation

Page the on-call engineer immediately: with no API there is no sign-in, no dial
authorization and no reply handling. If RDS is failed over or unavailable, escalate to
AWS support with the DB instance identifier.

## What must stay held

- Do not enable production sending as part of the recovery. Sending stays disabled
  until the gate of 16.2 is satisfied again.
- Do not bypass `/readyz` by pointing the target group at `/health`. `/health`
  answering 200 while degraded is deliberate and is not a liveness signal.
- Acknowledging the alert does not restore service and must not substitute for it.
