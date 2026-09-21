# The operations command line, and what the deployment still lacks

**Lane:** G12g · **Date:** 21 September 2026 · **Spec:** 4.2, 16.1, Appendix E, Appendix G 11 and 22

## What this lane found

Reading the release end to end turned up two gaps that a document cannot close.

**Nothing in deployment ever runs a migration.** The release workflow's step is called
"Migrate forward, then deploy the worker, then the API" and what
`infra/scripts/rehearsal-schema-ranges.sh` does is force a new deployment of each
service. Both binaries refuse to start unless the applied schema version is exactly the
one they declare (`packages/domain/db/schemaRange.ts`, `CURRENT_SCHEMA_VERSION` 14), so
against a fresh database both services exit at startup, for ever, and no command in this
repository would have changed that. `applyMigrations` existed and had no caller outside
the test harness.

**The restore drill calls a tool that did not exist.** Every `fss admin …` line in
`infra/scripts/rehearsal-restore-drill.sh` and `docs/greenfield/restore-drill.md` named a
command line nobody had written. G12f made its absence a named precondition rather than a
`command not found` at step 5; this lane wrote it.

## What the tool is

`apps/worker/src/tools/fss.ts`, with its modules under `apps/worker/src/tools/fss/`.
`migrate`, `migrate up|status`, `schema-version`, `verify`, `drill` and fourteen
`fss admin` commands. One JSON object on stdout per command; `--report <path>` (or
`--out`) writes the same bytes; `holds list --count` prints a bare integer because the
drill compares it in a shell. Logs and refusals go to stderr in the JSON shape the
CloudWatch metric filters parse, so stdout stays parseable. Exit codes: 0, 20 for a
refusal an operator must act on, 21 for a failure, 64 for a usage error.

### Why it lives in the worker image and not beside the carry

`apps/worker/tools/carry` is deliberately excluded from the image: the carry runs on an
operator's machine against the old stack. This tool is the opposite. The database is not
publicly reachable, so the tool has to run inside the VPC, and the worker image is what
is already there. `Dockerfile.worker` copies `apps/worker/src`, so `src/tools/fss.ts`
ships with no Dockerfile change and under the allow-list
`packages/domain/test/policy/imageClosure.test.ts` already enforces. Being the same image
also makes it the same code, the same dependency set and the same configuration reader as
the worker that starts afterwards: `databaseConnection` and `readWorkerDeployment` are
imported from `src/bootstrap`, not reimplemented. David's decision of 21 September — in-VPC
one-off ECS tasks — is what this shape was chosen for; G12h wires it.

### Decisions taken under spec silence

**Two connections.** `migrate` uses the migration credential
(`FSS_MIGRATION_DATABASE_URL` or the injected `MIGRATION_DATABASE_SECRET` value) and
never falls back to `DATABASE_URL`; every other command uses the runtime one. It refuses
outright when the connected role is `app_runtime`, before `--allow-any-role` is read,
because a migration applied with the application's credential either fails halfway or
succeeds because somebody granted the application DDL.

**The migration-role check is conditional.** Migration 0001 creates `app_runtime` and
`migration` as NOLOGIN group roles, so a database that has never been migrated has no
`migration` role to be a member of. The check is therefore: if the role exists, the
session must be a member; if it does not, the report says so and the run proceeds,
because this run is what creates it. `fss admin database-users ensure` then grants
`migration` to the connected user, so every later run passes for a reason rather than by
the absence of one. `SET ROLE migration` is deliberately not done: object ownership would
then differ between production and every test database here, and 0001's grants are
written against roles rather than owners.

**`--as-of` rather than `now()`.** Every count the restore protocol compares is measured
at the instant RDS restored to, on both sides of the restore. A count of "now" on each
side would be two different questions whose difference means nothing.

**`dial-authorize --any` reads a subject rather than inventing one.** `authorizeDial`
requires an identity owned by the acting salesperson, so a system actor could never get
past step 2 of nine and would always be refused for the wrong reason. The command finds an
assigned firm with a usable route and a verified identity owned by the assignee and asks
the question that person's card would ask. A database with no such triple gets a refusal
to answer (`no_dialable_subject`, exit 20) rather than a refusal to dial: "refused" from a
probe that had nothing to probe is exactly the vacuous pass the drill exists to prevent.
The applicable holds are reported beside the decision, because `authorizeDial` stops at
the first refusal and the restore pause is the last of eight — a drill at three in the
morning can be refused for being outside the calling window, and an operator still has to
see that `restore_in_progress` is what will refuse it at ten.

**The dependency mode is fixed per command** (David's condition, 21 September), as data
in `COMMAND_DEPENDENCIES` and asserted by a test: database-only commands never read the
deployment at all, so they cannot reach Gmail, KMS or S3 in a fully configured production
task; the journal replay reaches the configured bucket only; the three mailbox commands
and `drill` require `FSS_DEPENDENCIES=recorded` and refuse `live`. **This is a real
limitation and it is deliberate:** reconstructing sends from live Gmail during a
production restore is not something this tool will do, and the way to be sure is to refuse
it here rather than to trust that nothing downstream sends.

**`verify` writes and rolls back.** One `INSERT` and one `SELECT` on `heartbeats` inside a
transaction that is rolled back, then a re-read that reports `persisted: false`. A
read-only check passes against a user who has lost `INSERT`, a full volume and a read
replica. `heartbeats` is the one operational table with a nullable `workspace_id`, so the
check works on a migrated database with no workspace yet — which is exactly when a
deployment verifies.

**`system-generation advance` requires an admin id and does not have a session.**
Appendix E step 9 wants "a deliberate human act with a normal active, device-bound admin
session", and a command line has none. The command therefore refuses without
`--admin-user` or `FSS_ADMIN_USER_ID`, checks that the id is an active admin of some
workspace, and records it — which
`system_generations_operator_advance_attributed` requires of the row anyway. It does
**not** additionally refuse in a production environment, and that is a decision rather
than an oversight: the API route with a device-bound session does not exist, so refusing
here would leave a production restore with no way to release its own holds. When that
route lands, this command should refuse outside a rehearsal.

**`verifyRestoreReport` refuses any unresolved exception.** Section 9 of the runbook says
step 9 "refuses unless the step 8 report exists and has no unresolved exception", while
section 11 lists fences left `reconciling` as a category to *report*. The two disagree.
The conservative reading wins — the command refuses — and the consequence is stated here
because it will bite: a legitimate drill with one fence inside its 24-hour observation
window cannot advance the generation without an operator deciding that fence's outcome
first. If that is wrong, section 9 is the sentence to change, not this command.

## What the deployment still lacks for `fss migrate` to run before the services

For the coordinator and G12h. Nothing in this list is inside this lane's scope
(`infra/modules`, `infra/roots` and the workflows are not this lane's to edit).

1. **A way to run it.** There is no `fss` executable: no package declares a `bin` and no
   workflow step puts one on PATH, so `infra/scripts/rehearsal-restore-drill.sh` refuses
   at its own precondition. The two supported invocations are
   `node apps/worker/src/tools/fss.ts …` locally and the same as an ECS command override
   of the worker image. One of: a `bin` in `apps/worker/package.json` plus a PATH entry, a
   wrapper script on the runner, or a `run-task` in the drill.
2. **A migration credential, and a secret for it.** `fss-<env>/database-migration-user`,
   holding the RDS master user's JSON (`username`, `password`, `host`, `port`, `dbname`),
   injected as a **value** into `MIGRATION_DATABASE_SECRET` through the ECS `secrets`
   block. The master user must have `CREATEROLE` for `database-users ensure`.
3. **A runtime credential secret.** `app-runtime-database` (G12h's name), injected as a
   value into `FSS_RUNTIME_DATABASE_SECRET_ARN` for `database-users ensure`, and as
   `DATABASE_SECRET_ARN` for the two services once the user exists.
4. **A task definition or overrides that run it before the services.** The order is
   `fss migrate` → `fss admin database-users ensure` → `fss verify` → worker → API. The
   rehearsal's step 5 and `docs/greenfield/release.md` 4.1 both state that order and
   neither has anything that performs the first two steps.
5. **Network and IAM for the task.** The migration task needs the database security group
   and the private subnets, the two secrets on its execution role, and — for
   `suppression-journal replay` — `s3:GetObject` and `s3:ListBucket` on the journal
   prefix. The worker task role has `s3:PutObject` today and no read.
6. **`@aws-sdk/client-s3` is a devDependency of `@fss/worker`.** The image installs
   `--omit=dev`, so the journal replay's lazy import fails inside the image with
   `sdk_unavailable` — and so does the worker's own `loadS3SuppressionJournal`, which is
   a pre-existing latent failure of G12b's journal write, not something this lane
   introduced. It belongs in `dependencies` for either to work.
7. **`FSS_DATABASE_HOST` for the restored endpoint.** The drill restores to
   `${PREFIX}-pg-restored`, which no secret names. The tool accepts the override and
   refuses when a whole `DATABASE_URL` disagrees with it; something has to set it.

## The drill script change this lane did make

`--restore-time "$DRILL_START"` asked RDS to restore to an instant a second old. The
latest restorable point lags real time by up to about five minutes (spec 4.1), so that
request is refused with `InvalidRestoreTime` — in the cloud, after the guards, on a
credentialed run. The drill now reads `LatestRestorableTime` from the source instance
before the restore, measures the baseline at that instant, and asks for
`--use-latest-restorable-time`. Reading first and restoring second means the restored
database can only hold slightly *more* than the baseline counted, which is the safe
direction: every assertion is "no suppression lost, no send repeated" against a floor.
The execution path is untouched, as briefed, and every `fss` invocation is left exactly
as it was.

## What was added to the domain because it did not exist

The brief said every operation the drill calls exists as a domain function. Five did not,
and they are now in `packages/domain/restore/` and `packages/domain/suppression/replay.ts`:
the reconciliation counts, the runnable-job discard, the hold listing and selective
release, the generation advance with its report, and the journal replay. Each is written
to the sentence of Appendix E it implements and nothing more. `listHoldsByReason` was added
to `packages/domain/policy/holds.ts` because the restore protocol asks whether a reason is
in force, which the subject-shaped `listApplicableHolds` cannot answer.
