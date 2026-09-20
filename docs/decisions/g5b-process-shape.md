# G5b: liveness, readiness, and the three things this lane duplicated

**Date:** 20 September 2026 · **Lane:** G5b process bootstrap · **Spec:** 4.1, 4.2,
13.3, Appendix E

Four decisions the specification left open, in one place because each is small.

## 1. `/healthz` and `/readyz` are separate, and `/health` stays

`infra/modules/edge/variables.tf` defaults `health_check_path` to `/healthz` and
`infra/modules/cluster/variables.tf` calls the same path on the loopback address. G0's
API served `/health` and nothing else, so until this lane the load balancer would have
taken every task out of rotation.

* **`/healthz`** touches no database and answers 200 while the process is running. A
  liveness check that queries the database restarts every task in the fleet the moment
  the database hiccups, which is the opposite of what a liveness check is for.
* **`/readyz`** answers 503 when the database cannot answer, when the applied schema
  version is outside the range this binary accepts, or when `system_generation` is not
  the operator-pinned one. 503 rather than 500: the task is alive and deliberately not
  serving.
* **`/health`** is unchanged. It is the fuller report an operator reads, and it answers
  200 even when degraded, which is exactly why it must not be the load balancer's.

Where the spec is silent the conservative option wins, and readiness fails closed.

## 2. The worker's liveness file is a statement, not a timestamp

The worker has no HTTP surface, and the task definition's health check is
`statSync('/tmp/fss-worker-heartbeat')`. Existence alone would be a check that can
never fail: `statSync` succeeds on a file written once at boot and never touched again.

So the file is written when the schema check passes, rewritten while every loop is
succeeding, and removed after any loop has failed `FSS_LIVENESS_FAILURES` (default
three) times in a row. A worker whose database has gone loses its file, fails its health
check and is replaced. A worker that is merely idle keeps it, because an empty queue is
not a fault.

Per loop, not overall: a worker whose runner is failing and whose scheduler is fine is
not healthy, and a single shared counter that any success resets would say it is.

## 3. The worker exits on a bad schema; the API does not

`apps/worker` exits 10 on a database outside its declared range, because 4.2 says a
worker that cannot prove the schema must not write rows another binary cannot read.

The API does the opposite deliberately. It starts, serves `/healthz`, fails `/readyz`,
and stays up. An API that exits is a crash loop whose logs are gone by the time anyone
looks, and the load balancer has already stopped sending it traffic. The refusal is at
the door, not at the process.

Neither process refuses a *restored* database. Appendix E puts that on the restore
holds, which block sending and dialing; the worker logs
`restore_generation_mismatch` — the event the metric filter counts — and the API fails
readiness while the operator has pinned a generation that does not match.

## 4. What is duplicated, and when it should stop being

Three things exist twice, once per app, because `apps/api` may not import `apps/worker`
and `packages/domain` is not this lane's to extend:

* `bootstrap/log.ts` — identical apart from the component name. Both processes must
  produce the same line shape, because the same metric filter patterns read both log
  groups.
* `bootstrap/config.ts` — the same rules (read once, refuse rather than guess, name the
  variable and never its value, reject an ARN where the secret's value should be) over
  different variables.
* the small interval loop, which the worker has as `loop.ts` and the API has inline in
  `heartbeat.ts`.

That is about 150 lines. The alternative today is a fourth package that two other lanes
would have to merge into, for three files. When the first shared platform package
exists — or when a third process appears — these move there and the duplicate goes.
Until then the duplication is deliberate and written down, which is the difference
between duplication and drift.
