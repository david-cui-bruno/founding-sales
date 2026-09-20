# David's topology answers are root defaults, not a tfvars file

**Lane:** G12c · **Spec:** 16.2 · **Files:** `infra/roots/{production,rehearsal}/variables.tf` and their `tests/isolation.tftest.hcl`, `infra/modules/{cluster,database,stack}/outputs.tf`

## What went wrong

PR 134 recorded David's five answers (`docs/decisions/coord-topology-answers.md`) and
wrote the ones that are root inputs into `infra/roots/*/terraform.tfvars`.
`infra/.gitignore` ignores `*.tfvars`, and has since G1 for a good reason: *"Variable
files may carry environment detail. Roots take their values from the apply runbook and
the deployment role, never from a committed tfvars file."*

So the answers were written to files that were never committed, never reviewed and
never checked by CI. Answer 3 in particular — ARM64 — stayed unapplied while
`greenfield-images.yml` went on building `--platform linux/arm64` and nothing else.
The first release would have planned two task definitions declaring `X86_64`, and
Fargate would have looked for an x86 manifest that is not in the image index: a pull
failure, a rolled-back deployment and an error arriving from ECS rather than from a
plan somebody read.

## The decision

**The `.gitignore` line stays.** The reasoning in it is still correct: a tfvars file is
a place environment detail accumulates unreviewed, and the two roots already take
every genuinely per-apply value (`certificate_arn`, `api_hostname`, the digests, the
schema ranges, `alert_emails`, `gcp_project_id`) from the command line or the workflow.

**The answers become the defaults**, which is the one place in this repository that is
both version controlled and the value an apply actually uses when nobody types
anything. Each carries its reasoning in the variable's own description, and each is
asserted by a root `tftest`.

**The assertions are made against the plan, not against the variables.** A test saying
`var.cpu_architecture == "ARM64"` restates the default; it cannot fail for the reason
this blocker existed, which is that a value never reached the resource. Three new
outputs exist so the roots can assert the real thing:

| Output | Module | What it reads back |
|---|---|---|
| `task_runtime_platform` | `cluster` | `aws_ecs_task_definition.{api,worker}.runtime_platform[0]` |
| `service_shape` | `cluster` | task `cpu`/`memory` and service `desired_count` |
| `instance_shape` → `database_shape` | `database` | instance class, Multi-AZ, storage, retention, Performance Insights, `monitoring_interval` |

## What each answer became

| Answer | Production | Rehearsal |
|---|---|---|
| 3 · architecture | `cpu_architecture = "ARM64"`, validated `X86_64\|ARM64` at the root | same |
| 2 · database | `db.t4g.small`, Multi-AZ (a literal in `main.tf`) | `db.t4g.small`, Multi-AZ by default — **changed from G1** |
| 2 · tasks | 2 API + 1 worker, 512 CPU units / 1024 MiB each | 1 + 1, the same 512 / 1024 |
| 5 · WAF | `enable_waf = false` | same |
| 5 · Performance Insights | `database_performance_insights_enabled = false` | hard-wired `false` in `main.tf` |
| 5 · Container Insights | `container_insights = "disabled"` | hard-wired `"disabled"` |
| 5 · Enhanced Monitoring | not a root input at all: the database module's `monitoring_interval` defaults to `0` and the stack never passes it. Asserted as the zero it is, because a non-zero interval would also create an IAM role. |
| 5 · VPC flow logs | no flow-log resource exists anywhere in `infra/` (`docs/decisions/g1-no-flow-logs.md`). Nothing to default. |

Answers 1 and 4 are not root inputs: answer 1 is a statement about scope, and answer 4
(five KMS keys, logs sharing with alerts) landed in `infra/modules/stack/main.tf` as
`shared_with_alerts = true` before this lane.

Also recorded in the ignored tfvars and **not** moved into defaults: `api.usecallie.com`
and `api.rehearsal.usecallie.com`, their certificate ARNs, and `callie-fss`. Hostnames
and certificate ARNs stay required variables with no default — an apply against the
wrong hostname should be impossible to do by forgetting something — and `gcp_project_id`
stays `""` with the validation that refuses Gmail push without one. The release workflow
passes the rehearsal hostname and certificate from the `rehearsal` environment secrets;
the runbook passes production's by hand.

## The one change to a G1 decision, stated plainly

G1 defaulted the rehearsal database to `db.t4g.micro` and single-AZ, on the reasoning
that a rehearsal may be small. G12c defaults it to `db.t4g.small` **and Multi-AZ**,
because the rehearsal's most expensive and most load-bearing step is Appendix E step 1,
a point-in-time restore, and a single-AZ restore is not the operation production would
perform. `docs/greenfield/release.md` already describes the workflow's 180-minute
timeout as "a guess dominated by the Multi-AZ restore in Appendix E step 1", which was
not true of the plan until now.

This costs more per rehearsal. The variable is still there and `false` is still
accepted — the rehearsal root has no precondition against single-AZ, deliberately,
where production does — and `rehearsal_may_be_small_and_single_az` now asserts that
capability rather than the default. If David wants the cheaper default back, it is one
line and this paragraph is the argument to weigh against.
