# Release history: the rehearsal's narrative, the CI deploy's set-up, and what is still unverified (archived)

Moved from `docs/greenfield/release.md` on 27 September 2026 (lane W3-D10), when the operating procedure became [`docs/greenfield/runbooks/operate.md`](../greenfield/runbooks/operate.md) and `release.md` became the invariants alone. Nothing here is a step to run today; it is why the rehearsal has the shape it has, what each credentialed run of September 2026 cost, and what no run has yet proved. Section numbers are the ones `release.md` cites.

The steps themselves are in `runbooks/operate.md`: "A schema or infrastructure release" for the rehearsal dispatch, "Rehearsal clean-up" for an orphan and a held lock, and "Sending" for the attestation. The first release's one-off steps are in [`release-first.md`](release-first.md), and the records 8.0 to 8.0aw in [`release-records.md`](release-records.md).

---

## 3. The rehearsal — CI, started by David

Actions → *Greenfield release rehearsal* → Run workflow, with:

- `mode` — `schema`, the only one. Full mode was deleted with the restore drill on 26 September 2026 (W3-S8); the input stays so a dispatch passing `-f mode=schema` still starts.
- `stage` — how far this run goes: `full` (the default, the whole rehearsal), `plan`, `create`, `deploy`, or `teardown`. Read 3.0 before choosing anything but `full`.
- `api_image_digest` — from CI's `fss-image-digests` for the release commit (2.1);
- `worker_image_digest` — likewise;
- `desktop_commit_stamp`;
- `run_suffix` — optional, except for `teardown`; the prefix becomes `fss-rh-<suffix>`, or `fss-rh-<UTC timestamp>`.

**When to run it (lane g97, 25 September 2026; W3-S8, 26 September 2026).** Before the production plan of every release that changes the schema, the infrastructure or a release script, at the defaults. An app-only release needs none: CI deploys it (4.0). A desktop-only one needs none: build and publish. At `stage: full` it runs create → fill the entries → migrate, then worker, then API (`deploy.sh release --schema-change`) → bootstrap the workspace → the declared schema ranges against the deployed images → the production smoke script against the rehearsal → tear down → the guard, in about 45 minutes: create about 17, deploy about 12, the bootstrap, the ranges and the smoke about 5, and the teardown. The job stops at 90, and each long step has its own limit so a hang still leaves the teardown its time. It writes no release record: the record a release puts comes from the CI gate (4.2).

```bash
gh workflow run greenfield-release.yml --ref main -f mode=schema -f stage=full \
  -f api_image_digest="$API_DIGEST" -f worker_image_digest="$WORKER_DIGEST" \
  -f desktop_commit_stamp="$RELEASE_COMMIT"
```

There is no scheduled rehearsal and no restore drill any more. The monthly drill workflow, full mode, the drill tool, the drill task definition and the rehearsal's release record and manifest were deleted on 26 September 2026 (W3-S8). A restore is done, and rehearsed, by hand from [`runbooks/restore.md`](../greenfield/runbooks/restore.md), whose last section is a quarterly smoke against a scratch copy. The release workflow runs only on a dispatch: never on a pull request or a push.

### 3.0 The five stages, and the order to use them in

Until 21 September the workflow had one mode — the whole gate, all fifteen steps of it — and the
three credentialed runs of that day each stopped at the first error of a class no
offline check can see. One error per run, about an hour of attention each. `stage` makes
the cheap part runnable alone. Each of the first four runs everything the stage before it
runs, plus its own steps; `teardown` is not on that ladder and is
described under the table.

| `stage` | what it adds | what it proves | roughly |
| --- | --- | --- | --- |
| `plan` | the prefix and identity checks, `terraform init` against this run's own state key, `run.auto.tfvars.json`, `terraform plan` with the same variables the apply uses, and a summary | that the rehearsal root can be **planned** in this account with these variables: every required variable is passed, every provider it needs can be configured, and no `count` depends on a value unknown until apply | a few minutes |
| `create` | `terraform apply`, taking its values from the `run.auto.tfvars.json` the plan stage wrote | that the plan can be **applied**: quotas, service limits, IAM, the order Terraform chooses, and whether a fresh environment comes up at all | the apply, dominated by the Multi-AZ RDS instance |
| `deploy` | the two database entries, `infra/scripts/deploy.sh release --schema-change` and `deploy.sh bootstrap`, and the smoke | that a fresh environment can be **migrated and started**: the migration task's networking, whether `fss migrate` accepts the RDS master user, the schema-range refusals both binaries make on startup, and whether a canary datapoint ever appears | the deploy, five one-off tasks of about a minute each |
| `full` (default) | the declared ranges against the deployed images | that the new schema and both images agree in a real environment | about 45 minutes |
| `teardown` | nothing, and it takes the plan away: it runs only the steps before `terraform plan` plus the two every stage runs | that a prefix some earlier run left standing is gone | the destroy |

**`teardown` is the stage for an orphan.** It runs the prefix and identity checks,
`run.auto.tfvars.json`, `terraform init` against the prefix you name, and then the two
steps every stage runs — `infra/scripts/rehearsal.sh teardown` and `rehearsal.sh guard`.
It does not plan, does not apply and deploys nothing.

`run_suffix` is **required** for it and names an existing prefix. Every other stage falls
back to `fss-rh-<UTC timestamp>` when you leave it blank, which is right for a run about
to create an environment and exactly wrong for one about to destroy one: the teardown
would report `destroyed=nothing_created` and the orphan would still be there. The
workflow refuses an empty suffix on a `teardown` before it obtains a credential.

It exists because of the fourth credentialed run. `if: always()` brought the teardown up,
as it always does, and the teardown could not succeed: the journal bucket's own policy
denied `s3:DeleteBucketPolicy` and `s3:PutBucketObjectLockConfiguration` to every
principal including the deployer (8.0d). Before this stage there was no way to try again
without dispatching a run that would also create a second environment.

The recovery of the one orphan that needed a command before its teardown, `fss-rh-202609211659` (21 September 2026), is in [`docs/archive/release-first.md`](release-first.md).

**Every input but `run_suffix` is required, whatever the stage.** All four of `stage`,
`api_image_digest`, `worker_image_digest` and `desktop_commit_stamp` are `required: true`
on the `workflow_dispatch`, which has no notion of an input required by one stage and not
another, so a teardown dispatched from the command line is refused before it starts:

```
HTTP 422: Required input 'api_image_digest' not provided
```

Pass the release's own digests and commit stamp — a `teardown` reads none of them — and
put the prefix to destroy in `run_suffix`:

```bash
gh workflow run greenfield-release.yml \
  -f stage=teardown -f run_suffix=<the run to destroy> \
  -f api_image_digest="$API_DIGEST" -f worker_image_digest="$WORKER_DIGEST" \
  -f desktop_commit_stamp="$RELEASE_COMMIT"
```

**A cancelled `create` leaves its state lock held, and a teardown cannot take it.** This
is the one case where `teardown` is not enough on its own, and it is not the teardown's
fault: an `apply` killed mid-run never releases the lock, so both halves of it stand — the
S3 object `fss/greenfield/rehearsal/<prefix>/terraform.tfstate.tflock` and the DynamoDB
item in `callie-sourcing-tflock` — and every later `terraform` command against that key,
the run's own `if: always()` teardown included, stops inside 90 seconds at `Error
acquiring the state lock` (8.0s, run 35944594998). The lock is taken by hand, by an
administrator, from a scratch checkout at the release commit:

```bash
# Terraform 1.10 or newer, because the backend uses `use_lockfile`; Homebrew's 1.5.7
# refuses the root outright with "Unsupported Terraform Core version".
cd infra/roots/rehearsal
terraform init -reconfigure \
  -backend-config=backend.hcl \
  -backend-config="key=fss/greenfield/rehearsal/<prefix>/terraform.tfstate"
terraform force-unlock <the lock id the error printed>
```

No `kms_key_id` is needed: the state object is SSE-S3. Read the lock's `Who` and
`Created` in the error before taking it — a lock held by a *running* run is a run you
must let finish, and breaking it would corrupt the state it is writing.

**Then the orphans, which the state never recorded.** A create interrupted part-way
leaves behind whatever was in flight at that moment: on run 35944594998 the RDS instance
`<prefix>-pg`, the load balancer `<prefix>-alb` and the CloudFront distribution in front
of the updates bucket existed in AWS and in no state file, so `terraform destroy` could
not see them and a teardown that reported success still left them running. Delete them by
name — `rds delete-db-instance --skip-final-snapshot`, `elbv2 delete-load-balancer`, and a
CloudFront disable followed by a delete — and then dispatch `stage=teardown` for the same
prefix, which removes everything the state does hold. **Finding them is no longer yours to
do**: `infra/scripts/rehearsal.sh leftovers <prefix>` lists every resource still carrying
the prefix and both lock records, and the teardown and the guard fail on anything it finds
(3, item 14), so a run that leaves an orphan is a red run rather than a quiet bill.
Deleting them is still by hand. What remains post-release work for the workflow (8.0s) is
a teardown that force-unlocks a lock belonging to its own run.

**No stage writes a release record.** Until 26 September 2026 `stage: full` in `mode: full` wrote one; the record section 6 and every release put comes from the CI gate (4.2).

**What a `plan` run needs from you.** Two well-formed digests that differ, and a
commit stamp. Nothing reads the stamp before the release record, and nothing anywhere
— no data source, no registry call — checks that the two digests exist: Terraform
only assembles `<repository>@<digest>` into the task definitions. So a `plan` run can
be made before the images are pushed, which is most of what makes it the cheap loop
it is meant to be. `create` onwards needs the real ones.

**The order to use them in.**

1. **The local production plan, from your Mac** — `infra-apply-runbook.md`, "Plan
   first". It is the cheapest credentialed reading of the Terraform there is, it shows
   values you can read, and it finds the same class of error. Do this after every
   Terraform change, before anything in CI.
2. **CI `plan`.** The rehearsal root is not the production root: a different prefix, a
   different set of variables, and — after G12j — no Google provider at all, where
   production has one and needs your application-default credentials (1.7). A clean
   production plan does not imply a clean rehearsal plan, or the other way round.
3. **Fix as a batch.** Terraform reports every *independent* plan-time error in one
   run, so read the whole list before changing anything. The third credentialed run
   reported two errors at once and they had nothing to do with each other (8.0c).
4. **`create`**, once the plan is clean.
5. **`deploy`**, once the create is clean.
6. **`full`**, once the deploy is clean.

A stage is worth running only when the one before it passed. Running `full` first is
what the three runs of 21 September did, and it cost about an hour per error. `teardown`
is outside that order: run it when a run left something behind, and never as part of a
release.

Before any of them, run `infra/scripts/policy.sh check fss-rh-deploy fss-rh`
(`infra-apply-runbook.md` 1.1a). It is read-only, it takes seconds, and it answers the
whole class of error the fourth credentialed run spent an apply on.

**Every stage tears down, and every stage runs the guard.** Steps 13
and 14 of the list below keep `if: always()` and carry no stage condition at all. They
are what protects against a stage condition being wrong, so they may not depend on one:
if the apply's condition were ever mistyped, a `plan` run would create an environment,
and the step that destroys it must not be reading the same input. The teardown is
tolerant of a run that created nothing — it reports `destroyed=nothing_created` — so on
a `plan` run it costs seconds. Those two steps are also the whole of what a `teardown`
run does, which is why the stage needed no new step at all.

**A run must never rely on a single one-hour session.** `fss-rh-deploy`'s
`MaxSessionDuration` is 3600 seconds, which is also the default the workflow's
`configure-aws-credentials` step takes, and a run can outlive it — so the job assumes the
role again, on `always()`, before items 13 and 14, and checks the identity again, because a
renewal is a fresh assumption. The eleventh full run held one session, expired at exactly
one hour, and took the teardown and the production-prefix guard with it (8.0t).

**What a `plan` run prints.** The plan's own output is values: both image references,
the certificate ARN, the hostname, and every attribute Terraform can already resolve.
It goes to a file in the runner's temporary directory, which is not the reports
artifact, and the job summary gets this instead, built from `terraform show -json` out
of each change's `address` and `actions` and nothing else:

```
resource changes: <count>
  create: <count>
create module.stack.module.cluster.aws_ecs_service.api
create module.stack.module.cluster.aws_ecs_service.worker
…
```

(A shape, not a measurement: no rehearsal root has ever been planned.)

A second program then refuses to publish that summary if any value of a variable
assembled from a repository secret appears in it — `api_image`, `worker_image`,
`certificate_arn`, `api_hostname`, and each half of an `<repository>@<digest>` pair —
and refuses just as loudly if `run.auto.tfvars.json` has stopped naming those four, so
that a guard with nothing to look for is a failure rather than a pass. Both programs are
lifted out of the workflow and run by `test/ops/scenario39.check.ts` against a
summary that leaks a hostname and one that does not. Terraform's diagnostics are on
stderr and still reach the log, which is what the stage exists to show.

What none of these stages proves is in 8.1, and the rehearsal's permanent limits are in
`docs/archive/decisions/g12-what-the-rehearsal-cannot-prove.md`.

What the `full` stage does, in order, and why the order is the order. Each item is
tagged with the earliest stage that runs it, and a stage runs everything the stages
before it run:

1. [plan] **Refuse anything that is not a digest.** Two `sha256:` values, and they must differ — one image pushed under both names is a mistake the gate can catch and a person cannot.
2. [plan] **Name the principal.** `infra/scripts/rehearsal.sh identity fss-rh-deploy` prints `aws sts get-caller-identity --query Arn` and refuses anything that is not `arn:aws:sts::…:assumed-role/fss-rh-deploy/<session>`. Every `terraform` command in this job then runs with `-var="assume_deployment_role=false"`, because this session already *is* the deployment role and the provider must not ask STS to assume the role it already holds (`infra-apply-runbook.md` 1.1). The flag makes the job's own credentials the thing the apply acts as, so this step is what makes it safe; it is the one the teardown repeats.
3. [plan] **Judge the prefix; record nothing** (P7, 27 September 2026). `infra/scripts/rehearsal.sh prefix <prefix>` refuses a prefix that is not `fss-rh-` and a run identifier before anything exists. Until P7 this step read every resource tagged with the run prefix through the tagging API and recorded the ARNs for item 14 to compare against, and a third form of the same step re-applied the production refusal to a printed dry-run plan. The record went with the comparison it served: item 14 asks the cloud the absolute question instead — after a teardown nothing should carry the prefix — and an absolute question needs no “before”. The prefix guard went with the rehearsal's dry run. What still keeps a rehearsal command off production is unchanged: `lib.sh` refuses any AWS argument naming `fss-prod` at the call, the session is `fss-rh-deploy`, and that role's policy is scoped to `fss-rh-*`.
4. [plan, then create] **Plan, then create.** The variables the root requires are written to `run.auto.tfvars.json` beside the root, the backend is initialised against this run's own state key, and `terraform plan -out` is run with the whole `-var` list. The `create` stage then applies, and names **no variable of its own**: Terraform loads `run.auto.tfvars.json` automatically from the root directory, which is the same mechanism the teardown's `terraform destroy` depends on. One list in one place is what keeps the plan and the apply the same values. The apply creates the rehearsal root with the run prefix and `bootstrap=true`, deploying both digests from the stable `fss-rh-api` and `fss-rh-worker` repositories. **Both services are created at desired count zero.** A fresh environment's database has no schema, and both binaries refuse to start unless the applied schema version is exactly the range they declare — so an apply that started them would create two services crash-looping against an empty database while the task that would fix it had not been launched. The run creates no repository of its own and its teardown removes none; `infra/roots/rehearsal-registry` owns those two and was applied once, before the first push.
5. [deploy] **Fill every secret entry.** Terraform creates every Secrets Manager entry empty and never holds a value. In production you fill these two by hand (5.1); a rehearsal is unattended and an hour long, so it fills its own: `migration-database` takes the RDS-managed master credentials, because on a database that has never been migrated there is no other login role that can run DDL, and `app-runtime-database` takes a password generated in the runner. Both are masked before they can reach a log. This needs `secretsmanager:PutSecretValue` on `fss-rh-*` secrets on `fss-rh-deploy`, which it has held since the second credentialed run (8.0a, 8.0b).
6. [deploy] **Migrate, then deploy the worker, then the API.** `infra/scripts/deploy.sh release infra/roots/rehearsal <prefix> --schema-change` — the *same script* you run locally for production (section 4.1). It refuses unless both services are at zero — on a fresh stack the apply created them there, and on a stack that already stood the create step ran `stop.sh` before the apply (lane g70) — then runs `fss migrate` as a one-off ECS task inside the VPC, then `fss admin database-users ensure`, then `fss verify`, then the worker to its declared count, then the API, then `fss verify` again against the running deployment. Never beside each other: the API's declared schema range needs the migration to have run. Until 21 September nothing in deployment ran a migration at all; the step was named for an order it did not perform.

    [deploy] **Then the first workspace and its admin**, as its own step between this one and item 7: `infra/scripts/deploy.sh bootstrap infra/roots/rehearsal <prefix> --worker-digest D --slug rehearsal --display-name Rehearsal --admin-email rehearsal-admin@usecallie.com`. A migrated database has no `workspaces` row, and the scheduler's canary is inserted once per workspace — so an environment without one publishes no `CanaryCompletionAgeSeconds`, the `canary_stale` alarm breaches, and item 8's smoke has nothing to judge. That is exactly how the eighth full run failed (8.0p). It is the same script production runs, with `--environment production` (5.1a) and different values.
7. [full] **The declared ranges, against the deployed images** (`infra/scripts/rehearsal.sh ranges <prefix> --api-digest D --worker-digest D`): Appendix G 22's refusal cases, which only a real ECS task can answer. Each service image is launched as a one-off `--selftest` task through the same wrapper the deploy uses, with a declared schema range one below the one it was built with, and the *container* must refuse it — exit 12, `configurationInvalid` in both `API_EXIT_CODES` and `WORKER_EXIT_CODES`. The overlap case, the previous release's image against the current schema, runs **only when a `<prefix>-<service>-previous` task definition is actually registered**: nothing in this repository registers one and a first release has no previous image at all, so the report says `skipped_no_previous` rather than claiming a pass (8.0o).
8. [deploy] **Smoke** with the same `scripts/productionSmoke.mjs` production gets.
9. to 11. **Gone with full mode** (26 September 2026, W3-S8): the release suite runs in the pull-request gate on every commit, and the drill's evidence, the restore drill, the journal replay and the Gmail reconstruction became the hand-run [`runbooks/restore.md`](../greenfield/runbooks/restore.md) and its quarterly smoke. The numbers are kept so that 13 and 14 keep theirs.
12. **Carry watermark**: gone. The carry tool, its step and the record's `carryDrill` field were deleted on 26 September 2026; the old app's data tables were destroyed on 17 September 2026, so there is nothing to carry. The number is kept so that 13, 14 and 15 keep theirs.
13. [every stage] **Tear down**, always, with bypass-governance — and tolerantly, on a session renewed immediately before it so that a run which has already outlived its first hour can still destroy what it made. The teardown is four steps (any one-off task still running, the object-locked journal objects, the root, and the journal bucket if the destroy left it; the restore drill's instance and snapshot steps went with the drill), and each treats the AWS error code for absence as "already done" rather than as a failure, because `if: always()` means it runs after a creation that never happened. A failure that is *not* an absence — an `AccessDenied`, a throttle — still stops it, and an unreadable state that is not "the root was never initialised" still stops it. The report says which: `destroyed=true`, or `destroyed=nothing_created`, and `nothing_left=true`, because the teardown makes item 14's cloud-side reading itself before it reports: a destroy that left something standing is a failed teardown, not a passing one with a failing guard after it. `terraform destroy` requires every variable `apply` did, so the step that opens item 4 writes them to `run.auto.tfvars.json` beside the rehearsal root (identifiers only, ignored by `infra/.gitignore`) and the teardown refuses to destroy without that file rather than fail on a missing variable and leave the environment standing. To tear a run down by hand from a fresh checkout, recreate the file first: `name_prefix`, `api_image` and `worker_image` (`<repository>@<digest>`, from the release record or the run's inputs), `certificate_arn`, `api_hostname`, `assume_deployment_role: false`, `bootstrap: true`, and the two schema ranges read from `packages/domain/db/schemaRange.ts`; then run `infra/scripts/rehearsal.sh teardown <prefix>` from the root directory as the `fss-rh-deploy` session.
14. [every stage] **Nothing of the run is left, and nothing production's was touched** (`infra/scripts/rehearsal.sh guard <prefix>`), always, including on a run that created nothing. Four facts. **One**, `terraform state list` for the run's state key is empty, or the root was never initialised: the teardown destroyed everything the run's state held, and nothing in that state was production's. **Two**, the session is an assumed-role session of `fss-rh-deploy`, whose policy is scoped to `fss-rh-*`. **Three**, nothing in the cloud still carries the run prefix. **Four**, neither lock record of the run's state key is left: no `<key>.tflock` object in the state bucket, no `LockID = <bucket>/<key>` item in the lock table, either of which blocks the next run's `init`. Facts three and four are `rehearsal.sh leftovers <prefix>`, which the guard and the teardown both run and which anyone can run by hand; the guard repeats it up to five times a minute apart, because the tagging API lags a deletion, and names what is left when it still is.
    **What the third fact reads** (restored by the review of PR 292, 27 September 2026): every resource tagged `Name` with the prefix through the Resource Groups Tagging API, plus the four things tagging does not answer well — RDS instances and manual snapshots by identifier prefix, CloudFront distributions by comment (a distribution is listed long before it is deleted), and log groups named `/fss/<prefix>` or `<prefix>`. The cancelled run of 26 September left exactly an RDS instance, a load balancer and a distribution outside the run's state, none of which an empty state can see.
    **What it sets aside, on what evidence.** Six classes AWS keeps listing after it has accepted the deletion are *candidates* to be set aside — an `ecs` service, cluster, task or task-definition; a Fargate `network-interface/`; a `security-group/` or `security-group-rule/`; a `kms` `key/`; an `rds` `auto-backup:` — but the class is not the evidence (review of PR 292b). Each candidate is asked of its own service what state it is in, and only what is gone, inactive, draining to nothing or pending deletion is set aside: a service INACTIVE or DRAINING with nothing running or pending, a cluster INACTIVE, a task STOPPED, a task definition deregistered, an interface or rule EC2 no longer has, a group EC2 no longer has or whose VPC is gone or which holds no rule and no interface, a key PendingDeletion or Disabled, a backup retained or deleting. Anything else of those classes is a leftover like any other, reported with the state it was read in: an ACTIVE service, an Enabled key or a live security group is exactly what a failed teardown leaves. Run 36209569741 found one group and eight rules still listed that `describe-security-groups` answered `InvalidGroup.NotFound` for — that is the reading, not the class. A VPC is not a candidate at all, so a security group that really stayed keeps it. Rehearsal databases delete their automated backups on teardown (`database_delete_automated_backups = true` in `infra/roots/rehearsal`; production keeps them).
    **A reading that cannot be made is not an absence.** A candidate is set aside as gone only when its own service answers with an absence error code; a successful read that projects to nothing (`None`, or no line at all) is a state nobody read, and it stops the guard naming what answered. ECS is the exception that proves it: it reports absence with exit 0 and a `failures` entry, so a service, task or cluster is set aside only when every state field is `None` **and** the reason is exactly `MISSING`, and a task definition only on the `(ClientException) … Unable to describe task definition` pair. CloudFront is read one page at a time (`--no-paginate`), because the CLI's own pagination merges the pages into an answer with no `Quantity` to count against and no `IsTruncated` to say whether it is the whole list; the page must say it is the only one and list exactly what it counts. Every answer is checked for the shape it must have — a projection that is not a list of the rows it asked for is a failed reading, not an empty one — and any reader's failure fails the whole assertion, so no later empty reading can turn an earlier one into a pass. `FSS_REHEARSAL_SETTLING_READS` must be at least one: nothing is asserted without reading.
    **What P7 took away was the comparison, not the reading.** Until P7 this step compared the tagged inventory with item 3's record, and until lane g97 it compared the production inventory too, which failed whenever production was legitimately changed during a run. The absolute question — nothing carries the prefix — needs no record and no diff, and the settling classes are set aside by name in one place rather than learned one failed run at a time (lanes G47, G52, g97). It still sees only the rehearsal's region (8.1, item 1). That nothing production's was touched rests, as it always did, on no rehearsal command naming production (refused at the call), the session, and the role's policy.

15. **Release record**: gone with full mode (26 September 2026). The record a release puts comes from the CI gate (4.2).

If any step fails, steps 13 and 14 still run.

### 3.1 Watching it without credentials

There is no credential-free view of the whole rehearsal any more: its dry-run job was deleted on 26 September 2026, and the drill script whose dry run printed every command went with the drill (W3-S8). Read `.github/workflows/greenfield-release.yml`, then dispatch `stage: plan` first: it plans and summarises and creates nothing (3.0).

---

## 4.0 Setting the CI deploy up (done, 25 September 2026)

1. Apply the role from a plan of this root, given the deployed digests. The plan should create `aws_iam_role.ci_deploy` and `aws_iam_role_policy.ci_deploy`, set `track_latest` in place on `aws_ecs_task_definition.api` and `.worker`, change the outputs, and replace nothing. A plan that replaces a task definition or touches a service is not this change.
2. Create the `production-deploy` environment with `main` as its only deployment branch.
3. Give it the secret `FSS_PRODUCTION_CI_ROLE_ARN`: the public ARN that `terraform output -raw ci_deploy_role_arn` prints.
4. Set the four repository variables the deploy job launches the puts with (lane g100). They are public identifiers, read from the production root's outputs after the apply that adds them, and never from state in CI:

   ```bash
   cd infra/roots/production   # initialised as for section 4
   gh variable set FSS_PRODUCTION_CLUSTER_NAME           --repo david-cui-bruno/founding-sales --body "$(terraform output -raw ci_deploy_cluster_name)"
   gh variable set FSS_PRODUCTION_OPERATIONS_TASK_FAMILY --repo david-cui-bruno/founding-sales --body "$(terraform output -raw ci_deploy_operations_task_family)"
   gh variable set FSS_PRODUCTION_TASK_SUBNET_IDS        --repo david-cui-bruno/founding-sales --body "$(terraform output -raw ci_deploy_task_subnet_ids)"
   gh variable set FSS_PRODUCTION_TASK_SECURITY_GROUP_ID --repo david-cui-bruno/founding-sales --body "$(terraform output -raw ci_deploy_task_security_group_id)"
   ```

   Expect `fss-prod-cluster`, `fss-prod-operations`, two comma-separated `subnet-…` ids and one `sg-…` id. The record step refuses an empty or malformed one and names the variable. It also refuses a cluster name other than the one the deploy acts on.
5. Dispatch *Greenfield deploy* once by hand with the id of the latest green *Greenfield images* run on main. That range holds this lane's own infrastructure and workflow, so expect `manual`: release that one by hand, and CI takes over from the next app merge.

Optionally, customize the repository's OIDC subject claim to include the workflow, ref and event. Then change the trust's `sub` in `ci_deploy.tf` and its test to the exact new value together, in one pull request applied before the customization.

---

## 8. What this document could not verify

The records of what each credentialed run proved and refuted, and of what each lane's
change did, 8.0 to 8.0aw, are in [`docs/archive/release-records.md`](release-records.md), unchanged. A
numbered reference such as "8.0u", in this document or anywhere else, names one of them. From
25 September 2026 a change is its merged pull request instead, and this section holds only
what is still unverified.

### 8.1 Still unverified

Production is live: applied, deployed, bootstrapped and smoked at `66203322` on 24 September, and redeployed since (8.0s, 8.0v). Sign-in works and the first mailbox is connected (8.0x, 8.0y). The first release record exists: run 36100448302 at `b0f46711` passed every step, the restore drill's Appendix E steps 1 to 9 included, and wrote `releaseGateReference` `fss-rh-202609250554-2026-09-25T07:20:44Z`, kept outside GitHub's artifact retention in the coordinator's `.context/release-records/`. What follows is what that still does not settle. On 25 September lane g93 removed the items later runs had answered and cut the drill's item to the two gaps it left; the list as it stood is at the end of `docs/archive/release-records.md`, and an item number in an older document refers to that copy.

1. **The guard's reading is regional.** It reads the run's Terraform state, the session, and everything in this region carrying the run prefix — the tagging API, RDS by identifier, CloudFront by comment, log groups by name, and the two lock records (3, item 14). What it cannot see is a resource the run made outside its own state in another region; nothing in the rehearsal does. P7 briefly dropped the cloud-side reading altogether and the review of PR 292 restored it: the cancelled run of 26 September left an RDS instance, a load balancer and a distribution that an empty state answered nothing about.
2. Whether the worker task role can write the suppression journal. **Closed by G12b in the plan, unproved in the cloud.** `infra/modules/cluster` now gives the worker `s3:PutObject` on the journal object prefix and `kms:Encrypt`/`kms:GenerateDataKey` on the journal key, and `infra/modules/journal` names both task roles as permitted writers rather than the API alone — so the bucket policy's `DenyWritesFromAnyoneButTheTaskRoles` no longer refuses the worker. Neither role asks for any `s3:Delete*`, and no writer sets a per-object retention: the bucket's own default retention locks every object on put, and `s3:PutObjectRetention` stays denied to everybody. `infra/modules/cluster/tests/services.tftest.hcl` asserts both halves offline. What a plan cannot prove is that the first real opt-out the worker imports actually lands in the bucket; watch the `SuppressionJournalWriteFailures` metric after Gmail sync is first enabled, because a remaining IAM refusal surfaces there and nowhere else.
3. Whether one day of GOVERNANCE retention is long enough that `--bypass-governance-retention` is only ever needed for a same-day teardown.
4. **The restore drill is gone, and a rollback does not cross its removal.** PR 272 (main `beed2d90`) deleted the drill's task definition, roles, policies, metric filter and alarm, and W3-S8 moved what it exercised to the hand-run [`runbooks/restore.md`](../greenfield/runbooks/restore.md) and its quarterly smoke; what run 36100448302's drill left open (Appendix E.3's missing fences, recovered from the Sent folder since lane g73, and the API's per-process recorded-mode key) is that runbook's to prove now. A rollback to a release older than `beed2d90` would plan the drill back into existence, so `rollback.sh` refuses it: across that boundary only the images roll back, and infrastructure is repaired forward (4.1a). Unverified: that images-only procedure has not been run.
5. **The update path on a real Mac.** Signed and notarized builds are published to the update channel, the first being Callie 1.0.0 from `66203322` (8.0t). Gatekeeper's verdict on a downloaded build is not recorded here, and nobody has yet watched the updater take an update from the channel: since lane g83 it downloads, verifies and swaps a new build in at launch (8.0ap).
6. **The first mailbox, read back.** The mailbox connected from desktop 1.0.1 between 18:00Z and 18:11Z on 24 September, and the worker inserted its first jobs at 18:11:37Z (8.0y). The "This Mac" card and `/gmail/status` readings after it are not recorded here, nor are the audit row `auth.provisional_user_adopted` and the absence of both warn lines that 5.2a asks for. `fss-prod-mailbox-heartbeat-missed` flapped on a healthy worker until lane g58 (8.0z); whether it and `fss-prod-gmail-watch-expiring` now stay clear is not recorded here.
7. **Sending.** Section 6 has run: `FSS_SENDING_ENABLED` is `true` (committed in the root since 26 September 2026) and the attestation is the process form, `ci-gate:main`. 12.7's authentication checks, the six-week ramp, and the journal's first real write — item 2 above, which surfaces only as `SuppressionJournalWriteFailures` — are all unproved in production.
8. **Email validation against real DNS.** Since PR 231 the worker checks each unchecked address's domain (`route.validate`, `docs/archive/decisions/g90-email-technical-validation.md`). No test has asked a real DNS server: that the VPC resolver answers MX queries from the worker task, and that Node reports a null MX as an empty exchange, are inferred. After the deploy, `route.email.validated` audit events with `mx_present` or `implicit_mx` answer it; a run of `route.email.validation_deferred` events means the resolver is not answering.
9. **The CI deploy of an app-only change (lane g91) — unrun.** Nothing credentialed has run it. Still open:
    - that GitHub issues this repository's jobs the legacy subject `repo:david-cui-bruno/founding-sales:environment:production-deploy`. A repository opted into immutable subjects uses owner and repository ids, and the trust would then match nothing;
    - that ECS authorizes `ecs:RegisterTaskDefinition`, `ecs:DescribeTaskDefinition` and `ecs:DeregisterTaskDefinition` on `*` only (the first under the `NamePrefix` request tag, with `ecs:TagResource` for the tags), and `ecs:ListTasks` under `ecs:cluster`;
    - that `UpdateService` carries `ecs:task-definition` in its request context, which the plain `ArnLike` now requires, so if it does not, every roll is refused;
    - that `docker buildx imagetools create` from a runner copies into `fss-prod-*` with only the ECR actions the role holds;
    - that the images production runs today carry a `ci-<commit>` or bare commit tag, without which every guard answers manual;
    - that turning `track_latest` on is an in-place change with no replacement, and that it makes the first plan after a CI deploy show no change. Only a real plan of `infra/roots/production` can show these two;
10. **The CI deploy's release record put (lane g100) — unrun.** No credentialed run has put a record. Still open:
    - that ECS evaluates `ecs:cluster` on `RunTask` with the ARN form the `ArnEquals` condition names;
    - whether `--propagate-tags TASK_DEFINITION` makes `RunTask` a tag-on-create at all. The grant of `ecs:TagResource` under `ecs:CreateAction = RunTask` is there in case it does. If a run shows it is not needed, it can go;
    - that `RunTask` needs no `iam:PassRole` beyond the worker's two roles;
    - that the four repository variables hold what the outputs print. No apply has created those outputs yet;
    - that the last apply's operations image accepts a `ci-gate` record. Only images built at or after PR 235 know the `source: "ci-gate"` shape, so the first put needs an apply after that. Since 26 September 2026 the put comes before the rollout, so a refusal there stops the deploy instead of following it.
