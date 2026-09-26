# g86: readiness gates every request, from a verdict cached for five seconds

Lane g86, 25 September 2026. The other half of audit item S14 (P0) of
`GPT6-ASTRA-EXHAUSTIVE-20260925.md`, "the load balancer ignores API readiness". Lane g81
pointed the target group at `/readyz`. This lane makes the task itself refuse.

## The gap

`/readyz` fails when the database cannot answer, when its schema is outside the range
the binary declares, or when its system generation is not the pinned one (Appendix E
step 1). Since g81 the load balancer reads it, and a failing task leaves rotation after
consecutive failed checks: tens of seconds. Until then, and for any request that reached
the task another way, `server.ts` authenticated and ran the route regardless. On a
restored copy that is the window in which a task serves recovered data before it knows it
is recovered data.

## Decision

1. **In the handler, before authentication.** `handle` in `apps/api/src/server.ts` asks
   `ReadinessGate.admit(path, connection.session)` after the envelope and the body and
   before `dispatch`. A task that is not ready answers **503 `not_ready`**, a code added to
   `REFUSAL_CODES` in `limits.ts` beside `database_busy`, and logs a `refusal` line with
   `reason` and `code` `not_ready` and `not_ready_reason` naming which check failed. It
   runs nothing further: no principal lookup, no route, no receipt.
2. **Exempt, by exact path:** `/healthz` (liveness answers from the process alone),
   `/readyz` (it is the check), `/health` (the operator's degraded-but-answering report)
   and `/auth/client-version` (what an outdated Mac may always read, 5.3). None mutates.
3. **Cached, not asked per request.** The verdict is `buildReadinessReport`, the same
   report `/readyz` answers with, kept for `READINESS_GATE_TTL_MILLISECONDS` (5 s) per
   process. The request that finds it stale runs the check on its own connection, which
   it would have checked out for the route anyway. Requests arriving while it runs wait
   for that one check. Inside the window a request costs a clock read. A clock that went
   backwards expires the verdict rather than extending it.
4. **A busy pool is not a verdict.** A check that could not get a connection inside the
   checkout timeout says nothing about schema or generation, so nothing is cached and the
   request is answered exactly as any timed-out checkout, 503 `database_busy`, through
   the handler's existing path. A cached `database_unreachable` or mismatch is kept for
   the window like a pass.
5. **One line per change.** `api_readiness_changed` at `warn` when the verdict turns bad
   and at `info` when it recovers, with the reason, not one per window.

## Why not in `dispatch`

`dispatch` and `route` are the pure entry points every route test calls with a session of
its own. A gate there would put a readiness round trip into every route test call, or
need a cache keyed on an options object the tests rebuild. Production requests all enter
through `handle`, so that is where the gate is, and `createApiServer` builds one gate per
process. The tests that start a real server (`apps/api/test/readinessGate.test.ts`) prove
it against a database whose generation is not the pinned one and one behind the binary.

## What it costs, and what it does not buy

At most one readiness check (four short statements) per five seconds per task, on a
connection a request was going to use anyway. A task that has just turned unfit serves for
up to one window, and one that has recovered refuses for up to one. Both are well inside
the load balancer's own delay, which still applies. The gate does not replace the
worker's restore holds: it stops the API serving, and the holds stop sending and dialing.
