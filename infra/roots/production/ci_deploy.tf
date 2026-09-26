# The role CI deploys an app-only change to production with (lane g91).
#
# David's decision of 25 September 2026, 21:15Z: "I'm a startup, I want to move
# fast." A merge to main that changes only application code is deployed to
# production by `.github/workflows/greenfield-deploy.yml`, with no operator in the
# loop. Schema and infrastructure changes keep the manual path: an operator reads a
# plan of this root and applies it, and `infra/scripts/release-deploy.sh` does the
# rest (`docs/greenfield/release.md` section 4).
#
# This role is what the workflow holds, and it is deliberately small. It is not
# `fss-prod-deploy`, which Terraform assumes and which may create and destroy
# anything in the `fss-prod` namespace; that role trusts no OIDC subject and this
# lane does not change it. `fss-prod-ci-deploy` can do exactly six things:
#
#   1. read the two images from the rehearsal repositories CI published them to, and
#      copy them by digest into the two production repositories
#      (`infra/scripts/release-promote.sh <image-digests.json> --app-only`);
#   2. read the two services and their task definitions, register a new revision of
#      each carrying only the new image digest, and deregister a revision it
#      registered when that revision differs from the running one in anything but
#      the image, or when its rollout was rolled back;
#   3. point each service at a revision of its own family, and nothing else;
#   4. watch the rollout: the services' tasks, and the two services' logs when a
#      rollout fails;
#   5. read the canary metric the production smoke judges;
#   6. put the release record for the two digests it deployed, after the smoke passed
#      (lane g100): run the operations task in the production cluster, the one-off
#      `fss admin release-record put --json-base64` that `release-deploy.sh
#      --release-record` runs, and read that task's log for the put's answer.
#
# ## The residual this lane accepts, in two sentences
#
# A job holding this role can register a revision of `fss-prod-api` or
# `fss-prod-worker` with any image pushed to their two repositories and roll it out,
# because IAM has no condition on a task definition's contents and a main-branch
# workflow can deploy whatever main contains; that is the price of continuous
# deployment, and `ci-deploy-app.sh` narrows it in code by deriving every revision
# from the running one and deregistering any that differs in more than the image.
# What bounds it is the `production-deploy` environment restricted to main, no
# `id-token: write` in any job that runs code from the images commit, the exact OIDC
# subject below, ECR writes only to the two `fss-prod` repositories, and task roles
# that cannot change, because `iam:PassRole` names only the two services' existing
# four.
#
# A second, narrower residual: `UpdateService` requires `ecs:task-definition` to name
# the service's own family, so a call without a task definition is refused, but IAM
# has no condition on the other fields of the same call, so a call that names an
# allowed revision can also change `desiredCount`. The script never sends one.
#
# It has no Terraform state, no secret, no database, no bucket, no key and no IAM
# write. `iam:PassRole` names the two services' four roles, and only for ECS, because
# registering a task definition that names a task role and an execution role is a
# pass of both. The migration and drill task definitions are not CI's business: the
# policy names neither their families nor their roles.
#
# ## The release record's put, and its residual (lane g100)
#
# Once sending is on, the worker sends only under a stored release record naming its
# digest, so a CI deploy that stored none would hold sending until somebody put one by
# hand. So after the rollout and the smoke the workflow builds the ci-gate record
# (`release-record-from-ci.sh`) and puts it the way `release-deploy.sh
# --release-record` does: `ecs:RunTask` of the operations family, which runs the
# worker image under the worker's task and execution roles and writes to the worker's
# log group with the stream prefix `operations` (`infra/modules/cluster`). So the
# grant is `ecs:RunTask` on that family's revisions, conditioned on the production
# cluster; `ecs:TagResource` on that cluster's tasks, only as part of `RunTask`,
# because the wrapper propagates the task definition's tags onto the task; and nothing
# else — the `iam:PassRole` and the log read below already name the worker's two roles
# and the worker's log group, and `ecs:DescribeTasks` is already there. The network
# the task is launched into is three public identifiers the workflow reads from
# repository variables, never from state (`docs/greenfield/release.md` 4.0).
#
# IAM has no condition on a task's command or environment overrides, so a job holding
# this role can run any `fss` command on the operations task, as the worker's task role
# with the runtime database credential. It could already reach exactly that identity:
# it registers worker revisions with any image in `fss-prod-worker` and rolls them. The
# put adds a second way to the same identity, not a new one; `ci-deploy-app.sh record`
# runs one command, and the family, the cluster and the four roles `iam:PassRole`
# names bound what any other call could reach.
#
# ## The trust is one subject, and it is not a pattern
#
# Only the GitHub Actions OIDC provider may assume the role, and only for a job of
# this repository running in the `production-deploy` environment:
# `repo:david-cui-bruno@196666240/founding-sales@1351406527:environment:production-deploy`, compared with
# `StringEquals`. GitHub puts the environment in the subject in place of the branch,
# so the environment's deployment-branch rule — main only, set by the operator when
# the environment is created — is what keeps a dispatch from another branch out, and
# the workflow refuses anything but main as well. No `StringLike`, no wildcard, no
# `Principal: *`, and no AWS principal at all: nobody's laptop can assume this role.
#
# This is GitHub's default subject format. It names neither the workflow nor the event,
# so any job of this repository that may use the environment gets it, and a repository
# that opts into immutable subjects (owner and repository ids) stops matching it. A
# customized subject claim that adds the workflow, ref and event is the optional
# tightening: change this literal, its test and the repository's claim together
# (`docs/greenfield/release.md` 4.0).
#
# The OIDC provider is the account's existing one — the rehearsal role trusts it
# already — so its ARN is built from the account and not read with a data source,
# and this root creates no provider.
#
# ## Where a statement has `Resource: "*"`, and why
#
# Six, each for an action that has no resource to name, and the root test
# (`tests/ci_deploy_role.tftest.hcl`) holds the list to these six:
#
#   * `ecr:GetAuthorizationToken` — the registry sign-in takes no resource;
#   * `ecs:DescribeTaskDefinition` — read-only, and documented with no resource-level
#     permission;
#   * `ecs:DeregisterTaskDefinition` — documented with no resource-level permission,
#     as in `TaskDefinitionApisTakeNoResource` of the deployment roles' policy. It
#     marks a revision INACTIVE and stops no running task; the script only ever
#     deregisters the revision it has just registered;
#   * `cloudwatch:GetMetricStatistics` — read-only; metric reads take no resource.
#     It is what the smoke's canary age is read with;
#   * `ecs:RegisterTaskDefinition` — no resource-level permission either, so it is
#     conditioned instead: the request must carry the `NamePrefix` tag of this
#     namespace, which every task definition here carries and CI copies over;
#   * `ecs:ListTasks` — conditioned on `ecs:cluster`, the production cluster's ARN.
#
# Every other statement names its resources, and every resource it names is in the
# `fss-prod` namespace except `fss-rh-api` and `fss-rh-worker`, which the policy may
# only read.
#
# ## How Terraform and CI share the two service task definitions
#
# `infra/modules/cluster` gives `aws_ecs_task_definition.api` and `.worker`
# `track_latest = true`, so Terraform reads the newest ACTIVE revision of each
# family — the one CI registered — as its own. A plan given the deployed digests
# (`infra/scripts/deployed-digests.sh fss-prod`) therefore shows no change to either
# task definition or either service, and an infrastructure change that does touch a
# task definition registers the next revision from the running images and re-points
# the service, exactly as it did before CI deployed anything. A plan given older
# digests would put the older images back, and it says so in the plan: the drift
# rule in `docs/greenfield/release.md` 4.0 is to read the deployed digests first.

locals {
  ci_deploy_role_name = "${var.name_prefix}-ci-deploy"

  # GitHub's OIDC issuer, the account's provider for it, and the one subject the
  # role trusts. The repository and the environment are literals on purpose: a
  # variable would be a way to widen the trust with one `-var`.
  ci_deploy_oidc_issuer = "token.actions.githubusercontent.com"
  # This repository issues immutable OIDC subjects (`use_immutable_subject`): the owner and
  # repository carry their numeric ids, so a renamed or re-created repository cannot inherit
  # the trust. The rehearsal role's trust uses the same form. The plain form
  # `repo:david-cui-bruno/founding-sales:environment:production-deploy` was refused on the
  # first run (25 Sep 2026 23:42Z, "Not authorized to perform sts:AssumeRoleWithWebIdentity").
  ci_deploy_oidc_provider = "arn:aws:iam::${var.aws_account_id}:oidc-provider/${local.ci_deploy_oidc_issuer}"
  ci_deploy_subject       = "repo:david-cui-bruno@196666240/founding-sales@1351406527:environment:production-deploy"

  # Every name below comes from the stack's own outputs where the stack publishes it,
  # so a renamed cluster, service, task role or log group moves the policy with it.
  ci_deploy_services  = ["api", "worker"]
  ci_deploy_arn_ecs   = "arn:aws:ecs:${var.aws_region}:${var.aws_account_id}"
  ci_deploy_cluster   = "${local.ci_deploy_arn_ecs}:cluster/${module.stack.cluster_name}"
  ci_deploy_service   = { api = module.stack.api_service_name, worker = module.stack.worker_service_name }
  ci_deploy_task_role = { api = module.stack.api_task_role_name, worker = module.stack.worker_task_role_name }

  # The two families CI registers into: the services' own, never a one-off's.
  ci_deploy_family_arn = { for service in local.ci_deploy_services : service => "${local.ci_deploy_arn_ecs}:task-definition/${local.ci_deploy_service[service]}:*" }

  # The one family CI runs a task of (lane g100): the operations task, for the release
  # record's put. Its revisions are Terraform's; CI registers none.
  ci_deploy_operations_family_arn = "${local.ci_deploy_arn_ecs}:task-definition/${module.stack.operations_task_definition_family}:*"
  ci_deploy_cluster_tasks         = "${local.ci_deploy_arn_ecs}:task/${module.stack.cluster_name}/*"

  # The execution roles are not a stack output; `infra/modules/cluster` names them
  # `<prefix>-<service>-exec`. A mismatch is a refused registration, never a wider one.
  ci_deploy_pass_roles = flatten([
    for service in local.ci_deploy_services : [
      "arn:aws:iam::${var.aws_account_id}:role/${local.ci_deploy_task_role[service]}",
      "arn:aws:iam::${var.aws_account_id}:role/${var.name_prefix}-${service}-exec",
    ]
  ])

  # The rehearsal repositories are the two stable ones `infra/roots/rehearsal-registry`
  # owns, which CI's `publish` job pushes to. Read only.
  ci_deploy_source_repositories      = [for service in local.ci_deploy_services : "arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/fss-rh-${service}"]
  ci_deploy_destination_repositories = [for service in local.ci_deploy_services : "arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/${var.name_prefix}-${service}"]

  ci_deploy_log_groups = flatten([
    for service in local.ci_deploy_services : [
      "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:${module.stack.log_group_names[service]}",
      "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:${module.stack.log_group_names[service]}:*",
    ]
  ])

  ci_deploy_trust_policy = {
    Version = "2012-10-17"
    Statement = [{
      Sid       = "GitHubActionsInTheProductionDeployEnvironmentOnly"
      Effect    = "Allow"
      Principal = { Federated = local.ci_deploy_oidc_provider }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${local.ci_deploy_oidc_issuer}:aud" = "sts.amazonaws.com"
          "${local.ci_deploy_oidc_issuer}:sub" = local.ci_deploy_subject
        }
      }
    }]
  }

  ci_deploy_policy = {
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid      = "SignInToTheRegistry"
          Effect   = "Allow"
          Action   = ["ecr:GetAuthorizationToken"]
          Resource = ["*"]
        },
        {
          # release-promote.sh reads each digest in the rehearsal repository and reads
          # production back after the copy; `imagetools create` pulls the manifest and
          # its blobs from the source.
          Sid    = "ReadTheRehearsalAndProductionImages"
          Effect = "Allow"
          Action = [
            "ecr:BatchCheckLayerAvailability",
            "ecr:BatchGetImage",
            "ecr:DescribeImages",
            "ecr:DescribeRepositories",
            "ecr:GetDownloadUrlForLayer",
          ]
          Resource = concat(local.ci_deploy_source_repositories, local.ci_deploy_destination_repositories)
        },
        {
          # The copy writes into production and only into production: the rehearsal
          # repositories are CI's `publish` job's, under the rehearsal role.
          Sid    = "CopyIntoTheProductionRepositories"
          Effect = "Allow"
          Action = [
            "ecr:CompleteLayerUpload",
            "ecr:InitiateLayerUpload",
            "ecr:PutImage",
            "ecr:UploadLayerPart",
          ]
          Resource = local.ci_deploy_destination_repositories
        },
        {
          # The cluster's own Environment tag, which the deploy refuses to act without.
          Sid      = "ReadTheProductionCluster"
          Effect   = "Allow"
          Action   = ["ecs:DescribeClusters"]
          Resource = [local.ci_deploy_cluster]
        },
      ],
      [
        {
          Sid      = "ReadTheTwoServices"
          Effect   = "Allow"
          Action   = ["ecs:DescribeServices"]
          Resource = [for service in local.ci_deploy_services : "${local.ci_deploy_arn_ecs}:service/${module.stack.cluster_name}/${local.ci_deploy_service[service]}"]
        },
      ],
      [
        # One statement per service, so each may only be pointed at its own family.
        # `ArnLike`, not `ArnLikeIfExists`: a call that names no task definition — a
        # bare `--desired-count 0`, say — carries no `ecs:task-definition` key and is
        # refused. IAM cannot also forbid `desiredCount` on a call that does name an
        # allowed revision; that is the accepted residual in the header.
        for service in local.ci_deploy_services : {
          Sid      = "Roll${title(service)}OnItsOwnFamily"
          Effect   = "Allow"
          Action   = ["ecs:UpdateService"]
          Resource = ["${local.ci_deploy_arn_ecs}:service/${module.stack.cluster_name}/${local.ci_deploy_service[service]}"]
          Condition = {
            ArnLike = { "ecs:task-definition" = local.ci_deploy_family_arn[service] }
          }
        }
      ],
      [
        {
          Sid      = "ReadTaskDefinitionsWhichTakeNoResource"
          Effect   = "Allow"
          Action   = ["ecs:DescribeTaskDefinition"]
          Resource = ["*"]
        },
        {
          # The rollback of a revision this job registered: one that differs from the
          # running revision in more than the image, or whose rollout ECS rolled back.
          Sid      = "DeregisterWhichTakesNoResource"
          Effect   = "Allow"
          Action   = ["ecs:DeregisterTaskDefinition"]
          Resource = ["*"]
        },
        {
          Sid      = "RegisterRevisionsCarryingThisNamespace"
          Effect   = "Allow"
          Action   = ["ecs:RegisterTaskDefinition"]
          Resource = ["*"]
          Condition = {
            StringEquals = { "aws:RequestTag/NamePrefix" = var.name_prefix }
          }
        },
        {
          # Registering with tags is also a TagResource on the new revision. Only then,
          # and only in the two service families.
          Sid      = "TagOnlyTheRevisionsItRegisters"
          Effect   = "Allow"
          Action   = ["ecs:TagResource"]
          Resource = [for service in local.ci_deploy_services : local.ci_deploy_family_arn[service]]
          Condition = {
            StringEquals = { "ecs:CreateAction" = "RegisterTaskDefinition" }
          }
        },
        {
          Sid      = "ListTasksInTheProductionCluster"
          Effect   = "Allow"
          Action   = ["ecs:ListTasks"]
          Resource = ["*"]
          Condition = {
            ArnEquals = { "ecs:cluster" = local.ci_deploy_cluster }
          }
        },
        {
          Sid      = "ReadTasksInTheProductionCluster"
          Effect   = "Allow"
          Action   = ["ecs:DescribeTasks"]
          Resource = [local.ci_deploy_cluster_tasks]
        },
        {
          # The release record's put (lane g100): a revision of the operations family,
          # in the production cluster and no other. `ArnEquals`, not `IfExists`: a call
          # that names no cluster runs in `default` and is refused.
          Sid      = "RunTheOperationsTaskInTheProductionCluster"
          Effect   = "Allow"
          Action   = ["ecs:RunTask"]
          Resource = [local.ci_deploy_operations_family_arn]
          Condition = {
            ArnEquals = { "ecs:cluster" = local.ci_deploy_cluster }
          }
        },
        {
          # The put's task carries the operations definition's tags
          # (`--propagate-tags TASK_DEFINITION`), and tagging on creation is authorized
          # as a TagResource. Only on a task in the production cluster, and only as part
          # of RunTask: never a tag on anything that already exists.
          Sid      = "TagOnlyTheTasksItRuns"
          Effect   = "Allow"
          Action   = ["ecs:TagResource"]
          Resource = [local.ci_deploy_cluster_tasks]
          Condition = {
            StringEquals = { "ecs:CreateAction" = "RunTask" }
          }
        },
        {
          # The operations task runs under the worker's task and execution roles, so the
          # release record's put needs no role beyond these four (lane g100).
          Sid      = "PassOnlyTheTwoServicesRolesToEcs"
          Effect   = "Allow"
          Action   = ["iam:PassRole"]
          Resource = local.ci_deploy_pass_roles
          Condition = {
            StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" }
          }
        },
        {
          # A failed rollout's stopped tasks, read back so the run says why; and the
          # release record's put, whose operations task writes to the worker's log group
          # under the stream prefix `operations` (lane g100).
          Sid      = "ReadTheTwoServicesLogs"
          Effect   = "Allow"
          Action   = ["logs:FilterLogEvents", "logs:GetLogEvents"]
          Resource = local.ci_deploy_log_groups
        },
        {
          Sid      = "ReadTheCanaryMetric"
          Effect   = "Allow"
          Action   = ["cloudwatch:GetMetricStatistics"]
          Resource = ["*"]
        },
      ],
    )
  }
}

resource "aws_iam_role" "ci_deploy" {
  name               = local.ci_deploy_role_name
  description        = "CI deploys app-only changes to production: promote by digest, register the two service revisions, roll, verify. No state, no secrets, no IAM writes."
  assume_role_policy = jsonencode(local.ci_deploy_trust_policy)
  # Two hours: a promotion, then two rollouts of up to thirty minutes each, inside a
  # job whose timeout is twice the worst rollout (lane g91 review, P1 12).
  max_session_duration = 7200

  tags = {
    Name       = local.ci_deploy_role_name
    NamePrefix = var.name_prefix
  }
}

resource "aws_iam_role_policy" "ci_deploy" {
  name   = "${local.ci_deploy_role_name}-scope"
  role   = aws_iam_role.ci_deploy.id
  policy = jsonencode(local.ci_deploy_policy)
}
