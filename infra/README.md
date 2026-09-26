# `infra/` — FSS greenfield Terraform

Twelve reusable modules, four roots, and the two deployment roles' policies. Production
(`infra/roots/production`) has been applied since 23 September 2026 and runs in account
326255650484; `infra/roots/production-google` holds its Gmail push objects; each rehearsal
applies and destroys `infra/roots/rehearsal` under its own prefix.

```
infra/
  modules/
    network         VPC, two public task subnets, two private RDS subnets, no NAT, the security groups
    database        RDS PostgreSQL 16, Multi-AZ, customer key, 35-day PITR, deletion protection
    cluster         ECS cluster, API and worker Fargate services, execution and task roles for the API, worker, migration and drill
    edge            ALB, one TLS listener, access logs
    registry        two ECR repositories, immutable tags, scan on push
    secrets         two customer keys and EMPTY Secrets Manager entries
    journal         object-locked S3 suppression journal, deny-first bucket policy
    alerts          SNS topic, every spec 13.3 alarm, the critical and warning composites
    observability   encrypted 90-day log groups and the metric filters behind the alarms
    updates         private S3 + CloudFront OAC for signed Electron packages (production only)
    pubsub          Google Cloud Pub/Sub Gmail push with an OIDC token and an exact audience
    stack           the composition every root uses, and the environment guard
  roots/
    production          environment = "production", destroyable = false, name_prefix = "fss-prod"
    production-google   the four Gmail push objects in Google Cloud; the only Google provider (lane g85)
    rehearsal           environment = "rehearsal",  destroyable = true,  name_prefix = "fss-rh-<run>"
    rehearsal-registry  the two durable rehearsal ECR repositories, applied once, ever
  policies/
    deployment-role-policy.json.tftpl   one template, rendered for fss-rh-deploy and fss-prod-deploy
    terraform-resource-actions.json     every resource "aws_*" type in this tree and the actions it needs
  scripts/
    offline-gate.sh                     the same checks CI runs, runnable by hand with no credentials
    render-deployment-role-policy.sh    prints one role's policy document; makes no call
    check-deployment-role.sh            asks IAM whether a role may do what the next apply needs; read-only
```

## Running the gate

```bash
cd <repo root>
TERRAFORM=$(command -v terraform) infra/scripts/offline-gate.sh
```

Terraform 1.15.8, exactly: every root pins `required_version = "1.15.8"` and commits its `.terraform.lock.hcl` (darwin_arm64 and linux_amd64). `fmt`, `init -backend=false`, `validate` and `terraform test` only. No backend is ever configured and no AWS or Google credential is needed or wanted. Most runs are `command = plan` against `mock_provider`; a few are `command = apply`, which under a mocked provider also reaches nothing and is the only way to assert a value that depends on a computed attribute — a rendered bucket policy names the bucket ARN, and a real plan is exactly as blind (`docs/archive/decisions/g12j-mock-providers-keep-computed-values-unknown.md`). See `docs/archive/decisions/g1-terraform-version.md` for why this is not 1.5.7.

The policy half of the gate is not here: `infra/policies/**` is judged by `npm run test:release`, because it needs a resource-type walk and an IAM evaluation rather than Terraform.

## Reading order

1. `docs/greenfield/release.md` — how a change reaches production: app-only by CI, schema and infrastructure by hand.
2. `docs/greenfield/infra-topology.md` — what gets created and what each line is billed on.
3. `docs/greenfield/infra-apply-runbook.md` — how the stack was built the first time, and how to rebuild it from zero.
4. `docs/greenfield/runbooks/restore.md` — a point-in-time restore of production, and its quarterly hand smoke.
5. `docs/archive/decisions/g1-*.md` — every choice the specification left open.

## Two rules that hold everywhere in this tree

**No secret value, ever.** Terraform creates empty Secrets Manager containers and nothing else. There is no `aws_secretsmanager_secret_version`, no `aws_ssm_parameter`, no `random_password`. The RDS master password is generated, stored and rotated by RDS itself through `manage_master_user_password`, so it never enters a plan or state file. CI greps for all of these.

**One name, one namespace.** Every resource name derives from `name_prefix`. Production is exactly `fss-prod`; rehearsal is `fss-rh-<run>`. Each root's variable validation refuses the other's namespace, the stack module has the same guard as a precondition, and both root tests assert over the whole claimed-name inventory in both directions. `docs/archive/decisions/g1-structural-isolation.md` has the full argument.

**The layer Terraform cannot enforce is code too, now.** The two deployment IAM roles are what make the namespaces a boundary rather than a convention, and Terraform does not create them. Until 21 September the runbook described them in prose and the repository shipped nothing, so both policies were written by hand from that prose and the first apply that used them reported 25 errors in six classes. `policies/` holds the template; `test/release/deploymentRolePolicy.check.ts` walks this tree and fails when a resource type needs an action the rendered policy does not allow — or allows and then cancels with a blanket deny. `docs/greenfield/infra-apply-runbook.md` 1.1a has the commands and `docs/archive/decisions/g16-the-deployment-role-policy-is-code.md` the reasoning. The trust policies remain David's and are not in the repository.

## The old tree

`cloud/terraform` and `cloud/worker-terraform` were the previous stack; lane g95 deleted them from the repository, and the tag `legacy-final` holds them. The only thing read from them was the public state-backend identifiers: bucket `callie-sourcing-tfstate-326255650484`, lock table `callie-sourcing-tflock`. The greenfield roots use their own state keys under `fss/greenfield/` and CI fails if either points at a legacy key.
