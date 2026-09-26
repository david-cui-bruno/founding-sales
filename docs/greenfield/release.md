# FSS release: the invariants

**Spec:** 16.2, Appendix E, Appendix G · **Audience:** whoever is releasing a change to production, which has been live since 24 September 2026.

[`runbooks/operate.md`](runbooks/operate.md) is how a release is performed — the commands, in order, for an app change, a schema or infrastructure release and a desktop build. **This document is what may not change:** where a digest comes from, what a release record is and when it is stored, which paths take a release off the automatic path, what the deploy workflow checks before every production write, and what the database and the sending gate will not do whatever anyone asks.

Three pages hold what used to be here. The first release's one-off steps (sections 1, 2.0, part of 3.0 and 5) are in [`docs/archive/release-first.md`](../archive/release-first.md). The rehearsal's narrative, the CI deploy's set-up and section 8.1 are in [`docs/archive/release-history.md`](../archive/release-history.md). The records of the credentialed runs and the lanes before 25 September 2026 — every numbered reference such as 8.0u — are in [`docs/archive/release-records.md`](../archive/release-records.md). Each is cited below under the number this document used.

> **The one sentence the whole document serves.** Specification 16.2: *"Production sending remains disabled until all mandatory scenarios for the affected release class pass, the deployed commit/image digests match the rehearsal artifacts, and an authenticated admin enables sending."* Nothing below turns sending on. Section 6 is what binds it, and only the owner can write the attestation.

---

## 0. Who does what

| Step | Who | Why it cannot be the other one |
|---|---|---|
| Build, push and verify the images | CI (`greenfield-images.yml`, its `publish` job on a push to main that changes an image input) | One build per commit, pushed to `fss-rh-api` and `fss-rh-worker` as `ci-<commit>`, pulled back by digest and verified, with the digests published as `fss-image-digests`. That digest is the release's identity. |
| **Deploy an app-only change** | **CI (`greenfield-deploy.yml`), as `fss-prod-ci-deploy`** | David's decision of 25 September: app-only changes deploy themselves. Anything that is not application code, or expects another schema, answers `manual` and touches nothing (4.0). |
| **Promote the images of a schema or infrastructure release** | **The operator, with the admin profile** | `infra/scripts/images.sh promote` copies the two CI digests from `fss-rh-*` to `fss-prod-*` and reads production back (2.1). |
| Run the rehearsal | CI (`greenfield-release.yml`) | It needs the `fss-rh-deploy` role, which only the OIDC provider may assume, and it must tear the environment down even when a step fails. |
| Write the release record | The CI deploy, before each rollout (4.0); by hand for a manual release (`record.sh from-ci`, 4.2) | Since lane g96 it comes from the *Greenfield gate* run that was green on the deployed commit, not from a rehearsal. The script reads only GitHub and refuses unless the gate and the images run of that commit are green and name the digests, so a record can only exist for a commit CI passed. |
| Apply production Terraform | The operator | A plan should be read by a person before it is applied. |
| Put the secret values in | The operator | Terraform creates empty entries and never holds a value. |
| **Build and sign the desktop app — last, after the apply** | **CI (`greenfield-desktop.yml`), on prerequisites only the owner can create** | It needs a Developer ID Application certificate, the signing and notarisation secrets, three repository variables and the `desktop-release` environment, and it refuses to build without `FSS_UPDATE_CHANNEL_URL`, which is the CloudFront hostname the production apply creates. `docs/greenfield/install.md` lists every one of them. |
| Publish and install the desktop artifact | The operator | No AWS credential exists in that workflow. It is the one step that changes what every Mac sees. |
| **Enable sending** | **The owner, as an authenticated admin** | 16.2. It is an act, not a step. |

Nothing in this table can be done out of order without something below it refusing.

---

## 1. Before the first release

Done once, before 24 September 2026, and archived: sections 1.1 to 1.7 are in [`docs/archive/release-first.md`](../archive/release-first.md) under the numbers this document still cites. **1.2 is the one still load-bearing:** `s3:BypassGovernanceRetention` is on `fss-rh-deploy`, for a same-day rehearsal teardown, and must never appear on `fss-prod-deploy` — a production suppression journal its deployer can empty is not an append-only record, and Appendix E step 2 stops being a recovery. `infra/scripts/policy.sh` renders it for the rehearsal prefix alone and refuses to emit it for production; `test/ops/deploymentRolePolicy.check.ts` asserts both halves.

---

## 2. The images

Nothing is built on a Mac, and nothing is ever rebuilt for production. The order the first release needed, and why the desktop build came last — section **2.0**, which other documents still cite — is in [`docs/archive/release-first.md`](../archive/release-first.md).

### 2.1 Where a digest comes from, and what makes it trustworthy

1. **CI is the only source.** Every push to main that changes an image input runs *Greenfield images*. Its `publish` job pushes `fss-rh-api:ci-<commit>` and `fss-rh-worker:ci-<commit>`, pulls both back by digest, runs `infra/scripts/images.sh verify` on what it pulled, and uploads the artifact `fss-image-digests` (`image-digests.json`, `fss.image-digests.v1`), which also carries the schema range each image declares. Nothing is rebuilt after it. A commit that changed no image input has the images of the last one that did; `images.sh pin <commit> <file>` finds them and the green gate run of that images commit, which the release record is built from (4.2). The digests, `sha256:` and 64 hex characters, not the tags, are what everything downstream compares: `infra/modules/cluster` refuses a mutable tag.
2. **Production gets a copy, never a rebuild.** `images.sh promote` copies each digest from `fss-rh-*` to `fss-prod-*` with `docker buildx imagetools create --prefer-index=false` — a carbon copy of CI's bare manifest — and reads the tag back. A digest production already holds under a tag is `already-present` and nothing is copied, so running it twice is running it once; one it holds untagged is tagged in place from its own manifest bytes; a tag that already names another image is never overwritten, because the repositories are IMMUTABLE. **Promotion is `images.sh promote` and nothing else.**
3. **Provenance without a clock.** The rehearsal repositories are IMMUTABLE, so a tag names the first image pushed under it. The images run refuses a `ci-<commit>` tag that already exists unless an earlier attempt of the same run attests pushing that digest: each attempt uploads `fss-image-pushed-<attempt>` with `images.sh pushed` whatever its end, and a re-run reuses a tag only when `images.sh attested` finds such an artifact naming it. A first attempt that finds the tag, or a re-run with no attestation, fails, and that commit is released by hand. There is no ECR repository policy; what limits who can push `fss-rh-*` is the namespace of `fss-rh-deploy`.

The **desktop commit stamp** is the release commit. The release record names it, and no Mac build has to produce it first.

---

## 3. The rehearsal

Dispatch only, `mode: schema`, five stages (`plan`, `create`, `deploy`, `full`, `teardown`). It creates `fss-rh-<suffix>`, fills its own entries, migrates and deploys both digests, bootstraps a workspace, checks the declared ranges against the deployed images, smokes, tears down and guards. The dispatch is in [`runbooks/operate.md`](runbooks/operate.md); why it has this shape, what the stages cost, and the numbered list of what a `full` run does — items 1 to 15, of which **13 is the teardown and 14 the prefix guard** — are in [`docs/archive/release-history.md`](../archive/release-history.md).

Three things about it are invariants rather than procedure:

- **It cannot address production.** Production and rehearsal plans use distinct state keys, roles, secrets and resource namespaces (Appendix G 39). Every AWS call goes through `lib.sh`'s wrapper, which refuses an argument naming `fss-prod`; the session is an assumed-role session of `fss-rh-deploy`, whose policy is scoped to `fss-rh-*`; and `rehearsal.sh identity` proves that before the create and again before the teardown.
- **Every stage tears down and every stage guards.** Items 13 and 14 keep `if: always()` and carry no stage condition at all, so that a mistyped stage condition cannot leave an environment standing with nothing to destroy it. `rehearsal.sh guard` fails closed: a reading it cannot make is not an absence.
- **It writes no release record.** The record a release puts comes from the CI gate (4.2).

**When it is needed (lane g97, 25 September 2026).** Before the production plan of every release that changes the schema, the infrastructure or a release script. An app-only release needs none, because CI deploys it; a desktop-only one needs none either.

---

## 4. Production releases

An app-only change is not applied by hand: CI deploys it (4.0). Everything else is the manual path, whose order is in [`runbooks/operate.md`](runbooks/operate.md) and whose guards are below.

**`assume_deployment_role` is never passed here.** It defaults to `true` in every root, which is what a local apply wants: the provider assumes `fss-prod-deploy` for you. The flag is for a session that has already assumed its role — the rehearsal workflow, and nothing else.

**A plan that proposes to destroy or replace an ECR repository is not to be applied.** The production registry was bootstrapped by a targeted apply and `create_registry` has since given that module a `count`, so the repositories appear under **"has moved to"** and under nothing else. Destroying one would delete the images every release record identifies.

**Applying production while a rehearsal runs is safe** (lane g97): the rehearsal's guard reads only what carries its own run prefix and asks an absolute question rather than comparing inventories. Watch Actions anyway — a production apply and a rehearsal share the account's quotas, and a rehearsal cancelled to make room leaves what `rehearsal.sh leftovers` finds.

### 4.0 App-only changes deploy themselves: the protected paths and the gates (lane g91)

When *Greenfield images* publishes the images of a push to main, *Greenfield deploy* deploys them as `fss-prod-ci-deploy`, the role `infra/roots/production/ci_deploy.tf` declares. It trusts one OIDC subject, this repository's `production-deploy` environment, and holds no state, secret, database or IAM write. Five jobs: `gates`, `deploy`, `smoke`, `read-back`, `summary`. Every step that reads or writes production is `infra/scripts/deploy.sh ci <subcommand>`.

**The protected paths.** The deploy job's own inline guard runs before any of the repository's code. It reads the commit production's images were built from — the `ci-<commit>` tag the promotion gave each running digest in `fss-prod-*`, or the bare commit an operator's push was tagged with — and lists what every commit between that one and the images commit touched. Commit by commit, so a change later reverted still counts; rename detection off, so a moved file counts at both paths; a merge judged against its first parent. It answers `manual` — a notice, a green run, nothing touched, no role assumed — when any of these appears:

- `infra/**`, every script in `infra/scripts/` included;
- a migration;
- `packages/domain/db/schemaRange.ts`, `migrationRunner.ts` or `queryable.ts` — the schema acceptance rule and the migration runner, with what they read (lane A1). `check` compares the declared ranges, so a change to how a version is accepted would otherwise pass unseen;
- `scripts/productionSmoke.mjs` or another release script;
- `.github/**`;
- a path the list does not know.

It also answers `manual` when a running image carries no commit tag, or when production's commit is not behind the images commit.

**After a protected change, the next release is by hand.** A protected change in the range keeps answering `manual` until production runs images built after it, and an infrastructure-only merge builds no images. So: apply the change by the manual path, then release the first app merge after it by hand. Production's commit tag is then past the change and the next app merge deploys itself again. There is no switch that tells CI a change was applied.

**The gates, and the gate again before every production write** (reviews of PRs 273 and 278). The `gates` job holds no credential. It checks that the images run is a green `publish` of a push to main of this repository, then, from a checkout of `infra/scripts/` at that commit, runs `deploy.sh ci gates`, which asks GitHub two things: that *Greenfield gate* has a run of the push at that commit — found by its workflow file `.github/workflows/greenfield.yml`, never by its display name — whose newest attempt is `completed`/`success`; and that the commit is still on main (`compare/main...<commit>` answers `behind` or `identical`). It waits up to thirty minutes for a gate still running, then answers `pass` naming the run, or `manual` with the reason.

That answer only decides whether the deploy job starts. **Every production write reads the gate again**, waiting for nothing, and must find the same run: `deploy.sh ci record` before it builds the record and again immediately before its put; `images.sh promote --gate-run-id` before each write to a production repository; `deploy.sh ci deploy` before each registration and again before each update. A newer run of the push, a re-run gone red, or the commit force-pushed off main fails the run at that point with nothing more written. What cannot be closed is the few seconds between the last read and the write itself.

**`check` reads and writes nothing.** It answers `manual` when the images declare a schema range the running task definitions do not, when `/health` reports a database version the images do not accept, or when a service is not running exactly its declared count with nothing pending. It fails, touching nothing, when the session is not `fss-prod-ci-deploy` in account `326255650484` in `us-east-1`, when the cluster is not tagged `production` or a deployment is not `COMPLETED`, when the digests file is not the images run's own or names no ranges, when either digest differs from the one `fss-rh-<image>:ci-<commit>` names, or when `/health` does not answer.

**A revision is deregistered on one evidence only** (review of PR 278): ECS itself failed the deployment of it and nothing of it is left running — exactly one deployment names the new revision, its `rolloutState` is `FAILED`, and the one `PRIMARY` deployment and the service both name the previous revision. Anything else leaves it ACTIVE, the run fails, and it must be reconciled before the next production plan, because Terraform reads the family's newest ACTIVE revision. After a failed `update-service` call nothing is deregistered at all: a call that failed and one accepted with its answer lost leave the same trace, and deregistering there would take away a revision the service is about to run.

**What this accepts.** A job holding the role can register a revision of `fss-prod-api` or `fss-prod-worker` with any image in those two repositories and roll it out: IAM has no condition on a task definition's contents, and a main-branch workflow can deploy whatever main contains. That is the price of continuous deployment; the script narrows it by deriving every revision from the running one. The limits are the `production-deploy` environment restricted to main, no `id-token` in any job that runs images-commit code, the exact OIDC subject, ECR writes only to the two `fss-prod` repositories, and `iam:PassRole` naming only the two services' existing four roles. The set-up steps are archived in [`release-history.md`](../archive/release-history.md).

**Terraform and CI share the two service task definitions.** Both carry `track_latest = true`, so Terraform reads the family's newest ACTIVE revision — CI's — as its own, and the services still re-point on an apply that registers a revision. The migration and operations definitions do not track: they are Terraform's, and carry the worker image of the last apply.

### 4.1 The order inside a release, and the policy that is not negotiable

```
[schema change: stop.sh]  →  terraform apply  →  every entry filled  →  fss migrate  →  database users  →  fss verify  →  worker  →  API  →  fss verify
```

- **Every entry first.** Terraform creates the Secrets Manager entries empty, and an ECS task whose `secrets` block names an entry with no value does not start at all — `ResourceInitializationError … can't find the specified secret value`, before the container exists. Every task definition but the migration's names them all, so the values go in **before** the deploy, not after.
- **Stop during migration.** From migration 0006 every declared range is a strict `{N,N}`, so there is no build of this software that straddles a schema change and no honest way to migrate without an outage. `stop.sh` scales the API to zero first — so no request reaches a schema about to move — then the worker, which is given time to release its job leases, and it does so **before** the apply registers task definitions that refuse the current schema. `deploy.sh release --schema-change` then refuses to migrate unless both are still at zero; it no longer stops them itself, because by then the apply has pointed them at definitions that refuse the schema and a quiet stop would make the wrong order look right. The apply cannot restart them: `ignore_changes = [desired_count]`.
- **The database never rolls back.** There is no down migration in this repository and there will not be one. `packages/domain/db/migrations` is forward-only, `loadMigrations` refuses a gap, and the runner checksums an applied file's bytes, so editing one fails with `MIGRATION_CHECKSUM_MISMATCH` rather than diverging silently from production.
- **After a successful migration and a failed deployment there are exactly two paths.** *Forward repair*: fix the code, build a new digest, deploy it. Or *a restore*: [`runbooks/restore.md`](runbooks/restore.md), with both services stopped and nothing sending until it restarts them. Redeploying the previous digests is a rollback only when their declared ranges accept the current schema version, which after a migration they usually do not. What is never a path is undoing the schema.
- **The declared counts come from the plan**, not from a number in a shell file: the script scales each service to `terraform output deployment_plan`'s `declared_desired_count`. Terraform sets a count only when it creates a service; after that both ignore changes to it.
- **Every one-off launch is checked before it is made.** `infra/scripts/lib.sh` refuses a bare cluster name, a wrong account, a wrong region, a cluster tagged as the other environment, a task definition whose image is not the digest this release is about, a network configuration that is not the root's own subnets under the worker security group, and a definition resolving a credential entry this release did not name. Afterwards it reads the `failures` array, refuses a task that never started and a stopped task with no exit code, and records the task ARN so a retry waits on the task already running rather than starting a second migration.

**The drift rule: every production plan starts from what production runs, and every apply checks it again.**

```bash
infra/scripts/deploy.sh current fss-prod      # api_image=… worker_image=… and the two schema ranges
(cd infra/roots/production && terraform plan -out=production.tfplan \
   $(../../scripts/deploy.sh current fss-prod --var-flags))
# immediately before the apply, with the two images the plan was made with:
infra/scripts/deploy.sh current fss-prod --compare "<api_image>" "<worker_image>" \
  && (cd infra/roots/production && terraform apply production.tfplan)
```

`deploy.sh current` refuses when a service's rollout is not finished (one `PRIMARY` deployment ECS calls `COMPLETED`, its declared count running, nothing pending, every running task reporting its digest); when a family's newest ACTIVE revision is not the one its service runs, which Terraform would otherwise read; and, with `--compare`, when either image differs from the one running — a CI deploy has landed since the plan, so plan again. A schema release plans with its own new images on purpose and passes `--allow-digest-change`.

**During a restore, every plan names the copy** (W3-S8, PR 282). Between steps (f) and (g) of [`runbooks/restore.md`](runbooks/restore.md) production runs on a point-in-time copy, and every production plan and apply must carry `-var=active_database_host=<the copy's address>`, a routine release included; without it the plan puts the managed instance's address back into the four task definitions. `deploy.sh current fss-prod` prints `api_database_host=` and `worker_database_host=` after the four lines a plan is made from: equal to the root's `database_endpoint` without its port, production is on the managed instance and no plan names a host.

**The release record goes in before the apply.** `record.sh put` does the put and nothing else, on the operations definition the root outputs now — the running release's definition, so the task runs that image while the record it stores names the new digests. `deploy.sh release --release-record <file>` then reads it back after the final verify and fails unless the answer is `existing`; `created` fails the deploy, because the services would have started without it. Only a bootstrap, which had no database to put into, may create it.

### 4.1a Rolling back: images only, and never across `beed2d90`

`infra/scripts/rollback.sh` puts production back on a previous release's images. It runs from a checkout of main — an older commit has no copy of it — and plans the production root inside a second checkout at the previous release's commit. Without `--apply` it saves and prints the plan and stops; with `--apply` it plans again from the same reads, judges it the same way, applies, deploys on the rolling path (never `--schema-change`) and smokes, expecting the same sending state, so **a rollback never switches sending on or off**.

It refuses in one `FAIL:` line, before anything is written:

- **a checkout older than main `beed2d90`** (PR 272), or one that does not hold that commit. That merge deleted the restore drill's task definition, roles, policies, metric filter and alarm, and every older commit's Terraform declares them, so its plan would create them again. Across that boundary only the images roll back, without Terraform, and the infrastructure is repaired forward;
- **images that are not the checkout's**: each digest must be an image in `fss-prod-api`/`fss-prod-worker` tagged `ci-<commit>` or the bare `<commit>` for the checked-out commit, and a dirty checkout is refused for the same reason. That is what ties the code planned to the images that will run;
- **a rollback across a schema change**: the database version the running API reports at `/health` must be inside both of the checkout's declared ranges. The database never rolls back (4.1);
- **a service mid-rollout**, or a family whose newest revision is not the one that runs;
- **a committed production value that is not what production runs.** Since 26 September 2026 `infra/roots/production` commits `certificate_arn`, `api_hostname`, `alert_emails` and `sending_enabled` as literals rather than taking them as variables; for each, the value the checkout commits must equal the one production runs, because the plan would otherwise change the listener, the origin, a subscription or sending;
- **a restore in progress, unnamed**: while the two database hosts differ from the managed instance it refuses to plan unless `--active-database-host` names the host production runs on, and a host given that is not the running one is refused too;
- **a plan that creates, replaces or destroys anything but an `aws_ecs_task_definition`, or updates anything but the two services.** It names every address and deletes the plan file. A difference in infrastructure between the two commits is the manual path, not a rollback.

### 4.2 The release record, from the CI gate (lane g96)

The worker sends only under a stored release record that names its image digest (lane g71), and since the owner's axiom 10B that record comes from the CI gate that was green on the deployed commit, not from a rehearsal. `infra/scripts/record.sh from-ci` writes it. It reads GitHub only, makes no AWS call, and refuses in one `FAIL:` line, writing nothing, unless all of these hold:

- the gate run is a run of `.github/workflows/greenfield.yml`, judged by the run's `path` and never by the display name *Greenfield gate*, which another workflow could also carry; `completed`/`success` on its latest attempt, a push to `main` of this repository, at exactly the commit;
- the images run, by its `path` as well, is a green push run of `.github/workflows/greenfield-images.yml` for that commit. `--images-run <id>` names it, and the CI deploy always passes the run it deploys; without it the newest such run of the commit is taken, which is the hand path's choice;
- that run's `fss-image-digests` names that commit, that run and exactly the two digests passed.

A commit that changed no image input has no images run of its own: record and deploy the commit whose images run built the digests — the gate ran on it too.

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

- **`enablesSending`** is `true` only with `--enables-sending`. Nothing binds on it: sending is the deployment flag plus the owner's attestation (section 6).
- **No drill fields.** The record has no `rehearsalPrefix` or `rehearsalScenarios`, because a CI run drills nothing, and the contract refuses a `ci-gate` record that claims one. No new rehearsal record is accepted either: the rehearsal stopped writing them with W3-S8, and `fss admin release-record put` refuses one.
- **The same bytes twice, while the gate run is not re-run.** `recordedAt` is when the gate run last concluded, so a record rebuilt for the same gate run and images run is identical and a second put answers `existing`. A re-run of the gate run moves it, the rebuilt record differs, and the put is refused `release_record_conflict` — which is why the CI read-back puts the file the deploy job put rather than a rebuilt one, and why the hand path keeps its `release-record.json` from the record to the read-back.
- **Records are never replaced.** A different record under the same reference is refused `release_record_conflict`.

**The record is stored before the rollout, always.** The worker admits a send only while a stored record names its own digest, so a put after the rollout would leave every worker task that starts during it without one (`release_record_unknown`). In CI, `deploy.sh ci record --before-rollout` is the deploy job's **first write**, after `check` and before anything is promoted: when it fails the run is red and nothing was promoted or deployed. A record stored for a rollout that then fails is inert — no running process has its digests. `deploy.sh ci record --after-rollout` runs in a separate job after the smoke, on the exact bytes the deploy job put, and requires `existing`; it never rebuilds the record.

**What the put trusts.** A schema-valid `ci-gate` record put by whoever can run the operations task is trusted: `fss admin release-record put` checks the record's shape and stores it, and does not verify its GitHub evidence. `record.sh from-ci` is what makes a record true; the put is not.

---

## 5. The manual steps after the first apply

Done once, on 24 September 2026, and archived in [`docs/archive/release-first.md`](../archive/release-first.md) under the numbers this document cites: the secret values (5.1), the first workspace and its admin (5.1a), the DNS alias, the first sign-in, the SNS confirmation and the Gmail push grant.

---

## 6. Sending: what binds it

Three facts must hold before an automated email leaves FSS, and each is checked by a different thing. `packages/domain/outbound/gate.ts` reads all of it before every dispatch and names what said no.

1. **The deployment flag.** `FSS_SENDING_ENABLED` is `true` only when the value is exactly `true`; anything else is a refusal, never a send. Since 26 September 2026 it comes from the committed `sending_enabled = true` in `infra/roots/production/main.tf`, so changing it is a pull request, a read plan and an apply.
2. **The domain's authentication.** The database enforces it: `sending_domains.automated_sending_enabled` cannot be true without SPF, DKIM, DMARC and a recorded Postmaster review. If the checklist refuses, a check is missing — fix the DNS, not the constraint. How the row comes to exist is in `docs/greenfield/sending.md`.
3. **The owner's attestation, naming a stored release record.** From the desktop settings page, or:

   ```
   POST /settings/update
   { "settingKey": "sending_enabled",
     "value": { "enabled": true, "releaseGateReference": "<the reference the put printed>" },
     "changeNote": "<why>" }
   ```

   It refuses a non-admin caller and an enable that names no release gate: "an admin clicked yes" is not the gate. Turning sending off (`"enabled": false`) is always accepted. The desktop's *Release gate reference* field takes the same text.

Both the enable and each send compare their own half of the record, in the same transaction as the write:

| Refusal | Means |
|---|---|
| `release_record_unknown` | no stored record has that reference; under the process form, no `ci-gate` record names this image — the hold after a deploy whose record was not put |
| `release_record_not_passing` | the record's `suite` is not `pass` |
| `release_record_digest_mismatch` | the record's `artifacts.api` is not the API image serving the request |
| `release_record_identity_unknown` | the process could not read its own digest from the ECS task metadata. Fail-closed: the fix is the task, not the setting |

**The process form** (lane g100). The attestation may name `ci-gate:main` instead of one record, so that automatic deploys keep sending on without an attestation each time:

```
{ "settingKey": "sending_enabled",
  "value": { "enabled": true, "releaseGateReference": "ci-gate:main" },
  "changeNote": "I attest to the release process: a worker may send under any ci-gate release record for a commit on main, put by the CI deploy before its rollout" }
```
 `ci-gate:main` means any stored record with `source: "ci-gate"`, and only `record.sh from-ci` writes one, and only from a green *Greenfield gate* run of a push to main at the record's commit. The enable still needs a passing `ci-gate` record naming the running API's digest, and the worker still sends only while one names its own. A rehearsal record is never admitted by the process form even when it names the running digest: production binds `ci-gate` records alone (PR 279). `ci-gate:main` is reserved, so the contract refuses a record carrying it as its reference. Every claimed send records which form admitted it and which record it bound, in its `prepared → dispatching` row of `outbound_message_events`. To go back to one release at a time, attest again naming a reference.

**Withdrawing it.** Either half stops sending, and so does deploying other digests: the worker holds every send when no admitted record names its image. The attestation (`enabled: false`) stops it immediately and is a versioned change with a reason; the deployment flag stops it at the apply and deployment after its pull request. Neither cancels a fence that has already entered `dispatching` — that message may have gone, and Appendix B is how it settles.

**What enabling sending commits the workspace to.** A mailbox that has sent automated mail in the last thirty days is not disconnected and its Google authorization is not revoked, so that a late reply-based "stop" is still received and honoured (12.6's reply-only opt-out). This is an operating rule, not a guard the software enforces yet; see `docs/greenfield/mail.md`, "Mailbox lifecycle: the thirty-day rule".

---

## 7. If the release has to be undone

**Preferred.** Deploy the previous image digests, if and only if their declared schema ranges accept the current schema version: `infra/scripts/rollback.sh`, which refuses otherwise (4.1a). Across main `beed2d90` only the images roll back and infrastructure is repaired forward. Where the ranges do not overlap there is nothing to roll back to, and the honest answer is forward repair.

**If the data is wrong rather than the code.** Restore to a point in time with [`runbooks/restore.md`](runbooks/restore.md): stop both services, restore to a new instance, point production at it, replay the suppression journal, reconcile the Sent folders read-only, put the release record again, and restart. There is no faster version.

**Never.** The old stack. Its data tables were destroyed on 17 September 2026.

---

## 8. Records, and what is still unverified

The records of what each credentialed run proved and refuted, and of what each lane's change did, 8.0 to 8.0aw, are in [`docs/archive/release-records.md`](../archive/release-records.md), unchanged: a numbered reference such as "8.0u", in this document or anywhere else, names one of them. From 25 September 2026 a change is its merged pull request instead. **8.1, what production still has not proved**, moved with the rest of the history to [`docs/archive/release-history.md`](../archive/release-history.md).
