# The first release (archived)

Moved from `docs/greenfield/release.md` on 26 September 2026. Production was first applied on 23 September 2026 and has been live since 24 September; these are the steps that were done once to get there, and the ones a rebuild from zero would repeat. The section numbers are the ones `release.md` still cites; a reference to another section is to `release.md`.

## 1. Before the first release

### 1.1 The two deployment roles exist and differ

From `infra-apply-runbook.md` 1.1, and already done (`.context/FSS-GREENFIELD-ACCOUNT-IDENTIFIERS-20260920.md`):

- `arn:aws:iam::326255650484:role/fss-prod-deploy`
- `arn:aws:iam::326255650484:role/fss-rh-deploy` — **may act only on resources whose name begins `fss-rh`.**

Both are in account 326255650484, the one account FSS runs in. The plan of 22 September 2026 to move the rehearsal and production into dedicated accounts was not carried out, and its checklist was deleted on 26 September 2026.

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

And three **repository variables**, all optional and all unset.

| Variable | Value | What it does |
|---|---|---|
| `FSS_REHEARSAL_ACCOUNT_ID` | the rehearsal account's twelve digits | Cross-checked against the account the workflow's OIDC session actually belongs to; the run fails if they differ. The account the apply uses is always the session's, so this is a second statement of the same fact rather than a source of truth. |
| `FSS_REHEARSAL_STATE_BUCKET` | the rehearsal account's Terraform state bucket | Cross-checked against `infra/roots/rehearsal-registry/backend.hcl`. Catches an account that moved while the backend file did not, which would otherwise write state into the old account and say nothing. |
| `FSS_AWS_REGION` | the region, if it is not `us-east-1` | Sets `AWS_REGION` in both rehearsal workflows and `TF_VAR_aws_region` for the plan. |

Neither workflow contains an account id or a state bucket name at all: the account is read from the session, and the bucket and lock table from the root's own `backend.hcl`.

And these **two**, which are **optional and should not exist until the cutover is scheduled**:

| Secret | Value | Until then |
|---|---|---|
| `FSS_REHEARSAL_CARRY_WATERMARK` | the cutover watermark instant being drilled | leave it unset |
| `FSS_REHEARSAL_CARRY_TABLE` | the old table the carry reads | leave it unset |

With **both** unset the carry step prints exactly `carry drill skipped: no cutover watermark yet`, the release record carries `"carryDrill": "skipped_no_watermark"`, and the halves of Appendix G 20 that need no cutover — the old stack has no writer, no root names a legacy state key — still run. With **one** set the step fails: half a configuration is somebody halfway through something. `docs/archive/decisions/g12c-the-carry-drill-waits-for-a-cutover.md` has the reasoning.

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

You set neither by hand; the apply does. The bootstraps still read `push_topic` and `hosted_domain` out of the secret JSON **if the environment does not carry them**, so a deployment written against the older shape still starts — for one release. `docs/archive/decisions/g12b-two-public-identifiers-move-out-of-the-secret.md` says when that fallback goes and what has to be true first. The startup line reports which source each came from (`push_topic_source`, `hosted_domain_source`), so you can confirm the move landed without reading a task definition.

When neither source has one, the process refuses to start and names **both** places it looked.

### 1.7 Google application-default credentials, on your Mac

`infra/roots/production-google` is the only root that declares `provider "google"` (lane g85, 8.0ar). It holds the Gmail push objects and is planned only when one of them changes, and Terraform configures every provider a configuration requires before it evaluates anything, so a plan of it needs a working Google credential and without one stops at provider configuration with "Attempted to load application default credentials … No credentials loaded." A **production** plan needs none: the four push objects left the production state on 25 September 2026.

Once per machine, as the account that administers `callie-fss`:

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project callie-fss
```

`docs/greenfield/infra-apply-runbook.md` **1.3a** has the full procedure: enabling the Pub/Sub API, the two checks that the credential exists and can mint a token without printing any part of it, and why a downloaded service-account key file is refused by name rather than merely discouraged.

Nothing in the **rehearsal** needs this. The rehearsal root declares no Google provider and creates nothing in Google Cloud, which is why a CI run has no Google credential and must not be given one (`docs/archive/decisions/g12j-the-rehearsal-has-no-google-provider.md`).

## 2. The images

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

**Why the desktop build is last rather than first.** The obvious order — build the Mac app, take its stamp, feed it to the rehearsal — cannot run: the release job needs `FSS_UPDATE_CHANNEL_URL`, which needs the production apply, which comes after the rehearsal that was supposed to be waiting for the build. Making the stamp a fact about the commit rather than an output of a build breaks that circle and removes a copied string. `docs/archive/decisions/g13b-the-stamp-is-known-before-the-build.md` has the reasoning; `docs/archive/decisions/g13b-an-absent-channel-url-is-a-refusal.md` has why step 4 is a refusal rather than a default.

**What checks the agreement.** The desktop workflow refuses a `desktop_commit_stamp` that is not the commit the run is on, before it builds; and after it builds it compares the commit in the signed manifest — which is read out of the stamp inside the asar, inside the code signature — with both. At enable time (section 6) you compare the release record's `artifacts.desktopCommitStamp` with the commit the run summary printed. They are the same forty characters or sending does not get enabled.

**The API admits the desktop by its release line, not by its number (since 8.0aj).** Every sign-in, renewal and command is checked against the API's client-version policy (`CONTAINER_CLIENT_VERSIONS` in `apps/api/src/bootstrap/main.ts`). It has a `minimum`, a compatibility `ceiling` such as `1.x`, and an `incompatible` list of known-bad builds. Any build from the minimum to the top of the line that is not listed is admitted, even one built after the API was deployed. The API publishes the line's top as the maximum, `1.999.999` for `1.x`, so the Macs already installed read it with no change. The order is:

- **A desktop-only release publishes directly.** This is a new 1.x build that needs no route and no response field the deployed API lacks. There is no API deployment.
- **The API goes first only when the desktop needs something the deployed API does not have**: a new route, a new response field the desktop reads, or a migration. Deploy the API, smoke, then publish the desktop.
- **A new value in a closed vocabulary goes the other way.** Ship the desktop that knows it first; installed Macs refuse a value they do not know (`docs/archive/decisions/g78-one-wire-contract.md`).
- **A known-bad build** goes on `incompatible`, which is an API deployment. **A breaking change** raises the minimum or moves to a `2.x` line.

Until 8.0aj the maximum was the exact latest desktop, so every desktop release needed an API first: 1.0.1 (8.0x), 1.0.2 with migration 0016 (8.0ab), 1.0.3 (8.0ad) and 1.0.4 (8.0ae). 1.0.5 is the last one. The API in production still publishes 1.0.4 as its maximum, so the API carrying the ceiling is deployed first, once (8.0aj). `docs/archive/decisions/g78-version-ceiling.md` has the design.

**The first release, today.** Eight of the nine desktop signing secrets are not set and this Mac holds only an Apple Development identity, so the release job fails closed at its first step and names them. That is the intended state. `docs/greenfield/install.md` lists every one.

## 3.0 The orphan of run `fss-rh-202609211659`

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

**`admin.outcome: provisional_created` is normal on a first run.** The real Google `sub` cannot be known before that person signs in, so the row carries the sentinel `pending-email:<address>` until the first successful sign-in replaces it — `docs/greenfield/identity.md` and `docs/archive/decisions/g39-the-first-workspace-and-its-admin-are-bootstrapped.md`. A row that says `adopted_user` means that address already had an account, which is also fine.

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
