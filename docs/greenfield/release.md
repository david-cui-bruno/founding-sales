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
- `arn:aws:iam::326255650484:role/fss-rh-deploy` — **may act only on resources whose name begins `fss-rh-`.**

That scoping is Appendix G 39 in the cloud rather than only in the plan. `infra/scripts/rehearsal-prefix-guard.sh` checks the same thing from the other side after every rehearsal, and it refuses before making a call rather than waiting for an `AccessDenied` in a log.

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

`.github/workflows/greenfield-release.yml` puts every AWS step behind a repository environment named `rehearsal`. Create it in the repository settings and give it these **five** secrets:

| Secret | Value |
|---|---|
| `FSS_REHEARSAL_ROLE_ARN` | `arn:aws:iam::326255650484:role/fss-rh-deploy` |
| `FSS_REHEARSAL_API_REPOSITORY` | `326255650484.dkr.ecr.us-east-1.amazonaws.com/fss-rh-api` — `terraform output repository_urls` in `infra/roots/rehearsal-registry` prints it |
| `FSS_REHEARSAL_WORKER_REPOSITORY` | `326255650484.dkr.ecr.us-east-1.amazonaws.com/fss-rh-worker` — likewise |
| `FSS_REHEARSAL_CERTIFICATE_ARN` | the wildcard rehearsal certificate |
| `FSS_REHEARSAL_API_HOSTNAME` | `api.rehearsal.usecallie.com` |

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
| `FSS_GMAIL_PUSH_TOPIC` | `module.pubsub`'s topic, the same string `terraform output gmail_push_topic_id` prints |
| `FSS_GOOGLE_HOSTED_DOMAIN` | the `google_hosted_domain` root variable, `usecallie.com` |

You set neither by hand; the apply does. The bootstraps still read `push_topic` and `hosted_domain` out of the secret JSON **if the environment does not carry them**, so a deployment written against the older shape still starts — for one release. `docs/decisions/g12b-two-public-identifiers-move-out-of-the-secret.md` says when that fallback goes and what has to be true first. The startup line reports which source each came from (`push_topic_source`, `hosted_domain_source`), so you can confirm the move landed without reading a task definition.

When neither source has one, the process refuses to start and names **both** places it looked.

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
| 4 | Set the repository variable `FSS_UPDATE_CHANNEL_URL` to `terraform output -raw` of `distribution_domain_name`, as `https://<host>/` | David | It does not exist until step 3, and GitHub will not hold an empty variable. |
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

`fss-rh-api` and `fss-rh-worker` are **stable** repositories with no run in their names. They belong to `infra/roots/rehearsal-registry`, which is applied once (`infra-apply-runbook.md` 2.1) and never torn down; the per-run rehearsal root creates no repository at all. That is forced by this very step: you are pushing before the run exists, and the workflow's two repository secrets hold one value each. The rehearsal root refuses an image that does not come from those two repositories — `fss-rh-deploy` cannot read a production repository, so a plan-time refusal is better than an authorization error five minutes into a deployment.

The **desktop commit stamp** is the release commit from 2.0 — the same `git rev-parse HEAD` you have been using — and the release record names it. You do not wait for a Mac build to learn it.

---

## 3. The rehearsal — CI, started by David

Actions → *Greenfield release rehearsal* → Run workflow, with:

- `api_image_digest` — from the push above;
- `worker_image_digest` — likewise;
- `desktop_commit_stamp`;
- `run_suffix` — optional; the prefix becomes `fss-rh-<suffix>`, or `fss-rh-<UTC timestamp>`.

What it does, in order, and why the order is the order:

1. **Refuse anything that is not a digest.** Two `sha256:` values, and they must differ — one image pushed under both names is a mistake the gate can catch and a person cannot.
2. **Record the production inventory.** So that "teardown could not address production" is measured afterwards rather than asserted.
3. **Create** the rehearsal root with the run prefix, deploying both digests from the stable `fss-rh-api` and `fss-rh-worker` repositories. The run creates no repository of its own and its teardown removes none; `infra/roots/rehearsal-registry` owns those two and was applied once, before the first push.
4. **Migrate, then deploy the worker, then the API.** Never beside each other: the API's declared schema range needs the migration to have run, the worker may straddle. `infra/scripts/rehearsal-schema-ranges.sh` runs that order and then the refusal cases (Appendix G 22).
5. **Smoke** with the same `scripts/productionSmoke.mjs` production gets.
6. **Run the Appendix G suite** (`npm run test:release`) and the **mutation check** (`npm run test:release:mutation`), which breaks each trap in turn and requires the suite to go red.
7. **Restore drill**, Appendix E steps 1 to 9. It refuses to report a pass unless the baseline contained an accepted send, a reply, a suppression, a CRM edit and a migration — a drill against an empty database proves nothing.
8. **Suppression journal replay and Gmail reconstruction**, against the recorded fake (no real mailbox in rehearsal unless you provide a rehearsal Google project). The second replay must insert nothing; no send may repeat.
9. **Carry watermark** (Appendix G 20): the carry tooling must contain no writer at all, and — once a cutover is scheduled and the two optional secrets exist — the export must refuse a table with a post-watermark write. Before the cutover the step prints `carry drill skipped: no cutover watermark yet` and the record says `"carryDrill": "skipped_no_watermark"`. That is not a pass being claimed; it is the state being named.
10. **Tear down**, always, with bypass-governance.
11. **Assert nothing with the production prefix was touched**, always. The guard classifies every name it sees: the run's own resources, the two stable rehearsal repositories that carry no run, and anything production's — which it refuses. It runs in dry mode on every pull request, so both branches are exercised without a credential.
12. **Write the release record**, last. It names the two digests, the desktop stamp, and a `releaseGateReference` you will need in section 6.

If any step fails, steps 10 and 11 still run and no record is written. That is the design: there is no such thing as a partially passed release gate.

### 3.1 Watching it without credentials

Every pull request runs the `dry-run` job, which prints the entire plan — every `terraform` and `aws` invocation the rehearsal would make, in order — with no credential present. Read it before you run the real thing. You can run the same thing locally:

```bash
FSS_REHEARSAL_DRY_RUN=1 FSS_REHEARSAL_REPORTS=/tmp/fss-rehearsal \
  infra/scripts/rehearsal-restore-drill.sh fss-rh-dryrun
```

---

## 4. Production apply — David

Follow `docs/greenfield/infra-apply-runbook.md` section 3.2 for the plan and apply.

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
| `FSS_GMAIL_PUSH_TOPIC` | the Pub/Sub topic id | none; derived from `module.pubsub` |
| `FSS_GOOGLE_HOSTED_DOMAIN` | `usecallie.com` | `google_hosted_domain` |

Until G12c none of the first three could be set at all: `extra_environment` existed on the stack module and no root exposed it, so an apply produced two services whose tasks exit at startup naming a variable no plan could set. `docs/decisions/g12c-the-deployment-flags-are-root-variables.md`.

`FSS_DEPENDENCIES` has no default **in the binary**: an unset one is a refusal to start, which is deliberate (`docs/decisions/g12-the-credentialed-bootstrap.md`); the root's default is what makes sure it is never unset. `dependencies_mode` refuses `none` outright and accepts `recorded`, which the binaries then refuse in a production environment — the rule lives in one place rather than two that can disagree. `FSS_RESEARCH_PROVIDERS=none` is a declaration that this build ships no live research adapter, not an accident. The last two need nothing from you; they are listed so that a startup line reporting `hosted_domain_source: "secret"` reads as "the apply has not landed yet" rather than as a mystery.

There is also `extra_environment` (`map(string)`, empty) on both roots, for whatever the next release needs before it earns a variable of its own. Never a credential: secrets reach a container only as a Secrets Manager reference, and the root test asserts no environment name looks like one.

**What the API refuses to start without.** A live API now builds Google sign-in or exits with `api_deployment_refused`. The parts are the `google-oidc-client` secret, `FSS_PUBLIC_ORIGIN` (the redirect is `https://api.usecallie.com/auth/google/callback`, derived rather than configured twice), `FSS_GOOGLE_HOSTED_DOMAIN`, and `session-signing-key`. `--selftest` prints `sign_in`, `sign_in_client_configured`, `sign_in_redirect_configured`, `sign_in_hosted_domain_configured` and `session_signing_key_configured` — names and booleans, never a value. Before G12b the API started without any of it and refused every command; see `docs/decisions/g12b-sign-in-is-configured-or-the-api-refuses.md`.

### 4.1 The order inside the apply

```
pg_trgm extension  →  migrations forward  →  worker service  →  API service
```

The same order the rehearsal used, for the same reason. If you are applying the whole root in one go, apply it, then run the migration, then force a new deployment of the worker and then of the API:

```bash
aws ecs update-service --cluster fss-prod-cluster --service fss-prod-worker --force-new-deployment
aws ecs wait services-stable --cluster fss-prod-cluster --services fss-prod-worker
aws ecs update-service --cluster fss-prod-cluster --service fss-prod-api --force-new-deployment
aws ecs wait services-stable --cluster fss-prod-cluster --services fss-prod-api
```

---

## 5. The four manual steps after the apply

These are in the order they unblock each other. Doing 5.3 before 5.2 will not work, because Pub/Sub will not push to an endpoint whose certificate it cannot verify.

### 5.1 The secret values, from stdin

Terraform created six empty entries and never holds a value. Fill them:

```bash
aws secretsmanager put-secret-value --secret-id fss-prod/google-gmail-oauth-client \
  --secret-string file:///dev/stdin
# paste the JSON from section 1.6, then Ctrl-D.
```

Repeat for `google-oidc-client`, `session-signing-key`, `device-credential-pepper`, `llm-classifier-api-key` and `research-provider-credentials`. The two Google entries take the two-field JSON in section 1.6 and nothing else; the rest are single values.

`file:///dev/stdin` rather than `--secret-string '<value>'` so the value never reaches shell history or the process table. `session-signing-key` and `device-credential-pepper` are **base64 bytes, at least 32 of them, never PEM** — the API refuses PEM by name, because a PEM armour line in a repository is flagged by the history scanner in every commit it ever appeared in:

```bash
openssl rand -base64 48   # then paste that
```

Then force a new deployment of both services so the tasks read the values.

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

Nothing in this repository has ever been applied, and the rehearsal workflow has never run against AWS. Every command here comes from the AWS documentation, the Terraform schema and the scripts' dry-run output, checked offline. Watch these on the first real run:

1. Whether `resourcegroupstaggingapi get-resources` is readable by the rehearsal role. `rehearsal-prefix-guard.sh` uses it to compare the production inventory before and after; if the role cannot read production at all, the scenario still passes — "could not address" is the claim — but the script will need the read moved to a separate inventory role to produce a useful diff.
2. Whether the worker task role can write the suppression journal. **Closed by G12b in the plan, unproved in the cloud.** `infra/modules/cluster` now gives the worker `s3:PutObject` on the journal object prefix and `kms:Encrypt`/`kms:GenerateDataKey` on the journal key, and `infra/modules/journal` names both task roles as permitted writers rather than the API alone — so the bucket policy's `DenyWritesFromAnyoneButTheTaskRoles` no longer refuses the worker. Neither role asks for any `s3:Delete*`, and no writer sets a per-object retention: the bucket's own default retention locks every object on put, and `s3:PutObjectRetention` stays denied to everybody. `infra/modules/cluster/tests/services.tftest.hcl` asserts both halves offline. What a plan cannot prove is that the first real opt-out the worker imports actually lands in the bucket; watch the `SuppressionJournalWriteFailures` metric after Gmail sync is first enabled, because a remaining IAM refusal surfaces there and nowhere else.
3. Whether one day of GOVERNANCE retention is long enough that `--bypass-governance-retention` is only ever needed for a same-day teardown.
4. How long the whole rehearsal takes. The workflow's timeout is 180 minutes, which is a guess dominated by the Multi-AZ restore in Appendix E step 1. The rehearsal database is now `db.t4g.small` and Multi-AZ, like production's (`docs/decisions/g12c-the-topology-answers-are-root-defaults.md`), so that guess is at last a guess about the right operation — and it is the first thing to measure.
5. Whether `fss-rh-deploy` can read the RDS-managed master secret the database URL is assembled from. The secret is named `rds!db-<id>` by RDS and does not carry the `fss-rh-` prefix the role is scoped by, so its policy probably needs a statement naming the ARN the root outputs. Runbook 6.5 has the detail; symptom is an `AccessDenied` at "Assemble the rehearsal database URL" and no connection string.
6. Whether the first real rehearsal takes the skip branch of the carry drill, as it should before the cutover, and whether the release record reading `"carryDrill": "skipped_no_watermark"` is legible enough at enable time. Both branches run offline on every pull request; neither has run against AWS.
