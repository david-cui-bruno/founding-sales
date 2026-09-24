# FSS release: what David does, what CI does, and in what order

**Lane:** G12 · **Spec:** 16.2, Appendix E, Appendix G · **Audience:** the operator running the first release. Assume you have never applied this stack.

`docs/greenfield/infra-apply-runbook.md` is how the infrastructure comes into existence. This document is how a **release** happens on top of it: which steps are yours, which are the workflow's, and why the order cannot be rearranged.

Read section 1 before doing anything in section 3. Two steps in it take days of waiting (DNS authentication for sending, and an SNS confirmation click that is easy to forget), and one of them — the `fss-rh-deploy` bypass-governance grant — is the difference between a rehearsal you can tear down today and one that leaves a bucket behind for a day.

> **The one sentence the whole document serves.** Specification 16.2: *"Production sending remains disabled until all mandatory scenarios for the affected release class pass, the deployed commit/image digests match the rehearsal artifacts, and an authenticated admin enables sending."* Nothing below turns sending on. The last step of the last section does, and only you can do it.

---

## 0. Who does what

| Step | Who | Why it cannot be the other one |
|---|---|---|
| Build the images | CI (`greenfield-images.yml`) | Reproducible, and it proves the production dependency set loads. |
| **Push the images to ECR** | **David** | No AWS credential exists in this repository and none is wanted. `--push` prints the digest; that digest is the release's identity. |
| **Apply the rehearsal registry — once, ever, before the first push** | **CI (`greenfield-rehearsal-registry.yml`), dispatched by David twice: plan, then apply** | Same reason as the row below: `fss-rh-deploy` is assumable only from the `rehearsal` environment. `infra-apply-runbook.md` 2.1. |
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
| `FSS_GMAIL_PUSH_TOPIC` | the production root's `module.pubsub` topic, the same string `terraform output gmail_push_topic_id` prints |
| `FSS_GOOGLE_HOSTED_DOMAIN` | the `google_hosted_domain` root variable, `usecallie.com` |

You set neither by hand; the apply does. The bootstraps still read `push_topic` and `hosted_domain` out of the secret JSON **if the environment does not carry them**, so a deployment written against the older shape still starts — for one release. `docs/decisions/g12b-two-public-identifiers-move-out-of-the-secret.md` says when that fallback goes and what has to be true first. The startup line reports which source each came from (`push_topic_source`, `hosted_domain_source`), so you can confirm the move landed without reading a task definition.

When neither source has one, the process refuses to start and names **both** places it looked.

### 1.7 Google application-default credentials, on your Mac

`infra/roots/production` is the only root that declares `provider "google"`, and Terraform configures every provider a configuration requires before it evaluates anything. So a **production** plan or apply needs a working Google credential even when `enable_gmail_push` is false, and without one it stops at provider configuration with "Attempted to load application default credentials … No credentials loaded."

Once per machine, as the account that administers `callie-fss`:

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project callie-fss
```

`docs/greenfield/infra-apply-runbook.md` **1.3a** has the full procedure: enabling the Pub/Sub API, the two checks that the credential exists and can mint a token without printing any part of it, and why a downloaded service-account key file is refused by name rather than merely discouraged.

Nothing in the **rehearsal** needs this. The rehearsal root declares no Google provider and creates nothing in Google Cloud, which is why a CI run has no Google credential and must not be given one (`docs/decisions/g12j-the-rehearsal-has-no-google-provider.md`).

---

## 2. Build and push the images — David, from his Mac

CI never pushes. `greenfield-images.yml` builds both `linux/arm64` images on every relevant change and prints their digests; what it cannot do is put them in ECR.

### 2.0 The order, and why the desktop build is last

Everything in this document hangs on one string: the commit you are releasing. Fix it before anything else, because four separate things have to agree about it.

```bash
git rev-parse HEAD     # this is the release commit, and the desktop commit stamp
```

The desktop commit stamp **is that value**. It is not something a build produces and a person then copies: the signed Electron bundle carries it because it was built from that commit, and `rehearsal-release-record.sh` records it because you typed it. So the order is:

| # | Step | Who | Why it is here and not earlier |
|---|---|---|---|
| 1 | Fix the release commit; push both images tagged with it (2.1 below) | David | The digests are the release's identity. |
| 2 | Run the rehearsal with `desktop_commit_stamp` = the release commit (section 3) | CI | The record can name the commit before any Mac build exists, because the stamp is the commit. |
| 3 | Apply production Terraform (section 4) | David | This is what creates the CloudFront distribution the Mac updates from. |
| 4 | Set the repository variable `FSS_UPDATE_CHANNEL_URL` to `terraform output -raw` of `updates_distribution_domain_name`, as `https://<host>/` | David | It does not exist until step 3, and GitHub will not hold an empty variable. |
| 5 | Run *Greenfield desktop* with **release** ticked, on the release commit, passing the same commit as `desktop_commit_stamp` | CI | It refuses without step 4, because a build with no channel installs once and never updates. |
| 6 | Download the artifact, publish it, install it (`docs/greenfield/install.md`) | David | The one step that changes what every Mac sees. |

**Why the desktop build is last rather than first.** The obvious order — build the Mac app, take its stamp, feed it to the rehearsal — cannot run: the release job needs `FSS_UPDATE_CHANNEL_URL`, which needs the production apply, which comes after the rehearsal that was supposed to be waiting for the build. Making the stamp a fact about the commit rather than an output of a build breaks that circle and removes a copied string. `docs/decisions/g13b-the-stamp-is-known-before-the-build.md` has the reasoning; `docs/decisions/g13b-an-absent-channel-url-is-a-refusal.md` has why step 4 is a refusal rather than a default.

**What checks the agreement.** The desktop workflow refuses a `desktop_commit_stamp` that is not the commit the run is on, before it builds; and after it builds it compares the commit in the signed manifest — which is read out of the stamp inside the asar, inside the code signature — with both. At enable time (section 6) you compare the release record's `artifacts.desktopCommitStamp` with the commit the run summary printed. They are the same forty characters or sending does not get enabled.

**The first release, today.** Eight of the nine desktop signing secrets are not set and this Mac holds only an Apple Development identity, so the release job fails closed at its first step and names them. That is the intended state. `docs/greenfield/install.md` lists every one.

### 2.1 The images

From a checkout of the **exact commit** you intend to release:

```bash
export REGION=us-east-1 ACCOUNT=326255650484 GIT_SHA=$(git rev-parse HEAD)
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

docker buildx build --platform linux/arm64 --file Dockerfile.api \
  --build-arg "GIT_REVISION=$GIT_SHA" \
  --tag "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/fss-prod-api:$GIT_SHA" --push .
docker buildx build --platform linux/arm64 --file Dockerfile.worker \
  --build-arg "GIT_REVISION=$GIT_SHA" \
  --tag "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/fss-prod-worker:$GIT_SHA" --push .
```

`--push` prints the manifest digest for each. **Write both down.** They look like `sha256:` followed by 64 hex characters, and they — not the tags — are what everything downstream compares. `infra/modules/cluster` refuses a mutable tag by variable validation, and `rehearsal-release-record.sh` refuses one too.

Push the same digests to the rehearsal repositories so the rehearsal deploys the exact artefacts production will:

```bash
docker tag "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/fss-prod-api:$GIT_SHA" \
           "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/fss-rh-api:$GIT_SHA"
docker push "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/fss-rh-api:$GIT_SHA"
# ... and the worker.
```

**Before the first release only:** those two repositories do not exist until the registry root has been applied, and that apply is not a command — `fss-rh-deploy` is assumable only from the `rehearsal` environment. Run Actions → **Greenfield rehearsal registry apply** with `apply` unticked, read the plan in the summary, then run it again with `apply` ticked. `infra-apply-runbook.md` 2.1 has the detail. Every later release skips this: it happens once, ever.

`fss-rh-api` and `fss-rh-worker` are **stable** repositories with no run in their names. They belong to `infra/roots/rehearsal-registry`, which is applied once (`infra-apply-runbook.md` 2.1) and never torn down; the per-run rehearsal root creates no repository at all. That is forced by this very step: you are pushing before the run exists, and the workflow's two repository secrets hold one value each. The rehearsal root refuses an image that does not come from those two repositories — `fss-rh-deploy` cannot read a production repository, so a plan-time refusal is better than an authorization error five minutes into a deployment.

The **desktop commit stamp** is the release commit from 2.0 — the same `git rev-parse HEAD` you have been using — and the release record names it. You do not wait for a Mac build to learn it.

---

## 3. The rehearsal — CI, started by David

Actions → *Greenfield release rehearsal* → Run workflow, with:

- `stage` — how far this run goes: `plan` (the default), `create`, `deploy`, `full`, or `teardown`. Only `full` is the release gate; read 3.0 before choosing anything else.
- `api_image_digest` — from the push above;
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
6. [deploy] **Migrate, then deploy the worker, then the API.** `infra/scripts/release-deploy.sh infra/roots/rehearsal <prefix> --schema-change` — the *same script* you run locally for production (section 4.1). It scales to zero if anything is running, runs `fss migrate` as a one-off ECS task inside the VPC, then `fss admin database-users ensure`, then `fss verify`, then the worker to its declared count, then the API, then `fss verify` again against the running deployment. Never beside each other: the API's declared schema range needs the migration to have run. Until 21 September nothing in deployment ran a migration at all; the step was named for an order it did not perform.

    [deploy] **Then the first workspace and its admin**, as its own step between this one and item 7: `infra/scripts/release-bootstrap-workspace.sh infra/roots/rehearsal <prefix> --worker-digest D --slug rehearsal --display-name Rehearsal --admin-email rehearsal-admin@usecallie.com`. A migrated database has no `workspaces` row, and the scheduler's canary is inserted once per workspace — so an environment without one publishes no `CanaryCompletionAgeSeconds`, the `canary_stale` alarm breaches, and item 8's smoke has nothing to judge. That is exactly how the eighth full run failed (8.0p). It is the same script production runs, with `--environment production` (5.1a) and different values.
7. [full] **The declared ranges, against the deployed images** (`infra/scripts/rehearsal-schema-ranges.sh <prefix> --api-digest D --worker-digest D`): Appendix G 22's refusal cases, which only a real ECS task can answer. Each service image is launched as a one-off `--selftest` task through the same wrapper the deploy uses, with a declared schema range one below the one it was built with, and the *container* must refuse it — exit 12, `configurationInvalid` in both `API_EXIT_CODES` and `WORKER_EXIT_CODES`. The overlap case, the previous release's image against the current schema, runs **only when a `<prefix>-<service>-previous` task definition is actually registered**: nothing in this repository registers one and a first release has no previous image at all, so the report says `skipped_no_previous` rather than claiming a pass (8.0o).
8. [deploy] **Smoke** with the same `scripts/productionSmoke.mjs` production gets.
9. [full] **Release suite (recorded mode, runner)**: the 42 scenarios (`npm run test:release`) and the **mutation check** (`npm run test:release:mutation`), which breaks each trap in turn and requires the suite to go red. They run in the runner against the job's own `postgres:16` service container, which is what they were built for. They do **not** touch the rehearsal database and could not: it is private — `publicly_accessible = false`, no NAT gateway, no bastion — so the step that used to assemble a URL from the rehearsal's outputs could never have connected. What runs against the rehearsal database is `fss verify` and `fss drill`, inside the VPC.
    [full] **Before it, the evidence the drill has to reconstruct** (lane g40), as its own step between item 6's bootstrap and item 7: `infra/scripts/release-seed-drill-evidence.sh infra/roots/rehearsal <prefix> --worker-digest D --phase before --workspace-slug rehearsal`. `docs/greenfield/restore-drill.md` 0.1 needs an accepted send, a prospect reply, a prospect-originated opt-out, a salesperson's own manual suppression inside its ten-minute window and an ordinary CRM edit to exist *before* the restore target is read, and nothing in this repository could produce any of them in a deployed environment — so the drill's own refusal fired on every fresh rehearsal, which is how the ninth full run ended (8.0q). `fss admin drill seed-evidence` produces all five through the domain's own entry points. The drill then adds `--phase after` between the baseline and the restore, so the restore genuinely loses work, and waits for RDS to report a `LatestRestorableTime` past the evidence before reading the target at all. **Production is never seeded**: the script refuses any prefix that is not `fss-rh-<run>` and the command refuses unless `FSS_DEPENDENCIES=recorded`.
10. [full] **Restore drill**, Appendix E steps 1 to 9, preceded by a session renewal and its identity check. The runner keeps the control plane (reading the latest restorable point, the restore itself, the wait, the teardown); two in-VPC tasks do the database work — `fss admin counts` for the baseline on the source, then one `fss drill` against the restored instance for steps 1 to 9, with one correlated log and per-step JSON. The runner reads the report and decides whether it is a pass, so a change to the tool cannot quietly relax the gate. It refuses to report a pass unless the baseline contained an accepted send, a reply, a suppression, a CRM edit and a migration — a drill against an empty database proves nothing. The drill task is fixed at `FSS_DEPENDENCIES=recorded` **in its task definition**, because `reconcile-sent`, `recover` and `watch-renew` all reach Gmail when it is live and a mode a caller passes is a mode a caller can forget.
11. [full] **Suppression journal replay and Gmail reconstruction**, against the recorded fake (no real mailbox in rehearsal unless you provide a rehearsal Google project). The second replay must insert nothing; no send may repeat. The drill above already ran both; this step reads the reports it left, which the drill wrote out of the captured task report under the names they have always had.
12. [full] **Carry watermark** (Appendix G 20): the carry tooling must contain no writer at all, and — once a cutover is scheduled and the two optional secrets exist — the export must refuse a table with a post-watermark write. Before the cutover the step prints `carry drill skipped: no cutover watermark yet` and the record says `"carryDrill": "skipped_no_watermark"`. That is not a pass being claimed; it is the state being named.
13. [every stage] **Tear down**, always, with bypass-governance — and tolerantly, on a session renewed immediately before it so that a run which has already outlived its first hour can still destroy what it made. The teardown is five steps (any one-off task still running, the restored instance, any manual snapshot carrying the run prefix, the object-locked journal objects, the root), and each treats the AWS error code for absence as "already done" rather than as a failure, because `if: always()` means it runs after a creation that never happened. A failure that is *not* an absence — an `AccessDenied`, a throttle — still stops it, and an unreadable state that is not "the root was never initialised" still stops it. The report says which: `destroyed=true`, or `destroyed=nothing_created`. `terraform destroy` requires every variable `apply` did, so the step that opens item 4 writes them to `run.auto.tfvars.json` beside the rehearsal root (identifiers only, ignored by `infra/.gitignore`) and the teardown refuses to destroy without that file rather than fail on a missing variable and leave the environment standing. To tear a run down by hand from a fresh checkout, recreate the file first: `name_prefix`, `api_image` and `worker_image` (`<repository>@<digest>`, from the release record or the run's inputs), `certificate_arn`, `api_hostname`, `assume_deployment_role: false`, `bootstrap: true`, and the two schema ranges read from `packages/domain/db/schemaRange.ts`; then run `rehearsal-teardown.sh <prefix>` from the root directory as the `fss-rh-deploy` session.
14. [every stage] **Assert nothing with the production prefix was touched**, always, including on a run that created nothing. The guard classifies every name it sees: the run's own resources, the two stable rehearsal repositories that carry no run, and anything production's — which it refuses. A state it cannot list is reported as "the run created nothing" rather than swallowed, and the inventory comparison still runs. An inventory recorded only by a dry run is refused rather than compared: the workflow records the sentinel `["dry-run: no production inventory was read"]` when it validates the prefix, and comparing production against that would be a pass nobody earned. The guard runs in dry mode on every pull request, so every branch is exercised without a credential.
15. [full] **Write the release record**, last. It names the two digests, the desktop stamp, and a `releaseGateReference` you will need in section 6.

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

**Never apply or deploy production while a rehearsal run is in progress.** Watch Actions first, and if a rehearsal is running either wait for it or cancel it — reading 3.0 on what a cancelled `create` leaves behind before you do. Every rehearsal run records the sorted ARNs of every `Name`-tagged production resource before it starts and compares them when it finishes, and an ECS task-definition ARN carries its revision number: a production apply or deploy in between changes that list, and the run fails its final guard reporting that the production inventory changed during the rehearsal. That guard is how Appendix G 39's last clause is measured rather than asserted, so the answer is never to weaken it. It is what tripped the seventh run's final guard (8.0s).

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
| `gcp_project_id` | `callie-fss` | The project that owns the Gmail push topic. |
| `alert_emails` | `["callie@usecallie.com"]` | Each address confirms once by hand (5.3 below). |

**The deployment environment variables this release adds.** Both task definitions need them, and all five are Terraform's — there is nothing to type at apply time unless you are changing one:

| Variable | Production value | Root variable |
|---|---|---|
| `FSS_DEPENDENCIES` | `live` | `dependencies_mode`, default `live` |
| `FSS_RESEARCH_PROVIDERS` | `none` (worker only) | `research_providers`, default `none` |
| `FSS_SENDING_ENABLED` | `false` until section 6 step 4 | `sending_enabled`, default `false` |
| `FSS_GMAIL_PUSH_TOPIC` | the Pub/Sub topic id | none; derived from the production root's `module.pubsub` (G12j moved it out of the stack; the rehearsal passes a placeholder) |
| `FSS_GOOGLE_HOSTED_DOMAIN` | `usecallie.com` | `google_hosted_domain` |

Until G12c none of the first three could be set at all: `extra_environment` existed on the stack module and no root exposed it, so an apply produced two services whose tasks exit at startup naming a variable no plan could set. `docs/decisions/g12c-the-deployment-flags-are-root-variables.md`.

`FSS_DEPENDENCIES` has no default **in the binary**: an unset one is a refusal to start, which is deliberate (`docs/decisions/g12-the-credentialed-bootstrap.md`); the root's default is what makes sure it is never unset. `dependencies_mode` refuses `none` outright and accepts `recorded`, which the binaries then refuse in a production environment — the rule lives in one place rather than two that can disagree. `FSS_RESEARCH_PROVIDERS=none` is a declaration that this build ships no live research adapter, not an accident. The last two need nothing from you; they are listed so that a startup line reporting `hosted_domain_source: "secret"` reads as "the apply has not landed yet" rather than as a mystery.

There is also `extra_environment` (`map(string)`, empty) on both roots, for whatever the next release needs before it earns a variable of its own. Never a credential: secrets reach a container only as a Secrets Manager reference, and the root test asserts no environment name looks like one.

**What the API refuses to start without.** A live API now builds Google sign-in or exits with `api_deployment_refused`. The parts are the `google-oidc-client` secret, `FSS_PUBLIC_ORIGIN` (the redirect is `https://api.usecallie.com/auth/google/callback`, derived rather than configured twice), `FSS_GOOGLE_HOSTED_DOMAIN`, and `session-signing-key`. `--selftest` prints `sign_in`, `sign_in_client_configured`, `sign_in_redirect_configured`, `sign_in_hosted_domain_configured` and `session_signing_key_configured` — names and booleans, never a value. Before G12b the API started without any of it and refused every command; see `docs/decisions/g12b-sign-in-is-configured-or-the-api-refuses.md`.

### 4.1 The order inside the apply, and the one command that performs it

```
all eight entries filled  →  fss migrate  →  database users  →  fss verify  →  worker  →  API  →  fss verify
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

**You do not type those steps.** They are one script, and it is the same script CI runs for the rehearsal — the only differences are the root in argument one and the credentials in your shell:

```bash
export AWS_PROFILE=<the profile that can assume fss-prod-deploy>
export FSS_REHEARSAL_REPORTS="$HOME/fss-release-$(date -u +%Y%m%d%H%M)"

infra/scripts/release-deploy.sh infra/roots/production fss-prod \
  --schema-change \
  --api-digest "$API_DIGEST" \
  --worker-digest "$WORKER_DIGEST"
```

Read it first, without a credential, exactly as CI's dry run does:

```bash
FSS_REHEARSAL_DRY_RUN=1 FSS_REHEARSAL_REPORTS=/tmp/fss-plan \
  infra/scripts/release-deploy.sh infra/roots/production fss-prod \
    --schema-change --worker-digest "$WORKER_DIGEST"
```

Why a script rather than four commands you can see:

- **The migration is a one-off ECS task, not something you can run.** The production database is private: `publicly_accessible = false`, no NAT gateway, no bastion. Nothing on your Mac has a route to it and nothing should. The only thing already inside the VPC that can reach PostgreSQL is the worker image, so `fss migrate` runs as a task using it, under a task role that exists for nothing else.
- **Every launch is checked before it is made.** `infra/scripts/release-common.sh` refuses a bare cluster name, a wrong account, a wrong region, a cluster tagged as the other environment, a task definition whose image is not the digest this release is about, a network configuration that is not the root's own public subnets under the worker security group, and a task definition resolving a credential entry this release did not name. Afterwards it reads the `failures` array, refuses a task that never started, refuses a stopped task with no exit code (which is not a zero), prints `stopCode` and `stoppedReason`, waits out the log-stream race, and records the task ARN so a retry waits on the task that is already running rather than starting a second migration.
- **The declared counts come from the plan.** The script scales the services to `terraform output deployment_plan`'s `declared_desired_count`, not to a number in a shell file that somebody has to keep in step with the root.

`--schema-change` is the flag that makes it stop the services first. Leave it off for a release that moves no migration; the migration task still runs, finds nothing to apply, and says so.

**The policy, and it is not negotiable.**

- **Stop-during-migration.** From migration 0006 onwards every declared range is a strict `{N,N}`, so there is no build of this software that straddles a schema change and no honest way to migrate without an outage. The script scales the API to zero first — so no request reaches a schema that is about to move — then the worker, which is given time to release its job leases.
- **The database never rolls back.** There is no down migration in this repository and there will not be one. `packages/domain/db/migrations` is forward-only and `loadMigrations` refuses a gap.
- **After a successful migration and a failed deployment there are exactly two paths.** *Forward repair*: fix the code, build a new digest, deploy it. Or *the restore protocol*: `docs/greenfield/restore-drill.md`, all nine steps, with sending and dialing held until step 9. Redeploying the previous digests is only a rollback when their declared ranges accept the current schema version, which after a migration they usually do not — `infra/scripts/rehearsal-schema-ranges.sh` computed that during the rehearsal and told you. What is never a path is undoing the schema.

---

## 5. The five manual steps after the apply

These are in the order they unblock each other. Doing 5.3 before 5.2 will not work, because Pub/Sub will not push to an endpoint whose certificate it cannot verify. 5.1 comes before the apply's deploy (4.1) and 5.1a comes after it, because 5.1a runs a command against the deployed database.

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
  --slug callie --display-name Callie --admin-email callie@usecallie.com
```

It launches `fss admin workspace bootstrap` as a one-off task on the **operations** task definition, inside the VPC, under the runtime credential — the same wrapper, the same digest comparison and the same log-stream read as every other one-off task in 4.1. `--environment production` is required and is the only argument that differs from the rehearsal's: this command writes the first business rows of the environment, and production is named out loud or not at all.

It prints the tool's JSON report and writes a summary line into the reports directory as `bootstrap-workspace.txt`:

```json
{
  "workspace": { "id": "…-…-…-…-…", "slug": "callie", "displayName": "Callie",
                 "businessTimeZone": "America/New_York", "outcome": "created" },
  "admin": { "userId": "…", "email": "callie@usecallie.com", "outcome": "provisional_created" },
  "membership": { "role": "admin", "outcome": "created" }
}
```

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

### 5.4 The Gmail push grant

```bash
terraform output gmail_push_topic_id   # projects/callie-fss/topics/fss-prod-gmail-push
terraform output gmail_push_audience   # https://api.usecallie.com/integrations/gmail/push
```

Both are in the task environment already (`FSS_GMAIL_PUSH_TOPIC`, `FSS_GMAIL_PUSH_AUDIENCE`); the outputs are here so you can read what the apply decided. Confirm it reached the containers rather than assuming it — the API's startup line says `push_topic_source: "environment"` once it has.

Then connect the mailbox from the Mac client: it opens the Google consent screen in the system browser, you grant `gmail.readonly` and `gmail.send`, and the callback lands on `https://api.usecallie.com/oauth/gmail/callback`. The API validates the exact audience and the exact service-account email on every push; a token with a valid Google signature and the wrong audience is refused (Appendix G 27).

---

## 6. Enabling sending — the only step that turns anything on

Do not reach this section until every one of these is true. Each is a different fact and each is checked by a different thing.

**1. The smoke checks pass.**

```bash
AGE=$(aws cloudwatch get-metric-statistics --namespace FSS \
  --metric-name CanaryCompletionAgeSeconds --statistics Maximum \
  --start-time "$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --period 300 \
  --query 'reverse(sort_by(Datapoints,&Timestamp))[0].Maximum' --output text)

NODE_OPTIONS="--experimental-transform-types --disable-warning=ExperimentalWarning" \
  node scripts/productionSmoke.mjs --origin https://api.usecallie.com --canary-age-seconds "$AGE"
```

Six lines, all `PASS`. The sixth reads `PASS sending_disabled (sendingEnabled=false)` — its expected answer is that sending is **off**, which is what makes it meaningful at this point.

**What the canary line measures.** `CanaryCompletionAgeSeconds` is the newest canary run's **scheduler-to-worker latency** — the gap between the scheduler inserting the run and the worker completing it, and `now() - inserted_at` while it is still uncompleted, worst over the newest run of each workspace (`packages/domain/jobs/canary.ts`). It is not the time since the last completion: the canary is inserted once per quarter hour, so that reading sawtooths to 900 on a healthy system and fails this 300-second check for about ten minutes in every fifteen, which is what the first production smoke did (8.0r). A healthy system reads a few seconds here at any moment; a worker that has stopped pushes it past 300 within five minutes, which is the same fact `fss-prod-canary-stale` alarms on.

**2. The digests match.** The release record names two digests. Compare them with what production is actually running:

```bash
aws ecs describe-task-definition --task-definition fss-prod-api \
  --query 'taskDefinition.containerDefinitions[0].image' --output text
aws ecs describe-task-definition --task-definition fss-prod-worker \
  --query 'taskDefinition.containerDefinitions[0].image' --output text
```

This comparison is deliberately yours rather than the workflow's. It is the moment a person takes responsibility for the claim that the thing rehearsed is the thing deployed.

**3. The sending domain passes authentication.** 12.7, and the database enforces it: `sending_domains.automated_sending_enabled` cannot be true without SPF, DKIM, DMARC and a recorded Postmaster review. Set it from the admin surface (`/outbound/authentication`). If it refuses, a check is missing — fix the DNS, not the constraint.

**4. Flip the deployment flag.** `terraform apply -var="sending_enabled=true"` in the production root, then re-deploy (worker, then API). That puts `FSS_SENDING_ENABLED=true` on both task definitions; read the plan first, and expect it to change exactly the two task definitions and nothing else. This is the release process's statement that the gate passed on these digests.

**5. Write the attestation, as an authenticated admin.** From the settings page, or:

```
POST /settings/update
{ "settingKey": "sending_enabled",
  "value": { "enabled": true, "releaseGateReference": "<from the release record>" },
  "changeNote": "rehearsal <reference> passed; digests match production" }
```

The command refuses a non-admin caller and refuses an enable that names no release gate: "an admin clicked yes" is not the gate.

Only when **4 and 5 and 3** are all true does an automated email leave FSS. `packages/domain/outbound/gate.ts` reads all three before every dispatch and refuses `workspace_sending_not_attested` or `automated_sending_disabled` when any is false, naming which half said no.

**What enabling sending commits you to.** A mailbox that has sent automated mail in the last thirty days is not disconnected and its Google authorization is not revoked, so that a late reply-based "stop" is still received and honoured (12.6's reply-only opt-out). This is the workspace's own operating rule, not a guard the software enforces yet; see `docs/greenfield/mail.md`, "Mailbox lifecycle: the thirty-day rule".

### 6.1 Turning it off

Withdraw either half. The attestation (`enabled: false`) stops it immediately and is a versioned change with a reason; the deployment flag stops it at the next deployment. Neither cancels a fence that has already entered `dispatching` — that message may have gone, and Appendix B is how it settles.

---

## 7. If the release has to be undone

4.2: "Earlier compatible binaries on the same database, or database restore under the post-restore protocol; the old stack is never a rollback target."

**Preferred.** Deploy the previous image digests, if and only if their declared schema ranges accept the current schema version. Read them from the previous release's checkout; where the ranges do not overlap there is nothing to roll back to, and the honest answer is forward repair. This is exactly what `infra/scripts/rehearsal-schema-ranges.sh` computes, and it will have told you during the rehearsal.

**If the data is wrong rather than the code.** `docs/greenfield/restore-drill.md`, all nine steps, in production, with sending and dialing held until step 9. There is no faster version.

**Never.** The old stack. It is read-only after the cutover watermark and the carry tooling contains no writer at all (Appendix G 20).

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
with no dimension would still be ambiguous inside a single account.

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

### 8.1 Still unverified

Production is applied, deployed, bootstrapped and smoked at `66203322`, the signed desktop build is published at the same commit (8.0t), and eleven rehearsal runs have existed (8.0s, 8.0t). What follows is what that still does not settle. Items 1 to 10 were written before any of it ran, and each carries whatever a later run answered; items 11 to 17 are what is open on 24 September, and the first of them is the release record this release does not have.

1. Whether `resourcegroupstaggingapi get-resources` is readable by the rehearsal role. `rehearsal-prefix-guard.sh` uses it to compare the production inventory before and after; if the role cannot read production at all, the scenario still passes — "could not address" is the claim — but the script will need the read moved to a separate inventory role to produce a useful diff. Two things about that read changed in G12f and neither could be tested against AWS: the tag filter is now `Key=Name` with no value, because `get-resources` matches tag values exactly and `Values=fss-prod*` would have matched nothing and made the comparison a comparison of two empty lists; and the production names are selected and **sorted** locally, because the API promises no order and an unstable one would fail the comparison for no reason. If the account holds many `Name`-tagged resources, this read is now larger than it was.
2. Whether the drill can run at all: **nothing in this repository builds an `fss` executable.** No package declares a `bin`, and no step of the release workflow installs one, so every non-dry `fss admin …` in `rehearsal-restore-drill.sh` and every `fss carry export` in `rehearsal-carry-watermark.sh` would fail with `command not found`. Both scripts now refuse up front and say so, rather than discovering it after a restored RDS instance exists — but the CLI itself is another lane's, and the drill cannot pass until it lands. **Answered, 23 and 24 September: nothing puts an `fss` on PATH and nothing needs to.** No package declares a `bin` and that is now deliberate — every `fss` invocation is a command override of the worker image on a task definition inside the VPC, launched through `release_run_task`: the deploy's five one-off tasks, the workspace bootstrap, the drill's `fss admin counts`, the drill-evidence seeder and `fss drill` itself all ran that way in the cloud (8.0n to 8.0s). What is still open about the drill is steps 1 to 3, which is item 12.
3. Whether `--restore-time "$RESTORE_TARGET"` is acceptable to RDS. The drill defaults the target to *now*, and RDS refuses a restore time later than `LatestRestorableTime`, which trails the present by several minutes. The likely fix is `--use-latest-restorable-time` when no explicit target was given, but that changes which instant the baseline counts are `--as-of`, so it is not a change to make blind. Expect `InvalidRestoreTime` on the first run that reaches Appendix E step 1.
4. Whether the rehearsal environment publishes a `CanaryCompletionAgeSeconds` datapoint before the smoke step asks for one. **Answered, on 23 September: it did not, and the cause was that no workspace existed** (8.0p). The canary is inserted once per workspace, and the run now bootstraps one between steps 17 and 18; what is still unmeasured is how long the first datapoint takes after that — the scheduler's 60-second pass and the metrics publisher's 60-second pass say about two minutes, and the smoke step waits ten and then fails naming the cause rather than passing the literal `None` through to `Number()` and reporting `age=Nones`.
5. That `resourcegroupstaggingapi` is regional. The inventory only ever sees `us-east-1`, which is where everything is — but a production resource created in another region is outside the comparison and always will be.
6. Whether the worker task role can write the suppression journal. **Closed by G12b in the plan, unproved in the cloud.** `infra/modules/cluster` now gives the worker `s3:PutObject` on the journal object prefix and `kms:Encrypt`/`kms:GenerateDataKey` on the journal key, and `infra/modules/journal` names both task roles as permitted writers rather than the API alone — so the bucket policy's `DenyWritesFromAnyoneButTheTaskRoles` no longer refuses the worker. Neither role asks for any `s3:Delete*`, and no writer sets a per-object retention: the bucket's own default retention locks every object on put, and `s3:PutObjectRetention` stays denied to everybody. `infra/modules/cluster/tests/services.tftest.hcl` asserts both halves offline. What a plan cannot prove is that the first real opt-out the worker imports actually lands in the bucket; watch the `SuppressionJournalWriteFailures` metric after Gmail sync is first enabled, because a remaining IAM refusal surfaces there and nowhere else.
7. Whether one day of GOVERNANCE retention is long enough that `--bypass-governance-retention` is only ever needed for a same-day teardown.
8. How long the whole rehearsal takes. The workflow's timeout is 180 minutes, which is a guess dominated by the Multi-AZ restore in Appendix E step 1. The rehearsal database is now `db.t4g.small` and Multi-AZ, like production's (`docs/decisions/g12c-the-topology-answers-are-root-defaults.md`), so that guess is at last a guess about the right operation — and it is the first thing to measure.
9. Whether `fss-rh-deploy` can read the RDS-managed master secret the database URL is assembled from. The secret is named `rds!db-<id>` by RDS and does not carry the `fss-rh-` prefix, so `ReadTheRdsManagedMasterSecretOfThisNamespacesInstance` allows `DescribeSecret` and `GetSecretValue` on `rds!db-*` under `aws:ResourceTag/aws:rds:primaryDBInstanceArn` matching this namespace's instance ARNs (the global key since 8.0g; the service-specific one was refused by the simulator). **Creating** it is proved necessary and is now allowed (8.0f); **reading** it has never run against the service. The check simulates `DescribeSecret` under that key. Runbook 6.5 has the detail; symptom is an `AccessDenied` at "Assemble the rehearsal database URL" and no connection string.
10. Whether the first real rehearsal takes the skip branch of the carry drill, as it should before the cutover, and whether the release record reading `"carryDrill": "skipped_no_watermark"` is legible enough at enable time. Both branches run offline on every pull request; neither has run against AWS.
11. **A release record.** There is none. Every stage has passed at some commit — create, deploy, the bootstrap, the schema ranges, the smoke, the release suite, the drill's evidence — and the final `full` run at `66203322` (35948178549) ended at the drill step, though not for the reason 8.0s predicted: its credential expired at exactly one hour, inside `aws rds wait db-instance-available`, before the drill could reach the open steps of item 12 (8.0t). Only a `full` run that passes every step writes a record, so the `releaseGateReference` section 6 step 2 reads before sending can be enabled does not exist yet and will come from the post-release run that renews its session and passes the drill.
12. **The restore drill past its baseline — open, and post-release item 1.** The baseline exists; steps 1 to 3 do not run, for the five reasons 8.0s lists: no dialable subject, no suppression the restore loses, no fence left in `dispatching` or `reconciling`, no mailbox whose recorded envelope key the drill task can unwrap, and an `--at-failure` file nothing writes. Each of them refuses with its own reason rather than passing vacuously, which is why recording them is honest and relaxing an assertion would not be. David chose on 24 September to record them and ship the release path — his option 2, restated after the eleventh run's expiry (8.0t) and unchanged by it — so the drill stays **open** and stays post-release item 1; the drill's Step 1 point-in-time restore is the one part of it the eleventh run did issue, and it was the wait rather than the restore that died. The run that closes this item is also the run that writes item 11's record.
13. **The signed desktop build — answered, 24 September.** Run 35935100994 never got past importing the Developer ID certificate (8.0s) and the second build was refused at notarization for a team id that did not belong to the Apple ID; the **third**, run 35951921111, signed, notarized, stapled and published Callie 1.0.0 from commit `66203322` to the update channel at 03:37Z, manifest signed and zip `sha256` verified from outside the build (8.0t). What that still does not settle is the far end of it: nobody has installed the published artifact on a Mac, or taken an automatic update from the channel, so Gatekeeper's verdict on a real download and the updater's behaviour against a signed manifest are both unmeasured.
14. **The first sign-in, and the Gmail consent.** A live API refuses to start without the sign-in parts (section 4) and production started, so they are configured — which is not the same as used. Nobody has completed the hosted-domain sign-in, adopted the provisional admin row 5.1a created, or granted the mailbox consent whose callback lands on `https://api.usecallie.com/oauth/gmail/callback` (5.4). The first of those also decides whether `admin.outcome: provisional_created` behaves as `docs/greenfield/identity.md` says it will.
15. **Sending.** `FSS_SENDING_ENABLED` is `false` and section 6 has not been run, so nothing has been sent from production. 12.7's authentication checks, the six-week ramp, and the journal's first real write — item 6 above, which surfaces only as `SuppressionJournalWriteFailures` — are all unproved in production.
16. **The exact rehearsal deployment policy, put back.** `fss-rh-deploy` still carries the discovery document of 8.0h: a wide allow on the services the tree uses, with guards, for one pass of `create`, `deploy` and `full`. The exact policy derived from the CloudTrail record of that pass is put back only after the final run above has passed (`infra-apply-runbook.md` 1.1b, step 5), and until then no rehearsal run proves anything about the policy this release ships. `fss-prod-deploy` was never widened and the renderer refuses to widen it.
17. **A `full` run that outlasts its credentials, end to end.** The run is longer than the one-hour session the job used to hold, and 8.0t is what that cost: an expired token inside the drill's RDS waiter, a teardown and a production-prefix guard that both failed at their first call, and a leaked environment removed by a separate `stage=teardown` dispatch. The workflow now renews the session before the drill and again — on `always()` — before the teardown, each renewal followed by the identity assertion. **None of that has run against AWS.** What a credentialed run has to show is that a renewal mid-job succeeds at all (the OIDC token is requested fresh each time), that the renewed session passes `rehearsal-caller-identity.sh`, and that the teardown and the guard complete on it. The belt-and-braces follow-up — `MaxSessionDuration` 7200 on `fss-rh-deploy` and `role-duration-seconds: 7200` in the workflow — is not done and is deliberately separate: the role lives outside this repository.
