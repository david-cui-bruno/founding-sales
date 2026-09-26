# FSS greenfield infrastructure: apply runbook

**Lane:** G1 · **Roots:** `infra/roots/production`, `infra/roots/rehearsal` · **Audience:** David, running the applies.

Production was first applied on 23 September 2026 and has run since 24 September, in account 326255650484. This runbook is how the stack was built the first time, and what rebuilding it from zero would follow; the procedure for a release to the running stack is `docs/greenfield/release.md`. The plan commands below are those of the current roots.

Read section 1 in full before running anything in section 3. The order matters: several resources cannot be created until something outside Terraform exists first, and two of them (the ACM certificate and the Google OAuth consent screen) involve waiting on external validation.

## 0. Tooling

| Thing | Value |
|---|---|
| Terraform | 1.15.8 locally and in CI (`.github/workflows/greenfield-infra.yml`). The roots require exactly `1.15.8`, and each root commits its `.terraform.lock.hcl` for darwin_arm64 and linux_amd64. |
| Region | `us-east-1` — `local.aws_region` in each AWS root |
| Account | `326255650484` — `local.aws_account_id` in each AWS root |
| State bucket | `callie-sourcing-tfstate-326255650484` (already exists; created once by `cloud/scripts/bootstrap-terraform-state.sh`) — `infra/roots/<root>/backend.hcl`, `FSS_POLICY_STATE_BUCKET` |
| Lock table | `callie-sourcing-tflock` (already exists) — `infra/roots/<root>/backend.hcl`, `FSS_POLICY_LOCK_TABLE` |
| Production state key | `fss/greenfield/production/terraform.tfstate` |
| Rehearsal state key | `fss/greenfield/rehearsal/<run>/terraform.tfstate` |
| Rehearsal registry state key | `fss/greenfield/rehearsal-registry/terraform.tfstate` — deliberately outside the per-run space (2.1) |

Neither root provisions, modifies or grants access to the state bucket or the lock table. They are inputs.

FSS runs in that one account and region. They are literals in the roots and the backend files; the plan of 22 September 2026 to move into dedicated accounts was not carried out.

Run the offline gate before any apply. It is the same gate CI runs and it needs no credentials:

```bash
cd <repo root>
TERRAFORM=$(command -v terraform) infra/scripts/offline-gate.sh
```

## 1. What David creates by hand, before the first apply

These cannot be Terraform resources in these roots, either because Terraform would have to hold a secret, or because they need a human decision, or because they must exist before the thing that references them.

### 1.1 The two deployment IAM roles

Terraform assumes a role. The roles do not exist yet and they are what makes rehearsal unable to touch production.

Create two roles in `326255650484`:

| Role | Trusted by | Permission boundary |
|---|---|---|
| `fss-prod-deploy` | David's admin principal (and, later, the release workflow's OIDC provider) | may act on resources whose name begins `fss-prod`, plus the account-wide services that have no resource namespace |
| `fss-rh-deploy` | the CI rehearsal workflow's OIDC provider | **may act only on resources whose name begins `fss-rh-`** |

**You never assume `fss-rh-deploy`.** It trusts the GitHub OIDC provider and the subject `repo:david-cui-bruno/founding-sales:environment:rehearsal` alone, so every apply and every teardown in the `fss-rh-` namespace is a workflow run in the `rehearsal` environment: the release rehearsal (`greenfield-release.yml`) and, once, the registry apply (section 2.1), whose workflow was deleted on 26 September 2026. A local `terraform apply` against either rehearsal root is refused `sts:AssumeRole`, and that refusal is the boundary working. `fss-prod-deploy`, by contrast, is yours: section 3.2's production applies are local commands.

The scoping on `fss-rh-deploy` is what makes Appendix G scenario 39 true in the cloud rather than only in the plan. The `fss-rh` condition belongs on every statement that supports a resource ARN, including `iam:DeleteRole`, `rds:DeleteDBInstance`, `s3:DeleteBucket`, `ecs:DeleteService`, `secretsmanager:DeleteSecret` and `kms:ScheduleKeyDeletion`. Where a service has no resource-level permission, use a `aws:ResourceTag/NamePrefix` condition against the tag the stack sets on every resource.

Until those roles exist, `terraform plan` will fail at provider configuration. That is the intended failure: neither root will act as an unconstrained principal.

#### 1.1a The policies are in the repository. These are the commands.

**This section used to be the policy.** It described the two roles in prose and the repository shipped no document, so both policies were written from that prose — and on 21 September the fourth credentialed rehearsal (Actions run 35628963637) applied with them and reported 25 errors in six classes, then failed its teardown and left a bucket behind. Six classes, one run, none of them visible to any offline check here, because there was nothing offline to check.

The policy is now `infra/policies/deployment-role-policy.json.tftpl`, rendered by a script that makes no call, and `test/ops/deploymentRolePolicy.check.ts` walks every `resource "aws_*"` type in `infra/modules` and `infra/roots` and fails when one of them needs an action the rendered policy does not allow — or allows and then cancels with a blanket deny, which is what happened to all eight Secrets Manager entries. `infra/policies/terraform-resource-actions.json` is the map it reads, one entry per resource type, and it is meant to be read. `docs/archive/decisions/g16-the-deployment-role-policy-is-code.md` lists every change against David's hand-written policies.

**Read the document before you put it.** It is a whole inline policy, not a delta: `put-role-policy` replaces the policy of that name entirely. **Validate it before you put it**, read-only: `aws accessanalyzer validate-policy --policy-type IDENTITY_POLICY --policy-document file:///tmp/<file>.json --query 'findings[?findingType==`ERROR`]'` must print `[]`. The renderer checks the ARN grammar it knows about (a literal service segment in every resource); Access Analyzer checks the rest as IAM itself will.

```bash
cd <repo root>

# 1. Render both, and read them.
infra/scripts/render-deployment-role-policy.sh fss-rh   > /tmp/fss-rh-deploy-scope.json
infra/scripts/render-deployment-role-policy.sh fss-prod > /tmp/fss-prod-deploy-scope.json

infra/scripts/render-deployment-role-policy.sh fss-rh   --sids   # what is in it, by effect
infra/scripts/render-deployment-role-policy.sh fss-prod --sids

# What is about to change, against what the role holds today.
diff <(aws iam get-role-policy --role-name fss-rh-deploy --policy-name fss-rh-deploy-scope \
         --query PolicyDocument | python3 -m json.tool) \
     <(python3 -m json.tool /tmp/fss-rh-deploy-scope.json) || true

# 2. Put them. The policy name is the one the roles already carry.
aws iam put-role-policy --role-name fss-rh-deploy --policy-name fss-rh-deploy-scope \
  --policy-document file:///tmp/fss-rh-deploy-scope.json

aws iam put-role-policy --role-name fss-prod-deploy --policy-name fss-prod-deploy-scope \
  --policy-document file:///tmp/fss-prod-deploy-scope.json
```

To keep the exact certificate ARNs the hand-written policies named, pass them; the default is every certificate in the account and region, because the ARNs themselves are the `rehearsal` environment secret `FSS_REHEARSAL_CERTIFICATE_ARN` and its production counterpart, and a repository that shipped them would hold a value the workflow deliberately keeps out of it. `acm:DescribeCertificate` is read-only either way.

```bash
FSS_POLICY_CERTIFICATE_ARN=arn:aws:acm:us-east-1:326255650484:certificate/<rehearsal id> \
  infra/scripts/render-deployment-role-policy.sh fss-rh > /tmp/fss-rh-deploy-scope.json
```

**3. Then the check, before any apply.** Read-only: it calls `aws iam simulate-principal-policy`, which evaluates a policy and performs nothing, against sample ARNs of the namespace that need not exist. It asks about every action of run 35628963637 and at least one per service, prints allowed or denied for each, and exits non-zero on any denial.

```bash
infra/scripts/check-deployment-role.sh fss-rh-deploy   fss-rh
infra/scripts/check-deployment-role.sh fss-prod-deploy fss-prod

# What it would ask, without asking: no credential, no call.
FSS_CHECK_ROLE_DRY_RUN=1 infra/scripts/check-deployment-role.sh fss-rh-deploy fss-rh
```

Each role is asked only about its own namespace and the command refuses the other pairing, because simulating `fss-rh-deploy` against `fss-prod*` would print a wall of denials that are the boundary working and say nothing about the apply you are about to run.

**And the one permission that must never appear on the production role.** `s3:BypassGovernanceRetention` is in the rehearsal document and denied outright in the production one, because a production suppression journal that its deployer can empty is not an append-only record and Appendix E step 2 stops being a recovery. The check is in `docs/greenfield/release.md` 1.2 and the release suite asserts both halves.

**The trust policies are not this lane's and are not in the repository.** `fss-rh-deploy` trusts the GitHub OIDC provider and the subject `repo:david-cui-bruno/founding-sales:environment:rehearsal`; `fss-prod-deploy` trusts David's admin principal. Neither is touched by anything above: `put-role-policy` writes the permission policy, never the trust relationship.

**Who does the assuming, and the one flag that changes it.** Every root takes `assume_deployment_role`, a boolean **defaulting to `true`**: the provider assumes `deployment_role_name` before it makes a call. That is what your local applies do and there is nothing to pass — sections 2.2 and 3.2 are unchanged.

CI is the exception. `aws-actions/configure-aws-credentials` has already assumed `fss-rh-deploy` through GitHub OIDC before Terraform starts, so the workflow's session **is** the role; assuming it again is role chaining onto the same role, which needs `fss-rh-deploy` to trust itself. It does not, and it must not — its trust is the OIDC subject alone, which is the whole boundary. So both rehearsal workflows pass `-var=assume_deployment_role=false`, and each one first runs

```bash
infra/scripts/rehearsal-caller-identity.sh fss-rh-deploy
```

which prints `aws sts get-caller-identity --query Arn` and refuses anything that is not `arn:aws:sts::326255650484:assumed-role/fss-rh-deploy/<session>` — a user, a different role, or a role whose name merely begins the same way. The flag says "use the credentials you already have"; that script is what makes sure they are the right ones. The default stays `true` in all three roots so that a forgotten flag is an `sts:AssumeRole` refusal rather than an apply running as whatever credential happened to be in the environment. `docs/archive/decisions/g12e-the-provider-does-not-reassume-its-own-session.md`.

### 1.2 The DNS zone and the ACM certificates

1. Decide the production API hostname (`api_hostname`) and the rehearsal hostname. They must differ.
2. Request a public ACM certificate in **`us-east-1`** for the production API hostname. Note the ARN.
3. Add the CNAME records ACM asks for and wait for the certificate to reach `ISSUED`. This can take minutes; it will not complete until DNS resolves.
4. Repeat for the rehearsal hostname, or use a wildcard covering `*.rehearsal.<domain>` so that each run does not need a new certificate.
5. If the Electron package distribution gets a custom hostname, that certificate must **also** be in `us-east-1` (CloudFront requirement) and is a separate input to `infra/modules/updates`.

The DNS A/ALIAS record for the API hostname is created **after** the first apply, pointing at `load_balancer_dns_name` / `load_balancer_zone_id`. Creating it before the apply leaves a hostname resolving to nothing.

### 1.3 The Google Cloud project and OAuth consent screen

1. Create a Google Cloud project for production Gmail push. Note its id; it becomes `gcp_project_id` of `infra/roots/production-google`, whose default is the project in use, `callie-fss`.
2. Enable the Cloud Pub/Sub API and the Gmail API in it.
3. Configure the OAuth consent screen as an **Internal** application in the Callie Workspace organisation.
4. Create two OAuth client credentials:
   - the **sign-in** client, for the Google OpenID Connect authorization-code flow with PKCE in the system browser;
   - the **Gmail** client, for the separate `gmail.readonly` + `gmail.send` grant.
5. Keep both client secrets to hand for step 1.4. Do not put either in a file in the repository, in a `tfvars` file, or in a shell history line.
6. **No rehearsal Google Cloud project, ever.** The Pub/Sub topic and its push subscription belong to `infra/roots/production-google` alone (lane g85); the rehearsal root declares no Google provider, has no `gcp_project_id`, and creates nothing in Google Cloud. A rehearsal's Gmail is the recorded fake and its webhook is exercised offline with locally signed tokens, so a rehearsal project would be a second cloud trust relationship that proves nothing. Its two task definitions carry a derived audience and two public placeholders naming a project that does not exist; `docs/archive/decisions/g12j-the-rehearsal-has-no-google-provider.md` lists the values and why they are not blank.

### 1.3a Google application-default credentials, on your Mac, before a plan of the Google root

`infra/roots/production-google` is the one root that declares `provider "google"` (lane g85, `docs/archive/decisions/g85-the-google-provider-has-its-own-root.md`). It holds the four Gmail push objects and is planned and applied only when one of them has to change. `infra/roots/production` declares no Google provider: it takes the topic and the push service account as validated variable defaults, so **a production plan needs no Google credential**. The four objects were imported into the Google root's state, and removed from the production state, on 25 September 2026.

Terraform configures **every** provider a configuration requires before it evaluates anything, whether or not a resource uses it. Without a credential a plan of the Google root stops with

```
Error: Attempted to load application default credentials since neither `credentials`
nor `access_token` was set in the provider block. No credentials loaded.
```

which is exactly where the third credentialed rehearsal stopped, in CI, on 21 September 2026.

Once per machine, as the account that administers `callie-fss`:

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project callie-fss
gcloud services enable pubsub.googleapis.com --project callie-fss
```

Then confirm the credential exists, without printing any part of it:

```bash
test -f "$HOME/.config/gcloud/application_default_credentials.json" \
  && echo "ADC present" || echo "ADC MISSING: run gcloud auth application-default login"

gcloud auth application-default print-access-token >/dev/null \
  && echo "ADC token mints" || echo "ADC BROKEN: re-run the login"

gcloud services list --enabled --project callie-fss --filter=pubsub \
  --format='value(config.name)'   # expect pubsub.googleapis.com
```

Never `cat` that file, never echo a token, and never paste one into a variable, a `tfvars` file or a shell line. Note the second command deliberately redirects its output: it proves a token can be minted and shows nothing of it.

**A service-account key file is refused by name.** Do not create one, do not download one, and do not set `GOOGLE_APPLICATION_CREDENTIALS` or the provider's `credentials` argument to a path. David's rule is that no key is pasted anywhere, and a downloaded Google key is a long-lived credential in a file no rotation reaches. Application-default credentials from an interactive login expire and are revocable; that is the whole difference. If you find such a file, delete it and re-run the login.

The provider block in `infra/roots/production-google/providers.tf` names only `project` and `region`: there is no `credentials` and no `access_token` argument to fill in, which is why the failure above is the one you get rather than a quiet wrong-identity apply.

### 1.4 The secret values

Terraform creates six **empty** Secrets Manager entries. It never holds a value and it never generates one. After the first apply (step 3.3), put the values in with the CLI. These are the entries and what goes in each:

| Entry | Content |
|---|---|
| `fss-prod/google-oidc-client` | sign-in OAuth client id and secret, as `{"client_id": "...", "client_secret": "..."}` |
| `fss-prod/google-gmail-oauth-client` | Gmail OAuth client id and secret, same two-field shape |
| `fss-prod/session-signing-key` | signing material for access sessions |
| `fss-prod/device-credential-pepper` | server-side pepper for the device credential hash |
| `fss-prod/llm-classifier-api-key` | reply-classifier provider key |
| `fss-prod/research-provider-credentials` | nothing: the research feature was deleted on 26 September 2026 and nothing reads it; the empty entry goes with a later infrastructure release |

Nothing else goes in either Google entry. The Pub/Sub topic and the Workspace domain are public identifiers and travel in the task environment (`FSS_GMAIL_PUSH_TOPIC`, `FSS_GOOGLE_HOSTED_DOMAIN`), set by the apply from `module.pubsub` and the `google_hosted_domain` root variable; see `docs/greenfield/release.md` 1.6.

The RDS master password is **not** in that list. `manage_master_user_password` hands generation, storage and rotation to RDS, which writes it to its own Secrets Manager secret encrypted with the same customer key. Terraform never sees it and it never appears in state.

### 1.5 The alert recipients

Decide the addresses for `alert_emails`. Each one receives an AWS confirmation email after the first apply and **must click the link**. An unconfirmed subscription is silently no delivery. Step 3.5 has the check.

### 1.6 Sending prerequisites, before sending is enabled

Not infrastructure, but the apply is pointless without them and they take days, so start them now: SPF, DKIM and DMARC on the Callie sending domain, and Google Postmaster Tools registration. Spec 12.7 makes passing authentication a precondition of enabling automated sending, and the six-week new-domain ramp starts from the first healthy send.

### 1.7 The service quotas that stop an apply

One quota is reached in ordinary use and it is not obvious from the error: **VPCs per Region** (`L-F678F1CE`, service `vpc`), which defaults to **5** in `us-east-1`. Every rehearsal environment is one VPC, production is one, and the account holds unrelated ones, so a rehearsal `create` can fail at `CreateVpc` with nothing wrong with the plan — which is how two runs failed on 23 September. Read it and raise it before the first apply:

```bash
aws service-quotas get-service-quota --service-code vpc --quota-code L-F678F1CE \
  --query 'Quota.{name:QuotaName,value:Value}'
aws service-quotas request-service-quota-increase --service-code vpc \
  --quota-code L-F678F1CE --desired-value 10
```

It was raised to 10 on 23 September 2026 and approved the same afternoon. `docs/greenfield/release.md` 8.0s has the two failed runs. Requests are per region and per account, so a new account — the dedicated ones — starts again at 5.

## 2. Push the images first

Both services are deployed by **digest**. `api_image` and `worker_image` are validated against `@sha256:<64 hex>`; a tag is refused. There are **four** repositories across three roots, and two of them have to exist before anything can be pushed:

| Repository | Created by | When |
|---|---|---|
| `fss-prod-api`, `fss-prod-worker` | `infra/roots/production`, `module.stack.module.registry` | targeted first apply, once |
| `fss-rh-api`, `fss-rh-worker` | `infra/roots/rehearsal-registry` | its own apply, once |

### 2.1 The rehearsal repositories — one apply, then never again

The per-run rehearsal root creates **no** repository (`create_registry = false`). It cannot: the images are pushed before the run exists, the release workflow's environment secrets name two fixed repositories, and a per-run repository would be destroyed with the run — taking the earlier compatible binaries the 4.2 rollback path depends on. `docs/archive/decisions/g12c-the-rehearsal-registry-is-its-own-root.md` has the reasoning.

**It has been applied, once, and nothing re-applies it.** The workflow that did it (`greenfield-rehearsal-registry.yml`) and its plan guard were deleted on 26 September 2026; the root's state holds the two repositories. You cannot apply this root from your Mac: `fss-rh-deploy` trusts the GitHub OIDC provider and the subject `repo:david-cui-bruno/founding-sales:environment:rehearsal`, and nothing else, so a `terraform apply` here is refused `sts:AssumeRole`. If it ever has to be applied again, that is a pull request adding a job in the `rehearsal` environment that runs `infra/scripts/rehearsal-caller-identity.sh fss-rh-deploy` and then plans with `-var=assume_deployment_role=false` (section 1.1). The two repository URLs are the values of the `rehearsal` environment's `FSS_REHEARSAL_API_REPOSITORY` and `FSS_REHEARSAL_WORKER_REPOSITORY` secrets; `terraform output repository_urls` prints them.

This root takes no `name_prefix`: `fss-rh` is a literal, because the workflow's secrets name exactly `fss-rh-api` and `fss-rh-worker`. Its state key is `fss/greenfield/rehearsal-registry/terraform.tfstate`, deliberately outside the per-run space `fss/greenfield/rehearsal/<run>/` — `registry` is a legal run suffix, and a run whose state collided with this one would destroy the repositories on teardown. The offline gate checks all of that.

Do not `terraform destroy` this root. `force_delete` is false, so a destroy fails on a repository that still holds images, which is the correct answer.

**The first production plan after this change shows the two repositories as *moved*, never as replaced.** `create_registry` gives `module.stack.module.registry` a `count`, which renames its address to `module.stack.module.registry[0]`; the production state already holds the un-counted address, because the targeted apply in 2.2 below was run at commit 71d84e00. A `moved` block in `infra/modules/stack` migrates the state inside the plan, so the plan reads

```
module.stack.module.registry.aws_ecr_repository.this["api"] has moved to module.stack.module.registry[0].aws_ecr_repository.this["api"]
```

and reports **no changes** to either repository. **If a production plan ever proposes to destroy an ECR repository, stop and do not apply it.** Destroying `fss-prod-api` or `fss-prod-worker` deletes the images every release is identified by, including the earlier compatible binaries 4.2's preferred rollback depends on, and the digests in every past release record stop resolving.

### 2.2 The production repositories — the one use of `-target`

Unlike 2.1, this one **is** a local command. `fss-prod-deploy` is trusted by your admin principal; `fss-rh-deploy` is not trusted by anything but the `rehearsal` environment, which is why the rehearsal registry apply above was a workflow run and this is not. Nothing here passes `assume_deployment_role`: its default is `true`, and the provider assuming `fss-prod-deploy` on your behalf is exactly what should happen when a person runs this.

```bash
# First apply: create the registries only.
cd infra/roots/production
terraform init -backend-config=backend.hcl -backend-config="kms_key_id=<state key arn>"
terraform apply -target=module.stack.module.registry
```

Then build, push and record the digests:

```bash
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin 326255650484.dkr.ecr.us-east-1.amazonaws.com

docker push 326255650484.dkr.ecr.us-east-1.amazonaws.com/fss-prod-api:<version>
aws ecr describe-images --repository-name fss-prod-api \
  --image-ids imageTag=<version> --query 'imageDetails[0].imageDigest' --output text
```

`-target` is used exactly once, for this bootstrap, and never again. The rest of the runbook applies the whole root.

**This has already been done**, at commit 71d84e00, so production state holds the two repositories with immutable tags and scan on push. That is why 2.1's `moved` note exists: the next plan you run against this root migrates their address and changes nothing about them.

The same digests are then pushed to `fss-rh-api` and `fss-rh-worker` so the rehearsal deploys the exact artefacts production will (`release.md` 2.1). The rehearsal root refuses an `api_image` that does not end `/fss-rh-api@sha256:<64 hex>`: `fss-rh-deploy` may read nothing outside `fss-rh-*`, and a plan is a better place to learn that than an ECR authorization error minutes into a deployment.

## 3. The applies, in order

### 3.0 Plan first

**After any change to `infra/`, the first credentialed action is a local production plan, written to a file and not applied. It comes before dispatching a rehearsal.**

The reason is arithmetic rather than caution. Three credentialed runs have now been spent, and each one stopped on a different error that no offline layer in this repository can see:

| Run | Stopped on | Why offline could not see it |
|---|---|---|
| 35602423640 | `The root module input variable "api_schema_range" is not set` | `terraform test` supplies its own variables; the dry-run job (deleted 26 September 2026) never ran Terraform |
| 35611374218 | `provider["registry.terraform.io/hashicorp/google"]` had no credentials | `mock_provider` *replaces* the provider configuration, so no test can exercise one |
| 35611374218 | `Invalid count argument` on `count = var.kms_key_arn == null ? 1 : 0` | `validate` never evaluates a `count`, and the module's tests passed a literal ARN |

`terraform validate`, `terraform test` with mocked providers and `FSS_REHEARSAL_DRY_RUN=1` are all worth running and none of them configures a provider or evaluates an expression against a value that is unknown until apply. A real `plan` does both. A rehearsal costs 20 to 180 minutes and an hourly bill to learn the same thing.

```bash
cd infra/roots/production
terraform init -backend-config=backend.hcl -backend-config="kms_key_id=<state key arn>"

terraform plan -out=production.tfplan \
  -var="api_image=<api digest>" \
  -var="worker_image=<worker digest>" \
  -var='api_schema_range={min=1,max=1}' \
  -var='worker_schema_range={min=1,max=1}' \
  -var="bootstrap=true"
```

This needs the AWS credential of section 1.1 and no Google credential: the production root has no `gcp_project_id` and refuses one passed to it. It takes no `certificate_arn`, `api_hostname`, `alert_emails` or `sending_enabled` either: since 26 September 2026 those are literals in `infra/roots/production/main.tf` (a rebuild from zero edits them there first), and passing one is an "undeclared variable" error. The plan file is a read-only artefact here: **nothing in this section applies it.** Section 3.2 is where an apply happens, from a plan you have read.

A clean first plan shows:

- every name beginning `fss-prod`, and no `fss-rh-` anywhere;
- the two ECR repositories under **"has moved to"** — `module.stack.module.registry` to `module.stack.module.registry[0]` — and under nothing else. A plan that proposes to destroy, replace or recreate `fss-prod-api` or `fss-prod-worker` is a plan to delete the images the release record names. Stop there;
- **five** task definitions: `fss-prod-api`, `fss-prod-worker`, `fss-prod-migration`, `fss-prod-operations`, `fss-prod-drill`. Three of them are one-off families with no service;
- both ECS services created with `desired_count = 0`, because this plan passes `bootstrap=true`. `release-deploy.sh` scales them afterwards. Without `bootstrap=true` the counts are 2 and 1;
- **eight** `aws_secretsmanager_secret` entries and **no** `aws_secretsmanager_secret_version` at all. Terraform creates the entries empty and never holds a value; the offline gate refuses a version resource outright;
- exactly one `aws_lb_listener`, on port 443. There is no port-80 listener by decision (`docs/archive/decisions/g1-no-plaintext-listener.md`);
- no `aws_nat_gateway` and no `aws_vpc_endpoint`;
- no Google resource at all: the push objects are `infra/roots/production-google`'s.

**Terraform reports every independent plan-time error in one run.** It does not stop at the first: the third rehearsal printed the Google credential failure and the `count` failure together, from different parts of the graph. So when a plan fails, send the **whole** list, not the first paragraph; two errors mean two changes, and fixing one and re-dispatching a rehearsal is how a run gets spent on an error that was already on the screen.

### 3.1 Rehearsal first, always

A release that touches schema, sending, suppression, Gmail, restore or job fencing runs the full recovery drill in rehearsal before production sees it (spec 16.2). The rehearsal root deploys **the exact digests proposed for production**.

**This is a workflow run, not a command you type.** `fss-rh-deploy` is assumable only from the `rehearsal` environment (section 1.1), so the commands below are what `.github/workflows/greenfield-release.yml` runs, written out so you can read them; typed on your Mac they are refused `sts:AssumeRole`, and that refusal is the boundary working. Dispatch the workflow instead: `docs/greenfield/release.md` section 3.

Two differences between what the workflow runs and what is written here. It passes **`-var="assume_deployment_role=false"`** on the apply and on the teardown's destroy, because its session already *is* `fss-rh-deploy` and the provider must not assume the role it already holds (section 1.1); and it runs `infra/scripts/rehearsal-caller-identity.sh fss-rh-deploy` first, which prints the session ARN and refuses anything that is not an assumed-role session of that role. Both appear in the credential-free plan `FSS_REHEARSAL_DRY_RUN=1` prints.

```bash
cd infra/roots/rehearsal
RUN_ID=$(date -u +%Y%m%d%H%M)
terraform init -reconfigure \
  -backend-config=backend.hcl \
  -backend-config="key=fss/greenfield/rehearsal/${RUN_ID}/terraform.tfstate" \
  -backend-config="kms_key_id=<state key arn>"

terraform plan -out=rehearsal.tfplan \
  -var="assume_deployment_role=false" \
  -var="name_prefix=fss-rh-${RUN_ID}" \
  -var="certificate_arn=<rehearsal acm arn>" \
  -var="api_hostname=<rehearsal hostname>" \
  -var="api_image=<api digest>" \
  -var="worker_image=<worker digest>" \
  -var='api_schema_range={min=1,max=1}' \
  -var='worker_schema_range={min=1,max=1}'

terraform apply rehearsal.tfplan
```

`name_prefix` must be `fss-rh-<run>`, 3 to 18 characters after the prefix. The root refuses `fss-prod` and anything starting with it, and refuses a deployment role outside `fss-rh-`.

Run the Appendix G scenarios here. Then tear the run down:

```bash
terraform destroy -var="assume_deployment_role=false" -var="name_prefix=fss-rh-${RUN_ID}" ...same vars...
```

`infra/scripts/rehearsal-teardown.sh` is what the workflow runs, and it repeats the caller-identity check before the destroy: the teardown step runs on `always()`, so it cannot assume the earlier step was reached. An identity that is not `fss-rh-deploy` stops the teardown with the environment still standing, which is the cheaper mistake.

Teardown caveat: the rehearsal journal bucket uses **GOVERNANCE** object lock with a one-day retention. Objects written during the run refuse deletion until that day passes, so a same-day `destroy` leaves the bucket behind. Either wait a day, or have the rehearsal role carry `s3:BypassGovernanceRetention` scoped to `fss-rh-*` buckets only. Do not put that permission on the production role.

### 3.2 Production, the network and data layer

```bash
cd infra/roots/production
terraform init -backend-config=backend.hcl -backend-config="kms_key_id=<state key arn>"

terraform plan -out=production.tfplan \
  -var="api_image=<api digest>" \
  -var="worker_image=<worker digest>" \
  -var='api_schema_range={min=1,max=1}' \
  -var='worker_schema_range={min=1,max=1}' \
  -var="bootstrap=true"          # THE FIRST APPLY ONLY. See below.

terraform apply production.tfplan
```

**`bootstrap=true` on the first apply of a brand-new environment, and never again.**

The database it creates is empty, and both binaries refuse to start unless the applied schema version is exactly the range they declare. An apply that started the services would create two of them crash-looping against a schema that does not exist yet, while the task that would fix it had not been launched. So `bootstrap=true` creates both services at **desired count zero**, and `infra/scripts/release-deploy.sh` (3.2a below) migrates and then scales them.

`bootstrap` decides the count a service is *created* at and nothing after that: both services carry `ignore_changes = [desired_count]` (lane g70), so passing `true` to an environment that is already running no longer scales it, and it is still never what an ordinary release wants. Every apply after the first one omits it; the default is `false`.

**A schema-change release on a running environment stops the services before this apply.** Its task definitions declare a strict `{N,N}` range the database has not reached yet, and an apply against running services repoints them at those definitions, so ECS starts tasks that exit 12 before anything has migrated (`docs/greenfield/release.md` 8.0af). The order is: plan to a file and read it, then stop, then apply the plan, then 3.2a:

```bash
infra/scripts/release-stop.sh infra/roots/production fss-prod --environment production
(cd infra/roots/production && terraform apply production.tfplan)
```

The apply replaces the task definitions and leaves both services at zero. A release with no migration needs no stop: the apply replaces the task definitions and ECS rolls the running services on to them at their current counts.

### 3.2a Migrate and start the services — the same script CI runs

```bash
cd <repository root>
export FSS_REHEARSAL_REPORTS="$HOME/fss-release-$(date -u +%Y%m%d%H%M)"

# Read it first. No credential is used and nothing is launched.
FSS_REHEARSAL_DRY_RUN=1 \
  infra/scripts/release-deploy.sh infra/roots/production fss-prod \
    --schema-change --api-digest "<api digest>" --worker-digest "<worker digest>"

# A schema change on a running environment: this ran before the apply (3.2).
#   infra/scripts/release-stop.sh infra/roots/production fss-prod --environment production

infra/scripts/release-deploy.sh infra/roots/production fss-prod \
  --schema-change \
  --api-digest "<api digest>" \
  --worker-digest "<worker digest>"
```

In order: with `--schema-change`, refuse unless both services are already at zero (the first apply created them there, or `release-stop.sh` put them there before the apply, in 3.2); `fss migrate` as a one-off ECS task, `fss admin database-users ensure`, `fss verify`, the worker to its declared count, the API to its, and `fss verify` again against the running deployment. It no longer stops the services itself, because by the time it runs the apply has already registered task definitions that refuse the old schema. Terraform no longer moves a count after the first apply, so steps 5 and 6 here are what put the declared numbers on the services. Without `--schema-change` it is the rolling path (`release.md` 4.1 and 8.0am): no one-off task at all, the worker's and then the API's declared count with no forced deployment, one wait for both, and the running-digest check that each service runs its declared number of tasks on the release's digest.

This is **the same script** `.github/workflows/greenfield-release.yml` runs for a rehearsal. The differences are the root in argument one and the credentials in your shell; production applies stay local by decision, because `fss-prod-deploy` trusts no OIDC subject and giving it one is a separate decision nobody has made. `infra/scripts/release-common.sh` refuses a production command that names a rehearsal resource exactly as it refuses the reverse.

It runs the migration as a task inside the VPC because there is no other way: the production database is `publicly_accessible = false`, there is no NAT gateway and no bastion, and nothing on your Mac has a route to it. `docs/greenfield/release.md` 4.1 lists every guard the launch is checked against.

`assume_deployment_role` is not in that list and must not be: its default is `true`, so the provider assumes `fss-prod-deploy` for you, which is the whole point of a local apply. The flag exists for a session that has *already* assumed its role, which is CI and never you (section 1.1). Passing `false` here would apply as your own admin principal rather than as the scoped deployment role, and nothing in the plan would say so.

`google_hosted_domain` defaults to `usecallie.com` and needs no `-var`; pass one only if the Workspace domain changes. An empty value is refused by variable validation at the root and again in the stack module, because an empty `hd` restriction admits every Google account there is.

Read the plan before applying it. Specifically confirm:

- every name begins `fss-prod`;
- `aws_db_instance.main` has `multi_az = true`, `deletion_protection = true`, `backup_retention_period = 35`, `storage_encrypted = true`;
- there is no `aws_nat_gateway` and no `aws_vpc_endpoint`;
- there is no `aws_secretsmanager_secret_version`;
- the ALB has exactly one listener, on 443;
- the two ECR repositories appear under **"has moved to"** and under nothing else. A plan that proposes to destroy, replace or recreate `fss-prod-api` or `fss-prod-worker` is a plan to delete the images the release record names. Stop; the `moved` block in `infra/modules/stack` is what makes the address change a migration rather than a replacement.

The RDS instance takes 10-20 minutes to become available with Multi-AZ. The ECS services will not stabilise until it is, because the tasks need the database.

### 3.3 Put the secret values in

```bash
aws secretsmanager put-secret-value --secret-id fss-prod/google-oidc-client --secret-string file:///dev/stdin
# paste, then Ctrl-D. Repeat for each entry in 1.4.
```

Use `file:///dev/stdin` rather than `--secret-string '<value>'` so the value never reaches shell history or the process table.

**Two of the eight entries are database identities, and they come first — before 3.2a, because the migration task cannot start without them.**

| Entry | What goes in it | Who reads it |
|---|---|---|
| `fss-prod/migration-database` | the RDS-managed master user's `username` and `password`, with this instance's `host`, `port` and `dbname` (the master JSON carries only the first two; `fss migrate` needs all five) | the migration execution role, and nothing else in the cluster |
| `fss-prod/app-runtime-database` | `{"username":"app_runtime_login","password":"<48 random bytes>","host":"<db endpoint host>","port":5432,"dbname":"<db name>"}` | the two services' execution roles, as `DATABASE_SECRET_ARN`; and the migration task, which is what creates the login user |

```bash
# The master credentials, copied from the entry RDS manages into the one the
# migration task reads. Neither value is echoed and neither reaches the process table.
aws secretsmanager get-secret-value \
  --secret-id "$(terraform -chdir=infra/roots/production output -raw database_master_secret_arn)" \
  --query SecretString --output text \
| aws secretsmanager put-secret-value \
    --secret-id fss-prod/migration-database --secret-string file:///dev/stdin

# The runtime user. You choose the password; nothing else ever sees it.
openssl rand -base64 48        # copy this
aws secretsmanager put-secret-value --secret-id fss-prod/app-runtime-database \
  --secret-string file:///dev/stdin
# paste {"username":"app_runtime_login","password":"…","host":"…","port":5432,"dbname":"…"}, then Ctrl-D.
```

Why the master credentials, and why this is not a permanent exception: migration 0001 creates `app_runtime` and `migration` as `NOLOGIN` **group** roles, so on a database that has never been migrated there is no login user that can run DDL and none can be created — the database is private and nothing can reach it. The master is the one credential that exists. `fss migrate` runs as it once, creating the group roles; `fss admin database-users ensure` then creates the `app_runtime_login` user the services connect as and grants `migration` to the master, so every later `fss migrate` passes its membership check for a reason rather than by the absence of one.

What this buys is the boundary David asked for on 21 September: **nothing in the cluster can read the RDS-managed master secret.** The two services resolve `app-runtime-database` and cannot resolve `migration-database`; the migration task resolves `migration-database` and holds no journal, no bucket and no KMS key beyond the one that decrypts its own entry. `infra/modules/cluster/tests/migration_identity.tftest.hcl` asserts all four halves offline.

Then force a new deployment so the tasks pick the values up:

```bash
aws ecs update-service --cluster fss-prod-cluster --service fss-prod-api --force-new-deployment
aws ecs update-service --cluster fss-prod-cluster --service fss-prod-worker --force-new-deployment
```

### 3.4 DNS

```bash
terraform output load_balancer_dns_name
terraform output load_balancer_zone_id
```

Create the ALIAS (or CNAME) record for the API hostname pointing at those. Confirm:

```bash
dig +short <production hostname>
curl -sS -o /dev/null -w '%{http_code} %{ssl_verify_result}\n' https://<production hostname>/healthz
```

Expect `200 0`. Expect `http://<hostname>` to **fail to connect**, not redirect: there is no port 80 listener by design.

### 3.5 Confirm the alert subscriptions

```bash
aws sns list-subscriptions-by-topic --topic-arn "$(terraform output -raw alert_topic_arn)" \
  --query 'Subscriptions[].{endpoint:Endpoint,arn:SubscriptionArn}' --output table
```

Any row whose `arn` is `PendingConfirmation` is **not** receiving alerts. Find the AWS confirmation email and click the link.

Then prove the path end to end rather than assuming it:

```bash
aws sns publish --topic-arn "$(terraform output -raw alert_topic_arn)" \
  --subject "FSS alert path test" --message "If you are reading this, the independent alert path works."
```

### 3.6 Gmail push

```bash
terraform output gmail_push_topic_id     # projects/<project>/topics/fss-prod-gmail-push
terraform output gmail_push_audience     # https://<hostname>/integrations/gmail/push
```

The API must be configured to require exactly that audience and exactly the service account in `push_service_account_email`. A token with a valid Google signature but the wrong audience or the wrong service-account email must be refused (Appendix G scenario 27). The Gmail `users.watch` call names the topic id above, which the apply has already put in both task definitions as `FSS_GMAIL_PUSH_TOPIC`.

Push does not work until the API hostname resolves and serves a valid certificate: Pub/Sub will not push to an endpoint it cannot verify.

## 4. Smoke checks after the apply

Production receives **safe** checks only. Every destructive case belongs in rehearsal.

```bash
# 1. The API answers and reports its schema range.
curl -sS https://<hostname>/healthz

# 2. Both services are steady at their desired count.
aws ecs describe-services --cluster fss-prod-cluster \
  --services fss-prod-api fss-prod-worker \
  --query 'services[].{name:serviceName,desired:desiredCount,running:runningCount,deployments:length(deployments)}' \
  --output table

# 3. The database is where it should be.
aws rds describe-db-instances --db-instance-identifier fss-prod-pg \
  --query 'DBInstances[0].{status:DBInstanceStatus,multiAz:MultiAZ,protected:DeletionProtection,backupDays:BackupRetentionPeriod,public:PubliclyAccessible,encrypted:StorageEncrypted}'
# expect: available, true, true, 35, false, true

# 4. The journal bucket refuses deletion.
aws s3api get-object-lock-configuration --bucket "$(terraform output -raw journal_bucket_name)"

# 5. Every alarm is in a known state, not INSUFFICIENT_DATA forever.
aws cloudwatch describe-alarms --alarm-name-prefix fss-prod \
  --query 'sort_by(MetricAlarms,&AlarmName)[].{name:AlarmName,state:StateValue}' --output table
aws cloudwatch describe-alarms --alarm-types CompositeAlarm --alarm-name-prefix fss-prod \
  --query 'CompositeAlarms[].{name:AlarmName,state:StateValue}' --output table

# 6. The canary proves scheduler-to-worker completion. Production's metrics are in
#    its own namespace, FSS/fss-prod; nothing publishes to the bare FSS any more.
aws cloudwatch get-metric-statistics --namespace FSS/fss-prod \
  --metric-name CanaryCompletionAgeSeconds --statistics Maximum \
  --start-time "$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)" --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --period 300

# 7. Sending is still disabled.
#    Spec 16.2: production sending stays off until the rehearsal gate passes,
#    the deployed digests match the rehearsal artifacts, and an authenticated
#    admin explicitly enables it. Confirm through the admin surface, not here.
```

A freshly applied stack will show several alarms in `INSUFFICIENT_DATA` until the applications start emitting. The heartbeat alarms treat missing data as **breaching**, so they will go to `ALARM` if the tasks are not publishing. That is correct: a worker that is not heartbeating is a worker that is not running.

## 5. Ongoing operations

| Operation | Command |
|---|---|
| Deploy a new digest (app-only) | promote CI's digests (`release-promote.sh image-digests.json --app-only`, `release.md` 2.1), set `api_image` / `worker_image` to them, `terraform plan` and read it — only the two service task definitions and the services' `task_definition` change — `terraform apply`, then `release-deploy.sh --api-digest … --worker-digest …` without `--schema-change` (3.2a): no one-off task, the declared counts, one wait, and the running-digest check, which also fails a service the circuit breaker rolled back. Smoke after (`release.md` 8.0am). |
| Widen a schema range | change `api_schema_range` / `worker_schema_range` and apply. Expand, migrate, contract: additive migration first, both binaries accepting the range, backfill, then behaviour. A strict `{N,N}` move is not a widening: plan, `release-stop.sh … --environment production`, apply, `release-deploy.sh --schema-change` (3.2). |
| Change an alarm threshold | the thresholds are variables in `infra/modules/alerts`; surface the one you need in the root and apply. Spec 13.3 says thresholds are configuration versioned with the release. |
| Rotate a secret value | `aws secretsmanager put-secret-value`, then `--force-new-deployment`. Terraform is not involved. **Except `app-runtime-database`**, whose value is a live PostgreSQL password: a put on its own leaves a secret the database refuses. Put the new value, then `fss admin database-users ensure --rotate-password` to alter the role to match, then force the deployment — and never re-put it as part of a redeploy (`release.md` 5.1 and 8.0s). |
| Add an alert recipient | append to the `alert_emails` literal in `infra/roots/production/main.tf` in a pull request, plan and apply, then confirm the subscription. |
| Point production at a restored copy | `docs/greenfield/runbooks/restore.md` (c): `terraform plan -var="active_database_host=<the copy's address>"` with the rest of the section 3.0 list. The plan must replace exactly the `api`, `worker`, `migration` and `operations` task definitions, differing only in `FSS_DATABASE_HOST`, and update the two services in place. Unset (`null`), every task definition carries the managed instance's address, as before the variable existed. |
| Tear down a rehearsal run | The release workflow does it on `always()`, through `infra/scripts/rehearsal-teardown.sh`: caller-identity check, then `terraform destroy` with the same `name_prefix` and `assume_deployment_role=false`. Mind the object-lock caveat in 3.1. |

Never run `terraform destroy` in the production root. Deletion protection on the database and the load balancer will stop it part-way and leave the stack half-removed, which is worse than either state.

## 6. What this lane could not verify

Written before the first apply, from the Terraform schema and the AWS documentation, checked offline. The list is as it stood then; what the credentialed runs and the first production apply settled is in `docs/archive/release-records.md`, and what is still open is `release.md` 8.1:

1. Whether ALB access-log delivery in `us-east-1` is accepted from the `logdelivery.elasticloadbalancing.amazonaws.com` service principal alone. If the load balancer reports an access-log permission error, set `elb_account_id` to the documented Elastic Load Balancing account for `us-east-1` and re-apply; the bucket policy adds the extra statement.
2. Whether the RDS parameter group values are all dynamic. `rds.force_ssl` is static and requires a reboot; the first apply creates the instance with the group attached, so it applies at creation.
3. Whether `db.t4g.small` is enough for the scheduler's one-minute pass plus Gmail sync. It is a guess based on one salesperson; watch `OldestRunnableJobAgeSeconds` and the CPU credit balance for the first week.
4. ~~The exact IAM policy text the two deployment roles need.~~ **Closed as prose, open as a cloud fact.** The policy is now `infra/policies/deployment-role-policy.json.tftpl`, both documents are rendered by `infra/scripts/render-deployment-role-policy.sh`, and the release suite fails when a resource type in this tree needs an action they do not allow (1.1a). What is still unverified is whether AWS agrees: every condition key and every resource-ARN shape below comes from the service authorization reference, and the only thing that settles them is `infra/scripts/check-deployment-role.sh` against the real roles, then a plan, then an apply.
5. **Whether `fss-rh-deploy` can read the RDS-managed master secret.** The release workflow assembles the rehearsal database URL in the job from the run's outputs plus `secretsmanager:GetSecretValue` on `database_master_secret_arn` (`docs/archive/decisions/g12c-the-rehearsal-database-url-is-derived.md`). RDS names that secret `rds!db-<id>`, which does **not** begin `fss-rh-`, so a policy scoped purely by name prefix will refuse it. Allow `secretsmanager:GetSecretValue` and `kms:Decrypt` on the specific secret the rehearsal root outputs — not on `*` — or the suite step fails with an `AccessDenied` and no connection string.
6. Whether `fss-rh-deploy` may create the two durable repositories in `infra/roots/rehearsal-registry`. It should: the names are `fss-rh-api` and `fss-rh-worker` and the condition is on the resource name. It is one apply, and it is the first thing in section 2.
7. **That a CI plan with `assume_deployment_role=false` reaches AWS at all.** With the flag off the provider has no `assume_role` block, which is the ordinary configuration for a process using ambient credentials — but nothing here has been run. The first workflow run is the proof, and the caller-identity step immediately above the plan prints the session ARN, so a failure at provider configuration can be read rather than guessed. The provider version this rests on is `hashicorp/aws` v5.100.0 under `~> 5.60`; `docs/archive/decisions/g12e-the-provider-does-not-reassume-its-own-session.md` has the schema evidence and what to re-check if the roots ever move to v6.
