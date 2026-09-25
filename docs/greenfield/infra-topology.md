# FSS greenfield infrastructure: costed topology

**Lane:** G1 (infrastructure) · **Spec:** `FSS-GREENFIELD-SPEC-REV3-20260919.md` sections 2, 3, 4.1, 12.6, 13.3 · **Status:** awaiting David's approval of the line items and the sizes.

This is the complete list of what the `production` root creates, what each line is billed on, and which variable changes it. **No dollar figure appears in this document.** Nobody on this lane has AWS or Google credentials, no pricing API was called, and a remembered price would be a guess. The last section is the one command that turns the table into numbers.

Region assumed throughout: `us-east-1`, the account the repository already names (`326255650484`).

## 1. How to read the table

- **Pricing dimension** is the unit AWS or Google actually bills. That is the number to look up.
- **Quantity** is what the production root provisions at its current defaults.
- **Variable** is the input in `infra/roots/production/variables.tf` that changes the quantity.
- **Rehearsal** is what the rehearsal root does with the same line. Rehearsal environments are created and destroyed by CI, so their cost is hours-per-run, not hours-per-month.

## 2. Compute and database

| Line item | Pricing dimension | Quantity (production default) | Variable | Rehearsal |
|---|---|---|---|---|
| RDS PostgreSQL 16 instance | Instance-hour for the class, **doubled by Multi-AZ** | 1 × `db.t4g.small`, Multi-AZ, 730 h/month | `database_instance_class` | 1 × `db.t4g.micro`, single-AZ, run duration only |
| RDS storage | GB-month of gp3, **doubled by Multi-AZ** | 50 GiB provisioned, autoscaling to 200 GiB | `database_allocated_storage`, `database_max_allocated_storage` | 20 GiB, no autoscaling |
| RDS provisioned IOPS / throughput | Only billed above the gp3 baseline | none above baseline at 50 GiB | n/a | none |
| RDS backup storage | GB-month of backup **beyond** the provisioned storage size | 35-day retention over a 50 GiB instance | fixed at 35 in the production root | 1 day |
| RDS Performance Insights | vCPU-month beyond the 7-day free retention | off | `database_performance_insights_enabled` | off |
| RDS Enhanced Monitoring | CloudWatch Logs ingestion per metric sample | off (`monitoring_interval = 0`) | module default | off |
| Fargate API tasks | vCPU-hour + GB-hour, per task, per architecture | 2 tasks × 0.5 vCPU × 1 GiB × 730 h | `api_desired_count`, `api_cpu`, `api_memory`, `cpu_architecture` | 1 task × 0.25 vCPU × 0.5 GiB |
| Fargate worker tasks | vCPU-hour + GB-hour | 1 task × 0.5 vCPU × 1 GiB × 730 h | `worker_desired_count`, `worker_cpu`, `worker_memory` | 1 task × 0.25 vCPU × 0.5 GiB |
| Fargate ephemeral storage | GB-month above the free 20 GiB per task | none above free | n/a | none |
| ECS cluster | No charge for the cluster itself | 1 | n/a | 1 |
| ECS Container Insights | Per custom metric and per log ingested | **disabled** | `container_insights` | disabled |

Cost levers worth David's attention, in order of size:

1. **Multi-AZ doubles both the instance and its storage.** It is not optional in production: spec section 2 and the invariant that PostgreSQL is authoritative both require it. Rehearsal is single-AZ by variable.
2. **`cpu_architecture = "ARM64"`** is a materially cheaper Fargate rate for the same vCPU and memory. It is `X86_64` today only because the images must be built for the target. If the G-lane image build produces arm64, switching this is a one-line change and the digest validation still holds.
3. **`api_desired_count = 2`** is for rolling deployment without a gap, not for load. One salesperson does not need two tasks for throughput. Dropping to 1 halves the API compute and means a deployment has a brief window with no API; the Electron cache covers a brief outage by design (spec 4.2).

**Database connections** are not billed but are bounded by the instance class: each API task holds at most 9 (a request pool of 8 plus its heartbeat, lane g75) and the worker `FSS_WORKER_CONCURRENCY + 2` (3 by default), so even a rolling API deployment at 200 % peaks near 36 + 3 plus a few one-off operations connections, far below a `db.t4g.small`'s default `max_connections` of roughly 200 — the arithmetic is in `docs/decisions/g75-one-connection-per-request.md`.

## 3. Network and edge

| Line item | Pricing dimension | Quantity | Variable | Rehearsal |
|---|---|---|---|---|
| Application Load Balancer | ALB-hour | 1 × 730 h | n/a | 1, run duration |
| ALB capacity | LCU-hour, the maximum of new connections, active connections, processed bytes and rule evaluations | expected to sit at the 1-LCU floor for one salesperson | n/a | 1-LCU floor |
| Public IPv4 addresses | Address-hour, charged per public IPv4 in use | ALB (2 subnets) + one per running task; 2 + 3 = 5 addresses at the default counts | falls with `api_desired_count`, `worker_desired_count` | 2 + 2 |
| NAT gateway | **Not used.** Gateway-hour and GB-processed | 0 | — | 0 |
| VPC interface endpoints | **Not used.** Endpoint-hour per AZ and GB-processed | 0 | — | 0 |
| Data transfer out to internet | GB out | Gmail and research provider traffic; small | n/a | small |
| WAFv2 | Web-ACL-month + rule-month + per million requests | **off** | `enable_waf` | off |
| ACM certificate | No charge for a public certificate on an ALB | 1 | n/a | 1 |

The no-NAT choice is the largest single saving in the network. A NAT gateway would be billed per hour **and** per GB processed, for every ECR pull and every Gmail call. Public addresses on the tasks cost per address-hour only, and the security groups mean nothing can reach the tasks from outside: the API admits only the ALB, the worker admits nothing at all. `infra/modules/network/tests/security_groups.tftest.hcl` asserts exactly that.

## 4. Storage, keys and secrets

| Line item | Pricing dimension | Quantity | Variable | Rehearsal |
|---|---|---|---|---|
| S3 suppression journal | GB-month + PUT/GET requests + object-lock has no separate charge | one small JSON object per suppression event, versioned, retained years | `journal_object_lock_retention_days` | 1-day lock, destroyed with the run |
| S3 ALB access logs | GB-month + PUT requests + lifecycle transitions | one log file per 5 minutes per node, expired at 365 days | `access_log_retention_days` (module) | expired fast, bucket force-destroyed |
| S3 Electron packages | GB-month + GET requests | a handful of signed builds, superseded versions expired at 365 days | module default | same |
| CloudFront | Per GB out to the internet, per 10,000 requests, per price class | `PriceClass_100` | `updates_price_class` | `PriceClass_100` |
| ECR | GB-month of stored images + data transfer | 2 repositories, 30 images retained each, untagged expired at 7 days | module defaults | same, force-deletable |
| KMS customer keys | Key-month per key + per 10,000 requests | **6 keys**: database, secrets, envelope, journal, logs, alerts | n/a | 6 keys, short deletion window |
| Secrets Manager | Per secret-month + per 10,000 API calls | 6 empty entries + 1 RDS-managed master user secret = 7 | `secret_names` | 7, zero-day recovery window |

Six customer keys is a deliberate choice, not an accident. Spec 4.1 wants the envelope key for refresh tokens separate from application secrets, and separating the journal key from the log key means an operator who can read logs still cannot decrypt suppression history. If David wants the line smaller, the honest consolidation is logs + alerts onto one key; the database, envelope and journal keys should stay separate.

## 5. Observability and alerting

| Line item | Pricing dimension | Quantity | Variable | Rehearsal |
|---|---|---|---|---|
| CloudWatch Logs ingestion | GB ingested | API + worker structured logs, bodies and secrets excluded | application behaviour | small |
| CloudWatch Logs storage | GB-month archived | 90-day retention | `log_retention_days` (stack) | 7 days |
| CloudWatch custom metrics | Per metric-month | heartbeats, job age, canary age, watch expiry, mailbox state, held counts, plus the log metric filters | application behaviour | same |
| CloudWatch alarms | Per standard alarm-month; metric-math and composite alarms are billed differently | 16 standard alarms + 1 metric-math alarm + 15 composite alarms (two roll-ups and 13 per critical condition), none with an action | thresholds are variables in `infra/modules/alerts` | same |
| Lambda + EventBridge Scheduler | Per request and GB-second; per scheduled invocation | the daily alarm digest: one 128 MB invocation a day at 07:00 America/New_York, inside both free tiers | `infra/modules/alerts/digest.tf` | same |
| SNS | Per million publishes; **email notifications are free** | one topic, one subscription per recipient, one digest publish a day | `alert_emails` | same |
| RDS log exports | CloudWatch Logs ingestion for `postgresql` and `upgrade` | `log_min_duration_statement = 1000` ms and DDL only, so the volume is slow queries and migrations, not traffic | `database_log_min_duration_statement` | same |

Email delivery through SNS is why "connected mailbox disconnected for 48 hours" can still reach David when every mailbox is disconnected. It does not use a Gmail grant. Since lane g99 the one e-mail is the daily alarm digest at 07:00 America/New_York; no alarm e-mails when it trips (`docs/greenfield/runbooks/README.md`). Each address must confirm its subscription once; the runbook has the check.

## 6. Google Cloud

| Line item | Pricing dimension | Quantity | Variable |
|---|---|---|---|
| Pub/Sub | GB of message throughput, with a monthly free allotment | one small notification per Gmail change; an address and a history id, never business state | `enable_gmail_push` |
| Pub/Sub push delivery | Included in throughput | one subscription | n/a |
| Service account, IAM | No charge | 1 service account, 1 topic IAM binding | n/a |

Gmail push volume for one mailbox is far below the Pub/Sub free allotment. The line is in the table so it is not forgotten, not because it is expected to cost anything.

## 7. What is deliberately not here

- **No NAT gateway, no VPC endpoints.** Section 3 explains why.
- **No standing staging environment.** Spec section 2: rehearsal environments are created and destroyed by CI. The steady-state cost of rehearsal is zero.
- **No SQS, no Lambda, no DynamoDB.** The job queue is a PostgreSQL table.
- **No CloudTrail trail in this root.** Control-plane audit logging is an account-level decision, not an application-stack one; see `docs/decisions/g1-cloudtrail-out-of-scope.md`.
- **No VPC flow logs.** They are billed per GB ingested and the ALB access logs plus the application logs cover what version one needs; see `docs/decisions/g1-no-flow-logs.md`.

## 8. The one command that turns this into numbers

Every row above names its pricing dimension, so David can price the whole table from the Pricing API in one pass. Run this **with credentials, from David's machine** — this lane has none and has run nothing against AWS:

```bash
# us-east-1 prices are served from the us-east-1 pricing endpoint.
for service in AmazonRDS AmazonECS AWSELB AmazonVPC AmazonS3 AmazonCloudFront \
               awskms AWSSecretsManager AmazonCloudWatch AmazonSNS AmazonECR; do
  aws pricing get-products \
    --region us-east-1 \
    --service-code "$service" \
    --filters 'Type=TERM_MATCH,Field=regionCode,Value=us-east-1' \
    --max-results 100 \
    --output json > "pricing-$service.json"
done
```

For a single answer per line rather than a dump, the AWS Pricing Calculator is faster and is what the numbers should be recorded from:

<https://calculator.aws/#/estimate>

Enter, in this order: RDS (db.t4g.small, Multi-AZ, 50 GB gp3, 35-day backup), Fargate (3 tasks at the CPU and memory above), ALB (1 load balancer, 1 LCU), public IPv4 (5 addresses), S3 (three small buckets), CloudFront (PriceClass_100, low GB), KMS (6 keys), Secrets Manager (7 secrets), CloudWatch (logs GB, custom metrics, 18 alarms), SNS (email only). Google Cloud Pub/Sub is priced separately at <https://cloud.google.com/pubsub/pricing> and is expected to fall inside the free allotment.

## 9. What David is approving

1. The **line items** above: that this is the whole bill and nothing is missing.
2. The **sizes**: `db.t4g.small` Multi-AZ, two API tasks and one worker task at 0.5 vCPU / 1 GiB.
3. The three **cost levers** in section 2 — in particular whether to build arm64 images and whether one API task is acceptable.
4. The **six KMS keys**, or the consolidation named in section 4.
5. That **WAF, Performance Insights, Enhanced Monitoring, Container Insights and flow logs stay off** until something asks for them.

## 10. The Google root (lane g85, 25 September 2026)

Section 6's Google Cloud lines are no longer created by the `production` root. Since lane
g85 they belong to **`infra/roots/production-google`**, a fourth root. It holds the four
Gmail push objects and nothing else, and its state key is
`fss/greenfield/production-google/terraform.tfstate`, in the production state bucket and
lock table. The quantities and pricing dimensions in section 6 are unchanged. Only the
root that manages them, and the variable column, changed:

| Line item | Root | Variable |
|---|---|---|
| Pub/Sub topic `fss-prod-gmail-push` | `production-google` | none; `name_prefix` is fixed at `fss-prod`, the project is `gcp_project_id` (default `callie-fss`) |
| Pub/Sub push subscription `fss-prod-gmail-push` | `production-google` | `api_hostname` and `gmail_push_path` build its endpoint and audience |
| Service account `fss-prod-gmail-push`, 1 topic IAM binding | `production-google` | none |

`enable_gmail_push` is gone. The `production` root declares no Google provider and
creates nothing in Google Cloud. It carries the topic id and the push service account as
the committed defaults of `gmail_push_topic` and `gmail_push_service_account`, so an
ordinary production plan needs no Google login (audit O01). The Google root is planned
only when one of its objects changes, with application-default credentials. The root
list is now:

```
roots/
  production          AWS only, environment = "production", name_prefix = "fss-prod"
  production-google   Google only: the Gmail push topic, subscription, service account and publisher grant
  rehearsal           AWS only, name_prefix = "fss-rh-<run>"
  rehearsal-registry  the two durable rehearsal ECR repositories
```

`docs/decisions/g85-the-google-provider-has-its-own-root.md` has the reasoning.
`docs/greenfield/google-root-migration-runbook.md` is the one-time move of the existing
objects into the new root's state.
