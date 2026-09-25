# The load balancer asks readiness

**Lane:** g81 · **Date:** 25 September 2026 · **Spec:** 4.2, Appendix E step 1 · **Evidence:** audit `GPT6-ASTRA-EXHAUSTIVE-20260925`, item S14

## The gap

The API target group polled `/healthz`. That path answers 200 whenever the process is
running. Four checks say a task must not serve, and they only ever failed `/readyz`:
- the applied schema is outside the range the binary declares;
- the system generation is not the pinned one;
- the database cannot answer;
- the pool has no connection free (`database_busy`, since PR 215).

A task started against the wrong schema by a rolling deploy was in service as soon as it
listened.

## Decision

`infra/modules/edge` now defaults `health_check_path` to `/readyz`.
- The matcher stays `200`, so the 503 readiness answers is unhealthy.
- The container health check in `infra/modules/cluster` stays on `/healthz`. The process
  is restarted only when it is really dead, not when the database has a bad minute.

**`database_busy` takes a task out of service. Yes, as the brief recommended.**
- A task whose pool has had no free connection for three checks (45 s) is not serving
  its requests either.
- With two API tasks the load balancer sends traffic to the other one.
- ECS replaces a task that fails load-balancer checks, and the replacement gets a fresh
  pool.

**Timing.** A rolling deploy still completes.
- A new task is healthy after two passes 15 s apart, about 30 s after it is ready, well
  inside the service's 60 s grace.
- An old task drains for 30 s.
- A timed-out probe (5 s) counts as a failure.
- `test/release/loadBalancerReadiness.check.ts` and `tests/https_only.tftest.hcl` read
  these numbers.

## What the operator will see

- **Database unreachable.** Every API task fails readiness. The ALB fails open when every
  target is unhealthy, so requests still reach the tasks. ECS replaces the tasks every
  couple of minutes until the database answers. That is noise, not an outage the old
  check would have avoided: those tasks could not serve anyway.
- **A restore with the pin ahead (Appendix E).** The API is deliberately out of service,
  and ECS cycles its tasks until step 9 reconciles the generation. Step 9 runs from the
  operations task (`fss admin system-generation advance`), which uses no load balancer.
  The rehearsal drill never points the API service at the restored instance, so the
  rehearsal does not see this.
- **A schema release.** No change. The services are stopped before the apply (g70) and
  started after the migration, when the range is satisfied.

## Not done here

The audit also says ordinary request dispatch does not enforce readiness. That lives in
`apps/api/src/bootstrap/dispatch.ts` and `server.ts`, which are outside this lane.
`apps/api/src/bootstrap/readiness.ts` and `docs/greenfield/processes.md` still say the
target group polls `/healthz`. The brief keeps that file as it is, so those lines need a
follow-up.
