# `infra/` — FSS greenfield Terraform

Eleven reusable modules and two roots. Nothing here has ever been applied.

```
infra/
  modules/
    network         VPC, two public task subnets, two private RDS subnets, no NAT, the security groups
    database        RDS PostgreSQL 16, Multi-AZ, customer key, 35-day PITR, deletion protection
    cluster         ECS cluster, API and worker Fargate services, four distinct IAM roles
    edge            ALB, one TLS listener, access logs, optional WAF
    registry        two ECR repositories, immutable tags, scan on push
    secrets         two customer keys and EMPTY Secrets Manager entries
    journal         object-locked S3 suppression journal, deny-first bucket policy
    alerts          SNS topic, every spec 13.3 alarm, the critical and warning composites
    observability   encrypted 90-day log groups and the metric filters behind the alarms
    updates         private S3 + CloudFront OAC for signed Electron packages
    pubsub          Google Cloud Pub/Sub Gmail push with an OIDC token and an exact audience
    stack           the composition every root uses, and the environment guard
  roots/
    production      environment = "production", destroyable = false, name_prefix = "fss-prod"
    rehearsal       environment = "rehearsal",  destroyable = true,  name_prefix = "fss-rh-<run>"
  scripts/
    offline-gate.sh the same checks CI runs, runnable by hand with no credentials
```

## Running the gate

```bash
cd <repo root>
TERRAFORM=$(command -v terraform) infra/scripts/offline-gate.sh
```

Terraform 1.15.8. `fmt`, `init -backend=false`, `validate` and `terraform test` only. Every test is `command = plan` against `mock_provider`; no backend is ever configured and no AWS or Google credential is needed or wanted. See `docs/decisions/g1-terraform-version.md` for why this is not 1.5.7.

## Reading order

1. `docs/greenfield/infra-topology.md` — what gets created and what each line is billed on. David approves this before the first apply.
2. `docs/greenfield/infra-apply-runbook.md` — what David creates by hand first, the order of applies, the smoke checks.
3. `docs/greenfield/restore-drill.md` — Appendix E steps 1 to 9 as commands, run in rehearsal.
4. `docs/decisions/g1-*.md` — every choice the specification left open.

## Two rules that hold everywhere in this tree

**No secret value, ever.** Terraform creates empty Secrets Manager containers and nothing else. There is no `aws_secretsmanager_secret_version`, no `aws_ssm_parameter`, no `random_password`. The RDS master password is generated, stored and rotated by RDS itself through `manage_master_user_password`, so it never enters a plan or state file. CI greps for all of these.

**One name, one namespace.** Every resource name derives from `name_prefix`. Production is exactly `fss-prod`; rehearsal is `fss-rh-<run>`. Each root's variable validation refuses the other's namespace, the stack module has the same guard as a precondition, and both root tests assert over the whole claimed-name inventory in both directions. `docs/decisions/g1-structural-isolation.md` has the full argument, including the one layer — the two deployment IAM roles — that Terraform cannot enforce and the runbook has to.

## The old tree

`cloud/terraform` and `cloud/worker-terraform` are the previous stack and are untouched by this lane. They stay until the D3 deletion. The only thing read from them was the public state-backend identifiers: bucket `callie-sourcing-tfstate-326255650484`, lock table `callie-sourcing-tflock`. The greenfield roots use their own state keys under `fss/greenfield/` and CI fails if either points at a legacy key.
