# FSS greenfield infrastructure: apply runbook

**Lane:** G1 · **Roots:** `infra/roots/production`, `infra/roots/rehearsal` · **Audience:** David, running the applies.

Nothing in this repository has ever been applied. This lane had no AWS or Google credentials and ran only `terraform init -backend=false`, `validate`, `fmt` and mocked offline `terraform test`. Everything below is the first time these resources would exist.

Read section 1 in full before running anything in section 3. The order matters: several resources cannot be created until something outside Terraform exists first, and two of them (the ACM certificate and the Google OAuth consent screen) involve waiting on external validation.

## 0. Tooling

| Thing | Value |
|---|---|
| Terraform | 1.15.8 locally and in CI (`.github/workflows/greenfield-infra.yml`). The roots declare `>= 1.10.0`; the floor is the S3 native state lock. |
| Region | `us-east-1` |
| Account | `326255650484` |
| State bucket | `callie-sourcing-tfstate-326255650484` (already exists; created once by `cloud/scripts/bootstrap-terraform-state.sh`) |
| Lock table | `callie-sourcing-tflock` (already exists) |
| Production state key | `fss/greenfield/production/terraform.tfstate` |
| Rehearsal state key | `fss/greenfield/rehearsal/<run>/terraform.tfstate` |

Neither root provisions, modifies or grants access to the state bucket or the lock table. They are inputs.

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

The scoping on `fss-rh-deploy` is what makes Appendix G scenario 39 true in the cloud rather than only in the plan. The `fss-rh-` condition belongs on every statement that supports a resource ARN, including `iam:DeleteRole`, `rds:DeleteDBInstance`, `s3:DeleteBucket`, `ecs:DeleteService`, `secretsmanager:DeleteSecret` and `kms:ScheduleKeyDeletion`. Where a service has no resource-level permission, use a `aws:ResourceTag/NamePrefix` condition against the tag the stack sets on every resource.

Until those roles exist, `terraform plan` will fail at provider configuration. That is the intended failure: neither root will act as an unconstrained principal.

### 1.2 The DNS zone and the ACM certificates

1. Decide the production API hostname (`api_hostname`) and the rehearsal hostname. They must differ.
2. Request a public ACM certificate in **`us-east-1`** for the production API hostname. Note the ARN.
3. Add the CNAME records ACM asks for and wait for the certificate to reach `ISSUED`. This can take minutes; it will not complete until DNS resolves.
4. Repeat for the rehearsal hostname, or use a wildcard covering `*.rehearsal.<domain>` so that each run does not need a new certificate.
5. If the Electron package distribution gets a custom hostname, that certificate must **also** be in `us-east-1` (CloudFront requirement) and is a separate input to `infra/modules/updates`.

The DNS A/ALIAS record for the API hostname is created **after** the first apply, pointing at `load_balancer_dns_name` / `load_balancer_zone_id`. Creating it before the apply leaves a hostname resolving to nothing.

### 1.3 The Google Cloud project and OAuth consent screen

1. Create a Google Cloud project for production Gmail push. Note its id; it becomes `gcp_project_id`.
2. Enable the Cloud Pub/Sub API and the Gmail API in it.
3. Configure the OAuth consent screen as an **Internal** application in the Callie Workspace organisation.
4. Create two OAuth client credentials:
   - the **sign-in** client, for the Google OpenID Connect authorization-code flow with PKCE in the system browser;
   - the **Gmail** client, for the separate `gmail.readonly` + `gmail.send` grant.
5. Keep both client secrets to hand for step 1.4. Do not put either in a file in the repository, in a `tfvars` file, or in a shell history line.
6. If a rehearsal environment will exercise Gmail push, create a **separate** rehearsal project. `enable_gmail_push` in the rehearsal root refuses to turn on without its own `gcp_project_id`; that refusal is asserted offline.

### 1.4 The secret values

Terraform creates six **empty** Secrets Manager entries. It never holds a value and it never generates one. After the first apply (step 3.3), put the values in with the CLI. These are the entries and what goes in each:

| Entry | Content |
|---|---|
| `fss-prod/google-oidc-client` | sign-in OAuth client id and secret |
| `fss-prod/google-gmail-oauth-client` | Gmail OAuth client id and secret |
| `fss-prod/session-signing-key` | signing material for access sessions |
| `fss-prod/device-credential-pepper` | server-side pepper for the device credential hash |
| `fss-prod/llm-classifier-api-key` | reply-classifier provider key |
| `fss-prod/research-provider-credentials` | approved research provider credentials |

The RDS master password is **not** in that list. `manage_master_user_password` hands generation, storage and rotation to RDS, which writes it to its own Secrets Manager secret encrypted with the same customer key. Terraform never sees it and it never appears in state.

### 1.5 The alert recipients

Decide the addresses for `alert_emails`. Each one receives an AWS confirmation email after the first apply and **must click the link**. An unconfirmed subscription is silently no delivery. Step 3.5 has the check.

### 1.6 Sending prerequisites, before sending is enabled

Not infrastructure, but the apply is pointless without them and they take days, so start them now: SPF, DKIM and DMARC on the Callie sending domain, and Google Postmaster Tools registration. Spec 12.7 makes passing authentication a precondition of enabling automated sending, and the six-week new-domain ramp starts from the first healthy send.

## 2. Push the images first

Both services are deployed by **digest**. `api_image` and `worker_image` are validated against `@sha256:<64 hex>`; a tag is refused. The ECR repositories are created by this stack, so the very first apply is a chicken-and-egg:

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

## 3. The applies, in order

### 3.1 Rehearsal first, always

A release that touches schema, sending, suppression, Gmail, restore or job fencing runs the full recovery drill in rehearsal before production sees it (spec 16.2). The rehearsal root deploys **the exact digests proposed for production**.

```bash
cd infra/roots/rehearsal
RUN_ID=$(date -u +%Y%m%d%H%M)
terraform init -reconfigure \
  -backend-config=backend.hcl \
  -backend-config="key=fss/greenfield/rehearsal/${RUN_ID}/terraform.tfstate" \
  -backend-config="kms_key_id=<state key arn>"

terraform plan -out=rehearsal.tfplan \
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

Run the Appendix G scenarios and `docs/greenfield/restore-drill.md` here. Then tear the run down:

```bash
terraform destroy -var="name_prefix=fss-rh-${RUN_ID}" ...same vars...
```

Teardown caveat: the rehearsal journal bucket uses **GOVERNANCE** object lock with a one-day retention. Objects written during the run refuse deletion until that day passes, so a same-day `destroy` leaves the bucket behind. Either wait a day, or have the rehearsal role carry `s3:BypassGovernanceRetention` scoped to `fss-rh-*` buckets only. Do not put that permission on the production role.

### 3.2 Production, the network and data layer

```bash
cd infra/roots/production
terraform init -backend-config=backend.hcl -backend-config="kms_key_id=<state key arn>"

terraform plan -out=production.tfplan \
  -var="certificate_arn=<production acm arn>" \
  -var="api_hostname=<production hostname>" \
  -var="api_image=<api digest>" \
  -var="worker_image=<worker digest>" \
  -var='api_schema_range={min=1,max=1}' \
  -var='worker_schema_range={min=1,max=1}' \
  -var='alert_emails=["<address>"]' \
  -var="gcp_project_id=<production gcp project>"

terraform apply production.tfplan
```

Read the plan before applying it. Specifically confirm:

- every name begins `fss-prod`;
- `aws_db_instance.main` has `multi_az = true`, `deletion_protection = true`, `backup_retention_period = 35`, `storage_encrypted = true`;
- there is no `aws_nat_gateway` and no `aws_vpc_endpoint`;
- there is no `aws_secretsmanager_secret_version`;
- the ALB has exactly one listener, on 443.

The RDS instance takes 10-20 minutes to become available with Multi-AZ. The ECS services will not stabilise until it is, because the tasks need the database.

### 3.3 Put the secret values in

```bash
aws secretsmanager put-secret-value --secret-id fss-prod/google-oidc-client --secret-string file:///dev/stdin
# paste, then Ctrl-D. Repeat for each entry in 1.4.
```

Use `file:///dev/stdin` rather than `--secret-string '<value>'` so the value never reaches shell history or the process table.

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

The API must be configured to require exactly that audience and exactly the service account in `push_service_account_email`. A token with a valid Google signature but the wrong audience or the wrong service-account email must be refused (Appendix G scenario 27). The Gmail `users.watch` call names the topic id above.

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

# 6. The canary proves scheduler-to-worker completion.
aws cloudwatch get-metric-statistics --namespace FSS \
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
| Deploy a new digest | edit `api_image` / `worker_image`, `terraform plan`, read it, `terraform apply`. The circuit breaker rolls back a task that cannot pass its health check. |
| Widen a schema range | change `api_schema_range` / `worker_schema_range` and apply. Expand, migrate, contract: additive migration first, both binaries accepting the range, backfill, then behaviour. |
| Change an alarm threshold | the thresholds are variables in `infra/modules/alerts`; surface the one you need in the root and apply. Spec 13.3 says thresholds are configuration versioned with the release. |
| Rotate a secret value | `aws secretsmanager put-secret-value`, then `--force-new-deployment`. Terraform is not involved. |
| Add an alert recipient | append to `alert_emails`, apply, then confirm the subscription. |
| Tear down a rehearsal run | `terraform destroy` in the rehearsal root with the same `name_prefix`; mind the object-lock caveat in 3.1. |

Never run `terraform destroy` in the production root. Deletion protection on the database and the load balancer will stop it part-way and leave the stack half-removed, which is worse than either state.

## 6. What this lane could not verify

Every statement about resource behaviour here comes from the Terraform schema and the AWS documentation, checked offline. Nothing has been applied. In particular these are unverified and should be watched on the first apply:

1. Whether ALB access-log delivery in `us-east-1` is accepted from the `logdelivery.elasticloadbalancing.amazonaws.com` service principal alone. If the load balancer reports an access-log permission error, set `elb_account_id` to the documented Elastic Load Balancing account for `us-east-1` and re-apply; the bucket policy adds the extra statement.
2. Whether the RDS parameter group values are all dynamic. `rds.force_ssl` is static and requires a reboot; the first apply creates the instance with the group attached, so it applies at creation.
3. Whether `db.t4g.small` is enough for the scheduler's one-minute pass plus Gmail sync. It is a guess based on one salesperson; watch `OldestRunnableJobAgeSeconds` and the CPU credit balance for the first week.
4. The exact IAM policy text the two deployment roles need. Section 1.1 states the shape and the condition; the statement list will need one round of least-privilege iteration against a real plan.
