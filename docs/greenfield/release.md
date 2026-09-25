# FSS release: what David does, what CI does, and in what order

**Lane:** G12 · **Spec:** 16.2, Appendix E, Appendix G · **Audience:** the operator running the first release. Assume you have never applied this stack.

`docs/greenfield/infra-apply-runbook.md` is how the infrastructure comes into existence. This document is how a **release** happens on top of it: which steps are yours, which are the workflow's, and why the order cannot be rearranged.

Read section 1 before doing anything in section 3. Two steps in it take days of waiting (DNS authentication for sending, and an SNS confirmation click that is easy to forget), and one of them — the `fss-rh-deploy` bypass-governance grant — is the difference between a rehearsal you can tear down today and one that leaves a bucket behind for a day.

> **The one sentence the whole document serves.** Specification 16.2: *"Production sending remains disabled until all mandatory scenarios for the affected release class pass, the deployed commit/image digests match the rehearsal artifacts, and an authenticated admin enables sending."* Nothing below turns sending on. The last step of the last section does, and only you can do it.

---

## 0. Who does what

| Step | Who | Why it cannot be the other one |
|---|---|---|
| Build, push and verify the images | CI (`greenfield-images.yml`, its `publish` job on a push to main that changes an image input) | One build per commit, pushed to `fss-rh-api` and `fss-rh-worker` as `ci-<commit>`, pulled back by digest and verified, with the digests published as `fss-image-digests`. That digest is the release's identity (8.0al). |
| **Promote the images to production** | **David, with the admin profile** | `infra/scripts/release-promote.sh` copies the two digests from `fss-rh-*` to `fss-prod-*` and reads production back. No CI job holds a production credential (8.0al). |
| **Apply the rehearsal registry — once, ever** (done) | **CI (`greenfield-rehearsal-registry.yml`), dispatched by David twice: plan, then apply** | Same reason as the row below: `fss-rh-deploy` is assumable only from the `rehearsal` environment. `infra-apply-runbook.md` 2.1. |
| Run the rehearsal | CI (`greenfield-release.yml`) | It needs the `fss-rh-deploy` role, which only the OIDC provider may assume, and it must tear the environment down even when a step fails. |
| Write the release record | CI, last | So a record can only exist for a run that finished. |
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

1. **The digests come from CI.** Every push to main that changes an image input runs *Greenfield images*. Its `publish` job pushes `fss-rh-api:ci-<commit>` and `fss-rh-worker:ci-<commit>`, pulls both back by digest, runs `infra/scripts/release-images.sh verify` on what it pulled, and uploads the artifact `fss-image-digests` (`image-digests.json`, `fss.image-digests.v1`). A commit that changed no image input has the images of the last one that did; `release-images.sh pin <commit>` finds them, and the weekly rehearsal pins that way. The digests (`sha256:` and 64 hex characters), not the tags, are what everything downstream compares: `infra/modules/cluster` and `rehearsal-release-record.sh` both refuse a mutable tag.
2. **The rehearsal deploys those digests** from `fss-rh-api` and `fss-rh-worker`, the two stable repositories `infra/roots/rehearsal-registry` owns. Dispatch it with the two digests (section 3).
3. **Production gets a copy, never a rebuild.** With the admin profile, from a checkout of main:

   ```bash
   # After a green full rehearsal: its fss-release-manifest artifact.
   infra/scripts/release-promote.sh release-manifest.json
   # An app-only release, the one class the cadence lets skip the rehearsal: CI's digests.
   infra/scripts/release-promote.sh image-digests.json --app-only
   ```

   Each digest is copied from `fss-rh-*` to `fss-prod-*` with `docker buildx imagetools create` and read back. A digest production already holds is not copied again, and a tag that already names another image is refused.

The **desktop commit stamp** is the release commit from 2.0 — the same `git rev-parse HEAD` you have been using — and the release record names it. You do not wait for a Mac build to learn it.

---

## 3. The rehearsal — CI, started by David

Actions → *Greenfield release rehearsal* → Run workflow, with:

- `stage` — how far this run goes: `plan` (the default), `create`, `deploy`, `full`, or `teardown`. Only `full` is the release gate; read 3.0 before choosing anything else.
- `api_image_digest` — from CI's `fss-image-digests` for the release commit (2.1);
- `worker_image_digest` — likewise;
- `desktop_commit_stamp`;
- `run_suffix` — optional, except for `teardown`; the prefix becomes `fss-rh-<suffix>`, or `fss-rh-<UTC timestamp>`.

### 3.0 The five stages, and the order to use them in

Until 21 September the workflow had one mode — the whole gate, all fifteen steps of it — and the
three credentialed runs of that day each stopped at the first error of a class no
offline check can see. One error per run, about an hour of attention each. `stage` makes
the cheap part runnable alone. Each of the first four runs everything the stage before it
runs, plus its own steps; `teardown` is not on that ladder and is described under the
table.

| `stage` | what it adds | what it proves | roughly |
| --- | --- | --- | --- |
| `plan` (default) | the identity check, the production inventory, `terraform init` against this run's own state key, `run.auto.tfvars.json`, `terraform plan` with the same variables the apply uses, and a summary | that the rehearsal root can be **planned** in this account with these variables: every required variable is passed, every provider it needs can be configured, and no `count` depends on a value unknown until apply | a few minutes |
| `create` | `terraform apply`, taking its values from the `run.auto.tfvars.json` the plan stage wrote | that the plan can be **applied**: quotas, service limits, IAM, the order Terraform chooses, and whether a fresh environment comes up at all | the apply, dominated by the Multi-AZ RDS instance |
| `deploy` | the two database entries, `infra/scripts/release-deploy.sh`, `infra/scripts/release-bootstrap-workspace.sh` and the smoke | that a fresh environment can be **migrated and started**: the migration task's networking, whether `fss migrate` accepts the RDS master user, the schema-range refusals both binaries make on startup, and whether a canary datapoint ever appears | the deploy, five one-off tasks of about a minute each |
| `full` | the declared ranges against the deployed images, the release suite and the mutation check, the drill's evidence and the restore drill, the journal replay and Gmail reconstruction, the carry drill, and the release record | the release gate of 16.2, which is everything in the numbered list below | up to the 180-minute timeout |
| `teardown` | nothing, and it takes the plan away: it runs only the steps before `terraform plan` plus the two every stage runs | that a prefix some earlier run left standing is gone | the destroy |

**`teardown` is the stage for an orphan.** It runs the identity check, the production
inventory, `run.auto.tfvars.json`, `terraform init` against the prefix you name, and then
the two steps every stage runs — `infra/scripts/rehearsal-teardown.sh` and the
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

**Only `full` is the gate.** It is the only stage that runs
`infra/scripts/rehearsal-release-record.sh`, and that is the step's own condition
(`if: inputs.stage == 'full'`) rather than a convention: a `plan`, `create`, `deploy` or
`teardown` run cannot write a release record, and so cannot produce the
`releaseGateReference` section 6 asks for before sending can be enabled. The default is
`plan`, so the expensive run is always chosen and never inherited.

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
6. **`full`**, which is the release gate, once the deploy is clean.

A stage is worth running only when the one before it passed. Running `full` first is
what the three runs of 21 September did, and it cost about an hour per error. `teardown`
is outside that order: run it when a run left something behind, and never as part of a
release.

Before any of them, run `infra/scripts/check-deployment-role.sh fss-rh-deploy fss-rh`
(`infra-apply-runbook.md` 1.1a). It is read-only, it takes seconds, and it answers the
whole class of error the fourth credentialed run spent an apply on.

**Every stage tears down, and every stage re-reads the production inventory.** Steps 13
and 14 of the list below keep `if: always()` and carry no stage condition at all. They
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
before it run:

1. [plan] **Refuse anything that is not a digest.** Two `sha256:` values, and they must differ — one image pushed under both names is a mistake the gate can catch and a person cannot.
2. [plan] **Name the principal.** `infra/scripts/rehearsal-caller-identity.sh fss-rh-deploy` prints `aws sts get-caller-identity --query Arn` and refuses anything that is not `arn:aws:sts::…:assumed-role/fss-rh-deploy/<session>`. Every `terraform` command in this job then runs with `-var="assume_deployment_role=false"`, because this session already *is* the deployment role and the provider must not ask STS to assume the role it already holds (`infra-apply-runbook.md` 1.1). The flag makes the job's own credentials the thing the apply acts as, so this step is what makes it safe; it is the one the teardown repeats.
3. [plan] **Record the production inventory.** So that "teardown could not address production" is measured afterwards rather than asserted. This is the one rehearsal command that names a production resource on purpose, and on the first credentialed run (Actions 35548888865) the rehearsal's own guard refused it — `FAIL: a rehearsal command names a production resource: Key=Name,Values=fss-prod*` — before anything was created. It is now issued through one named function, `rehearsal_read_production_inventory` in `infra/scripts/rehearsal-common.sh`, which is the only caller exempt from the refusal, may issue only `resourcegroupstaggingapi get-resources`, and builds its own filter so no caller can push a name through it. Every other command naming `fss-prod` — including a mutating one wearing the same filter — is still refused. The dry run prints the read with an `exempt-read-only-production-inventory` marker and `infra/scripts/rehearsal-prefix-guard.sh <prefix> plan <file>` re-applies the refusal to that printed plan on every pull request, so a rehearsal that would refuse itself is red before a credential is spent.
4. [plan, then create] **Plan, then create.** The variables the root requires are written to `run.auto.tfvars.json` beside the root, the backend is initialised against this run's own state key, and `terraform plan -out` is run with the whole `-var` list. The `create` stage then applies, and names **no variable of its own**: Terraform loads `run.auto.tfvars.json` automatically from the root directory, which is the same mechanism the teardown's `terraform destroy` depends on. One list in one place is what keeps the plan and the apply the same values. The apply creates the rehearsal root with the run prefix and `bootstrap=true`, deploying both digests from the stable `fss-rh-api` and `fss-rh-worker` repositories. **Both services are created at desired count zero.** A fresh environment's database has no schema, and both binaries refuse to start unless the applied schema version is exactly the range they declare — so an apply that started them would create two services crash-looping against an empty database while the task that would fix it had not been launched. The run creates no repository of its own and its teardown removes none; `infra/roots/rehearsal-registry` owns those two and was applied once, before the first push.
5. [deploy] **Fill every secret entry.** Terraform creates every Secrets Manager entry empty and never holds a value. In production you fill these two by hand (5.1); a rehearsal is unattended and an hour long, so it fills its own: `migration-database` takes the RDS-managed master credentials, because on a database that has never been migrated there is no other login role that can run DDL, and `app-runtime-database` takes a password generated in the runner. Both are masked before they can reach a log. This needs `secretsmanager:PutSecretValue` on `fss-rh-*` secrets on `fss-rh-deploy` — see 8.1.
6. [deploy] **Migrate, then deploy the worker, then the API.** `infra/scripts/release-deploy.sh infra/roots/rehearsal <prefix> --schema-change` — the *same script* you run locally for production (section 4.1). It refuses unless both services are at zero — on a fresh stack the apply created them there, and on a stack that already stood the create step ran `release-stop.sh` before the apply (lane g70) — then runs `fss migrate` as a one-off ECS task inside the VPC, then `fss admin database-users ensure`, then `fss verify`, then the worker to its declared count, then the API, then `fss verify` again against the running deployment. Never beside each other: the API's declared schema range needs the migration to have run. Until 21 September nothing in deployment ran a migration at all; the step was named for an order it did not perform.

    [deploy] **Then the first workspace and its admin**, as its own step between this one and item 7: `infra/scripts/release-bootstrap-workspace.sh infra/roots/rehearsal <prefix> --worker-digest D --slug rehearsal --display-name Rehearsal --admin-email rehearsal-admin@usecallie.com`. A migrated database has no `workspaces` row, and the scheduler's canary is inserted once per workspace — so an environment without one publishes no `CanaryCompletionAgeSeconds`, the `canary_stale` alarm breaches, and item 8's smoke has nothing to judge. That is exactly how the eighth full run failed (8.0p). It is the same script production runs, with `--environment production` (5.1a) and different values.
7. [full] **The declared ranges, against the deployed images** (`infra/scripts/rehearsal-schema-ranges.sh <prefix> --api-digest D --worker-digest D`): Appendix G 22's refusal cases, which only a real ECS task can answer. Each service image is launched as a one-off `--selftest` task through the same wrapper the deploy uses, with a declared schema range one below the one it was built with, and the *container* must refuse it — exit 12, `configurationInvalid` in both `API_EXIT_CODES` and `WORKER_EXIT_CODES`. The overlap case, the previous release's image against the current schema, runs **only when a `<prefix>-<service>-previous` task definition is actually registered**: nothing in this repository registers one and a first release has no previous image at all, so the report says `skipped_no_previous` rather than claiming a pass (8.0o).
8. [deploy] **Smoke** with the same `scripts/productionSmoke.mjs` production gets.
9. [full] **Release suite (recorded mode, runner)**: the 42 scenarios (`npm run test:release`) and the **mutation check** (`npm run test:release:mutation`), which breaks each trap in turn and requires the suite to go red. They run in the runner against the job's own `postgres:16` service container, which is what they were built for. They do **not** touch the rehearsal database and could not: it is private — `publicly_accessible = false`, no NAT gateway, no bastion — so the step that used to assemble a URL from the rehearsal's outputs could never have connected. What runs against the rehearsal database is `fss verify` and `fss drill`, inside the VPC.
    [full] **Before it, the evidence the drill has to reconstruct** (lane g40), as its own step between item 6's bootstrap and item 7: `infra/scripts/release-seed-drill-evidence.sh infra/roots/rehearsal <prefix> --worker-digest D --phase before --workspace-slug rehearsal`. `docs/greenfield/restore-drill.md` 0.1 needs an accepted send, a prospect reply, a prospect-originated opt-out, a salesperson's own manual suppression inside its ten-minute window and an ordinary CRM edit to exist *before* the restore target is read, and nothing in this repository could produce any of them in a deployed environment — so the drill's own refusal fired on every fresh rehearsal, which is how the ninth full run ended (8.0q). `fss admin drill seed-evidence` produces all five through the domain's own entry points. The drill then adds `--phase after` between the baseline and the restore, so the restore genuinely loses work, and waits for RDS to report a `LatestRestorableTime` past the evidence before reading the target at all. **Production is never seeded**: the script refuses any prefix that is not `fss-rh-<run>` and the command refuses unless `FSS_DEPENDENCIES=recorded`.
10. [full] **Restore drill**, Appendix E steps 1 to 9, preceded by a session renewal and its identity check. The runner keeps the control plane (reading the latest restorable point, the restore itself, the wait, the teardown); two in-VPC tasks do the database work — `fss admin counts` for the baseline on the source, then one `fss drill` against the restored instance for steps 1 to 9, with one correlated log and per-step JSON. The runner reads the report and decides whether it is a pass, so a change to the tool cannot quietly relax the gate. It refuses to report a pass unless the baseline contained an accepted send, a reply, a suppression, a CRM edit and a migration — a drill against an empty database proves nothing. The drill task is fixed at `FSS_DEPENDENCIES=recorded` **in its task definition**, because `reconcile-sent`, `recover` and `watch-renew` all reach Gmail when it is live and a mode a caller passes is a mode a caller can forget. The restored instance reaches the drill task only as the `FSS_DATABASE_HOST` override. `--database-host` stays the primary host the task definition names, which is what the run-task wrapper checks the definition against (lane g48). Run 35962272085 (24 September) passed the restored endpoint as both, and the wrapper refused the drill's first task after a restore that had succeeded. That first item of the deferred drill work is fixed in code. Run 35976297919 (24 September) proved it and showed where the drill stops next. The task started against the restored instance and stopped at its first write, a step-0 baseline file in `/tmp/fss-drill`, which nothing in the container created. The baseline the runner measured on the source was not handed to the drill task either (8.0w). Lane g53 fixes both in code: the drill creates its reports directory before its first write, and the runner hands the drill task the source baseline as `--baseline-json`, one line holding the `asOf` instant and the five counts, instead of `--as-of`. Run 36062337914 (24 September, 22:45Z) passed step 0 and stopped at step 1, because nothing anywhere opened a restore hold (8.0aa). Lane g56 closes that. The runner refuses a baseline without `systemGeneration` before the restore. It launches the drill with `--expected-generation` set to that value plus one, so step 1a runs the worker's own generation check against the restored copy. After step 9, `step9-generation-reconciled` asserts the database landed on that pin. After the drill, the runner reads the mismatch line in the drill's log and a transition to ALARM in the history of `<prefix>-restore-generation-mismatch`. Lane g59 gives steps 1 to 9 the evidence they have to find (`restore-drill.md` 0.1). The evidence comes in three phases: `before`, the release step, which now also makes a late opt-out's firm, a phone route and an administrative pause; `in-flight`, just before the target, one send left `reconciling` for step 3; and `after`, once the restore has been requested, a late opt-out the restore loses, for steps 2 and 4. The runner then counts the source again and hands the drill those counts as `--at-failure-json` for step 8, the three phases' recorded mailboxes merged as `--mailbox-recording-json`, and the seed's admin as `--admin-user` for step 9. In recorded mode a task that carries `FSS_ENVELOPE_KEY_ID` wraps refresh tokens through KMS under the context `fss_envelope_seam = recorded`, and outside production the drill role may decrypt under that context and no other. Lane g60 gives the dial probe its subject. The `before` phase registers the rehearsal admin's calling number and attests it through the domain, the same path a salesperson takes on the Settings screen. Step 1 now also requires `restore_in_progress` among the holds that apply to the refused dial, in the drill and in the runner's verdict. A rehearsal's probe is otherwise refused `posture_missing` whether or not a restore is in progress (8.0ab). The drill prints its whole report even when it fails. A database with no attested number still gets `step1-dial-refused` unanswered, and the runner fails the run on it (8.1 item 12). Lane g73 closes Appendix E.3's missing fences (8.0ah). Step 3 also lists every Sent folder and tombstones each FSS send whose fence the restore lost. The `after` phase sends a step the `before` phase enrolled so that there is one. The runner requires `step3-missing-fence-tombstoned` and `step5-no-second-send`.
11. [full] **Suppression journal replay and Gmail reconstruction**, against the recorded fake (no real mailbox in rehearsal unless you provide a rehearsal Google project). The second replay must insert nothing; no send may repeat. The drill above already ran both; this step reads the reports it left, which the drill wrote out of the captured task report under the names they have always had.
12. [full] **Carry watermark** (Appendix G 20): the carry tooling must contain no writer at all, and — once a cutover is scheduled and the two optional secrets exist — the export must refuse a table with a post-watermark write. Before the cutover the step prints `carry drill skipped: no cutover watermark yet` and the record says `"carryDrill": "skipped_no_watermark"`. That is not a pass being claimed; it is the state being named.
13. [every stage] **Tear down**, always, with bypass-governance — and tolerantly, on a session renewed immediately before it so that a run which has already outlived its first hour can still destroy what it made. The teardown is five steps (any one-off task still running, the restored instance, any manual snapshot carrying the run prefix, the object-locked journal objects, the root), and each treats the AWS error code for absence as "already done" rather than as a failure, because `if: always()` means it runs after a creation that never happened. A failure that is *not* an absence — an `AccessDenied`, a throttle — still stops it, and an unreadable state that is not "the root was never initialised" still stops it. The report says which: `destroyed=true`, or `destroyed=nothing_created`. `terraform destroy` requires every variable `apply` did, so the step that opens item 4 writes them to `run.auto.tfvars.json` beside the rehearsal root (identifiers only, ignored by `infra/.gitignore`) and the teardown refuses to destroy without that file rather than fail on a missing variable and leave the environment standing. To tear a run down by hand from a fresh checkout, recreate the file first: `name_prefix`, `api_image` and `worker_image` (`<repository>@<digest>`, from the release record or the run's inputs), `certificate_arn`, `api_hostname`, `assume_deployment_role: false`, `bootstrap: true`, and the two schema ranges read from `packages/domain/db/schemaRange.ts`; then run `rehearsal-teardown.sh <prefix>` from the root directory as the `fss-rh-deploy` session.
14. [every stage] **Assert nothing with the production prefix was touched**, always, including on a run that created nothing. The guard classifies every name it sees: the run's own resources, the two stable rehearsal repositories that carry no run, and anything production's — which it refuses. A state it cannot list is reported as "the run created nothing" rather than swallowed, and the inventory comparison still runs. An inventory recorded only by a dry run is refused rather than compared: the workflow records the sentinel `["dry-run: no production inventory was read"]` when it validates the prefix, and comparing production against that would be a pass nobody earned. The comparison is between durable resources. ECS task ARNs are set aside on both sides, because the tagging API lists tasks and ECS forgets a stopped one after about an hour (8.0v). So are EC2 ARNs whose resource part begins `network-interface/`, because a Fargate task's elastic network interface carries the same propagated tags and is created and deleted with its task (run 36032732128, 8.1 item 1). The guard logs both counts for each side. Task-definition revisions, services, the VPC, the subnets, the security groups, the route tables, the internet gateway and every other resource are still compared. The guard runs in dry mode on every pull request, so every branch is exercised without a credential.
15. [full] **Write the release record**, last. It names the two digests, the desktop stamp, and a `releaseGateReference` you will need in section 6. It is `release-record.json` in the run's `rehearsal-reports-<prefix>` artifact. Keep that file: since lane g71, section 6 step 2 stores it in production (`release-deploy.sh --release-record`), and the enable and the send are both checked against it.

If any step fails, steps 13 and 14 still run and no record is written. That is the design: there is no such thing as a partially passed release gate — and it is why a `plan`, `create` or `deploy` run writes no record either. A stage that stopped early and a stage that was never asked to go that far look the same to section 6, which is the correct answer to both.

### 3.1 Watching it without credentials

Every pull request runs the `dry-run` job, which prints the entire plan — every `terraform` and `aws` invocation the rehearsal would make, in order — with no credential present. Read it before you run the real thing. You can run the same thing locally:

```bash
FSS_REHEARSAL_DRY_RUN=1 FSS_REHEARSAL_REPORTS=/tmp/fss-rehearsal \
  infra/scripts/rehearsal-restore-drill.sh fss-rh-dryrun
```

---

## 4. Production apply — David

Follow `docs/greenfield/infra-apply-runbook.md` section 3.2 for the plan and apply.

**You pass no `assume_deployment_role` here.** It defaults to `true` in every root, which is what a person running a local apply wants: the provider assumes `fss-prod-deploy` for you. The flag is for a session that has already assumed its role — the two rehearsal workflows, and nothing else (`infra-apply-runbook.md` 1.1).

**Never apply or deploy production while a rehearsal run is in progress.** Watch Actions first, and if a rehearsal is running either wait for it or cancel it — reading 3.0 on what a cancelled `create` leaves behind before you do. Every rehearsal run records the sorted ARNs of every `Name`-tagged production resource before it starts and compares them when it finishes, setting aside ECS tasks, which ECS forgets on its own (8.0v). An ECS task-definition ARN carries its revision number, so a production apply or deploy in between changes that list, and the run fails its final guard reporting that the production inventory changed during the rehearsal. That guard is how Appendix G 39's last clause is measured rather than asserted, so the answer is never to weaken it. It is what tripped the seventh run's final guard (8.0s).

**Read the ECR lines first.** The production registry was bootstrapped by a targeted apply at commit 71d84e00, and `create_registry` has since given that module a `count`. The first plan after this change must show `fss-prod-api` and `fss-prod-worker` as **moved** — `module.stack.module.registry.…` *has moved to* `module.stack.module.registry[0].…` — and then report no changes to them. **A plan that proposes to destroy or replace an ECR repository is not to be applied.** It would delete the images every release record identifies, and the digests in section 6 step 2 would stop resolving. The `moved` block in `infra/modules/stack` is what makes this a state migration; if it is ever removed, this is the failure.

Three things belong to the release rather than to the infrastructure:

**The digests.** `api_image` and `worker_image` are the digests from section 2, not the tags.

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

**An app-only release is the rolling path** (8.0am): no stop, the apply, then `release-deploy.sh` without `--schema-change`:

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

`--release-record <release-record.json>` (lane g71) is optional. When given, after the final verify the script runs `fss admin release-record put` on the operations task and prints the stored record. Pass the file the green `full` rehearsal of these same digests wrote (section 3, step 15). Without it nothing about the deploy changes. Section 6 is where it matters: an enable of sending is refused unless its reference is a stored record naming the running API's digest.

**The policy, and it is not negotiable.**

- **Stop-during-migration.** From migration 0006 onwards every declared range is a strict `{N,N}`, so there is no build of this software that straddles a schema change and no honest way to migrate without an outage. `release-stop.sh` scales the API to zero first — so no request reaches a schema that is about to move — then the worker, which is given time to release its job leases, and it does so **before** the apply registers task definitions that refuse the current schema. `release-deploy.sh --schema-change` then refuses to migrate unless both are still at zero.
- **The database never rolls back.** There is no down migration in this repository and there will not be one. `packages/domain/db/migrations` is forward-only and `loadMigrations` refuses a gap.
- **After a successful migration and a failed deployment there are exactly two paths.** *Forward repair*: fix the code, build a new digest, deploy it. Or *the restore protocol*: `docs/greenfield/restore-drill.md`, all nine steps, with sending and dialing held until step 9. Redeploying the previous digests is only a rollback when their declared ranges accept the current schema version, which after a migration they usually do not — `infra/scripts/rehearsal-schema-ranges.sh` computed that during the rehearsal and told you. What is never a path is undoing the schema.

---

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

**What arrives after that.** Two alarms e-mail: `fss-prod-critical` and `fss-prod-warning`, each once when it goes to `ALARM` and once when it returns to `OK`. The sixteen metric alarms under them keep their state and send nothing, and a composite already in `ALARM` sends nothing more when a second member trips (8.0ac, `docs/greenfield/runbooks/README.md`).

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

The green `full` rehearsal wrote `release-record.json` into its `rehearsal-reports-<prefix>` artifact. Download that file from the run whose digests you are deploying, and pass it to the deploy:

```bash
gh run download <run id> --repo david-cui-bruno/founding-sales --name rehearsal-reports-<prefix> --dir /tmp/fss-green
infra/scripts/release-deploy.sh infra/roots/production fss-prod [--schema-change] \
  --api-digest <artifacts.api> --worker-digest <artifacts.worker> \
  --release-record /tmp/fss-green/release-record.json
```

After the final verify, the script runs `fss admin release-record put` on the operations task. It prints the stored record: the reference, `suite`, `apiDigest`, `workerDigest`, and `outcome` (`created`, or `existing` on a re-run). A different record under the same reference is refused `release_record_conflict`. Records are never replaced. The put enables nothing.

If production is already running the rehearsed digests, you do not have to redeploy to store the record. Run the put alone, from a checkout at the commit production runs, as the admin profile, with the production root initialised as for section 4:

```bash
export AWS_REGION=us-east-1
export WORKER_DIGEST="$(aws ecs describe-task-definition --task-definition fss-prod-operations \
  --query 'taskDefinition.containerDefinitions[0].image' --output text | sed 's/.*@//')"
export RECORD_BASE64="$(python3 -c 'import base64,sys; print(base64.b64encode(open(sys.argv[1],"rb").read()).decode())' /tmp/fss-green/release-record.json)"
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

A one-off task can only be handed arguments, so the record travels as base64. That also keeps the record's `fss-rh-` text out of the arguments the production guard reads. The record names the rehearsal it certifies, and the guard would otherwise read that as a rehearsal resource the command is about to act on. `fss admin release-record show --reference <reference>` reads a stored record back the same way.

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

Only when **4 and 5 and 3** are all true, and the attested record names the running worker's digest, does an automated email leave FSS. `packages/domain/outbound/gate.ts` reads all of it before every dispatch. When any part is false it refuses `workspace_sending_not_attested` or `automated_sending_disabled`, and names what said no. For the release half the `detail` is `deployment`, `workspace`, or one of the four codes above, never the reference. A worker deployed later from other digests therefore holds every send (`release_record_digest_mismatch`) until someone rehearses it, puts its record and attests again. `GET /settings` then reports `effectiveSendingEnabled: false` on an API whose digest the record does not name, so Home's sidebar says sending is off.

**What enabling sending commits you to.** A mailbox that has sent automated mail in the last thirty days is not disconnected and its Google authorization is not revoked, so that a late reply-based "stop" is still received and honoured (12.6's reply-only opt-out). This is the workspace's own operating rule, not a guard the software enforces yet; see `docs/greenfield/mail.md`, "Mailbox lifecycle: the thirty-day rule".

### 6.1 Turning it off

Withdraw either half, or deploy other digests: the worker holds every send when the attested record does not name its image. The attestation (`enabled: false`) stops it immediately and is a versioned change with a reason; the deployment flag stops it at the next deployment. Neither cancels a fence that has already entered `dispatching` — that message may have gone, and Appendix B is how it settles.

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

### 8.0 What the first credentialed run proved, and what it refuted

The rehearsal workflow was dispatched for the first time on 21 September 2026 (Actions run 35548888865, commit 68cee601). It got four steps in. What that is worth:

**Proved, and no longer a guess.**

- The GitHub OIDC trust works. The job in the `rehearsal` environment obtained a credential and `infra/scripts/rehearsal-caller-identity.sh` printed `arn:aws:sts::326255650484:assumed-role/fss-rh-deploy/fss-rh-202609210049` — an assumed-role session of the right role, in the right account, with the session name the workflow chose. G12e's `assume_deployment_role=false` rests on exactly that shape, and it is now observed rather than asserted.
- The role is assumable from that environment and the environment is configured: the digest refusal, the prefix decision and the identity check all ran, in order.
- The workflow's own structure holds. `if: always()` brought the teardown and the post-run guard up after the failure, and **no release record was written** — which is the correct outcome and the one thing the gate exists to guarantee.

**Refuted.**

- *"The dry run prints the plan the rehearsal would run."* It did not. The production-inventory read happens only in the credentialed branches of `rehearsal-prefix-guard.sh`, so the dry run never printed it and never judged it — and the rehearsal's own guard refused it on the first real attempt. Fixed: the read is printed in dry mode, and the printed plan is re-scanned by the same guard on every pull request (section 3, step 3).
- *"Teardown always runs."* It ran and stopped at its first step, because a run that created nothing has no restored instance to delete. Everything after it — the object-locked bucket, the root, the report — was skipped. Fixed: section 3, step 11.
- The state key, the backend and the KMS key were never exercised: the run never reached `terraform init`. Everything in 8.1 still applies.

### 8.0a What G12h changed, and what it could not test

The first credentialed run stopped before anything was created, and reading the
scripts in the order the workflow calls them found three things that no offline gate
could see (the decision record of 21 September, section 2). All three are now closed
in the plan and none has run against AWS:

- **Nothing in deployment ever ran a migration.** The step was named "migrate, then
  deploy the worker, then the API" and redeployed two ECS services. Both binaries
  refuse to start unless the applied schema version is exactly the range they declare,
  so on a fresh database that was two services that would never start. Closed by
  `infra/scripts/release-deploy.sh` and the `<prefix>-migration` task definition.
- **The drill called a command line that did not exist.** G12g wrote it; G12h runs it
  as one-off ECS tasks, because the database is private and the worker image is the
  only thing inside the VPC that can reach it.
- **The release suite was pointed at a database a GitHub runner cannot reach.** It now
  runs against the job's own `postgres:16` service container, which is what it was
  built for, and the step that assembled a URL from the rehearsal's outputs is gone.

Watch these, in this order, on the next run:

1. **`secretsmanager:PutSecretValue` on `fss-rh-*`.** The rehearsal fills its own two
   database entries (section 3, step 5) because it is unattended. If `fss-rh-deploy`
   does not hold that action the run stops at "Fill every secret entry" with an
   `AccessDenied`, and the fix is one statement scoped to `arn:aws:secretsmanager:*:*:secret:fss-rh-*`.
   Production never needs it: David fills both entries by hand.
2. **Whether the migration task can reach the database at all.** It runs in the public
   subnets with `assignPublicIp=ENABLED` under the worker security group, which the
   database security group already admits on 5432 and which admits nothing inbound.
   That is the same path the worker service uses, so it should work for the same
   reason — but no task has ever been launched into this VPC. A failure here looks
   like a task that starts, cannot connect, and exits 21 with `fss_failed`.
3. **Whether `fss migrate` accepts the RDS master user.** It refuses unless the
   connected role is a member of `migration`, with an exception only while that role
   does not exist — which is true on the very first run and false afterwards.
   `fss admin database-users ensure` grants the membership immediately after, so the
   second release is the one that tests it. If it refuses with `not_migration_role` on
   a later release, the grant did not happen and `ensure`'s report says so.
4. **Whether the task's log stream carries the report.** The drill's answer comes back
   through CloudWatch, not through a file (`docs/decisions/g12h-the-report-comes-back-in-the-log.md`).
   If `awslogs` truncates or reorders a large JSON object the capture will fail with
   "the task printed no JSON report on stdout", which is a legible failure and a real
   possibility for the step 8 report.
5. **How long the whole thing takes now.** Every database step costs about a minute of
   Fargate startup, and there are five of them in a deploy plus two in the drill. The
   180-minute job timeout was already dominated by the Multi-AZ restore.

### 8.0b What the second credentialed run proved, and what it refuted

Dispatched on 21 September 2026 at commit 02cd48e7 (Actions run 35602423640, after a first attempt that lacked the per-run state permissions).

**Proved.**

- The `secretsmanager:PutSecretValue` grant on `fss-rh-*` is in place (8.0a item 1 is closed as a permission; the fill step itself has not yet run).
- `terraform init` against the per-run state key works: the backend, the lock table and the state KMS key were exercised for the first time. Rehearsal state is readable and production state is explicitly denied — the boundary in 8.1 item 1 is now observed.
- The tolerant teardown behaves as section 3 step 13 describes for a run that created nothing: every step reported absence as done, the post-run guard passed, and no release record was written.

**Refuted.**

- *"The apply names every variable the root requires."* It named six of eight. `api_schema_range` and `worker_schema_range` have no default in `infra/roots/rehearsal/variables.tf`, and the apply was refused at variable evaluation with "The root module input variable api_schema_range is not set". Nothing had ever compared the workflow's `-var` list with the root's required variables: the dry-run job never runs `terraform`, and the offline gate's `terraform test` sets its own variables. Fixed: the workflow reads both ranges from the source (as `greenfield-images.yml` does) and passes them; scenario 22 derives the required list from `variables.tf` and reads the workflow for each name, with a mutation that removes one line.
- *"The teardown can destroy what the apply created."* Untested by this run, but the same reading shows it could not have: `terraform destroy` requires the same variables and the teardown passed only `name_prefix`. On a run that got past the apply, the teardown would have been refused and the environment left standing. Fixed: the create step writes `run.auto.tfvars.json` beside the root and the teardown refuses without it (section 3, step 13).
- Everything from the fill step onwards — 8.0a items 2 to 5 — is still untested.

### 8.0c What the third credentialed run proved, and what it refuted

Dispatched on 21 September 2026 at commit 845c6ed5 (Actions run 35611374218), the first
run with G12i's variables in place.

**Proved.**

- *"The apply names every variable the root requires."* It does now. The run got past
  variable evaluation, which is where the second run stopped, and
  `run.auto.tfvars.json` was written beside the root before the apply, in the same
  step and printing the count it wrote — so the teardown of a run that had created
  something would have had the values `terraform destroy` requires. 8.0b's first
  refutation is closed.
- The per-run state key works a second time: `terraform init -reconfigure` against
  `fss/greenfield/rehearsal/<prefix>/terraform.tfstate` succeeded, as it did on the
  second run. The backend, the lock table and the state KMS key are no longer a guess.
- The teardown and the post-run guard ran, as `if: always()` makes them, on a run that
  had created nothing — the case section 3 step 13 describes — and **no release record
  was written**, because the record step follows a failed step and is skipped.

**Refuted.**

*"The rehearsal root can be planned in CI."* It cannot, or could not: `terraform plan`
failed with two independent errors before it reached AWS at all.

```
Error: Attempted to load application default credentials since neither `credentials` nor `access_token` was set in the provider block. No credentials loaded.
  with provider["registry.terraform.io/hashicorp/google"], on providers.tf line 33, in provider "google"

Error: Invalid count argument
  on ../../modules/alerts/main.tf line 262: count = var.kms_key_arn == null ? 1 : 0
  The "count" value depends on resource attributes that cannot be determined until apply.
```

Neither is an AWS fact and neither had anything to do with the other; Terraform reports
independent plan-time errors together, which is the one piece of luck in the sequence.

**Why no offline layer saw either of them.** Three layers run on every pull request and
all three are blind to plan-time reality in the same way:

- `terraform validate` and `terraform fmt` never configure a provider, so a provider
  that cannot obtain a credential is not a validation error. At 845c6ed5 the rehearsal
  required the Google provider only because `infra/modules/stack` held `module
  "pubsub"`, and Terraform configures every *required* provider during plan even when
  the module has zero instances. G12j moves that module to the production root and
  removes the provider and the `gcp_*` variables from the rehearsal root, so the
  rehearsal no longer declares it at all.
- `terraform test` with `mock_provider` sets `override_during = plan`, which makes
  computed attributes **known** during plan — the opposite of what a real plan does.
  The alerts module's own tests also pass a literal `kms_key_arn`, so the expression
  `count = var.kms_key_arn == null ? 1 : 0` was never evaluated against the unknown the
  stack actually passes it (`module.observability.kms_key_arn`, a key created in the
  same apply).
- The dry-run job scans the scripts and prints their plan; it runs no `terraform` at
  all, by design, because it holds no credential.

The discovery tool for this class is a real `terraform plan` and nothing else. Both
errors are G12j's: the alerts module takes a plan-time-known boolean instead of testing
the ARN for null, `module "pubsub"` moves to the production root so the rehearsal
requires no Google provider, and the mock providers keep computed values unknown so
`terraform test` reproduces a real plan. G12k is the other half: the rehearsal workflow
gained the `plan` stage (3.0), so the next error of this class costs minutes rather than
a whole gate, and the local production plan (`infra-apply-runbook.md`, "Plan first")
comes before even that.

Three runs, three errors, one per run, each of a class the pull request could not see:
a guard refusing its own read (8.0), two unpassed required variables (8.0b), and a
provider with no credential beside a `count` on an unknown (here). The rule they add up
to is in COMMON-G and in the decision record
`docs/decisions/g12k-the-rehearsal-has-stages-and-one-gate.md`.

### 8.0d What the fourth credentialed run (create) proved and refuted

Dispatched on 21 September 2026 at commit 679460c6 (Actions run 35628963637), the first
run of G12k's `create` stage, after a `plan` stage that was green in CI (run 35626442598)
and locally (138 to add).

The apply reported **25 errors**. The teardown then failed and left residue. That is a
worse-sounding outcome than the three runs before it and a much better one: for the first
time the run got past the plan and into AWS, so every error is a fact about the account
rather than about the configuration's shape, and they arrived 25 at a time instead of one
per hour.

**Proved.**

- *The `plan` stage is worth having.* It was green, and the errors below are all of
  classes a plan cannot see: IAM denials, a retired engine version, and a resource-based
  policy refusing its own author. Three runs had been spent one error at a time; this one
  produced six classes at once, which is what the stage was added for.
- *`run.auto.tfvars.json` is the one list.* The apply named no variable of its own and
  took every value from the file the plan stage wrote, and the teardown read the same
  file. 8.0b's second refutation is closed.
- *The apply reaches AWS.* Provider configuration, the credential path with
  `assume_deployment_role=false`, the per-run state key, the lock and the state KMS key
  all worked, and Terraform got as far as creating resources.
- *The tolerant teardown runs.* `if: always()` brought it up after a failed apply and it
  worked through its steps rather than stopping at the first absence, which is what 8.0's
  second refutation asked for.

**Refuted.**

- *"The deployment role's policy covers the modules."* It does not, in six classes:

  | class | errors |
  | --- | --- |
  | `cloudwatch:PutCompositeAlarm` denied | 2 (`aws_cloudwatch_composite_alarm.critical`, `.warning`) |
  | `kms:CreateAlias` denied | 5 (every `aws_kms_alias`) |
  | Secrets Manager `Access to KMS is not allowed` | 8 (every `aws_secretsmanager_secret`) |
  | `ec2:AuthorizeSecurityGroupIngress` denied | 5 (`aws_vpc_security_group_ingress_rule`) |
  | `ec2:AuthorizeSecurityGroupEgress` denied | 3 (`aws_vpc_security_group_egress_rule`) |
  | `cloudfront:CreateOriginAccessControl` denied | 1 |

  The cause was structural rather than a list of omissions: `infra-apply-runbook.md` 1.1
  described the two roles' permissions in prose — "may act only on resources whose name
  begins `fss-rh-`" — and the repository shipped no policy document, so both roles were
  written by hand from that prose and nothing offline could compare either with the
  Terraform it was meant to apply. Closed by G16: the policy is
  `infra/policies/deployment-role-policy.json.tftpl`, the map from every
  `resource "aws_*"` type in the tree to the actions it needs is
  `infra/policies/terraform-resource-actions.json`, and
  `test/release/deploymentRolePolicy.check.ts` fails when a type needs an action the
  rendered policy does not allow — or allows and then cancels with a blanket deny, which
  is what the eight Secrets Manager errors were. The commands are in 1.1a of the runbook
  and the read-only check is `infra/scripts/check-deployment-role.sh`.

  Two of the six deserve naming because the shape of the mistake is instructive. The
  security-group *rules* were denied although the security groups were not: the `ec2:*`
  allow was conditioned on `ec2:ResourceTag/NamePrefix`, and a rule being created carries
  no resource tag yet, while the `RequestTag` statement beside it covered only
  `ec2:Create*` and the rule actions are `AuthorizeSecurityGroupIngress` and
  `AuthorizeSecurityGroupEgress`. And the eight Secrets Manager errors were not a missing
  allow at all — they were an explicit deny, `kms:GenerateDataKey*` and `kms:Decrypt` on
  every key but the Terraform state key, which Secrets Manager checks at `CreateSecret`.
  A policy can refuse a resource it has an allow for, and only an evaluation catches that.

- *"The journal can be torn down."* It cannot, by anybody but the account root.
  `infra/modules/journal`'s `DenyAnyDeletionOrLockWeakening` names `Principal *` with no
  exemption and lists `s3:BypassGovernanceRetention`, so the teardown was refused

  ```
  S3 DeleteBucketPolicy … 403 AccessDenied because of an explicit deny in the resource-based policy
  ```

  and the same for `PutBucketObjectLockConfiguration` — and the teardown's own
  `--bypass-governance-retention` emptying step could never have worked either. Residue:
  the bucket `fss-rh-202609211659-suppression-journal-326255650484` with its policy,
  object lock (GOVERNANCE, one day), versioning and public-access block, plus one state
  object `fss/greenfield/rehearsal/fss-rh-202609211659/terraform.tfstate` holding those
  four resources. Five KMS keys are pending deletion, which is the normal window and
  needs nothing. Closed by G16's `administrative_principal_arns`: the rehearsal root
  exempts its own deployment role from every deny but the transport one, production
  exempts nobody unless David sets a variable
  (`docs/decisions/g16-the-journal-deny-exempts-its-deployer.md`). 3.0 has the order for
  recovering that one orphan and the `teardown` stage is how it is dispatched.

- *"16.8 exists."* `InvalidParameterCombination: Cannot find version 16.8 for postgres`.
  AWS had retired it; `us-east-1` held 16.3, 16.4 and 16.9 through 16.15 that day.
  `infra/modules/database` now defaults `engine_version` to the bare major `"16"`, which
  `auto_minor_version_upgrade = true` makes diff-free against whichever minor AWS
  chooses. Note that the `plan` stage was green with `16.8` in it, so the lesson is not
  "plan first" — it is that a pinned minor's validity is a fact about AWS's retirement
  calendar on the day of the apply.
  `docs/decisions/g16-postgresql-is-pinned-by-major.md`.

**Explained after the run, by simulation.** `cloudwatch:PutCompositeAlarm` was denied although the two composite alarms are named `fss-rh-<run>-critical` and `-warning` and the hand-written policy's `cloudwatch:*` covered `alarm:fss-rh-*`. The errors carried no encoded authorization message, so David ran a read-only `simulate-principal-policy` for the action: CloudWatch authorizes it against `arn:aws:cloudwatch:us-east-1:326255650484:alarm:*`, not the composite alarm's own name, because the alarm rule references other alarms; the result was an implicit deny with no matched statement. The shipped policy therefore allows that one action on `alarm:*` (`CompositeAlarmsAreEvaluatedAgainstEveryAlarm`; a wildcard resource carries no tag, so no condition can narrow it) and `infra/scripts/check-deployment-role.sh` simulates it against that resource.

**What none of this settles.** Everything from the fill step onwards — 8.0a items 2 to 5
— is still untested: no migration task has ever been launched into a rehearsal VPC, no
`fss migrate` has met the RDS master user, and no drill report has come back through a
log stream.

### 8.0e What the fifth credentialed run (create, late 21 September) proved and refuted

Actions 35660873276, `stage = create` at ae53e7d2, after both rendered deployment-role
policies were installed and checked (99 of 99 actions allowed for each role).

**Proved.** The installed rehearsal policy carries a whole environment: 125 resources
were created — network, both KMS keys and their aliases, the eight secret entries,
log groups with their metric filters and the alarms, the cluster, five task
definitions, the task roles, the load balancer and its listener, the CloudFront
distribution with its origin access control, the journal bucket with its lock and its
deny policy — and the teardown destroyed all 125 by name, reported
`journal_bucket=gone`, and the production guard passed. PR 162's teardown is proved.

**Refuted, once.** `CreateDBInstance` answered `KMSKeyNotAccessibleFault`, naming the
database module's own key. The CloudTrail record of the window says what actually
happened: on that key RDS's `CreateGrant` and `DescribeKey` on the deployer's behalf
succeeded, and the one refusal was `kms:DescribeKey` on an AWS-managed key of the
account (`89caff99-…`, `alias/aws/secretsmanager`, the default Secrets Manager key), which RDS
describes while creating an instance with a managed master password even when a
customer key is given for the secret. The deployer could
describe only keys tagged with its namespace, and AWS-managed keys have no tags.
`kms:DescribeKey` is now account metadata in both role policies, which must be
rendered and put again before the next stage
(`docs/decisions/g18-rds-describes-a-default-key-the-deployer-could-not-see.md`).

**A wrong fix, added and removed the same night.** Before the record was read, the
refusal was explained as tag propagation (the KMS Developer Guide bounds it at five
minutes) and PR 163 added a five-minute wait between the key and the instance. The
record shows the tagged key was authorized within twenty seconds; the wait is removed.
The rule from here: when a service refuses, read that service's own record of the
refusal (CloudTrail names the action, the resource and the reason) before choosing a
fix. The message a service returns names the resource the caller specified, not
necessarily the one it was refused.

### 8.0f What the sixth credentialed run (create, 22 September) proved and refuted

Actions 35679472666, `stage = create` at 04816ad9, after both role policies were rendered,
put and checked again (100 of 100 actions allowed for each role). Plan 35679320156 was
green on the same commit.

**Proved.** `kms:DescribeKey` as account metadata was the right fix for the fifth run:
RDS reached past the key and into Secrets Manager. The teardown again destroyed all 125
resources by name and reported `journal_bucket=gone`; the production guard passed.

**Refuted, once.** `CreateDBInstance` answered `AccessDenied: The user isn't authorized
to create a secret in AWS Secrets Manager`. With `manage_master_user_password`, RDS
creates the master secret `rds!db-<uuid>` **in the caller's own session**, tagged
`aws:rds:primaryDBInstanceArn = <the instance's ARN>`, and the RDS User Guide lists
`secretsmanager:CreateSecret` and `secretsmanager:TagResource` among the permissions the
caller must hold for that. The role could create secrets only under its own name prefix
(`NamedResourcesInThisNamespace`), and `rds!db-` is not it. Both role policies now carry
`LetRdsCreateThisNamespacesManagedMasterSecret`: those two actions on `secret:rds!db-*`,
narrowed by `aws:RequestTag/aws:rds:primaryDBInstanceArn` matching this namespace's
instance ARNs. The tag is an `aws:` system tag that only a service can set, so the
statement is reachable only through RDS, and only for an instance whose name the
role could create in the first place
(`docs/decisions/g23-rds-creates-the-master-secret-in-the-callers-session.md`). The
policies must be rendered and put again before the next stage; the check now asks about
these two actions and about describing the secret afterwards, so it reports 103 of 103.

**Also refuted: that the reports artifact was being kept.** The upload step reported
that nothing under `.rehearsal-reports` was uploaded. `actions/upload-artifact` v4 skips
hidden paths unless `include-hidden-files: true` is set, which it now is. Every earlier
run's release record survives only in the job log and the step summary.

**Unproved by this run**, because the instance never existed: whether RDS also needs the
caller to hold `secretsmanager:DeleteSecret` or `secretsmanager:RotateSecret` on that secret
at deletion or rotation. The User Guide lists neither among the caller's permissions and
RDS performs both after the API call has returned, so the statement grants neither. If the
next teardown's `DeleteDBInstance` is refused, CloudTrail's Secrets Manager record of the
window says which action to add, and to which statement.

### 8.0g What step 0 at 01968250 found: the read row, refused by the simulator

Both policies rendered from 01968250 were installed, and the rehearsal role's check
reported one denial, the first time the read statement had ever been simulated:

```
DENIED  secretsmanager:DescribeSecret (implicitDeny) on arn:aws:secretsmanager:us-east-1:326255650484:secret:rds!db-11111111-…-AbCdEf
```

The row supplied `secretsmanager:ResourceTag/aws:rds:primaryDBInstanceArn` as context, which
is the key `ReadTheRdsManagedMasterSecretOfThisNamespacesInstance` was conditioned on. The
creation rows beside it, conditioned on `aws:RequestTag/aws:rds:primaryDBInstanceArn` with
the same colons in the tag key, were allowed. AWS's service reference for Secrets Manager
lists both `aws:ResourceTag/${TagKey}` and `secretsmanager:ResourceTag/tag-key` on
`DescribeSecret` and `GetSecretValue`, so the service honours either; the simulator, on
this evidence, evaluates the global family and not the service-specific one for this key.
The two read-side conditions (the allow, and the deny of every other `GetSecretValue`) now
use `aws:ResourceTag/aws:rds:primaryDBInstanceArn`, the check row asks under that key and
only of the rehearsal role (production holds no read statement, by design, and the row as
PR 168 wrote it would have failed the production check), and a denial now prints the
simulator's `MissingContextValues` beneath it, which is the line that would have
explained this one. Both policies must be rendered and put again; expect 103 of 103 for
`fss-rh-deploy` and 102 of 102 for `fss-prod-deploy`.

### 8.0h Discovery mode (David's decision, 22 September, afternoon)

After the sixth run and the step 0 stop that followed it, David asked why so many pull
requests had moved so little, and the honest answer was the shape of the loop: least
privilege for a deployment role was being discovered empirically, one refusal per forty
minute run, because the services the apply asks for call each other in the caller's
session, the message names the wrong resource, and the database, where the last two
refusals were, is created after the first 125 resources. He chose to break the loop once.
For one pass of `create`, `deploy` and `full`, `fss-rh-deploy` holds a wide allow on the
services the tree uses, with guards (runbook 1.1b; `docs/decisions/g25-discovery-mode-for-
the-rehearsal-role.md`). The CloudTrail record of that pass, read by
`infra/scripts/deployment-role-actions-used.sh`, is the source of the exact policy, which one more
run proves before anything touches production. `fss-prod-deploy` is never widened; the
renderer refuses to render discovery for it. Every deny of the normal document stays in the
discovery document, and the wide allow never names IAM, STS or DynamoDB.

**The first discovery document was refused by `put-role-policy`** (22 September, evening):
`Resource vendor must be fully qualified and cannot contain regexes`, for the two guards
written as `arn:aws:*:*:*:*fss-prod*` and `arn:aws:*:*:*:*delegated-worker*`. The put is
atomic, so the role kept its normal document. IAM's ARN grammar requires a literal service
segment; the guards now name production's version of every named shape the role can
address, one per service, the renderer refuses any resource whose service segment is not
literal, and the runbook validates every document with `accessanalyzer validate-policy`
(read-only) before it is put.

### 8.0i What the independent review found before the discovery pass (22 September, night)

An independent read-only review of the tree against AWS's service reference found four
things that would have stopped the pass at `deploy` or `full`, each fixed before the pass
ran: the migration entry was filled with the master JSON alone, which carries no host,
port or database name, so `fss migrate` could not build a connection (now assembled like
the runtime entry); the drill's point-in-time restore named no subnet group, parameter
group or security groups, so RDS would have placed it in the VPC's emptied default group
(now placed where the source instance lives, read from the source); nothing pointed the
rehearsal hostname at this run's load balancer, so the smoke had no DNS path (the runner
now resolves the hostname to the load balancer's addresses through `/etc/hosts`, keeping
Host, SNI and the certificate honest); and the teardown destroyed the subnet group while
the restored instance was still deleting (now waits). Two policy findings were taken as
well: `cloudfront:TagResource` joins the tagged-creation statement, because the service
reference no longer lists `CreateDistributionWithTags` as an action; and the discovery
allow no longer names `s3`, `ecr`, `sns` or `acm`, none of which ever refused a run, since
`s3:*` on `*` would have let the rehearsal role at production's state object in the
shared bucket, which a seventh guard now also denies by name. Whether RDS needs
`secretsmanager:DeleteSecret` from the caller at teardown remains for the pass to show.

### 8.0j What the first two `deploy` attempts proved: the migration task never reached the database (23 September, night)

Runs 35812168524 (at 1d9b8671, the operator's) and 35817370929 (at 555f0624, the first
the coordinator dispatched itself) both created the environment, filled the two database
entries, launched the migration task and stopped at `migrate: container migration exited
20`, with not one line of what the container said. CloudTrail showed the task launched at
once, its execution role reading both entries, no call by the task role and no refusal
anywhere; the container stopped about a minute after launch. The cause was in the tool:
`fss` read its configuration the same way for every command, and the *runtime*
connection came first — `neither DATABASE_URL nor DATABASE_SECRET_ARN is set`, exit 20,
before the command was looked at. The migration task definition carries exactly
`MIGRATION_DATABASE_SECRET` and `FSS_RUNTIME_DATABASE_SECRET_ARN` and, by design, no
`DATABASE_SECRET_ARN` (`infra/modules/cluster`, `tests/migration_identity.tftest.hcl`):
a migration applied with the application's credential must not be possible from there.
The Terraform test asserted the names; nothing asserted that the tool could start with
them. The 8.0i fix to the migration entry's shape was necessary and was never reached.

`fss migrate` is now the one command that reads its configuration with the runtime
connection optional; every other command still refuses without one, up front and naming
both variables. `apps/worker/test/fssTool.test.ts` runs `migrate` with exactly the two
names the task definition injects, and a mutation puts the old demand back.

The silence was a second defect. `release_print_task_logs` read the stream in the
seconds between ECS reporting the stop and the awslogs driver delivering the last lines,
found it empty, and printed nothing; it also returned without a word when given no log
group name. It now waits for a stream that exists but is still empty the way it already
waited for one that did not exist, always says which stream it read or why it read
nothing, and the wrapper keeps a copy of every one-off task's log beside its ARN record
under `.rehearsal-reports/tasks/`, which the artifact collects before the teardown
destroys the log group. `test/release/oneOffTaskLogs.check.ts`, with two mutations.

### 8.0k What the third `deploy` attempt proved: the database refuses a plain connection (23 September, morning)

Run 35876269976 (4afdeab9, the first with the 8.0j fix in the worker image) created the
environment, filled both entries, launched the migration task and stopped at
`migrate: container migration exited 21` — one code further than before, and this time
with the container's own lines in the job log and in `tasks/migrate.log`. The tool built
its configuration, opened the migration connection, and the database refused the
handshake: `infra/modules/database` sets `rds.force_ssl = 1`, the `pg` driver sends no
TLS unless `PGSSLMODE` or an `ssl` option says so, and nothing in the tree said so. No
process had ever reached the real database before this one; the parameter had been in
the Terraform tests since the module was written, and nothing tied it to the images.
Had the handshake been accepted, verification would have failed next: Node's bundled
roots do not include Amazon RDS.

Both images now set `PGSSLMODE=verify-full` and `NODE_EXTRA_CA_CERTS` pointing at AWS's
public RDS bundle, vendored at `certs/rds-global-bundle.pem` with its provenance in
`certs/README.md`. Every connection the API, the worker, `fss migrate`, the drill and the
operations task make is encrypted, the certificate is verified against the RDS
authorities, and the hostname is checked. `test/release/databaseTls.check.ts` ties the
parameter, the two Dockerfiles, the two ignore files and the bundle's hash together, and
two mutations guard it: the image dropping to `no-verify`, and the database ceasing to
force SSL.

The run also showed that 8.0j's log fetch had not yet earned its keep: `release_run_task`
returned on the non-zero verdict before it reached the fetch, so a *failed* task — the
only kind whose output matters — still printed nothing and kept nothing. The verdict is
now taken first, the log fetched whatever it was, and the failure returned after;
`oneOffTaskLogs.check.ts` drives the whole wrapper through its fixture hooks with a
stopped task that exited 21 and asserts the line and the kept copy, with a mutation.

### 8.0l What the fourth attempt proved: the migration ran; the next command had the same gap (23 September, midday)

Run 35883201716 (bb5eea61) is the first in which `fss migrate` ran against the real
database: schema 0 to 15, fifteen migrations applied over TLS, and the container's report
in the job log and in `tasks/migrate.log`. The next command, `fss admin database-users
ensure`, runs on the same migration task definition and was refused the way `migrate`
had been the run before: `neither DATABASE_URL nor DATABASE_SECRET_ARN is set`. 8.0j had
made one command runtime-optional by name; the task definition carries two.

The commands that run as the migration identity are now a list in the tool,
`MIGRATION_IDENTITY_COMMANDS`, and `apps/worker/test/fssCli.test.ts` reads
`release-deploy.sh` for every `one_off` on `$MIGRATION_TASK_DEFINITION` and requires each
to be in that list, and each entry in the list to be a command the parser knows. The
tool test runs `admin database-users ensure` with exactly the two variables the task
injects. A mutation removes the entry.

### 8.0m What the fifth attempt proved: two commands passed; no task can start on an empty entry (23 September, afternoon)

Run 35891175510 (2e3cc8cc) migrated the database and created the runtime login user
(`admin database-users ensure` exited 0: `app_runtime_login` created in `app_runtime`,
`migration` granted to `fss_admin`). The next one-off, `fss verify` on the operations
task definition, never started: `TaskFailedToStart — ResourceInitializationError: unable
to pull secrets … device-credential-pepper … can't find the specified secret value for
staging label: AWSCURRENT`. Terraform creates every entry empty; the rehearsal filled the
two database entries and nothing else; every task definition but the migration's injects
all eight. The same order was written into section 5 for production (fill the six after
the first deploy), and would have stopped the production deploy at the same step.

The rehearsal now fills all eight in the step that filled two, the six with fixtures of
the shape the code parses, driven by the stack's own list so an entry this step cannot
fill is a failure rather than a silent gap. Section 4.1 says every entry first; 5.1 is
now about changing a value. `test/release/secretEntriesFilled.check.ts` ties the stack's
list, the workflow step and the two sections together, with a mutation.

### 8.0n What the first production apply proved: the deployer could not see its journal (23 September, evening)

The first apply against `fss-prod` ran twice, and the second run is the one with a
finding in it.

**Run 1** created 134 of 138 resources and stopped on something unrelated to AWS
entirely: the Pub/Sub push subscription could not be given its identity, because
`constraints/iam.allowedPolicyMemberDomains` on the Google organisation refuses
`gmail-api-push@system.gserviceaccount.com` — a member outside the allowed domains. A
project-level override on `callie-fss` was set so the binding could be made, and it is to
be removed once the subscription exists; the organisation policy is the right default and
this project is the only exception it needs. Nothing about the journal is involved and
nothing in this repository could have planned around it.

**Run 2** is the finding. The plan proposed to create the suppression-journal bucket that
run 1 had already created, and to replace every resource hanging off it. CloudTrail names
the creator: `arn:aws:sts::…:assumed-role/fss-prod-deploy/fss-prod-terraform`,
`CreateBucket` at 17:36:12Z. What happened in between is that the bucket's own policy
denied `s3:ListBucket` to `Principal *` with no exemption in production —
**`HeadBucket` is authorised as `s3:ListBucket`** — so the role that created the bucket
was refused when it asked whether the bucket existed, and the AWS provider reads a 403 on
`HeadBucket` as "the bucket is gone". It removed `aws_s3_bucket.journal` from state and
planned a create.

Applying that plan cost two resources. The deletions it attempted were refused where
`DenyAnyDeletionOrLockWeakening` covers them — the bucket policy and the object-lock
configuration both survived, which is the deny doing its job — and went through where
nothing covers them: the **server-side-encryption configuration** and the **ownership
controls** were deleted. A deny list protects what it lists.

The same cause explains `fss-rh-202609211659-suppression-journal-326255650484`, the
rehearsal bucket left standing on 21 September, which was created before the rehearsal
root passed any exemption at all (8.0d).

**The repair, in order.** The account administrator replaced the live bucket policy with
`put-bucket-policy`, dropping `s3:ListBucket` from the reads deny — a bucket policy's
`Deny` on `Principal *` binds every principal in the account but not the account root,
and `s3:PutBucketPolicy` is not in the deny list, which is what makes a bucket in this
state recoverable at all. Then `terraform import` brought `module.stack.module.journal.aws_s3_bucket.journal`
back into state, run under the deploy role so the import reads the bucket the way the
apply will. Then `plan` and `apply` at the fixed commit, which restores the encryption
configuration and the ownership controls and writes the two-statement policy.

**What the fix is.** `infra/modules/journal` now denies object reads and listing in two
statements. `DenyObjectReadsFromAnyoneButTheTaskRoles` keeps `s3:GetObject`,
`s3:GetObjectVersion` and `s3:ListBucketVersions`, exempting only an administrative
principal the root names — nobody, in production.
`DenyListingFromAnyoneButTheTaskRolesAndTheDeployer` covers `s3:ListBucket` on the bucket
ARN alone and exempts the principal the root passes as
`journal_listing_principal_arns`, which **both** roots set to their own deployment role
and production sets unconditionally: an environment whose deployer cannot see its bucket
recreates it. Listing is not reading — the deployer may enumerate keys and is denied every
object by the bucket policy and by `NoDeploymentDataAccess` in its own IAM policy.
`docs/decisions/g37-the-deployer-may-list-the-journal-but-never-read-it.md`, with the
module test, both roots' teardown tests, the release check and a mutation.

### 8.0o What the seventh full run proved: the deploy path, and a step that measured the wrong thing (23 September, evening)

Run 35905867795 (d4e6708d) is the first that reached the far side of step 17. The whole
deploy path ran against a fresh environment: create took 16 minutes, every secret entry
was filled, and stop, `fss migrate`, `fss admin database-users ensure`, `fss verify`,
worker, API and `fss verify` again took 12 more. Every one-off task started, reached the
database, said what it had done and exited 0 — the four findings of 8.0j to 8.0m,
closed in one pass.

Step 18, "the declared schema ranges, against the deployed images", then failed in about
a second, and for reasons of its own.
`infra/scripts/rehearsal-schema-ranges.sh` carried two defects, both invisible for as
long as no run ever reached it.

**The overlap case named a task definition nothing creates.**
`PREVIOUS_RELEASE_SCHEMA_RANGE` is `{1,15}` and the current schema version is 15, so the
previous release's range accepts it and the overlap branch was the branch the numbers
chose. It ran `ecs run-task` against `<prefix>-<service>-previous`. No root registers
such a family — `infra/modules/cluster` registers `-api`, `-worker`, `-migration`,
`-operations` and `-drill` — and this was a first release, which has no previous image
anywhere. Whether that definition exists is now a fact the step *reads* before it uses
one: absent, it records `<service>_overlap=skipped_no_previous` and carries on, because
having no predecessor is a fact about history rather than a failed test; registered, its
`--selftest` must exit 0 and a refusal is a failure.

**The stale case measured the wrong thing, and would have passed for ever.** It called
`command aws ecs run-task` — deliberately outside the wrapper — with `FSS_SCHEMA_MIN`
and `FSS_SCHEMA_MAX` one below the image's minimum, and read a *successful API call* as
"the image accepted a range it does not support". Two things are wrong with that. The
refusal it is hunting for happens inside the container at startup
(`apps/*/src/bootstrap/config.ts`, `SCHEMA_RANGE_DISAGREES`), not in the `run-task`
response; and an `awsvpc` task definition cannot be launched without
`--network-configuration`, which that call never passed — so it was refused
client-side every time and the case passed vacuously.

**What changed.** Both cases now launch through `release_run_task`, the wrapper every
other one-off task already uses: it takes the network plan from the root's own output,
checks the registered image against the digest this release names, waits for the task to
stop, prints the task's log lines and reads the *container's* exit code. The stale case
requires exactly 12, which is `configurationInvalid` in both `API_EXIT_CODES` and
`WORKER_EXIT_CODES` and what either service image returns when the declared range
disagrees — not the `fss` tool's 20, since that tool is the migration and operations
entry point and reads no schema range at all. Exit 0 is the failure this case exists to
catch, and any other code fails with the code printed. The wrapper gained one option for
it, `--expect-exit`, because a comparison of exit codes belongs where the exit code is
already read rather than in a caller parsing output.

The step therefore needs both digests, and the workflow hands them to it exactly as it
hands them to step 17; the restore drill, which runs the same script for its step 7,
passes them in the environment and refuses up front without them.
`test/release/scenario22.check.ts` drives the whole script offline against a fake CLI —
a first release with no previous image, a registered previous image, an image that
accepts the stale range, and a container that stops for some other reason — and a
mutation puts the run-task reading back to prove the suite goes red when it does.

### 8.0p What the eighth full run proved: everything up to the smoke, and no first workspace (23 September, night)

Run 35919040315 (12b559e7) went further than any run before it. Create, the secret
fill, **step 17** (stop, `fss migrate`, `fss admin database-users ensure`, `fss verify`,
worker, API, `fss verify` again) and **step 18**, the schema-range refusals that lane
g38 had just rewritten, all passed. Both reverse cases behaved as 8.0o said they would:
no previous image is registered on a first release, so the overlap case recorded
`skipped_no_previous`, and both stale cases refused the declared range at startup with
exit 12.

**Step 19, the production smoke, then failed after ten minutes**: "the rehearsal
environment published no `CanaryCompletionAgeSeconds` datapoint in ten minutes". Ten
one-minute attempts, no datapoint, and the step said so rather than passing `None`
through — which is the improvement a previous lane made to this step and the reason the
message named the cause instead of printing `age=Nones`.

**Nothing was wrong with the smoke, the metric filter, the scheduler or the worker.**
`apps/worker/src/scheduler/sources.ts` inserts one canary **per workspace**:
`SELECT id FROM workspaces`. A freshly migrated database has no workspace row, so the
scheduler correctly found nothing due, emitted no canary, and published no datapoint.
The `canary_stale` alarm is `treat_missing_data = "breaching"`, so the environment also
sat in ALARM for being empty rather than for being broken.

**Underneath it was a larger gap, and it was about production rather than the
rehearsal.** `apps/api/src/auth/signIn.ts` refuses with `workspace_unknown` unless the
`workspaces` row exists and with `membership_required` unless an **active**
`workspace_memberships` row exists — while the `users` row is written only at the end of
a successful sign-in. Three rows that each presuppose the others, and nothing in `apps/`
or `packages/` inserted the first of them: `grep 'INSERT INTO workspaces'` found tests
and nothing else. A production release would have deployed cleanly, passed both
verifies, and left David with an API nobody could sign in to and an alarm nobody could
clear. `docs/greenfield/identity.md` stated the requirement and never said who creates
the first membership; `apps/api/src/routes/admin/memberships.ts` needs an authenticated
admin, which is the thing that cannot exist yet.

**What changed (lane g39).** `fss admin workspace bootstrap` creates the workspace, a
**provisional** admin `users` row and an active `admin` membership in one idempotent
transaction, under the runtime credential, with an `audit_events` row; the first
successful sign-in with that address replaces the sentinel `google_sub` with the real
Google `sub` and records `auth.provisional_user_adopted`.
`infra/scripts/release-bootstrap-workspace.sh` runs it through the same wrapper every
other one-off task uses, and the rehearsal runs it between steps 17 and 18. Production
runs the same script with `--environment production`, which is section 5.1a. The smoke
step needed no change: the scheduler's 60-second pass and the metrics publisher's
60-second pass both fit inside its ten-minute wait.

### 8.0q What the ninth full run proved: through the release suite, and a drill with nothing to reconstruct (23 September, night)

Run 35930664547 (f44eb6bf) is the first run to reach the restore drill. Create, the
secret fill, **step 17**, g39's **workspace bootstrap**, g38's **schema-range
refusals**, the **production smoke** — which 8.0p's missing workspace row had stopped
for ten minutes on the run before — and the whole **release suite in recorded mode**,
including the mutation check, all passed.

**Step 22, the restore drill, then failed after 67 seconds.** One in-VPC
`fss admin counts --as-of <restore target>` task ran against the source, and the script
refused by design:

```
FAIL: the drill baseline has no sends, so reconstructing them would prove nothing
      Appendix G 11 needs an accepted send, a reply, a suppression, a CRM edit and a migration
```

**The refusal is right, and it could never have been anything else.**
`docs/greenfield/restore-drill.md` 0.1 lists six things that must exist before the
restore target is read, and nothing in this repository produced five of them in a
deployed environment: there was no `fss` command for it and no workflow step, and the
release suite (step 21) runs on the runner against its own `postgres:16` service
container rather than against the rehearsal's private database. A fresh environment
could therefore never pass step 22, however correct everything before it was — and
`test/release/scenario11.check.ts` and a mutation entry pin the refusal, so relaxing it
was never the fix.

Two details that only a credentialed run makes visible sit underneath it. RDS's
`LatestRestorableTime` lags real time by up to about five minutes, so evidence written a
moment before the target is read is evidence the target *predates* — the restore would
land on a database without it and the same refusal would fire with the seeding having
worked. And `--use-latest-restorable-time` acts at the moment RDS is asked, which is
later than the instant the drill read, so work done in between is in the safe direction:
the restored database holds slightly more than the baseline counted, and every assertion
is a floor.

**What changed (lane g40).** `fss admin drill seed-evidence --workspace-slug S --phase
before|after` produces the five kinds through the domain's own entry points —
`createFirm`, `addEmailRoute`, `enrollContact`, `prepareOutboundMessage`,
`dispatchOutboundMessage` against the recorded Gmail client, `processMessageIds`,
`confirmReplyDisposition`, `recordSuppression`, `updateFirm` — idempotently, reporting
`created` or `existing` per item and ending with the same five counts `fss admin counts`
reports, because it calls the same function. `infra/scripts/release-seed-drill-evidence.sh`
launches it on the operations task definition through the same wrapper every other
one-off task uses, and refuses any prefix that is not `fss-rh-<run>`: production's drill
runs against real data and is never seeded. The workflow runs `--phase before` between
the workspace bootstrap and the schema ranges; the drill script waits for
`LatestRestorableTime` to pass the `asOf` instant that step recorded, then measures its
baseline, then runs `--phase after` — a second send and a second CRM edit — before
requesting the restore. Every existing drill assertion is unchanged, including the
refusal above.

### 8.0r What the first production smoke proved: five of six, and a metric that measured the gap between canaries (23 September, night)

The first production deploy reached section 6.1 and ran `scripts/productionSmoke.mjs`
against `https://api.usecallie.com`. Five of the six checks passed. The sixth did not:

```
FAIL canary (age=359.441672s limit=300s)
```

**Nothing was wrong with production.** The scheduler was inserting canaries, the worker
was completing them within seconds, and the metrics publisher was publishing every
minute. `FSS/CanaryCompletionAgeSeconds` was `extract(epoch FROM now() -
max(completed_at))` — seconds since the newest *completion* — while the canary is
inserted once per workspace per **quarter hour**
(`apps/worker/src/scheduler/sources.ts`). Sampled every 60 seconds, that is a sawtooth:
59, 119, 179, 239, 299, 359, 419, and back to 59 when the next canary completes. The
smoke read it at 359 and compared it with the 300 that 13.3's "canary not completed
within five minutes" gives. On a healthy idle system the value is above 300 for roughly
ten minutes of every fifteen, so the smoke check fails most of the time. The eighth
rehearsal's smoke passed only because it ran about two minutes after the workspace
bootstrap (8.0p) — the one moment in the cycle when the value is small.

**The alarm did the same thing, to the operator's inbox.** `fss-prod-canary-stale`
(threshold `var.canary_stale_seconds` = 300, period 60, two evaluation periods,
`treat_missing_data = "breaching"`) flapped OK→ALARM→OK three times in the first hour
and e-mailed on every transition. The operator ran
`aws cloudwatch disable-alarm-actions --alarm-names fss-prod-canary-stale` to stop the
mail. **That is temporary and the next `terraform apply` re-enables it**: actions are
alarm state that the resource sets, so the apply that follows this fix restores them
without anybody having to remember.

**What changed (lane g41).** The metric keeps its name — the alarm, the dashboard
runbook, the smoke and the docs all reference it — and changes to the meaning 13.3's
sentence actually describes: the newest canary run's **scheduler-to-worker latency**.
For the newest run of each workspace, `completed_at - inserted_at` when it has
completed and `now() - inserted_at` when it has not, and the worst of those, so one
workspace whose canary completes normally cannot hide another whose canary never
completes at all. Null when there is no run, unchanged, which is what the breaching
treatment of missing data is for. On a healthy system this stays at a few seconds
whatever the moment; when the worker dies the newest run never completes and the value
passes 300 within five minutes — which is exactly the alarm and exactly the smoke
check, and neither the threshold nor the name nor the period had to move.
`docs/decisions/g41-the-canary-age-is-the-newest-runs-latency.md`.

### 8.0s What the production deploy and the tenth full run proved: production is live, and two runs that must not overlap (23 and 24 September)

**Production is deployed and verified at `66203322`.** The production root was applied in
four passes — apply runs 1, 3, 4 and 5 — and `infra/scripts/release-deploy.sh` exited 0
on its third attempt at **02:27Z on 24 September**, every step of 4.1's order in order:
stop, `fss migrate` (schema 0 → 15), `fss admin database-users ensure`, `fss verify`, the
worker to 1, the API to 2, `fss verify` again against the running deployment. The
`api.usecallie.com` ALIAS answers (5.2), the SNS proof publish arrived (5.3), the first
workspace exists — `fss admin workspace bootstrap`, slug `callie` (5.1a) — and
`scripts/productionSmoke.mjs` reports **six of six**, the canary among them, at an age of
**1.0 second**: the metric 8.0r read as 359 on this same environment, now read with g41's
semantics. Both deployed digests are the ones the rehearsal ran — api
`sha256:511799ee…`, worker `sha256:a0b71b97…` — which is the comparison section 6 step 2
makes.

**A redeploy must not re-put the runtime database secret.** Deploy run 2, at this same
commit, failed at **step 4/7**, `fss verify`, with PostgreSQL `28P01`: `password
authentication failed for user app_runtime_login`. Nothing was wrong with the deploy. The
wrapper that fills the entries had re-put `fss-prod/app-runtime-database` with a freshly
generated password, which is right for a first deploy and wrong for every one after it —
`fss admin database-users ensure` sets the login role's password only when it **creates**
the role, or when `--rotate-password` says so, and `release-deploy.sh` does not pass it
(`apps/worker/src/tools/fss/databaseUsers.ts`: PostgreSQL cannot be asked whether a
password matches, so a command that always set it would silently rotate a credential the
services are holding). The secret therefore no longer matched the database; and because
the failure landed inside stop-during-migration, both services sat at desired count zero
until `AWSCURRENT` was moved back to the entry's creation-time version. The rule is
written into 5.1: on a redeploy the runtime entry is never re-put, and a rotation is a
put followed by `ensure --rotate-password`. `migration-database` is the other case and is
unchanged — it is filled each deploy from the RDS master secret, as 5.1 and
`infra-apply-runbook.md` 3.3 already say.

**Never apply or deploy production while a rehearsal run is in progress.** The seventh
run's production-untouched step (run 35905867795, 8.0o) tripped for this reason and no
other. `infra/scripts/rehearsal-prefix-guard.sh` records the sorted ARNs of every
production resource carrying a `Name` tag before the run and compares them afterwards,
and an ECS task-definition ARN carries its revision number — so a production apply or
deploy in between changes the list, and the guard reports that the production inventory
changed during the rehearsal run. The finding is real and the comparison is the one thing
Appendix G 39's last clause is measured by, so the fix is the order of work rather than a
softer guard: the workflow's `concurrency` group already keeps two rehearsals from
overlapping for exactly this reason, and production is the half it cannot see. Section 4
carries the rule.

**The tenth full run: the rehearsal and production share every metric.** Run 35943001092
(`337c8f88`, before g41 merged) passed the workspace bootstrap, ran g40's drill-evidence
seeder in the cloud for the first time — 64 seconds, `--phase before`, on the operations
task definition — and passed the schema ranges. The smoke then failed in **two seconds**
on a canary age of **837.9 s**, and that number was *production's* sawtooth rather than
the rehearsal's. FSS publishes `FSS/CanaryCompletionAgeSeconds` with no environment
dimension at all, so every rehearsal and production share the metric and share every
alarm that reads it: the rehearsal's smoke read production's datapoint, and
`fss-prod-canary-stale` sees rehearsal data. **Post-release, item g42:** an environment or
name-prefix dimension on the emitted metrics, on the alarms and in the smoke's query.
Dedicated accounts (PR 173) separate them as well, and neither change is a substitute for
the other — one account holding two environments is exactly this failure, and one metric
with no dimension would still be ambiguous inside a single account. **Fixed in lane g55,
with a namespace rather than a dimension:** every environment publishes, filters and
alarms in `FSS/<prefix>` (`FSS/fss-prod`, `FSS/fss-rh-<run>`), derived once in
`infra/modules/stack`; each task role may `PutMetricData` into its own namespace only, so a
rehearsal *cannot* publish into production's; the worker refuses to start without the
namespace or with one that is not its own prefix's; and the smoke step reads the root's
`metric_namespace` output. `docs/decisions/g55-one-metric-namespace-per-environment.md`
says why a namespace and what production sees on the apply that brings it in.

**A cancelled `create` leaves its state lock held, and resources nothing recorded.** Run
35944594998, at this commit, was cancelled mid-create so that the production apply and
deploy could run without the overlap the paragraph above describes. Two consequences, both
of them the cancel's:

* the interrupted `terraform apply` had written state — 120 resources — and never
  released its lock, so both halves of it stood: the S3 lockfile
  `…/terraform.tfstate.tflock` and the DynamoDB item. The run's own `if: always()`
  teardown and a later `stage=teardown` dispatch each failed inside 90 seconds at
  `Error acquiring the state lock`. The teardown ran exactly as designed; what it cannot
  do is take a lock its own run is still holding;
* three resources whose creation was in flight at the moment of the interrupt were
  created and never recorded in that state: the RDS instance `<prefix>-pg`, the ALB
  `<prefix>-alb`, and the CloudFront distribution in front of the updates bucket. A
  `destroy` of that state cannot see them, so a teardown that succeeds still leaves them.

The recovery was by hand, with the admin profile, and the commands are in 3.0:
`terraform force-unlock`, then the three orphans by name, then `stage=teardown` again.
**Post-release:** the teardown should force-unlock a lock whose `Who` and `Created` belong
to its own run, and should find and delete orphans by name prefix — or the create should
adopt them — because a cancelled create is a normal event and needs a teardown that copes
with it.

**The VPC quota is a prerequisite, not a detail.** Two rehearsal creates failed at
`CreateVpc`. EC2's **VPCs per Region** (`L-F678F1CE`) defaults to **5** in `us-east-1`;
each rehearsal environment is one VPC, production is one, and the account holds unrelated
ones — so the fifth is reached before anything about FSS is wrong, and the message is
about a quota rather than about the plan. Raised to 10, approved 18:32Z on 23 September.
`infra-apply-runbook.md` 1.7 now lists it with the rest of what has to exist before an
apply.

**Two things production left standing.** A production re-plan at this commit reports a
perpetual diff on the RDS parameter group's `apply_method` which changes nothing when it
is applied; post-release, pin the value or `ignore_changes` it, because a plan an operator
is told to read line by line must not carry a line they learn to skip. And the leaked
bucket `fss-rh-202609211659-suppression-journal-326255650484` of 3.0 is still there,
object-locked with its one-day retention and — as 3.0 says — locking nothing, because
that run never wrote an object. Deleting it is post-release cleanup.

**The signed desktop build is still unverified.** Desktop release run 35935100994 failed
at "Import the Developer ID certificate into a temporary keychain":

```
security: SecKeychainItemImport: MAC verification failed during PKCS12 import (wrong password?)
```

Either the `FSS_MAC_CERTIFICATE_P12` and `FSS_MAC_CERTIFICATE_PASSWORD` repository secrets
disagree, or the `.p12` was exported with an algorithm macOS `security import` does not
accept. The fix is to re-export the identity with
`security export -t identities -f pkcs12` (`docs/greenfield/install.md` has the two
commands), re-set both secrets from that export, and re-run the desktop release. Nothing
about the build has been shown to be wrong; nothing about it has been shown to be right
either, which is why it is in 8.1.

**The drill has a baseline now, and its later steps are recorded as open.** g40's seeder
means `infra/scripts/rehearsal-restore-drill.sh` gets its baseline — an accepted send, a
reply, two suppressions, a CRM edit and a migration, all through the domain's own entry
points — so the refusal that ended the ninth run (8.0q) is behind it. What is in front of
it is a list of prerequisites `docs/greenfield/restore-drill.md` 0.1 never listed, and
`docs/decisions/g40-the-drill-has-evidence-to-reconstruct.md` named the first three
deliberately, without inventing the work; the last two are what the runs since have
added:

* **step 1** — restore, and prove the generation mismatch holds sending and dialing —
  needs `fss admin dial-authorize --any` to find a dialable subject: an assigned firm with
  a *phone* route and a verified, enabled calling identity. A fresh rehearsal environment
  has neither, because the seeder creates email routes only, so the step refuses with
  `no_dialable_subject`, which is the tool declining to report a refusal it did not earn;
* **step 2** — replay the suppression journal — needs a journalled suppression the restore
  actually *loses*. Both of the seeder's suppressions are written before the restore
  target, so the restored database already has them and the replay inserts nothing; the
  fix is for the seeder's `--phase after` to add one;
* **step 3** — reconstruct sends from every Sent folder — needs a send fence left in
  `dispatching` or `reconciling` whose Message-ID the Sent folder proves was delivered.
  The seeded send reaches `sent` in one pass, which is what 0.1 asks for and not what
  step 3 reconciles;
* **steps 3, 4 and 6** need a connected mailbox the *drill task* can use, and the
  envelope key is the obstacle. `localDataKeyWrapper` generates its master key when the
  process starts, so the refresh token the seeding process wrapped cannot be unwrapped by
  the drill's process: g40 made the seeder re-wrap on every run, which fixes the seeder's
  own re-runs and not another task reading what it stored. Every mailbox step therefore
  reports `grant_revoked`;
* **step 8** reads `/tmp/at-failure.json` — the counts taken at the moment of failure —
  and nothing writes it. The file is in 0.1's prose and in step 8's `--at-failure`
  argument; the `fss drill` the script launches passes `--reports`, `--as-of`, `--from`,
  `--since` and `--all-mailboxes`, and no at-failure file at all.

**David's decision, about 03:00Z on 24 September: record them, do not chase them.** The
drill's later steps are **open**, the release path finishes now, and the drill is
post-release item 1. The consequence is stated rather than softened: the final `full` run
at this commit, 35948178549, is in flight and is expected to pass through the release
suite and then fail at the drill step — so its release record is not written, and this
release has none. `infra/scripts/rehearsal-release-record.sh` is the last step of the
`full` stage and runs only when everything before it passed (3.0), which is the design and
not a thing to work around. The first release record will come from the post-release run
that passes the drill. No drill assertion is relaxed to get one, which is the whole
content of the decision.

That leaves one question open and it is David's: section 6 step 2 reads a
`releaseGateReference` out of a release record before automated sending can be enabled,
and there is no record to read. The recommendation on the table is that sending waits for
one passing drill rather than for a waiver of the reference.

### 8.0t What the eleventh full run proved: the run outlived its credentials (24 September, night)

**The job held one session, and the session was shorter than the run.** Run 35948178549,
at the release commit `66203322`, prefix `fss-rh-202609240242`, assumed `fss-rh-deploy`
exactly once — at the step *Assume the rehearsal deployment role*, about **02:42Z**.
`aws-actions/configure-aws-credentials` is given a role ARN and a session name and no
`role-duration-seconds`, so the session lasts the default **3600 seconds**, which is also
`fss-rh-deploy`'s own `MaxSessionDuration`: an hour is both the default and the ceiling.
The run is longer than an hour and has been for several releases — create about **17
minutes**, deploy about **12**, the bootstrap, the evidence seed, the schema ranges and
the smoke about **5**, the release suite about **15**, and the drill at least **10** more.

At **03:42Z**, exactly one hour in, the credential expired. Three things then happened, in
this order:

* the restore drill died inside `aws rds wait db-instance-available` —
  `Waiter DBInstanceAvailable failed: An error occurred (ExpiredToken) …`, exit **255**.
  Appendix E step 1 had genuinely been issued: the point-in-time restore was accepted and
  the restored instance `fss-rh-202609240242-pg-restored` was being created when the
  waiter lost its credential. What failed was the wait, not the restore;
* *Tear the rehearsal run down* ran, as `if: always()` says it must, and failed at its
  **first** call — `GetCallerIdentity … ExpiredToken`, exit **254**. Nothing was
  destroyed. The whole environment leaked, the restored instance with it;
* *Nothing with the production prefix was touched* ran and failed the same way, at the
  same first call, for the same reason.

**The release suite had already passed**, at **03:32Z**, at this commit: the 42 scenarios
and the mutation check both green in the runner, ten minutes before the credential went.
So nothing about the code under test is implicated in any of this.

**The guard's failure was an authentication failure, not a production touch.** This
matters more than the leak, because "nothing with the production prefix was touched" is
the last clause of Appendix G 39 and the run left it unproved rather than disproved. The
guard never reached its inventory read: it could not obtain an identity, so it made no
comparison at all. Production was checked by hand immediately afterwards with the admin
profile — both task definitions still at **revision 3**, both services stable at their
declared counts — and nothing had moved. The correct reading of that step's red is "the
run could not tell you", not "the run found something".

**The leaked environment was torn down with a `stage=teardown` dispatch** for the same
prefix, which is exactly the stage 8.0d created for this shape of failure (3.0). It
succeeded: a fresh dispatch gets a fresh session, which is the whole of what the original
teardown was missing.

**The fix: the run renews its session, twice.** `.github/workflows/greenfield-release.yml`
now assumes the role **three** times rather than once — at the start as before, again
immediately before the restore drill, and again, on `always()`, immediately before the
teardown — and each renewal is followed by the same
`infra/scripts/rehearsal-caller-identity.sh fss-rh-deploy` assertion the first assumption
gets, because a renewal is a fresh assumption and the steps after it act as whatever it
produced. The renewal before the teardown carries `always()` for the same reason the
teardown does: a renewal conditional on the steps above succeeding is a renewal that is
missing exactly when it is needed. The `teardown` stage gets the same pair — it runs every
step whose condition is `always()` — so a standalone teardown dispatch is unchanged in
what it does and now starts its destroy on a session it just obtained.

**The follow-up, which is not this change: 7200 seconds on both sides.** Neither the role
nor the workflow asks for a longer session, and `role-duration-seconds` above 3600 is
refused outright while `fss-rh-deploy`'s `MaxSessionDuration` is 3600. Raising the role to
**7200** and then passing `role-duration-seconds: 7200` here is the belt-and-braces
version: the renewals make a two-hour run safe on today's role, and a two-hour session
would make them unnecessary rather than wrong. The role is defined outside this
repository's per-run state, so it is a separate, deliberate step.

**The desktop release, at the third attempt.** 8.0s left the signed build unverified after
run 35935100994 failed importing the `.p12`. The **second** build got past the keychain and
failed at notarization:

```
HTTP status code: 403. Invalid or inaccessible developer team ID for the provided Apple ID
```

`FSS_MAC_TEAM_ID` did not belong to the Apple ID in `FSS_APPLE_ID`. Apple reports this as
an authorization failure on the submission rather than as a bad argument, which is why it
arrives *after* a successful signing and a full upload. David verified the trio locally
with `xcrun notarytool history --keychain-profile …` — the command that answers "do these
three values work together?" in seconds — and re-set the secrets from what that proved.

The **third** build, run **35951921111**, signed, notarized, stapled, and published:
**Callie 1.0.0**, built from commit `66203322`, manifest signed, and the zip's `sha256`
verified from outside the build. It reached the update channel at **03:37Z**. Item 13 of
8.1 is closed by it.

**Post-release, the desktop workflow should preflight.** `xcrun notarytool history
--apple-id … --team-id … --password …` exercises exactly the credential triple that failed
here and returns in seconds. Run before the build rather than after it, a wrong team id
costs a few seconds instead of a full signing, packaging and upload.

### 8.0u What the first real sign-in proved: the API refused Google's own discovery document (24 September, night)

**Four refusals, one code.** The first real sign-in to production — `callie@usecallie.com`,
desktop **1.0.0**, workspace slug `callie` — was refused at **03:43Z, 03:46Z, 04:06Z and
04:09Z** on 24 September. Each time the browser leg worked: Google's consent screen
opened, the person signed in, and Google redirected to
`https://api.usecallie.com/auth/google/callback`. Each time the callback answered **400**
with the refused page, the audit log recorded `auth.sign_in_refused` with
`refusal: token_exchange_failed`, and the desktop stayed at "Waiting for your browser…",
because the handoff it polls for was never authenticated. Confirmed at about **04:20Z**.

**The cause was the API's own rule, not Google and not the configuration.**
`apps/api/src/auth/googleClient.ts` `discovery()` required every endpoint the discovery
document names to have the **same origin** as the issuer, `https://accounts.google.com`.
Google's live document, fetched with `curl` from
`https://accounts.google.com/.well-known/openid-configuration` that night, names three
hosts:

| Field | Value | Same origin as the issuer? |
|---|---|---|
| `authorization_endpoint` | `https://accounts.google.com/o/oauth2/v2/auth` | yes |
| `token_endpoint` | `https://oauth2.googleapis.com/token` | **no** |
| `jwks_uri` | `https://www.googleapis.com/oauth2/v3/certs` | **no** |

So `discovery()` answered null for the real document, every time; `exchangeCode()` then
answered `{ ok: false }` without ever posting to Google, and the callback turned that into
`token_exchange_failed`. Nothing reached Google's token endpoint on any of the four.

**The start step hid it.** `startSignIn` falls back to `<issuer>/o/oauth2/v2/auth` when
discovery is null (`apps/api/src/auth/signIn.ts`), and that fallback is right about the
authorization endpoint — so the half of the flow a person can see worked perfectly, and
the half that cannot fall back, because the token endpoint is the thing discovery vouches
for, failed with nothing in the log. The only trace was the audit row, and it said *that*
the exchange failed, never why.

**What was verified good, so that the fix is the rule and only the rule.** The production
sign-in client is accepted by Google: a probe of `https://oauth2.googleapis.com/token`
with the production client id and secret and a deliberately bogus code answered
`invalid_grant` — "Malformed auth code" — which is Google rejecting the *code* after
accepting the *client*. The API's network egress reaches Google. The redirect URI the API
sends is the one registered on the client. None of those needed changing.

**Why nothing caught it before production.** The rehearsal deploys its API `live`, with
the real sign-in client under the rehearsal redirect URI, but no step of a run ever signs
in: nobody opens a browser, and the smoke reads `/healthz`, `/readyz`, `/health` and the
canary age — the unauthenticated surface only. The API reads Google's discovery
document only when a sign-in starts, so no rehearsal has ever fetched it, and a
`recorded` deployment could not have either: it must name its own fake sign-in client
(`docs/decisions/g12b-sign-in-is-configured-or-the-api-refuses.md`), because a rehearsal
that fetched Google's documents would be testing Google's availability. The lane tests
run against a local provider (`apps/api/test/support/googleStub.ts`) that serves the
discovery document, the token endpoint and the key set from **one** loopback origin —
exactly the shape the old rule accepted. Every test passed against a Google that does not
exist.

**The fix (lane g45).** An endpoint is accepted iff it is **`https:` and its hostname is
either the issuer's hostname or ends with `.googleapis.com`** — Google's documented API
hosts — and the document's `issuer` must still equal the configured one exactly. The
attack the rule was written for is unchanged and still refused: a document whose token
endpoint is `https://evil.example/token`, `http://oauth2.googleapis.com/token`, or
`https://oauth2.googleapis.com.evil.example/token` makes `discovery()` answer null, and no
code or secret is posted anywhere. `docs/greenfield/identity.md` has the rule beside the
OIDC configuration. The tests now include Google's real document shape —
`apps/api/test/auth/discovery.test.ts`, against the production issuer and discovery URL
constants and an injected `fetch` that reaches nothing — and `test/release/scenario23.check.ts`
holds the same rule in the release suite, with two mutations in
`scripts/releaseMutationCheck.mjs` (the same-origin rule put back; the HTTPS requirement
dropped) that it must go red for.

**Failure is visible now.** `exchangeCode` returns a closed reason —
`discovery_unavailable`, `token_endpoint_status_<n>`, or `id_token_absent` — plus Google's
own `error` code when the token endpoint answered JSON with one. Two `warn` lines in the
API log group, neither carrying a code, a verifier, a token, the client secret or a
response body:

* `event: "token_exchange_failed"` with `reason` and, where Google gave one,
  `provider_error` — written once per refused callback, beside the audit row;
* `event: "oidc_discovery_unavailable"` with `step: "sign_in_start"` — written each time
  start falls back, so a null discovery is visible at the moment the browser is sent to
  Google rather than a minute later at the callback.

Had the second existed at 03:43Z the cause would have been in the log before the person
had finished signing in.

**The second Google-side check, closed before a real token reached it.** The id-token
validator compared `iss` with `https://accounts.google.com` exactly, and Google documents
`accounts.google.com` as a second form a genuine token may carry — so it now accepts the
configured issuer with or without its `https://` scheme and nothing else
(`apps/api/src/auth/idToken.ts`, held by the same scenario23 check and a mutation that
accepts any issuer).

**The lesson: the first real sign-in is the first test of this path, so it is a step.**
The rehearsal cannot exercise Google and should not; the lane tests exercise a Google-shaped
fake; so discovery, the token exchange, Google's key set and the id-token validation
against Google's real claims are first run by whoever first signs in to a production
deployment. That must be the operator, deliberately, **immediately after the production
deploy** — not the first person who happens to need the app. It is now section 5.2a,
with the log query that shows either warn line. Until an API built from the g45 commit is
deployed to production, sign-in to production cannot succeed.

### 8.0v What the twelfth full run proved: the renewals held, and the guard counted tasks ECS forgets (24 September, night)

**Everything up to the drill passed, at the commit production now runs.** Run
**35962272085**, at the release commit `02da3dd5`, prefix `fss-rh-202609240558`, was
dispatched straight after the production redeploy of the same commit (below). It passed
create, the fill of every secret entry, the deploy path, the workspace bootstrap, the
drill-evidence seed, the declared schema ranges, the smoke and the release suite — every
stage 8.0q and 8.0t had already shown passing, again, at the commit that carries g44's
renewals and g45's sign-in fix.

**The renewals held — item 17's first half, answered.** Both of g44's steps ran against
AWS for the first time and both succeeded: *Renew the session before the restore drill*,
followed by *The renewed identity is the rehearsal role and nothing else*, and — on
`always()`, after the drill had failed — *Renew the session before the teardown,
whatever happened above*, followed by the same assertion. Each renewal requested a fresh
OIDC token and each renewed session passed `rehearsal-caller-identity.sh fss-rh-deploy`.
The run was well past an hour when it reached the teardown, which is exactly the point at
which 8.0t's run had lost its credential.

**The teardown ran cleanly on the renewed session.** It destroyed the environment, the
restored instance with it, and left nothing for a `stage=teardown` dispatch to remove.
That is the first clean teardown of a `full` run since the run grew past an hour.

**Then the production guard failed, and production had not moved.** *Nothing with the
production prefix was touched* read the inventory at about **07:10Z**, compared it with
the one recorded at about **05:59Z**, and failed with
`FAIL: the production inventory changed during the rehearsal run` and a diff of exactly
**twelve deleted lines**, every one of the form

```
arn:aws:ecs:us-east-1:326255650484:task/fss-prod-cluster/<id>
```

Those were ECS **tasks**, not services, task definitions or anything else. The inventory
is `resourcegroupstaggingapi get-resources`, which is tag-based, and a service's tasks
carry its propagated `Name` tag, so the tagging API lists them. The twelve were the tasks
the production rolling redeploy stopped between **05:50Z and 05:57Z**: the old service
tasks and the deploy's one-off migrate, database-users, verify and bootstrap tasks. ECS
keeps a stopped task visible for about an hour and then forgets it, so they were still
listed at 05:59Z and had aged out of the tagging API by 07:10Z. Both production services
stayed stable on their new task definitions, **revision 4**, for the whole run. The
order-of-work rule in section 4 had been kept, since the production deploy finished before
the rehearsal started, and the guard still tripped. This time it counted resources that
change on their own, not a deploy that overlapped the run.

**The fix (lane g47): the comparison is between durable resources.**
`infra/scripts/rehearsal-prefix-guard.sh` now passes both sides — the recorded file and
the fresh read — through `durable_inventory` at comparison time. That function drops
every ARN whose service is `ecs` and whose resource part begins `task/`, and keeps
everything else. The ARN is parsed rather than matched as a substring, so
`task-definition/fss-prod-api:5` is still compared: a new task-definition revision is a
production touch and still fails the guard, and so does a missing service, cluster, log
group, alarm, bucket or role. The recorded file stays the raw read, which keeps the
evidence of what existed, and because the filter is applied to the recorded side too, a
file recorded by an older guard compares correctly. Each side logs how many task ARNs it
set aside. `test/release/scenario39.check.ts` runs the guard against this run's shape
(twelve stopped tasks before, none after, the running ones and a replacement: pass) and
against a new revision, a removed revision, a removed service and a removed cluster (fail,
naming the resource each time), with three mutations in `scripts/releaseMutationCheck.mjs`
it must go red for.

What this gives up: a task launched into production during the run no longer shows in the
comparison. That direction was never this comparison's to catch. `release_run_task`
refuses a production name in a rehearsal launch per launch (G12h), and the guard's
identity check refuses a run that was not `fss-rh-deploy`.

**The restore drill's new stopping point: its first task after the restore.** The
point-in-time restore itself succeeded this time. With the session renewed, `aws rds wait
db-instance-available` returned, `fss-rh-202609240558-pg-restored` was available in about
**twelve minutes**, and the drill logged the restored instance's create and
latest-restorable instants (`restored instance instants: …`) and its endpoint. Appendix E
step 1's restore has now run to completion in the cloud. The drill then stopped at
`steps 1 to 9: one in-VPC task against the restored instance`, before the task was
launched:

```
FAIL: this task would connect to 'fss-rh-202609240558-pg.….rds.amazonaws.com' and the database this release targets is 'fss-rh-202609240558-pg-restored.….rds.amazonaws.com'.
```

The drill task definition still names the **primary** database host in
`FSS_DATABASE_HOST`, and the run-task wrapper's host check
(`release_guard_task_definition`, `infra/scripts/release-common.sh`) refused the launch
because that differs from the restored endpoint the drill targets. The restored endpoint
does travel as an `--env FSS_DATABASE_HOST=…` override, from
`infra/scripts/rehearsal-run-task.sh`. The trouble is that the same script also passes the
restored endpoint as `--database-host`. `release_run_task` skips the definition's host
check only when the override *differs* from `--database-host` ("a drill step pointed at
the restored instance overrides it on purpose"). With both naming the restored instance,
the exemption never fires, and the definition, which names the primary, is compared with
the restored endpoint and refused. Nothing offline caught it for two reasons. The dry run
reads no task definition, so the host check never runs there. And
`test/release/support/runTaskGuards.sh` exercises the override with `--database-host`
naming the primary, the one shape that passes.

So the drill needs a database-host override the wrapper honours for the restored endpoint:
either `--database-host` stays the primary host the definition names and the override
alone carries the restored one, or the drill task definition takes the restored host as a
parameter of its own. That is the **first concrete item of the drill work David
deferred** (his option 2, 8.0s and 8.1 item 12). It is recorded here and not changed in
this lane. Past it lie the five reasons 8.0s lists, which no run has yet reached.

**Production, at the same commit.** The redeploy at 05:50–05:57Z put `02da3dd5` into
production, which carries lane g45's discovery rule and id-token issuer fix (8.0u). The
sign-in fix was live at **05:56Z**. David's retry of the first real sign-in (section 5.2a)
was still pending when this was written.

### 8.0w What the thirteenth full run proved: every step but the drill, and the drill found its next wall (24 September, morning)

**Every step but the deferred drill passed.** Run **35976297919**, at `226d50b4`, which
is main with lane g47's durable inventory (PR 188) and lane g48's drill host argument
(PR 189), prefix `fss-rh-202609240838`, was dispatched at **08:37Z** with production's
own image digests: API `sha256:c7fff87c…` and worker `sha256:67fe5612…`, both built at
`02da3dd5`. No path that goes into either image changed between `02da3dd5` and
`226d50b4`. `desktop_commit_stamp` was `66203322`, the commit the published desktop was
built from. The run records the stamp and does not compare it: the release workflow
hands it only to `rehearsal-release-record.sh`. In order:

* create, passed at **08:57Z**; the fill of every secret entry, passed;
* the deploy path, passed at **09:07Z**; the workspace bootstrap, the drill-evidence
  seed and the declared schema ranges, passed;
* the smoke, passed at **09:12Z**; the release suite, passed at **09:32Z**;
* *Renew the session before the restore drill* and its identity assertion, passed;
* the restore drill, deferred by David's option 2, failed (below);
* *Renew the session before the teardown, whatever happened above* and its identity
  assertion, passed;
* the teardown, passed at **09:57Z**;
* *Nothing with the production prefix was touched*, passed.

This is the first full run in which every step but the drill passed. It is also the
second run to prove lane g44's renewals (PR 186), after 8.0v's, and the first to prove
lane g47's durable inventory. The guard logged `3 ECS task ARN(s) set aside` for the
recorded side and again for the fresh read, then `pass: nothing with the production
prefix was addressed`. The account went back to its baseline: five VPCs and nothing
carrying the run's prefix, the restored instance included.

**The drill: the restore again, and then its task started.** Step 0b, the activity the
restore has to lose, passed. Step 1's point-in-time restore passed:
`fss-rh-202609240838-pg-restored` was available in about **fourteen minutes**, and its
logged create and latest-restorable instants were **09:37:21Z** and **09:43:31Z**. With
lane g48's fix the run-task wrapper accepted the launch and logged `drill: target
database host fss-rh-202609240838-pg-restored.…`. That is the first time the drill task
has started against a restored instance. It exited **21** after about 25 seconds:

```
fss_failed command=drill error_message="ENOENT: no such file or directory, open '/tmp/fss-drill/step0-baseline.json'"
```

**What the repository shows about that line.** The immediate failure is a write, and
behind it is a handoff that does not exist.

* `rehearsal-restore-drill.sh` launches the drill as `fss drill --reports /tmp/fss-drill
  --as-of <restore target> --from … --since … --all-mailboxes`. It passes `--as-of` and
  not `--baseline`. The baseline the runner measured on the source came from the
  separate `baseline` one-off task on the operations definition. It came back through
  that task's log stream to `baseline.json` in the runner's `.rehearsal-reports/`,
  where step 0's refusal read it, and it stays there. Nothing hands it to the drill
  task.
* Given `--as-of` and no `--baseline`, `runDrill` (`apps/worker/src/tools/fss/drill.ts`)
  measures step 0 again inside the task and writes the result to
  `<reports>/step0-baseline.json`, the first of its per-step files. Nothing creates
  `/tmp/fss-drill` in the container. `Dockerfile.worker` creates `/tmp` and nothing
  under it, the drill task definition mounts nothing, and `runDrill` writes into its
  reports directory without creating it. The `open` in the message is that write. It
  comes after the counts query in `step`, so the task had already connected to the
  restored database and read its counts. A `--baseline` file that could not be read
  would have been refused as `baseline_unreadable`, which is `fss_refused` and exit
  20. A thrown error is `fss_failed` and exit 21, which is what the run logged.
* Offline, the dry run writes a sample drill report instead of launching the task, so
  this path had never run.

**The next item of the deferred drill work is the baseline handoff.** The baseline has
to reach the drill task. It is small enough to travel as an argument or environment
value in the task override, or it can travel as an object the drill task can read. The
drill also needs a reports directory that exists before its first write. Creating the
directory alone would get the task past this write, but its step 0 would then be
measured again on the restored instance, not taken from the source baseline that the
runner measured and checked. Which way the baseline travels is a design choice for the
work David deferred (his option 2, 8.0s and 8.1 item 12). It is recorded here and not
changed in this lane. The five reasons 8.0s lists still come after it.

**Lane g53 made that choice after this run, in code, and no run has proved it yet.** The
baseline travels in the drill task's command override as `fss drill --baseline-json
'<json>'`. The runner compacts `baseline.json` to one line holding `asOf` and the five
counts, because `release_run_task` reads the command one word per line. That keeps the
override the same size however many workspaces there are, and every value in it is
public. The drill writes the value to `<reports>/step0-baseline.json` and reads it as step
8's `--before`. `runDrill` now creates its reports directory, recursively and with mode
700, before its first write, and refuses `reports_unwritable` if it cannot. The run-task
wrapper JSON-encodes each command word, so the braces and quotes arrive unchanged, and
the production-name refusal has nothing to object to. `test/release/scenario11.check.ts`
drives the wrapper to prove it. An environment override was the other candidate.
`rehearsal-run-task.sh` forwards only the restored host, though, so that route would
have meant changing the wrapper every one-off task shares, for a value that is an
argument in every other sense (`docs/decisions/g53-the-drill-is-handed-the-source-baseline.md`).

**Production, at the time of writing.** Lane g45's sign-in fix (PR 187) has been live in
production since **05:56Z** at `02da3dd5` (8.0v). David's retry of the first real
sign-in (section 5.2a) is still pending: no callback has reached the API since the
redeploy.

### 8.0x What the first sign-in proved: the Mac client had no way to connect the mailbox (24 September, afternoon)

**Sign-in worked.** At **15:08Z** on 24 September David signed in to production from the
published desktop **1.0.0**, built at `66203322`, against the API that carries lane g45's
discovery fix (8.0v). It is the first production sign-in that succeeded, and the first
time the g45 rule met Google's real discovery document, token endpoint and key set. The
main window — heading **Today**, `apps/desktop/src/renderer/renderer.ts` — showed its
"This Mac" card with Name, Device, Workspace, Role `admin` and Registered, and two
buttons: **Sign out** on the card and **Refresh** below it. Role `admin` is the membership
5.1a bootstrapped. The two log checks section 5.2a asks for are not recorded in this
section.

**And then there was nothing to press.** Section 5.4 says "connect the mailbox from the
Mac client: it opens the Google consent screen in the system browser…", and
`docs/greenfield/mail.md` assumes the same. No control anywhere in the desktop connects
Gmail. `grep -rn "gmail/connect\|gmail/status\|gmail/disconnect" apps/desktop/src
packages/contracts/src` finds nothing at `66203322`, while the API serves all four paths
in `apps/api/src/routes/gmail.ts`:

| Path | What it is |
|---|---|
| `POST /gmail/connect` | The authenticated user command `connect_mailbox`. `beginGmailGrant` signs a ten-minute state and returns Google's consent URL. |
| `GET /gmail/status` | The caller's own mailbox: address, status, baseline state, last sync. |
| `POST /gmail/disconnect` | The command `disconnect_mailbox`. |
| `GET /oauth/gmail/callback` | Google's browser redirect. Verifies the state, exchanges the code, creates the mailbox in `baseline_pending`. |

Until a mailbox connects, the two production alarms that wait for one,
`fss-prod-mailbox-heartbeat-missed` and `fss-prod-gmail-watch-expiring`, stay red, and
nothing the operator had could clear them.

**Why nothing caught it.** G7 built and tested the API half, and
`apps/api/src/routes/mailSupport.ts` said the command schemas would move to
`@fss/contracts` "in the pull request that adds the screen". No lane carried the screen.
The API tests drive the routes directly, the desktop suite tests what the desktop has,
and nothing asked whether a client called the routes at all. The rehearsal never signs
in (8.0u), so no run reached the step where the gap shows.

**The fix (lane g50): a Mailbox row on the "This Mac" card.**

| State | What the row shows | What there is to press |
|---|---|---|
| Never connected | **Not connected** | **Connect Gmail** |
| Waiting for the browser | the same text, and a hint to press Refresh if the browser said "Gmail not connected" | the button reads **Waiting for your browser…**, disabled |
| Connected | `address · connected · baseline pending`, then `· ready` once the baseline completes | nothing |
| Revoked or disconnected | `address · revoked` or `address · disconnected` | **Connect Gmail** |
| Not yet read, or unreadable | **Checking…** or **Unknown** | nothing (Refresh reads it again) |

* Connect Gmail asks the main process, never the renderer (whose policy stays
  `connect-src 'none'`). `apps/desktop/src/main/mailboxBridge.ts` sends
  `connect_mailbox` through the same authenticated client every other window uses, so the
  envelope, the token and the version gate are the session manager's. It opens the
  returned consent URL with `shell.openExternal`, exactly as sign-in opens Google, and
  only if it is an `https:` URL. The URL never crosses the bridge.
* The main process then reads `/gmail/status` every two seconds. It stops when the
  mailbox is connected, when the grant's signed state expires (ten minutes, the API's
  own), when the server refuses, or when the person presses Refresh. The row is also read
  again whenever the window regains focus, which is when a person comes back from the
  browser.
* A refusal is one fixed sentence on the card, never a dialog. An unknown code is shown
  as it came.
* **There is no Disconnect.** `docs/greenfield/mail.md` ("Mailbox lifecycle: the
  thirty-day rule") keeps a mailbox that sent automated mail connected for thirty days
  after its last automated send, and says its guard, a refusal with an audited admin
  override, belongs to a later lane. A Disconnect button would be a way round a rule the
  software does not yet enforce, so the row shows status only. `POST /gmail/disconnect`
  is unchanged.
* The connect and disconnect command schemas moved to `@fss/contracts`
  (`packages/contracts/src/mail.ts`) with the two answer shapes. The route's status body
  is typed against the status shape, and the Mac parses it with the same schema.

**The Gmail callback's token exchange, checked before it runs.** 8.0u's lesson was that a
Google-side path is first tested by whoever first runs it, and Connect Gmail starts the
next one. The Gmail grant does **not** use discovery or `exchangeCode`, and applies no
same-origin or issuer rule. `beginGmailGrant` and `completeGmailGrant`
(`packages/domain/mail/oauth.ts`) call the `GmailClient` port. The live API gives it
`createGmailHttpClient`, which posts the code to its configured token endpoint, and
`readApiDeployment` fixes that to `https://oauth2.googleapis.com/token`, the consent
screen to `https://accounts.google.com/o/oauth2/v2/auth` and the profile read to
`https://gmail.googleapis.com`. No id token comes back, because the grant asks for
`gmail.readonly` and `gmail.send` and not `openid`, so no key set is fetched either.
Nothing needed changing, and the scopes and the redirect URI
(`${FSS_PUBLIC_ORIGIN}/oauth/gmail/callback`) are unchanged.
`apps/api/test/gmailGoogle.test.ts` now holds that in place. It reads the live
deployment with a `fetch` that answers only Google's real URLs in Google's real shapes.
It checks that the exchange posts to exactly the token endpoint with the registered
redirect, that the PKCE verifier matches the consent URL's challenge, that the profile is
read on `gmail.googleapis.com`, and that the mailbox connects in `baseline_pending`. A
refused code connects nothing.

**The API has to admit 1.0.1 before 1.0.1 is published.** The API published
`{ minimum: 1.0.0, maximum: 1.0.0 }` (`CONTAINER_CLIENT_VERSIONS` in
`apps/api/src/bootstrap/main.ts`). A client above the maximum is `api_behind_client`, and
sign-in, session renewal and every command refuse it `client_upgrade_required`, exactly as
they refuse a client below the minimum. So desktop 1.0.1 against today's production API
could not renew its session, let alone connect a mailbox. This lane raises the maximum to
**1.0.1** and leaves the minimum at 1.0.0, so the installed 1.0.0 keeps working until it
takes the update. The order is therefore:

1. build and push both images from the merge commit, and **redeploy the API** (the worker
   has no change that matters here);
2. confirm `GET https://api.usecallie.com/auth/client-version` reports
   `"maximum":"1.0.1"`;
3. set `FSS_DESKTOP_APP_VERSION` to `1.0.1` and build, publish and install desktop 1.0.1
   from the same commit (`docs/greenfield/install.md`, "4 — publish 1.0.1");
4. on the Mac, press **Connect Gmail** on the "This Mac" card and finish the consent
   screen as `callie@usecallie.com`.

Publishing 1.0.1 before step 1 would offer every 1.0.0 Mac an update that the API
refuses.

**If the connection is refused at the callback.** The browser page says "Gmail not
connected" and, by design, says nothing else. `/gmail/status` has no field for why a grant
was refused, so the row keeps waiting until Refresh or the ten-minute expiry, and its hint
says so. The API's `refusal` line for the path `/oauth/gmail/callback` carries only the
status: `400` is the signed state (expired, or not this API's), `403` is the membership,
and `409` is the grant itself. A `409` can mean Google refused the code, Google returned
no refresh token, a scope was not granted, the address is outside the Workspace domain, or
another user already holds the address. The log does not say which, and that is a gap
worth closing before a second person connects.

**What guards it now.**

* `apps/desktop/test/mailbox.test.ts`: the bridge (connect, then the URL opened, then the
  status read until connected; refusal; `https:` only; Refresh stops the wait; the expiry;
  offline versus refusal; no second grant; nothing crosses the bridge but the row) and
  the row in every state.
* `apps/desktop/test/e2e/desktop.spec.ts`: the card's exact buttons in each state (Connect
  Gmail and Sign out; Sign out alone once connected) and a refusal as text with no
  dialog. Playwright is not in the gate; these ran locally.
* `test/release/desktopMailbox.check.ts`, with three mutations in
  `scripts/releaseMutationCheck.mjs`: the bridge stops opening the consent screen, the
  preload stops exposing the bridge, and the API's maximum goes back to 1.0.0.
* `apps/api/test/mail.test.ts` parses the connect answer and the status with the shared
  schemas, and `apps/api/test/gmailGoogle.test.ts` covers the exchange above.

**Still unverified.** No Mac has run 1.0.1, and no Gmail consent has reached the
production callback. The first real exchange, the first profile read and the first
baseline all run when David presses Connect Gmail, and the two alarms should clear only
after that.

### 8.0y What the first connected mailbox proved: a unit CloudWatch does not know, and a health check tied to it (24 September, evening)

**The mailbox connected.** David connected the first Gmail mailbox to production from
desktop **1.0.1** between 18:00Z and 18:11Z on 24 September. At **18:11:37Z** the worker's
scheduler pass inserted four jobs for it.

**From that minute no worker metric was published.** Every metrics pass of
`fss-prod-worker` logged, at error level:

```
{"event":"worker_loop_failed","loop":"metrics","error_name":"InvalidParameterValueException","error_message":"The parameter MetricData.member.6.Unit must be a value in the set [ Megabits, Terabits, Gigabits, Cou…"}
```

The message stops at 200 characters because `errorFields` truncates it. The sixth datum
was `GmailWatchHoursToExpiry`, the first gauge that exists only once a mailbox does, and
`packages/domain/mail/metrics.ts` gave it the unit **`Hours`**. CloudWatch has no such
unit, and `PutMetricData` rejects the whole request when one member is invalid. So
`WorkerHeartbeat`, `SchedulerHeartbeat`, `MailboxCheckHeartbeat`,
`CanaryCompletionAgeSeconds`, `GmailWatchHoursToExpiry` and every other worker metric
stopped at 18:11Z. `MailboxDisconnectedHours` carried `Hours` too, in both
`mail/metrics.ts` and `outbound/metrics.ts`. It was silent only because no mailbox had
sent and then disconnected.

**Then ECS killed healthy workers.** The metrics loop reported to the liveness file just
as the scheduler and the runners do. After three failed passes in a row
(`FSS_LIVENESS_FAILURES`, default 3, one pass a minute) the worker removed
`/tmp/fss-worker-heartbeat`. The container health check stats that file every 30 s with
three retries, so ECS stopped the task (`fss-prod-worker:5`) at **18:15Z** for "failed
container health checks". The replacement started at 18:16Z and failed the same way.
The jobs were fine: the stopped task drained with `jobs_completed` 11 and `jobs_failed`
0. A refusal the worker cannot fix was costing it its task.

**Why nothing caught it.** `MetricUnit` in `packages/domain/jobs/metrics.ts` listed
`Hours`, and `validateMetricDatum` checked names and values but not units. Every test
sink validates the same way, and `apps/worker/test/metricCoverage.test.ts` publishes
`GmailWatchHoursToExpiry` through a recording sink that never talks to CloudWatch. The
rehearsal never connects a mailbox, so this was the first time the datum was sent.

**The fix (lane g51).**

* Both hour gauges now publish with unit **`None`**, a dimensionless number, with a
  comment at each site saying why. Their names and values are unchanged. The alarms
  `gmail_watch_expiring` and `mailbox_disconnected` set no unit and compare the bare
  number with thresholds in hours, so they read it as before.
* The CloudWatch unit set is in code (`CLOUDWATCH_STANDARD_UNITS`). `MetricUnit` is
  narrowed from it to `Seconds`, `Count` and `None`, so `Hours` is now a type error, and
  `validateMetricDatum` refuses any unit outside the set (`METRIC_UNIT_INVALID`).
* One bad datum refuses only itself. Every sink publishes the valid data and then throws
  one `METRIC_REJECTED` error that names each refused datum.
  `cloudWatchPutMetricData` retries a rejected batch one datum per request, so the good
  data still goes out. If every datum fails on its own too, the fault is the transport
  (credentials or network), and the original error is thrown once.
* The metric publication **no longer reports to the liveness file.** The scheduler and
  the runner slots still do, so a worker whose database is gone is still replaced. A
  refused datum is logged as `metric_rejected` (metric, unit, error name, message). A
  collector that throws is logged as `metrics_collect_failed` with its name, and the
  other collectors are still published. The missing heartbeat metrics raise their own
  alarms, because those alarms treat missing data as breaching.

**What guards it now.**

* `packages/domain/test/jobs/metricUnits.test.ts` checks the unit set, the declared
  units and the validator. It also reads every metric datum literal in
  `packages/domain`, `apps/worker/src` and `apps/api/src`, and every Terraform `unit =`,
  against the set.
* `packages/domain/test/jobs/metricsCloudWatch.test.ts` replays the 24 September batch:
  five valid datums are sent and `GmailWatchHoursToExpiry` in `Hours` is named. It also
  covers a batch CloudWatch rejects over one member, where the others are still sent,
  and a transport that refuses everything, which gives one error.
* `apps/worker/test/workerProcess.test.ts` refuses every publication with a liveness
  threshold of one, and the file must survive. A second test checks that a refused
  metric is logged by name and the publication still counts.
* Three mutations in `scripts/releaseMutationCheck.mjs` break these on purpose: the unit
  goes back to `Hours` behind a cast, the metrics loop reports to liveness again, and the
  per-datum retry is removed.

**To close it.** Build the worker image from the merge commit and redeploy the worker.
The API publishes no metrics and needs no redeploy for this. After that, `fss-prod-worker`
should log no `worker_loop_failed` for `metrics` and no `metric_rejected`. The worker
metrics should come back on the new task's first metrics pass. `GmailWatchHoursToExpiry`
should read just under 168 hours, because a Gmail watch lasts seven days, and
`fss-prod-gmail-watch-expiring` should clear. The task should stop being replaced.

### 8.0z What the first mailbox's heartbeat proved: a five-minute check behind a one-minute alarm (24 September, evening)

**The alarm flapped on a healthy worker.** With the g51 fix deployed and one mailbox
connected (sending off), `fss-prod-mailbox-heartbeat-missed` went ALARM and back to OK at
22:30–22:37Z and again at 22:52–22:53Z, e-mailing the operator each time, with no warning
or error in the worker log. `MailboxCheckHeartbeat` in `FSS/fss-prod`, one datapoint a
minute from 22:15Z to 22:55Z, read 1 only every two to four minutes, with runs of up to
four zeros.

**Why.** Three facts, each true on its own:

* The alarm is Sum < 1 for three of three one-minute periods, and the heartbeat promises
  sixty seconds: `recordMailboxHeartbeat` wrote the default `expected_interval_seconds`
  of 60, and a beat is fresh while its age is within that.
* Nothing checked a quiet mailbox every minute. The only unconditional check was the
  scheduler's `mail-sync-reconcile` source, and it asked only for a mailbox whose
  `last_synced_at` was five minutes old (`MAIL_RECONCILE_INTERVAL_MINUTES = 5`). Every
  other `mail.sync` came from a Gmail push, and the watch has no label filter, so a push
  arrives when anything in the mailbox changes: a message, a read, a label.
* Each check makes the metric 1 for exactly one sample, because the metrics loop samples
  once a minute and the beat is fresh for sixty seconds.

So the metric was 1 once per push and at least once per five minutes, the longest runs of
zeros were the sweep's four, and the alarm fired whenever three quiet minutes passed.

**The fix (lane g58).**

* The sweep asks for one `mail.sync` of every connected, `ready` mailbox on **every**
  pass, with no `last_synced_at` filter; coalescing makes the ask free while a sync is
  queued or running. The heartbeat writes `MAILBOX_CHECK_INTERVAL_SECONDS` (60)
  explicitly. The alarm is unchanged.
* A mailbox heartbeat is fresh up to 30 seconds past its promise
  (`HEARTBEAT_GRACE_SECONDS`), because the check is asked for by one fixed-delay loop and
  performed by another a claim later, and healthy checks are about 61 seconds apart. The
  API, scheduler and worker heartbeats keep no grace.
* Found beside it and fixed with it: the watch renewal waited for a watch's last day
  (day six of seven) while `gmail_watch_expiring` fires below 48 hours, so every connected
  mailbox would have held that critical alarm for the day before each renewal, first on
  29 September. The watch is now renewed once it is a day old.

A quiet mailbox now costs 1,440 checks a day instead of 288: each is one KMS `Decrypt`,
one token refresh and one `users.history.list` (2 Gmail quota units).
`docs/greenfield/mail.md`, "The mailbox check, once a minute", has the numbers.

**What guards it now.** `test/release/mailboxHeartbeatCadence.check.ts` reads the
interval `recordMailboxHeartbeat` writes, the scheduler's pass interval, the alarm's
period and datapoints and the grace, and fails if they disagree.
`apps/worker/test/mailHandlers.test.ts` syncs a mailbox with nothing new before each of
three passes and requires every pass to check it again and leave a fresh sixty-second
heartbeat, and requires a day-old watch with six days left to be renewed.
`packages/domain/test/jobs/heartbeatFreshness.test.ts` holds the grace at 30 seconds for
the mailbox and zero for the rest. Two mutations appended to
`scripts/releaseMutationCheck.mjs` must be killed: the five-minute filter put back, and
the mailbox alarm's period raised to 300.

**Still open.** `MailboxCheckHeartbeat` is 1 when *any* mailbox is fresh, which is right
for one mailbox and hides a stuck one among several. `TodaySnapshotMissing` is published
by nothing at all (its owner is still `later_lane`), so `fss-prod-today-snapshot-absent`,
with missing data ignored, stays INSUFFICIENT_DATA after the first 05:00 snapshot as well
as before it. Both are written down in `docs/greenfield/mail.md` and here, not fixed.
(Lane g67 gives `TodaySnapshotMissing` a publisher: every metric pass, 1 when a workspace
is past 05:10 local without that day's `today.build` job `done`, otherwise 0; see
`docs/greenfield/runbooks/today_snapshot_absent.md`.)
(Lane g72 does the same for `ActiveEnrollments` and `HeldEnrollments`, the two inputs of
`all-sequences-held`, which were also `later_lane` and published by nothing: both are now
published every metric pass, 0 and 0 with nothing enrolled, and pauses, sending switched
off and the clock-clearing holds do not count as held; see
`docs/decisions/g72-enrollment-gauges.md`.)

**To close it.** Build the worker image from the merge commit and redeploy the worker.
No Terraform apply is needed: no alarm changed. On the new task, `MailboxCheckHeartbeat`
should read 1 every minute, `fss-prod-mailbox-heartbeat-missed` should stay OK, and the
`mail.sync` job for the mailbox should complete about once a minute. The first pass after
the watch registered on 24 September turns a day old (on the new build) should renew it,
and `GmailWatchHoursToExpiry` should read just under 168 again, and stay above 144.

### 8.0aa What the fourteenth full run proved: step 0 passes, and nothing opens a restore hold (24 September, late evening)

Run 36062337914 (22:45Z) carried lane g53. The drill task received the source baseline, created its reports directory, and passed step 0 against the restored instance for the first time. It then stopped at step 1: `holds list --reason restore_in_progress` returned 0, with "the restored database did not open a restore hold. Stop the drill and fail the release."

**Why.** No code opened a `restore_in_progress` hold. `advanceSystemGeneration` released them, the gates and `holds list` read them, and the worker only *logged* `restore_generation_mismatch` when `FSS_EXPECTED_SYSTEM_GENERATION` differed from the database. No task definition set that variable. Even if one had, a restored copy carries its source's generation, so only an expected generation pinned ahead of the copy can show a mismatch. A real production restore would have held nothing.

**Lane g56** adds four things:

- `openRestoreHolds`: one workspace-scope hold per workspace, idempotent, under an advisory lock, touching no other hold.
- The worker opens those holds at startup on a mismatch.
- `fss admin restore-holds open --expected-generation <n>`, the same check by hand.
- `expected_system_generation` on both roots (7.1).

The drill runs that command as step 1a with the source generation plus one. It asserts the step 9 reconciliation, and the runner reads the alarm's history. The next `full` run is the one that proves it (8.1 item 12).

### 8.0ab What lane g60 changed: a salesperson can attest the number they call from (25 September)

**The gap.** Production's only salesperson could sign in, connect Gmail and read Today on 24 September, and could not place a call. `authorizeDial`'s second step refuses a dial unless the actor's own calling identity is verified and enabled (9.1, 9.2). The Today card offers a Call button only when the expanded card carries one. Nothing in the tree created or verified a `calling_identities` row: no domain function, route, control or command. The restore drill's step 1 dial probe had no subject for the same reason, and lane g59 left it unanswered rather than fake one.

**What g60 adds.**

- `packages/domain/dial/identities.ts`: `registerCallingIdentity`, `verifyCallingIdentity` and `disableCallingIdentity`, with `currentCallingIdentityId` choosing the number Today dials from.
- Four routes: `GET /calling-identities`, and `POST /calling-identities/register`, `/attest` and `/disable`.
- The Settings screen's **Your calling number** section, for every role, in desktop 1.0.2.
- A hint on a Today card that has a number to dial and nothing to dial it from.
- The drill seed's attested number for the rehearsal admin.

In version one a number is verified by the owner's attestation, recorded with who, how and when. No telephony provider is involved, because a call is a `tel:` handoff (`docs/decisions/g60-calling-identities-are-attested-in-version-one.md`).

**Migration 0016, and what the production deploy therefore does.** Six nullable columns on `calling_identities` and the constraints that make a verified row name its attestation. `calling_identities_verification_recorded` is `NOT VALID`: enforced on every write, and not checked against rows that predate it. Both images now declare `{16, 16}`. The images running today declare `{15, 15}`, so this is a stop-migrate-start release with no rolling path:

1. build and push both images at the release commit (2.1);
2. apply production with the new digests and with `api_schema_range` and `worker_schema_range` both `{min=16,max=16}`, read from `packages/domain/db/schemaRange.ts` as the rehearsal reads them;
3. `infra/scripts/release-deploy.sh infra/roots/production fss-prod --schema-change --api-digest … --worker-digest …` (4.1). It scales the API and then the worker to zero, runs `fss migrate` to 16, ensures the database users, verifies, starts the worker, starts the API and verifies again. Dialing, Today and sending are down for those minutes. The previous digests are not a rollback afterwards, because their ranges refuse 16.

**Then desktop 1.0.2, after the API.** `CONTAINER_CLIENT_VERSIONS` is `{ minimum: 1.0.0, maximum: 1.0.2 }`. Confirm `curl -fsS https://api.usecallie.com/auth/client-version` reports maximum `1.0.2` before setting `FSS_DESKTOP_APP_VERSION` to `1.0.2` and publishing (`docs/greenfield/install.md`, "5a — publish 1.0.2").

**What David does on the Mac.** Window › Administration (⌘5), Settings screen, **Your calling number**: type the number with `+` and country code, optionally a name, tick **This is the number I place my calls from.**, press **Add number**. The section then reads *"Today calls from +1…"*, and a Today card with a usable phone route has a Call button. Retiring a number is **Stop using this number**. Its row stays, because call logs reference it.

**What the next `full` rehearsal should show at step 1.**

- The `before` phase's report lists `calling_identity: created`.
- `step1a-generation-check` opens the restore hold as before, and `step1-restore-holds` counts at least one.
- `step1-dial-refused` is `ok: true` for the first time. Its report reads `allowed: false` with `holds` containing `restore_in_progress`, and its `subject.callingIdentityId` is the seeded number. Its `reason` is whichever step of 9.2 answered first: `posture_missing` (a rehearsal has no MA posture), `outside_calling_window` at night, or `restore_in_progress`.
- `unanswered` is `[]`. If the run fails now, it fails at a later step for that step's own reason, and every step's verdict is in the log.

**Still unverified.** Nothing here has run in the cloud. Migration 0016 has not been applied to a deployed database. The Settings section has not run in a signed build on a Mac. The Today card's Call button after an attestation has been seen only in tests.

### 8.0ac What lane g62 changed: the mutation check runs nightly, and only the composites e-mail (25 September)

**The decision.** David, 25 September at about 03:50Z: the release ceremony gets shorter without touching safety. The full rehearsal runs only for schema, infrastructure or release-script changes. App-only changes go CI, rolling deploy, smoke. Desktop-only changes go CI, build, publish. Lane g62 is two pieces of that.

**The mutation check leaves the pull-request path.** `npm run test:release:mutation` was a step of `.github/workflows/greenfield.yml` and most of its wall clock: about sixteen minutes of every pull request and every push at 102 mutations (main, run 36089059879: "129 suite run(s) in 940 s").

- `greenfield.yml` now runs `npm run gate:greenfield` only: typecheck, lint, the workspace tests and the release suite. Its timeout goes from 45 minutes back to 20.
- `.github/workflows/greenfield-nightly.yml` runs the check at 09:00 UTC every day on main, and on `workflow_dispatch` against any branch. It uses the same `postgres:16` service container, Node 24.20.0 and install, with a 60-minute timeout.
- A failed run fails the job. A summary step that always runs writes the check's last line, "N mutation(s) killed, M problem(s).", and every problem line to the job summary, and raises an error annotation when M is not 0 or the line is missing. GitHub's own notice of a failed scheduled run goes to the user who last changed the cron line, if their notification settings allow it.
- Locally the check runs exactly as before. The rehearsal's `full` stage still runs it after the release suite (section 3, step 9).
- `test/release/mutationSchedule.check.ts` holds the shape. It checks that the pull-request job and `gate:greenfield` no longer reach the check, and that the nightly has its schedule, a step that decides its own status, and the same setup as the pull-request job line for line. It also runs the summary step's patterns against what the runner really prints. Two mutations at the end of `scripts/releaseMutationCheck.mjs` must be killed: the check chained back onto the gate step, and the nightly step marked `continue-on-error`.

What that gives up: a pull request can land a trap that no longer closes, and the nightly reports it the next morning rather than before the merge. A pull request that edits a trap or the mutation list can be checked first by dispatching the nightly on its branch.

**Alarm e-mail comes only from the composites.** Every metric alarm notified the topic on `ALARM` and on `OK` beside its composite, so one flap sent the composite's two e-mails plus two for each member it tripped: four to six per incident on 24 September. Now only the composites carry `alarm_actions` and `ok_actions`. The metric alarms keep their state, which is what the composites read, and send nothing. No threshold, period, evaluation count or `treat_missing_data` changed.

| Alarm | E-mails? | Member of |
|---|---|---|
| `fss-prod-critical` (composite) | yes, on `ALARM` and `OK` | — |
| `fss-prod-warning` (composite) | yes, on `ALARM` and `OK` | — |
| `api-heartbeat-missed`, `scheduler-heartbeat-missed`, `worker-heartbeat-missed`, `mailbox-heartbeat-missed`, `today-snapshot-absent`, `oldest-runnable-job-critical`, `gmail-watch-expiring`, `canary-stale`, `mailbox-disconnected`, `suppression-journal-failure`, `restore-generation-mismatch`, `outbound-invariant-failure` (severity critical) | no | `fss-prod-critical` |
| `all-sequences-held` (metric math, critical) | no | `fss-prod-critical` |
| `oldest-runnable-job-warning`, `dead-job-unresolved`, `unacknowledged-critical-alert` (severity warning) | no | `fss-prod-warning` |

Every metric alarm was already a member of exactly one composite, so none had to be added and none keeps its own notification. `infra/modules/alerts/tests/thresholds.tftest.hcl` asserts both halves. The composites notify the topic and only it, on `ALARM` and `OK`, and no metric alarm has an action of any kind. Every metric alarm is named by exactly one composite, the one its severity says, and the composites name nothing else.

What that gives up, and how to read around it:

- **A composite already in `ALARM` sends nothing when a second member trips.** It sends its `OK` only when every member has cleared. A member stuck in `ALARM` hides every later member of its composite from the inbox. `gmail-watch-expiring` treats missing data as breaching, so with no connected mailbox it sits in `ALARM` and holds `fss-prod-critical` there. Before this change the members' own e-mails were a backstop for that; now `aws cloudwatch describe-alarms --state-value ALARM --alarm-name-prefix fss-prod` is.
- **The unacknowledged-critical repeat** (`docs/decisions/g1-alert-repetition.md`) is mailed by `fss-prod-warning`. So it is not mailed while `oldest-runnable-job-warning` or `dead-job-unresolved` already holds that composite in `ALARM`. The decision record says how to give it back its own e-mail.
- The composite's state-change reason names the member that raised it. That member's key is the runbook to open.

**To close it: a production apply, nothing else.** No image and no redeploy. The plan must show exactly this from lane g62, beside whatever else the apply carries:

- 16 resources updated in place. They are `module.stack.module.alerts.aws_cloudwatch_metric_alarm.this["<key>"]` for the fifteen keys above, and `module.stack.module.alerts.aws_cloudwatch_metric_alarm.all_sequences_held`. Each changes `alarm_actions` and `ok_actions` from the topic ARN to empty.
- The two `aws_cloudwatch_composite_alarm` resources unchanged.
- 0 to add and 0 to destroy, and no `-/+`. Only `alarm_name` would force a replacement, and no name changed.

If an alarm's actions were switched off by hand (`disable-alarm-actions`, 8.0r), its line also shows `actions_enabled` going from false to true. That is harmless now, because it has no actions. Each new rehearsal gets the same routing from the same module.

### 8.0ad What lane g65 changed: Today is the home, and the window says what needs you (25 September)

**The gap.** A signed-in person saw a "This Mac" card and a bare list of cached firm names whose Open button opened nothing. The real Today (the lanes, the expansion into contact tasks, snooze or hold, the Call button, the outcome form) was a second window behind ⌘1. Nothing on screen said what to do next. Connect Gmail was a row on the device card; a missing calling number showed up only as a Call button that was not there; the domain checklist lived three screens into Administration.

**What g65 adds.** Desktop 1.0.3 only. No route, no migration, no infrastructure.

- **Home** is the main window's signed-in screen (`apps/desktop/src/renderer/homePage.ts`, view model `homeView.ts`). The business date in words, such as *Friday, 25 September*, read at noon in the workspace's zone. A line of counts. The four lanes, **Replies**, **Callbacks**, **Due today** and **New firms**, as runs of the server's order, never re-sorted (8.2). **Last 7 days**: replies with uncertain, calls, holds open, and emails sent, which reads *— not in this build* while the dashboard's sending figures are `available: false`. **Needs you**: Connect Gmail, Add your calling number, Record the domain checklist (admin only) and *N alerts to acknowledge* (admin only), each raised only by a fact a bridge has read. An empty list reads *Nothing today. Add firms and a sequence, and tomorrow's list builds at 05:00.*
- **The sidebar** lists the six windows with their keys and shows status as a dot and a few words. The mailbox. The calling number, masked (`+1 617 ··· 0100`). Sending on or off, read from the settings snapshot's `effectiveSendingEnabled`. The domain checklist, for an admin only. The version, with online, offline or *list is stale*. **This Mac** sits at the foot, a `<details>` holding the device, the Mailbox row with Connect Gmail and Sign out.
- **One code path for the lanes.** G6's `todayPage.ts` is now `todayLanes.ts`, and Home calls it. `today.html` and the Today window are gone; **Today ⌘1** brings the main window forward. **Dashboard ⌘6** is new: it opens Administration on its Dashboard screen (`settings.html?screen=dashboard`). ⌘5 opens it on Settings. Home opens every window through one new `callie` channel, `openWindow`, which accepts `replies`, `firms`, `sequences`, `dashboard` and `administration` and opens nothing for any other value.
- **No press needed.** At launch and at sign-in Home shows the cached list, then reads today's. Before, the list stayed marked stale, and every control stayed disabled, until Refresh.
- **The stylesheet** is the design system from Mockup A2 (`docs/decisions/g65-today-is-the-home.md`). Dividers rather than cards, grey section headers with a count, colour only as a dot or a tag, row actions on hover, light only. Replies, Firms, Sequences and Administration pick it up unchanged.
- **The administration bridge's dashboard read no longer moves Administration.** `loadDashboard` used to switch the shared bridge to its Dashboard screen and adopt the window asked for. Home reads its seven days through it, so the next command Administration sent would have come back drawn on the Dashboard. Now it changes only the figures, and Home checks that the answer's window is the one it asked for.

**The version order: the API first, then desktop 1.0.3.** `CONTAINER_CLIENT_VERSIONS` is `{ minimum: 1.0.0, maximum: 1.0.3 }`. Under the release cadence this is an app-only API release followed by a desktop-only one. Build both images at the release commit (2.1). Deploy with `release-deploy.sh infra/roots/production fss-prod --api-digest … --worker-digest …` and **no** `--schema-change` (4.1): the schema range stays `{16, 16}`, and the migration task finds nothing to apply. Smoke. Confirm `curl -fsS https://api.usecallie.com/auth/client-version` reports maximum `1.0.3`. Only then set `FSS_DESKTOP_APP_VERSION` to `1.0.3` and publish (`docs/greenfield/install.md`, "5b — publish 1.0.3"). A 1.0.3 Mac against an API still publishing 1.0.2 is refused every sign-in, renewal and command. Installed 1.0.0 to 1.0.2 keep working until they take the update.

**What David does on the Mac.** Take the update and open Callie. The window opens on today's list, headed by the date. Read the sidebar's **Status**: every dot green is a working setup. Work **Needs you** from the top. Hover a row and press its button: **Connect Gmail** starts the grant in the browser, as the Mailbox row always did. **Open** brings up Administration on Settings, where **Your calling number** and the domain checklist are. Expand a firm with **Open** on its row. The tasks, the Call button and the outcome form are under that row now, not in a separate window. **Refresh** reads the list, the mailbox and the figures again. ⌘2 to ⌘6 open the other windows, and the sidebar names them.

**Still unverified.** Nothing here has run in Electron. The Playwright specs drive the shipped renderer with its bridges substituted (`apps/desktop/test/e2e/home.spec.ts`). The main-process half is untested outside a packaged build: the `openWindow` handler, ⌘1 finding or reopening the main window, and ⌘6 reloading an open Administration window with `?screen=dashboard`. So are the stylesheet's sticky sidebar and hover actions in a real window at its default 1100 × 760, and the auto-read at launch against production.

### 8.0ae What lane g69 fixed: the sending section never parsed, and Home asked for a number that existed (25 September)

**The gap.** In production, Administration's **Sending domain and caps** section never rendered for David, who is an admin. On that code path Home's sidebar reads *Domain not read*. The API logged no refusal. Separately, Home told anybody with a saved but unattested calling number that they had *No calling number*, and Needs you asked them to **Add your calling number**. The one related refusal in the log, `POST /calling-identities/register → 409` at 14:56Z, did not say which of five refusals it was.

**The cause.** `POST /outbound/status` answers `personalGmailRecipients` as `{ automated, direct, total }` (`personalGmailRecipientsInWindow` in `packages/domain/outbound/domainGuard.ts`, passed through by `apps/api/src/routes/outbound.ts`), and always has. The desktop's `outboundStatusSchema` in `apps/desktop/src/main/settingsBridge.ts` declared `z.number()`. Every answer failed to parse. `AuthedClient.read` turned the failure into `unreadable_answer`, `loadSending` dropped it into `sendingAdmin = null`, and `settingsView.ts` renders no section for a null posture. The route had answered 200, so nothing was logged. Before PR 202 the read went out as a GET and the API answered 405. PR 202 made it a POST, and from then on it reached this parser and failed there. Either way, no published build has rendered the section. Three smaller defects sat beside it:

- `loadSettings` returned before `loadSending` when `/settings` failed.
- `sessionManager.ts`'s `renew` kept the credentials and dropped the role the renewal carries (`renewSession` in `apps/api/src/auth/sessions.ts`), so a promotion reached the Mac only at its next full sign-in.
- `homeView.ts` read "no number in use" as "no number", so a saved, unattested number, which is exactly what an unticked Add leaves, was told to add itself again.

**Why the tests missed it.** The desktop unit fixture in `apps/desktop/test/settings.test.ts` said `personalGmailRecipients: 1`, the same wrong number as the parser, so the suite agreed with itself. The Playwright specs substitute the bridge, so they never run a real API answer through the parser. The session fixture always answered `salesperson`. The Home fixtures carried an empty list or a verified number, never a saved unattested one.

**What g69 changes.**

- **The parser** reads the object (`.loose()`, like its siblings) and maps `total` into `SendingAdminView.personalGmailRecipients`, so *Personal-Gmail guard: 4000 per 24 hours, N used* keeps its meaning. `total` counts FSS's own sends and the direct ones the sync imported.
- **Drift is now caught in the release suite.** `test/release/sendingSection.check.ts` runs the real route over a real database and session, feeds its answer to the real desktop bridge and view, and asserts the rendered section. It also holds the desktop's unit fixture, now `apps/desktop/test/support/outboundStatus.ts`, to the route's answer key for key and type for type. A field the route adds, drops or retypes fails there, before it can fail a parser in production.
- **A failed sending read is visible.** The bridge keeps `sendingReadError`, the refusal code. For an admin the section then reads *Callie could not read the sending status.* plus a sentence naming the code, with **Retry**, which re-shows Settings. Sending is read even when `/settings` fails. `state()` asks again while an admin's posture is not held, so Home's focus and **Refresh** retry a failed read. Home's *Domain not read* row stays.
- **A renewal applies the role.** The session manager puts the renewed role on the in-memory device and writes it to `device.json` through the new `DeviceStore.saveDevice`. That call writes public metadata only; the Keychain is untouched. When the role changes, the administration bridge drops the sending posture, the diagnostics and the dashboard, and the next read derives them under the new role.
- **Home says what is missing.** With no number: **Add your calling number** and *No calling number*, as before. A saved, unattested number: **Attest your calling number**, detail *Your number is saved. Open Your calling number and attest it.*, and the amber status *Calling number needs attestation*. Only retired numbers: **Re-attest your calling number**. Each row opens Administration on Settings, where the saved row already has its own **Attest** button.
- **The API logs the refusal code.** The `refusal` line keeps `reason` as the HTTP status, which is the Refusals metric's dimension. It adds `code` from the body's `reason` or `error` (`refusalCodeOf` in `apps/api/src/server.ts`). A value that is not code-shaped is dropped, and request bodies are never logged. Today's 409 would now read `code: number_invalid`, `number_registered_to_another` or whichever it was.
- Three mutations, appended to `scripts/releaseMutationCheck.mjs` (110 → 113). The two existing `maximum` mutations now find `'1.0.4'`.

**The version order: API 1.0.4 first, then desktop 1.0.4.** `CONTAINER_CLIENT_VERSIONS` is `{ minimum: 1.0.0, maximum: 1.0.4 }`. This is an app-only API release followed by a desktop-only one:

1. Build both images at the release commit (2.1).
2. Deploy with `release-deploy.sh infra/roots/production fss-prod --api-digest … --worker-digest …` and **no** `--schema-change` (4.1). The schema range stays `{16, 16}`.
3. Smoke.
4. Confirm `curl -fsS https://api.usecallie.com/auth/client-version` reports maximum `1.0.4`.
5. Only then set `FSS_DESKTOP_APP_VERSION` to `1.0.4` and publish (`docs/greenfield/install.md`, "5c — publish 1.0.4").

A 1.0.4 Mac against an API still publishing 1.0.3 is refused every sign-in, renewal and command. Installed 1.0.0 to 1.0.3 keep working, with the section still missing, until they take the update.

**What David does on the Mac.** Take the update and open **Administration › Settings**.

1. **Sending domain and caps** is there: *usecallie.com: …* with the checklist boxes, the guard line and one ramp line per connected mailbox. If it instead reads *Callie could not read the sending status.*, the sentence after it names the code. Press **Retry**. If it still fails, send the code.
2. Record the checklist (5.1a and section 6 of this runbook). Home's sidebar should then read *Domain passes · usecallie.com*.
3. On Home, a saved number now reads *Calling number needs attestation*, with **Attest your calling number** under Needs you. Press **Open**, then press the number's **Attest: This is the number I place my calls from.** on Settings. Do not add the number again.

**Still unverified.** Nothing here has run in Electron or against production. The release check drives the real route and the real bridge in one process, with the socket replaced by `dispatch`. The Playwright specs still substitute the bridge. So these are unmeasured:

- The section on David's Mac against production's data.
- The role change across a real renewal, and whether the renderer's own device state picks it up before Home's next focus.
- The `code` field in CloudWatch and its effect on the Refusals metric filter, which reads `reason` and should be unaffected.

Also unknown: which refusal the 25 September 409 was. The receipt in `command_receipts` holds it, and nothing here reads production.
### 8.0af What lane g70 changed: a schema release stops before the apply, not after it (25 September)

**The defect.** The independent review of 25 September (at `b2cc080b`, a P1 for the next schema deploy) found the order of a schema-change release backwards. `terraform apply` registers the release's task definitions, and it updated both live services in place to point at them, at their running counts. `release-deploy.sh --schema-change` scaled the services to zero only afterwards, in its step 1. From migration 0006 every declared range is a strict `{N,N}`, so those task definitions refuse the schema the database is still at: both binaries exit 12 (`configurationInvalid`) at startup.

The schema-16 release of 25 September ran in exactly that order (8.0ab, steps 2 and 3). The apply at `3bb2249f` registered revision 9 of both service task definitions, declaring `{16, 16}`, and repointed both services while they were running against schema 15. The deploy's step 1 then scaled the API and the worker to zero at about 04:41Z, migrated, and the API was back at about 04:50Z. Between the apply and that step 1, ECS was starting tasks that could only refuse:

- the worker's deployment replaces rather than overlaps (minimum healthy 0 %), so ECS could stop its only `{15, 15}` task before the `{16, 16}` replacement refused;
- the API's rolling deployment (minimum healthy 100 %) kept its old tasks serving while the new ones failed beside them;
- the deployment circuit breaker rolls a failed deployment back to the previous revision. A rollback racing the scale-down could leave a service on `{15, 15}`, and step 5 would then start it against schema 16.

None of that was observed task by task. It is what the order does, and the log records only the 04:41Z to 04:50Z window. The migration itself ran with both services at zero, so nothing was written against the wrong schema. The failure was the stop arriving after the harm, not the migration.

**The fix.**

- **`infra/scripts/release-stop.sh <root> <prefix> [--environment production]`**, run before the apply. It scales the API to zero, waits for it to be stable and reads it back, then does the same for the worker. It fails naming the counts if either is not at desired, running and pending zero afterwards. A service already at zero is reported and left alone, so a second run does nothing. It carries the guards the other production-capable scripts carry: the prefix decides the environment, the root must agree, every call goes through the symmetric refusal, the cluster must be a full ARN in this account, region and namespace, and its `Environment` tag must agree. Production must be named out loud with `--environment production`.
- **`ignore_changes = [desired_count]` on both services** (`infra/modules/cluster/main.tf`). Terraform sets a count when it creates a service and never afterwards, so the apply after the stop replaces the task definitions and starts nothing. This reverses the rejection recorded in `docs/decisions/g12h-bootstrap-is-a-root-variable.md`, which is amended to say why. `bootstrap` still creates a fresh environment at zero, and `bootstrap=true` against a standing one no longer scales it at all.
- **`release-deploy.sh --schema-change` step 1 is now an assertion.** Both services must already be at desired, running and pending zero, or it refuses and prints the `release-stop.sh` command. It does not scale them: by then the harm has happened, and a quiet stop would make the wrong order look right. The assertion runs on a bootstrap too, where it passes without a stop, because `bootstrap=true` on a standing stack no longer zeroes anything. The rolling path, with no `--schema-change`, is unchanged.
- **The rehearsal.** Every run creates a fresh stack, so there is nothing to stop. The create step reads its own plan: if both services already stand in the run's state, which happens only when `run_suffix` names a stack an earlier run left, it runs `release-stop.sh` before the apply. A plan that creates one service and not the other is refused.

**Why `ignore_changes` is safe for a rolling release.** It ignores the count and nothing else. A new image or range still replaces the task definition, the service still references `aws_ecs_task_definition.<name>.arn`, and the apply still updates the service in place, so ECS rolls it on to the new revision at the count it is running. `release-deploy.sh` sets the declared counts explicitly in steps 5 and 6 of every deploy, as it already did. What changes: a new `api_desired_count` or `worker_desired_count` reaches the services at the next deploy, not at the apply. And `deployment_plan.planned_desired_count` reports the count Terraform last read from ECS.

**Test evidence, offline only.** `infra/modules/cluster/tests/release_owns_the_count.tftest.hcl` applies a stack at zero, then a schema release's apply with the bootstrap off, new images and a `{16, 16}` range. Both counts stay at zero, the declared two and one still reach `deployment_plan`, and the task definitions carry the new images and ranges. `infra/roots/production/tests/schema_release_order.tftest.hcl` applies production at two and one, then again with new ranges and `bootstrap = true`, and the counts do not move. Both runs fail with the lifecycle removed. `test/release/scenario22.check.ts` drives both scripts against a fake ECS:

- the deploy refuses with either service running, making no `update-service` and no `run-task`;
- with both at zero, the deploy reaches the migration;
- the stop scales the API before the worker and reads both back;
- the stop is idempotent, fails when a service will not stop, and refuses production unless it is named.

It also runs the workflow's classifier against four plans. Two mutations at the end of `scripts/releaseMutationCheck.mjs` must be killed: the refusal removed, and the lifecycle taken off the worker.

**What the next schema release does in production.**

1. Build and push both images (2.1). Read the ranges from the source (4).
2. Plan to a file, and read it. The two service task definitions are replaced, the two services are updated in place for `task_definition` only, and no `desired_count` line appears (`infra-apply-runbook.md` 3.2).
3. `infra/scripts/release-stop.sh infra/roots/production fss-prod --environment production`. The outage starts here.
4. Apply the plan.
5. `infra/scripts/release-deploy.sh infra/roots/production fss-prod --schema-change --api-digest … --worker-digest …`. It refuses unless step 3 happened, then migrates, verifies, and starts the worker and then the API.
6. Smoke.

A release with no migration keeps its order: plan, apply, `release-deploy.sh` without `--schema-change`, smoke.

**Still unverified.** Nothing here has run in the cloud. Whether `update-service --desired-count 0` then `wait services-stable` stops the API inside the waiter's ten minutes with the target group's 30-second deregistration delay is expected and unmeasured. So is the claim that an apply against services at zero registers the new deployment and starts no task. So is a `describe-services` read by `fss-rh-deploy` and `fss-prod-deploy` from these scripts (both roles allow `ecs:Describe*`). A normal fresh `full` run exercises only the assertion's bootstrap branch; the standing-stack branch runs only when a run names a leftover stack. Under the release cadence this is an infrastructure and release-script change, so it needs a full rehearsal before production uses it.

### 8.0ah What lane g73 changed: Appendix E.3's missing fences are recovered from the Sent folder (25 September)

**The gap.** After a point-in-time restore, step 3 (`fss admin mailbox reconcile-sent`) reconciled only fences the restored copy still had, in `dispatching` or `reconciling`. A send made after the restore point has no fence in the restored copy, and its step is pending again. The sender's only dedupe key is one fence per step execution, and that fence is what the restore lost. So the restored sequence would have sent the same email a second time. The independent review of 25 September found it (P1, before automated sending).

**Why the green drill did not prove it.** Step 3's assertion was `tombstones >= 1`. The in-flight seed leaves a fence the restored copy still has, `reconciling`, with its Message-ID in the recorded Sent folder, and reconciling that one fence satisfied the assertion. The `after` phase's send went to a firm made after the restore point, so its loss left nothing that could send again, and nothing looked for it. Run 36100448302's green step 3 is that surviving fence and nothing more.

**The fix** (`docs/decisions/g73-missing-fences-are-recovered-from-sent.md`).

- Step 3 now also lists each mailbox's Sent folder from the restore point minus ten minutes (`RESTORE_SENT_SCAN_SKEW_SECONDS`) to now. It uses `GmailClient.listSentMessageIds`, `in:sent`, epoch-second bounds, and metadata only.
- It keeps the messages carrying FSS's marker for that mailbox: the whole deterministic Message-ID `<fss.{fence}@{the mailbox's domain}>`, domain included.
- A message whose fence is missing and whose step is known is recorded as a `sent` tombstone on that step. The tombstone takes the lost fence's own id and Message-ID, Gmail's ids and instant, and a ledger event `reconciled_from: sent_folder_missing_fence`. The step is completed from the original send, and `prepareOutboundMessage` and `dispatchOutboundMessage` then refuse to send it again.
- A fence the copy holds `prepared` or `held` whose message already left is recorded sent.
- A send nothing restored could repeat is reported `unmatched`.
- A send that cannot be tied to one step is `unattached`. It becomes an unresolved exception in step 8, and step 9 refuses to release the restore holds.
- No migration, and no change to the sender.
- The drill has two new checks, `step3-missing-fence-tombstoned` and `step5-no-second-send`. The runner requires both, together with `missing_fences_tombstoned >= 1`, `mailboxes_unscanned == 0` and `missing_fences_unattached == 0` in `sent-reconcile.json`.
- The `before` phase enrols `restore-lost@drill-evidence.invalid` in a one-step sequence due in thirty days. The `after` phase sends that step through the recorded client, so the restored copy holds the step with no fence while the recording's Sent folder, now carried as `sentMessages` with metadata, holds its message.

**What the next `full` run should show at step 3.**

- `drill-evidence-before.json` lists `restore_lost_enrollment: created`, and `drill-evidence-after.json` lists `restore_lost_send: created`.
- The runner logs `mailbox recording handed to the drill task: 4 sent, 3 messages, 4 Sent-folder messages listed`. The before phase's send may fall outside the ten-minute window; it is recorded either way.
- `step3-reconcile-sent` is `ok`. `sent-reconcile.json` shows:
  - `fences_reconciled: 1` and `tombstones: 1`: the in-flight fence, as before;
  - `missing_fences_tombstoned: 1`: the restore-lost step;
  - `missing_fences_unmatched: 1`: the send to the after phase's own firm;
  - `missing_fences_unattached: 0`, `pre_dispatch_fences_marked_sent: 0`, `mailboxes_unscanned: 0` and `resent: 0`.
- `step3-missing-fence-tombstoned` is `ok`. Its one tombstone reads `state: sent`, `reconciledFrom: sent_folder_missing_fence`, `fencesForStep: 1`.
- `step5-no-second-send` is `ok`, with `sends: 0` and the same one fence to that recipient as at step 3.
- Step 8's `unresolved` is still `[]`, and `sent_missing_fences_tombstoned` reads 1.
- If the step fails, its refusal names the reason. `no send whose fence the restore lost was tombstoned` means the recording or the before phase's enrollment did not reach the drill.

**Still unverified.** Nothing here has run in the cloud. The live Gmail client's `in:sent` listing has been exercised only against the HTTP stub, never against a real mailbox. In particular, a trashed Sent message's appearance with `includeSpamTrash` is Gmail's documented behaviour, not an observation. The daily cap of a lost send's day is not re-counted, which is a known limit written in the decision. Production has still never sent an automated email.

### 8.0ag What lane g71 changed: the sending attestation is bound to the release record (25 September)

**The gap.** Found by the independent review of `b2cc080b` (section 1, P1 "sending gate"; action 6). 16.2 keeps production sending disabled until three things hold. The mandatory rehearsal scenarios passed. The deployed image digests match the rehearsal artifacts. An authenticated admin enabled sending. The admin's attestation `sending_enabled = { enabled: true, releaseGateReference }` accepted any nonempty reference, and nothing compared it with anything. Once the deployment flag was on, the send gate checked a boolean. The digest match was an instruction in section 6, step 2, and nothing enforced it.

**What g71 adds.** `docs/decisions/g71-sending-gate-is-bound-to-the-release-record.md` has the reasoning.

- **Migration 0017**, `release_records`: one row per `releaseGateReference`, holding the whole `fss.release-record.v1` and the columns the rules read. CHECKs mirror the script's refusals: a digest is `sha256:` plus 64 hex, the two digests differ, and the columns agree with the JSON. The table is append-only for the runtime role.
- **The contract** is `packages/contracts/src/release.ts`, and it is strict. `test/release/scenario42.check.ts` runs `rehearsal-release-record.sh` and parses its output with it, so a field renamed on either side fails the release suite, not the production enable.
- **`fss admin release-record put --json <file> | --json-base64 <value>`**, idempotent by reference, and `show --reference <reference>`. `release-deploy.sh --release-record <file>` runs the put on the operations task after the final verify and prints the outcome. Without the flag the deploy is unchanged.
- **Each service knows its own digest.** The API and the worker read `ECS_CONTAINER_METADATA_URI_V4` once at startup. The digest comes from `Image`'s `@sha256:` suffix, or from `ImageID` when the reference has none. It is logged as `image_digest` in `api_configuration` and `worker_configuration`. Outside ECS, `FSS_IMAGE_DIGEST` is used; inside ECS it is ignored. Failing both, the digest is `unknown`. No Terraform change was needed.
- **The enable rule (API).** Saving `enabled: true` is refused unless the reference is a stored record with `suite = pass` whose `artifacts.api` is the running API's digest. The refusals are `release_record_unknown`, `release_record_not_passing`, `release_record_digest_mismatch`, and `release_record_identity_unknown` when the API cannot read its own digest. `enabled: false` is always accepted. `GET /settings` and `GET /diagnostics` report the attestation in force only while its record names this API's digest.
- **The send rule (worker).** `decideSend` also requires the attested record to be stored and passing, and its `artifacts.worker` to be the running worker's digest. Otherwise it refuses `workspace_sending_not_attested`, with the binding refusal as `detail` and never the reference. A later deploy of other digests holds every send without anybody withdrawing the attestation.
- **The drill seed** stores a record of its own and sends under it. Its two digests are SHA-256 of a sentence, so they can never be a built image, and no production API or worker can bind to them.

**Migration 0017, and what the production deploy therefore does.** Both images now declare `{17, 17}`. The images running today declare `{16, 16}`, so this is a stop-migrate-start release with no rolling path, like 8.0ab:

1. build and push both images at the release commit (2.1), and run a `full` rehearsal on them, because this release touches the schema and sending;
2. apply production with the new digests and `api_schema_range` and `worker_schema_range` both `{min=17,max=17}`;
3. `infra/scripts/release-deploy.sh infra/roots/production fss-prod --schema-change --api-digest … --worker-digest … --release-record <release-record.json from that green run>` (4.1). The put runs after the final verify.

No desktop build is needed. The settings page renders the new refusal codes as they come back, and Home's sending line reads `effectiveSendingEnabled` as before.

**What the next `full` rehearsal should show.** The `before` phase's report lists `release_record: created` next to `sending_attestation: created`, and `accepted_send` still reaches `sent`. The API's and worker's startup lines carry `image_digest` equal to the run's two digest inputs, with `image_digest_source: ecs_metadata_image`.

**Still unverified.** Nothing here has run in the cloud. Migration 0017 has not been applied to a deployed database. The shape of the ECS metadata answer comes from AWS's documentation, and the tests reproduce it with a local server. No Fargate task has been read. If the answer lacks the digest, both services log `image_digest: unknown`. Enabling is then refused and sending held, which is fail-closed, but a real gap until it is fixed. The first rehearsal after this merge is where that shows. Production sending is still disabled, and no real attestation has been written under the new rule.
### 8.0ai What lane g77 changed: the dispatch rechecks everything under one lock, then claims (25 September)

**The gap.** The independent audit of 25 September (`GPT6-ASTRA-EXHAUSTIVE-20260925.md`) rated six items P0 or P1 before automated sending: S01, S02, S03, S05, S09 and C25. All six were real in code. Before this lane, `dispatchOutboundMessage` ran four autocommit statements: read, count, OAuth, and a state-only claim.

- A reply, opt-out or hold that committed during the token refresh was never seen (S01).
- The gate never asked the enrollment, control mode, assignment or template, and it let a `candidate` route through (S02).
- The gate trusted `sync_state = 'ready'` through any number of rate-limited syncs (S03).
- The cap was charged to the planned business date, not the day the email left (S05).
- The window ignored holidays (S09).
- A crash between the count and the claim left a count no fence explained (C25).

Audit T02 applied too: `scenario03.check.ts` committed the reply before the dispatch, so it never entered that window.

**What g77 changes.** `docs/decisions/g77-dispatch-rechecks-under-the-lock.md` has the reasoning, and `docs/greenfield/sending.md` has the sequence.

- **OAuth first, then one claiming transaction.** The transaction takes the send gate shared, locks the fence and its enrollment `FOR UPDATE`, reruns `decideSend`, reserves the day's capacity and claims, then commits. Gmail is called only after the commit, with the claimed row's bytes. The dispatch refuses to run inside a caller's transaction.
- **The send gate** (`packages/domain/policy/sendGate.ts`) is a per-workspace transaction advisory lock. Every writer of a restrictive stop fact takes it exclusive: `openHold`, the direct hold inserts in reassignment and departure, restrictive suppression events, manual mode, stage changes and `stopEnrollments`. So a stop either commits before the recheck reads, or waits for the claim.
- **The complete eligibility at the claim.** `decideStepPermission` reruns `composeEligibility()`, with the fence's frozen route version and template version. The composition gains `enrollmentSource`. Its hold read now includes the owner's mailbox scope and the email channel, so an administrator's mailbox or email-channel pause is honoured. The new refusal `step_ineligible` carries the section 15 code as its detail and opens no second hold. A reply's hold used to surface as `provider_refusal`.
- **Proven coverage.** `coverage_watermark_at` is the last success and `last_synced_at` the last attempt. No migration was needed, and the schema stays at 16 on this branch (17 with PR 211). The watermark must be no older than `COVERAGE_FRESHNESS_SECONDS` (15 minutes) on the database clock (`packages/domain/mail/coverage.ts`). The ramp's day health uses the same decision.
- **The claim's business date and holidays.** The cap counts on the workspace business date of the decision instant, and the claim writes that date to `outbound_messages.business_date`. The window asks `placeEmailSend` about that instant, using the union of the enrollment's frozen holiday calendar and the current one.
- **Capacity by fence.** `claimedAutomatedSends` derives `automated_sent` from the fences. `releaseCount` is gone.
- **The drill** proves coverage again (one sync over its recorded inbox) when a phase finds the previous phase's watermark stale. The in-flight and after phases run about half an hour after the before phase.
- Three mutations, appended to `scripts/releaseMutationCheck.mjs` (120 → 123 on this branch, rebased on main `ac26db53`; other lanes append concurrently).

**Release class.** Application-only for the schema: no migration and no range change. Both images change, because the domain's writers now take the gate inside API commands too. Sending stays disabled in production (`FSS_SENDING_ENABLED=false`), so nothing here changes live behaviour until the attestation is written. Because this is a sending-safety change, it rides the next `full` rehearsal already owed for g70 and g73.

**What the next `full` rehearsal's release suite should prove.**

1. `scenario03.check.ts` enters the race window: the reply commits during the real dispatch's token refresh and nothing is sent, and the control's identical pause sends.
2. The drill's `in-flight` and `after` phases still reach `accepted_send` or `in_doubt_send` with their mailbox proved fresh. If a phase refuses with `the coverage sync answered …` or `still unproved`, that is this lane's change meeting the deployed seam.
3. Scenarios 5, 12, 16 and 33 pass unchanged on the claimed-row envelope and the claim's business date.
4. No API command in the run logs a lock timeout or `40P01`. Holds and suppressions now wait for in-flight claims, which last milliseconds.

**Still unverified.** Nothing here has run in the cloud. These are measured only on embedded PostgreSQL 16: the advisory lock's behaviour under the RDS parameter group, the deadlock-detector path the decision doc accepts, and the drill's re-sync on the rehearsal's recorded seam. The fifteen-minute window is reasoned, not measured: nobody has yet watched a production watermark's age through a Gmail 429.
### 8.0aj What lane g78 changed: one wire contract for the desktop's reads, and the version gate as a ceiling (25 September)

**The drift class.** The Mac parsed most API answers with schemas it wrote itself, and its unit fixtures were written to those same schemas. Each suite agreed with itself while the real answers drifted. The independent audit found six more cases after g69's sending section:

- Every populated sequence version was unreadable: the step's `sequenceVersionId` was forbidden (D01).
- Every populated enrollment list was unreadable: four of thirteen fields were missing (D02).
- A classifier at `xhigh` or `max` read back as no classifier (D03).
- Settings history stripped every value, and nothing drew it (D04).
- A refused merge never reached the conflict screen, and a replay lost the conflicts (D05).
- A failed sequence read looked like an empty workspace (D06).

Production has no sequences or merges yet, which is why nobody saw them.

**What g78 changes.** Every response the desktop reads is declared once, in `@fss/contracts`. Each route's test asserts `wireDrift(schema, answer)` is empty, and the desktop imports the same schema. The Mac's parse strips a key it does not know, so an API deployed ahead of a Mac cannot lock it out. The route's test is where an undeclared key fails. Closed vocabularies are the domain's own lists, compared in `apps/api/test/wireVocabulary.test.ts`. Four release checks drive the real route into the real bridge and view:

- `sequences.check.ts`: a published two-step version, a held enrollment and a LinkedIn handoff;
- `replies.check.ts`: the classifier at `max` and a card with its hold;
- `settingsHistory.check.ts`: two versions with their from and to values;
- `crmMerge.check.ts`: the conflict screen, and a replay that keeps its conflicts.

Each check also holds the desktop's unit fixtures to the route. The sequence editor draws one grey line with **Retry** per failed read, and History under a setting shows *From …* and *To …* per version. `docs/decisions/g78-one-wire-contract.md`.

**The ceiling.** `CONTAINER_CLIENT_VERSIONS` is now `{ minimum: '1.0.0', ceiling: '1.x', incompatible: [] }`. The API publishes `{ minimum: '1.0.0', maximum: '1.999.999' }`, which desktops 1.0.0 to 1.0.4 parse and read as admitting themselves. Diagnostics on 1.0.5 reads *Clients 1.0.0 to any 1.x.* `docs/decisions/g78-version-ceiling.md`.

Mutations: three appended to `scripts/releaseMutationCheck.mjs` (120 → 123 at the rebase onto PR 214). Three existing entries were retargeted: the two `maximum` mutations now list 1.0.1 and 1.0.2 as incompatible, and the recipients mutation now edits `packages/contracts/src/outbound.ts`.

**The version order: API first this once, then desktop 1.0.5.** This is an app-only API release, then a desktop-only one:

1. Build both images at the release commit (2.1).
2. Deploy with `release-deploy.sh infra/roots/production fss-prod --api-digest … --worker-digest …` and **no** `--schema-change` (4.1). The schema range is unchanged.
3. Smoke.
4. Confirm `curl -fsS https://api.usecallie.com/auth/client-version` reports maximum `1.999.999`.
5. Set `FSS_DESKTOP_APP_VERSION` to `1.0.5` and publish (`docs/greenfield/install.md`, "5d — publish 1.0.5").

Installed 1.0.0 to 1.0.4 keep working throughout. From then on a 1.x desktop publishes without an API deployment, unless 2.0 says the API goes first.

**Still unverified.** Nothing here has run in Electron or against production. The release checks replace the socket with `dispatch`, and the Playwright specs substitute the bridge. Unmeasured:

- 1.0.4 against the new API's `1.999.999` on a real Mac;
- the merge screen on a real refusal: there is still no control that starts a merge, so it opens only from `resolveMerge`;
- a receipt written with details, replayed across an API deployment.

### 8.0ak What lane g79 fixed: calls apply to their step, keep their ticket, and are never refused (25 September)

**What was wrong.** The 25 September audit (items C04, C13, C14, C15, C16, C17, C18, S10, S15, C22) found the calling path recording a call as a row that pointed at nothing. A logged call applied no step effect, so a voicemail left its call task on Today for ever and the cadence stalled; the no-answer behaviour came from the request; the ticket and calling identity were never carried into the log; the Mac's clock was the call's time, so a fast Mac failed `recorded_at >= occurred_at`; a callback with no time, or a wrong number with no route, was refused and the call lost; a refusal half-way committed the effects before it; a route from another firm could be retired; a callback could not be completed from the Mac because the Today task dropped its id; the Mac resolved New York's 02:30 on 8 March to 01:30 while the server resolves it to 03:30 and never checked the two agreed; consuming a dial ticket did not re-run `authorizeDial`; and an automated task's "snooze until Thursday" was an indefinite firm-wide hold with the date discarded.

**The fix.** `logCallOutcome` decides every refusal before it writes, records the call, and applies the effects in a savepoint, answering `followUps` (callback needs a time, no number named, effects not applied) instead of refusing history. A call logged against its Today task (`itemId`) applies the frozen step's successor or `retry_call`; an engaged call stops every live enrollment at the firm in the same transaction. "Just now" is database time. The ticket, identity and route travel from the handoff to the log and are checked against the firm. Recording a call against a callback task completes the callback; a callback without a time is a "Callback — needs a time" task, set later with `POST /callbacks/schedule`. The calendar clock moved to `@fss/contracts`, so the Mac and the server resolve a wall clock with one implementation, and the server refuses a `dueAt` that disagrees. Consumption re-runs `authorizeDial` against what the ticket recorded. An automated task's action is **Pause**, scoped to its enrollment, visible on the task with a **Resume** control (`POST /today/pause/release`), which resumes the enrollment under 4.3. Decisions: `docs/decisions/g79-calls-carry-their-authorization.md`.

**No migration.** Schema stays at 17 (main's 0017 from lane g71; g79 adds none); this is an app-only API deploy (deploy and smoke) followed by the desktop release that carries the new Today window. The API goes first: the new desktop sends `itemId`, `cardVersion: 2` and bodies without `occurredAt`, which an older API refuses as malformed. Lane g78's ceiling (8.0aj) means the version gate no longer enforces that order, so the request shapes do: publish the desktop carrying these Today files only after this API is deployed. An older desktop (1.0.4) keeps working against the new API: every request change is additive or relaxing, and `/today/firm` answers the old card shape unless `cardVersion: 2` is asked for. `CONTAINER_CLIENT_VERSIONS` is not changed here.

**What David sees on the Mac, once the desktop ships.** After a Call, the outcome form says *The call to +1…* and which task it was for (the call due or callback of the person just called, by default). Recording a voicemail or no answer moves the call task off today's list and the next step or the retry appears on its own day; recording a conversation ends the firm's sequences at once. *Callback requested* with no day records the call and puts *Callback — needs a time* on the list, with a day and time field. A callback's time is shown back before it is recorded, as the server will store it. An automated email's button reads **Pause sending** and asks only why; the task then shows **Paused** and **Resume**.

**Unverified.** Nothing here has run against the deployed stack or a real Phone.app handoff: the evidence is the domain suite on embedded PostgreSQL (`test/policy/callsAndCallbacks.test.ts`), the API route tests, the desktop unit tests and the Home Playwright spec. Production has no firms or sequences yet, so no production call has exercised any of it. Whether a released pause or a retried call step is picked up again by the worker depends on audit item C02 (lane L-D): the execution is re-pended and re-timed here, and a call task is worked from Today, which reads the executions directly.

### 8.0al What lane g74 changed: CI publishes the images, a weekly full rehearsal pins them, and a manifest binds the release (25 September)

**The gaps.** Four items of the audit of 25 September (`GPT6-ASTRA-EXHAUSTIVE-20260925.md`):

- O17: CI verified one build, and the operator pushed a second build of the same commit from a Mac.
- O10: the accepted weekly full rehearsal had no schedule.
- O09: the release record names what the dispatch said, and nothing bound it to the checkout, the run, the images' source or the deployment.
- O11: on 25 September the nightly's first scheduled run never started, and nothing noticed.

`docs/decisions/g74-ci-publishes-and-the-weekly-rehearsal-pins.md` has the reasoning.

**What changed.**

- **CI publishes the images.** `greenfield-images.yml` gains a `publish` job for pushes to main that change an image input. It uses the `rehearsal` environment and `fss-rh-deploy`, whose policy already holds `ecr:*` on `fss-rh*`, so IAM is unchanged. It pushes `fss-rh-api:ci-<commit>` and `fss-rh-worker:ci-<commit>` once each, pulls both back by digest, and verifies them (`infra/scripts/release-images.sh verify`). It publishes the digests as the artifact `fss-image-digests` (`fss.image-digests.v1`) and in the step summary. The pull-request job builds and verifies as before and holds no credential. `push.paths` now includes `certs/**`, which both images copy.
- **Promotion to production is a copy, not a rebuild.** `infra/scripts/release-promote.sh <release-manifest.json>` copies both digests from `fss-rh-*` to `fss-prod-*` with `docker buildx imagetools create`, reads production back, and refuses a different digest. An existing tag naming another image, or a digest the rehearsal repository lacks, is also refused. CI's `image-digests.json` is accepted only with `--app-only`, the one release class the cadence lets reach production without a rehearsal. It is the operator's, with the admin profile, and it replaces `fss-prod-images.sh`.
- **The weekly full rehearsal is scheduled.** `greenfield-weekly-rehearsal.yml` wakes at minute 23 of every Sunday hour. It rehearses at `FSS_WEEKLY_REHEARSAL_HOUR_UTC` (repository variable, default 9, `off` pauses). A later Sunday hour catches up only if no run since the slot pinned. It pins the digests CI published for the commit it runs at (`release-images.sh pin`), using the newest green publish run whose image inputs are byte-identical to that commit's. The desktop stamp is the commit itself. Then it calls `greenfield-release.yml` (`workflow_call`) with `stage: full` and `pinned_commit`, and the called run refuses unless it checked out exactly that commit. A commit whose images CI has not published is refused, and nothing runs. It holds no credential beyond the called rehearsal's `fss-rh-deploy`, so production is never touched.
- **One manifest per green full run.** After the record, `infra/scripts/release-manifest.sh write` produces `release-manifest.json` (`fss.release-manifest.v1`), and `verify` checks it at once. It binds:
  - the record's reference and SHA-256;
  - the checkout, the run id, attempt and URL;
  - both digests and whether CI built them from this code;
  - the desktop stamp and `FSS_DESKTOP_APP_VERSION`.

  The manifest and record are kept together as the artifact `fss-release-manifest`. The record's shape is unchanged.
- **Nightly and weekly freshness.** `greenfield-freshness.yml` runs at 13:41Z and 21:41Z with `actions: read` and `issues: write` only. It fails when the newest successful nightly on main is over 30 hours old, or the newest `fss-release-manifest` from main is over eight days old. On failure it opens or updates one issue, mentions the owner, and asks GitHub to pin it. It closes the issue when both are fresh.
- Eleven mutations appended to `scripts/releaseMutationCheck.mjs`, 136 → 147 on this branch, rebased on main `2d262695` (other lanes append concurrently). Each was applied by hand and turned its own check red.

**What the operator does differently at the next release.**

1. The digests come from the images run's `fss-image-digests` artifact, or from the rehearsal's `fss-release-manifest`. There is no local build.
2. After a green `full` run, download `fss-release-manifest`. Run `infra/scripts/release-promote.sh release-manifest.json`, then deploy with the same two digests and `--release-record release-record.json`.
3. After the deploy, run `infra/scripts/release-manifest.sh deployed release-manifest.json release-manifest.deployed.json`. It reads both production services and their task definitions, and records them only if they run the manifest's digests.

**Release class.** Workflows and scripts only: no schema, no image change, no infrastructure. The first push to main after merge that touches an image input is the first `publish`. The first Sunday after merge is the first weekly run.

**Still unverified.** Nothing here has run in GitHub or AWS. The first real runs will show:

- whether `publish` pushes and reads back as written;
- whether the called rehearsal behaves exactly as a dispatched one, including its concurrency group;
- whether `GITHUB_TOKEN` may pin an issue (a warning if not);
- whether the `rehearsal` environment makes either run wait for an approval.

`release-promote.sh` and `release-manifest.sh deployed` have run only against stubs.
### 8.0ao What lane g82 changed: a held or stranded step is woken again, and settled from its fence (25 September)

**The gap.** The audit's lane L-D items were real in code at `0af4ce3c`; lane g79 (8.0ak), which merged first, made a logged call complete or re-arm its step and a released Today pause resume its enrollment, and both now reach the worker through the wake below. Production has no enrollments yet, so none of them has bitten.

- C02: the `sequence.action` key was `step-execution:{id}`. A step held by the cap, a window or a pause completed its job, and when it was due again the scheduler's insert collided with the `done` row. It never ran again.
- C03: a worker that died between the step's transaction (`dispatched` plus a prepared fence) and the dispatch claim left the fence `prepared`. The retry read `dispatched`, did nothing and completed.
- C05: releasing a hold woke nothing. Only the salesperson's long-hold resume called `resumeEnrollment`.
- C09: a second resume shifted the steps by the first hold again.
- C10: the resume asked five hold scopes of seven, and the scheduler asked none.
- C11: the successor was always the start-anchored plan. A late email was followed by a call due the same hour, and 12.5's "next delay calculated from the original dispatch time" was never read.

Two more defects surfaced on the way. A capped step's own firm cap hold kept its next run from ever reaching the dispatch that would release it. And an admin's `delivered` or `skipped` on an `unknown_terminal` fence did nothing to the sequence.

**What g82 changes.** `docs/decisions/g82-a-step-is-woken-by-its-row-version.md` has the reasoning.

- **The wake.** The key is `step-execution:{id}:{wake}`, where the wake is the row's `updated_at` in microseconds. A row nobody wrote to is not asked again; a row that moved is a new job. `listStepWakes` never materializes a wake for a step that already has a live job.
- **What is woken.** Due `pending` work. `held` work past its `not_before` that no open hold blocks, asking all seven scopes as eligibility does (so a released hold wakes its steps on the next pass). `dispatched` work untouched for ten minutes. A step's own fence's holds do not block its own wake.
- **How long a held step waits.** A step an open hold blocks keeps its `not_before` and sleeps until the release. Any other held step waits out its reason's interval: `CLOCK_CLEARING_HOLDS` as before, fifteen minutes for `send_unknown_terminal`, an hour for the rest.
- **The run starts from what happened.** An email step with a fence is driven from the fence. `sent` completes it from the original dispatch. `dispatching` and `reconciling` hold it. The admin's answer to `unknown_terminal` continues or stops the sequence and releases the firm's terminal hold. `prepared` and `held` go back to the dispatch path, which now dispatches a `held` fence too and still claims atomically under the send gate. A held step is resumed (4.3) before its eligibility check.
- **C09, C10.** A resume counts only the window after the last applied resume. It asks all seven scopes for the next step's own action kinds, and ignores holds the enrollment's own fences opened.
- **C11.** A successor is due at the later of the plan and the plan's gap counted from when the previous step actually happened (for an email, the original dispatch instant). Business-day gaps are counted in business days. A floor-produced due instant's `rule_version` ends `+after-completion`.
- `SendHandoff.readOutcome` gains the fence id and the admin resolution; `outboundSendHandoff` passes them through.
- Ten mutations, appended to `scripts/releaseMutationCheck.mjs` (main 136 → 146 at `2d262695`), each applied by hand and killed by its own suite.

**Not done.** C12 (LinkedIn undo) is left. David's decision G09 deletes LinkedIn steps, and that deletion reaches migrations, contracts, API routes, the desktop and Today, most of them other lanes' files. The undo defect stands until then.

**Release class.** Application-only: no migration, no schema range change. Both images change: the domain's resume is also the API's `/enrollments/resume`. Sending stays disabled in production and there are no enrollments, so nothing changes live until the first enrollment. It touches the dispatch hand-off, so it rides the next `full` rehearsal already owed for g70, g73 and g77; otherwise deploy and smoke.

**What the next `full` rehearsal should show.**

1. The release suite passes unchanged. No scenario check drives the wake; `apps/worker/test/sequenceActionRearm.test.ts` and `packages/domain/test/sequences/wake.test.ts` are its proof.
2. The drill's phases still reach `accepted_send` or `in_doubt_send`. The drill dispatches its own fences and does not run through the wake, so a refusal there is not this lane's.
3. The scheduler's `sequence-action` source logs no pass that inserts the same step every minute.

**Still unverified.** Measured only on embedded PostgreSQL 16:

- the wake query's cost with many held steps (the `dispatched` arm and the live-job check scan without a dedicated index);
- a real worker killed mid-claim on Fargate rather than a terminated backend;
- the hour-long recheck interval, which is reasoned, not measured.
### 8.0am What lane g80 changed: an app-only release is one rolling deployment, and it ends only when the release is what runs (25 September)

**The findings.** The GPT-6 exhaustive audit of `b2cc080b` raised six release and test items against the scripts this lane owns:

- **O03.** An app-only deploy, with no `--schema-change`, still launched four one-off tasks: migrate, database users, and verify twice. It also forced a second rollout of each service after the one the apply had started.
- **O08.** "Services stable" was the last word. The circuit breaker rolls a failed deployment back, and a service that has rolled back is stable.
- **O07.** A one-off task record was keyed by its step name alone, so a reused reports directory could read another release's verdict. Read from the code, one case did this on every `full` run: the restore drill's step 7 runs `rehearsal-schema-ranges.sh` again, in the same job and directory with the same step names, and it waited on the first run's tasks instead of launching its own.
- **O06.** A failed record was read for ever, including the `CannotPullContainerError … not found` a one-off hit minutes after an ECR copy.
- **O12.** The smoke passed only on `sendingEnabled === false`.
- **T01.** The mutation runner counted "Test Files 1 failed" with "Tests no tests" as a kill.

**What changed.** `docs/decisions/g80-app-only-deploy-and-task-records.md` has the rules. In short:

- **The rolling path** is `update-service --desired-count` on the worker and then the API, with no forced deployment. Then one wait for both, then the running-digest check. It launches no one-off task. `--release-record`, when given, is the one launch, and it runs last.
- **The schema path** keeps all seven steps. The running-digest check runs after step 6.
- **The running-digest check** reads `describe-services`, `list-tasks` and `describe-tasks` for both services. Each service must have one deployment that did not fail, exactly the declared number of running tasks, every task on that deployment's task definition, and the release's digest in the `api` or `worker` container. A release that adds a migration but is deployed without `--schema-change` fails here, and the message says so.
- **`--api-digest` is required** as well as `--worker-digest`, both as `sha256:` digests. `bootstrap=true` without `--schema-change` is refused. The account, cluster ARN and cluster tag guards now run in the deploy script before its first call.
- **A task record** carries a SHA-256 fingerprint of the invocation: the run, cluster, step, task definition revision, container, digest, database host, credential entry, command words, overrides and expected exit code. It is waited on only by the same invocation. A record with any other fingerprint, or none, is refused while its task runs, and otherwise set aside unread. A record is retired to `tasks/<step>.history` once its outcome is read. The run is `FSS_RELEASE_RUN_ID`, else the Actions run and attempt, else the reports directory.
- **A task stopped by `CannotPullContainerError`** before any container ran is launched again. It gets three attempts in all, 30 s then 60 s apart, and each is logged. Everything else fails on its first attempt, including a secret with no value.
- **`scripts/productionSmoke.mjs --expect-sending disabled|enabled`**, default `disabled`. The sixth line reads `PASS sending_disabled (sendingEnabled=false expected=disabled)` by default, where section 6's text shows it without `expected=`. Under `--expect-sending enabled` it is `sending_enabled`. An unknown state is exit 2.
- **The mutation runner** counts a kill only when a test ran and failed and nothing in the output is a syntax or transform failure. Otherwise the run is broken, counted in `brokenRuns`, and reported as `MUTATION_UNDECIDED <name>: broken run: …`, which fails the nightly.

Section 4.1's sentence on the rolling path ("the migration task finds nothing to apply and says so, and steps 5 and 6 set the declared counts") and `infra-apply-runbook.md`'s rolling row describe the path before this lane; this record supersedes them.

**What an app-only release is now, in production.**

1. Build and push both images (2.1).
2. Plan and read it. Only the two service task definitions and the services' `task_definition` change (`infra-apply-runbook.md` 3.2).
3. Apply.
4. `infra/scripts/release-deploy.sh infra/roots/production fss-prod --api-digest … --worker-digest …`, with no `--schema-change`. It prints the running task of each service with its digest.
5. Smoke. Pass `--expect-sending enabled` once section 6 has turned sending on.

**Test evidence, offline only.**

- `test/release/scenario22.check.ts` drives both paths against a fake ECS. The rolling path makes no `run-task`, exactly two `update-service --desired-count` calls, no forced deployment and one wait. It fails on a stale API or worker digest, on fewer tasks than declared, on a failed deployment, and on a wrong tag, account or caller, and it refuses a bootstrap or a missing API digest before any call. The schema path runs from its assertion to the final verify, with the digest check between step 6 and step 7.
- `test/release/oneOffTaskRecords.check.ts` covers the record rules against a fake CLI that counts launches: resume, another release, another command, another revision, a second run after a read, a task still running, a record from before g80, a pull failure then a pass, three pull failures, and no retry for an exit code or a missing secret.
- `test/release/productionSmoke.check.ts` runs both expectations against both answers.
- `test/release/mutationRunner.check.ts` feeds the runner the vitest output of 25 September probes.
- `test/release/support/runTaskGuards.sh` seeds a fingerprinted record and adds the set-aside and pull-retry guards.

Eleven mutations are appended to `scripts/releaseMutationCheck.mjs` (136 → 147 at the rebase onto PR 218). Each was applied by hand and turned its own check red.

**Still unverified.** Nothing here has run in the cloud. Unmeasured:

- that a count-only `update-service` starts no second deployment;
- that `describe-tasks` reports `imageDigest` for these Fargate tasks as expected;
- the state a rolled-back service is left in;
- that ECS words a post-copy pull failure as `CannotPullContainerError`, as the 25 September log did.

The `fss-rh-deploy` and `fss-prod-deploy` policies allow `ecs:Describe*` and `ecs:List*` on every resource, so the three reads need no new permission. This is a release-script change under the release cadence, so a full rehearsal must pass before production relies on it.

One question is left open. Once sending is on, the worker sends only under a stored record carrying its own digest (8.0ag). An app-only release with a new worker digest, deployed without a rehearsal, holds every send until such a record exists.

### 8.0ap What lane g83 changed: Callie updates itself when it is opened (25 September)

**The gap.** Audit item G11. The updater checked the channel every six hours and never at launch. On a hit it asked, wrote the verified zip to Downloads, and told the person to unzip it and replace Callie in Applications. That was G13a's choice (`docs/decisions/g13-update-application.md`) when no Developer ID signature existed. Signed and notarized builds have existed since 1.0.0 (8.0t).

**What g83 adds.** Desktop only: no route, no migration, no infrastructure, so the release is a desktop build and publish (2.1). `apps/desktop/src/main/updateInstall.ts` holds every decision and step, with Electron-free ports. `updater.ts` binds it to macOS, and `main.ts` starts it right after `start(...)`. `docs/decisions/g83-the-update-installs-itself.md` is the design.

- **At launch** the channel is read at once. An update is downloaded, unpacked with `ditto` into `~/Library/Application Support/Callie/updates/staging/`, verified, swapped into place and relaunched (`app.relaunch` and `app.exit(0)`), without a question.
- **While in use**, the six-hourly check stages a verified update and adds *Callie 1.0.6 is ready* and **Restart to update** under the version row in Home's sidebar. The next launch installs it if the person does not.
- **A raised minimum client version** (5.3): the in-use check installs at once, because the app is refusing every mutation anyway.
- **The bundle checks**, on top of the unchanged channel checks (signature, origin, version, size, sha256): `CFBundleShortVersionString` equals the manifest's `releaseVersion` and is newer; `CFBundleIdentifier` equals the running app's; the Team ID equals the running app's; and `codesign --verify --deep --strict -R '=anchor apple generic and certificate leaf[subject.OU] = "<team>"'` passes. A running build with no Team ID (the local smoke build) installs nothing.
- **The swap** is three renames. The staged bundle moves into `/Applications` as `.Callie-<new>.incoming`, the running one becomes `.Callie-<current>.previous`, and the incoming one becomes `Callie.app`. A failure part-way is undone. Any failure after verification falls back to the zip in Downloads.
- **The previous bundle** is deleted only after the new version has started once and written `updates/launched.json`. If the new version will not start, `install.md` "If an update will not start" restores the previous one by hand. The restored build then holds the version that failed (`updates/held.json`), so the next launch does not reinstall it.

**The first automatic update.** The running build's updater is the one that receives an update, so the update *to* the first desktop build carrying g83 arrives the old way (dialog, Downloads, replace by hand). The update *from* that build is the first that installs itself. If 1.0.5 is built from a commit that carries g83, 1.0.4 → 1.0.5 is manual and 1.0.5 → 1.0.6 is the first automatic update.

**What David sees, from that build on.** Opening Callie when a release is out: the sidebar's last line reads *Updating Callie to 1.0.6…*, and Callie closes and reopens as the new version. A release published while Callie is open: *Callie 1.0.6 is ready · Restart to update*. The refusal dialog (*Callie could not verify the update*) and the silence on a tampered manifest (install.md step 6) are unchanged.

**Unverified.** No real signed install has run. The evidence is `apps/desktop/test/updateInstall.test.ts` (fake filesystem, fake `codesign`/`plutil`/`ditto`, fake relauncher), `test/updater.test.ts` (the Electron binding with Electron mocked, the real `node:fs` port, and the whole swap on a real temporary directory), the Home unit tests and `test/e2e/update.spec.ts`. The `codesign` requirement was checked by hand, read-only, against the installed 1.0.4 on David's Mac. Three things only the published 1.0.5 → 1.0.6 path can prove:

- that macOS's App Management protection lets the app rename its own bundle in `/Applications` (if not, the first rename fails and the zip fallback runs);
- that the relaunch starts the new bundle;
- how long the deep verify takes on a real release bundle (about 18 seconds cold on 1.0.4).

### 8.0an What lane g81 changed: each critical condition e-mails, the load balancer asks readiness, each task gets its own secrets (25 September)

**The gap.** The independent audit of 25 September (`GPT6-ASTRA-EXHAUSTIVE-20260925.md`) named six operations and safety items for this lane: O14, O15, O16, S12, S14 and S17. All six were real in code. The coordinator then asked for three more fixes in the same pull request, all found while checking these items.

- **O14.** `fss-prod-critical` was one OR composite, and a composite e-mails only on its own transitions. The first critical alarm to trip hid every later one until all had cleared.
- **O15.** `gmail-watch-expiring` treated a missing gauge as breaching, and the gauge exists only while a mailbox is connected. `MailboxCheckHeartbeat` was built from any mailbox heartbeat row. An environment with no mailbox, or one disconnected on purpose, sat in critical ALARM and held the roll-up there.
- **O16.** The worker logged `restore_generation_mismatch` once, at startup. The one-minute alarm over it read OK soon after, while the mismatch lasted.
- **S12.** Both journal writers read a `409 ConditionalRequestConflict` as a durable object. A conflict could acknowledge a suppression that no journal object recorded.
- **S14.** The target group polled `/healthz`. A task on the wrong schema range or generation, or with no database connection free, was put in service.
- **S17.** One secret map went to the API, the worker, the operations tool and the drill. Three processes that never sign anyone in held the session-signing key, the device pepper and the sign-in client.
- **Found while checking.** The classifier reads `FSS_LLM_CLASSIFIER_API_KEY`, and the key was injected as `llm-classifier-api-key`, so the deployed worker never had a classifier. Nothing read `research-provider-credentials`. Nothing logged `suppression_journal_write_failed`, so its immediately-critical alarm could not fire. `MailboxDisconnectedHours` counted a mailbox its owner disconnected on purpose.

**What g81 changes.** The reasoning is in three decision docs: `docs/decisions/g81-one-e-mail-per-critical-condition.md`, `g81-the-load-balancer-asks-readiness.md` and `g81-each-task-gets-its-own-secrets.md`.

- **A composite per critical condition.** Each of the 13 critical conditions gets `<prefix>-critical-<condition>`, which e-mails on ALARM only. `<prefix>-critical` now sends only the all-clear. The warning roll-up is unchanged. A single incident is still two e-mails, and each further condition that trips while it is open adds one.
- **Held-back e-mails while the worker is down.** The API, scheduler and mailbox heartbeat composites and the canary composite are held back while `worker-heartbeat-missed` is in ALARM, because the worker's silence trips all four (wait 120 s, extension 300 s). A dead worker is one e-mail, not five.
- **The watch alarm and the check heartbeat.** `gmail-watch-expiring` is not-breaching on missing data. The mail lane publishes `MailboxCheckHeartbeat` on every pass: 1 when every connected mailbox is checked on time or none is connected, 0 otherwise. The job lane no longer publishes it.
- **The restore mismatch.** The worker's metric loop logs `restore_generation_mismatch` on every pass while the pin and the database differ (`continuing: true`). The alarm fires on one line and clears after three quiet minutes.
- **The journal writers.** Only a `412 PreconditionFailed` is durable now. A 409 fails that write, and the command fails with 503 `journal_unavailable`. Its retry meets the object or writes it.
- **The journal alarm can fire.** Both writers log `suppression_journal_write_failed` at level `error` on every refusal but the `412`, with the writer and the error name and nothing that identifies the suppression. The observability module now filters the worker's log group for it too, into the same metric.
- **The target group.** It polls `/readyz`, and a 503 is unhealthy. That covers `database_busy`, which now takes a task out of service. The container check stays on `/healthz`.
- **Per-process secrets.** Each runtime task definition carries the secrets its process reads. The authentication secrets reach the API alone. A plan with an application secret no list names is refused.
- **The classifier key, under the name the classifier reads.** The worker is handed `llm-classifier-api-key` as `FSS_LLM_CLASSIFIER_API_KEY`, in production only. The classifier has no recorded seam, and a rehearsal's entry holds a fixture. `research-provider-credentials` is handed to no task. The entry itself stays.
- **Owner disconnect.** `MailboxDisconnectedHours` counts `status = 'revoked'` only: a refused grant or a departure. A mailbox its owner disconnected is no longer a critical alarm two days later.
- **Coverage age, visible outside the Mac (coordinator addition).** Since lane g77 the send path holds an owner's automated email once their watermark is fifteen minutes old. Until now nothing but the Mac showed whether sync was advancing.
  - The worker publishes `MailboxCoverageAgeSeconds` on every pass: the stalest connected, `ready` mailbox's `coverage_watermark_at` age on `clock_timestamp()`, judged by the gate's own `coverageIsFresh`.
  - A watermark the gate cannot credit reads 901: none on a ready mailbox, or one more than five minutes ahead of the database clock. With no mailbox connected and `ready`, nothing is published.
  - The new warning `mailbox-coverage-stale` fires above 900 s for 3 of 3 minutes, is not-breaching on missing data, and is a member of the warning roll-up only. Its runbook is `docs/greenfield/runbooks/mailbox_coverage_stale.md`.
- **Mutations.** Twenty are appended to `scripts/releaseMutationCheck.mjs`, 147 on main at `837030c7` plus 20 is 167. Each went red when applied by hand to its own suite.

**What changes in the production plan.**

- 13 new `aws_cloudwatch_composite_alarm.critical_condition` resources.
- `fss-prod-critical` loses its alarm action.
- One new metric alarm, `fss-prod-mailbox-coverage-stale`. `fss-prod-warning`'s rule gains it.
- Three metric alarms are updated in place: `gmail-watch-expiring` (missing data), `restore-generation-mismatch` (three evaluation periods) and `mailbox-disconnected` (description).
- One new log metric filter, `fss-prod-suppression-journal-write-failed-worker`, on the worker log group.
- The target group health check path is updated in place.
- The API, worker, operations and drill task definitions are new revisions with fewer secrets, and both services roll. The worker's revision gains `FSS_LLM_CLASSIFIER_API_KEY` and loses the logical-name copy.

**Live behaviour this changes.** After the deploy the production worker composes the reply classifier. It claims `classify.reply` for replies that need a second opinion, within the workspace's daily cap, and sends each one to the provider under the key in `fss-prod/llm-classifier-api-key`. If that entry holds a real key, this is the designed behaviour, off since the cutover because of the name mismatch. If it holds a placeholder, every `classify.reply` dies and `dead_job_unresolved` warns an hour later. David should confirm which before the production apply. `FSS_CLASSIFIER=off` is the documented off switch, and no root sets it.

No IAM, no principal and no network change. The deployment role already holds `cloudwatch:*` on `alarm:<prefix>*` and `PutCompositeAlarm` on `alarm:*`.

**Release class.** This changes infrastructure, so it takes a `full` rehearsal before production. Both images change as well: the journal writers, the metric loop, and the mail collector's two gauges.

**What the `full` rehearsal should prove.**

1. The create and deploy stages apply 13 per-condition composites, four of them with an actions suppressor, and CloudWatch accepts them.
2. The API service reaches steady state behind `/readyz`, and the rolling deploy completes.
3. The restore drill still sees `<prefix>-restore-generation-mismatch` go to ALARM from the drill's one line.
4. `fss verify` and the drill start with the narrower secret sets.
5. The rehearsal worker starts with no classifier: its `worker_configuration` line reads `classifier_configured: false`.

**Left open.**

- **Repetition.** 13.3's "repeated while critical and unacknowledged" still does not happen. Nothing raises a `critical_alerts` row, and the age metric would not cycle anyway.
- **Stale text.** The 8.0ac table above and `docs/greenfield/processes.md` still name `fss-prod-critical` as the e-mail for every critical alarm and `/healthz` as the load balancer's path, and `processes.md` still says every secret arrives under its logical name. So does the comment at the top of `apps/api/src/bootstrap/readiness.ts`.
- **Dispatch readiness.** Ordinary API dispatch still does not enforce readiness, the other half of S14.

**Still unverified.** Nothing here has run in the cloud. The Terraform assertions ran as `terraform validate` locally and run as `terraform test` in the infrastructure workflow. The actions-suppressor timing comes from the CloudWatch documentation and has not been observed. Nor has the ECS behaviour when every task fails readiness during a database outage.
### 8.0ar What lane g85 changed: a production plan needs no Google login (25 September)

**The gap (audit O01, P0).** `infra/roots/production` declared `provider "google"` for the
four Gmail push objects: the topic, the push subscription, the push service account and
Gmail's publisher grant. Terraform configures every provider a root requires before it
plans anything, so every production plan, an image-only release included, needed
application-default credentials for `callie@usecallie.com`. The Workspace
reauthentication policy lapses those about every 17 hours, and a lapsed login held back
the deployment of `b2cc080b`'s worker fix. David decided on 25 September to give the
Google provider a root of its own. `docs/decisions/g85-the-google-provider-has-its-own-root.md`
has the reasoning.

**What changed.**

- **`infra/roots/production-google`** is a fourth root. It holds the four objects and
  nothing else:
  - it has the Google provider and no AWS provider;
  - its state key is `fss/greenfield/production-google/terraform.tfstate`, in the
    production state bucket and lock table;
  - `import` blocks adopt the four objects;
  - its outputs are the topic id and name, the subscription name, the push service
    account, the audience and the project.

  It is planned only when a push object changes, and only with application-default
  credentials.
- **`infra/roots/production`** declares no Google provider and no `module.pubsub`, and
  it has lost `enable_gmail_push`, `gcp_project_id` and `gcp_region`. It carries the
  topic id and the push service account as the defaults of `gmail_push_topic` and
  `gmail_push_service_account`. These are the rehearsal root's variable names, with the
  production values. It still derives the audience from `api_hostname`. The task
  definitions carry the same three strings as before.
- **`removed { from = module.pubsub  lifecycle { destroy = false } }`** in the
  production root. A production plan taken before the migration's state removal shows
  the four objects as "will no longer be managed by Terraform", never as deletions.
- **`test/release/googleRoot.check.ts`** requires the following. Three mutations are
  appended to `scripts/releaseMutationCheck.mjs`, 168 → 171 at the rebase onto `9f10dbc0`:
  the provider comes back, the topic default drifts, and the `removed` block destroys.
  Each was applied by hand and turned the check red.
  - Only the Google root and `infra/modules/pubsub` name Google.
  - The production defaults equal what the Google root's own names produce.
  - Both roots derive the audience with one expression from one path default.
  - The Google root's key is unique and outside the rehearsal key space.
  - The `removed` block says `destroy = false`.
- The rehearsal root and `greenfield-release.yml` are unchanged. The rehearsal never
  had a Google provider.

**What the operator does, once, before the next production plan.** Follow
`docs/greenfield/google-root-migration-runbook.md`. It needs the admin profile and
application-default credentials, and it writes Terraform state only:

1. Back up the production state.
2. Check that the production state's recorded identifiers equal the new defaults.
3. Plan the Google root and read it: `Plan: 4 to import, 0 to add, 0 to change, 0 to destroy`.
   A label-only variant is acceptable.
4. Apply that plan.
5. `terraform state rm 'module.pubsub[0]'` in production.
6. Plan production with every Google credential hidden, and read that it runs to the end
   with no Google line.
7. Read the objects back from Google and see them unchanged.

The runbook has the rollback for each step, and fallback B for the one case where the
import plan is refused.

**What changes for every release after that.**

- A production plan needs **no Google login**. **Do not pass
  `-var="gcp_project_id=…"`** to `infra/roots/production` any more: Terraform refuses
  it as an undeclared variable.
- The following prose describes the tree before this lane, and this record supersedes
  it:
  - section 1.7 and the `gcp_project_id` row of section 4's root-variable table;
  - the `FSS_GMAIL_PUSH_TOPIC` row that says the topic is derived from `module.pubsub`;
  - `infra-apply-runbook.md` 1.3a and the `gcp_project_id` lines of its 3.0 and 3.2.
- Application-default credentials are needed only to plan or apply
  `infra/roots/production-google`, and to read the Google side back.

**Release class.** Infrastructure, but no AWS resource and no Google object changes, and
no production apply is part of it. The migration is state only. The next ordinary
production plan must show no Google resource, and no change to `FSS_GMAIL_PUSH_*`. The
cadence asks for a rehearsal only when the rehearsal root or the release scripts change,
and neither did here.

**Still unverified.** Nothing here has run against a real backend or Google. Checked
offline:

- `terraform fmt -check` and `terraform validate` pass for both roots, after
  `init -backend=false`;
- the production root's provider lock lists only `hashicorp/aws`;
- the release suite passes.

The two roots' `terraform test` runs are CI's (`greenfield-infra.yml`). The migration
will show:

- whether the Google provider imports the topic's and the subscription's labels as
  empty, which is the label-only variant;
- that the first production plan with no Google credential runs to the end.

`infra/scripts/offline-gate.sh` belongs to lane g80. Its Google check still allows
`infra/roots/production/` and must allow `infra/roots/production-google/` instead; the
pull request carries the diff. Until then, a hand-run of that script flags the new root.

### 8.0aq What lane g84 changed: a founder adds and imports firms, records postures, and Today keeps itself current (25 September)

**What was wrong.** Three items of the 25 September audit (`GPT6-ASTRA-EXHAUSTIVE-20260925.md`):

- **G02.** An empty workspace could not be filled from the Mac. Nothing created a firm, a contact or a route, and `POST /import/*` had no screen.
- **G04.** A call to a state with no posture is refused (9.2 step 6), and Settings printed `/postures — G4 policy` where the form should be.
- **G05.** Home read Today's list only at sign-in and on Refresh, so a window left open overnight showed yesterday's list.

**What changed.** `docs/decisions/g84-founder-capture-postures-and-refresh.md` has the rules; the import format is in `docs/greenfield/crm-surface.md`, "The CSV".

- **Add firm** (Firms window, any member): firm name, website, time zone, and optionally the first contact's name, title, email and phone. One command, `POST /crm/firms/add`. A refusal names every field; a firm already here comes back with **Open the firm already here**.
- **Import CSV** (Firms window, admins): one row per contact with the firm's columns repeated, header required. The screen previews every row as *New firm*, *Adds a contact*, *Already here* or *Fix*, with the column and reason, and imports nothing until **Import N rows**. Firms match by external id, then website domain, then name; contacts by email, else name. The commit decides each row again and refuses what changed since the preview, naming the row and column. A row is one transaction.
- A captured firm is assigned to whoever captured it, its routes are `candidate` (the route policy's own starting state), and it is listed under **Not in the pipeline yet**.
- **Calling postures** (Administration › Settings): the postures with their status and **Revoke**, and a form — state, takes effect, review by, one box per statement in `statePosture.ts`'s words, the rule quoted for the state, a note — with the JSON behind **Show as JSON**. The texts come from the new `GET /postures/reference`. An overlapping posture now answers 409 `posture_overlapping`; it was a 500.
- **Today** reads again on focus when the last read is a minute old, and at 05:00 and 05:10 in the business zone, without clearing the notice and never while somebody is typing in the lanes. A line under the summary says *Updated just now* / *Updated 4 min ago*, and *Could not refresh.* with **Retry** when a read failed.

**No migration.** The schema range is unchanged. This is an app-only API deployment (deploy and smoke), then a desktop release carrying the new windows. **The API goes first**: the new desktop calls `/crm/firms/add` and `/postures/reference` and reads the preview's `attach` outcome, which an older API does not have. The installed 1.0.4 sees nothing different: it never calls `/import/*` or `/postures*`, and no answer it parses changed. `CONTAINER_CLIENT_VERSIONS` is not changed.

**Test evidence, offline only.**

- `test/release/founderCapture.check.ts` drives the shipped CRM and Administration bridges through the real routes on embedded PostgreSQL. A salesperson adds a firm and it lands assigned to them with two `candidate` routes; the same website again is refused with the firm's id. An import is previewed, the same firm and contact are then added by hand, and the commit refuses row 2 at `contact_email` and attaches row 3 to that firm. A posture is recorded at midnight in the business zone, an overlap comes back as its sentence, and a revoke lets a new one in.
- Domain: `packages/domain/test/crm/capture.test.ts`. API: `apps/api/test/capture.test.ts` and `postureForm.test.ts`, each asserting `wireDrift` is empty. Desktop units: `capture.test.ts`, `postures.test.ts`, `todayRefresh.test.ts`. Playwright: `capture.spec.ts`, `postures.spec.ts`, `todayRefresh.spec.ts`, the last on the page's own fake clock.

Eight mutations are appended to `scripts/releaseMutationCheck.mjs` (200 → 208 at the rebase onto PR 222). Each was applied by hand and turned its own test red.

**Still unverified.** Nothing here has run in Electron or against production. Unmeasured:

- a real window's `focus` event after the phone app or the browser, and timers across a real sleep and wake;
- the 05:00 build finishing before 05:10 on the production schedule;
- a real spreadsheet export's quoting and encoding;
- dialing a captured firm: its routes are `candidate`, and nothing on the Mac validates a route yet.

### 8.0as What lane g87 changed: a raise is earned, the account has headroom, and the guard counts exposure (25 September)

**The gap.** The 25 September audit (`GPT6-ASTRA-EXHAUSTIVE-20260925.md`) left three send-path items after lane g77. All three were real in code.

- **S06, P0.** `POST /outbound/cap` accepted `raiseTo: 75` for a mailbox connected that morning, and the stored raise replaced the ramp's schedule. The whole six-week ramp was one admin click deep.
- **S07, P1.** A salesperson's own sends were counted in `direct_sent`, but nothing read the column. The gate had no ceiling for the account as a whole.
- **S08, P1.** The personal-Gmail guard counted `sent` fences only. A send in doubt left the count, and a direct message counted once however many Gmail recipients it named.

**What g87 changes.** `docs/decisions/g87-ramp-raise-headroom-exposure.md` has the reasoning, and `docs/greenfield/sending.md` rules 6 to 8 have the rules.

- **A raise is earned (S06).** It needs two things. The mailbox has finished the schedule, which is 30 healthy sending days; otherwise the refusal is `ramp_not_settled`. Its last 10 closed sending days were all healthy; otherwise it is `health_not_sustained`. `POST /outbound/cap` returns either code as its 409 `reason`. The gate asks again before every send: a stored raise lifts the day's cap only while the rule holds, and otherwise the schedule governs that day. So a raise recorded before this release on a young mailbox now sends only the schedule's number. `POST /outbound/status` reports the cap in force. `setAdminCap` also stops reading an absent field as null, so lowering a raised mailbox no longer clears its raise.
- **The account has headroom (S07).** An automated send is refused as `daily_cap`, detail `account used/ceiling`, once the mailbox's automated plus direct sends on the claim's business date and the one before it reach 1,500. That is Google Workspace's 2,000 a rolling day, less a 500-message reserve for direct sends the sync has not imported yet. The automated cap's detail now reads `automated n/cap`.
- **The guard counts exposure (S08).** The count covers every fence to personal Gmail that has been claimed, whether `dispatching`, `reconciling`, `sent` or `unknown_terminal`. It also covers every distinct personal-Gmail address on each imported message's `To` and `Cc`. FSS's own imported copy is counted once, matched by Gmail id or deterministic `Message-ID`. The gate now serializes the guard's decisions with a per-workspace advisory lock, so a claim counts the claim before it. The answer keeps the `{ automated, direct, total }` shape: `test/release/sendingSection.check.ts` holds the desktop's fixture to it key for key, and it passes unchanged.
- Six mutations are appended to `scripts/releaseMutationCheck.mjs` (see the pull request for the count on its base). Each was applied by hand and turns `sendingCeilings.test.ts` red.

**Release class.** This is application-only, with no migration and no schema range change. It changes the worker image, because the gate runs there, and the API image, because of the cap command and the status read. No desktop change is needed. Sending stays disabled in production (`FSS_SENDING_ENABLED=false`), so nothing changes live behaviour until the attestation is written. Because this is a sending-safety change, it rides the next `full` rehearsal already owed for g77.

**What the next `full` rehearsal should prove.**

1. Scenarios 5, 12, 16 and 33 pass unchanged. The rehearsal's mailbox is young, and none of them raises a cap.
2. The drill's `accepted_send` and `in_doubt_send` still send. The in-doubt fence now counts against the personal-Gmail guard only if its recipient is on personal Gmail, and the drill's is not.
3. No claim logs a lock timeout or `40P01`. The guard lock is taken only for personal-Gmail recipients, only by claims, and last.

**Still unverified.** Nothing here has run in the cloud. The lock's behaviour is measured only on embedded PostgreSQL 16. Google's limits of 2,000 messages and the Workspace recipient ceilings are taken from Google's published figures, not measured, and this lane had no network to re-read them. The ten-day streak and the 500-message reserve are this lane's numbers, not the specification's, and are David's to change.

### 8.0au What lane g88 changed: a founder authors and starts a sequence, reviews a resume, picks a reply's conversation, and confirms a number (25 September)

**What was wrong.** Seven items of the 25 September audit (`GPT6-ASTRA-EXHAUSTIVE-20260925.md`), and the gap 8.0aq left open:

- **G03, P0.** No main-process handler answered the editor's `saveDraft`. Nothing wrote a template, and nothing on the Mac enrolled anybody, so no sequence could be started from the product.
- **G06.** **Review and resume** resumed on the first press and showed nothing, where 4.3 asks for a review of the rendered future steps first.
- **G07.** An ambiguous reply listed its candidates as text, and the window could not send G7's resolution, which the confirmation requires.
- **G08.** Settings edited each slice as JSON and printed endpoint paths, lane names and raw codes. The sequence editor printed content hashes and stop-condition codes.
- **C19.** A Won or Lost firm came back on Today as a new firm.
- **C20.** An emptied contact title was dropped, not sent as null. Every contact save from the Mac was a 400, because the bridge did not send the `patch` shape the route reads.
- **C21.** Already fixed by lane g84 (unplaced firms are listed under **Not in the pipeline yet**); nothing changed.
- **Routes.** A captured phone number is `candidate`, a call refuses a candidate, and nothing on the Mac could make one usable.

**What changed.** `docs/decisions/g88-founder-authoring-and-review.md` has the rules. The flows are in `docs/greenfield/sequences.md` ("Authoring and starting a sequence on the Mac"), `crm-surface.md` ("The windows") and `settings.md` ("How the page edits them").

- **Authoring (Sequences window).**
  - **New sequence** makes the sequence and its empty draft.
  - **New template** takes a name, subject, email and sign-off. The bridge appends the sign-off and the stop line, and declares the variables the text names. The form refuses unknown variables, unsubscribe links and more than 89 words before sending.
  - **Approve** is its own press, and a refusal lists every issue.
  - The steps are typed controls: Call or Email, delay, template or no-answer action, with reorder and remove. **Start from the suggested plan** fills the editor and publishes nothing, and **Save draft** numbers the steps.
  - **Publish** waits for a save.
- **Enrolment (Firm page).** A Sequences section lists the enrolments running at the firm and enrols a contact in a published version. A firm with no opportunity gets **Add to pipeline** first.
- **Review and resume.** The new read `POST /enrollments/resume/preview` is computed by the same `resumeDecisionFor` and `shiftDueInstant` the resume runs, and writes nothing. The window shows what held the enrollment and each step's *from → to* date in the firm's zone. **Resume with these dates** is the only control that resumes, and the bridge will not resume an enrollment whose review is not on screen.
- **Which conversation (reply page).** One radio per candidate, and **This one** sends `POST /messages/resolve-ambiguity` with `human: false`. The bridge refuses an opportunity that is not one of the open card's candidates.
- **Settings.** Typed controls replace JSON:
  - a zone picker;
  - a sending switch and reference;
  - two version fields;
  - labelled threshold numbers and a time.
  Version, provenance and JSON are behind **Details**. Thresholds and versions are behind **Advanced**, and endpoints and lanes behind **Where each is changed**. Reasons are sentences.
- **Confirm this number (Firm page).**
  - What it does: `POST /contacts/routes/confirm` records the person as the validation (`passed`, confidence 1), lets the route policy decide, and bumps the version. The receipt and the `route.phone.confirmed` audit event record who confirmed the number and when.
  - Refusals: a stale version is refused `route_version_stale`, a failed number `route_invalid`.
  - Phone only: an address's validation is deliverability, which a person cannot supply, and the page says so.
- **C19.** `newFirmSource` excludes a firm with any closed opportunity.
- **C20.** The contact save is sent as `{ contactId, patch }`, with the title as given, including `null`.

**No migration.** The schema range is unchanged.
- New: two endpoints (`/enrollments/resume/preview`, `/contacts/routes/confirm`) and two CRM refusal codes that only the new endpoint returns.
- Unchanged: no existing response changed shape.
- The installed 1.0.5 calls neither endpoint.
- Release class: an app-only API deployment (deploy and smoke), then a desktop release. **The API goes first**, because the new desktop calls both new endpoints.
- `CONTAINER_CLIENT_VERSIONS` is not changed.

**Test evidence, offline only.**

- `test/release/founderAuthoring.check.ts` drives the shipped Sequences and CRM bridges through the real routes on embedded PostgreSQL:
  1. A sequence is created. A template is written and approved, which the server allows only because the bridge appended the sign-off and stop line. The suggested plan is saved, then published.
  2. A refused approval names all its issues past 80 characters.
  3. A firm is added and its number confirmed: usable at version 2, with the actor in the audit. Enrolment is refused without an opportunity. After **Add to pipeline** it succeeds, and the first step is a call.
  4. An emptied title is stored as null.
  5. After a released nine-day hold, pressing resume opens the review without resuming. The confirmation then stores exactly the proposed due instant.
- Domain: `test/sequences/resumePreview.test.ts`, `test/crm/routeConfirm.test.ts`, `test/today/newFirms.test.ts`.
- API: `apps/api/test/founderGaps.test.ts`, with `wireDrift` empty and no receipt for the preview.
- Desktop units: `founderGaps.test.ts` and `reply.test.ts`.
- Playwright: `sequences.spec.ts`, `firmWorkspace.spec.ts`, `reply.spec.ts`, `settings.spec.ts`.

Twelve mutations are appended to `scripts/releaseMutationCheck.mjs` (217 → 229 at the rebase onto PR 226). Each was applied by hand and turned its own test red.

**Still unverified.** Nothing here has run in Electron or against production. Open:

- Dates are formatted with `Intl` in the firm's zone, but only in Node and Chromium, not on a real Mac.
- **Email routes still cannot become usable.** An email step to a contact whose only address is `candidate` will hold `route_candidate` once sending opens. A validator is the route policy's work and is owed before about 1 October.
- Enrolment is from the Firm page only; Today has no enrol control.
- The reply page's resolve is covered by the API, unit and Playwright tests, but not by a release check.

### 8.1 Still unverified

Production was applied, deployed, bootstrapped and smoked at `66203322`, and redeployed at `02da3dd5` between 05:50Z and 05:57Z on 24 September, which carries the sign-in fix (8.0v). The signed desktop build is published at `66203322` (8.0t), and thirteen rehearsal runs have existed (8.0s, 8.0t, 8.0v, 8.0w). The first real sign-in was attempted against the `66203322` deployment and refused by the API's own discovery rule (8.0u); the retry against the g45 fix succeeded at 15:08Z, and showed that desktop 1.0.0 has no way to connect the mailbox (8.0x). Desktop 1.0.1 connected the first mailbox at about 18:10Z on 24 September. From 18:11Z CloudWatch refused every worker metric publication over one unit, and ECS replaced the worker every few minutes for failed health checks. That blackout lasts until the g51 fix is deployed (8.0y). What follows is what that still does not settle. Items 1 to 10 were written before any of it ran, and each carries whatever a later run answered; items 11 to 18 are what is open on 24 September, and the first of them is the release record this release does not have.

1. Whether `resourcegroupstaggingapi get-resources` is readable by the rehearsal role. `rehearsal-prefix-guard.sh` uses it to compare the production inventory before and after; if the role cannot read production at all, the scenario still passes — "could not address" is the claim — but the script will need the read moved to a separate inventory role to produce a useful diff. Two things about that read changed in G12f and neither could be tested against AWS: the tag filter is now `Key=Name` with no value, because `get-resources` matches tag values exactly and `Values=fss-prod*` would have matched nothing and made the comparison a comparison of two empty lists; and the production names are selected and **sorted** locally, because the API promises no order and an unstable one would fail the comparison for no reason. If the account holds many `Name`-tagged resources, this read is now larger than it was. **Answered by use:** the read works. The seventh run's guard (8.0o) and the twelfth's (8.0v) both compared real production inventories. The twelfth also showed that the read lists ECS tasks, which carry their service's propagated tags and which ECS forgets about an hour after they stop. Its guard failed on twelve of them aging out while production stood still, and the comparison now sets task ARNs aside on both sides and compares every durable resource, task-definition revisions included (8.0v, lane g47). **Verified on the thirteenth run (8.0w):** the guard set aside three task ARNs on each side and passed. **Found on 24 September at `fb7686a2` (run 36032732128, prefix `fss-rh-202609241713`, 17:13Z to 18:29Z): the read lists task network interfaces too.** *Nothing with the production prefix was touched* failed with exactly one changed line, `arn:aws:ec2:us-east-1:326255650484:network-interface/eni-0d67…` before and `…/eni-0e2f…` after. ECS had replaced the production worker task during the run: the worker's liveness check fails while its metrics loop is broken, so ECS was restarting the task about every five minutes, which is a separate incident (8.0y). A Fargate task gets its own elastic network interface when it starts and loses it when it stops, and the interface carries the task's propagated tags, so the tagging API lists it. It is as ephemeral as the task and is not a production touch. **Fixed in lane g52:** `durable_inventory` also sets aside every ARN whose service is `ec2` and whose resource part begins `network-interface/`, parsed the same way as the task rule, and logs `N ECS task ARN(s), M network interface ARN(s) set aside` for each side. The VPC, the subnets, the security groups, the route tables and the internet gateway are `ec2` ARNs too and are still compared. `test/release/scenario39.check.ts` runs the guard against this run's shape and against an interface that only vanishes or only appears (pass), and against each of those five network resources replaced while the interfaces churn beside it (fail, naming the resource). Two new mutations in `scripts/releaseMutationCheck.mjs` must be killed: interfaces compared again, and a filter that matches any `ec2` ARN. What this gives up is the same as for tasks: an interface created in production during the run is not compared, and a launch into production from a rehearsal is refused per launch instead (G12h).
2. Whether the drill can run at all: **nothing in this repository builds an `fss` executable.** No package declares a `bin`, and no step of the release workflow installs one, so every non-dry `fss admin …` in `rehearsal-restore-drill.sh` and every `fss carry export` in `rehearsal-carry-watermark.sh` would fail with `command not found`. Both scripts now refuse up front and say so, rather than discovering it after a restored RDS instance exists — but the CLI itself is another lane's, and the drill cannot pass until it lands. **Answered, 23 and 24 September: nothing puts an `fss` on PATH and nothing needs to.** No package declares a `bin` and that is now deliberate — every `fss` invocation is a command override of the worker image on a task definition inside the VPC, launched through `release_run_task`: the deploy's five one-off tasks, the workspace bootstrap, the drill's `fss admin counts`, the drill-evidence seeder and `fss drill` itself all ran that way in the cloud (8.0n to 8.0s). What is still open about the drill is steps 1 to 3, which is item 12.
3. Whether `--restore-time "$RESTORE_TARGET"` is acceptable to RDS. The drill defaults the target to *now*, and RDS refuses a restore time later than `LatestRestorableTime`, which trails the present by several minutes. The likely fix is `--use-latest-restorable-time` when no explicit target was given, but that changes which instant the baseline counts are `--as-of`, so it is not a change to make blind. Expect `InvalidRestoreTime` on the first run that reaches Appendix E step 1.
4. Whether the rehearsal environment publishes a `CanaryCompletionAgeSeconds` datapoint before the smoke step asks for one. **Answered, on 23 September: it did not, and the cause was that no workspace existed** (8.0p). The canary is inserted once per workspace, and the run now bootstraps one between steps 17 and 18; what is still unmeasured is how long the first datapoint takes after that — the scheduler's 60-second pass and the metrics publisher's 60-second pass say about two minutes, and the smoke step waits ten and then fails naming the cause rather than passing the literal `None` through to `Number()` and reporting `age=Nones`.
5. That `resourcegroupstaggingapi` is regional. The inventory only ever sees `us-east-1`, which is where everything is — but a production resource created in another region is outside the comparison and always will be.
6. Whether the worker task role can write the suppression journal. **Closed by G12b in the plan, unproved in the cloud.** `infra/modules/cluster` now gives the worker `s3:PutObject` on the journal object prefix and `kms:Encrypt`/`kms:GenerateDataKey` on the journal key, and `infra/modules/journal` names both task roles as permitted writers rather than the API alone — so the bucket policy's `DenyWritesFromAnyoneButTheTaskRoles` no longer refuses the worker. Neither role asks for any `s3:Delete*`, and no writer sets a per-object retention: the bucket's own default retention locks every object on put, and `s3:PutObjectRetention` stays denied to everybody. `infra/modules/cluster/tests/services.tftest.hcl` asserts both halves offline. What a plan cannot prove is that the first real opt-out the worker imports actually lands in the bucket; watch the `SuppressionJournalWriteFailures` metric after Gmail sync is first enabled, because a remaining IAM refusal surfaces there and nowhere else.
7. Whether one day of GOVERNANCE retention is long enough that `--bypass-governance-retention` is only ever needed for a same-day teardown.
8. How long the whole rehearsal takes. The workflow's timeout is 180 minutes, which is a guess dominated by the Multi-AZ restore in Appendix E step 1. The rehearsal database is now `db.t4g.small` and Multi-AZ, like production's (`docs/decisions/g12c-the-topology-answers-are-root-defaults.md`), so that guess is at last a guess about the right operation — and it is the first thing to measure.
9. Whether `fss-rh-deploy` can read the RDS-managed master secret the database URL is assembled from. The secret is named `rds!db-<id>` by RDS and does not carry the `fss-rh-` prefix, so `ReadTheRdsManagedMasterSecretOfThisNamespacesInstance` allows `DescribeSecret` and `GetSecretValue` on `rds!db-*` under `aws:ResourceTag/aws:rds:primaryDBInstanceArn` matching this namespace's instance ARNs (the global key since 8.0g; the service-specific one was refused by the simulator). **Creating** it is proved necessary and is now allowed (8.0f); **reading** it has never run against the service. The check simulates `DescribeSecret` under that key. Runbook 6.5 has the detail; symptom is an `AccessDenied` at "Assemble the rehearsal database URL" and no connection string.
10. Whether the first real rehearsal takes the skip branch of the carry drill, as it should before the cutover, and whether the release record reading `"carryDrill": "skipped_no_watermark"` is legible enough at enable time. Both branches run offline on every pull request; neither has run against AWS.
11. **A release record.** There is none. Every stage has passed at some commit — create, deploy, the bootstrap, the schema ranges, the smoke, the release suite, the drill's evidence — and the final `full` run at `66203322` (35948178549) ended at the drill step, though not for the reason 8.0s predicted: its credential expired at exactly one hour, inside `aws rds wait db-instance-available`, before the drill could reach the open steps of item 12 (8.0t). The twelfth, at `02da3dd5` (35962272085), renewed its session, passed everything before the drill again, completed the drill's point-in-time restore and stopped at the drill's first task against the restored instance, refused by the run-task wrapper's host check. Its production guard then failed on twelve ECS tasks aging out, a false positive now fixed (8.0v). The thirteenth, at `226d50b4` (35976297919), passed every step but the drill, the teardown and the production guard included. Its drill task started against the restored instance and stopped at its first write, a step-0 baseline file in a directory nothing creates (8.0w). Only a `full` run that passes every step writes a record, so the `releaseGateReference` section 6 step 2 reads before sending can be enabled does not exist yet. It will come from the post-release run that passes the drill. **Answered, 25 September.** Run 36100448302 at `b0f46711` (api `fe8fdb13…`, worker `a38cfa22…`, desktop stamp `6376c659`) passed every step, the drill included, and step 33 wrote the first record: `releaseGateReference` **`fss-rh-202609250554-2026-09-25T07:20:44Z`**, suite `pass`, `carryDrill: skipped_no_watermark`, `enablesSending: false`. It is the reference section 6 step 2 reads. Kept outside GitHub's artifact retention in the coordinator's `.context/release-records/`.
12. **The restore drill past its baseline — open, and post-release item 1.** The baseline exists; steps 1 to 3 do not run, for the five reasons 8.0s lists: no dialable subject, no suppression the restore loses, no fence left in `dispatching` or `reconciling`, no mailbox whose recorded envelope key the drill task can unwrap, and an `--at-failure` file nothing writes. Each of them refuses with its own reason rather than passing vacuously, which is why recording them is honest and relaxing an assertion would not be. David chose on 24 September to record them and ship the release path — his option 2, restated after the eleventh run's expiry (8.0t) and unchanged by it — so the drill stays **open** and stays post-release item 1; the drill's Step 1 point-in-time restore is the one part of it the eleventh run did issue, and it was the wait rather than the restore that died. **The twelfth run (8.0v) completed that restore:** `fss-rh-202609240558-pg-restored` was available in about twelve minutes, with its instants logged. It then stopped one step later, when the run-task wrapper refused the drill's one in-VPC task because the restored endpoint travelled as `--database-host` as well as the override. **That first item of the deferred drill work is fixed in code** (lane g48, PR 189): `--database-host` stays the primary host the drill task definition names, and the restored endpoint travels only as the `FSS_DATABASE_HOST` override. **The thirteenth run (8.0w) proved it.** The drill task started against `fss-rh-202609240838-pg-restored` for the first time, and exited 21 after about 25 seconds with `ENOENT: no such file or directory, open '/tmp/fss-drill/step0-baseline.json'`. That makes the **next item** the baseline handoff. The drill is launched with `--as-of` and not `--baseline`, so the baseline the runner measured on the source stays in the runner's `.rehearsal-reports/` and nothing hands it to the drill task. The drill measures step 0 again instead and writes it into `/tmp/fss-drill`, which nothing in the container creates. The baseline has to reach the drill task, as an argument or environment value in the task override or as an object the drill task can read, and the drill needs a reports directory that exists before its first write. **Lane g53 fixed both in code:** the baseline travels as `fss drill --baseline-json '<json>'` in the task override, and the drill creates its reports directory itself (8.0w). The next `full` run is the one that proves it. The five reasons above come after that. The run that closes this item is also the run that writes item 11's record. **Lane g56** opens the restore holds step 1 found missing (8.0aa). **Lane g59 closes four of the five reasons in code, unproved in the cloud, and leaves one open.** Closed: a late prospect opt-out, written and journalled once the restore has been requested, is the suppression the restore loses (step 2) and the inbox message it recovers (step 4); a send left `reconciling` just before the target, with the Sent folder handed to the drill, is step 3's fence; the recorded seam wraps with the environment's KMS envelope key under its own encryption context, and the drill role may decrypt it outside production; and the runner writes the at-failure counts, which step 8 reports and step 9 refuses to advance below. **The dial subject, closed in code by lane g60 (8.0ab).** A salesperson now registers and attests their own calling number, and the `before` phase does that for the rehearsal admin through the same domain functions. The probe has a subject. Step 1 now also requires the restore hold among the holds that apply to the refused dial, because a rehearsal's probe is refused `posture_missing` either way. The next `full` run should pass step 1 with `unanswered: []`. A database with no attested number still leaves the step unanswered and fails the run. The lane also fixed four faults it found on the way: a restore recovery reused the mailbox generation whose recovery was already complete and reprocessed nothing, in production too; an opt-out's suppression command id was its row id, which a restore changes; step 9 counted the other holds before step 1 rather than before the advance; and step 9 was never handed an admin. Two gaps remain behind it. Step 3 inserts no tombstone for a send whose fence the restored copy never had (Appendix E.3's "missing fences"), so the `after` phase's send is lost without a trace in the report (closed in code by lane g73, 8.0ah; unproved in the cloud). And the API's recorded mode still wraps with a per-process key, which nothing in the drill reaches. **Closed, 25 September, by run 36100448302 at `b0f46711`.** The drill ran Appendix E steps 1 to 9 against `fss-rh-202609250554-pg-restored` with `ok: true`, fifteen checks passed and `unanswered: []`: 1a opened the restore hold, 1 refused the dial with the attested number and the hold among its reasons, 2 replayed the journal (5 read, 2 inserted, 3 already present) and again, 3 reconciled the Sent folder, 4 recovered the inbox, 5 discarded the jobs and ran the scheduler once, 6 renewed the watch and measured coverage, 7 migrated, 8 wrote the restore report, and 9 advanced the generation to 2 and reconciled it. The two gaps named above (E.3 missing fences, closed in code by lane g73 in 8.0ah and to be proved by the next `full` run; the API's recorded-mode key) stay open as tidy items, not as drill failures. The weekly scheduled run keeps proving this.
13. **The signed desktop build — answered, 24 September.** Run 35935100994 never got past importing the Developer ID certificate (8.0s) and the second build was refused at notarization for a team id that did not belong to the Apple ID; the **third**, run 35951921111, signed, notarized, stapled and published Callie 1.0.0 from commit `66203322` to the update channel at 03:37Z, manifest signed and zip `sha256` verified from outside the build (8.0t). What that still does not settle is the far end of it: nobody has installed the published artifact on a Mac, or taken an automatic update from the channel, so Gatekeeper's verdict on a real download and the updater's behaviour against a signed manifest are both unmeasured.
14. **The first sign-in, and the Gmail consent — sign-in verified at 15:08Z on 24 September; the first mailbox connected from desktop 1.0.1 at about 18:10Z, and the two alarms cannot clear until the g51 fix is deployed (8.0y).** The first real sign-in, `callie@usecallie.com` on desktop 1.0.0, was refused `token_exchange_failed` four times between 03:43Z and 04:09Z, because `discovery()` refused Google's own discovery document for naming its token endpoint and key set on `googleapis.com` hosts (8.0u). Lane g45's fix went live in production at `02da3dd5` from 05:56Z (8.0v), and David's retry at **15:08Z** signed in: the main window reached **Today** with the "This Mac" card showing Role `admin`, so the membership 5.1a bootstrapped is the one the session carries (8.0x). The audit row `auth.provisional_user_adopted` and the absence of both warn lines, which 5.2a also asks for, are not recorded here. **The Gmail consent has not run, because desktop 1.0.0 has no control that starts it** (8.0x). Lane g50 adds the Mailbox row with Connect Gmail to the "This Mac" card and raises the API's published client maximum to 1.0.1. The API has to be redeployed from that commit **before** desktop 1.0.1 is published (`docs/greenfield/install.md`, "4 — publish 1.0.1"), because an API whose maximum is 1.0.0 refuses a 1.0.1 client everything. The Gmail grant's token exchange uses Google's real hosts and no discovery rule, and `apps/api/test/gmailGoogle.test.ts` now holds that (8.0x). This item closes when the "This Mac" card reads `callie@usecallie.com · connected · baseline pending`, `/gmail/status` agrees, and `fss-prod-mailbox-heartbeat-missed` and `fss-prod-gmail-watch-expiring` clear. A refused callback shows only as a `refusal` line with status 400, 403 or 409 for `/oauth/gmail/callback`, and 8.0x says what each one means. **The connection ran between 18:00Z and 18:11Z on 24 September** and the worker inserted the mailbox's first jobs at 18:11:37Z. The card and `/gmail/status` readings are not recorded here. Both alarms read metrics the worker could not publish from 18:11Z (8.0y), so neither can clear before item 18.
15. **Sending.** `FSS_SENDING_ENABLED` is `false` and section 6 has not been run, so nothing has been sent from production. 12.7's authentication checks, the six-week ramp, and the journal's first real write — item 6 above, which surfaces only as `SuppressionJournalWriteFailures` — are all unproved in production.
16. **The exact rehearsal deployment policy, put back.** `fss-rh-deploy` still carries the discovery document of 8.0h: a wide allow on the services the tree uses, with guards, for one pass of `create`, `deploy` and `full`. The exact policy derived from the CloudTrail record of that pass is put back only after the final run above has passed (`infra-apply-runbook.md` 1.1b, step 5), and until then no rehearsal run proves anything about the policy this release ships. `fss-prod-deploy` was never widened and the renderer refuses to widen it.
17. **A `full` run that outlasts its credentials, end to end.** The run is longer than the one-hour session the job used to hold, and 8.0t is what that cost: an expired token inside the drill's RDS waiter, a teardown and a production-prefix guard that both failed at their first call, and a leaked environment removed by a separate `stage=teardown` dispatch. The workflow now renews the session before the drill and again — on `always()` — before the teardown, each renewal followed by the identity assertion. **Answered, 24 September (8.0v):** run 35962272085, well past an hour, renewed twice, and both renewed sessions passed `rehearsal-caller-identity.sh`. The teardown then ran cleanly on the second, the first clean teardown of a `full` run since the run grew past an hour. The guard reached its comparison on the same session, and its red was the ECS-task false positive fixed in lane g47, not an authentication failure. **Verified again on the thirteenth run (8.0w):** both renewals and both identity assertions passed, the teardown passed at 09:57Z, and the production guard passed on the same session. The belt-and-braces follow-up — `MaxSessionDuration` 7200 on `fss-rh-deploy` and `role-duration-seconds: 7200` in the workflow — is not done and is deliberately separate: the role lives outside this repository.
18. **The worker metrics, back after the first mailbox.** From 18:11Z on 24 September every `PutMetricData` from `fss-prod-worker` was rejected, because `GmailWatchHoursToExpiry` carried the unit `Hours`. The failing metrics loop removed the liveness file, and ECS stopped the task at 18:15Z and every replacement after it (8.0y). Lane g51 publishes the hour gauges as `None`, refuses a unit outside the CloudWatch set before sending, publishes the rest when one datum is refused, and takes the metrics loop out of liveness. It is not deployed yet. This item closes when the worker from that commit is running, logs no `worker_loop_failed` for `metrics` and no `metric_rejected`, and has published `WorkerHeartbeat` and `GmailWatchHoursToExpiry` again, and its task is no longer being replaced.
