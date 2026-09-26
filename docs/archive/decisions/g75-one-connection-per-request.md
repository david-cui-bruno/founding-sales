# g75: one database connection per API request

Lane g75, 25 September 2026. Fixes audit item C01 (P0, `.context/reviews/GPT6-ASTRA-EXHAUSTIVE-20260925.md`):
the API served every request on one shared `pg.Client`.

## What was wrong

`apps/api/src/bootstrap/main.ts` opened one `requestClient` and handed it, as a
`SessionQueryable`, to everything: `createApiServer`'s `session` and `AuthDeps.db`.
`SessionQueryable` is the promise "one backend connection for its whole lifetime", and
`withTransaction` relies on it — `BEGIN`, the work and `COMMIT` are separate statements
on whatever session it is given.

node-postgres queues *statements* on a client. It does not queue *transactions*. So as
soon as two requests were in flight, the second one's statements ran inside the first
one's transaction whenever the first was awaiting something between statements — the
suppression journal's S3 write inside every suppression command, a Gmail or KMS call,
or simply the event loop. Concretely, with request A inside its transaction and
request B arriving:

- B's `BEGIN` is a no-op warning ("there is already a transaction in progress"); B's
  writes join A's transaction; B's `COMMIT` commits A's half-done work, and A's later
  `ROLLBACK` finds nothing to roll back. **A rolled-back write persists.**
- Or B fails: B's `ROLLBACK` ends A's transaction and discards A's writes; A's
  `COMMIT` finds no transaction and A answers 200. **A committed write is lost.**
- A's `SELECT … FOR UPDATE` or advisory lock is already "held" by B, because they are
  the same session. **Mutual exclusion between requests is gone.**

The desktop's Home fires several requests in parallel at launch, so this was live, not
theoretical. `apps/api/test/connectionPerRequest.test.ts` reproduces the first two on
the old shape deterministically, as its control; the third is what its real-command
test proves on the pool, and what goes red when a mutation restores the shared
connection.

## The fix

A `pg.Pool` (`createRequestPool`, `apps/api/src/bootstrap/connections.ts`) and one
connection per request:

- `handle` in `apps/api/src/server.ts` opens a `requestConnection` for each request.
  It checks nothing out until the request's first statement; from then on every
  statement — the principal, a renewal, the command receipt, the route, the receipt's
  commit — runs on that backend. `handle`'s `finally` gives it back, on an error too.
- `createApiServer` takes `ApiServerOptions`: `connections`, and `auth` without its
  `db`. There is no way to hand the server a shared session. Each request runs under
  `optionsForRequest` — the server's options on that request's connection — so the
  route modules, which are closures over their options, close over that request's
  connection. That means a route registry per request, about 40 µs.
- `dispatch` and `route` keep taking one `session`: the route tests call them one at a
  time with a session of their own, which is what the type promises.
- The heartbeat keeps its own `pg.Client` outside the pool, for the reason its comment
  gives: a heartbeat that waited for a free connection would report the queue.

### Why lazy

`/healthz` is the load balancer's and the container's liveness check and must not touch
the database (`docs/greenfield/processes.md`). A request that checked out eagerly
would make liveness depend on the pool, and a saturated pool would get healthy tasks
replaced. Lazy checkout also means a refused envelope or a slow upload never holds a
backend. The checkout is memoized, so two statements a route starts together share one
backend rather than splitting the request across two.

### Why not per transaction, or AsyncLocalStorage

Per-transaction checkout would leave the statements between transactions — the receipt
read before `runCommand`'s transaction, the principal — on some other connection, and
the whole point is that a request sees one consistent backend. AsyncLocalStorage would
have kept every signature and hidden the connection in the async context; explicit
per-request options are more code but nothing is ambient, and a closure over the
server-wide options can no longer reach a shared session because there is none.

## The size: 8 per task

**Supply.** Production is one `db.t4g.small` (2 GiB), Multi-AZ, with the default
parameter group value for `max_connections`, `LEAST({DBInstanceClassMemory/9531392}, 5000)`.
2 GiB ÷ 9,531,392 bytes is 225 before RDS subtracts its own memory, so roughly 190–225.
RDS keeps 3 (`superuser_reserved_connections`) plus 2
(`rds.rds_superuser_reserved_connections`) back. Rehearsal defaults to the same class.

**Demand at the worst moment**, a rolling API deployment:

| Holder | Count | Connections |
|---|---|---|
| API tasks | 2 declared, up to 4 during a deployment (`deployment_maximum_percent = 200`) | 4 × (8 pool + 1 heartbeat) = 36 |
| Worker | 1 task, replaced rather than overlapped (`deployment_maximum_percent = 100`) | `FSS_WORKER_CONCURRENCY` (1) + scheduler + metrics = 3 |
| One-off tasks | `migrate`, `database-users ensure`, `verify`, `admin counts`, `drill` — the release script runs them one at a time | ≤ 5 |
| Reserved by RDS | | 5 |
| **Total** | | **≈ 49** |

That is a quarter of the instance's connections, so the budget leaves room for the
worker's concurrency to be raised (each slot is one more) and for an operator's `psql`.

**Why not more.** One salesperson. Home's parallel burst at launch is a handful of
requests, split across two tasks by the load balancer; a request holds its connection
for milliseconds, or for the length of an external call in the few commands listed
below. Eight gives that burst headroom several times over. A bigger pool buys nothing
on a 2-vCPU burstable database — concurrent queries beyond a small multiple of its
cores queue inside PostgreSQL instead of in the pool, where they cannot be refused
cleanly — and it widens the blast radius of a leak or a hang.

**Checkout timeout: 5 s.** Orders of magnitude above a normal request's hold, well
under the load balancer's 60 s idle timeout. Past it the request is refused 503
`database_busy` with a `refusal` log line carrying that reason, and nothing ran — the
checkout is the request's first statement. A checkout after `pool.end()` (a stopping
task) and PostgreSQL's own `too_many_connections` (53300) are answered the same way.
Anything else that stops a connection opening is the database being unreachable and
behaves as it did: `/readyz` reports `database_unreachable`, other routes
`internal_error`.

**Idle timeout: 60 s**, so a quiet task holds almost nothing and a burst after a pause
pays one TLS handshake per connection it needs.

## Failure modes

- **Busy.** 503 `database_busy`, never a hang. `/readyz` reports `database_busy`
  truthfully — the database was never asked — and `/healthz` keeps answering.
- **A connection comes back inside a transaction** (a route that opened one and
  returned without closing it): destroyed, which PostgreSQL rolls back, rather than
  lent to the next request with somebody else's transaction open.
  `api_connection_discarded` at `warn`.
- **An idle connection's backend dies** (failover, `pg_terminate_backend`): the pool
  emits `error`. With no listener that would have been an uncaught exception; it is an
  `api_pool_client_error` line at `warn`, the pool drops the client, the next request
  connects afresh.
- **A straggling statement after the request finished** is refused by the session
  rather than run on a backend another request now owns.
- **The heartbeat's own client** still has no `error` listener, exactly as before: if
  its backend dies the process ends and ECS replaces the task. Unchanged here.
- **Startup** checks connectivity once — a pooled client, `SELECT 1`, released — and
  fails as `requestClient.connect()` did when the database cannot be reached at all.
- **Stopping** (`apps/api/src/bootstrap/shutdown.ts`): stop accepting, close each
  keep-alive socket as soon as its request finishes, wait for the requests in flight,
  stop the heartbeat, `pool.end()` — which waits for every checked-out connection —
  and end the heartbeat's connection, all inside `FSS_API_SHUTDOWN_TIMEOUT_MS`.
  `api_drained` reports whether it all came back. Exit codes are unchanged. Before
  this lane `server.close()` alone waited out Node's keep-alive timeout after the last
  response, five seconds a stop.

## Transactions held across external calls

A connection per request makes these safe, not fast: each holds its connection, and a
transaction, for the length of the call. They are noted, not restructured.

- Every suppression command, and each retention deletion that records a suppression,
  awaits the suppression journal's S3 `PutObject` inside the command transaction, by
  design (10.2: the journal is durable before the row;
  `packages/domain/suppression/events.ts`, `packages/domain/retention/deletion.ts`).
- `POST /gmail/disconnect` decrypts the refresh token (KMS) and calls Google's token
  refresh, `stopWatch` and revoke inside `runCommand`'s transaction
  (`disconnectMailbox`, `packages/domain/mail/oauth.ts`).
- `GET /oauth/gmail/callback` is not in a transaction, but holds its connection across
  the Google code exchange, the profile read and the KMS encrypt.

## The worker

Checked, not changed. `apps/worker/src/bootstrap/main.ts` opens
`FSS_WORKER_CONCURRENCY + 2` clients: one for the scheduler loop, one per runner slot,
one for the metric loop, and `startWorker` refuses to start unless it was given exactly
one runner connection per slot. Each loop runs on its own connection and never overlaps
itself (`bootstrap/loop.ts`), so no two concurrent units of work share a session. The
worker does not have this defect.

## Proof

`apps/api/test/connectionPerRequest.test.ts`, on embedded PostgreSQL through the real
server, pool and `withTransaction`: both interleavings keep the right rows on the pool
and lose them on one shared connection (the control); a real suppression command waits
for another request's `FOR UPDATE` lock; a throwing request returns its connection to
the pool's baseline; a connection left inside a transaction is discarded; a held pool
refuses in 503 `database_busy` inside the timeout while `/healthz` answers; an idle
connection's death is logged and survived; `/readyz` works on the pool and reports an
unreachable database; the drain waits for a request in flight and stops at its deadline.
Two mutations in `scripts/releaseMutationCheck.mjs` put the shared connection back and
remove the `finally` release; the file goes red for each.
