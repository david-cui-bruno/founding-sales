# FSS release: what David does, what CI does, and in what order

**Lane:** G12 · **Spec:** 16.2, Appendix E, Appendix G · **Audience:** the operator releasing a change to production, which has been live since 24 September 2026.

`docs/greenfield/infra-apply-runbook.md` is how the infrastructure comes into existence. This document is how a **release** happens on top of it: which steps are yours, which are the workflow's, and why the order cannot be rearranged.

This is the runbook and nothing else. What each merged change did is its merged pull request (`changelog.md` holds the list up to 26 September 2026), and the records of the credentialed runs and lanes before 25 September 2026 (the numbered references such as 8.0u below) are in [`docs/archive/release-records.md`](../archive/release-records.md).

The first release's one-off steps (sections 1, 2.0, part of 3.0 and 5) are in [`docs/archive/release-first.md`](../archive/release-first.md), under the numbers this document cites.

> **The one sentence the whole document serves.** Specification 16.2: *"Production sending remains disabled until all mandatory scenarios for the affected release class pass, the deployed commit/image digests match the rehearsal artifacts, and an authenticated admin enables sending."* Nothing below turns sending on. The last step of the last section does, and only you can do it.

---

## 0. Who does what

| Step | Who | Why it cannot be the other one |
|---|---|---|
| Build, push and verify the images | CI (`greenfield-images.yml`, its `publish` job on a push to main that changes an image input) | One build per commit, pushed to `fss-rh-api` and `fss-rh-worker` as `ci-<commit>`, pulled back by digest and verified, with the digests published as `fss-image-digests`. That digest is the release's identity (8.0al). |
| **Deploy an app-only change to production** | **CI (`greenfield-deploy.yml`, after `publish`), as `fss-prod-ci-deploy`** | David's decision of 25 September: app-only changes deploy themselves. It promotes by digest, registers the two service revisions, rolls, holds each to its digest and smokes; anything that is not application code, or expects another schema, answers "manual" and touches nothing (4.0). |
| **Promote the images of a schema or infrastructure release** | **David, with the admin profile** | `infra/scripts/images.sh promote image-pin.json` copies the two CI digests from `fss-rh-*` to `fss-prod-*` and reads production back (2.1). |
| **Apply the rehearsal registry — once, ever** (done) | **CI, by a workflow deleted on 26 September 2026** (`infra-apply-runbook.md` 2.1) | Same reason as the row below: `fss-rh-deploy` is assumable only from the `rehearsal` environment. `infra-apply-runbook.md` 2.1. |
| Run the rehearsal | CI (`greenfield-release.yml`) | It needs the `fss-rh-deploy` role, which only the OIDC provider may assume, and it must tear the environment down even when a step fails. |
| Write the release record | The CI deploy, before each rollout (4.0); David by hand for a manual release (`record.sh from-ci`, 4.2) | Since lane g96 (the owner's axiom 10B) it comes from the *Greenfield gate* run that was green on the deployed commit, not from a rehearsal. The script reads only GitHub and refuses unless the gate and the images run of that commit are green and name the digests, so a record can only exist for a commit CI passed. |
| Apply production Terraform | David | A plan should be read by a person before it is applied. |
| Put the secret values in | David | Terraform creates empty secrets and never holds a value. |
| Create the DNS ALIAS | David | It points at a load balancer that does not exist until the first apply. |
| Confirm the SNS subscription | David | AWS sends an email with a link. Nothing can click it for you. |
| Grant the Gmail push | David | A Google consent screen in a browser. |
| **Build and sign the desktop app — last, after the apply** | **CI (`greenfield-desktop.yml`), on prerequisites only David can create** | It needs a Developer ID Application certificate, the nine signing and notarisation secrets (eight of which are unset as of 20 September 2026), three repository variables, and the `desktop-release` GitHub environment; and it refuses to build without `FSS_UPDATE_CHANNEL_URL`, which is the CloudFront hostname the production apply creates. So it cannot come before section 4. `docs/greenfield/install.md` lists every one of them, and the job fails closed naming whichever is missing. |
| Publish and install the desktop artifact | David | The one step that changes what every Mac sees. |
| Run the production smoke checks | David or CI | Read-only, safe either way. |
| **Enable sending** | **David, as an authenticated admin** | 16.2. It is an act, not a step. |

The desktop rows are last on purpose, and 2.0 explains why the obvious order cannot run. Nothing in this table can be done out of order without something below it refusing.

---

## 1. Before the first release

Done once, before 24 September 2026. The first release's one-off steps are in [`docs/archive/release-first.md`](../archive/release-first.md): sections 1.1 to 1.7, 2.0, the orphan recovery of 3.0 and 5.1 to 5.4, under the numbers this document still cites.

---

## 2. The images — CI publishes them, David promotes them

Nothing is built on a Mac. CI builds, pushes and verifies both `linux/arm64` images, and production receives a copy of those exact digests (8.0al).

The order the first release needed, and why the desktop build came last, is 2.0 in [`docs/archive/release-first.md`](../archive/release-first.md).

### 2.1 The images

1. **The digests come from CI.** Every push to main that changes an image input runs *Greenfield images*. Its `publish` job pushes `fss-rh-api:ci-<commit>` and `fss-rh-worker:ci-<commit>`, pulls both back by digest, runs `infra/scripts/images.sh verify` on what it pulled, and uploads the artifact `fss-image-digests` (`image-digests.json`, `fss.image-digests.v1`). A commit that changed no image input (a script-, docs- or infrastructure-only merge) has the images of the last one that did; `images.sh pin <commit> image-pin.json` finds them and the green gate run of that images commit, which is what the release record is built from (4.2). The digests (`sha256:` and 64 hex characters), not the tags, are what everything downstream compares: `infra/modules/cluster` and `rehearsal-release-record.sh` both refuse a mutable tag.
2. **The rehearsal deploys those digests** from `fss-rh-api` and `fss-rh-worker`, the two stable repositories `infra/roots/rehearsal-registry` owns. Dispatch it with the two digests (section 3).
3. **Production gets a copy, never a rebuild.** With the admin profile, from a checkout of main:

   ```bash
   GITHUB_REPOSITORY=david-cui-bruno/founding-sales infra/scripts/images.sh pin "$(git rev-parse HEAD)" image-pin.json
   infra/scripts/images.sh promote image-pin.json      # or CI's image-digests.json
   ```

   An app-only change is not promoted by hand. *Greenfield deploy* promotes `image-digests.json` itself, as `fss-prod-ci-deploy`, once it has decided the change is app-only (4.0). The same command with the admin profile is the fallback when that workflow cannot run. Running it twice copies nothing the second time (`already-present`).

   Each digest is copied from `fss-rh-*` to `fss-prod-*` with `docker buildx imagetools create --prefer-index=false`, a carbon copy of CI's bare manifest, and the tag is read back. If the tag names anything else, the image itself must be in production, and it is tagged there by its own manifest (`<tag>-image` when the release's tag is taken) and read back again. A digest production already holds under a tag is not copied again; one it holds untagged is tagged in place. A tag that already names another image is never overwritten. `docs/archive/decisions/g86-the-promotion-copies-a-bare-manifest-as-itself.md`.

The **desktop commit stamp** is the release commit from 2.0 — the same `git rev-parse HEAD` you have been using — and the release record names it. You do not wait for a Mac build to learn it.

---

## 3. The rehearsal — CI, started by David

Actions → *Greenfield release rehearsal* → Run workflow, with:

- `mode` — what the run is for: `schema` (the default) or `full`. Read "The two modes" below.
- `stage` — how far this run goes: `full` (the default, meaning the whole of the chosen mode), `plan`, `create`, `deploy`, or `teardown`. Read 3.0 before choosing anything but `full`.
- `api_image_digest` — from CI's `fss-image-digests` for the release commit (2.1);
- `worker_image_digest` — likewise;
- `desktop_commit_stamp`;
- `run_suffix` — optional, except for `teardown`; the prefix becomes `fss-rh-<suffix>`, or `fss-rh-<UTC timestamp>`.

**The two modes, and the cadence (lane g97, David's decision of 25 September 2026).** A dispatch left at its defaults is the trimmed `schema` rehearsal. The full run is the monthly restore drill.

| `mode` | when | what it runs, at `stage: full` | roughly |
| --- | --- | --- | --- |
| `schema` (default) | every release that changes the schema, the infrastructure or a release script; an app-only release needs none (deploy and smoke), a desktop-only one needs none (build and publish) | create → fill the entries → migrate, then worker, then API (`release-deploy.sh --schema-change`) → bootstrap the workspace → the declared schema ranges against the deployed images → the production smoke script against the rehearsal → tear down → the guard. No drill evidence, no release suite (it already runs in the pull-request gate on every commit), no restore drill, no journal drill, and **no release record or manifest** | about 45 minutes: create about 17, deploy about 12, the bootstrap, the ranges and the smoke about 5, and the teardown; the job stops at 90, and each long step has its own limit so a hang still leaves the teardown its time |
| `full` | the first Sunday of each month at 06:00 UTC, from *Greenfield monthly restore drill* (`greenfield-monthly-drill.yml`), pinned to main's commit; and by hand whenever you want the drill before a release | everything in the numbered list below: the schema run plus the drill's evidence, the release suite, the restore drill, the journal replay and Gmail reconstruction, and the release record and manifest | up to the 180-minute timeout |

The weekly scheduled full rehearsal (lane g74) is off: its workflow became the monthly drill. Since 26 September 2026 the drill has one cron, 06:00 UTC on days 1 to 7, and runs on the Sunday among them only: there is no catch-up when that run fails to start, and no `off` switch (`FSS_MONTHLY_DRILL_HOUR_UTC` is no longer read). **To run the drill by hand,** at main: Actions → *Greenfield monthly restore drill* → Run workflow on `main` with `dry_run` unticked, or `gh workflow run greenfield-monthly-drill.yml --ref main -f dry_run=false`. A dispatch left at `dry_run` only pins and prints. To drill digests of your own, dispatch the release workflow with `mode: full`. The release workflow runs only on a dispatch and from the monthly drill: never on a pull request or a push. Nothing alarms on a missed drill any more (the freshness workflow was deleted on 26 September 2026).

### 3.0 The five stages, and the order to use them in

Until 21 September the workflow had one mode — the whole gate, all fifteen steps of it — and the
three credentialed runs of that day each stopped at the first error of a class no
offline check can see. One error per run, about an hour of attention each. `stage` makes
the cheap part runnable alone. Each of the first four runs everything the stage before it
runs, plus its own steps, in either mode; `teardown` is not on that ladder and is
described under the table.

| `stage` | what it adds | what it proves | roughly |
| --- | --- | --- | --- |
| `plan` | the identity check, the run's own resources, `terraform init` against this run's own state key, `run.auto.tfvars.json`, `terraform plan` with the same variables the apply uses, and a summary | that the rehearsal root can be **planned** in this account with these variables: every required variable is passed, every provider it needs can be configured, and no `count` depends on a value unknown until apply | a few minutes |
| `create` | `terraform apply`, taking its values from the `run.auto.tfvars.json` the plan stage wrote | that the plan can be **applied**: quotas, service limits, IAM, the order Terraform chooses, and whether a fresh environment comes up at all | the apply, dominated by the Multi-AZ RDS instance |
| `deploy` | the two database entries, `infra/scripts/release-deploy.sh`, `infra/scripts/release-bootstrap-workspace.sh` and the smoke | that a fresh environment can be **migrated and started**: the migration task's networking, whether `fss migrate` accepts the RDS master user, the schema-range refusals both binaries make on startup, and whether a canary datapoint ever appears | the deploy, five one-off tasks of about a minute each |
| `full` (default) | the declared ranges against the deployed images; and in `mode: full` the ops suite, the drill's evidence and the restore drill, the journal replay and Gmail reconstruction, and the release record | in `mode: schema`, that the new schema and both images agree in a real environment; in `mode: full`, the release gate of 16.2, which is everything in the numbered list below | about 45 minutes (`schema`), up to the 180-minute timeout (`full`) |
| `teardown` | nothing, and it takes the plan away: it runs only the steps before `terraform plan` plus the two every stage runs | that a prefix some earlier run left standing is gone | the destroy |

**`teardown` is the stage for an orphan.** It runs the identity check, the record of the
run's own resources, `run.auto.tfvars.json`, `terraform init` against the prefix you name,
and then the two steps every stage runs — `infra/scripts/rehearsal-teardown.sh` and the
production-untouched guard. It does not plan, does not apply, deploys nothing, drills
nothing and writes no record.

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

The recovery of the one orphan that needed a command before its teardown, `fss-rh-202609211659` (21 September 2026), is in [`docs/archive/release-first.md`](../archive/release-first.md).

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
prefix, which removes everything the state does hold. Both halves of this are post-release
work for the workflow (8.0s): a teardown that force-unlocks a lock belonging to its own
run, and a teardown that finds orphans by name prefix.

**Only `full` is the gate.** Only `stage: full` in `mode: full` runs
`infra/scripts/rehearsal-release-record.sh`, and that is the step's own condition
(`if: inputs.stage == 'full' && inputs.mode == 'full'`) rather than a convention: a
`plan`, `create`, `deploy` or `teardown` run, and a `mode: schema` run, cannot write a
release record. Since lane g96 the record section 6 puts comes from the CI gate (4.2); a
rehearsal's record is still accepted. The mode defaults to `schema`, so the
record-writing run is always chosen — by the monthly drill or by you — and never
inherited.

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
6. **`full`**, once the deploy is clean: in `mode: schema` for a schema change, and in
   `mode: full` when you want the restore drill before a release (the monthly drill runs
   it every month).

A stage is worth running only when the one before it passed. Running `full` first is
what the three runs of 21 September did, and it cost about an hour per error. `teardown`
is outside that order: run it when a run left something behind, and never as part of a
release.

Before any of them, run `infra/scripts/check-deployment-role.sh fss-rh-deploy fss-rh`
(`infra-apply-runbook.md` 1.1a). It is read-only, it takes seconds, and it answers the
whole class of error the fourth credentialed run spent an apply on.

**Every stage tears down, and every stage runs the guard, in either mode.** Steps 13
and 14 of the list below keep `if: always()` and carry no stage or mode condition at all. They
are what protects against a stage condition being wrong, so they may not depend on one:
if the apply's condition were ever mistyped, a `plan` run would create an environment,
and the step that destroys it must not be reading the same input. The teardown is
tolerant of a run that created nothing — it reports `destroyed=nothing_created` — so on
a `plan` run it costs seconds. Those two steps are also the whole of what a `teardown`
run does, which is why the stage needed no new step at all.

**A run must never rely on a single one-hour session.** `fss-rh-deploy`'s
`MaxSessionDuration` is 3600 seconds, which is also the default the workflow's
`configure-aws-credentials` step takes, and a `full` run is longer than an hour — so the
job assumes the role three times: at the start, again before item 10's restore drill, and
again, on `always()`, before items 13 and 14. Each renewal is followed by the identity
check of item 2, because a renewal is a fresh assumption. The eleventh full run held one
session, expired at exactly one hour inside the drill, and took the teardown and the
production-prefix guard with it (8.0t).

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
before it run. An item tagged `[full, mode: full]` is skipped by a `mode: schema` run;
everything else runs in both modes:

1. [plan] **Refuse anything that is not a digest.** Two `sha256:` values, and they must differ — one image pushed under both names is a mistake the gate can catch and a person cannot.
2. [plan] **Name the principal.** `infra/scripts/rehearsal-caller-identity.sh fss-rh-deploy` prints `aws sts get-caller-identity --query Arn` and refuses anything that is not `arn:aws:sts::…:assumed-role/fss-rh-deploy/<session>`. Every `terraform` command in this job then runs with `-var="assume_deployment_role=false"`, because this session already *is* the deployment role and the provider must not ask STS to assume the role it already holds (`infra-apply-runbook.md` 1.1). The flag makes the job's own credentials the thing the apply acts as, so this step is what makes it safe; it is the one the teardown repeats.
3. [plan] **Record the run's own resources.** `infra/scripts/rehearsal-prefix-guard.sh <prefix> before` reads, through `rehearsal_read_run_inventory` in `infra/scripts/rehearsal-common.sh`, every resource whose `Name` tag is the run prefix or begins `<prefix>-`, and records the sorted ARNs: nothing, for a fresh run, and the orphan's resources for a `teardown`. Item 14 compares against it. Until lane g97 this step recorded the **production** inventory instead, which was the one rehearsal command that named production on purpose; on the first credentialed run (Actions 35548888865) the rehearsal's own guard refused it — `FAIL: a rehearsal command names a production resource: Key=Name,Values=fss-prod*` — and G12f gave it the one exemption from that refusal. The read names nothing but the run now and goes through the ordinary wrapper, so there is no exemption: every command naming `fss-prod` is refused, and `infra/scripts/rehearsal-prefix-guard.sh <prefix> plan <file>` re-applies the refusal to a printed dry-run plan and requires the read of the run's own resources to be in it, so a rehearsal that would refuse itself is red before a credential is spent.
4. [plan, then create] **Plan, then create.** The variables the root requires are written to `run.auto.tfvars.json` beside the root, the backend is initialised against this run's own state key, and `terraform plan -out` is run with the whole `-var` list. The `create` stage then applies, and names **no variable of its own**: Terraform loads `run.auto.tfvars.json` automatically from the root directory, which is the same mechanism the teardown's `terraform destroy` depends on. One list in one place is what keeps the plan and the apply the same values. The apply creates the rehearsal root with the run prefix and `bootstrap=true`, deploying both digests from the stable `fss-rh-api` and `fss-rh-worker` repositories. **Both services are created at desired count zero.** A fresh environment's database has no schema, and both binaries refuse to start unless the applied schema version is exactly the range they declare — so an apply that started them would create two services crash-looping against an empty database while the task that would fix it had not been launched. The run creates no repository of its own and its teardown removes none; `infra/roots/rehearsal-registry` owns those two and was applied once, before the first push.
5. [deploy] **Fill every secret entry.** Terraform creates every Secrets Manager entry empty and never holds a value. In production you fill these two by hand (5.1); a rehearsal is unattended and an hour long, so it fills its own: `migration-database` takes the RDS-managed master credentials, because on a database that has never been migrated there is no other login role that can run DDL, and `app-runtime-database` takes a password generated in the runner. Both are masked before they can reach a log. This needs `secretsmanager:PutSecretValue` on `fss-rh-*` secrets on `fss-rh-deploy`, which it has held since the second credentialed run (8.0a, 8.0b).
6. [deploy] **Migrate, then deploy the worker, then the API.** `infra/scripts/release-deploy.sh infra/roots/rehearsal <prefix> --schema-change` — the *same script* you run locally for production (section 4.1). It refuses unless both services are at zero — on a fresh stack the apply created them there, and on a stack that already stood the create step ran `release-stop.sh` before the apply (lane g70) — then runs `fss migrate` as a one-off ECS task inside the VPC, then `fss admin database-users ensure`, then `fss verify`, then the worker to its declared count, then the API, then `fss verify` again against the running deployment. Never beside each other: the API's declared schema range needs the migration to have run. Until 21 September nothing in deployment ran a migration at all; the step was named for an order it did not perform.

    [deploy] **Then the first workspace and its admin**, as its own step between this one and item 7: `infra/scripts/release-bootstrap-workspace.sh infra/roots/rehearsal <prefix> --worker-digest D --slug rehearsal --display-name Rehearsal --admin-email rehearsal-admin@usecallie.com`. A migrated database has no `workspaces` row, and the scheduler's canary is inserted once per workspace — so an environment without one publishes no `CanaryCompletionAgeSeconds`, the `canary_stale` alarm breaches, and item 8's smoke has nothing to judge. That is exactly how the eighth full run failed (8.0p). It is the same script production runs, with `--environment production` (5.1a) and different values.
7. [full] **The declared ranges, against the deployed images** (`infra/scripts/rehearsal-schema-ranges.sh <prefix> --api-digest D --worker-digest D`): Appendix G 22's refusal cases, which only a real ECS task can answer. Each service image is launched as a one-off `--selftest` task through the same wrapper the deploy uses, with a declared schema range one below the one it was built with, and the *container* must refuse it — exit 12, `configurationInvalid` in both `API_EXIT_CODES` and `WORKER_EXIT_CODES`. The overlap case, the previous release's image against the current schema, runs **only when a `<prefix>-<service>-previous` task definition is actually registered**: nothing in this repository registers one and a first release has no previous image at all, so the report says `skipped_no_previous` rather than claiming a pass (8.0o).
8. [deploy] **Smoke** with the same `scripts/productionSmoke.mjs` production gets.
9. [full, mode: full] **Release suite (recorded mode, runner)**: the ops suite (`npm run test:ops`), in the runner. The mutation check was deleted on 26 September 2026. It does **not** touch the rehearsal database and could not: it is private — `publicly_accessible = false`, no NAT gateway, no bastion — so the step that used to assemble a URL from the rehearsal's outputs could never have connected. What runs against the rehearsal database is `fss verify` and `fss drill`, inside the VPC.
    [full, mode: full] **Before it, the evidence the drill has to reconstruct** (lane g40), as its own step between item 6's bootstrap and item 7: `infra/scripts/release-seed-drill-evidence.sh infra/roots/rehearsal <prefix> --worker-digest D --phase before --workspace-slug rehearsal`. `docs/greenfield/restore-drill.md` 0.1 needs an accepted send, a prospect reply, a prospect-originated opt-out, a salesperson's own manual suppression inside its ten-minute window and an ordinary CRM edit to exist *before* the restore target is read, and nothing in this repository could produce any of them in a deployed environment — so the drill's own refusal fired on every fresh rehearsal, which is how the ninth full run ended (8.0q). `fss admin drill seed-evidence` produces all five through the domain's own entry points. The drill then adds `--phase after` between the baseline and the restore, so the restore genuinely loses work, and waits for RDS to report a `LatestRestorableTime` past the evidence before reading the target at all. **Production is never seeded**: the script refuses any prefix that is not `fss-rh-<run>` and the command refuses unless `FSS_DEPENDENCIES=recorded`.
10. [full, mode: full] **Restore drill**, Appendix E steps 1 to 9, preceded by a session renewal and its identity check. The runner keeps the control plane (reading the latest restorable point, the restore itself, the wait, the teardown); two in-VPC tasks do the database work — `fss admin counts` for the baseline on the source, then one `fss drill` against the restored instance for steps 1 to 9, with one correlated log and per-step JSON. The runner reads the report and decides whether it is a pass, so a change to the tool cannot quietly relax the gate. It refuses to report a pass unless the baseline contained an accepted send, a reply, a suppression, a CRM edit and a migration — a drill against an empty database proves nothing. The drill task is fixed at `FSS_DEPENDENCIES=recorded` **in its task definition**, because `reconcile-sent`, `recover` and `watch-renew` all reach Gmail when it is live and a mode a caller passes is a mode a caller can forget. The restored instance reaches the drill task only as the `FSS_DATABASE_HOST` override. `--database-host` stays the primary host the task definition names, which is what the run-task wrapper checks the definition against (lane g48). Run 35962272085 (24 September) passed the restored endpoint as both, and the wrapper refused the drill's first task after a restore that had succeeded. That first item of the deferred drill work is fixed in code. Run 35976297919 (24 September) proved it and showed where the drill stops next. The task started against the restored instance and stopped at its first write, a step-0 baseline file in `/tmp/fss-drill`, which nothing in the container created. The baseline the runner measured on the source was not handed to the drill task either (8.0w). Lane g53 fixes both in code: the drill creates its reports directory before its first write, and the runner hands the drill task the source baseline as `--baseline-json`, one line holding the `asOf` instant and the five counts, instead of `--as-of`. Run 36062337914 (24 September, 22:45Z) passed step 0 and stopped at step 1, because nothing anywhere opened a restore hold (8.0aa). Lane g56 closes that. The runner refuses a baseline without `systemGeneration` before the restore. It launches the drill with `--expected-generation` set to that value plus one, so step 1a runs the worker's own generation check against the restored copy. After step 9, `step9-generation-reconciled` asserts the database landed on that pin. After the drill, the runner reads the mismatch line in the drill's log and a transition to ALARM in the history of `<prefix>-restore-generation-mismatch`. Lane g59 gives steps 1 to 9 the evidence they have to find (`restore-drill.md` 0.1). The evidence comes in three phases: `before`, the release step, which now also makes a late opt-out's firm, a phone route and an administrative pause; `in-flight`, just before the target, one send left `reconciling` for step 3; and `after`, once the restore has been requested, a late opt-out the restore loses, for steps 2 and 4. The runner then counts the source again and hands the drill those counts as `--at-failure-json` for step 8, the three phases' recorded mailboxes merged as `--mailbox-recording-json`, and the seed's admin as `--admin-user` for step 9. In recorded mode a task that carries `FSS_ENVELOPE_KEY_ID` wraps refresh tokens through KMS under the context `fss_envelope_seam = recorded`, and outside production the drill role may decrypt under that context and no other. Lane g60 gives the dial probe its subject. The `before` phase registers the rehearsal admin's calling number and attests it through the domain, the same path a salesperson takes on the Settings screen. Step 1 now also requires `restore_in_progress` among the holds that apply to the refused dial, in the drill and in the runner's verdict. A rehearsal's probe is otherwise refused `posture_missing` whether or not a restore is in progress (8.0ab). The drill prints its whole report even when it fails. A database with no attested number still gets `step1-dial-refused` unanswered, and the runner fails the run on it (item 12 of 8.1 as it stood on 25 September, in `docs/archive/release-records.md`). Lane g73 closes Appendix E.3's missing fences (8.0ah). Step 3 also lists every Sent folder and tombstones each FSS send whose fence the restore lost. The `after` phase sends a step the `before` phase enrolled so that there is one. The runner requires `step3-missing-fence-tombstoned` and `step5-no-second-send`.
11. [full, mode: full] **Suppression journal replay and Gmail reconstruction**, against the recorded fake (no real mailbox in rehearsal unless you provide a rehearsal Google project). The second replay must insert nothing; no send may repeat. The drill above already ran both; this step reads the reports it left, which the drill wrote out of the captured task report under the names they have always had.
12. **Carry watermark**: gone. The carry tool, its step and the record's `carryDrill` field were deleted on 26 September 2026; the old app's data tables were destroyed on 17 September 2026, so there is nothing to carry. The number is kept so that 13, 14 and 15 keep theirs.
13. [every stage] **Tear down**, always, with bypass-governance — and tolerantly, on a session renewed immediately before it so that a run which has already outlived its first hour can still destroy what it made. The teardown is five steps (any one-off task still running, the restored instance, any manual snapshot carrying the run prefix, the object-locked journal objects, the root), and each treats the AWS error code for absence as "already done" rather than as a failure, because `if: always()` means it runs after a creation that never happened. A failure that is *not* an absence — an `AccessDenied`, a throttle — still stops it, and an unreadable state that is not "the root was never initialised" still stops it. The report says which: `destroyed=true`, or `destroyed=nothing_created`. `terraform destroy` requires every variable `apply` did, so the step that opens item 4 writes them to `run.auto.tfvars.json` beside the rehearsal root (identifiers only, ignored by `infra/.gitignore`) and the teardown refuses to destroy without that file rather than fail on a missing variable and leave the environment standing. To tear a run down by hand from a fresh checkout, recreate the file first: `name_prefix`, `api_image` and `worker_image` (`<repository>@<digest>`, from the release record or the run's inputs), `certificate_arn`, `api_hostname`, `assume_deployment_role: false`, `bootstrap: true`, and the two schema ranges read from `packages/domain/db/schemaRange.ts`; then run `rehearsal-teardown.sh <prefix>` from the root directory as the `fss-rh-deploy` session.
14. [every stage] **Assert nothing with the production prefix was touched**, always, in either mode, including on a run that created nothing. The guard classifies every name it sees: the run's own resources, the two stable rehearsal repositories that carry no run, and anything production's — which it refuses. It then checks that the state it lists names nothing production's and that the session is an `fss-rh-` role, and compares **the resources carrying this run's own prefix** against what item 3 recorded before creation: every durable one the run created must be gone after the teardown. A state it cannot list is reported as "the run created nothing" rather than swallowed, and the comparison still runs. A record made only by a dry run is refused rather than compared: the workflow records the sentinel `["dry-run: no inventory was read"]` when it validates the prefix, and comparing against that would be a pass nobody earned. **Why it no longer compares production (lane g97, 25 September 2026).** Until g97 this step diffed the production inventory recorded before the run against the one read after it. The diff was of a thing that moves for reasons of its own: it had already been taught that ECS forgets a stopped task (run 35962272085, 8.0v) and that a replaced task takes its network interface with it (run 36032732128), and on the night of 25 September it failed a rehearsal only because the operator applied production while the rehearsal ran. A comparison that fails whenever production is legitimately changed measures the operator, not the rehearsal, so it is dropped; the comparison is of the run's own resources, and that nothing production's was touched rests on what made it true before as well — no rehearsal command names production (checked on the printed plan, and refused at the call), the session is `fss-rh-deploy`, and that role's policy is scoped to `fss-rh-*`. **What the comparison sets aside**, by parsed service and resource type, is what AWS keeps listing after it accepted a deletion: every `ecs` ARN (a stopped task for about an hour, a deleted service or cluster while INACTIVE, a deregistered task-definition revision for good), EC2 ARNs whose resource part begins `network-interface/` (a Fargate task's interface goes with its task), EC2 `security-group/` and `security-group-rule/` ARNs (run 36209569741 of 26 September 2026 found a deleted group and eight rules still listed; a group that really stayed would keep the run's VPC, which is compared), `kms` keys (a key is only scheduled for deletion), and RDS `auto-backup:` ARNs (a deleted production database keeps its automated backups). The guard logs each class it set aside. The database and its snapshots, automated ones included, the buckets, the load balancer, the log groups, the alarms, the secrets, the VPC and the subnets are compared. Rehearsal databases delete their automated backups on teardown (`database_delete_automated_backups = true` in `infra/roots/rehearsal`; production keeps them): until 26 September each deleted rehearsal database left a retained 20 GB automated backup, and run 36209569741's guard failed on its snapshot `rds:<prefix>-pg-<date>`. A leftover is read again up to five times a minute apart before it is called one, because the tagging API lags a deletion. Its dry mode is `FSS_REHEARSAL_DRY_RUN=1`, run locally without a credential.
15. [full, mode: full] **Write the release record**, last, and the manifest beside it. It names the two digests, the desktop stamp, and a `releaseGateReference`. It is `release-record.json` in the run's `rehearsal-reports-<prefix>` artifact. Since lane g96 it is not the record a release puts: that comes from the CI gate (4.2). `fss admin release-record put` still accepts a rehearsal record, and it binds the same way.

If any step fails, steps 13 and 14 still run and no record is written. That is the design: there is no such thing as a partially passed release gate — and it is why a `plan`, `create` or `deploy` run, and a `mode: schema` run, writes no record either. A stage that stopped early and a stage that was never asked to go that far look the same to section 6, which is the correct answer to both.

### 3.1 Watching it without credentials

The release workflow has no credential-free job on pull requests any more (its dry-run job was deleted on 26 September 2026). Print the plan — every `terraform` and `aws` invocation the rehearsal would make, in order — locally, with no credential present, and read it before you run the real thing:

```bash
FSS_REHEARSAL_DRY_RUN=1 FSS_REHEARSAL_REPORTS=/tmp/fss-rehearsal \
  infra/scripts/rehearsal-restore-drill.sh fss-rh-dryrun
```

---

## 4. Production apply — David

**An app-only change is not applied here: CI deploys it (4.0).** This section is the manual path, for a schema or an infrastructure change.

Follow `docs/greenfield/infra-apply-runbook.md` section 3.2 for the plan and apply.

**You pass no `assume_deployment_role` here.** It defaults to `true` in every root, which is what a person running a local apply wants: the provider assumes `fss-prod-deploy` for you. The flag is for a session that has already assumed its role — the two rehearsal workflows, and nothing else (`infra-apply-runbook.md` 1.1).

**Applying production while a rehearsal runs no longer fails the rehearsal (lane g97).** Until 25 September every rehearsal recorded the production inventory before it started and compared it when it finished, so a production apply or deploy in between failed its final guard — which is what tripped the seventh run's (8.0s) and a run on the night of 25 September. The guard now compares only the resources carrying the rehearsal's own run prefix (3, item 14). Watch Actions anyway: a production apply and a rehearsal share the account's quotas, and a rehearsal cancelled to make room leaves what 3.0 describes.

**Read the ECR lines first.** The production registry was bootstrapped by a targeted apply at commit 71d84e00, and `create_registry` has since given that module a `count`. The first plan after this change must show `fss-prod-api` and `fss-prod-worker` as **moved** — `module.stack.module.registry.…` *has moved to* `module.stack.module.registry[0].…` — and then report no changes to them. **A plan that proposes to destroy or replace an ECR repository is not to be applied.** It would delete the images every release record identifies, and the digests in section 6 step 2 would stop resolving. The `moved` block in `infra/modules/stack` is what makes this a state migration; if it is ever removed, this is the failure.

Three things belong to the release rather than to the infrastructure:

**The digests.** For a schema release, `api_image` and `worker_image` are the release's digests from section 2, not the tags. For an infrastructure change they are the digests production runs, which `infra/scripts/deploy.sh current fss-prod` prints — never the ones in the last plan anybody applied, because CI has moved them since (4.0, the drift rule).

**The schema ranges.** Read them from the source rather than typing them:

```bash
node --experimental-transform-types --disable-warning=ExperimentalWarning --input-type=module -e "
  const m = await import('./packages/domain/db/schemaRange.ts');
  console.log('api', m.API_SCHEMA_RANGE, 'worker', m.WORKER_SCHEMA_RANGE);
"
```

and pass them as `api_schema_range` and `worker_schema_range`. A task definition that declares a range the image does not accept is a stale deployment and both binaries refuse to start rather than guess.

**The root variables this release needs.** Beyond the digests and the ranges:

| Root variable | Production value | Why it is here |
|---|---|---|
| `google_hosted_domain` | `usecallie.com` (the default) | 5.1 and 12.1. A public identifier, so it belongs in a plan an operator reads, not inside a secret. An empty one is refused by variable validation, because an empty `hd` restriction admits every Google account there is. |
| `gmail_push_topic`, `gmail_push_service_account` | the defaults, which are production's topic and push identity | Public identifiers `infra/roots/production-google` outputs (8.0ar). The root validates both to the production names, and has no `gcp_project_id`. |
| `certificate_arn`, `api_hostname`, `alert_emails`, `sending_enabled` | not variables: committed in the `locals` of `infra/roots/production/main.tf` (26 September 2026) | The listener's certificate, `api.usecallie.com`, `["callie@usecallie.com"]` and `true`, read from running production. **Pass none of them**: `-var="certificate_arn=…"` is now an "undeclared variable" error. A change to one is a pull request and a read plan. |

**The deployment environment variables this release adds.** Both task definitions need them, and all five are Terraform's — there is nothing to type at apply time unless you are changing one:

| Variable | Production value | Root variable |
|---|---|---|
| `FSS_DEPENDENCIES` | `live` | `dependencies_mode`, default `live` |
| `FSS_RESEARCH_PROVIDERS` | `none` (worker only); the worker ignores it since research was deleted (26 September 2026), and a later infrastructure release removes it | `research_providers`, default `none` |
| `FSS_SENDING_ENABLED` | `true` since section 6 ran | `sending_enabled`, a committed literal in the root, not a variable |
| `FSS_GMAIL_PUSH_TOPIC` | the Pub/Sub topic id | `gmail_push_topic`, whose default is production's (8.0ar; the rehearsal passes a placeholder) |
| `FSS_GOOGLE_HOSTED_DOMAIN` | `usecallie.com` | `google_hosted_domain` |

Until G12c none of the first three could be set at all: `extra_environment` existed on the stack module and no root exposed it, so an apply produced two services whose tasks exit at startup naming a variable no plan could set. `docs/archive/decisions/g12c-the-deployment-flags-are-root-variables.md`.

`FSS_DEPENDENCIES` has no default **in the binary**: an unset one is a refusal to start, which is deliberate (`docs/archive/decisions/g12-the-credentialed-bootstrap.md`); the root's default is what makes sure it is never unset. `dependencies_mode` refuses `none` outright and accepts `recorded`, which the binaries then refuse in a production environment — the rule lives in one place rather than two that can disagree. `FSS_RESEARCH_PROVIDERS=none` is left over from the deleted research feature and read by nothing. The last two need nothing from you; they are listed so that a startup line reporting `hosted_domain_source: "secret"` reads as "the apply has not landed yet" rather than as a mystery.

There is also `extra_environment` (`map(string)`, empty) on both roots, for whatever the next release needs before it earns a variable of its own. Never a credential: secrets reach a container only as a Secrets Manager reference, and the root test asserts no environment name looks like one.

**What the API refuses to start without.** A live API now builds Google sign-in or exits with `api_deployment_refused`. The parts are the `google-oidc-client` secret, `FSS_PUBLIC_ORIGIN` (the redirect is `https://api.usecallie.com/auth/google/callback`, derived rather than configured twice), `FSS_GOOGLE_HOSTED_DOMAIN`, and `session-signing-key`. `--selftest` prints `sign_in`, `sign_in_client_configured`, `sign_in_redirect_configured`, `sign_in_hosted_domain_configured` and `session_signing_key_configured` — names and booleans, never a value. Before G12b the API started without any of it and refused every command; see `docs/archive/decisions/g12b-sign-in-is-configured-or-the-api-refuses.md`.

**A desktop release is not a reason for this section.** Since 8.0aj the API admits every 1.x desktop from its minimum up, so publishing a desktop build needs no apply and no deployment, unless 2.0 says the API goes first. Confirm the published range with `curl -fsS https://api.usecallie.com/auth/client-version`. After 8.0aj it reads `"supported":{"minimum":"1.0.0","maximum":"1.999.999"}`.

### 4.0 App-only changes deploy themselves, and the two manual paths (lane g91)

David's decision of 25 September 2026: *"I'm a startup, I want to move fast."* When *Greenfield images* publishes the images of a push to main, *Greenfield deploy* (`.github/workflows/greenfield-deploy.yml`) deploys them to production as `fss-prod-ci-deploy`, the role `infra/roots/production/ci_deploy.tf` declares. It trusts one OIDC subject, this repository's `production-deploy` environment, and holds no state, secret, database or IAM write.

```
gates (no credential): images run → gate green, on main → deploy (credential): guard → download → check → record: gate again → put → promote → worker → API → read-back (`existing`) → canary age → smoke (images commit, no credential) → one line
```

Four jobs since P6 (27 September 2026): `gates`, `deploy`, `smoke` and `summary`, in 400 lines. Every step that reads or writes production is `infra/scripts/deploy.sh ci <subcommand>` (the old name `ci-deploy-app.sh` still execs it until the helpers move).

- **gates** holds no credential. It checks that the images run is a green publish of a push to main of this repository, and takes its commit and attempt from it. Then it checks out only `infra/scripts/` at that commit and runs `deploy.sh ci gates --commit <commit> --wait-minutes 30` (lane A1), which asks the GitHub API two things:
  - the *Greenfield gate* has a run of the push to main at that commit, found by its workflow file `.github/workflows/greenfield.yml` and never by its display name, and the newest such run is `completed`/`success`. GitHub reports a run as its latest attempt, so a re-run still going is waited for and a re-run that failed is red;
  - the commit is still on main: `GET /repos/{owner}/{repo}/compare/main...<commit>` answers `behind` or `identical`, so a commit force-pushed off main is never deployed.

  It waits up to thirty minutes for a gate that is still running or has not started. Then, or at once for a red gate or a commit no longer on main, it answers `manual` with the reason: a green run, a notice, nothing touched, no role assumed. Its answer only decides whether the deploy job starts: `record` reads the gate again, after the guard, immediately before each of its puts, and fails the run red, writing nothing, when the answer has changed.
- **One job holds a credential, and it runs no code from the images commit before its guard.** It checks out the images commit exactly, never main's tip, and after the guard runs only `infra/scripts/` and no Node. The smoke runs from the images commit in its own job without a credential and is handed the canary age as a scalar.
- **The guard** is the workflow's own inline code and runs before any of the repository's. It reads the commit production's images were built from: the `ci-<commit>` tag the promotion gave each running digest in `fss-prod-*`, or the bare commit an operator's own push was tagged with. Then it lists what every commit between that commit and the images commit touched. It reads commit by commit, so a change that was later reverted still counts. Rename detection is off, so a moved file counts at both its paths, and a merge is judged against its first parent. It answers `manual` — a notice and a list of paths in the summary, a green run, nothing touched — when any of these paths appears:
  - `infra/**`, every script in `infra/scripts/` included;
  - a migration;
  - the schema acceptance rule and the migration runner, with what they read: `packages/domain/db/schemaRange.ts`, `migrationRunner.ts` and `queryable.ts` (lane A1). `check` compares the declared ranges, so a change to how a version is accepted would otherwise pass it unseen;
  - `scripts/productionSmoke.mjs` or another release script;
  - `.github/**`;
  - a path the list does not know.

  It also answers `manual` when a running image has no commit tag, or when production's commit is not behind the images commit. It passes when every commit's paths are application code. Only then does anything from the checkout run, and that is `infra/scripts/`, which the guard has just shown is unchanged since production's own commit.
- **download** (`deploy.sh ci download`) fetches the images run's `fss-image-digests` artifact, found through the run, uploaded by that run of that commit on main, unexpired, held to the digest GitHub recorded for it, and holding `image-digests.json` alone. The file carries the two digests and, since P6, the schema range each image declares (`images.sh record --api-range … --worker-range …`, the ranges the images run verified each image's `--selftest` against). No job runs code from the images commit to read the ranges any more. An artifact from before P6 names no range, and `check` refuses it: release that commit by hand.
- **check** (`deploy.sh ci check`) reads and writes nothing. It answers `manual` in two cases:
  - the images declare a schema range the running task definitions do not, or `/health` reports a database version the images do not accept;
  - a service is not running exactly its declared count with nothing pending: desired zero is a schema release, and running short is an outage.

  It fails, touching nothing, in these cases:
  - the session is not one of `fss-prod-ci-deploy` in account `326255650484`, or the region is not `us-east-1`;
  - the cluster is not tagged `production`, or a service's one deployment is not `COMPLETED`;
  - the digests file is not the images run's own (commit, run id and attempt), or names no schema ranges;
  - either digest differs from the one `fss-rh-<image>:ci-<commit>` names;
  - `/health` does not answer.
- **The release record, before the rollout** (26 September 2026). The worker admits a send only while a stored record names its own digest, so the deploy job's first write, after `check` decided `deploy`, is `deploy.sh ci record --before-rollout`. It repeats every read and guard of `check`, reads the gate again (waiting for nothing), and builds the ci-gate record with `record.sh from-ci`, without `--enables-sending`. It puts the record with `fss admin release-record put --json-base64` on the operations task, reading the task's answer back from its log. The operations definition is Terraform's and carries the worker image of the last apply, so the put runs that image, and the record it stores names this deploy's digests. When it fails the run is red and nothing was promoted or deployed. A record stored for a rollout that then fails is inert: no running process has its digests.
- **deploy** runs `images.sh promote image-digests.json`, then `deploy.sh ci deploy`, which repeats every read and guard first. It registers the next revision of each service's running task definition with only the image digest changed, describes it back and compares it with the running one field by field. Anything but the image different, and it deregisters the revision before any service names it. It then points the service at the revision: the worker first, waited on until ECS calls its one deployment `COMPLETED` with the declared count running and nothing pending, and held to its digest on every running task, read with `list-tasks` and `describe-tasks`; only then the API. The circuit breaker stays on. When ECS rolls a revision back, the deploy fails, nothing after it is touched, and the rolled-back revision is deregistered, so the newest ACTIVE revision is again the one that runs. The run prints the stopped tasks' stop and exit codes, and only the `event`, `reason` and `code` fields of their structured log lines, never a raw line. It never changes a count.
- **The read-back**, in the same job after the rollout, on a fresh session of the role: `deploy.sh ci record --after-rollout` refuses unless both services run exactly the two digests, reads the gate again, builds the same record from the same gate run, puts it again and requires `existing`. It is a separate operation from the put before the rollout; the put is never moved after the rollout. Then `deploy.sh ci canary` reads the newest `CanaryCompletionAgeSeconds` for the smoke.
- **smoke** is `scripts/productionSmoke.mjs` at the images commit, with that canary age, expecting the sending state the task definition carries.

**What this lane accepts.** A job holding the role can register a revision of `fss-prod-api` or `fss-prod-worker` with any image in their two repositories and roll it out. IAM has no condition on a task definition's contents, and a main-branch workflow can deploy whatever main contains; that is the price of continuous deployment, and the script narrows it by deriving every revision from the running one. The limits are the `production-deploy` environment restricted to main, no `id-token` in a job that runs images-commit code, the exact OIDC subject, ECR writes only to the two `fss-prod` repositories, and unchanged task roles, because `iam:PassRole` names only the two services' existing four. `UpdateService` needs a task definition of the service's own family, so a bare `--desired-count 0` is refused; IAM cannot also forbid a count on a call that names one, and the script never sends one.

**Provenance, without a clock (P6, 27 September 2026).** A deploy runs only images whose digests came from the images run's own artifact and which `fss-rh-<image>:ci-<commit>` names. What makes that the image the run built: the rehearsal repositories are IMMUTABLE, so a tag names the first image pushed under it; the images run refuses a `ci-<commit>` tag that already exists on its first attempt (only a re-run of the same run may reuse its own push); it verifies the image it pulls back by digest; and the artifact is bound to the run and held to its recorded digest. There is no ECR repository policy. What limits who can push `fss-rh-*` is the namespace of the rehearsal deploy role, `fss-rh-deploy`: the images run's publish job, the rehearsal workflows and an operator session that assumes it. Until P6 the deploy also required the tag's `imagePushedAt` to fall inside the images run's `created_at`–`updated_at`; that compared two services' clocks and failed a re-run, and it was dropped.

**Merges and rehearsals.** Deploys share one concurrency group (`fss-production-deploy`) and a running one always finishes; a waiting run replaced by a newer one is covered by the newer one's range. A rehearsal running at the same time does not matter: its guard compares only its own run's resources (lane g97), so the shared group and the rehearsal polls were deleted on 26 September 2026. The job allows 170 minutes: the worst rollouts of three ten-minute waits per service, plus up to twenty for each put. The first credential lasts two hours (the role's maximum), and the read-back assumes the role again for one more. A failed run's summary names the revisions each service had before and, for the service that failed, the one it names now. `aws ecs update-service --cluster fss-prod-cluster --service fss-prod-<api|worker> --task-definition <previous>` puts one back.

**After a protected change, the next release is by hand.** A protected change in the range keeps answering `manual` until production runs images built after it. An infrastructure-only merge builds no images. So the rule is: apply the infrastructure change by the manual path, then release the first app merge after it by hand — `images.sh promote image-digests.json` with the admin profile, and the rolling path of 4.1. Production's commit tag is then past the change, and the next app merge deploys itself again. There is no switch that tells CI a change was applied.

**CI puts the release record, and sending stays on (lane g100).** Once section 6 has run, the worker holds every send unless a stored record names its image. The deploy job puts one for every worker it deploys, before the rollout starts it. Under the process form of the attestation (6, step 5: `ci-gate:main`), that record is all the new worker needs, and nobody attests again. Under an attestation that names one reference, a new worker still holds until the owner attests to its record.

**When the record is not put.** `record.sh from-ci` may refuse, or the put may be refused. The put is the deploy job's first write, so the run goes red with *the release record … was NOT put before the rollout, so nothing was promoted or deployed*. Once the cause is gone, re-run the deploy job. The put is idempotent: the same gate run builds the same record, and a second put answers `existing`.

**When the read-back fails.** A gate may have been re-run red since the deploy, the commit may have left main, production may not run the two digests, or the put may have had to create the record. The record was stored before the rollout, so sending does not hold. The deploy job goes red and the smoke does not run; the summary names the record and what the read-back found. Read the stored record with `fss admin release-record show --reference <reference>` (6, step 2), then run the smoke by hand (6, step 1), or re-run the deploy job, which is idempotent: the record puts answer `existing` and the rollout finds the digests already running. To put the record by hand, as the admin profile, build it with the 4.2 commands for the deployed commit and run `record.sh read-back … --allow-created` (4.2). That runs on the operations definition as it is.

**The role's grant for the put.** `ecs:RunTask` on `fss-prod-operations:*`, conditioned on `ecs:cluster` being the production cluster. `ecs:TagResource` on the production cluster's tasks, only under `ecs:CreateAction = RunTask`, because the wrapper propagates the definition's tags onto the task. Nothing else is new. The operations task runs as the worker's task and execution roles, which `iam:PassRole` already names. It logs to `/fss/fss-prod/worker` under the prefix `operations`, which the log read already covers, and `ecs:DescribeTasks` was already there. IAM cannot condition a task's command, so a job holding the role could run any `fss` command on that task, as the worker's task role. It could already reach that identity by rolling a worker revision.

**Terraform and CI share the two service task definitions.** Both carry `track_latest = true` (`infra/modules/cluster`), so Terraform reads the family's newest ACTIVE revision — CI's — as its own, and the services still re-point on an apply that registers a revision. The migration, operations and drill definitions do not track: they are Terraform's, and carry the worker image of the last apply until the next one.

**The drift rule: every production plan starts from what production runs, and every apply checks it again.**

```bash
infra/scripts/deploy.sh current fss-prod      # api_image=… worker_image=… and the two schema ranges
(cd infra/roots/production && terraform plan -out=production.tfplan \
   $(../../scripts/deploy.sh current fss-prod --var-flags))   # plus -var="expected_system_generation=<N>" while one is pinned
# immediately before the apply, with the two images the plan was made with:
infra/scripts/deploy.sh current fss-prod --compare "<api_image>" "<worker_image>" \
  && (cd infra/roots/production && terraform apply production.tfplan)
```

`deploy.sh current` (the old name `deployed-digests.sh` execs it) refuses in three cases:
- a service's rollout is not finished: it must have one `PRIMARY` deployment that ECS calls `COMPLETED`, its declared count running and nothing pending, and every running task of that deployment's revision reporting its image digest (lane A1). A lone deployment is not enough, because ECS reports one `IN_PROGRESS` with nothing running yet. A service stopped for a schema release (desired zero) runs no task, and prints its revision's image;
- a family's newest ACTIVE revision is not the one its service runs, which Terraform would otherwise read. Deregister the stray revision it names first;
- with `--compare`, either image differs from the one running. A CI deploy has landed since the plan; plan again. A schema release plans with its own new images on purpose and passes `--allow-digest-change`.

The two manual paths:

1. **An infrastructure change.** Plan with exactly those four values. The plan shows no change to `aws_ecs_task_definition.api` or `.worker` or to either service. The exception is a change to a task definition, where it registers the next revision from the running images and re-points the service. **A plan that replaces either definition with an image other than the one `deploy.sh current` printed rolls production back: do not apply it.** After the apply, `deploy.sh release infra/roots/production fss-prod --api-digest <deployed> --worker-digest <deployed>` holds the running tasks to those digests. Then release the next app merge by hand, as above.
2. **A schema change.** The release's digests and ranges, `stop.sh` before the apply, and `deploy.sh release --schema-change` after it (4.1). Pass `--compare … --allow-digest-change` before the apply. CI refuses to deploy while the services are stopped or the images' range differs from production's, so it cannot race a migration.

**Set up once** (the operator, 25 September):
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

### 4.1 The order inside the apply, and the one command that performs it

```
[schema change: stop.sh]  →  terraform apply  →  all eight entries filled  →  fss migrate  →  database users  →  fss verify  →  worker  →  API  →  fss verify
```

**Every entry first.** Terraform creates the eight Secrets Manager entries empty, and an
ECS task whose `secrets` block names an entry with no value does not start at all —
`ResourceInitializationError … can't find the specified secret value for staging label:
AWSCURRENT`, before the container exists (run 35891175510, 23 September 2026, at `fss
verify`). Every task definition but the migration's names all eight, so section 5.1's
six values go in **before** this command, not after it; the two database entries too.
The rehearsal fills all eight in its own step, six of them with fixtures. The `pg_trgm`
extension needs no step of its own: migration 0005 creates it, and it is a trusted
extension the migration role may create.

**A schema change stops the services before the apply (lane g70).** From migration 0006 every declared range is a strict `{N,N}`, so the task definitions a schema-change apply registers refuse the schema the database is still at: both binaries exit 12 at startup. An apply against running services repoints them at those definitions and ECS starts replacing working tasks with ones that refuse, before anything has migrated. That is what the 04:41Z deploy of schema 16 did on 25 September (8.0af). So a schema-change release on a standing environment is three commands, in this order:

```bash
# 1. Stop both services: the API, then the worker. Each is waited on and read back at zero.
infra/scripts/stop.sh infra/roots/production fss-prod --environment production

# 2. The apply, from the plan you read (infra-apply-runbook.md 3.2). It replaces the task
#    definitions and starts nothing: both services ignore changes to their count.
(cd infra/roots/production && terraform apply production.tfplan)

# 3. Migrate, verify and start: the command below, with --schema-change.
```

`stop.sh` (the old name `release-stop.sh` execs it) asks for `--environment production` because it takes production down on purpose, the same extra word `deploy.sh bootstrap` asks for, and it refuses a root that is not the prefix's, a cluster in another account, region or namespace, and a cluster tagged as the other environment. Run twice, it does nothing the second time. Plan before the stop and apply after it: the plan does not depend on the counts, and the outage starts at step 1, so keep steps 1 to 3 together. A first apply (`bootstrap=true`) needs no stop, because it creates both services at zero.

**An app-only release is CI's (4.0).** By hand — only when that workflow cannot run — it is the rolling path (8.0am). Store the release record first with `record.sh put` (4.2). Then run `images.sh promote image-digests.json`, no stop, the apply with the release's digests, and `deploy.sh release … --release-record <file>` without `--schema-change`:

```
record.sh put  →  terraform apply  →  worker count  →  API count  →  one wait  →  running-digest check  →  the record read back (existing)
```

**You do not type the steps after the apply.** They are one script, and it is the same script CI runs for the rehearsal — the only differences are the root in argument one and the credentials in your shell:

```bash
export AWS_PROFILE=<the profile that can assume fss-prod-deploy>
export FSS_REHEARSAL_REPORTS="$HOME/fss-release-$(date -u +%Y%m%d%H%M)"

infra/scripts/deploy.sh release infra/roots/production fss-prod \
  --schema-change \
  --api-digest "$API_DIGEST" \
  --worker-digest "$WORKER_DIGEST"
```

Read both first, locally and without a credential:

```bash
FSS_REHEARSAL_DRY_RUN=1 FSS_REHEARSAL_REPORTS=/tmp/fss-plan \
  infra/scripts/stop.sh infra/roots/production fss-prod --environment production
FSS_REHEARSAL_DRY_RUN=1 FSS_REHEARSAL_REPORTS=/tmp/fss-plan \
  infra/scripts/deploy.sh release infra/roots/production fss-prod \
    --schema-change --api-digest "$API_DIGEST" --worker-digest "$WORKER_DIGEST"
```

Why a script rather than four commands you can see:

- **The migration is a one-off ECS task, not something you can run.** The production database is private: `publicly_accessible = false`, no NAT gateway, no bastion. Nothing on your Mac has a route to it and nothing should. The only thing already inside the VPC that can reach PostgreSQL is the worker image, so `fss migrate` runs as a task using it, under a task role that exists for nothing else.
- **Every launch is checked before it is made.** `infra/scripts/lib.sh` refuses a bare cluster name, a wrong account, a wrong region, a cluster tagged as the other environment, a task definition whose image is not the digest this release is about, a network configuration that is not the root's own public subnets under the worker security group, and a task definition resolving a credential entry this release did not name. Afterwards it reads the `failures` array, refuses a task that never started, refuses a stopped task with no exit code (which is not a zero), prints `stopCode` and `stoppedReason`, waits out the log-stream race, and records the task ARN so a retry waits on the task that is already running rather than starting a second migration.
- **The declared counts come from the plan.** The script scales the services to `terraform output deployment_plan`'s `declared_desired_count`, not to a number in a shell file that somebody has to keep in step with the root. Terraform sets a count only when it creates a service. After that both services ignore changes to `desired_count`, so an apply never moves one, and steps 5 and 6 of every deploy, rolling or schema, set the declared numbers explicitly.

`--schema-change` is the flag that makes it refuse unless both services are already at desired, running and pending zero. It no longer stops them itself: by the time it runs, the apply has registered the new task definitions, and a stop there is the defect 8.0af records. The refusal names the `stop.sh` command to run. Leave the flag off for a release that moves no migration: that is the rolling path. The apply replaces the two service task definitions and ECS rolls each service on to its new one at its current count. The script then launches no one-off task. It sets the worker's and then the API's declared count with `update-service --desired-count`, forcing no second deployment, waits once for both, and runs the running-digest check: each service has one deployment that did not fail, exactly its declared number of running tasks, every one on that deployment's task definition, and the release's digest in its container. A release that adds a migration but is deployed without `--schema-change` fails that check. Both `--api-digest` and `--worker-digest` are required on either path, and `bootstrap=true` without `--schema-change` is refused.

`--release-record <release-record.json>` (lane g71) is optional. When given, after the final verify the script reads the record back: it runs `fss admin release-record put` on the operations task, prints the stored record, and fails unless the answer is `existing` for this release's digests. `created` fails the deploy (P7, 26 September 2026): the record was not stored before the plan, so the services started without it. Only a bootstrap, which had no database to put into before its apply, may create it. Pass the record `record.sh from-ci` wrote for these same digests (4.2, lane g96): a record naming other digests is refused before anything else runs. Without it nothing about the deploy changes. Section 6 is where it matters: an enable of sending is refused unless its reference is a stored record naming the running API's digest.

**The record goes in before the apply (26 September 2026).** The worker admits a send only while a stored record names its own digest, and new worker tasks start as soon as the apply re-points the service. So store the record first, with `record.sh put` (4.2; `release-deploy.sh --record-only` is its old name, and still execs it). It does the put and nothing else, on the operations definition the root outputs now. That is the running release's definition, so the task is held to that definition's own worker image, and the record it stores names the new digests. The read-back at the end of `deploy.sh release --release-record` then answers `existing`; `record.sh read-back` is the same check on its own and fails on anything but `existing`. `record.sh put` refuses without `--release-record`, without both digests, on a `bootstrap=true` plan, and when the operations definition is not a worker image by digest.

**The policy, and it is not negotiable.**

- **Stop-during-migration.** From migration 0006 onwards every declared range is a strict `{N,N}`, so there is no build of this software that straddles a schema change and no honest way to migrate without an outage. `stop.sh` scales the API to zero first — so no request reaches a schema that is about to move — then the worker, which is given time to release its job leases, and it does so **before** the apply registers task definitions that refuse the current schema. `deploy.sh release --schema-change` then refuses to migrate unless both are still at zero.
- **The database never rolls back.** There is no down migration in this repository and there will not be one. `packages/domain/db/migrations` is forward-only and `loadMigrations` refuses a gap.
- **After a successful migration and a failed deployment there are exactly two paths.** *Forward repair*: fix the code, build a new digest, deploy it. Or *the restore protocol*: `docs/greenfield/restore-drill.md`, all nine steps, with sending and dialing held until step 9. Redeploying the previous digests is only a rollback when their declared ranges accept the current schema version, which after a migration they usually do not — `infra/scripts/rehearsal-schema-ranges.sh` computed that during the rehearsal and told you. What is never a path is undoing the schema.

### 4.1a Rolling back to the previous release (lane R1)

When a release is bad and the previous release's images accept the schema the database is at now, one command puts those images back. It runs from a checkout of main, because a commit from before this lane has no copy of the script. Its first argument is the production root inside a second checkout, at the previous release's commit, initialised as for section 4. The digests are that release's, as recorded in its release record or in the `fss-prod-*` tags.

```bash
git -C ~/fss-prod checkout --detach <previous release commit>   # then terraform init there, as section 4
infra/scripts/release-rollback.sh ~/fss-prod/infra/roots/production fss-prod \
  --api-digest "$PREVIOUS_API_DIGEST" --worker-digest "$PREVIOUS_WORKER_DIGEST"           # plan, print, stop
infra/scripts/release-rollback.sh ~/fss-prod/infra/roots/production fss-prod \
  --api-digest "$PREVIOUS_API_DIGEST" --worker-digest "$PREVIOUS_WORKER_DIGEST" --apply   # plan, apply, deploy, smoke
```

Without `--apply` it saves `rollback.tfplan` in the root, prints each change, and stops so that you can read the plan. With `--apply` it plans again from the same reads and judges the new plan the same way. Then it runs `terraform apply rollback.tfplan`, then `deploy.sh release` on the rolling path (never `--schema-change`), then the canary age and the six smoke checks. The plan is given the checkout's schema ranges and `bootstrap=false`. Everything else comes from what production runs now, which it reads first: `FSS_SENDING_ENABLED`, the generation pin, `FSS_PUBLIC_ORIGIN` as `api_hostname`, the HTTPS listener's certificate, and the alert topic's e-mail subscriptions. The pin is passed as a `-var`. The other four depend on the checkout:

- **A commit from 26 September 2026 on** commits `certificate_arn`, `api_hostname`, `alert_emails` and `sending_enabled` as literals in `infra/roots/production/main.tf`. The script reads each literal from the root, compares it with what production runs, and passes none of the four: the plan uses the committed values, which are production's.
- **A commit from before that** (the previous release at the time of writing, `5ccd2279`) declares them as variables, and the script passes production's values as `-var`, as it always did.

The smoke expects the same sending state, so **a rollback never switches sending on or off**. `FSS_REHEARSAL_DRY_RUN=1` prints every command and calls nothing.

It refuses in one `FAIL:` line, before anything is written, in these cases:
- either digest is not an image in `fss-prod-api` or `fss-prod-worker` tagged `ci-<commit>` or `<commit>` for the checked-out commit, or the checkout is not clean. The code that is planned must be the code of the images that will run;
- the database version the running API reports at `/health` is outside either of the checkout's declared ranges;
- either service is mid-rollout (`deploy.sh current`), or the API and worker disagree about sending or the pin;
- a value the checkout commits is not the one production runs, for example `sending_enabled = true` while production runs sending off. The `FAIL:` line names each value both ways. Decide which is right. If production's, roll back by hand on the manual path of 4.0 and correct the literal in a pull request. If the committed one, production has drifted: put it back with a plan and apply of main (4.0), then run the rollback again;
- the plan creates, replaces or destroys anything but an `aws_ecs_task_definition`, or updates anything but the `api` and `worker` services. It names every address and deletes the plan file. A difference in infrastructure between the two commits is the manual path of 4.0, not a rollback.

**The database is not part of a rollback, because it never rolls back (4.1).** No down migration exists. From migration 0006 every range is a strict `{N,N}`, so after a schema release the previous images refuse the database at startup. The version check exists to stop that before the apply rather than after it. After a migration the paths are forward repair or the restore protocol (section 7).

### 4.2 The release record, from the CI gate (lane g96)

The worker sends only under a stored release record that names its image digest (lane g71). The owner's axiom 10B (25 September 2026) says where that record comes from: the CI gate that was green on the deployed commit, not a full rehearsal. `infra/scripts/record.sh from-ci` writes it (`release-record-from-ci.sh` is its old name). It reads GitHub and nothing else, with no AWS call. It refuses in one `FAIL:` line, writing nothing, unless all of these hold:

- the gate run is a run of `.github/workflows/greenfield.yml`, judged by the run's `path` from `gh api repos/<repo>/actions/runs/<id>` and never by the display name *Greenfield gate*, which another workflow could also carry (lane A1). It is `completed`/`success` on its latest attempt, a push to `main` of this repository, at exactly the commit;
- the newest push run on `main` of `.github/workflows/greenfield-images.yml` for that commit, by its `path` as well, is `completed`/`success`;
- that run's `fss-image-digests` names that commit, that run and exactly the two digests you pass.

A commit that changed no image input has no images run. Record and deploy the commit whose images run built the digests; the gate ran on it too.

It writes `fss.release-record.v1` with `source: "ci-gate"`:

```json
{
  "schema": "fss.release-record.v1",
  "source": "ci-gate",
  "releaseGateReference": "ci-gate-<gate run id>-<first 12 characters of the commit>",
  "recordedAt": "<when the gate run concluded>",
  "suite": "pass",
  "commit": "<the commit, 40 characters>",
  "gateRunId": "<gate run id>",
  "gateRunUrl": "https://github.com/david-cui-bruno/founding-sales/actions/runs/<gate run id>",
  "imagesRunId": "<images run id>",
  "artifacts": { "api": "<api digest>", "worker": "<worker digest>", "desktopCommitStamp": "<the commit>" },
  "enablesSending": false
}
```

- **`enablesSending`** is `true` only with `--enables-sending`. Pass it for the release you mean to switch sending on under. Nothing binds on it: sending is still the deployment flag plus the owner's attestation (section 6).
- **No drill fields.** The record has no `rehearsalPrefix` or `rehearsalScenarios`, because a CI run drills nothing. The contract refuses a `ci-gate` record that claims one. A rehearsal record still needs both, and is still accepted.
- **The same bytes twice.** `recordedAt` is when the gate run concluded, so a record built again for the same run is identical, and a second put answers `existing`.

The commands, from a checkout of main (the release commit, which may be newer than the images commit) with `gh` signed in, then the profile and root of 4.1 for the deploy:

```bash
export GITHUB_REPOSITORY=david-cui-bruno/founding-sales
# The images of the checkout: the last commit that changed an image input, and its green gate run.
infra/scripts/images.sh pin "$(git rev-parse HEAD)" /tmp/fss-ci/image-pin.json > /tmp/fss-ci/pin.env
. /tmp/fss-ci/pin.env   # api_digest worker_digest images_run_id images_commit gate_run_id

# 1. The record, for the images commit. Add --enables-sending for the release sending is to be switched on under.
infra/scripts/record.sh from-ci "$gate_run_id" "$images_commit" "$api_digest" "$worker_digest" \
  --out /tmp/fss-ci/release-record.json

# 2. Store it before anything changes: the put alone, on the operations definition as it runs now.
infra/scripts/record.sh put infra/roots/production fss-prod \
  --api-digest "$api_digest" --worker-digest "$worker_digest" \
  --release-record /tmp/fss-ci/release-record.json

# 3. The plan and the apply: images.sh promote /tmp/fss-ci/image-pin.json first, stop.sh
#    first for a schema change (4.1).

# 4. The deploy, which reads the record back after the final verify: it must answer existing.
infra/scripts/deploy.sh release infra/roots/production fss-prod [--schema-change] \
  --api-digest "$api_digest" --worker-digest "$worker_digest" \
  --release-record /tmp/fss-ci/release-record.json

# 5. The production smoke (6, step 1).
```

The script prints the reference to stderr. The put prints it back as `reference`, with `source: "ci-gate"`. Section 6 step 5's attestation names it.

**What the put trusts.** A schema-valid `ci-gate` record put by whoever can run the operations task is trusted: `fss admin release-record put` checks the record's shape and stores it, and does not verify its GitHub evidence (the gate run, the images run, the artifact). CI's deploy job or an admin who can run that task can therefore store one, and its provenance is not independently verified. The script above is what makes a record true, not the put.

**The CI deploy does this itself (lane g100; before the rollout since 26 September 2026).** `deploy.sh ci record --before-rollout`, in the deploy job of `greenfield-deploy.yml`, runs the three steps below after `check` and before its first write, with no `--enables-sending` (4.0). `deploy.sh ci record --after-rollout` runs them again, in the same job after the rollout, and requires `existing`:

1. Read the gate and main again, as the `gates` job did (4.0): the *Greenfield gate* green on the images commit, by its workflow file, and the commit still on main. It waits for nothing, and puts nothing on any other answer.
2. Run `record.sh from-ci <gate run id> <images commit> <api digest> <worker digest>`, without `--enables-sending`. Actions already sets `GITHUB_REPOSITORY`, and the deploy job has the `actions: read` that `gh api` and `gh run download` need.
3. Put the record, as `record.sh put` does (lib.sh `release_record_put`): `fss admin release-record put --json-base64` on the operations task, held to that definition's own worker image. The network comes from four repository variables, and nothing reads Terraform state. `fss-prod-ci-deploy` holds `ecs:RunTask` on the operations family for this.

The commands above are the path for a manual release and the hand fallback when a read-back fails (4.0). Switching sending on uses them too.

---

## 5. The manual steps after the first apply

Done once, on 24 September 2026: the secret values, the first workspace and its admin, the DNS alias, the first sign-in, the SNS confirmation and the Gmail push grant. The first release's one-off steps are in [`docs/archive/release-first.md`](../archive/release-first.md): sections 1.1 to 1.7, 2.0, the orphan recovery of 3.0 and 5.1 to 5.4, under the numbers this document still cites.

---

## 6. Enabling sending — the only step that turns anything on

Do not reach this section until every one of these is true. Each is a different fact and each is checked by a different thing.

**1. The smoke checks pass.**

```bash
AGE=$(aws cloudwatch get-metric-statistics --namespace FSS/fss-prod \
  --metric-name CanaryCompletionAgeSeconds --statistics Maximum \
  --start-time "$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --period 300 \
  --query 'reverse(sort_by(Datapoints,&Timestamp))[0].Maximum' --output text)

NODE_OPTIONS="--experimental-transform-types --disable-warning=ExperimentalWarning" \
  node scripts/productionSmoke.mjs --origin https://api.usecallie.com --canary-age-seconds "$AGE"
```

Six lines, all `PASS`. The sixth reads `PASS sending_disabled (sendingEnabled=false)` — its expected answer is that sending is **off**, which is what makes it meaningful at this point.

**What the canary line measures.** `CanaryCompletionAgeSeconds` is the newest canary run's **scheduler-to-worker latency** — the gap between the scheduler inserting the run and the worker completing it, and `now() - inserted_at` while it is still uncompleted, worst over the newest run of each workspace (`packages/domain/jobs/canary.ts`). It is not the time since the last completion: the canary is inserted once per quarter hour, so that reading sawtooths to 900 on a healthy system and fails this 300-second check for about ten minutes in every fifteen, which is what the first production smoke did (8.0r). A healthy system reads a few seconds here at any moment; a worker that has stopped pushes it past 300 within five minutes, which is the same fact `fss-prod-canary-stale` alarms on.

**2. Put the release record, then check the digests match.** Since lane g71 (8.0ag) the software makes the comparison. You still read it before you attest.

Since lane g96 (the owner's axiom 10B) the record comes from the CI gate that was green on the deployed commit, not from a rehearsal. Build it with `record.sh from-ci` and store it with `record.sh put`, from a checkout at the commit production runs, as the admin profile, with the production root initialised as for section 4. 4.2 has the commands that find the gate run, the images run and the digests:

```bash
GITHUB_REPOSITORY=david-cui-bruno/founding-sales infra/scripts/record.sh from-ci \
  "$gate_run_id" "$images_commit" "$api_digest" "$worker_digest" --enables-sending --out /tmp/fss-ci/release-record.json
infra/scripts/record.sh put infra/roots/production fss-prod \
  --api-digest "$api_digest" --worker-digest "$worker_digest" \
  --release-record /tmp/fss-ci/release-record.json
```

`record.sh put` runs `fss admin release-record put` on the operations task as its definition is now, and deploys nothing, so it serves both a production already running the record's digests and a release about to deploy them (4.2). It prints the stored record: the reference, `source` (`ci-gate`), `suite`, `apiDigest`, `workerDigest`, and `outcome` (`created`, or `existing` on a re-run). It refuses a record naming other digests than the two given. A different record under the same reference is refused `release_record_conflict`. Records are never replaced. The put enables nothing. A deploy given the same file with `--release-record` puts it again after its final verify and answers `existing`.

A one-off task can only be handed arguments, so the record travels as base64. That also keeps a rehearsal record's `fss-rh-` text out of the arguments the production guard reads, which would otherwise read it as a rehearsal resource the command is about to act on. `fss admin release-record show --reference <reference>` reads a stored record back the same way.

The reference step 5 names, `"releaseGateReference": "<releaseGateReference from the record step 2 stored>"`, is the record's `releaseGateReference`, which the put prints as `reference`. For a record from the CI gate that is `ci-gate-<gate run id>-<first 12 characters of the commit>`. Step 5 is unchanged. Where its table and the paragraph after it say *rehearse*, read: a green gate run on the deployed commit, and its record (4.2).

Then read which images are running. Each service logs its own digest at startup, from the ECS task metadata:

```bash
for service in api worker; do
  aws logs filter-log-events --log-group-name "/fss/fss-prod/$service" \
    --filter-pattern "{ \$.event = \"${service}_configuration\" }" \
    --start-time $(( ($(date +%s) - 86400) * 1000 )) \
    --query 'events[-1].message' --output text
done
```

`image_digest` on the API line must be the record's `artifacts.api`, and on the worker line its `artifacts.worker`. `image_digest_source` should be `ecs_metadata_image`. If `image_digest` is `unknown`, the service could not read its own metadata: every enable is refused `release_record_identity_unknown` and every send is held. That is fail-closed, and the fix is the task, not the setting.

You still make this comparison by eye, and it is still the moment you take responsibility for the claim. But it is no longer the only thing between an unrehearsed image and a prospect. The API refuses an enable whose record's API digest is not its own. The worker refuses to send when the record's worker digest is not its own.

**3. The sending domain passes authentication.** 12.7, and the database enforces it: `sending_domains.automated_sending_enabled` cannot be true without SPF, DKIM, DMARC and a recorded Postmaster review. Set it from the admin surface (`/outbound/authentication`). If it refuses, a check is missing — fix the DNS, not the constraint.

The checklist needs the `sending_domains` row to exist. If Administration says **"No sending domain is configured."** and shows no checkboxes, the row is missing, and `/outbound/authentication` would answer `domain_unknown`. Two things create it (`docs/greenfield/sending.md`, "How a sending domain comes to exist"):

* **A mailbox connect**, on an API built at or after lane g57, registers the connected address's domain. A mailbox connected before that is not registered retroactively.
* **5.1a with `--sending-domain usecallie.com`**, run with the worker digest of a release that includes g57. This is the backfill for `callie@usecallie.com`, which connected on 24 September 2026, before g57. The report should show `"sendingDomain": { "domain": "usecallie.com", "isPrimary": true, "outcome": "created" }` the first time and `"outcome": "existing"` after that.

Once the row exists, reopen Settings on desktop **1.0.4 or later**: the section shows the five checkboxes and **Record checklist**. No earlier build can. Desktop 1.0.2 and 1.0.3 fail to parse every `/outbound/status` answer, so on them the section is absent whether the row exists or not (8.0ae).

**4. Flip the deployment flag.** Since 26 September 2026 it is the committed `sending_enabled = true` in `infra/roots/production/main.tf`, not a `-var`: production runs `FSS_SENDING_ENABLED=true` on both task definitions and every plan keeps it. Changing it is a pull request that edits the literal, then a plan and apply of the root (the manual path of 4.0), then re-deploy (worker, then API); read the plan first, and expect it to change exactly the two task definitions and nothing else. This is the release process's statement that the gate passed on these digests.

**5. Write the attestation, as an authenticated admin, naming the stored record.** From the settings page, or:

```
POST /settings/update
{ "settingKey": "sending_enabled",
  "value": { "enabled": true, "releaseGateReference": "<releaseGateReference from the record step 2 stored>" },
  "changeNote": "rehearsal <reference> passed; digests match production" }
```

The command refuses a non-admin caller and an enable that names no release gate: "an admin clicked yes" is not the gate. Since g71 it also refuses, in the same transaction as the write:

| Refusal | Means | Fix |
|---|---|---|
| `release_record_unknown` | no stored record has that reference | step 2's put, or a typo in the reference |
| `release_record_not_passing` | the record's `suite` is not `pass` | rehearse again |
| `release_record_digest_mismatch` | the record's `artifacts.api` is not the API image serving the request | deploy the rehearsed digests, or rehearse what is deployed |
| `release_record_identity_unknown` | the API could not read its own digest | the API task's metadata; its `api_configuration` line says why in `image_digest_detail` |

Turning sending off (`enabled: false`) is always accepted.

**The process form (lane g100).** The attestation may name the release process instead of one record, so that automatic deploys keep sending on without an attestation each time:

```
POST /settings/update
{ "settingKey": "sending_enabled",
  "value": { "enabled": true, "releaseGateReference": "ci-gate:main" },
  "changeNote": "I attest to the release process: a worker may send under any ci-gate release record for a commit on main, put by the CI deploy before its rollout" }
```

`ci-gate:main` means any stored record with `source: "ci-gate"`. Only `record.sh from-ci` writes one, and only from a green *Greenfield gate* run of a push to main at the record's commit. The CI deploy puts one before every rollout; the operator puts one by hand only for a manual release (4.2). Each process still compares its own half:
- the enable needs a stored, passing `ci-gate` record naming the running API's digest;
- the worker sends only while a stored, passing `ci-gate` record names its digest.

The refusals are the four above, with these meanings for the process form:
- `release_record_identity_unknown`: the process cannot read its own digest;
- `release_record_unknown`: no `ci-gate` record names this image. That is the hold after a deploy whose record was not put;
- `release_record_not_passing`: the record's `suite` is not `pass`.

A rehearsal record is never admitted by the process form, even when it names the running digest; it binds only under its own reference. `ci-gate:main` is reserved, so the contract refuses a record that carries it as its reference. The desktop's *Release gate reference* field takes the same text. Every claimed send records which form admitted it and the record it bound, in its `prepared → dispatching` row of `outbound_message_events` (`detail.releaseAdmission`, `attestation` either `ci-gate:main` or `reference`). To go back to one release at a time, attest again naming a reference.

Only when **4 and 5 and 3** are all true, and the attested record names the running worker's digest, does an automated email leave FSS. `packages/domain/outbound/gate.ts` reads all of it before every dispatch. When any part is false it refuses `workspace_sending_not_attested` or `automated_sending_disabled`, and names what said no. For the release half the `detail` is `deployment`, `workspace`, or one of the four codes above, never the reference. Under a named reference, a worker deployed later from other digests therefore holds every send (`release_record_digest_mismatch`) until its record is put and someone attests again. Under the process form it sends as soon as the CI deploy has put its record, and holds (`release_record_unknown`) until then. `GET /settings` then reports `effectiveSendingEnabled: false` on an API whose digest the record does not name, so Home's sidebar says sending is off.

**What enabling sending commits you to.** A mailbox that has sent automated mail in the last thirty days is not disconnected and its Google authorization is not revoked, so that a late reply-based "stop" is still received and honoured (12.6's reply-only opt-out). This is the workspace's own operating rule, not a guard the software enforces yet; see `docs/greenfield/mail.md`, "Mailbox lifecycle: the thirty-day rule".

### 6.1 Turning it off

Withdraw either half, or deploy other digests: the worker holds every send when the attested record does not name its image (under the process form, when no ci-gate record names it). The attestation (`enabled: false`) stops it immediately and is a versioned change with a reason; the deployment flag (the committed literal, 6 step 4) stops it at the apply and deployment after its pull request. Neither cancels a fence that has already entered `dispatching` — that message may have gone, and Appendix B is how it settles.

---

## 7. If the release has to be undone

4.2: "Earlier compatible binaries on the same database, or database restore under the post-restore protocol; the old stack is never a rollback target."

**Preferred.** Deploy the previous image digests, if and only if their declared schema ranges accept the current schema version. `infra/scripts/release-rollback.sh` does this and refuses otherwise (4.1a). Read them from the previous release's checkout; where the ranges do not overlap there is nothing to roll back to, and the honest answer is forward repair. This is exactly what `infra/scripts/rehearsal-schema-ranges.sh` computes, and it will have told you during the rehearsal.

**If the data is wrong rather than the code.** `docs/greenfield/restore-drill.md`, all nine steps, in production, with sending and dialing held until step 9. There is no faster version.

**Never.** The old stack. Its data tables were destroyed on 17 September 2026.

### 7.1 The expected system generation (Appendix E step 1)

`expected_system_generation` in the production root is Appendix E's "operator-controlled expected generation". Its code default is `null`, meaning unpinned. When set, it becomes `FSS_EXPECTED_SYSTEM_GENERATION` on `fss-prod-api` and `fss-prod-worker` and on no one-off task definition. At startup the worker compares it with the database's `system_generation`. When they differ, the worker opens one `restore_in_progress` hold per workspace, logs `restore_generation_mismatch` (which fires `fss-prod-restore-generation-mismatch`, a critical alarm), and runs. The API fails `/readyz` (the smoke's second check) and shows both numbers in the Settings diagnostics line. Until lane g56 nothing set it, and nothing anywhere opened a restore hold (`docs/archive/decisions/g56-restore-holds-are-opened-by-the-generation-check.md`).

**Read the database's generation.** Run this from a checkout at the commit production runs, as the admin profile, with the production root initialised as for section 4. It runs `fss verify` on the operations task, which the deployed image already has. The write it proves is rolled back, and `deploy.sh release --schema-change` runs the same command at every schema release. From g56 on, `fss admin counts` reports the same `systemGeneration` field.

```bash
export AWS_REGION=us-east-1
export WORKER_DIGEST="$(aws ecs describe-task-definition --task-definition fss-prod-operations \
  --query 'taskDefinition.containerDefinitions[0].image' --output text | sed 's/.*@//')"
bash -c 'set -euo pipefail
source infra/scripts/release-common.sh
root=infra/roots/production
network=$(release_output "$root" task_network_configuration json)
release_run_task --step read-generation --environment production --prefix fss-prod \
  --account "$(release_caller_account)" --region "$AWS_REGION" \
  --cluster "$(release_output "$root" cluster_arn)" \
  --task-definition "$(release_output "$root" operations_task_definition_arn)" \
  --container operations --network-plan "$network" --image-digest "$WORKER_DIGEST" \
  --database-host "$(release_json_path "$network" database_host)" \
  --secret-arn "$(release_output "$root" app_runtime_database_secret_arn)" \
  --log-group "$(release_output "$root" worker_log_group_name)" --log-stream-prefix operations \
  --capture /tmp/fss-read-generation.log \
  -- verify
release_captured_report /tmp/fss-read-generation.log /tmp/fss-read-generation.json'
python3 -c 'import json; print(json.load(open("/tmp/fss-read-generation.json"))["systemGeneration"])'
```

It prints one integer, `1` unless a step 9 has ever run. The desktop Settings diagnostics line shows the same value as "Database N, expected unpinned".

**Pin it.** Apply with the value you read. Read the plan first. It changes exactly two task definitions, `fss-prod-api` and `fss-prod-worker`, each replaced by a new revision that differs only in `FSS_EXPECTED_SYSTEM_GENERATION`. Both services update in place to the new revision, and nothing else changes. The apply itself rolls both services onto the new revisions. The new worker's log must show `worker_started` with `system_generation` equal to the pin, and **no** `restore_generation_mismatch` before it. If that line is there, the value is wrong: the worker has opened restore holds, sending and dialing are held, and the alarm is firing. Set the right value and apply. Releasing the holds it opened is then Appendix E step 9, because that is the only thing that releases a restore hold.

```bash
terraform -chdir=infra/roots/production plan -out=pin.tfplan -var="expected_system_generation=<N>" <the same -var list as section 4>
```

**After a restore** (`docs/greenfield/restore-drill.md`, in production):

1. Read the restored copy's generation R with the command above, adding `--env FSS_DATABASE_HOST=<restored endpoint>` to `release_run_task`.
2. Before any service is pointed at the copy, hold it: run the same command with `-- admin restore-holds open --expected-generation <R+1>`, and the same `--env`, in place of `-- verify`.
3. Set `expected_system_generation = R + 1` in the same apply as, or an apply before, whatever points the services at the copy. Never after. A worker that starts on the copy with the old pin sees no mismatch and holds nothing.
4. **Step 9 needs no bump.** It inserts generation `max + 1 = R + 1`, which is the pin. Confirm that the `generation` step 9 reports equals the pin. If it does not, set the pin to it and apply before any worker restarts. A pin that disagrees with the database makes the next worker start reopen the restore holds that step 9 released.

---

## 8. What this document could not verify

The records of what each credentialed run proved and refuted, and of what each lane's
change did, 8.0 to 8.0aw, are in [`docs/archive/release-records.md`](../archive/release-records.md), unchanged. A
numbered reference such as "8.0u", in this document or anywhere else, names one of them. From
25 September 2026 a change is its merged pull request instead, and this section holds only
what is still unverified.

### 8.1 Still unverified

Production is live: applied, deployed, bootstrapped and smoked at `66203322` on 24 September, and redeployed since (8.0s, 8.0v). Sign-in works and the first mailbox is connected (8.0x, 8.0y). The first release record exists: run 36100448302 at `b0f46711` passed every step, the restore drill's Appendix E steps 1 to 9 included, and wrote `releaseGateReference` `fss-rh-202609250554-2026-09-25T07:20:44Z`, kept outside GitHub's artifact retention in the coordinator's `.context/release-records/`. What follows is what that still does not settle. On 25 September lane g93 removed the items later runs had answered and cut the drill's item to the two gaps it left; the list as it stood is at the end of `docs/archive/release-records.md`, and an item number in an older document refers to that copy.

1. That `resourcegroupstaggingapi` is regional. The guard's read of the run's own resources only ever sees the rehearsal's region, which is where everything is — but a rehearsal resource left in another region is outside the comparison and always will be.
2. Whether the worker task role can write the suppression journal. **Closed by G12b in the plan, unproved in the cloud.** `infra/modules/cluster` now gives the worker `s3:PutObject` on the journal object prefix and `kms:Encrypt`/`kms:GenerateDataKey` on the journal key, and `infra/modules/journal` names both task roles as permitted writers rather than the API alone — so the bucket policy's `DenyWritesFromAnyoneButTheTaskRoles` no longer refuses the worker. Neither role asks for any `s3:Delete*`, and no writer sets a per-object retention: the bucket's own default retention locks every object on put, and `s3:PutObjectRetention` stays denied to everybody. `infra/modules/cluster/tests/services.tftest.hcl` asserts both halves offline. What a plan cannot prove is that the first real opt-out the worker imports actually lands in the bucket; watch the `SuppressionJournalWriteFailures` metric after Gmail sync is first enabled, because a remaining IAM refusal surfaces there and nowhere else.
3. Whether one day of GOVERNANCE retention is long enough that `--bypass-governance-retention` is only ever needed for a same-day teardown.
4. **What the green drill left open.** Two gaps behind run 36100448302's drill are tidy items, not drill failures. Appendix E.3's missing fences, a send whose fence the restored copy never had, are recovered from the Sent folder in code by lane g73 (8.0ah); no `full` run is recorded here as having proved it. And the API's recorded mode still wraps with a per-process key, which nothing in the drill reaches.
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
