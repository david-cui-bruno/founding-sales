# Dedicated AWS accounts: the per-account checklist

**Lane:** G27 · **Audience:** David, by hand · **Decision:** 22 September 2026 — the
rehearsal and production move out of the shared account `326255650484` into two
dedicated member accounts under AWS Organizations, before the first production release.

Until now both environments lived in one account and were kept apart by the name
prefixes `fss-rh` and `fss-prod`, an IAM policy per prefix and a structural isolation
test. That is still true and still checked; a dedicated account is the outer wall the
prefix boundary sits inside, so that a mistake in the boundary costs a rehearsal rather
than production.

**Nothing in this document deletes anything.** The shared account keeps everything it
has: the legacy state bucket and lock table, the delegated worker that is still running,
the two deployment roles, the ECR repositories, the certificates. The old worker keeps
running there until its own cutover, and no step below touches it.

**Nothing in this document changes today's behaviour.** Every account-specific value in
the tree is now a variable, an environment variable or a `-backend-config` file, and
every one of them defaults to what the shared account uses. A run with no new settings
renders, plans and applies exactly what it did before this lane.

---

## 0. What is account-specific, and where it now lives

| Value | Where it comes from | Default today |
|---|---|---|
| Account id, Terraform | `var.aws_account_id` in each root (`TF_VAR_aws_account_id` or `-var`) | `326255650484` |
| Account id, the two rehearsal workflows | read from the session `aws-actions/configure-aws-credentials` obtained, and cross-checked against `vars.FSS_REHEARSAL_ACCOUNT_ID` when that is set | no literal anywhere |
| Account id, `render-deployment-role-policy.sh` | `FSS_POLICY_ACCOUNT_ID` | `326255650484` |
| Account id, `check-deployment-role.sh` | `FSS_CHECK_ROLE_ACCOUNT_ID` | `326255650484` |
| Account id, every release and rehearsal script | the caller's own session (`release_caller_account`, `REHEARSAL_SESSION_ACCOUNT`) | derived, never written |
| Region, Terraform | `var.aws_region` | `us-east-1` |
| Region, workflows | `vars.FSS_AWS_REGION` | `us-east-1` |
| Region, scripts | `AWS_REGION`, `FSS_POLICY_REGION`, `FSS_CHECK_ROLE_REGION` | `us-east-1` |
| State bucket, lock table, state region | `infra/roots/<root>/backend.hcl` — the per-account backend file, one per root | the shared account's |
| State KMS key | `-backend-config="kms_key_id=<arn>"` at init; `FSS_POLICY_STATE_KMS_KEY_ID` / `FSS_POLICY_STATE_KMS_KEY_ARN` for the policy | the shared account's state key |
| Role ARNs | `secrets.FSS_REHEARSAL_ROLE_ARN`; production's is built from `var.aws_account_id` | as configured |
| ECR registry hostnames | `secrets.FSS_REHEARSAL_API_REPOSITORY` / `…_WORKER_REPOSITORY`; production's from `terraform output` | as configured |
| Journal bucket name | `<prefix>-suppression-journal-<account id>`, derived by the module and by the teardown from the verified session | derived |

No workflow file and no script under `infra/scripts` writes the account id or the state
bucket name anywhere but a documented default assignment;
`test/release/accountAgnostic.check.ts` and `infra/scripts/offline-gate.sh` are what keep
that true.

**Each root belongs to exactly one account.** `infra/roots/rehearsal` and
`infra/roots/rehearsal-registry` run only in the rehearsal account;
`infra/roots/production` and `infra/roots/production-google` (lane g85: the Gmail push
objects, with its state in production's bucket under a key of its own) run only in the
production account. That is why each root's
`backend.hcl` can be that account's backend file rather than a switch between several.

---

## 1. The order, and roughly how long each step takes

Do these in order. Several steps cannot start until something in an earlier one exists,
and two of them wait on something outside AWS.

| # | Step | Where | Rough time |
|---|---|---|---|
| 1 | Create the two member accounts | Organizations, management account | 10 min + up to a few hours for account provisioning |
| 2 | Reach each account as `OrganizationAccountAccessRole` | your Mac | 10 min |
| 3 | Bootstrap Terraform state in each account | each account | 20 min each |
| 4 | Point each root's `backend.hcl` at its account | the repository | 10 min, one commit |
| 5 | GitHub OIDC provider + `fss-rh-deploy` in the rehearsal account | rehearsal account | 30 min |
| 6 | `fss-prod-deploy` in the production account | production account | 20 min |
| 7 | The rehearsal ECR repositories | rehearsal account, by workflow | 15 min |
| 8 | The production ECR repositories | production account, local | 15 min |
| 9 | Route 53 zone and ACM certificates | production account (and rehearsal) | 30 min + DNS validation wait |
| 10 | The eight production secret entries, created empty | production account | part of the apply |
| 11 | GitHub environment secrets and variables | repository settings | 15 min |
| 12 | The diagnostic credential in each account | both accounts | 20 min |
| 13 | One full rehearsal in the rehearsal account | CI | the usual rehearsal |

Budget most of a day, and start step 1 first because account provisioning is the only
part you cannot hurry.

---

## 2. Create the two member accounts

In the management account, Organizations → **Add an AWS account** → *Create an AWS
account*, twice:

| Account name | Root email | Purpose |
|---|---|---|
| `callie-rehearsal` | a `+`-addressed alias at `usecallie.com`, e.g. `aws-rehearsal@usecallie.com` | everything `fss-rh-*` |
| `callie-production` | e.g. `aws-production@usecallie.com` | everything `fss-prod-*` |

Rules for the two root emails:

- each must be a mailbox **you can receive at** — root password resets and account
  recovery go there and nowhere else;
- neither may be the management account's root email, and no two AWS accounts may share
  one;
- put both under the Workspace, not a personal address.

Leave `OrganizationAccountAccessRole` at its default name; step 3 uses it. Put each
account in its own organizational unit if you want an SCP later, but no SCP is required
for anything below.

**Immediately after each account is created:** set a long root password, turn on MFA for
the root user, and then stop using the root user. Everything below is done as
`OrganizationAccountAccessRole`.

*Record, for step 11: the twelve-digit account id of each.*

---

## 3. Reach each account

From your Mac, as the principal that administers the management account:

```bash
# The rehearsal account.
aws sts assume-role \
  --role-arn "arn:aws:iam::<rehearsal account id>:role/OrganizationAccountAccessRole" \
  --role-session-name callie-bootstrap

# Confirm where you are before doing anything. An ARN is a public identifier.
aws sts get-caller-identity --query Arn --output text
```

The last command is the habit the whole tree is built on: every script in
`infra/scripts` prints the identity it is about to act as and refuses one it does not
recognise. Do the same by hand, once per shell, before every step below.

---

## 4. Bootstrap Terraform state in each account

Each account needs its own state bucket, lock table and state key. `cloud/scripts/bootstrap-terraform-state.sh`
is the script that created the shared account's, but it **pins the shared account id and
the shared table name** (`expected_account_id`, `expected_table`) and writes a recovery
receipt under `~/.callie-bootstrap-receipts`. It is part of the old tree and this lane
did not change it. Either adapt it for the new account or do the minimal thing by hand;
the minimal thing is four resources.

For each account, with a session in that account:

```bash
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
REGION=us-east-1
BUCKET="callie-tfstate-${ACCOUNT}"
TABLE=callie-tflock

# 1. A customer-managed key for the state, with rotation.
KEY_ARN="$(aws kms create-key \
  --description "Terraform state for ${ACCOUNT}" \
  --query KeyMetadata.Arn --output text)"
aws kms enable-key-rotation --key-id "$KEY_ARN"
aws kms create-alias --alias-name alias/callie-tfstate --target-key-id "$KEY_ARN"

# 2. The bucket: versioned, encrypted with that key, public access blocked.
aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"
aws s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$BUCKET" \
  --server-side-encryption-configuration \
  "{\"Rules\":[{\"ApplyServerSideEncryptionByDefault\":{\"SSEAlgorithm\":\"aws:kms\",\"KMSMasterKeyID\":\"${KEY_ARN}\"},\"BucketKeyEnabled\":true}]}"
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# 3. The lock table. `use_lockfile = true` means S3 holds the lock as well, and the
#    table stays because the backend files name it and a mixed fleet is worse than one.
aws dynamodb create-table --table-name "$TABLE" \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST

echo "bucket=${BUCKET} table=${TABLE} key=${KEY_ARN}"
```

*Record, for steps 5, 6 and 11: the bucket name, the table name and the KMS key ARN of
each account.*

`us-east-1` is assumed throughout, and the ACM certificate for CloudFront must be in
`us-east-1` regardless. If either account uses another region, set `vars.FSS_AWS_REGION`
and the `region` line of the relevant `backend.hcl` and leave the CloudFront certificate
where it has to be.

---

## 5. Point each root's `backend.hcl` at its account

One commit in the repository. In each file, three values change and nothing else:

| File | Account |
|---|---|
| `infra/roots/rehearsal/backend.hcl` | rehearsal |
| `infra/roots/rehearsal-registry/backend.hcl` | rehearsal |
| `infra/roots/production/backend.hcl` | production |
| `infra/roots/production-google/backend.hcl` | production (the Google project does not move) |

```
bucket         = "callie-tfstate-<that account id>"
region         = "<that account's region>"
dynamodb_table = "callie-tflock"
```

Leave `key`, `encrypt` and `use_lockfile` alone: a state key names a root and a run and
means the same thing in every account, and the three keys must stay distinct and
namespaced (`infra/scripts/offline-gate.sh` checks that, and that the registry key is
outside the per-run space).

Run the offline gate before committing:

```bash
TERRAFORM=$(command -v terraform) infra/scripts/offline-gate.sh
npm run test:release
```

**Do not migrate the old state.** The greenfield tree has never been applied to
production, and the rehearsal state is per-run and disposable. Each root starts with an
empty state in its new account. If a rehearsal environment is standing in the shared
account when you do this, tear it down **first**, from the old backend, or it becomes an
orphan no state knows about.

---

## 6. The GitHub OIDC provider and `fss-rh-deploy`, in the rehearsal account

The provider first. It is one per account, and the two accounts need their own only if
both use OIDC — production does not, by decision (section 7).

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com
```

Then the role. **The subject is exact and carries no wildcard:**

```
repo:david-cui-bruno/founding-sales:environment:rehearsal
```

Trust policy, with `<rehearsal account id>` substituted:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<rehearsal account id>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:david-cui-bruno/founding-sales:environment:rehearsal"
        }
      }
    }
  ]
}
```

`StringEquals` on the subject, not `StringLike`, and one subject only. A `*` anywhere in
that string — `repo:david-cui-bruno/founding-sales:*` is the common one — lets any
branch of any pull request assume the role, which is the whole boundary gone. And
`fss-rh-deploy` must **not** trust itself: the workflows pass
`-var=assume_deployment_role=false` precisely so that no role chaining is needed
(`docs/decisions/g12e-the-provider-does-not-reassume-its-own-session.md`).

```bash
aws iam create-role --role-name fss-rh-deploy \
  --assume-role-policy-document file:///tmp/fss-rh-deploy-trust.json
```

Then the permission policy, from the repository, rendered for the new account:

```bash
FSS_POLICY_ACCOUNT_ID=<rehearsal account id> \
FSS_POLICY_REGION=us-east-1 \
FSS_POLICY_STATE_BUCKET=callie-tfstate-<rehearsal account id> \
FSS_POLICY_LOCK_TABLE=callie-tflock \
FSS_POLICY_STATE_KMS_KEY_ARN=<the rehearsal state key ARN from step 4> \
  infra/scripts/render-deployment-role-policy.sh fss-rh --pretty > /tmp/fss-rh-deploy-scope.json

infra/scripts/render-deployment-role-policy.sh fss-rh --sids   # read what is in it

aws iam put-role-policy --role-name fss-rh-deploy \
  --policy-name fss-rh-deploy-scope \
  --policy-document file:///tmp/fss-rh-deploy-scope.json
```

Also before the first apply in this account: the three service-linked roles the stack
leans on. ECS, the load balancer service and RDS each create their own service-linked
role on first use, and they do it **through the caller's credentials**. The first
discovery pass in the old account (23 September 2026, CloudTrail) showed ECS calling
`iam:CreateServiceLinkedRole` on `fss-rh-deploy`'s behalf and being refused; it was
harmless there only because `AWSServiceRoleForECS` had existed since April. A fresh
account has none of them, and the deployment role is not allowed to create IAM roles, so
create them once with your administrator profile. The call is idempotent: a second run
answers `InvalidInput` for a role that already exists, which is the wanted state.

```bash
for service in ecs.amazonaws.com elasticloadbalancing.amazonaws.com rds.amazonaws.com; do
  aws iam create-service-linked-role --aws-service-name "$service" \
    --query 'Role.RoleName' --output text || true
done
aws iam get-role --role-name AWSServiceRoleForECS --query 'Role.RoleName' --output text   # expect AWSServiceRoleForECS
```

And the read-only check, before any apply:

```bash
FSS_CHECK_ROLE_ACCOUNT_ID=<rehearsal account id> FSS_CHECK_ROLE_REGION=us-east-1 \
  infra/scripts/check-deployment-role.sh fss-rh-deploy fss-rh
```

`docs/greenfield/infra-apply-runbook.md` 1.1a is the fuller description of those three
commands, and 1.1b is discovery mode — which is still a rehearsal-only, one-pass thing
and is **not** something a fresh account needs by default. In a dedicated account the
policy's `fss-rh` prefix conditions are largely redundant; leave them. They cost nothing
and they are what `test/release/deploymentRolePolicy.check.ts` and Appendix G 39 are
written against.

---

## 7. `fss-prod-deploy`, in the production account

The three service-linked roles from section 6 are per account: run the same loop here
with your administrator profile before the first production apply.

Production applies stay local and the provider does the assuming. That model does not
change: `fss-prod-deploy` trusts **your** principal and no OIDC subject, so there is no
workflow anywhere that can apply to production.

Trust policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "<the ARN of the principal you administer from>" },
      "Action": "sts:AssumeRole",
      "Condition": { "Bool": { "aws:MultiFactorAuthPresent": "true" } }
    }
  ]
}
```

Until the production account has its own IAM user or SSO identity, that principal is
`arn:aws:iam::<production account id>:role/OrganizationAccountAccessRole` or the
management-account identity you assume it with. Decide which, write it down, and do not
leave it as the whole account (`"AWS": "arn:aws:iam::<id>:root"`).

Then the permission policy, exactly as in section 6 but for production:

```bash
FSS_POLICY_ACCOUNT_ID=<production account id> \
FSS_POLICY_REGION=us-east-1 \
FSS_POLICY_STATE_BUCKET=callie-tfstate-<production account id> \
FSS_POLICY_LOCK_TABLE=callie-tflock \
FSS_POLICY_STATE_KMS_KEY_ARN=<the production state key ARN from step 4> \
  infra/scripts/render-deployment-role-policy.sh fss-prod --pretty > /tmp/fss-prod-deploy-scope.json

aws iam put-role-policy --role-name fss-prod-deploy \
  --policy-name fss-prod-deploy-scope \
  --policy-document file:///tmp/fss-prod-deploy-scope.json

FSS_CHECK_ROLE_ACCOUNT_ID=<production account id> \
  infra/scripts/check-deployment-role.sh fss-prod-deploy fss-prod
```

**`s3:BypassGovernanceRetention` must never appear on `fss-prod-deploy`.** The renderer
refuses to emit it for `fss-prod` and `NoDeploymentDataAccess` denies it outright; check
anyway, because a production suppression journal its deployer can empty is not an
append-only record and Appendix E step 2 stops being a recovery:

```bash
aws iam get-role-policy --role-name fss-prod-deploy --policy-name fss-prod-deploy-scope \
  | grep -i BypassGovernanceRetention && echo "REMOVE THIS" || echo "ok"
```

`--discovery` is refused for `fss-prod` by the renderer. The production role is never
widened, in any account.

---

## 8. The ECR registries, per account

**Rehearsal** — the two durable repositories `fss-rh-api` and `fss-rh-worker` are
`infra/roots/rehearsal-registry`, and its apply is the **Greenfield rehearsal registry
apply** workflow, dispatched twice: once to plan and read the summary, once with
**apply** ticked. You never run it locally; `fss-rh-deploy` trusts only the `rehearsal`
environment. Section 2.1 of `docs/greenfield/infra-apply-runbook.md` is the full
description. The workflow now reads the account from the session it verified and the
bucket and table from `backend.hcl`, so steps 5 and 6 are all it needs.

After the apply, the run's summary prints the two repository URLs. They are the values
of `FSS_REHEARSAL_API_REPOSITORY` and `FSS_REHEARSAL_WORKER_REPOSITORY` in step 11 —
take them from there, not by hand.

**Production** — `infra/roots/production`, the one use of `-target`, local:

```bash
cd infra/roots/production
terraform init -backend-config=backend.hcl -backend-config="kms_key_id=<production state key arn>"
terraform apply -target=module.stack.module.registry
```

Then log in and push against the **production account's** registry hostname:

```bash
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin "${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com"
```

The two accounts have separate registries and no cross-account pull. The same image
digests are pushed to both, which is what makes the rehearsal a rehearsal of the exact
artefacts: build once, push to `fss-rh-api`/`fss-rh-worker` in the rehearsal account and
to `fss-prod-api`/`fss-prod-worker` in the production account, and check the digests
match. If you would rather grant the production account pull access to the rehearsal
repositories than push twice, that is a repository policy and a decision nobody has
made; pushing twice needs no trust between the accounts at all.

---

## 9. Route 53 and ACM, in the production account

The hosted zone for the sending and API domain moves with production. Certificates are
per-account: a certificate in the shared account cannot be used by a load balancer in
the production account.

1. Create (or delegate) the hosted zone for the domain in the **production** account.
   If the registrar's nameservers still point at the shared account's zone, change the
   delegation — and keep the old zone's records until the old worker's cutover, because
   the delegated worker still resolves through them.
2. Request a public ACM certificate in **`us-east-1`** in the production account for the
   production API hostname. Add the CNAMEs it asks for; wait for `ISSUED`.
3. Request the rehearsal certificate in the **rehearsal** account — a wildcard covering
   `*.rehearsal.<domain>` so that each run does not need a new one. Its validation CNAMEs
   go in the production account's zone, which is fine: validation is DNS, not IAM.
4. If the desktop update distribution gets a custom hostname, its certificate must also
   be in `us-east-1`, in the production account, and is a separate input to
   `infra/modules/updates`.
5. The A/ALIAS record for the API hostname is created **after** the first apply, pointing
   at `load_balancer_dns_name` / `load_balancer_zone_id`.

*Record, for step 11: the rehearsal certificate ARN (it is the `FSS_REHEARSAL_CERTIFICATE_ARN`
secret) and the production one (it is a `-var` on the local apply).*

Also in the production account, before the first apply: SPF, DKIM and DMARC on the
sending domain, and Google Postmaster Tools. Those take days to settle and the database
refuses `automated_sending_enabled` without all three
(`docs/greenfield/release.md` 1.4 and 6).

---

## 10. The eight production secret entries, created empty

`infra/modules/secrets` creates them; Terraform never writes, reads or plans a value.
The eight are:

```
google-oidc-client
google-gmail-oauth-client
session-signing-key
device-credential-pepper
llm-classifier-api-key
research-provider-credentials
migration-database
app-runtime-database
```

They arrive empty from the production apply, in the production account, named
`fss-prod/<logical name>`. The values are entered once by hand afterwards, with
`aws secretsmanager put-secret-value`, reading from stdin so nothing lands in a shell
history line — `docs/greenfield/infra-apply-runbook.md` 4 and `docs/greenfield/release.md`
have the exact commands and the JSON shape of the two Google entries.

`migration-database` and `app-runtime-database` are two entries on purpose: the identity
that may read one may not read the other, and nothing in the cluster may read the
RDS-managed master secret at all. Do not merge them.

None of these exists in the rehearsal account by hand. A rehearsal's entries are created
and filled by the run itself and destroyed at its teardown.

---

## 11. The GitHub environment secrets and variables

Repository settings → Environments → `rehearsal`. Update the five secrets to the
rehearsal account's values:

| Secret | New value |
|---|---|
| `FSS_REHEARSAL_ROLE_ARN` | `arn:aws:iam::<rehearsal account id>:role/fss-rh-deploy` |
| `FSS_REHEARSAL_API_REPOSITORY` | `<rehearsal account id>.dkr.ecr.us-east-1.amazonaws.com/fss-rh-api` |
| `FSS_REHEARSAL_WORKER_REPOSITORY` | `<rehearsal account id>.dkr.ecr.us-east-1.amazonaws.com/fss-rh-worker` |
| `FSS_REHEARSAL_CERTIFICATE_ARN` | the rehearsal wildcard certificate, in the rehearsal account |
| `FSS_REHEARSAL_API_HOSTNAME` | unchanged, e.g. `api.rehearsal.usecallie.com` |
| `FSS_REHEARSAL_STATE_KMS_KEY_ARN` (optional) | the rehearsal account's state key ARN from step 4 |

And these **repository variables**, which are new and are the account-agnosticism this
lane added. Both are optional; unset, everything behaves exactly as it does today.

| Variable | Value | What it does |
|---|---|---|
| `FSS_REHEARSAL_ACCOUNT_ID` | the rehearsal account id | Cross-checked against the account the workflow's session actually belongs to, and the run fails if they differ. It is a second statement of the same fact, so an environment pointed at the wrong account is caught before a plan rather than after an apply. |
| `FSS_REHEARSAL_STATE_BUCKET` | `callie-tfstate-<rehearsal account id>` | Cross-checked against `infra/roots/rehearsal-registry/backend.hcl`. Catches the case where the account moved and the backend file did not, which would otherwise write state into the old account silently. |
| `FSS_AWS_REGION` | the region, if not `us-east-1` | Sets `AWS_REGION` for both rehearsal workflows and `TF_VAR_aws_region` for the plan. |

`FSS_REHEARSAL_CARRY_WATERMARK` and `FSS_REHEARSAL_CARRY_TABLE` stay unset until the
cutover is scheduled, and must be set together or not at all.

No production credential, no production account id and no production role ARN goes into
GitHub. There is no production workflow and there must not be one.

---

## 12. The coordinator's diagnostic credential

The coordinator (and any agent lane) has **no credential** and must not obtain one. What
the operator sometimes runs on the coordinator's behalf is read-only, and in a dedicated
account it needs a principal in **that** account. Two kinds:

**In the rehearsal account:**

- `iam:SimulatePrincipalPolicy` on `arn:aws:iam::<rehearsal account id>:role/fss-rh-deploy`
  — `infra/scripts/check-deployment-role.sh`, which evaluates a policy and performs
  nothing;
- `cloudtrail:LookupEvents` — `infra/scripts/deployment-role-actions-used.sh`, the
  90-day management-event history, which needs no trail and prints no request
  parameters;
- `iam:GetRole`, `iam:GetRolePolicy`, `iam:ListRolePolicies` — to read back what the
  role holds before an apply;
- `sts:GetCallerIdentity`, which needs no permission at all.

**In the production account:** the same four, against `fss-prod-deploy`.

A `ReadOnlyAccess`-style managed policy covers all of it, but the four above are what is
actually used, and a credential scoped to them can be handed to a shell without any
further thought. It must not carry `iam:PutRolePolicy`, `iam:AttachRolePolicy` or
anything that mutates: every mutating command in this document is one the owner runs by
hand, from a directive, having read it.

Nothing in `.context/`, `docs/` or any lane's worktree holds a credential, and nothing in
this document asks for one to be stored anywhere.

---

## 13. Prove it

In order, and stop at the first failure:

```bash
# Offline, no credential, from the repository root.
TERRAFORM=$(command -v terraform) infra/scripts/offline-gate.sh
npm run test:release

# Read-only, in each account.
FSS_CHECK_ROLE_ACCOUNT_ID=<rehearsal account id> \
  infra/scripts/check-deployment-role.sh fss-rh-deploy fss-rh
FSS_CHECK_ROLE_ACCOUNT_ID=<production account id> \
  infra/scripts/check-deployment-role.sh fss-prod-deploy fss-prod
```

Then dispatch **Greenfield rehearsal registry apply** (plan only), read the summary, and
confirm three things in it: the caller identity is an assumed-role session of
`fss-rh-deploy` in the **new** account; the state line reads
`s3://callie-tfstate-<rehearsal account id>/fss/greenfield/rehearsal-registry/terraform.tfstate`;
and the plan creates only `fss-rh-api` and `fss-rh-worker` and destroys nothing. Then
dispatch again with **apply**.

Then one full rehearsal (`Greenfield release rehearsal`, stage `full`) in the new
account. Until that has passed, nothing touches production.

---

## 14. What must not change

- **Nothing in the shared account `326255650484` is deleted by any of this.** The
  legacy state bucket, the lock table, the old worker, the existing roles, the existing
  ECR repositories and the existing certificates all stay exactly where they are.
- **The old worker keeps running in the shared account until its own cutover.** It is
  not moved, not re-deployed and not touched here.
- **Production applies stay local.** `fss-prod-deploy` trusts your principal and no OIDC
  subject; `assume_deployment_role` stays `true` by default in all three roots so that a
  forgotten flag is a refusal rather than an apply as whatever credential was lying
  around.
- **The prefix boundary stays.** `fss-rh` and `fss-prod` name-prefix conditions, the
  production-inventory guard, the classifier and the isolation tests are all still there
  and still checked. In a dedicated account the discovery guards against the old stack
  are moot; they are harmless and they stay, because removing them would be a second
  change riding on this one.
- **The defaults in the repository stay the shared account's** until every step above is
  done and one full rehearsal has passed in the new account. That is what makes this
  reversible.
