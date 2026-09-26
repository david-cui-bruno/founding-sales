# FSS release: what David does, what CI does, and in what order

**Lane:** G12 · **Spec:** 16.2, Appendix E, Appendix G · **Audience:** the operator running the first release. Assume you have never applied this stack.

`docs/greenfield/infra-apply-runbook.md` is how the infrastructure comes into existence. This document is how a **release** happens on top of it: which steps are yours, which are the workflow's, and why the order cannot be rearranged.

This is the runbook and nothing else. What each merged change did is one line in [`changelog.md`](changelog.md), added as one fragment file under [`changelog/`](changelog/), and the records of the credentialed runs and lanes before 25 September 2026 (the numbered references such as 8.0u below) are in [`release-records.md`](release-records.md).

Read section 1 before doing anything in section 3. Two steps in it take days of waiting (DNS authentication for sending, and an SNS confirmation click that is easy to forget), and one of them — the `fss-rh-deploy` bypass-governance grant — is the difference between a rehearsal you can tear down today and one that leaves a bucket behind for a day.

> **The one sentence the whole document serves.** Specification 16.2: *"Production sending remains disabled until all mandatory scenarios for the affected release class pass, the deployed commit/image digests match the rehearsal artifacts, and an authenticated admin enables sending."* Nothing below turns sending on. The last step of the last section does, and only you can do it.

---

## 0. Who does what

| Step | Who | Why it cannot be the other one |
|---|---|---|
| Build, push and verify the images | CI (`greenfield-images.yml`, its `publish` job on a push to main that changes an image input) | One build per commit, pushed to `fss-rh-api` and `fss-rh-worker` as `ci-<commit>`, pulled back by digest and verified, with the digests published as `fss-image-digests`. That digest is the release's identity (8.0al). |
| **Deploy an app-only change to production** | **CI (`greenfield-deploy.yml`, after `publish`), as `fss-prod-ci-deploy`** | David's decision of 25 September: app-only changes deploy themselves. It promotes by digest, registers the two service revisions, rolls, holds each to its digest and smokes; anything that is not application code, or expects another schema, answers "manual" and touches nothing (4.0). |
| **Promote the images of a schema or infrastructure release** | **David, with the admin profile** | `infra/scripts/release-promote.sh release-manifest.json` copies the two digests of a green full rehearsal from `fss-rh-*` to `fss-prod-*` and reads production back (2.1). |
| **Apply the rehearsal registry — once, ever** (done) | **CI (`greenfield-rehearsal-registry.yml`), dispatched by David twice: plan, then apply** | Same reason as the row below: `fss-rh-deploy` is assumable only from the `rehearsal` environment. `infra-apply-runbook.md` 2.1. |
| Run the rehearsal | CI (`greenfield-release.yml`) | It needs the `fss-rh-deploy` role, which only the OIDC provider may assume, and it must tear the environment down even when a step fails. |
| Write the release record | David, from CI's results (`release-record-from-ci.sh`, 4.2); the CI deploy once g91's follow-up lands | Since lane g96 (the owner's axiom 10B) it comes from the *Greenfield gate* run that was green on the deployed commit, not from a rehearsal. The script reads only GitHub and refuses unless the gate and the images run of that commit are green and name the digests, so a record can only exist for a commit CI passed. |
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

### 1.1 The two deployment roles exist and differ

From `infra-apply-runbook.md` 1.1, and already done (`.context/FSS-GREENFIELD-ACCOUNT-IDENTIFIERS-20260920.md`):

- `arn:aws:iam::326255650484:role/fss-prod-deploy`
- `arn:aws:iam::326255650484:role/fss-rh-deploy` — **may act only on resources whose name begins `fss-rh`.**

Those two ARNs are the shared account's, and the shared account is the tree's **default**, not its assumption: the account, the region, the state backend and the role ARNs are all parameters. David decided on 22 September 2026 to move the rehearsal and production into two dedicated member accounts under Organizations before the first production release. **`docs/greenfield/accounts.md`** is the checklist he performs by hand, in order — the accounts, the state bootstrap, the OIDC provider and the exact subject, the two roles, the registries, the certificates, the eight empty secret entries, and the GitHub secrets and variables below that change. Nothing in the shared account is deleted by it, and the old worker keeps running there until its own cutover.

That scoping is Appendix G 39 in the cloud rather than only in the plan. `infra/scripts/rehearsal-prefix-guard.sh` checks the same thing from the other side after every rehearsal, and it refuses before making a call rather than waiting for an `AccessDenied` in a log.

**Their policies are in the repository now, and so are the commands that install them.** Until 21 September both were written by hand from prose in the runbook, and the fourth credentialed rehearsal applied with them and reported 25 errors in six classes (8.0d). `infra-apply-runbook.md` **1.1a** has the three commands — render, read, `put-role-policy` — and the read-only `infra/scripts/check-deployment-role.sh <role> <prefix>` to run before any apply. Do that before section 3 and again before section 4; it takes seconds and it answers the whole class.

### 1.2 The `fss-rh-deploy` bypass-governance grant

The rehearsal journal bucket uses **GOVERNANCE** object lock with a one-day retention, so a same-day `terraform destroy` cannot remove it: the objects the drill wrote refuse deletion until the day passes. A rehearsal is per-release and same-day, so add to `fss-rh-deploy`:

```json
{
  "Sid": "BypassGovernanceOnRehearsalBucketsOnly",
  "Effect": "Allow",
  "Action": ["s3:BypassGovernanceRetention", "s3:DeleteObject", "s3:DeleteObjectVersion"],
  "Resource": "arn:aws:s3:::fss-rh-*/*"
}
```

**This permission must never be on `fss-prod-deploy`.** If it ever appears there, the production suppression journal stops being an append-only record and Appendix E step 2 stops being a recovery. Check with:

```bash
aws iam get-role-policy --role-name fss-prod-deploy --policy-name <name> \
  | grep -i BypassGovernanceRetention && echo "REMOVE THIS" || echo "ok"
```

### 1.3 The `rehearsal` repository environment

`.github/workflows/greenfield-release.yml` puts every AWS step behind a repository environment named `rehearsal`. So does `.github/workflows/greenfield-rehearsal-registry.yml`, the one-off apply of the durable rehearsal repositories (`infra-apply-runbook.md` 2.1) — the environment is the only OIDC subject `fss-rh-deploy` trusts, which is why neither of them is a command you can run on your Mac.

Create it in the repository settings and give it these **five** secrets:

| Secret | Value |
|---|---|
| `FSS_REHEARSAL_ROLE_ARN` | `arn:aws:iam::326255650484:role/fss-rh-deploy` |
| `FSS_REHEARSAL_API_REPOSITORY` | `326255650484.dkr.ecr.us-east-1.amazonaws.com/fss-rh-api` — `terraform output repository_urls` in `infra/roots/rehearsal-registry` prints it |
| `FSS_REHEARSAL_WORKER_REPOSITORY` | `326255650484.dkr.ecr.us-east-1.amazonaws.com/fss-rh-worker` — likewise |
| `FSS_REHEARSAL_CERTIFICATE_ARN` | the wildcard rehearsal certificate |
| `FSS_REHEARSAL_API_HOSTNAME` | `api.rehearsal.usecallie.com` |

And **one more, optional**, which only the registry apply reads:

| Secret | Value | If it is absent |
|---|---|---|
| `FSS_REHEARSAL_STATE_KMS_KEY_ARN` | the KMS key the Terraform state bucket is encrypted with, `arn:aws:kms:us-east-1:326255650484:key/…` | `terraform init` runs without `kms_key_id` and the bucket's default encryption applies, which is what the per-run rehearsal root already does. The run prints *whether* the secret was supplied, never its value. |

It is an identifier rather than a credential; it is an environment secret because that is where the other account-specific values live.

And three **repository variables**, all optional. Unset, both workflows behave exactly as they do today; set, they are how a dedicated AWS account states itself (`docs/greenfield/accounts.md` 11).

| Variable | Value | What it does |
|---|---|---|
| `FSS_REHEARSAL_ACCOUNT_ID` | the rehearsal account's twelve digits | Cross-checked against the account the workflow's OIDC session actually belongs to; the run fails if they differ. The account the apply uses is always the session's, so this is a second statement of the same fact rather than a source of truth. |
| `FSS_REHEARSAL_STATE_BUCKET` | the rehearsal account's Terraform state bucket | Cross-checked against `infra/roots/rehearsal-registry/backend.hcl`. Catches an account that moved while the backend file did not, which would otherwise write state into the old account and say nothing. |
| `FSS_AWS_REGION` | the region, if it is not `us-east-1` | Sets `AWS_REGION` in both rehearsal workflows and `TF_VAR_aws_region` for the plan. |

Neither workflow contains an account id or a state bucket name at all: the account is read from the session, and the bucket and lock table from the root's own `backend.hcl`. `test/release/accountAgnostic.check.ts` is what keeps that true.

And these **two**, which are **optional and should not exist until the cutover is scheduled**:

| Secret | Value | Until then |
|---|---|---|
| `FSS_REHEARSAL_CARRY_WATERMARK` | the cutover watermark instant being drilled | leave it unset |
| `FSS_REHEARSAL_CARRY_TABLE` | the old table the carry reads | leave it unset |

With **both** unset the carry step prints exactly `carry drill skipped: no cutover watermark yet`, the release record carries `"carryDrill": "skipped_no_watermark"`, and the halves of Appendix G 20 that need no cutover — the old stack has no writer, no root names a legacy state key — still run. With **one** set the step fails: half a configuration is somebody halfway through something. `docs/decisions/g12c-the-carry-drill-waits-for-a-cutover.md` has the reasoning.

**There is no `FSS_REHEARSAL_DATABASE_URL`, and there must not be.** The database the Appendix G suite runs against is created by the run's own apply and destroyed at its teardown, so a stored URL could only ever name a database that no longer exists. The workflow assembles `FSS_TEST_POSTGRES_URL` inside the job from three outputs of the run's root — the endpoint, the database name, and the RDS-managed master secret read with the rehearsal role — masks it with `::add-mask::` before it can reach a log, and never echoes it. Terraform never saw that password either: `manage_master_user_password` leaves generation and rotation to RDS.

Until the environment exists, the workflow's `rehearsal` job cannot start and its `dry-run` job runs on every pull request without a credential. That is the intended state, not a failure.

### 1.4 Sending prerequisites, which take days

SPF, DKIM and DMARC on the Callie sending domain, and Google Postmaster Tools. Already present in Route 53 per the account identifiers note; the *policy values* are checked at the sending-enable checklist in section 6, because 12.7 makes passing authentication a precondition and the database enforces it (`sending_domains`' CHECK forbids `automated_sending_enabled` without all three plus a Postmaster review).

### 1.5 The `pg_trgm` extension

Migration 0005 creates the trigram indexes CRM search is fast with. `CREATE EXTENSION` needs `rds_superuser`, which the migration role does not have, so it is a one-off you run against the fresh instance **before the first migration**:

```bash
psql "$DATABASE_URL" -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm;'
```

Do it for the production instance and for each rehearsal instance. If you forget, migration 0005 fails and says so; nothing is damaged, and you run it and migrate again.

### 1.6 What goes in each Google secret, and what no longer does

The task definitions inject Secrets Manager values into environment variables named after the secrets. Each Google secret carries **two fields and no more**:

```json
{ "client_id": "<from the Google console>", "client_secret": "<from the Google console>" }
```

Both are refused by name when absent: the process will not start and the log line says which field is missing, never its value. Two secrets have this shape:

| Secret | Client | Redirect URI Google must have registered |
|---|---|---|
| `fss-prod/google-gmail-oauth-client` | `fss-greenfield-gmail` | `https://api.usecallie.com/oauth/gmail/callback` |
| `fss-prod/google-oidc-client` | `fss-greenfield-oidc` | `https://api.usecallie.com/auth/google/callback` |

They are **different clients**. 5.1 keeps sign-in (`openid email profile`) and the Gmail grant (`gmail.readonly`, `gmail.send`) apart, and the API refuses an id token whose `aud` is not exactly the sign-in client id — so pasting one client into both entries fails at the first sign-in rather than quietly working.

**What changed in G12b.** Two *public* identifiers used to travel inside the Gmail secret because nothing in the task environment carried them. They are now Terraform's, in both services' environment:

| Environment variable | Where the value comes from |
|---|---|
| `FSS_GMAIL_PUSH_TOPIC` | the production root's `gmail_push_topic` variable, whose default is the topic `infra/roots/production-google` owns (8.0ar); `terraform output gmail_push_topic_id` prints it |
| `FSS_GOOGLE_HOSTED_DOMAIN` | the `google_hosted_domain` root variable, `usecallie.com` |

You set neither by hand; the apply does. The bootstraps still read `push_topic` and `hosted_domain` out of the secret JSON **if the environment does not carry them**, so a deployment written against the older shape still starts — for one release. `docs/decisions/g12b-two-public-identifiers-move-out-of-the-secret.md` says when that fallback goes and what has to be true first. The startup line reports which source each came from (`push_topic_source`, `hosted_domain_source`), so you can confirm the move landed without reading a task definition.

When neither source has one, the process refuses to start and names **both** places it looked.

### 1.7 Google application-default credentials, on your Mac

`infra/roots/production-google` is the only root that declares `provider "google"` (lane g85, 8.0ar). It holds the Gmail push objects and is planned only when one of them changes, and Terraform configures every provider a configuration requires before it evaluates anything, so a plan of it needs a working Google credential and without one stops at provider configuration with "Attempted to load application default credentials … No credentials loaded." A **production** plan needs none once the one-time migration (`docs/greenfield/google-root-migration-runbook.md`) has taken the four push objects out of the production state; until then it still does.

Once per machine, as the account that administers `callie-fss`:

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project callie-fss
```

`docs/greenfield/infra-apply-runbook.md` **1.3a** has the full procedure: enabling the Pub/Sub API, the two checks that the credential exists and can mint a token without printing any part of it, and why a downloaded service-account key file is refused by name rather than merely discouraged.

Nothing in the **rehearsal** needs this. The rehearsal root declares no Google provider and creates nothing in Google Cloud, which is why a CI run has no Google credential and must not be given one (`docs/decisions/g12j-the-rehearsal-has-no-google-provider.md`).

---

## 2. The images — CI publishes them, David promotes them

Nothing is built on a Mac. CI builds, pushes and verifies both `linux/arm64` images, and production receives a copy of those exact digests (8.0al).

### 2.0 The order, and why the desktop build is last

Everything in this document hangs on one string: the commit you are releasing. Fix it before anything else, because four separate things have to agree about it.

```bash
git rev-parse HEAD     # this is the release commit, and the desktop commit stamp
```

The desktop commit stamp **is that value**. It is not something a build produces and a person then copies: the signed Electron bundle carries it because it was built from that commit, and `rehearsal-release-record.sh` records it because you typed it. So the order is:

| # | Step | Who | Why it is here and not earlier |
|---|---|---|---|
| 1 | Fix the release commit; take the two digests CI published for it (2.1 below) | CI publishes, David reads | The digests are the release's identity. |
| 2 | Run the rehearsal with `desktop_commit_stamp` = the release commit (section 3) | CI | The record can name the commit before any Mac build exists, because the stamp is the commit. |
| 3 | Apply production Terraform (section 4) | David | This is what creates the CloudFront distribution the Mac updates from. |
| 4 | Set the repository variable `FSS_UPDATE_CHANNEL_URL` to `terraform output -raw` of `updates_distribution_domain_name`, as `https://<host>/` | David | It does not exist until step 3, and GitHub will not hold an empty variable. |
| 5 | Run *Greenfield desktop* with **release** ticked, on the release commit, passing the same commit as `desktop_commit_stamp` | CI | It refuses without step 4, because a build with no channel installs once and never updates. |
| 6 | Download the artifact, publish it, install it (`docs/greenfield/install.md`) | David | The one step that changes what every Mac sees. |

**Why the desktop build is last rather than first.** The obvious order — build the Mac app, take its stamp, feed it to the rehearsal — cannot run: the release job needs `FSS_UPDATE_CHANNEL_URL`, which needs the production apply, which comes after the rehearsal that was supposed to be waiting for the build. Making the stamp a fact about the commit rather than an output of a build breaks that circle and removes a copied string. `docs/decisions/g13b-the-stamp-is-known-before-the-build.md` has the reasoning; `docs/decisions/g13b-an-absent-channel-url-is-a-refusal.md` has why step 4 is a refusal rather than a default.

**What checks the agreement.** The desktop workflow refuses a `desktop_commit_stamp` that is not the commit the run is on, before it builds; and after it builds it compares the commit in the signed manifest — which is read out of the stamp inside the asar, inside the code signature — with both. At enable time (section 6) you compare the release record's `artifacts.desktopCommitStamp` with the commit the run summary printed. They are the same forty characters or sending does not get enabled.

**The API admits the desktop by its release line, not by its number (since 8.0aj).** Every sign-in, renewal and command is checked against the API's client-version policy (`CONTAINER_CLIENT_VERSIONS` in `apps/api/src/bootstrap/main.ts`). It has a `minimum`, a compatibility `ceiling` such as `1.x`, and an `incompatible` list of known-bad builds. Any build from the minimum to the top of the line that is not listed is admitted, even one built after the API was deployed. The API publishes the line's top as the maximum, `1.999.999` for `1.x`, so the Macs already installed read it with no change. The order is:

- **A desktop-only release publishes directly.** This is a new 1.x build that needs no route and no response field the deployed API lacks. There is no API deployment.
- **The API goes first only when the desktop needs something the deployed API does not have**: a new route, a new response field the desktop reads, or a migration. Deploy the API, smoke, then publish the desktop.
- **A new value in a closed vocabulary goes the other way.** Ship the desktop that knows it first; installed Macs refuse a value they do not know (`docs/decisions/g78-one-wire-contract.md`).
- **A known-bad build** goes on `incompatible`, which is an API deployment. **A breaking change** raises the minimum or moves to a `2.x` line.

Until 8.0aj the maximum was the exact latest desktop, so every desktop release needed an API first: 1.0.1 (8.0x), 1.0.2 with migration 0016 (8.0ab), 1.0.3 (8.0ad) and 1.0.4 (8.0ae). 1.0.5 is the last one. The API in production still publishes 1.0.4 as its maximum, so the API carrying the ceiling is deployed first, once (8.0aj). `docs/decisions/g78-version-ceiling.md` has the design.

**The first release, today.** Eight of the nine desktop signing secrets are not set and this Mac holds only an Apple Development identity, so the release job fails closed at its first step and names them. That is the intended state. `docs/greenfield/install.md` lists every one.

### 2.1 The images

1. **The digests come from CI.** Every push to main that changes an image input runs *Greenfield images*. Its `publish` job pushes `fss-rh-api:ci-<commit>` and `fss-rh-worker:ci-<commit>`, pulls both back by digest, runs `infra/scripts/release-images.sh verify` on what it pulled, and uploads the artifact `fss-image-digests` (`image-digests.json`, `fss.image-digests.v1`). A commit that changed no image input has the images of the last one that did; `release-images.sh pin <commit>` finds them, and the monthly drill pins that way. The digests (`sha256:` and 64 hex characters), not the tags, are what everything downstream compares: `infra/modules/cluster` and `rehearsal-release-record.sh` both refuse a mutable tag.
2. **The rehearsal deploys those digests** from `fss-rh-api` and `fss-rh-worker`, the two stable repositories `infra/roots/rehearsal-registry` owns. Dispatch it with the two digests (section 3).
3. **Production gets a copy, never a rebuild.** With the admin profile, from a checkout of main:

   ```bash
   # After a green full rehearsal: its fss-release-manifest artifact.
   infra/scripts/release-promote.sh release-manifest.json
   ```

   An app-only change is not promoted by hand. *Greenfield deploy* runs `release-promote.sh image-digests.json --app-only` itself, as `fss-prod-ci-deploy`, once it has decided the change is app-only (4.0). The same command with the admin profile is the fallback when that workflow cannot run.

   Each digest is copied from `fss-rh-*` to `fss-prod-*` with `docker buildx imagetools create --prefer-index=false`, a carbon copy of CI's bare manifest, and the tag is read back. If the tag names anything else, the image itself must be in production, and it is tagged there by its own manifest (`<tag>-image` when the release's tag is taken) and read back again. A digest production already holds under a tag is not copied again; one it holds untagged is tagged in place. A tag that already names another image is never overwritten. `docs/decisions/g86-the-promotion-copies-a-bare-manifest-as-itself.md`.

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
| `schema` (default) | every release that changes the schema, the infrastructure or a release script; an app-only release needs none (deploy and smoke), a desktop-only one needs none (build and publish) | create → fill the entries → migrate, then worker, then API (`release-deploy.sh --schema-change`) → bootstrap the workspace → the declared schema ranges against the deployed images → the production smoke script against the rehearsal → tear down → the guard. No drill evidence, no release suite (it already runs in the pull-request gate on every commit), no restore drill, no journal or carry drill, and **no release record or manifest** | about 45 minutes: create about 17, deploy about 12, the bootstrap, the ranges and the smoke about 5, and the teardown; the job stops at 90, and each long step has its own limit so a hang still leaves the teardown its time |
| `full` | the first Sunday of each month at 06:00 UTC, from *Greenfield monthly restore drill* (`greenfield-monthly-drill.yml`), pinned to main's commit; and by hand whenever you want the drill before a release | everything in the numbered list below: the schema run plus the drill's evidence, the release suite, the restore drill, the journal replay and Gmail reconstruction, the carry drill, and the release record and manifest | up to the 180-minute timeout |

The weekly scheduled full rehearsal (lane g74) is off: its workflow became the monthly drill, which wakes at 06:00 and hourly on Sundays and runs only on the first Sunday of the month at `FSS_MONTHLY_DRILL_HOUR_UTC` (default 6; `off` pauses it). **To run the drill by hand,** at main: Actions → *Greenfield monthly restore drill* → Run workflow on `main` with `dry_run` unticked, or `gh workflow run greenfield-monthly-drill.yml --ref main -f dry_run=false`. A dispatch left at `dry_run` only pins and prints. To drill digests of your own, dispatch this workflow with `mode: full`. The freshness check (`greenfield-freshness.yml`) alarms when no green `full` run from main is younger than `FSS_DRILL_MAX_AGE_HOURS` (864, thirty-six days); the old `FSS_WEEKLY_REHEARSAL_HOUR_UTC` and `FSS_WEEKLY_MAX_AGE_HOURS` variables are no longer read.

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
| `full` (default) | the declared ranges against the deployed images; and in `mode: full` the release suite, the drill's evidence and the restore drill, the journal replay and Gmail reconstruction, the carry drill, and the release record | in `mode: schema`, that the new schema and both images agree in a real environment; in `mode: full`, the release gate of 16.2, which is everything in the numbered list below | about 45 minutes (`schema`), up to the 180-minute timeout (`full`) |
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

**`fss-rh-202609211659` needs one command before its teardown, and only that run does.**
The exemption is in the repository; the *bucket* carries the old policy, and S3 evaluates
the policy on the bucket. The good news is that `s3:PutBucketPolicy` was never in the
deny list — the deny covers deletion and lock weakening, not policy replacement — so the
policy can be replaced, and it can be replaced by your own admin principal. (An explicit
`Deny` on `Principal *` in a bucket policy applies to every principal in the account
including you; what it cannot deny is the account **root**. `PutBucketPolicy` is not
denied to anybody, which is the whole reason this is recoverable without a root session.)

That run never reached its deploy stage, so nothing was ever written to the bucket: there
are no journal objects, the one-day GOVERNANCE lock is locking nothing, and no
bypass-governance is needed.

```bash
BUCKET=fss-rh-202609211659-suppression-journal-326255650484

# Read what is there now, so the replacement is a decision rather than a guess.
aws s3api get-bucket-policy --bucket "$BUCKET" --query Policy --output text | python3 -m json.tool
aws s3api list-object-versions --bucket "$BUCKET" --query 'length(Versions || `[]`)'   # expect 0

# Replace it with one that admits the run's own deployer. Nothing else changes.
cat > /tmp/journal-orphan-policy.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowTheRehearsalDeployerToRemoveThisOrphan",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::326255650484:role/fss-rh-deploy" },
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::fss-rh-202609211659-suppression-journal-326255650484",
        "arn:aws:s3:::fss-rh-202609211659-suppression-journal-326255650484/*"
      ]
    }
  ]
}
JSON
aws s3api put-bucket-policy --bucket "$BUCKET" --policy file:///tmp/journal-orphan-policy.json
```

Then Actions → *Greenfield release rehearsal* → `stage = teardown`, `run_suffix =
202609211659`, and any two well-formed digests that differ. On 21 September that run
(Actions 35649752231) destroyed the four resources the state held and the post-run guard
said production was untouched, but the bucket stood: the state never held the bucket
itself, and the teardown script of that commit named the journal bucket without the
account-id suffix the module appends, so its emptying step looked at a bucket that does
not exist and said "already absent". The finish was by hand, with an administrator's
session: `aws s3api delete-bucket` on the empty bucket (Object Lock does not prevent
deleting an empty bucket), then `aws s3api delete-object` on the run's now-empty state
object. From the commit carrying this paragraph the teardown names the bucket with the
account of its verified session and, after the destroy, deletes the bucket by name if
the destroy left it (`journal_bucket=gone` in `teardown.txt`).

What every teardown leaves, by design, is the run's empty state object under
`fss/greenfield/rehearsal/<prefix>/terraform.tfstate`: Terraform's S3 backend does not
delete state on destroy. It is a small file; delete it by hand when tidying, and nothing
else in that bucket.

The alternative is `create` then `teardown` at a commit carrying the journal change,
which also works — the apply rewrites the policy from the module — but it creates a whole
fresh environment, Multi-AZ RDS and all, to fix one bucket policy. Use it only if the
command above is refused, and read the plan first: it will propose one change to
`module.stack.module.journal.aws_s3_bucket_policy.journal` and the creation of everything
else, because that run's state holds only four resources.

Every run after this one applies the fixed policy from the start and needs only
`teardown`.

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
lifted out of the workflow and run by `test/release/scenario39.check.ts` against a
summary that leaks a hostname and one that does not. Terraform's diagnostics are on
stderr and still reach the log, which is what the stage exists to show.

What none of these stages proves is in 8.1, and the rehearsal's permanent limits are in
`docs/decisions/g12-what-the-rehearsal-cannot-prove.md`.

What the `full` stage does, in order, and why the order is the order. Each item is
tagged with the earliest stage that runs it, and a stage runs everything the stages
before it run. An item tagged `[full, mode: full]` is skipped by a `mode: schema` run;
everything else runs in both modes:

1. [plan] **Refuse anything that is not a digest.** Two `sha256:` values, and they must differ — one image pushed under both names is a mistake the gate can catch and a person cannot.
2. [plan] **Name the principal.** `infra/scripts/rehearsal-caller-identity.sh fss-rh-deploy` prints `aws sts get-caller-identity --query Arn` and refuses anything that is not `arn:aws:sts::…:assumed-role/fss-rh-deploy/<session>`. Every `terraform` command in this job then runs with `-var="assume_deployment_role=false"`, because this session already *is* the deployment role and the provider must not ask STS to assume the role it already holds (`infra-apply-runbook.md` 1.1). The flag makes the job's own credentials the thing the apply acts as, so this step is what makes it safe; it is the one the teardown repeats.
3. [plan] **Record the run's own resources.** `infra/scripts/rehearsal-prefix-guard.sh <prefix> before` reads, through `rehearsal_read_run_inventory` in `infra/scripts/rehearsal-common.sh`, every resource whose `Name` tag is the run prefix or begins `<prefix>-`, and records the sorted ARNs: nothing, for a fresh run, and the orphan's resources for a `teardown`. Item 14 compares against it. Until lane g97 this step recorded the **production** inventory instead, which was the one rehearsal command that named production on purpose; on the first credentialed run (Actions 35548888865) the rehearsal's own guard refused it — `FAIL: a rehearsal command names a production resource: Key=Name,Values=fss-prod*` — and G12f gave it the one exemption from that refusal. The read names nothing but the run now and goes through the ordinary wrapper, so there is no exemption: every command naming `fss-prod` is refused, and `infra/scripts/rehearsal-prefix-guard.sh <prefix> plan <file>` re-applies the refusal to the plan the dry run prints on every pull request and requires the read of the run's own resources to be in it, so a rehearsal that would refuse itself is red before a credential is spent.
4. [plan, then create] **Plan, then create.** The variables the root requires are written to `run.auto.tfvars.json` beside the root, the backend is initialised against this run's own state key, and `terraform plan -out` is run with the whole `-var` list. The `create` stage then applies, and names **no variable of its own**: Terraform loads `run.auto.tfvars.json` automatically from the root directory, which is the same mechanism the teardown's `terraform destroy` depends on. One list in one place is what keeps the plan and the apply the same values. The apply creates the rehearsal root with the run prefix and `bootstrap=true`, deploying both digests from the stable `fss-rh-api` and `fss-rh-worker` repositories. **Both services are created at desired count zero.** A fresh environment's database has no schema, and both binaries refuse to start unless the applied schema version is exactly the range they declare — so an apply that started them would create two services crash-looping against an empty database while the task that would fix it had not been launched. The run creates no repository of its own and its teardown removes none; `infra/roots/rehearsal-registry` owns those two and was applied once, before the first push.
5. [deploy] **Fill every secret entry.** Terraform creates every Secrets Manager entry empty and never holds a value. In production you fill these two by hand (5.1); a rehearsal is unattended and an hour long, so it fills its own: `migration-database` takes the RDS-managed master credentials, because on a database that has never been migrated there is no other login role that can run DDL, and `app-runtime-database` takes a password generated in the runner. Both are masked before they can reach a log. This needs `secretsmanager:PutSecretValue` on `fss-rh-*` secrets on `fss-rh-deploy`, which it has held since the second credentialed run (8.0a, 8.0b).
6. [deploy] **Migrate, then deploy the worker, then the API.** `infra/scripts/release-deploy.sh infra/roots/rehearsal <prefix> --schema-change` — the *same script* you run locally for production (section 4.1). It refuses unless both services are at zero — on a fresh stack the apply created them there, and on a stack that already stood the create step ran `release-stop.sh` before the apply (lane g70) — then runs `fss migrate` as a one-off ECS task inside the VPC, then `fss admin database-users ensure`, then `fss verify`, then the worker to its declared count, then the API, then `fss verify` again against the running deployment. Never beside each other: the API's declared schema range needs the migration to have run. Until 21 September nothing in deployment ran a migration at all; the step was named for an order it did not perform.

    [deploy] **Then the first workspace and its admin**, as its own step between this one and item 7: `infra/scripts/release-bootstrap-workspace.sh infra/roots/rehearsal <prefix> --worker-digest D --slug rehearsal --display-name Rehearsal --admin-email rehearsal-admin@usecallie.com`. A migrated database has no `workspaces` row, and the scheduler's canary is inserted once per workspace — so an environment without one publishes no `CanaryCompletionAgeSeconds`, the `canary_stale` alarm breaches, and item 8's smoke has nothing to judge. That is exactly how the eighth full run failed (8.0p). It is the same script production runs, with `--environment production` (5.1a) and different values.
7. [full] **The declared ranges, against the deployed images** (`infra/scripts/rehearsal-schema-ranges.sh <prefix> --api-digest D --worker-digest D`): Appendix G 22's refusal cases, which only a real ECS task can answer. Each service image is launched as a one-off `--selftest` task through the same wrapper the deploy uses, with a declared schema range one below the one it was built with, and the *container* must refuse it — exit 12, `configurationInvalid` in both `API_EXIT_CODES` and `WORKER_EXIT_CODES`. The overlap case, the previous release's image against the current schema, runs **only when a `<prefix>-<service>-previous` task definition is actually registered**: nothing in this repository registers one and a first release has no previous image at all, so the report says `skipped_no_previous` rather than claiming a pass (8.0o).
8. [deploy] **Smoke** with the same `scripts/productionSmoke.mjs` production gets.
9. [full, mode: full] **Release suite (recorded mode, runner)**: the 42 scenarios (`npm run test:release`). The **mutation check** (`npm run test:release:mutation`), which breaks each trap in turn and requires the suite to go red, is not part of a rehearsal since lane g93 (25 September 2026): it runs once a day on main in `greenfield-nightly.yml`, and on demand there. The scenarios run in the runner against the job's own `postgres:16` service container, which is what they were built for. They do **not** touch the rehearsal database and could not: it is private — `publicly_accessible = false`, no NAT gateway, no bastion — so the step that used to assemble a URL from the rehearsal's outputs could never have connected. What runs against the rehearsal database is `fss verify` and `fss drill`, inside the VPC.
    [full, mode: full] **Before it, the evidence the drill has to reconstruct** (lane g40), as its own step between item 6's bootstrap and item 7: `infra/scripts/release-seed-drill-evidence.sh infra/roots/rehearsal <prefix> --worker-digest D --phase before --workspace-slug rehearsal`. `docs/greenfield/restore-drill.md` 0.1 needs an accepted send, a prospect reply, a prospect-originated opt-out, a salesperson's own manual suppression inside its ten-minute window and an ordinary CRM edit to exist *before* the restore target is read, and nothing in this repository could produce any of them in a deployed environment — so the drill's own refusal fired on every fresh rehearsal, which is how the ninth full run ended (8.0q). `fss admin drill seed-evidence` produces all five through the domain's own entry points. The drill then adds `--phase after` between the baseline and the restore, so the restore genuinely loses work, and waits for RDS to report a `LatestRestorableTime` past the evidence before reading the target at all. **Production is never seeded**: the script refuses any prefix that is not `fss-rh-<run>` and the command refuses unless `FSS_DEPENDENCIES=recorded`.
10. [full, mode: full] **Restore drill**, Appendix E steps 1 to 9, preceded by a session renewal and its identity check. The runner keeps the control plane (reading the latest restorable point, the restore itself, the wait, the teardown); two in-VPC tasks do the database work — `fss admin counts` for the baseline on the source, then one `fss drill` against the restored instance for steps 1 to 9, with one correlated log and per-step JSON. The runner reads the report and decides whether it is a pass, so a change to the tool cannot quietly relax the gate. It refuses to report a pass unless the baseline contained an accepted send, a reply, a suppression, a CRM edit and a migration — a drill against an empty database proves nothing. The drill task is fixed at `FSS_DEPENDENCIES=recorded` **in its task definition**, because `reconcile-sent`, `recover` and `watch-renew` all reach Gmail when it is live and a mode a caller passes is a mode a caller can forget. The restored instance reaches the drill task only as the `FSS_DATABASE_HOST` override. `--database-host` stays the primary host the task definition names, which is what the run-task wrapper checks the definition against (lane g48). Run 35962272085 (24 September) passed the restored endpoint as both, and the wrapper refused the drill's first task after a restore that had succeeded. That first item of the deferred drill work is fixed in code. Run 35976297919 (24 September) proved it and showed where the drill stops next. The task started against the restored instance and stopped at its first write, a step-0 baseline file in `/tmp/fss-drill`, which nothing in the container created. The baseline the runner measured on the source was not handed to the drill task either (8.0w). Lane g53 fixes both in code: the drill creates its reports directory before its first write, and the runner hands the drill task the source baseline as `--baseline-json`, one line holding the `asOf` instant and the five counts, instead of `--as-of`. Run 36062337914 (24 September, 22:45Z) passed step 0 and stopped at step 1, because nothing anywhere opened a restore hold (8.0aa). Lane g56 closes that. The runner refuses a baseline without `systemGeneration` before the restore. It launches the drill with `--expected-generation` set to that value plus one, so step 1a runs the worker's own generation check against the restored copy. After step 9, `step9-generation-reconciled` asserts the database landed on that pin. After the drill, the runner reads the mismatch line in the drill's log and a transition to ALARM in the history of `<prefix>-restore-generation-mismatch`. Lane g59 gives steps 1 to 9 the evidence they have to find (`restore-drill.md` 0.1). The evidence comes in three phases: `before`, the release step, which now also makes a late opt-out's firm, a phone route and an administrative pause; `in-flight`, just before the target, one send left `reconciling` for step 3; and `after`, once the restore has been requested, a late opt-out the restore loses, for steps 2 and 4. The runner then counts the source again and hands the drill those counts as `--at-failure-json` for step 8, the three phases' recorded mailboxes merged as `--mailbox-recording-json`, and the seed's admin as `--admin-user` for step 9. In recorded mode a task that carries `FSS_ENVELOPE_KEY_ID` wraps refresh tokens through KMS under the context `fss_envelope_seam = recorded`, and outside production the drill role may decrypt under that context and no other. Lane g60 gives the dial probe its subject. The `before` phase registers the rehearsal admin's calling number and attests it through the domain, the same path a salesperson takes on the Settings screen. Step 1 now also requires `restore_in_progress` among the holds that apply to the refused dial, in the drill and in the runner's verdict. A rehearsal's probe is otherwise refused `posture_missing` whether or not a restore is in progress (8.0ab). The drill prints its whole report even when it fails. A database with no attested number still gets `step1-dial-refused` unanswered, and the runner fails the run on it (item 12 of 8.1 as it stood on 25 September, in `release-records.md`). Lane g73 closes Appendix E.3's missing fences (8.0ah). Step 3 also lists every Sent folder and tombstones each FSS send whose fence the restore lost. The `after` phase sends a step the `before` phase enrolled so that there is one. The runner requires `step3-missing-fence-tombstoned` and `step5-no-second-send`.
11. [full, mode: full] **Suppression journal replay and Gmail reconstruction**, against the recorded fake (no real mailbox in rehearsal unless you provide a rehearsal Google project). The second replay must insert nothing; no send may repeat. The drill above already ran both; this step reads the reports it left, which the drill wrote out of the captured task report under the names they have always had.
12. [full, mode: full] **Carry watermark** (Appendix G 20): the carry tooling must contain no writer at all, and — once a cutover is scheduled and the two optional secrets exist — the export must refuse a table with a post-watermark write. Before the cutover the step prints `carry drill skipped: no cutover watermark yet` and the record says `"carryDrill": "skipped_no_watermark"`. That is not a pass being claimed; it is the state being named.
13. [every stage] **Tear down**, always, with bypass-governance — and tolerantly, on a session renewed immediately before it so that a run which has already outlived its first hour can still destroy what it made. The teardown is five steps (any one-off task still running, the restored instance, any manual snapshot carrying the run prefix, the object-locked journal objects, the root), and each treats the AWS error code for absence as "already done" rather than as a failure, because `if: always()` means it runs after a creation that never happened. A failure that is *not* an absence — an `AccessDenied`, a throttle — still stops it, and an unreadable state that is not "the root was never initialised" still stops it. The report says which: `destroyed=true`, or `destroyed=nothing_created`. `terraform destroy` requires every variable `apply` did, so the step that opens item 4 writes them to `run.auto.tfvars.json` beside the rehearsal root (identifiers only, ignored by `infra/.gitignore`) and the teardown refuses to destroy without that file rather than fail on a missing variable and leave the environment standing. To tear a run down by hand from a fresh checkout, recreate the file first: `name_prefix`, `api_image` and `worker_image` (`<repository>@<digest>`, from the release record or the run's inputs), `certificate_arn`, `api_hostname`, `assume_deployment_role: false`, `bootstrap: true`, and the two schema ranges read from `packages/domain/db/schemaRange.ts`; then run `rehearsal-teardown.sh <prefix>` from the root directory as the `fss-rh-deploy` session.
14. [every stage] **Assert nothing with the production prefix was touched**, always, in either mode, including on a run that created nothing. The guard classifies every name it sees: the run's own resources, the two stable rehearsal repositories that carry no run, and anything production's — which it refuses. It then checks that the state it lists names nothing production's and that the session is an `fss-rh-` role, and compares **the resources carrying this run's own prefix** against what item 3 recorded before creation: every durable one the run created must be gone after the teardown. A state it cannot list is reported as "the run created nothing" rather than swallowed, and the comparison still runs. A record made only by a dry run is refused rather than compared: the workflow records the sentinel `["dry-run: no inventory was read"]` when it validates the prefix, and comparing against that would be a pass nobody earned. **Why it no longer compares production (lane g97, 25 September 2026).** Until g97 this step diffed the production inventory recorded before the run against the one read after it. The diff was of a thing that moves for reasons of its own: it had already been taught that ECS forgets a stopped task (run 35962272085, 8.0v) and that a replaced task takes its network interface with it (run 36032732128), and on the night of 25 September it failed a rehearsal only because the operator applied production while the rehearsal ran. A comparison that fails whenever production is legitimately changed measures the operator, not the rehearsal, so it is dropped; the comparison is of the run's own resources, and that nothing production's was touched rests on what made it true before as well — no rehearsal command names production (checked on the printed plan, and refused at the call), the session is `fss-rh-deploy`, and that role's policy is scoped to `fss-rh-*`. **What the comparison sets aside**, by parsed service and resource type, is what AWS keeps listing after it accepted a deletion: every `ecs` ARN (a stopped task for about an hour, a deleted service or cluster while INACTIVE, a deregistered task-definition revision for good), EC2 ARNs whose resource part begins `network-interface/` (a Fargate task's interface goes with its task), `kms` keys (a key is only scheduled for deletion), and RDS `auto-backup:` ARNs (the database module keeps automated backups). The guard logs each class it set aside. The database and its snapshots, the buckets, the load balancer, the log groups, the alarms, the secrets and the network are compared. A leftover is read again up to five times a minute apart before it is called one, because the tagging API lags a deletion. The guard runs in dry mode on every pull request, so every branch is exercised without a credential.
15. [full, mode: full] **Write the release record**, last, and the manifest beside it. It names the two digests, the desktop stamp, and a `releaseGateReference`. It is `release-record.json` in the run's `rehearsal-reports-<prefix>` artifact. Since lane g96 it is not the record a release puts: that comes from the CI gate (4.2). `fss admin release-record put` still accepts a rehearsal record, and it binds the same way.

If any step fails, steps 13 and 14 still run and no record is written. That is the design: there is no such thing as a partially passed release gate — and it is why a `plan`, `create` or `deploy` run, and a `mode: schema` run, writes no record either. A stage that stopped early and a stage that was never asked to go that far look the same to section 6, which is the correct answer to both.

### 3.1 Watching it without credentials

Every pull request runs the `dry-run` job, which prints the entire plan — every `terraform` and `aws` invocation the rehearsal would make, in order — with no credential present. Read it before you run the real thing. You can run the same thing locally:

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

**The digests.** For a schema release, `api_image` and `worker_image` are the release's digests from section 2, not the tags. For an infrastructure change they are the digests production runs, which `infra/scripts/deployed-digests.sh fss-prod` prints — never the ones in the last plan anybody applied, because CI has moved them since (4.0, the drift rule).

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
| `alert_emails` | `["callie@usecallie.com"]` | Each address confirms once by hand (5.3 below). |

**The deployment environment variables this release adds.** Both task definitions need them, and all five are Terraform's — there is nothing to type at apply time unless you are changing one:

| Variable | Production value | Root variable |
|---|---|---|
| `FSS_DEPENDENCIES` | `live` | `dependencies_mode`, default `live` |
| `FSS_RESEARCH_PROVIDERS` | `none` (worker only) | `research_providers`, default `none` |
| `FSS_SENDING_ENABLED` | `false` until section 6 step 4 | `sending_enabled`, default `false` |
| `FSS_GMAIL_PUSH_TOPIC` | the Pub/Sub topic id | `gmail_push_topic`, whose default is production's (8.0ar; the rehearsal passes a placeholder) |
| `FSS_GOOGLE_HOSTED_DOMAIN` | `usecallie.com` | `google_hosted_domain` |

Until G12c none of the first three could be set at all: `extra_environment` existed on the stack module and no root exposed it, so an apply produced two services whose tasks exit at startup naming a variable no plan could set. `docs/decisions/g12c-the-deployment-flags-are-root-variables.md`.

`FSS_DEPENDENCIES` has no default **in the binary**: an unset one is a refusal to start, which is deliberate (`docs/decisions/g12-the-credentialed-bootstrap.md`); the root's default is what makes sure it is never unset. `dependencies_mode` refuses `none` outright and accepts `recorded`, which the binaries then refuse in a production environment — the rule lives in one place rather than two that can disagree. `FSS_RESEARCH_PROVIDERS=none` is a declaration that this build ships no live research adapter, not an accident. The last two need nothing from you; they are listed so that a startup line reporting `hosted_domain_source: "secret"` reads as "the apply has not landed yet" rather than as a mystery.

There is also `extra_environment` (`map(string)`, empty) on both roots, for whatever the next release needs before it earns a variable of its own. Never a credential: secrets reach a container only as a Secrets Manager reference, and the root test asserts no environment name looks like one.

**What the API refuses to start without.** A live API now builds Google sign-in or exits with `api_deployment_refused`. The parts are the `google-oidc-client` secret, `FSS_PUBLIC_ORIGIN` (the redirect is `https://api.usecallie.com/auth/google/callback`, derived rather than configured twice), `FSS_GOOGLE_HOSTED_DOMAIN`, and `session-signing-key`. `--selftest` prints `sign_in`, `sign_in_client_configured`, `sign_in_redirect_configured`, `sign_in_hosted_domain_configured` and `session_signing_key_configured` — names and booleans, never a value. Before G12b the API started without any of it and refused every command; see `docs/decisions/g12b-sign-in-is-configured-or-the-api-refuses.md`.

**A desktop release is not a reason for this section.** Since 8.0aj the API admits every 1.x desktop from its minimum up, so publishing a desktop build needs no apply and no deployment, unless 2.0 says the API goes first. Confirm the published range with `curl -fsS https://api.usecallie.com/auth/client-version`. After 8.0aj it reads `"supported":{"minimum":"1.0.0","maximum":"1.999.999"}`.

### 4.0 App-only changes deploy themselves, and the two manual paths (lane g91)

David's decision of 25 September 2026: *"I'm a startup, I want to move fast."* When *Greenfield images* publishes the images of a push to main, *Greenfield deploy* (`.github/workflows/greenfield-deploy.yml`) deploys them to production as `fss-prod-ci-deploy`, the role `infra/roots/production/ci_deploy.tf` declares. It trusts one OIDC subject, this repository's `production-deploy` environment, and holds no state, secret, database or IAM write.

```
run (no credential) → gates (no credential) → ranges (images commit, no credential) → deploy (credential): artifact → guard → check → gates again → promote → worker → API → canary age → smoke (images commit, no credential) → record (credential): gates again → build → put → one line
```

- **gates** (lane A1) holds no credential and checks nothing out. It asks the GitHub API three things about the images commit, and the deploy job starts only when all three hold:
  - the *Greenfield gate* has a run of the push to main at that commit, found by its workflow file `.github/workflows/greenfield.yml` and never by its display name, and the newest such run is `completed`/`success`. GitHub reports a run as its latest attempt, so a re-run still going is waited for and a re-run that failed is red;
  - the *Source security gate* (`.github/workflows/ci.yml`) likewise;
  - the commit is still on main: `GET /repos/{owner}/{repo}/compare/main...<commit>` answers `behind` or `identical`, so a commit force-pushed off main is never deployed.

  It waits up to thirty minutes for a gate that is still running or has not started. Then, or at once for a red gate or a commit no longer on main, it answers `manual` with the reason: a green run, a notice, nothing touched, no role assumed. The deploy job runs the same step again, waiting for nothing, after `check` and before its first write, and the record job runs it before the put. Either of those fails the run red, writing nothing more, when the answer has changed.
- **Two jobs hold a credential, deploy and record, and neither runs code from the images commit before the deploy's guard.** The schema ranges are read from the images commit by a job with no `id-token`, and reach the credentialed jobs as two validated scalars. The smoke runs from the images commit in another job without a credential; it is handed the canary age as a scalar. Both credentialed jobs check out the images commit exactly — never main's tip — run only `infra/scripts/`, and run no Node at all. The record job starts only after the deploy decided `deploy`, so the guard has already proved `infra/scripts/` unchanged.
- **The guard** is the workflow's own inline code and runs before any of the repository's. It reads the commit production's images were built from: the `ci-<commit>` tag the promotion gave each running digest in `fss-prod-*`, or the bare commit an operator's own push was tagged with. Then it lists what every commit between that commit and the images commit touched. It reads commit by commit, so a change that was later reverted still counts. Rename detection is off, so a moved file counts at both its paths, and a merge is judged against its first parent. It answers `manual` — a notice and a list of paths in the summary, a green run, nothing touched — when any of these paths appears:
  - `infra/**`, every script in `infra/scripts/` included;
  - a migration;
  - the schema acceptance rule and the migration runner, with what they read: `packages/domain/db/schemaRange.ts`, `migrationRunner.ts` and `queryable.ts` (lane A1). `check` compares the declared ranges, so a change to how a version is accepted would otherwise pass it unseen;
  - `scripts/productionSmoke.mjs` or another release script;
  - `.github/**`;
  - a path the list does not know.

  It also answers `manual` when a running image has no commit tag, or when production's commit is not behind the images commit. It passes when every commit's paths are application code. Only then does anything from the checkout run, and that is `infra/scripts/`, which the guard has just shown is unchanged since production's own commit.
- **check** (`infra/scripts/ci-deploy-app.sh check`) reads and writes nothing. It answers `manual` in two cases:
  - the images declare a schema range the running task definitions do not, or `/health` reports a database version the images do not accept;
  - a service is not running exactly its declared count with nothing pending: desired zero is a schema release, and running short is an outage.

  It fails, touching nothing, in these cases:
  - the session is not one of `fss-prod-ci-deploy` in account `326255650484`, or the region is not `us-east-1`;
  - the cluster is not tagged `production`, or a service is mid-rollout;
  - the digests file is not the images run's own (commit, run id and attempt). The workflow downloads it from that run's `fss-image-digests` artifact, found through the run, uploaded by that run of that commit on main, and held to the digest GitHub recorded for it;
  - either digest differs from the one `fss-rh-<image>:ci-<commit>` names;
  - that image's `imagePushedAt` is outside the images run's window, from the run's `created_at` to its `updated_at` (lane A1). The window starts at the run's creation, so a re-run that reuses its first attempt's push is inside it;
  - `/health` does not answer.
- **deploy** repeats every read and guard first. It registers the next revision of each service's running task definition with only the image digest changed, describes it back and compares it with the running one field by field. Anything but the image different, and it deregisters the revision before any service names it. It then points the service at the revision: the worker first, waited on until ECS calls its one deployment `COMPLETED` with the declared count running and nothing pending, and held to its digest on every running task, read with `list-tasks` and `describe-tasks`; only then the API. The circuit breaker stays on. When ECS rolls a revision back, the deploy fails, nothing after it is touched, and the rolled-back revision is deregistered, so the newest ACTIVE revision is again the one that runs. The run prints the stopped tasks' stop and exit codes, and only the `event`, `reason` and `code` fields of their structured log lines, never a raw line. It never changes a count.
- **smoke** is `scripts/productionSmoke.mjs` at the images commit, with the canary age from `FSS/fss-prod`, expecting the sending state the task definition carries.
- **record** (lane g100) runs only after a deploy that rolled out and a smoke that passed. With no credential, it runs the gates job's step again: both gates green on the images commit and the commit still on main, waiting up to thirty minutes for a re-run still going. It fails, putting nothing, on any other answer. Then it assumes the role for an hour and runs `infra/scripts/ci-deploy-app.sh record`, which repeats every read and guard of `check` and refuses unless both services run exactly the two digests. It builds the ci-gate record with `release-record-from-ci.sh`, without `--enables-sending`, and puts it the way `release-deploy.sh --release-record` does: `fss admin release-record put --json-base64` on the operations task, reading the task's answer back from its log. The operations definition is Terraform's and carries the worker image of the last apply, so the put runs that image. The record it stores names this deploy's digests.

**What this lane accepts.** A job holding the role can register a revision of `fss-prod-api` or `fss-prod-worker` with any image in their two repositories and roll it out. IAM has no condition on a task definition's contents, and a main-branch workflow can deploy whatever main contains; that is the price of continuous deployment, and the script narrows it by deriving every revision from the running one. The limits are the `production-deploy` environment restricted to main, no `id-token` in a job that runs images-commit code, the exact OIDC subject, ECR writes only to the two `fss-prod` repositories, and unchanged task roles, because `iam:PassRole` names only the two services' existing four. `UpdateService` needs a task definition of the service's own family, so a bare `--desired-count 0` is refused; IAM cannot also forbid a count on a call that names one, and the script never sends one.

**Provenance, and what is left (lane A1).** A deploy runs only images whose digests came from the images run's own artifact, which `fss-rh-<image>:ci-<commit>` names, and which were pushed while that run was going. That refuses an image pushed under the tag before the run began or after it ended. What is left is another writer to the `fss-rh` repositories pushing the tag while the run is going. Only `fss-rh-deploy` can write there: the images run's publish job, the rehearsal workflows and an operator session that assumes it. A commit pushed to main a second time, which starts a second images run that reuses the first one's tag, fails that deploy on the window; release it by hand.

**Merges and rehearsals.** Deploys share one concurrency group and a running one always finishes; a waiting run replaced by a newer one is covered by the newer one's range. The deploy job and the rehearsal job of `greenfield-release.yml` share the group `fss-production-inventory`, so they exclude each other: every revision a deploy registers is a new `Name`-tagged production ARN, which a running rehearsal's inventory guard would see. GitHub replaces a job pending in a group with the next one to queue: a replaced rehearsal is dispatched again, and a replaced deploy is covered by the next. A poll before the role is assumed, and again before the first write, catches a rehearsal job that started without the group. The job allows 150 minutes and the credential two hours, twice the worst rollout of three ten-minute waits per service. A failed run's summary names the revisions each service had before and the ones it names now, as observed. `aws ecs update-service --cluster fss-prod-cluster --service fss-prod-<api|worker> --task-definition <previous>` puts one back.

**After a protected change, the next release is by hand.** A protected change in the range keeps answering `manual` until production runs images built after it. An infrastructure-only merge builds no images. So the rule is: apply the infrastructure change by the manual path, then release the first app merge after it by hand — `release-promote.sh image-digests.json --app-only` with the admin profile, and the rolling path of 4.1. Production's commit tag is then past the change, and the next app merge deploys itself again. There is no switch that tells CI a change was applied.

**CI puts the release record, and sending stays on (lane g100).** Once section 6 has run, the worker holds every send unless a stored record names its image. The record job puts one for every worker it deploys. Under the process form of the attestation (6, step 5: `ci-gate:main`), that record is all the new worker needs, and nobody attests again. Under an attestation that names one reference, a new worker still holds until the owner attests to its record.

**When the record is not put.** A gate may have been re-run red since the deploy, or not finish within thirty minutes, the commit may have left main, `release-record-from-ci.sh` may refuse, or the put may be refused. By then the deploy has rolled out and passed its smoke, so nothing is undone. The run goes red with one line: *the release record was NOT put, and sending holds for the new worker until the operator puts its record by hand (4.2)*. The fix, once the cause is gone, is one of these:
1. Re-run the failed `record` job from the run's page. It is idempotent: the same gate run builds the same record, and a second put answers `existing`.
2. Put it by hand, as the admin profile. Build the record with the 4.2 commands for the deployed commit, then run the put-alone command of 6, step 2, which runs on the operations definition as it is. Do not use `release-deploy.sh --release-record` here: its put holds the operations task to the new worker digest, and the operations definition carries the last apply's image until the next apply.

**The role's grant for the put.** `ecs:RunTask` on `fss-prod-operations:*`, conditioned on `ecs:cluster` being the production cluster. `ecs:TagResource` on the production cluster's tasks, only under `ecs:CreateAction = RunTask`, because the wrapper propagates the definition's tags onto the task. Nothing else is new. The operations task runs as the worker's task and execution roles, which `iam:PassRole` already names. It logs to `/fss/fss-prod/worker` under the prefix `operations`, which the log read already covers, and `ecs:DescribeTasks` was already there. IAM cannot condition a task's command, so a job holding the role could run any `fss` command on that task, as the worker's task role. It could already reach that identity by rolling a worker revision.

**Terraform and CI share the two service task definitions.** Both carry `track_latest = true` (`infra/modules/cluster`), so Terraform reads the family's newest ACTIVE revision — CI's — as its own, and the services still re-point on an apply that registers a revision. The migration, operations and drill definitions do not track: they are Terraform's, and carry the worker image of the last apply until the next one.

**The drift rule: every production plan starts from what production runs, and every apply checks it again.**

```bash
infra/scripts/deployed-digests.sh fss-prod      # api_image=… worker_image=… and the two schema ranges
(cd infra/roots/production && terraform plan -out=production.tfplan \
   $(../../scripts/deployed-digests.sh fss-prod --var-flags) \
   -var="certificate_arn=<production acm arn>" -var="api_hostname=api.usecallie.com" ...)
# immediately before the apply, with the two images the plan was made with:
infra/scripts/deployed-digests.sh fss-prod --compare "<api_image>" "<worker_image>" \
  && (cd infra/roots/production && terraform apply production.tfplan)
```

`deployed-digests.sh` refuses in three cases:
- a service's rollout is not finished: it must have one `PRIMARY` deployment that ECS calls `COMPLETED`, its declared count running and nothing pending, and every running task of that deployment's revision reporting its image digest (lane A1). A lone deployment is not enough, because ECS reports one `IN_PROGRESS` with nothing running yet. A service stopped for a schema release (desired zero) runs no task, and prints its revision's image;
- a family's newest ACTIVE revision is not the one its service runs, which Terraform would otherwise read. Deregister the stray revision it names first;
- with `--compare`, either image differs from the one running. A CI deploy has landed since the plan; plan again. A schema release plans with its own new images on purpose and passes `--allow-digest-change`.

The two manual paths:

1. **An infrastructure change.** Plan with exactly those four values. The plan shows no change to `aws_ecs_task_definition.api` or `.worker` or to either service. The exception is a change to a task definition, where it registers the next revision from the running images and re-points the service. **A plan that replaces either definition with an image other than the one `deployed-digests.sh` printed rolls production back: do not apply it.** After the apply, `release-deploy.sh infra/roots/production fss-prod --api-digest <deployed> --worker-digest <deployed>` holds the running tasks to those digests. Then release the next app merge by hand, as above.
2. **A schema change.** The release's digests and ranges, `release-stop.sh` before the apply, and `release-deploy.sh --schema-change` after it (4.1). Pass `--compare … --allow-digest-change` before the apply. CI refuses to deploy while the services are stopped or the images' range differs from production's, so it cannot race a migration.

**Set up once** (the operator, 25 September):
1. Apply the role from a plan of this root, given the deployed digests. The plan should create `aws_iam_role.ci_deploy` and `aws_iam_role_policy.ci_deploy`, set `track_latest` in place on `aws_ecs_task_definition.api` and `.worker`, change the outputs, and replace nothing. A plan that replaces a task definition or touches a service is not this change.
2. Create the `production-deploy` environment with `main` as its only deployment branch.
3. Give it the secret `FSS_PRODUCTION_CI_ROLE_ARN`: the public ARN that `terraform output -raw ci_deploy_role_arn` prints.
4. Set the four repository variables the record job launches the put with (lane g100). They are public identifiers, read from the production root's outputs after the apply that adds them, and never from state in CI:

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
[schema change: release-stop.sh]  →  terraform apply  →  all eight entries filled  →  fss migrate  →  database users  →  fss verify  →  worker  →  API  →  fss verify
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
infra/scripts/release-stop.sh infra/roots/production fss-prod --environment production

# 2. The apply, from the plan you read (infra-apply-runbook.md 3.2). It replaces the task
#    definitions and starts nothing: both services ignore changes to their count.
(cd infra/roots/production && terraform apply production.tfplan)

# 3. Migrate, verify and start: the command below, with --schema-change.
```

`release-stop.sh` asks for `--environment production` because it takes production down on purpose, the same extra word `release-bootstrap-workspace.sh` asks for, and it refuses a root that is not the prefix's, a cluster in another account, region or namespace, and a cluster tagged as the other environment. Run twice, it does nothing the second time. Plan before the stop and apply after it: the plan does not depend on the counts, and the outage starts at step 1, so keep steps 1 to 3 together. A first apply (`bootstrap=true`) needs no stop, because it creates both services at zero.

**An app-only release is CI's (4.0).** By hand — only when that workflow cannot run — it is the rolling path (8.0am): `release-promote.sh image-digests.json --app-only`, no stop, the apply with the release's digests, then `release-deploy.sh` without `--schema-change`:

```
terraform apply  →  worker count  →  API count  →  one wait  →  running-digest check
```

**You do not type the steps after the apply.** They are one script, and it is the same script CI runs for the rehearsal — the only differences are the root in argument one and the credentials in your shell:

```bash
export AWS_PROFILE=<the profile that can assume fss-prod-deploy>
export FSS_REHEARSAL_REPORTS="$HOME/fss-release-$(date -u +%Y%m%d%H%M)"

infra/scripts/release-deploy.sh infra/roots/production fss-prod \
  --schema-change \
  --api-digest "$API_DIGEST" \
  --worker-digest "$WORKER_DIGEST"
```

Read both first, without a credential, exactly as CI's dry run does:

```bash
FSS_REHEARSAL_DRY_RUN=1 FSS_REHEARSAL_REPORTS=/tmp/fss-plan \
  infra/scripts/release-stop.sh infra/roots/production fss-prod --environment production
FSS_REHEARSAL_DRY_RUN=1 FSS_REHEARSAL_REPORTS=/tmp/fss-plan \
  infra/scripts/release-deploy.sh infra/roots/production fss-prod \
    --schema-change --api-digest "$API_DIGEST" --worker-digest "$WORKER_DIGEST"
```

Why a script rather than four commands you can see:

- **The migration is a one-off ECS task, not something you can run.** The production database is private: `publicly_accessible = false`, no NAT gateway, no bastion. Nothing on your Mac has a route to it and nothing should. The only thing already inside the VPC that can reach PostgreSQL is the worker image, so `fss migrate` runs as a task using it, under a task role that exists for nothing else.
- **Every launch is checked before it is made.** `infra/scripts/release-common.sh` refuses a bare cluster name, a wrong account, a wrong region, a cluster tagged as the other environment, a task definition whose image is not the digest this release is about, a network configuration that is not the root's own public subnets under the worker security group, and a task definition resolving a credential entry this release did not name. Afterwards it reads the `failures` array, refuses a task that never started, refuses a stopped task with no exit code (which is not a zero), prints `stopCode` and `stoppedReason`, waits out the log-stream race, and records the task ARN so a retry waits on the task that is already running rather than starting a second migration.
- **The declared counts come from the plan.** The script scales the services to `terraform output deployment_plan`'s `declared_desired_count`, not to a number in a shell file that somebody has to keep in step with the root. Terraform sets a count only when it creates a service. After that both services ignore changes to `desired_count`, so an apply never moves one, and steps 5 and 6 of every deploy, rolling or schema, set the declared numbers explicitly.

`--schema-change` is the flag that makes it refuse unless both services are already at desired, running and pending zero. It no longer stops them itself: by the time it runs, the apply has registered the new task definitions, and a stop there is the defect 8.0af records. The refusal names the `release-stop.sh` command to run. Leave the flag off for a release that moves no migration: that is the rolling path. The apply replaces the two service task definitions and ECS rolls each service on to its new one at its current count. The script then launches no one-off task. It sets the worker's and then the API's declared count with `update-service --desired-count`, forcing no second deployment, waits once for both, and runs the running-digest check: each service has one deployment that did not fail, exactly its declared number of running tasks, every one on that deployment's task definition, and the release's digest in its container. A release that adds a migration but is deployed without `--schema-change` fails that check. Both `--api-digest` and `--worker-digest` are required on either path, and `bootstrap=true` without `--schema-change` is refused.

`--release-record <release-record.json>` (lane g71) is optional. When given, after the final verify the script runs `fss admin release-record put` on the operations task and prints the stored record. Pass the record `release-record-from-ci.sh` wrote for these same digests (4.2, lane g96). Without it nothing about the deploy changes. Section 6 is where it matters: an enable of sending is refused unless its reference is a stored record naming the running API's digest.

**The policy, and it is not negotiable.**

- **Stop-during-migration.** From migration 0006 onwards every declared range is a strict `{N,N}`, so there is no build of this software that straddles a schema change and no honest way to migrate without an outage. `release-stop.sh` scales the API to zero first — so no request reaches a schema that is about to move — then the worker, which is given time to release its job leases, and it does so **before** the apply registers task definitions that refuse the current schema. `release-deploy.sh --schema-change` then refuses to migrate unless both are still at zero.
- **The database never rolls back.** There is no down migration in this repository and there will not be one. `packages/domain/db/migrations` is forward-only and `loadMigrations` refuses a gap.
- **After a successful migration and a failed deployment there are exactly two paths.** *Forward repair*: fix the code, build a new digest, deploy it. Or *the restore protocol*: `docs/greenfield/restore-drill.md`, all nine steps, with sending and dialing held until step 9. Redeploying the previous digests is only a rollback when their declared ranges accept the current schema version, which after a migration they usually do not — `infra/scripts/rehearsal-schema-ranges.sh` computed that during the rehearsal and told you. What is never a path is undoing the schema.

### 4.2 The release record, from the CI gate (lane g96)

The worker sends only under a stored release record that names its image digest (lane g71). The owner's axiom 10B (25 September 2026) says where that record comes from: the CI gate that was green on the deployed commit, not a full rehearsal. `infra/scripts/release-record-from-ci.sh` writes it. It reads GitHub and nothing else, with no AWS call. It refuses in one `FAIL:` line, writing nothing, unless all of these hold:

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
- **No drill fields.** The record has no `rehearsalPrefix`, `carryDrill` or `rehearsalScenarios`, because a CI run drills nothing. The contract refuses a `ci-gate` record that claims one. A rehearsal record still needs all three, and is still accepted.
- **The same bytes twice.** `recordedAt` is when the gate run concluded, so a record built again for the same run is identical, and a second put answers `existing`.

The commands, from a checkout of main with `gh` signed in, then the profile and root of 4.1 for the deploy:

```bash
export REPO=david-cui-bruno/founding-sales
export COMMIT=<the release commit, 40 characters>
export GATE_RUN_ID="$(gh run list --repo "$REPO" --workflow greenfield.yml --commit "$COMMIT" \
  --event push --branch main --status success --limit 1 --json databaseId --jq '.[0].databaseId')"
export IMAGES_RUN_ID="$(gh run list --repo "$REPO" --workflow greenfield-images.yml --commit "$COMMIT" \
  --event push --branch main --status success --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run download "$IMAGES_RUN_ID" --repo "$REPO" --name fss-image-digests --dir /tmp/fss-ci
export API_DIGEST="$(jq -r .images.api.digest /tmp/fss-ci/image-digests.json)"
export WORKER_DIGEST="$(jq -r .images.worker.digest /tmp/fss-ci/image-digests.json)"

# 1. The record. Add --enables-sending for the release sending is to be switched on under.
GITHUB_REPOSITORY="$REPO" infra/scripts/release-record-from-ci.sh \
  "$GATE_RUN_ID" "$COMMIT" "$API_DIGEST" "$WORKER_DIGEST" --out /tmp/fss-ci/release-record.json

# 2. The deploy, which puts the record after the final verify (4.1 says when --schema-change applies).
infra/scripts/release-deploy.sh infra/roots/production fss-prod [--schema-change] \
  --api-digest "$API_DIGEST" --worker-digest "$WORKER_DIGEST" \
  --release-record /tmp/fss-ci/release-record.json
```

The script prints the reference to stderr. The put prints it back as `reference`, with `source: "ci-gate"`. Section 6 step 5's attestation names it.

**What the put trusts.** A schema-valid `ci-gate` record put by whoever can run the operations task is trusted: `fss admin release-record put` checks the record's shape and stores it, and does not verify its GitHub evidence (the gate run, the images run, the artifact). CI's record job or an admin who can run that task can therefore store one, and its provenance is not independently verified. The script above is what makes a record true, not the put.

**The CI deploy does this itself (lane g100).** After the rollout and the smoke, the `record` job of `greenfield-deploy.yml` runs the three steps below, with no `--enables-sending` (4.0):

1. Read the two gates and main again, as the `gates` job did before the deploy (4.0): the *Greenfield gate* and the *Source security gate* green on the images commit, each by its workflow file, and the commit still on main. It waits up to thirty minutes for a re-run still going, and puts nothing on any other answer.
2. Run `release-record-from-ci.sh <gate run id> <images commit> <api digest> <worker digest> --out "$RUNNER_TEMP/release-record.json"`, without `--enables-sending`. Actions already sets `GITHUB_REPOSITORY`, and the record job already has the `actions: read` that `gh api` and `gh run download` need.
3. Put the record, as `release-deploy.sh --release-record` does: `fss admin release-record put --json-base64` on the operations task. The network comes from four repository variables, and nothing reads Terraform state. `fss-prod-ci-deploy` holds `ecs:RunTask` on the operations family for this.

The commands above are the hand fallback when the record job fails (4.0, "When the record is not put"), and the path for a manual release. Switching sending on uses them too.

---

### 4.3 Migration 0018 (schema 18): LinkedIn's schema, the preflight, and the owner's decision (lane A4)

`0018_remove_linkedin.sql` removes what PR 234 left of LinkedIn in the schema. What it does to each stored value is in the file's header; in short:

- **kept where the owner sees it:** each contact's `linkedin_url` is appended to the contact's title (`Managing Partner · https://www.linkedin.com/in/…`), the one free-text field of a contact the desktop shows and lets a person edit; then the column goes;
- **converted without asking:** `linkedin_reply` leaves every version's `stop_conditions`, published ones included (the published-version trigger is set aside for that one statement), and the default and both CHECKs; `linkedin_task` leaves every hold's kinds (a hold that blocked only it blocks `removed`); a LinkedIn pause's channel, `open_and_copy`, `handed_off` and `linkedin_grace` become `removed`; a `linkedin_reply` end becomes `human_reply`; `linkedin_due` Today items are deleted and `today_snapshots.linkedin_due`, `today_refresh_card`'s count and `today_lane_of_kind`'s arm go, with the nonnegative CHECK added back over the four remaining counts;
- **kept as a marker:** a step's and an execution's channel stays `linkedin_task`, and both channel CHECKs keep admitting it. It is what lane A2's read-only representation keys on (`channel: 'removed', removedChannel: 'linkedin'`), what keeps a version's steps in place, and what `isStepChannel` refuses, so a held LinkedIn execution stays held. No step or execution row is deleted;
- **refused unless the owner decides:** a non-empty `sequence_steps.linkedin_message`, any row of `enrollment_linkedin_results`, or a contact URL that does not fit beside the title in 200 characters. The migration then raises `0018 refused: linkedin_message=N linkedin_results=N unfit_urls=N; …` (SQLSTATE `FS018`), `fss migrate` exits 20 with reason `linkedin_history_present`, and schema 17 is untouched. Only `fss migrate --remove-linkedin-history` — `release-deploy.sh --remove-linkedin-history` — lets it erase them.

Both service ranges become `{18, 18}`, so this is a stop-migrate-start release, and the trimmed rehearsal cannot prove the live path: it builds its database from zero. `packages/domain/test/sequences/removedLinkedIn.test.ts` proves 17 → 18 on seeded legacy rows; the preflight below reads production's own counts before anything is stopped.

**The order.** Every step before `release-stop.sh` leaves production running.

1. **Merge.** *Greenfield gate* and *Greenfield images* run on the merge commit. Download the digests as in 4.2 (`COMMIT`, `API_DIGEST`, `WORKER_DIGEST`, `GATE_RUN_ID`).
2. **The trimmed rehearsal, `mode: schema`:**

   ```bash
   gh workflow run greenfield-release.yml --ref main -f stage=full -f mode=schema \
     -f api_image_digest="$API_DIGEST" -f worker_image_digest="$WORKER_DIGEST" \
     -f desktop_commit_stamp="$COMMIT"
   ```

3. **Promote the two digests (2.1).** A `mode: schema` run writes no release manifest, so this is `infra/scripts/release-promote.sh /tmp/fss-ci/image-digests.json --app-only` with the admin profile (the flag's name predates the trimmed rehearsal). The preflight's image must be in `fss-prod-worker`.
4. **The preflight**, read-only, with production still running:

   ```bash
   export FSS_REHEARSAL_REPORTS="$HOME/fss-release-$(date -u +%Y%m%d%H%M)"
   infra/scripts/schema-preflight-0018.sh infra/roots/production fss-prod --worker-digest "$WORKER_DIGEST"
   ```

   It registers one revision of the operations family that differs only in the worker digest (the registered one runs the previous image, which has no `fss admin schema-preflight 0018`), runs the counts on it as the runtime identity in a READ ONLY transaction, prints the JSON, writes `schema-preflight-0018.txt`, and deregisters the revision on the way out. Read it without a credential first with `FSS_REHEARSAL_DRY_RUN=1`.
5. **The owner's decision on the counts.** `refusesWithoutSetting: false` needs none: nothing 0018 would erase is stored. `true` means the owner sees `stepMessages`, `recordedLinkedInResults` and `contactUrlsThatDoNotFit` and chooses: erase them (step 8 passes `--remove-linkedin-history`) or do not release 0018 yet. The other counts are what 0018 converts; show them too. The flag is passed on the owner's word only.
6. **`release-stop.sh`** (4.1).
7. **The apply**, with the new digests and both `api_schema_range` and `worker_schema_range` `{min=18,max=18}`.
8. **The deploy, with the record.** Build the `ci-gate` record for the merge commit with `release-record-from-ci.sh` (4.2), then:

   ```bash
   infra/scripts/release-deploy.sh infra/roots/production fss-prod --schema-change \
     --api-digest "$API_DIGEST" --worker-digest "$WORKER_DIGEST" \
     --release-record /tmp/fss-ci/release-record.json \
     [--remove-linkedin-history]   # only on the owner's word, step 5
   ```

   The record is put after the final verify, so it names a deployment that runs its digests.
9. **Smoke** (`scripts/productionSmoke.mjs`, as after every release).
10. **Publish the desktop** built from the merge commit (2.0).

**If 0018 fails in production.** The runner applies the file in one transaction, so a refusal or any error leaves schema 17 exactly as it was, with both services stopped and the apply's `{18, 18}` task definitions registered. Decide before step 6 which of these you will take; neither restores the database:

- **Forward, when the cause is the refusal:** the owner decides, and `release-deploy.sh … --schema-change --remove-linkedin-history` runs again from step 8. It refuses unless both services are still stopped, which they are.
- **Forward, when the cause is a defect:** fix it in a new pull request and release that from step 1; the services stay stopped until it is deployed.
- **Back to schema 17, when the outage must end first:** apply the previous release's digests with both ranges `{min=17,max=17}`, then `release-deploy.sh infra/roots/production fss-prod --api-digest "$OLD_API" --worker-digest "$OLD_WORKER"` with `--schema-change` unset. That is the rolling path: it scales both services to their declared counts on the previous images, which accept 17, and checks the running digests.

A 0018 that succeeded is never undone: 17 images cannot serve 18, and the database does not roll back (4.1). After success, a failed deploy is forward repair or the restore protocol.

## 5. The five manual steps after the apply

These are in the order they unblock each other. Doing 5.3 before 5.2 will not work, because Pub/Sub will not push to an endpoint whose certificate it cannot verify. 5.1 comes before the apply's deploy (4.1) and 5.1a comes after it, because 5.1a runs a command against the deployed database. 5.2a comes straight after 5.2, because Google sends the browser back to `api.usecallie.com`, and before 5.4, whose mailbox consent starts from a signed-in Mac.

### 5.1 The secret values, from stdin

Terraform created eight empty entries and never holds a value. Fill them **before section
4.1** — no task that names an empty entry starts (see "Every entry first" there):

```bash
aws secretsmanager put-secret-value --secret-id fss-prod/google-gmail-oauth-client \
  --secret-string file:///dev/stdin
# paste the JSON from section 1.6, then Ctrl-D.
```

Repeat for `google-oidc-client`, `session-signing-key`, `device-credential-pepper`, `llm-classifier-api-key` and `research-provider-credentials`. The two Google entries take the two-field JSON in section 1.6 and nothing else; the rest are single values.

**And the two database entries, which come first — before section 4.1, because the migration task cannot start without them.** `migration-database` takes the RDS-managed master user's `username` and `password` together with this instance's `host`, `port` and `dbname` (the master JSON carries only the credentials; `fss migrate` needs all five, which the independent review of 22 September caught before the first deploy did); `app-runtime-database` takes `{"username":"app_runtime_login","password":"<openssl rand -base64 48>","host":"<endpoint host>","port":5432,"dbname":"<database>"}`. `infra-apply-runbook.md` 3.3 has the two commands and the reason the master credentials are what goes in the first one: migration 0001 creates `app_runtime` and `migration` as NOLOGIN group roles, so on a database that has never been migrated there is no other login role that can run DDL and none can be created — the database is private. `fss admin database-users ensure` makes the runtime login user and grants `migration` to the master, so every later `fss migrate` passes its membership check for a reason.

After G12h **nothing in the cluster can read the RDS-managed master secret.** The two services resolve `app-runtime-database`; the migration task resolves `migration-database`; neither can resolve the other's.

`file:///dev/stdin` rather than `--secret-string '<value>'` so the value never reaches shell history or the process table. `session-signing-key` and `device-credential-pepper` are **base64 bytes, at least 32 of them, never PEM** — the API refuses PEM by name, because a PEM armour line in a repository is flagged by the history scanner in every commit it ever appeared in:

```bash
openssl rand -base64 48   # then paste that
```

If a value changes later, put the new value and force a new deployment of both services
so the tasks read it.

**On a redeploy, never re-put `app-runtime-database`.** It is filled once, when the
environment is created, and after that the password in it is a live PostgreSQL credential:
putting a fresh one leaves a secret the database does not accept, the services start and
fail their first connection, and — if the deploy is mid-migration — they sit at desired
count zero until `AWSCURRENT` is moved back to the version the database still agrees with.
That is deploy run 2 of the production release (8.0s). A rotation is two steps in one
maintenance, in this order: put the new value, then run
`fss admin database-users ensure --rotate-password`, which is the only thing that alters
the role to match — it takes the password from the secret it was handed and never from an
argument — and then force a new deployment of both services. `release-deploy.sh` runs
`ensure` **without** that flag on purpose, so an ordinary deploy cannot rotate a credential
the running services are holding. `migration-database` is the other entry and is
unaffected: fill it each deploy from the RDS master secret, exactly as above.

### 5.1a The first workspace and its admin

Run this **after 4.1** — it is one command against the migrated, deployed database — and **before 5.2 and the smoke**.

```bash
infra/scripts/release-bootstrap-workspace.sh infra/roots/production fss-prod \
  --environment production \
  --worker-digest <the worker digest this release is about> \
  --slug callie --display-name Callie --admin-email callie@usecallie.com \
  --sending-domain usecallie.com
```

`--sending-domain` (lane g57) registers the sending domain that section 6 item 3's checklist is recorded against. It is optional and idempotent: a domain that is already registered is reported `existing` and left untouched, checklist included. It needs a worker image built at or after g57; an older tool refuses the flag as `flag_unknown`.

It launches `fss admin workspace bootstrap` as a one-off task on the **operations** task definition, inside the VPC, under the runtime credential — the same wrapper, the same digest comparison and the same log-stream read as every other one-off task in 4.1. `--environment production` is required and is the only argument that differs from the rehearsal's: this command writes the first business rows of the environment, and production is named out loud or not at all.

It prints the tool's JSON report and writes a summary line into the reports directory as `bootstrap-workspace.txt`:

```json
{
  "workspace": { "id": "…-…-…-…-…", "slug": "callie", "displayName": "Callie",
                 "businessTimeZone": "America/New_York", "outcome": "created" },
  "admin": { "userId": "…", "email": "callie@usecallie.com", "outcome": "provisional_created" },
  "membership": { "role": "admin", "outcome": "created" },
  "sendingDomain": { "domain": "usecallie.com", "isPrimary": true, "outcome": "created" }
}
```

`sendingDomain` is `null` when the flag is not passed. The summary line in `bootstrap-workspace.txt` ends with `sending_domain=usecallie.com sending_domain_outcome=created sending_domain_primary=true`, or `none` in all three places when no domain was passed.

**`workspace.id` is what the desktop asks for.** The Mac's sign-in form has a Workspace field (`apps/desktop/src/renderer/renderer.ts`), and the UUID above is what goes in it. Keep the line; nothing else prints it.

**`admin.outcome: provisional_created` is normal on a first run.** The real Google `sub` cannot be known before that person signs in, so the row carries the sentinel `pending-email:<address>` until the first successful sign-in replaces it — `docs/greenfield/identity.md` and `docs/decisions/g39-the-first-workspace-and-its-admin-are-bootstrapped.md`. A row that says `adopted_user` means that address already had an account, which is also fine.

**Re-running is safe.** The command is idempotent in one transaction: it selects the workspace by slug and inserts only if it is absent, reuses the admin row it finds, and creates, leaves alone or reactivates the membership. A second run reports `existing`/`provisional_existing`/`existing` and writes no new row. It refuses a malformed slug, address or zone with exit 20 before touching the database.

**The `canary_stale` alarm breaches until this has run, and that is correct.** The scheduler's canary is inserted once per workspace (`apps/worker/src/scheduler/sources.ts`, `SELECT id FROM workspaces`), so an environment with no workspace publishes no `CanaryCompletionAgeSeconds` at all — and the alarm is `treat_missing_data = "breaching"` on purpose (`infra/modules/alerts/main.tf`). Expect the alarm to clear within a couple of minutes of this step: the scheduler runs every 60 seconds and the metrics publisher every 60 seconds. The smoke check in section 6 reads that same metric and has nothing to judge before this step, which is exactly how the eighth full rehearsal failed (8.0p).

### 5.2 The DNS ALIAS

```bash
cd infra/roots/production
terraform output load_balancer_dns_name
terraform output load_balancer_zone_id
```

Create the A/ALIAS record for `api.usecallie.com` pointing at those. Confirm:

```bash
dig +short api.usecallie.com
curl -sS -o /dev/null -w '%{http_code} %{ssl_verify_result}\n' https://api.usecallie.com/healthz
```

Expect `200 0`. Expect `http://api.usecallie.com` to **fail to connect** rather than redirect: there is no port 80 listener by design.

### 5.2a The first real sign-in, straight after the deploy

Do this **immediately after 5.2**, yourself, as the admin 5.1a bootstrapped — not later,
and not left to whoever first needs the app. It is the first time anything exercises
Google's side of sign-in: no rehearsal step signs in, and the lane tests use a local
provider, so Google's discovery document, the token exchange, Google's key set and the
id-token checks against Google's real claims are all untested until this moment. The
first production sign-in was refused four times for a reason no test could see (8.0u).

1. Install the published desktop build, enter the `workspace.id` from 5.1a, and sign in
   as `callie@usecallie.com`.
2. Expect the browser to show **Signed in** and the Mac to leave "Waiting for your
   browser…" within seconds. This first sign-in also adopts the provisional admin row, and
   the audit log records `auth.provisional_user_adopted`.
3. Whether it worked or not, read the API's two sign-in warn lines for the last hour:

```bash
aws logs filter-log-events --log-group-name /fss/fss-prod/api \
  --start-time "$(( $(date -u +%s) - 3600 ))000" \
  --filter-pattern '{ ($.event = "token_exchange_failed") || ($.event = "oidc_discovery_unavailable") }' \
  --query 'events[].message' --output text
```

Expect nothing. Neither line ever carries a code, a token, the client secret or a
response body; what each one means:

| Line | Meaning |
|---|---|
| `oidc_discovery_unavailable`, or `token_exchange_failed` with `reason: discovery_unavailable` | The API did not accept Google's discovery document. Fetch `https://accounts.google.com/.well-known/openid-configuration` and compare its `issuer`, `authorization_endpoint`, `token_endpoint` and `jwks_uri` with the rule in `docs/greenfield/identity.md`. This is 8.0u. |
| `reason: token_endpoint_status_4xx`, `provider_error: invalid_client` or `unauthorized_client` | Google refused the sign-in client: the `google-oidc-client` entry (5.1). |
| `provider_error: redirect_uri_mismatch` | The client's registered redirect URIs do not include `https://api.usecallie.com/auth/google/callback`. |
| `provider_error: invalid_grant` | The code was spent or expired, or the PKCE verifier did not match. Sign in once more before reading anything into one of these. |
| `reason: id_token_absent` | Google answered 200 without an id token, so the `openid` scope did not reach it. |

A refusal the audit log records with any other code — `hosted_domain_mismatch`,
`membership_required`, `email_unverified` — is about the account rather than about
Google's side, and writes neither line. One is about Google's side and is also first
exercised here: `issuer_mismatch`. The validator accepts `https://accounts.google.com` and
`accounts.google.com`, the two forms Google documents (8.0u), so that refusal means the
token named some other issuer, and it is worth stopping on.

### 5.3 The SNS confirmation

AWS emailed each address in `alert_emails` a confirmation link. An unconfirmed subscription is silently no delivery, so this is checked rather than assumed:

```bash
aws sns list-subscriptions-by-topic --topic-arn "$(terraform output -raw alert_topic_arn)" \
  --query 'Subscriptions[].{endpoint:Endpoint,arn:SubscriptionArn}' --output table
```

Any row whose `arn` is `PendingConfirmation` is not receiving alerts. Find the email and click the link. Then prove the path rather than trusting it:

```bash
aws sns publish --topic-arn "$(terraform output -raw alert_topic_arn)" \
  --subject "FSS alert path test" --message "If you are reading this, the independent alert path works."
```

**What arrives after that.** One e-mail a day and nothing else: the daily alarm digest, `Callie daily alarm digest — <date>`, at 07:00 America/New_York (lane g99). It lists every `fss-prod-` alarm that is not `OK`, then the last 24 hours of state changes in time order, or says `All N alarms OK.` when nothing happened. No alarm e-mails when it trips. To read one immediately: `aws cloudwatch describe-alarms --state-value ALARM --alarm-name-prefix fss-prod- --alarm-types MetricAlarm CompositeAlarm`; to have the digest now, `aws lambda invoke --function-name fss-prod-alarm-digest /dev/null` (`docs/greenfield/runbooks/README.md`).

### 5.4 The Gmail push grant

```bash
terraform output gmail_push_topic_id   # projects/callie-fss/topics/fss-prod-gmail-push
terraform output gmail_push_audience   # https://api.usecallie.com/integrations/gmail/push
```

Both are in the task environment already (`FSS_GMAIL_PUSH_TOPIC`, `FSS_GMAIL_PUSH_AUDIENCE`); the outputs are here so you can read what the apply decided. Confirm it reached the containers rather than assuming it — the API's startup line says `push_topic_source: "environment"` once it has.

Then connect the mailbox from the Mac client: on the main window's "This Mac" card, the **Mailbox** row has a **Connect Gmail** button (desktop 1.0.1 and later — 1.0.0 has no such control, 8.0x). It opens the Google consent screen in the system browser, you grant `gmail.readonly` and `gmail.send`, and the callback lands on `https://api.usecallie.com/oauth/gmail/callback`. The row then reads `callie@usecallie.com · connected · baseline pending`. It has no Disconnect, because of the thirty-day rule in `docs/greenfield/mail.md`. The API validates the exact audience and the exact service-account email on every push; a token with a valid Google signature and the wrong audience is refused (Appendix G 27).

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

Since lane g96 (the owner's axiom 10B) the record comes from the CI gate that was green on the deployed commit, not from a rehearsal. Build it with `release-record-from-ci.sh` and pass it to the deploy. 4.2 has the commands that find the gate run, the images run and the digests:

```bash
GITHUB_REPOSITORY=david-cui-bruno/founding-sales infra/scripts/release-record-from-ci.sh \
  "$GATE_RUN_ID" "$COMMIT" "$API_DIGEST" "$WORKER_DIGEST" --enables-sending --out /tmp/fss-ci/release-record.json
infra/scripts/release-deploy.sh infra/roots/production fss-prod [--schema-change] \
  --api-digest "$API_DIGEST" --worker-digest "$WORKER_DIGEST" \
  --release-record /tmp/fss-ci/release-record.json
```

After the final verify, the script runs `fss admin release-record put` on the operations task. It prints the stored record: the reference, `source` (`ci-gate`), `suite`, `apiDigest`, `workerDigest`, and `outcome` (`created`, or `existing` on a re-run). A different record under the same reference is refused `release_record_conflict`. Records are never replaced. The put enables nothing.

If production is already running the record's digests, you do not have to redeploy to store the record. Run the put alone, from a checkout at the commit production runs, as the admin profile, with the production root initialised as for section 4:

```bash
export AWS_REGION=us-east-1
export WORKER_DIGEST="$(aws ecs describe-task-definition --task-definition fss-prod-operations \
  --query 'taskDefinition.containerDefinitions[0].image' --output text | sed 's/.*@//')"
export RECORD_BASE64="$(python3 -c 'import base64,sys; print(base64.b64encode(open(sys.argv[1],"rb").read()).decode())' /tmp/fss-ci/release-record.json)"
bash -c 'set -euo pipefail
source infra/scripts/release-common.sh
root=infra/roots/production
network=$(release_output "$root" task_network_configuration json)
release_run_task --step release-record-put --environment production --prefix fss-prod \
  --account "$(release_caller_account)" --region "$AWS_REGION" \
  --cluster "$(release_output "$root" cluster_arn)" \
  --task-definition "$(release_output "$root" operations_task_definition_arn)" \
  --container operations --network-plan "$network" --image-digest "$WORKER_DIGEST" \
  --database-host "$(release_json_path "$network" database_host)" \
  --secret-arn "$(release_output "$root" app_runtime_database_secret_arn)" \
  --log-group "$(release_output "$root" worker_log_group_name)" --log-stream-prefix operations \
  --capture /tmp/fss-release-record-put.log \
  -- admin release-record put --json-base64 "$RECORD_BASE64"
release_captured_report /tmp/fss-release-record-put.log /tmp/fss-release-record-put.json'
cat /tmp/fss-release-record-put.json
```

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

**4. Flip the deployment flag.** `terraform apply -var="sending_enabled=true"` in the production root, then re-deploy (worker, then API). That puts `FSS_SENDING_ENABLED=true` on both task definitions; read the plan first, and expect it to change exactly the two task definitions and nothing else. This is the release process's statement that the gate passed on these digests.

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
  "changeNote": "I attest to the release process: a worker may send under any ci-gate release record for a commit on main, put by the CI deploy after its rollout and smoke passed" }
```

`ci-gate:main` means any stored record with `source: "ci-gate"`. Only `release-record-from-ci.sh` writes one, and only from a green *Greenfield gate* run of a push to main at the record's commit. The CI deploy puts one after every rollout and smoke; the operator puts one by hand only as its fallback (4.0). Each process still compares its own half:
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

Withdraw either half, or deploy other digests: the worker holds every send when the attested record does not name its image (under the process form, when no ci-gate record names it). The attestation (`enabled: false`) stops it immediately and is a versioned change with a reason; the deployment flag stops it at the next deployment. Neither cancels a fence that has already entered `dispatching` — that message may have gone, and Appendix B is how it settles.

---

## 7. If the release has to be undone

4.2: "Earlier compatible binaries on the same database, or database restore under the post-restore protocol; the old stack is never a rollback target."

**Preferred.** Deploy the previous image digests, if and only if their declared schema ranges accept the current schema version. Read them from the previous release's checkout; where the ranges do not overlap there is nothing to roll back to, and the honest answer is forward repair. This is exactly what `infra/scripts/rehearsal-schema-ranges.sh` computes, and it will have told you during the rehearsal.

**If the data is wrong rather than the code.** `docs/greenfield/restore-drill.md`, all nine steps, in production, with sending and dialing held until step 9. There is no faster version.

**Never.** The old stack. It is read-only after the cutover watermark and the carry tooling contains no writer at all (Appendix G 20).

### 7.1 The expected system generation (Appendix E step 1)

`expected_system_generation` in the production root is Appendix E's "operator-controlled expected generation". Its code default is `null`, meaning unpinned. When set, it becomes `FSS_EXPECTED_SYSTEM_GENERATION` on `fss-prod-api` and `fss-prod-worker` and on no one-off task definition. At startup the worker compares it with the database's `system_generation`. When they differ, the worker opens one `restore_in_progress` hold per workspace, logs `restore_generation_mismatch` (which fires `fss-prod-restore-generation-mismatch`, a critical alarm), and runs. The API fails `/readyz` (the smoke's second check) and shows both numbers in the Settings diagnostics line. Until lane g56 nothing set it, and nothing anywhere opened a restore hold (`docs/decisions/g56-restore-holds-are-opened-by-the-generation-check.md`).

**Read the database's generation.** Run this from a checkout at the commit production runs, as the admin profile, with the production root initialised as for section 4. It runs `fss verify` on the operations task, which the deployed image already has. The write it proves is rolled back, and `release-deploy.sh` runs the same command at every deploy. From g56 on, `fss admin counts` reports the same `systemGeneration` field.

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
change did, 8.0 to 8.0aw, are in [`release-records.md`](release-records.md), unchanged. A
numbered reference such as "8.0u", in this document or anywhere else, names one of them. From
25 September 2026 a change is one line in [`changelog.md`](changelog.md) instead, added as
one fragment file under [`changelog/`](changelog/), and this section holds only what is
still unverified.

### 8.1 Still unverified

Production is live: applied, deployed, bootstrapped and smoked at `66203322` on 24 September, and redeployed since (8.0s, 8.0v). Sign-in works and the first mailbox is connected (8.0x, 8.0y). The first release record exists: run 36100448302 at `b0f46711` passed every step, the restore drill's Appendix E steps 1 to 9 included, and wrote `releaseGateReference` `fss-rh-202609250554-2026-09-25T07:20:44Z`, kept outside GitHub's artifact retention in the coordinator's `.context/release-records/`. What follows is what that still does not settle. On 25 September lane g93 removed the items later runs had answered and cut the drill's item to the two gaps it left; the list as it stood is at the end of `release-records.md`, and an item number in an older document refers to that copy.

1. That `resourcegroupstaggingapi` is regional. The guard's read of the run's own resources only ever sees the rehearsal's region, which is where everything is — but a rehearsal resource left in another region is outside the comparison and always will be.
2. Whether the worker task role can write the suppression journal. **Closed by G12b in the plan, unproved in the cloud.** `infra/modules/cluster` now gives the worker `s3:PutObject` on the journal object prefix and `kms:Encrypt`/`kms:GenerateDataKey` on the journal key, and `infra/modules/journal` names both task roles as permitted writers rather than the API alone — so the bucket policy's `DenyWritesFromAnyoneButTheTaskRoles` no longer refuses the worker. Neither role asks for any `s3:Delete*`, and no writer sets a per-object retention: the bucket's own default retention locks every object on put, and `s3:PutObjectRetention` stays denied to everybody. `infra/modules/cluster/tests/services.tftest.hcl` asserts both halves offline. What a plan cannot prove is that the first real opt-out the worker imports actually lands in the bucket; watch the `SuppressionJournalWriteFailures` metric after Gmail sync is first enabled, because a remaining IAM refusal surfaces there and nowhere else.
3. Whether one day of GOVERNANCE retention is long enough that `--bypass-governance-retention` is only ever needed for a same-day teardown.
4. Whether `"carryDrill": "skipped_no_watermark"` in the release record is legible enough at enable time. The skip branch has run against AWS: run 36100448302 took it before the cutover, as it should, and the first record says so. The other branch, the export refusing a table with a post-watermark write, runs offline on every pull request and has not run against AWS.
5. **What the green drill left open.** Two gaps behind run 36100448302's drill are tidy items, not drill failures. Appendix E.3's missing fences, a send whose fence the restored copy never had, are recovered from the Sent folder in code by lane g73 (8.0ah); no `full` run is recorded here as having proved it. And the API's recorded mode still wraps with a per-process key, which nothing in the drill reaches.
6. **The update path on a real Mac.** Signed and notarized builds are published to the update channel, the first being Callie 1.0.0 from `66203322` (8.0t). Gatekeeper's verdict on a downloaded build is not recorded here, and nobody has yet watched the updater take an update from the channel: since lane g83 it downloads, verifies and swaps a new build in at launch (8.0ap).
7. **The first mailbox, read back.** The mailbox connected from desktop 1.0.1 between 18:00Z and 18:11Z on 24 September, and the worker inserted its first jobs at 18:11:37Z (8.0y). The "This Mac" card and `/gmail/status` readings after it are not recorded here, nor are the audit row `auth.provisional_user_adopted` and the absence of both warn lines that 5.2a asks for. `fss-prod-mailbox-heartbeat-missed` flapped on a healthy worker until lane g58 (8.0z); whether it and `fss-prod-gmail-watch-expiring` now stay clear is not recorded here.
8. **Sending.** `FSS_SENDING_ENABLED` is `false` and section 6 has not been run, so nothing has been sent from production. 12.7's authentication checks, the six-week ramp, and the journal's first real write — item 2 above, which surfaces only as `SuppressionJournalWriteFailures` — are all unproved in production.
9. **The exact rehearsal deployment policy, put back.** `fss-rh-deploy` still carries the discovery document of 8.0h: a wide allow on the services the tree uses, with guards, for one pass of `create`, `deploy` and `full`. The exact policy derived from the CloudTrail record of that pass is put back only after a `full` run has passed (`infra-apply-runbook.md` 1.1b, step 5). Run 36100448302 passed on 25 September; putting the exact document back is not recorded here, and until it is, no rehearsal run proves anything about the policy this release ships. `fss-prod-deploy` was never widened and the renderer refuses to widen it.
10. **Email validation against real DNS.** Since PR 231 the worker checks each unchecked address's domain (`route.validate`, `docs/decisions/g90-email-technical-validation.md`). No test has asked a real DNS server: that the VPC resolver answers MX queries from the worker task, and that Node reports a null MX as an empty exchange, are inferred. After the deploy, `route.email.validated` audit events with `mx_present` or `implicit_mx` answer it; a run of `route.email.validation_deferred` events means the resolver is not answering.
11. **The CI deploy of an app-only change (lane g91) — unrun.** Nothing credentialed has run it. Still open:
    - that GitHub issues this repository's jobs the legacy subject `repo:david-cui-bruno/founding-sales:environment:production-deploy`. A repository opted into immutable subjects uses owner and repository ids, and the trust would then match nothing;
    - that ECS authorizes `ecs:RegisterTaskDefinition`, `ecs:DescribeTaskDefinition` and `ecs:DeregisterTaskDefinition` on `*` only (the first under the `NamePrefix` request tag, with `ecs:TagResource` for the tags), and `ecs:ListTasks` under `ecs:cluster`;
    - that `UpdateService` carries `ecs:task-definition` in its request context, which the plain `ArnLike` now requires, so if it does not, every roll is refused;
    - that `docker buildx imagetools create` from a runner copies into `fss-prod-*` with only the ECR actions the role holds;
    - that the images production runs today carry a `ci-<commit>` or bare commit tag, without which every guard answers manual;
    - that turning `track_latest` on is an in-place change with no replacement, and that it makes the first plan after a CI deploy show no change. Only a real plan of `infra/roots/production` can show these two;
    - the shared concurrency group across a reusable-workflow call from the monthly drill.
12. **The CI deploy's release record put (lane g100) — unrun.** No credentialed run has put a record. Still open:
    - that ECS evaluates `ecs:cluster` on `RunTask` with the ARN form the `ArnEquals` condition names;
    - whether `--propagate-tags TASK_DEFINITION` makes `RunTask` a tag-on-create at all. The grant of `ecs:TagResource` under `ecs:CreateAction = RunTask` is there in case it does. If a run shows it is not needed, it can go;
    - that `RunTask` needs no `iam:PassRole` beyond the worker's two roles;
    - that the four repository variables hold what the outputs print. No apply has created those outputs yet;
    - that the last apply's operations image accepts a `ci-gate` record. Only images built at or after PR 235 know the `source: "ci-gate"` shape, so the first put needs an apply after that.
