# g80: an app-only release is one rolling deployment, and a task record is read once

Lane g80, 25 September 2026. Audit items O03, O06, O07, O08, O12 and T01 of the GPT-6
exhaustive audit (`b2cc080b`). This records the rules the release scripts, the smoke
and the mutation runner now follow, and the one judgement that went past the brief.

## What `release-deploy.sh` does without `--schema-change`

1. `update-service --desired-count <declared>` on the worker, then on the API. No
   `--force-new-deployment`: the apply that registered the task definitions has already
   started the rollout, and a count change starts no second one.
2. One `aws ecs wait services-stable` naming both services.
3. For each service: `describe-services`, `list-tasks --desired-status RUNNING` and
   `describe-tasks`. It refuses unless the service has one deployment and that
   deployment did not fail, exactly the declared number of tasks are running, each
   belongs to the deployment's task definition, and the container ECS pulled for
   `worker` or `api` reports the release's digest.

Nothing else. No one-off task runs, and the four it used to launch are gone: migrate,
database users, and verify before and after. The schema does not move. The database
users were ensured by the last schema release or the bootstrap, and a credential
rotation is its own procedure (`database-users ensure --rotate-password`). Whether the
running API reaches the schema it declares is what the production smoke's readiness,
schema-range and connectivity checks read.

`--release-record` keeps working on this path. When given, the put is the one
administrative launch, and it runs last, after step 3. It is opt-in, and the enable rule
needs it (g71).

The `--schema-change` path keeps every step, in order, including both forced
deployments. It gains the running-digest check after step 6 and before the final
verify.

**`--api-digest` is now required** outside a dry run, because the API's running tasks
are held to it. Both digests must be `sha256:` plus 64 hex characters. A plan with
`bootstrap=true` is refused without `--schema-change`: the rolling path migrates
nothing, and a bootstrap is an empty database.

**The guards moved up.** Before g80 the first AWS call of every deploy was a one-off
task, and before launching it the wrapper checked the account, a full cluster ARN in
this account, region and namespace, and the cluster's `Environment` tag. The rolling
path's first call is now `update-service`. So `release-deploy.sh` runs the same guards
`release-stop.sh` runs, on both paths, before any call that changes anything.

**A forgotten `--schema-change` is caught.** A release that adds a migration and is
deployed without the flag registers tasks that refuse the schema. The circuit breaker
rolls the service back, the service is stable, and step 3 fails. It names the digest
that is running and says the release is a schema-change one.

## What a one-off task record means

`tasks/<step>.arn` sits beside `tasks/<step>.fingerprint`, and together they mean: this
task was launched and nobody has read how it ended.

- **The fingerprint** is `sha256` over the canonical JSON of fifteen fields: the run,
  environment, prefix, account, region, cluster, step, task definition, container,
  image digest, database host, credential entry, expected exit code, command words and
  environment overrides. The task definition is the revision ECS registered, read from
  `describe-task-definition` when the guard reads it. Only the hash is stored, with the
  run, the task definition, the digest and the attempt beside it for a reader.
- **The run** is `FSS_RELEASE_RUN_ID` when set. Otherwise it is `github-<run>-<attempt>`
  in Actions, or `local:<reports directory>`. The documented production commands make a
  fresh reports directory for every release, so locally the directory is the release
  boundary. Set `FSS_RELEASE_RUN_ID` to start a new release in a directory that already
  holds records.
- **Reused** only when the fingerprint is this invocation's. The wrapper then waits on
  the task and reads its outcome, which is the resume the record was made for.
- **Set aside** when the fingerprint is another's, or when the record has none, as every
  record written before g80. If that task is still running the wrapper refuses, because
  launching beside it is how a second migration hides the first. If it has stopped, or
  ECS no longer knows it, the record is moved to `tasks/<step>.history` unread and the
  step launches its own task.
- **Retired** once its outcome is read: a verdict, a timeout the wrapper stopped, or a
  pull failure about to be retried. The history keeps one line per task: time, outcome,
  ARN and fingerprint.

Retirement is the part the brief did not name. The fingerprint alone does not close
O07. The restore drill's step 7 runs `rehearsal-schema-ranges.sh` a second time, in the
same job and the same reports directory, with the same four step names, task
definitions, digests and commands. Every field matched, so it would have read the four
verdicts the first run had already judged and launched nothing against the restored
schema. Read from the code, that is what every `full` run before g80 did; no run log
records it either way. A record that means "unread" makes that second
run launch its own tasks. The resume case is untouched, because an interrupted
invocation never read its outcome.

## When a one-off task is launched again

Only when the task is `STOPPED`, no container reports an exit code (so no process ran),
and ECS names a `CannotPullContainerError`. It is launched up to `RELEASE_PULL_ATTEMPTS`
(3) times in all. The pause is `RELEASE_PULL_BACKOFF_SECONDS` (30) times the attempt
number, so 30 s, then 60 s. Each attempt is logged with its reason and the time to the
next one. After the last, the wrapper fails, naming the pull error. A resumed record
counts as the attempt it was.

Everything else fails on its first attempt, as before. That includes an exit code, a
`ResourceInitializationError` for a secret with no value (which also stops a task before
any container runs), a `failures` entry from `run-task`, and a timeout.

## The smoke's sending state

`scripts/productionSmoke.mjs --expect-sending disabled|enabled`, default `disabled`. The
sixth check is named for what it expects, `sending_disabled` or `sending_enabled`. It
passes only when `/health` reports that boolean. Its detail reads
`sendingEnabled=<value> expected=<state>`. Any other expectation is exit 2 before any
request. `/health`'s `sendingEnabled` is the deployment flag (`FSS_SENDING_ENABLED`),
not the admin attestation.

## Broken runs in the mutation runner

A mutated run is a kill only when vitest's `Tests` line names a failed test (or an error
thrown while tests ran), and the output shows no syntax or transform failure. Such a
failure is esbuild's "Transform failed", vite's "Failed to parse source for import
analysis" or "Parse failure", a line beginning `SyntaxError:`, `IndentationError:` or
`TabError:` that is not about JSON, or bash's `line N: syntax error`.

Each pattern is anchored where the tool prints it: at the start of a line, or straight
after the error name vitest puts in front of a failure message. The first version was
not. Applying this lane's own runner mutation showed why that matters: vitest prints the
source around a failed assertion, and `mutationRunner.check.ts` names these messages
in its assertions, so a real kill read as a broken run. `mutationRunner.check.ts` now
holds a report that quotes the messages in its code frame and diff to red.

A run that fails this rule is `broken` with `brokenRun: true`. That covers a malformed
edit, a test file that did not load beside passing ones, and "Tests no tests". It is
counted in `brokenRuns` and reported as `MUTATION_UNDECIDED <name>: broken run: …`, the
tag the nightly's problem pattern already lists. Like every problem, it fails the
nightly. `JSON.parse` failures are excluded on purpose: a test that parsed a command's
output and got something else has failed for a real reason.

## Not settled here

- **Sending after an app-only release.** Once sending is enabled, the worker refuses to
  send unless the attested release record carries its own digest (g71). An app-only
  release with a new worker digest therefore holds every send until a record for the
  new digests is stored. The release cadence of 25 September has no rehearsal for an
  app-only release, so no such record will exist. This lane changes neither rule.
  Before sending is turned on, a decision is needed: rehearse every release whose
  worker digest changes, or let a record carry forward.
- **Every cloud behaviour** named above is unmeasured. That covers `update-service
  --desired-count` starting no second deployment, `imageDigest` in `describe-tasks` for
  a Fargate task, the circuit breaker's end state, and the wording ECS uses for a pull
  failure. Each is written from the ECS documentation and the 25 September production
  log. The release cadence makes this a release-script change, so a full rehearsal is
  needed before production relies on it.
