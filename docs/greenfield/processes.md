# The two processes

Specification revision 3, sections 4 and 13. This is what runs on Fargate: how the
worker and the API start, what they do every minute, how they stop, what the health
checks actually check, and which lines of `apps/api/src/server.ts` still have to be
written once the identity lane has merged.

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
  heartbeat.ts    the api heartbeat the worker turns into ApiHeartbeat
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

**The runner slots.** One per unit of configured concurrency, one connection each,
because two slots cannot share a connection — a transaction is not shareable.
Concurrency is one by default. A slot that claimed work asks for more immediately; a
slot that found none waits `FSS_RUNNER_IDLE_MS`.

**The metric publication.** Every sixty seconds, `collectJobMetrics` and one publish
through the sink. With `FSS_METRICS=off`, or with no region, the sink validates every
datum and sends nothing, so a wrong unit or an unknown metric name fails on a laptop.

**Startup** refuses a database outside the declared schema range and exits 10 (4.2,
`docs/decisions/g5-schema-range.md`). It does *not* refuse a restored database: restore
holds are what stop sending and dialing, so the worker runs and logs
`restore_generation_mismatch`, which is the event `infra/modules/observability`
turns into the immediately-critical `RestoreGenerationMismatches` metric.

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

**The heartbeat** is a separate connection. `ApiHeartbeat` is a
`treat_missing_data = "breaching"` alarm, so an API that stops writing that row pages
someone after three minutes — including an API that is too busy to serve, which is the
point.

## Health, liveness, readiness

Three different questions, and the infrastructure asks all three:

| Path | Asked by | Answers |
|---|---|---|
| `/healthz` | the load balancer target group (`infra/modules/edge`) and the container health check (`infra/modules/cluster`) | is this process running? No database is touched. |
| `/readyz` | a deployment, and an operator | should this task be given traffic? 503 when the database cannot answer, when the schema is outside the range, or when the system generation is not the pinned one. |
| `/health` | an operator | the fuller report G0 wrote. 200 even when degraded. |

A liveness check that queries the database restarts every task in the fleet the moment
the database hiccups. That is why `/healthz` answers from the process alone.

The worker has no HTTP surface, so its health check stats
`/tmp/fss-worker-heartbeat`. The file is a statement rather than a timestamp: it is
written when the schema check passes, rewritten while every loop is succeeding, and
**removed** after a loop has failed `FSS_LIVENESS_FAILURES` times in a row, so
`statSync` can actually fail. A task whose database has gone loses its file, fails its
health check and is replaced.

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
| `FSS_EXPECTED_SYSTEM_GENERATION` | ✓ | Appendix E step 1. Absent means the check is not made. |
| `AWS_REGION`, `FSS_METRIC_NAMESPACE` | ✓ | where metrics go. |
| `FSS_METRICS` | worker | `on`, `off` or `auto` (default). `on` with no usable transport is a refusal; `auto` degrades to the validating no-op and says so. |
| `FSS_WORKER_CONCURRENCY` | worker | runner slots. Default 1. |
| `FSS_SCHEDULER_INTERVAL_MS`, `FSS_METRICS_INTERVAL_MS`, `FSS_RUNNER_IDLE_MS`, `FSS_DRAIN_TIMEOUT_MS` | worker | the cadences. Defaults are the specification's. |
| `FSS_WORKER_LIVENESS_FILE`, `FSS_LIVENESS_FAILURES` | worker | the health-check file and how many consecutive failures remove it. |
| `PORT`, `FSS_HTTP_PORT` | api | the listening port. Default 8080. |
| `FSS_API_HEARTBEAT_MS`, `FSS_API_SHUTDOWN_TIMEOUT_MS` | api | the heartbeat cadence and the drain budget. |
| `FSS_ENVIRONMENT`, `FSS_DEPENDENCIES` | ✓ | the deployment switch. `production` refuses anything but `live`, and refuses the switch being unset (`docs/decisions/g12-the-credentialed-bootstrap.md`). |
| `FSS_PUBLIC_ORIGIN` | ✓ | the API's own origin. Both OAuth redirect URIs are derived from it rather than configured twice. |
| `FSS_JOURNAL_BUCKET`, `FSS_ENVELOPE_KEY_ID` | ✓ | the suppression journal and the refresh-token envelope key. A live process without the bucket refuses (10.2). |
| `FSS_GMAIL_PUSH_AUDIENCE`, `FSS_GMAIL_PUSH_SERVICE_ACCOUNT` | ✓ | the two claims the webhook checks exactly (Appendix G 27). |
| `FSS_GMAIL_PUSH_TOPIC` | ✓ | the Pub/Sub topic `users.watch` registers against. From `module.pubsub`; empty when push is off. |
| `FSS_GOOGLE_HOSTED_DOMAIN` | ✓ | the Callie Workspace domain. Restricts `hd` at sign-in (5.1) and which mailbox may connect (12.1). |
| `FSS_SENDING_ENABLED` | ✓ | 16.2's deployment half. False unless the value is exactly `true`; anything else is a refusal, never a send. |
| `FSS_RESEARCH_PROVIDERS` | worker | `none` or `recorded`. A live worker must say which; there is no live research adapter in this build. |

The last two rows of Google configuration are the ones that moved: `FSS_GMAIL_PUSH_TOPIC`
and `FSS_GOOGLE_HOSTED_DOMAIN` used to travel inside the operator-written
`google-gmail-oauth-client` secret because nothing in the task environment carried them.
Both bootstraps read the environment first and the secret second, for one release, and
report which source they used. `docs/decisions/g12b-two-public-identifiers-move-out-of-the-secret.md`
says when the fallback goes.

The secrets arrive under their logical Secrets Manager names — `google-gmail-oauth-client`,
`google-oidc-client`, `session-signing-key`, `device-credential-pepper`,
`llm-classifier-api-key`, `research-provider-credentials` — because that is what the ECS
`secrets` block names them. None is ever logged; the startup line reports whether each
is configured.

## Metrics, and what is not published

`packages/domain/jobs/metrics.ts` publishes what can be read out of the job,
heartbeat, canary and alert tables. `apps/worker/src/bootstrap/metricCoverage.ts`
names every remaining metric an alarm watches and the mechanism that raises it — a log
event a CloudWatch metric filter counts, another process, or a named later lane.

`apps/worker/test/metricCoverage.test.ts` parses `local.alarms` out of
`infra/modules/alerts/main.tf`, starts the real worker against a real database with the
alarm conditions already true, and fails when a name there is in neither list. An alarm
over a metric nobody emits never fires, and an operator who has seen the alarm exist
will believe it is watching.

The log events that become metrics, and who writes them:

| Event | Written by | Metric |
|---|---|---|
| `restore_generation_mismatch` | the worker, at startup | `RestoreGenerationMismatches` |
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
`docs/decisions/g5b-typescript-at-runtime.md`.

`npm ci --workspace @fss/api --workspace @fss/domain --workspace @fss/contracts`
resolves from the same lock file as the repository root and installs only what those
three need — 45 packages — so the old trees' Electron, React and native modules never
enter the image. `Dockerfile.api.dockerignore` and `Dockerfile.worker.dockerignore`
allow four directories into the build context and exclude everything else.

Both entry points take `--selftest`: read the environment, print the decisions, exit.
No socket, no database, no AWS client. `.github/workflows/greenfield-images.yml` runs
it inside both images, which is how the production dependency set is proved without a
credential.

**Pushing is not CI's.** No AWS credential exists in this repository. The workflow
builds and prints digests; the push is an operator step against a directive, written
at the bottom of the workflow and in `docs/greenfield/infra-apply-runbook.md`. The
digest, not the tag, is what `infra/modules/cluster` accepts.

## How the API is wired (done, lane G3b)

`apps/api/src/server.ts` is the only HTTP surface. `bootstrap/server.ts` was this
lane's duplicate while `server.ts` belonged to the identity lane, and it is gone;
`bootstrap/main.ts` calls `createApiServer`.

* `createApiServer` builds one registry per server —
  `createRouteRegistry(mountedRoutes([...apiRouteModules(routing), ...extraRoutes]))`
  — eagerly, so two modules claiming one path refuse when the server is created
  rather than on the first request that reaches them. `route()` and `dispatch()` get
  the same registry from a `WeakMap` keyed on the options object.
* `apps/api/src/routes/modules.ts` is the declaration: which router owns which paths.
  Adding a route is one line there, or one entry in `ApiOptions.extraRoutes`.
* `handle()` reads the body with `bootstrap/requestBody.ts` for body-carrying methods
  only, after `checkEnvelope` and before anything looks at the path.
* `ApiOptions.expectedSystemGeneration: number | null` is Appendix E step 1 and is
  what `/readyz` compares against; `bootstrap/config.ts` reads it from the
  environment.
* The principal is produced once, in `dispatch`, by `authenticate`. A module is given
  a principal, never a credential.

Most routers are mounted on a **prefix** rather than on exact paths, because they
already answer `not_found` for the unknown paths under their own root and because
`GET /firms/<uuid>` cannot be enumerated. The registry refuses a prefix that overlaps
another module's claim, so the guarantee is the one an exact path gives; see
`docs/decisions/g3b-route-registry-prefixes.md`.

## Running the old gate on this Mac

`npm run typecheck` and `npm run lint:tracked` are the **old** trees' gate, not the
greenfield one (`npm run gate:greenfield`). Both fail on a fresh clone with seven
errors that look alarming and are not:

```
cloud/lambdas/delegated-worker/src/handler.ts(11,80): error TS2307:
  Cannot find module '@aws-sdk/client-ssm' or its corresponding type declarations.
...
Unable to resolve path to module '@aws-sdk/client-sqs'  import/no-unresolved
```

**Nothing is wrong with the lambdas.** `cloud/lambdas/*` are independent npm packages
with their own pinned lock files — `docs/decisions/g1-provider-lock-files.md` and
`docs/decisions/g0-old-gate-isolation.md` are why — and the root `npm install` does
not install them. The root `tsconfig.json` and the old ESLint config still *read* their
sources, so an uninstalled dependency reads as a missing module. `.github/workflows/ci.yml`
installs each one before it runs the gate, which is why CI is green and a laptop is not:

```bash
while IFS= read -r -d '' lock; do
  npm ci --prefix "${lock%/package-lock.json}"
done < <(git ls-files -z -- 'cloud/lambdas/*/package-lock.json')
```

Run that once and both commands pass. A greenfield lane does not need to: the old trees
are frozen until the deletion PRs, no greenfield lane may edit them, and
`gate:greenfield` excludes them entirely. The honest statement is the one in this
section rather than a wrapper script that would have to live in the old tree to say it
— see `docs/decisions/g12b-the-old-gate-needs-a-per-lambda-install.md`.
