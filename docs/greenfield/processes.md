# The two processes

Specification revision 3, sections 4 and 13. This is what runs on Fargate: how the
worker and the API start, what they do every minute, how they stop, what the health
checks actually check, and how `apps/api/src/server.ts` wires the routes to the
database.

## The shape

```
apps/worker/src/index.ts            the startup check, and the module surface
apps/worker/src/bootstrap/
  config.ts       the environment contract with the task definition
  log.ts          the JSON line shape the CloudWatch metric filters parse
  loop.ts         one repeating pass that never overlaps itself and drains on stop
  liveness.ts     the file the ECS health check stats
  metricCoverage.ts   every alarm metric this process does not publish, and why
  worker.ts       the three loops, composed
  main.ts         the container entry point

apps/api/src/bootstrap/
  config.ts       the same contract, for the API task
  routeRegistry.ts  modules declare the paths they own; two claims is a refusal
  routes.ts       what this process mounts
  dispatch.ts     find the module, or return null and let the caller refuse
  readiness.ts    /healthz and /readyz, which are different questions
  requestBody.ts  bytes counted as they arrive, not as Content-Length claims
  connections.ts  the request pool: one connection per request, database_busy
  heartbeat.ts    the api heartbeat the worker turns into ApiHeartbeat
  shutdown.ts     SIGTERM: stop accepting, drain the requests, end the pool
  server.ts       the container's HTTP surface
  main.ts         the container entry point

packages/domain/jobs/metricsCloudWatch.ts   the one module that loads an AWS SDK
```

## The worker

One process, three loops, one connection each.

**The scheduler timer.** Every sixty seconds, `runSchedulerPass` on its own connection
(13.1). The interval is not `setInterval`: a pass that runs longer than its interval
would overlap itself and the two would fight over the same advisory lock. Each pass
waits for the previous one to finish and then waits the interval.

**The due-work sources.** `workerDueWorkSources()` in `apps/worker/src/bootstrap/main.ts`
is the list every pass reads, and `fss admin scheduler run-once` — Appendix E step 5's
"rematerialise from business state" — reads the same function rather than a list of its
own. A source only inserts rows, so running one from a command line is safe; a source
that talked to anything outside PostgreSQL would be a bug.

| Source | What it materializes |
|---|---|
| `canary` | One `canary_runs` row per workspace per quarter hour (13.3) |
| `today-build` | The morning list, once per workspace per business date (8.2) |
| `sequence-action` | Every due or clock-held step execution (11.2) |
| `terminal-stop` | The terminal stops the CRM outbox and the suppression marker owe (7.3, 8.1, 10.2) |
| `send-day-close` | Each open send day the workspace's own calendar has moved past (12.7) |
| `retention-batch` | Eleven sweeps per workspace per UTC day (10.3) |
| `mail-recovery`, `mail-sync-reconcile`, `mail-watch-renewal`, `outbound-reconcile` | 12.3's coverage and Appendix B's fence |
| `classify-reply` | One LLM classification per reply inside its window (12.4) |
| `route-validation` | One `route.validate` retry per unchecked email address per round: hourly for its first day, then daily (7.4, lane g90) |

That table is the contract, not a description: `apps/worker/test/sourceRegistry.test.ts`
reads it and fails when the registered list and the documented one differ in either
direction. Three functions were built, tested and left with no caller for a week
because nothing compared the two (the 21 September deviations sweep;
`docs/archive/decisions/g15-the-worker-drains-what-the-lanes-left.md`).

**The runner slots.** One per unit of configured concurrency, one connection each,
because two slots cannot share a connection — a transaction is not shareable.
Concurrency is one by default. A slot that claimed work asks for more immediately; a
slot that found none waits `FSS_RUNNER_IDLE_MS`.

**The metric publication.** Every sixty seconds, `collectJobMetrics` and one publish
through the sink. With `FSS_METRICS=off`, or with no region, the sink validates every
datum and sends nothing, so a wrong unit or an unknown metric name fails on a laptop.

**Startup** refuses a database outside the declared schema range and exits 10 (4.2,
`docs/archive/decisions/g5-schema-range.md`). It reads no system generation and opens no
hold: since lane W3-S8 a restore is a runbook run with both services stopped
(`docs/greenfield/runbooks/restore.md`), and nothing pins or compares a generation. The
`system_generations` table and the `restore_in_progress` hold code stay until a migration
drops them; no code writes either.

**Stopping** drains. `SIGTERM` sets every loop stopping and waits for the pass in
flight, so the job being run finishes inside the lease it already holds. The budget is
`FSS_DRAIN_TIMEOUT_MS`, default 100 s, deliberately shorter than the task definition's
`stopTimeout` of 120 s. A drain that does not finish is reported, not hidden.

## The API

`node:http`, one handler, the registry mounted. The order in `server.ts` is the order
in which a request can do damage:

1. the envelope — method, content type, declared length — before a byte is read;
2. the body, counted as it arrives, so a lying `Content-Length` is caught too;
3. the principal, which the identity lane's verification produces;
4. the route, which is mounted or the request is refused with a redacted `not_found`.

**Adding a route** is one line in `bootstrap/routes.ts`. A module declares the exact
paths it owns; two modules claiming one path is refused when the registry is built,
because the alternative is that one of them silently never runs and it might be the
one with the authorization in it.

**One connection per request** (lane g75). Requests are served from a `pg.Pool` of at
most `API_POOL_MAX_CONNECTIONS` (8) per task, built by `createRequestPool` in
`bootstrap/connections.ts`. `handle` opens a `requestConnection` for each request:
nothing is checked out until the request's first statement, and from then on every
statement — the principal, a renewal, the command receipt, the route, the receipt's
commit — runs on that one backend, which `handle`'s `finally` gives back, on an error
too. So `withTransaction`, `FOR UPDATE` and advisory locks mean what they say per
request. Until 25 September 2026 the API served every request on one shared
`pg.Client`, and two requests in flight at once ran inside each other's transactions:
one's `ROLLBACK` discarded the other's answered-200 write
(`docs/archive/decisions/g75-one-connection-per-request.md`).

* A checkout that waits longer than `API_POOL_CHECKOUT_TIMEOUT_MILLISECONDS` (5 s) is
  answered **503 `database_busy`** with a `refusal` line carrying that reason, never a
  hang. The checkout is the request's first statement, so nothing ran.
* A connection that comes back still inside a transaction is destroyed rather than
  lent to the next request (`api_connection_discarded`, `warn`).
* An idle pooled connection whose backend dies is an `api_pool_client_error` line at
  `warn`; the pool drops it and the next request connects afresh. It is not fatal.
* `/healthz`, a refused envelope and a body still arriving hold no connection.
* Startup checks connectivity once — a pooled client, `SELECT 1`, released — and a
  database that cannot be reached at all fails startup, as it did before.
* Some commands deliberately await an external call inside their transaction: the
  suppression journal's S3 write in every suppression command and in the retention
  deletions that record one (10.2: the journal is durable before the row), and
  Google's refresh, `stopWatch` and revoke, with a KMS decrypt, in
  `POST /gmail/disconnect`. On a connection of their own that is safe; it holds that
  connection, and the transaction, for the call's duration.

**The heartbeat** is a separate connection, outside the pool. `ApiHeartbeat` is a
`treat_missing_data = "breaching"` alarm, so an API that stops writing that row pages
someone after three minutes — including an API that is too busy to serve, which is the
point. A heartbeat that waited for a free pool connection would report the queue.

**Stopping** drains (`bootstrap/shutdown.ts`). `SIGTERM` stops accepting, closes each
keep-alive socket as soon as its request has finished, waits for the requests in
flight, stops the heartbeat, ends the pool — which waits for every checked-out
connection to come back — and ends the heartbeat's connection, all inside
`FSS_API_SHUTDOWN_TIMEOUT_MS` (20 s, under the task's 30 s `stopTimeout`). What is still
out at the deadline is not waited for; `api_drained` says `drained: false` at `warn`.
The exit code is 0 either way.

## Health, liveness, readiness

Three different questions, and the infrastructure asks all three:

| Path | Asked by | Answers |
|---|---|---|
| `/healthz` | the container health check (`infra/modules/cluster`) | is this process running? No database is touched. |
| `/readyz` | the load balancer target group (`infra/modules/edge`, since lane g81), a deployment, and an operator | should this task be given traffic? 503 when the database cannot answer, when the pool has no connection free inside the checkout timeout (`database_busy`), or when the schema is outside the range. It asks on a connection checked out from the pool for that request and gives it back. |
| `/health` | an operator | the fuller report G0 wrote. 200 even when degraded. |

A liveness check that queries the database restarts every task in the fleet the moment
the database hiccups. That is why `/healthz` answers from the process alone.

**Every other request asks readiness too** (lane g86, `bootstrap/readinessGate.ts`). A
task that is not ready answers 503 `not_ready` on every path but `/healthz`, `/readyz`,
`/health` and `/auth/client-version`, before authentication and before the route, so it
serves nothing in the tens of seconds the load balancer takes to notice. The verdict is
`/readyz`'s own report, cached for five seconds per process: one check per window on the
connection of the request that found it stale, shared by requests arriving meanwhile, and
none at all inside the window. A busy pool is no verdict; that request is answered
`database_busy` and nothing is cached. `api_readiness_changed` (`warn` when it stops
being ready, `info` when it recovers) says when and why, once per change.

The worker has no HTTP surface, so its health check stats
`/tmp/fss-worker-heartbeat`. The file is a statement rather than a timestamp: it is
written when the schema check passes, rewritten while the scheduler and the runner slots
are succeeding, and **removed** after one of them has failed `FSS_LIVENESS_FAILURES`
times in a row, so `statSync` can actually fail. A task whose database has gone loses
its file, fails its health check and is replaced. The metric publication does not report
to the file: on 24 September 2026 CloudWatch refusing one datum removed it and ECS
replaced healthy workers every few minutes (`release.md` 8.0y). A refused metric is
logged by name as `metric_rejected`, and the missing heartbeat metrics raise their own
alarms.

If the task definition ever sets `readonlyRootFilesystem`, the worker needs a writable
tmpfs volume at `/tmp`. The API writes nothing and needs no such volume.

## The environment

Set by `infra/modules/cluster/main.tf` unless noted. No value is ever logged; the
startup line names every decision and no credential.

| Variable | Both | Meaning |
|---|:--:|---|
| `FSS_ROLE` | ✓ | `api` or `worker`. The image sets it too; a mismatch is refused. |
| `FSS_SCHEMA_MIN`, `FSS_SCHEMA_MAX` | ✓ | the range the *task definition* believes this image accepts. A disagreement with the binary is a stale deployment and is refused at startup. |
| `DATABASE_SECRET_ARN` | ✓ | the Secrets Manager **value**, injected by the ECS `secrets` block. An ARN arriving here means the task definition used `environment` instead, and that is refused rather than diagnosed later as "database unreachable". |
| `DATABASE_URL` | ✓ | the alternative, for a laptop and for rehearsal. |
| `FSS_DATABASE_HOST` | ✓ | the host both connect to, from `active_database_host` in the root (the managed instance's address unless a restore points elsewhere). It replaces the host of the `DATABASE_SECRET_ARN` value; a `DATABASE_URL` is used as given. |
| `AWS_REGION`, `FSS_METRIC_NAMESPACE` | ✓ | where metrics go. The namespace is the environment's own, `FSS/<name prefix>` (`FSS/fss-prod`, `FSS/fss-rh-<run>`), derived once in `infra/modules/stack`; the task roles may publish nowhere else. It has no default: a worker that would publish (a region is set and `FSS_METRICS` is not `off`) refuses to start without one, and refuses one that is not `FSS/` followed by `FSS_NAME_PREFIX`. The bare `FSS` was shared by every environment in the account (g42, lane g55). |
| `FSS_METRICS` | worker | `on`, `off` or `auto` (default). `on` with no usable transport is a refusal; `auto` degrades to the validating no-op and says so. |
| `FSS_WORKER_CONCURRENCY` | worker | runner slots. Default 1. |
| `FSS_SCHEDULER_INTERVAL_MS`, `FSS_METRICS_INTERVAL_MS`, `FSS_RUNNER_IDLE_MS`, `FSS_DRAIN_TIMEOUT_MS` | worker | the cadences. Defaults are the specification's. |
| `FSS_WORKER_LIVENESS_FILE`, `FSS_LIVENESS_FAILURES` | worker | the health-check file and how many consecutive failures remove it. |
| `PORT`, `FSS_HTTP_PORT` | api | the listening port. Default 8080. |
| `FSS_DESKTOP_UPGRADE_URL` | api | the `upgradeUrl` `/auth/client-version` publishes (lane g86): in production the signed update manifest, from the root's `desktop_upgrade_url`. Unset elsewhere is the `callie.example` placeholder; unset in production is a refusal to start. |
| `FSS_API_HEARTBEAT_MS`, `FSS_API_SHUTDOWN_TIMEOUT_MS` | api | the heartbeat cadence and the drain budget. |
| `FSS_ENVIRONMENT`, `FSS_DEPENDENCIES` | ✓ | the deployment switch. `production` refuses anything but `live`, and refuses the switch being unset (`docs/archive/decisions/g12-the-credentialed-bootstrap.md`). |
| `FSS_PUBLIC_ORIGIN` | ✓ | the API's own origin. Both OAuth redirect URIs are derived from it rather than configured twice. |
| `FSS_JOURNAL_BUCKET`, `FSS_ENVELOPE_KEY_ID` | ✓ | the suppression journal and the refresh-token envelope key. A live process without the bucket refuses (10.2). |
| `FSS_GMAIL_PUSH_AUDIENCE`, `FSS_GMAIL_PUSH_SERVICE_ACCOUNT` | ✓ | the two claims the webhook checks exactly (Appendix G 27). |
| `FSS_GMAIL_PUSH_TOPIC` | ✓ | the Pub/Sub topic `users.watch` registers against. In production from the root's `module.pubsub`; the rehearsal carries a placeholder identifier because its Gmail is recorded and it has no Google project (`docs/archive/decisions/g12j-the-rehearsal-has-no-google-provider.md`). |
| `FSS_GOOGLE_HOSTED_DOMAIN` | ✓ | the Callie Workspace domain. Restricts `hd` at sign-in (5.1) and which mailbox may connect (12.1). |
| `FSS_SENDING_ENABLED` | ✓ | 16.2's deployment half. False unless the value is exactly `true`; anything else is a refusal, never a send. |
| `FSS_RESEARCH_PROVIDERS` | worker | Ignored since the research feature was deleted (26 September 2026). Terraform still sets it to `none` until a later infrastructure release removes it. |

The last two rows of Google configuration are the ones that moved: `FSS_GMAIL_PUSH_TOPIC`
and `FSS_GOOGLE_HOSTED_DOMAIN` used to travel inside the operator-written
`google-gmail-oauth-client` secret because nothing in the task environment carried them.
Both bootstraps read the environment first and the secret second, for one release, and
report which source they used. `docs/archive/decisions/g12b-two-public-identifiers-move-out-of-the-secret.md`
says when the fallback goes.

Each task definition carries only the secrets its own process reads (lane g81,
`infra/modules/cluster`): the API `google-gmail-oauth-client`, `google-oidc-client`,
`session-signing-key` and `device-credential-pepper`; the worker
`google-gmail-oauth-client` and, in production only, the classifier key; the operations
task `google-gmail-oauth-client`. Each arrives under its logical Secrets
Manager name except the classifier key, which arrives as `FSS_LLM_CLASSIFIER_API_KEY`,
the name the classifier reads. `research-provider-credentials` reaches no process,
because none reads it; the empty entry goes with a later infrastructure release. None is ever logged; the startup line reports whether each is
configured.

## Metrics, and what is not published

`packages/domain/jobs/metrics.ts` publishes what can be read out of the job,
heartbeat, canary and alert tables, and the mail, outbound, Today and sequences
collectors publish their lanes' gauges through the same loop.
`apps/worker/src/bootstrap/metricCoverage.ts` names every remaining metric an alarm
watches and the log event a CloudWatch metric filter counts for it. Since g72 there is
no third kind: nothing is "owed by a later lane".

`apps/worker/test/metricCoverage.test.ts` parses `local.alarms` and the standalone
metric alarms (`all_sequences_held`) out of `infra/modules/alerts/main.tf`, starts the
real worker against a real database with the alarm conditions already true, and fails
when a name there is in neither list, or when `METRIC_OWNERS` claims a collector for a
name the worker did not publish. An alarm over a metric nobody emits never fires, and an
operator who has seen the alarm exist will believe it is watching.

The log events that become metrics, and who writes them:

| Event | Written by | Metric |
|---|---|---|
| `job_dead` | the worker, one line per dead job | `DeadJobs` |
| `refusal` | the API, one line per refusal, with `reason` | `Refusals` |
| `level: "error"` | both | `ApiErrors`, `WorkerErrors` |
| `suppression_journal_write_failed` | the suppression lane | `SuppressionJournalWriteFailures` |
| `outbound_invariant_violation` | the outbound fence lane | `OutboundSafetyInvariantFailures` |
| `step_held` | the sequence lane | `StepsHeld` |

## The images

`Dockerfile.api` and `Dockerfile.worker`, both `linux/arm64`, both non-root, both with
`node` as PID 1 so `SIGTERM` reaches the drain rather than a shell.

There is no build step: Node runs the TypeScript. It needs
`--experimental-transform-types` rather than plain type stripping, because
`packages/domain` uses constructor parameter properties; see
`docs/archive/decisions/g5b-typescript-at-runtime.md`.

`npm ci --workspace @fss/api --workspace @fss/domain --workspace @fss/contracts`
resolves from the same lock file as the repository root and installs only what those
three need — 45 packages — so the desktop app's Electron and the root's lint and test
tooling never enter the image. `Dockerfile.api.dockerignore` and `Dockerfile.worker.dockerignore`
allow four directories into the build context and exclude everything else.

Both entry points take `--selftest`: read the environment, print the decisions, exit.
No socket, no database, no AWS client. `.github/workflows/greenfield-images.yml` runs
it inside both images, which is how the production dependency set is proved without a
credential.

**Pushing is not CI's.** No AWS credential exists in this repository. The workflow
builds and prints digests; the push is an operator step against a directive, written
at the bottom of the workflow and in `docs/greenfield/infra-apply-runbook.md`. The
digest, not the tag, is what `infra/modules/cluster` accepts.

## The third process: `fss`, the operations command line (lane G12g)

There is a third thing in the worker image and it is not a service:
`apps/worker/src/tools/fss.ts`. It exists because two operations have no home
otherwise — applying migrations, which no deployment step in this repository ever
did, and the database steps of a restore (`docs/greenfield/runbooks/restore.md`).

```
fss migrate [--report <path>] [--allow-any-role]   apply every unapplied migration forward
fss migrate up | status                            the same, and the applied/pending list
fss schema-version                                 the applied version and both declared ranges
fss verify [--actor <name>] [--note <text>]        version, configured parts, and a rolled-back write
fss admin database-users ensure [--runtime-secret <VARIABLE>] [--rotate-password]
fss admin holds list [--reason|--exclude-reason <code>]
fss admin holds release-restore --admin-user <uuid> --note <text> [--hold <id>]
fss admin suppression-journal replay --from <instant> [--to <instant>]
fss admin mailbox list                             every mailbox, its address and status (read-only)
fss admin mailbox reconcile-sent --since <instant> --inventory <address>[,<address>...] [--hold-unattached]
fss admin workspace bootstrap --slug <slug> ...    the first workspace and its admin
fss admin schema-preflight 0019                    the one-off check before migration 0019
fss admin release-record put --json <file> | --json-base64 <value>
fss admin release-record show --reference <releaseGateReference>
```

Every command takes `--report <path>`, which writes the same JSON the command printed.

**`fss verify`** is what a deployment runs between the migration and the first service:
the applied version and whether each declared range accepts it, the configured-parts
report (names and booleans, never values), and one `INSERT` and `SELECT` on `heartbeats`
inside a transaction that is **rolled back**. It runs as the runtime user, because that
is whose `INSERT` is in doubt, and it reports `persisted: false` after re-reading — a
read-only check passes against a user who has lost `INSERT`, a full volume and a read
replica, and each of those is a deployment that looks ready and is not.

**`fss admin mailbox reconcile-sent`** (lane W3-S8) is the Sent-folder step of the
restore runbook, run with both services stopped against the restored copy.
- **Which mailboxes.** The operator's `--inventory`: every address that could have sent
  since the restore point, taken with `fss admin mailbox list` from the instance being
  replaced. It is never only the copy's own list, which cannot know a mailbox connected
  after the restore point. An inventory address the copy has no mailbox for is
  `mailbox_not_in_copy`. A connected mailbox the inventory leaves out is still read, and
  is `mailbox_not_in_inventory`. A run that read no mailbox is refused as
  `reconcile_no_coverage`.
- **What it does.** It reconciles every fence left dispatching since `--since` (the
  restore point less ten minutes), a page at a time and never capped. It then lists each
  Sent folder and answers each FSS message with `recoverSentFolderMessage`
  (`packages/domain/restore/missingFences.ts`): present, marked sent, tombstoned,
  unmatched or unattached.
- **Gmail.** Its client is `readOnlyGmail` (`tools/fss/readOnlyGmail.ts`). That client
  forwards the token refresh, the listings, the `rfc822msgid:` search and metadata reads.
  It refuses a send, a watch, a code exchange, a revocation and a body read. So the
  command runs under `FSS_DEPENDENCIES=live` against real mailboxes.
- **When it refuses to finish** (exit 20, the report printed):
  - a folder was not read to the end (`grant_revoked`, `rate_limited`, `truncated`, or
    `message_vanished` for a message deleted between the listing and its metadata read);
  - a send is unattached. With `--hold-unattached`, each unattached send instead opens a
    `restore_in_progress` hold on the firms it could belong to, or on the workspace when
    it names none. The hold's source is `restore.unattached_send`, keyed by the message's
    hash, so a rerun opens nothing twice;
  - an inventory item is unresolved.

**`fss admin holds release-restore`** (lane W3-S8) is the only thing that releases a
`restore_in_progress` hold since the generation advance went. It needs an active admin
of the hold's workspace (`--admin-user`) and a `--note`. It releases the open restore
holds, or the one `--hold` names, through `releaseHold`, and writes one `audit_events`
row (`hold.restore_released`) per hold in the same transaction. It never touches a hold
of another reason.

**`fss admin release-record put`** (lane g71) stores the `fss.release-record.v1` the
CI gate wrote (`infra/scripts/record.sh from-ci`; lane W3-S8 deleted the rehearsal's), so an admin's `sending_enabled` attestation can name it. The API
refuses an enable whose record did not pass or does not carry the API's own image digest,
and the worker refuses to send when the record does not carry its own
(`docs/archive/decisions/g71-sending-gate-is-bound-to-the-release-record.md`). The command is
idempotent by reference: the same record is `existing`, and a different record under a
stored reference is refused `release_record_conflict`. It runs on the operations task,
as the runtime identity, which may insert into `release_records` and read it, and do
nothing else. `release-deploy.sh --record-only --release-record <file>` runs it alone,
before the apply, and `release-deploy.sh --release-record <file>` runs it again after the
final verify, where it answers `existing`; the CI deploy puts it before the rollout
(`docs/greenfield/release.md` 4.0). `--json-base64` is that form, because a one-off task
is handed only arguments.
`show --reference` reads a stored record back.

**`fss admin database-users ensure`** runs on the migration task. It creates or alters
the runtime login user named in the runtime secret as `LOGIN IN ROLE app_runtime` (0001
created `app_runtime` and `migration` as NOLOGIN group roles, so the login user is a
member and holds no privilege of its own) and grants `migration` to the connected user,
so every later `fss migrate` passes its membership check for a reason. It reports
`created|altered|unchanged` for the user and `granted|already` for the membership, sets
a password only when it creates the user or when `--rotate-password` says so, and
refuses when `app_runtime` or `migration` does not exist — which means `fss migrate` has
not run.

**Two invocation forms, and no third.** Locally, or on a CI runner with a route to
the database:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
DATABASE_URL=postgresql://... node --experimental-transform-types \
  --disable-warning=ExperimentalWarning apps/worker/src/tools/fss.ts migrate
```

and as a command override of the worker image, where `NODE_OPTIONS` already carries
the transform flags and the ECS `secrets` block already carries the database
credential:

```bash
# containerOverrides: [{ "name": "worker",
#   "command": ["node", "apps/worker/src/tools/fss.ts", "migrate"] }]
docker run --rm -e DATABASE_URL="$DATABASE_URL" <worker-digest> \
  node apps/worker/src/tools/fss.ts schema-version
```

The second form is the one that matters in a deployed environment: the database is
not publicly reachable, so the tool has to run inside the VPC, and the worker image
is what is already there. Being the same image is also what makes it the same code,
the same dependency set and the same configuration as the worker that starts
afterwards — `databaseConnection` in `bootstrap/config.ts` and `readWorkerDeployment`
are imported, not reimplemented.

### How it runs in a deployed environment (lane G12h)

**In-VPC one-off ECS tasks** (David, 21 September), and nothing is ever on a PATH.
`aws ecs run-task --overrides` can replace a container's `command` and **cannot**
replace its `entryPoint`, and the worker image's entry point is the worker — so the
two one-off task definitions in `infra/modules/cluster` declare the tool as their
entry point and take the subcommand as the command. A definition that expected
otherwise would start a worker every time an operator asked it for a migration.

| Task definition | Identity | Reads | Runs |
|---|---|---|---|
| `<prefix>-migration` | `<prefix>-migration-task` / `<prefix>-migration-exec` | `migration-database` as `MIGRATION_DATABASE_SECRET`, `app-runtime-database` as `FSS_RUNTIME_DATABASE_SECRET_ARN`. **No runtime connection at all** | `migrate`, `admin database-users ensure` |
| `<prefix>-operations` | the worker task role / worker execution role | `app-runtime-database` as `DATABASE_SECRET_ARN`, plus the application secrets | `verify`, `schema-version`, `admin suppression-journal replay`, `admin mailbox list`, `admin mailbox reconcile-sent`, `admin holds list`, `admin holds release-restore`, `admin release-record put` |

Two rather than one, because of what each needs and what each must not have.
`verify` runs as the *runtime* identity on purpose: the point of a post-deploy gate is
to prove the credential the services are about to use reaches the database, and the
DDL identity must not read the journal or a mailbox. The third, `<prefix>-drill`, held
both and went with the restore drill (lane W3-S8).

`infra/scripts/release-common.sh` is the wrapper. It checks the account, the region,
the cluster's `Environment` tag, full ARNs in this namespace, the registered image
digest against the release's, the network against the root's own output, and the
credential entry the definition resolves — all before the launch. Afterwards it reads
the `failures` array, refuses a task that never started, refuses a stopped task with
no exit code, prints `stopCode` and `stoppedReason`, waits out the log-stream create
race, and records the task ARN so a retry waits on the task already running rather
than starting a second migration.

**A one-off task's filesystem goes away with the task**, so `--report <path>` writes a
file nobody can read afterwards. What survives is the log stream: `--capture` writes
the task's messages to a file on the runner and `release_captured_report` takes the
command's JSON answer out of it — the last parseable object that is not a log line.
That is how a one-off task's report reaches the operator.

**What it reads.**

| Variable | Read by | Meaning |
|---|---|---|
| `DATABASE_URL` | every command except `migrate` | the runtime connection, for a laptop or a runner |
| `DATABASE_SECRET_ARN` | the same | the Secrets Manager **value**, injected by the ECS `secrets` block |
| `FSS_MIGRATION_DATABASE_URL` | `migrate`, `database-users ensure` | the migration user's connection, for a laptop |
| `MIGRATION_DATABASE_SECRET` | the same | the migration credential's secret **value**. `<prefix>/migration-database`, which holds the RDS master user — the only credential a fresh instance has |
| `FSS_RUNTIME_DATABASE_SECRET_ARN` | `database-users ensure` | the runtime credential's secret value, whose `username` and `password` the command creates the login user from. `--runtime-secret` names a different variable |
| `FSS_DATABASE_HOST` | every command | the host the task definition names (`active_database_host`), or a scratch copy's in the quarterly restore smoke. It replaces the host of a connection assembled from a secret; a `DATABASE_URL` that names a different host is a refusal rather than an override |
| `FSS_DEPENDENCIES` | `mailbox reconcile-sent` | `live` or `recorded`, or it refuses; the Gmail client is read-only either way |
| `FSS_JOURNAL_BUCKET`, `AWS_REGION` | `suppression-journal replay` | what the journal is replayed from; without them it refuses rather than replaying nothing |

**`migrate` never uses the runtime credential**, and there is no fallback: the runtime
credential is `app_runtime`'s, and a tool that applied DDL with it would either fail or
succeed because somebody had granted the application more than it needs. It also refuses
outright when the connected role *is* `app_runtime`, before `--allow-any-role` is read.

**The dependency mode is fixed per command**, as data in `COMMAND_DEPENDENCIES`, not as
whatever the environment happens to say: `holds list`, `holds release-restore`, `mailbox list`, `workspace bootstrap`,
`release-record`, `schema-preflight 0019` and `database-users ensure` reach PostgreSQL and
nothing else — no deployment is read, so they cannot reach Gmail, KMS or S3 in a fully
configured production task; `suppression-journal replay` reaches the configured journal
bucket and nothing else; `mailbox reconcile-sent` reaches Gmail through the read-only
client and nothing else, so a command line can never send mail.

It does **not** read `FSS_SCHEMA_MIN`/`FSS_SCHEMA_MAX`: `fss migrate` is the command
that makes those agree, so requiring them to agree first would make it unusable for its
own purpose.

**What it prints.** One JSON object on stdout per command; `--report <path>` writes the
same bytes to a file with mode 600. Logs and refusals go to **stderr** as one JSON line
each in the shape the metric filters parse, so stdout stays parseable. Exit codes: 0,
20 for a refusal an operator has to act on, 21 for a failure, 64 for a usage error.
`--selftest` reads the configuration, prints the decisions and exits without touching a
database, exactly as both services' do.

## How the API is wired (done, lane G3b)

`apps/api/src/server.ts` is the only HTTP surface. `bootstrap/server.ts` was this
lane's duplicate while `server.ts` belonged to the identity lane, and it is gone;
`bootstrap/main.ts` calls `createApiServer`.

* `createApiServer` builds a registry —
  `createRouteRegistry(mountedRoutes([...apiRouteModules(routing), ...extraRoutes]))`
  — eagerly, so two modules claiming one path refuse when the server is created
  rather than on the first request that reaches them. `route()` and `dispatch()` get
  their registry from a `WeakMap` keyed on the options object. Since lane g75 the
  server's options carry `connections`, never a session, and each request runs under
  `optionsForRequest` — the same options on that request's own connection — so the
  modules, which close over their options, close over that request's connection; the
  registry for it costs about 40 µs to build.
* `apps/api/src/routes/modules.ts` is the declaration: which router owns which paths.
  Adding a route is one line there, or one entry in `ApiOptions.extraRoutes`.
* `handle()` reads the body with `bootstrap/requestBody.ts` for body-carrying methods
  only, after `checkEnvelope` and before anything looks at the path.
* The principal is produced once, in `dispatch`, by `authenticate`. A module is given
  a principal, never a credential.

Most routers are mounted on a **prefix** rather than on exact paths, because they
already answer `not_found` for the unknown paths under their own root and because
`GET /firms/<uuid>` cannot be enumerated. The registry refuses a prefix that overlaps
another module's claim, so the guarantee is the one an exact path gives; see
`docs/archive/decisions/g3b-route-registry-prefixes.md`.
