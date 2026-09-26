# The production CI deploy role trusts one subject and holds only what the deploy
# uses (lane g91).
#
# Offline only: every run is a mocked plan, there is no backend and there are no
# credentials. The account id and every ARN below are the AWS documentation example
# values, never real ones.
#
# ## What is asserted, and the vacuous passes it closes
#
# **The trust.** Exactly one statement, compared whole: the account's GitHub OIDC
# provider, `AssumeRoleWithWebIdentity`, and `StringEquals` alone on the audience and
# on the one subject. "The subject is right" is true of a policy that also carries a
# `StringLike` beside it, so the condition is compared as a map rather than read key
# by key, which also refuses a wildcard in the subject.
#
# **The permissions.** The distinct actions are compared with an exact list, so a
# statement that grows one — a state read, a secret, `iam:PutRolePolicy` — is red here
# rather than in a review. `Resource: "*"` appears on exactly six statements, each
# exactly `["*"]`, and the four that carry no condition are reads or the sign-in.
# Everything else names its resources, all `fss-prod` but the two rehearsal
# repositories the read statement names. `UpdateService` is granted once per service
# under a plain `ArnLike` on that service's own family, so a call naming no task
# definition — `--desired-count 0` alone — is refused. A test over no statements passes
# every `alltrue`, so the statement count is asserted too.
#
# **The release record's put (lane g100).** `ecs:RunTask` appears once, on the
# operations family's revisions, under `ArnEquals` on the production cluster; its tags
# are a `TagResource` only as part of a create. The put reuses the `iam:PassRole` and
# the log read the role already had: no fifth role, no new group.

mock_provider "aws" {
  override_during = apply

  mock_resource "aws_kms_key" {
    defaults = {
      arn    = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555555"
      key_id = "11111111-2222-4333-8444-555555555555"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/mock"
      id  = "mock"
    }
  }

  mock_resource "aws_s3_bucket" {
    defaults = {
      arn                         = "arn:aws:s3:::mock-bucket"
      id                          = "mock-bucket"
      bucket_regional_domain_name = "mock-bucket.s3.us-east-1.amazonaws.com"
    }
  }

  mock_resource "aws_lb" {
    defaults = {
      arn      = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/mock/1111111111111111"
      dns_name = "mock-1111111111.us-east-1.elb.amazonaws.com"
      zone_id  = "Z35SXDOTRQ7X7K"
    }
  }

  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:us-east-1:123456789012:mock-alerts"
    }
  }

  mock_resource "aws_cloudfront_distribution" {
    defaults = {
      arn         = "arn:aws:cloudfront::123456789012:distribution/E111111111111"
      id          = "E111111111111"
      domain_name = "d111111111111.cloudfront.net"
    }
  }
}

variables {
  api_image           = "326255650484.dkr.ecr.us-east-1.amazonaws.com/fss-prod-api@sha256:0000000000000000000000000000000000000000000000000000000000000001"
  worker_image        = "326255650484.dkr.ecr.us-east-1.amazonaws.com/fss-prod-worker@sha256:0000000000000000000000000000000000000000000000000000000000000002"
  api_schema_range    = { min = 16, max = 16 }
  worker_schema_range = { min = 16, max = 16 }
}

run "the_role_is_production_s_own_and_is_not_the_terraform_role" {
  command = plan

  assert {
    condition = (
      aws_iam_role.ci_deploy.name == "fss-prod-ci-deploy"
      && output.ci_deploy_role_name == "fss-prod-ci-deploy"
      && output.deployment_role_name == "fss-prod-deploy"
      && contains(output.resource_names, "fss-prod-ci-deploy")
      && aws_iam_role.ci_deploy.max_session_duration == 7200
    )
    error_message = "The role CI assumes and the role Terraform assumes are two different roles; CI's is a name this root claims, and its session lasts the two hours of a promotion and two rollouts."
  }
}

run "the_role_trusts_one_github_subject_and_nothing_else" {
  command = plan

  assert {
    condition = jsondecode(aws_iam_role.ci_deploy.assume_role_policy).Statement == [{
      Sid       = "GitHubActionsInTheProductionDeployEnvironmentOnly"
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = "arn:aws:iam::326255650484:oidc-provider/token.actions.githubusercontent.com" }
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:david-cui-bruno@196666240/founding-sales@1351406527:environment:production-deploy"
        }
      }
    }]
    error_message = "The trust is one statement, compared whole: this account's GitHub OIDC provider alone, AssumeRoleWithWebIdentity alone — no sts:AssumeRole, so no AWS principal can chain into it — and StringEquals alone on the audience and this repository's production-deploy subject. A StringLike beside it would be a pattern, and a pattern is how a wildcard subject gets in."
  }
}

run "the_role_holds_exactly_the_actions_the_deploy_uses" {
  command = plan

  assert {
    condition = (
      length(jsondecode(aws_iam_role_policy.ci_deploy.policy).Statement) >= 12
      && alltrue([for statement in jsondecode(aws_iam_role_policy.ci_deploy.policy).Statement : statement.Effect == "Allow"])
    )
    error_message = "The policy has its statements — an assertion over none would pass anything — and every one is an Allow: the role needs no deny because it is granted nothing a deny would take away."
  }

  assert {
    condition = sort(distinct(flatten([for statement in jsondecode(aws_iam_role_policy.ci_deploy.policy).Statement : statement.Action]))) == tolist([
      "cloudwatch:GetMetricStatistics",
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:DescribeRepositories",
      "ecr:GetAuthorizationToken",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
      "ecs:DeregisterTaskDefinition",
      "ecs:DescribeClusters",
      "ecs:DescribeServices",
      "ecs:DescribeTaskDefinition",
      "ecs:DescribeTasks",
      "ecs:ListTasks",
      "ecs:RegisterTaskDefinition",
      "ecs:RunTask",
      "ecs:TagResource",
      "ecs:UpdateService",
      "iam:PassRole",
      "logs:FilterLogEvents",
      "logs:GetLogEvents",
    ])
    error_message = "The role holds exactly the promote, register, roll, watch, smoke and record-put actions: no Terraform state, no secret, no database, no IAM write but PassRole, no wildcard. Anything more is a change to this test first."
  }
}

run "resource_star_only_where_there_is_no_resource_to_name" {
  command = plan

  # Each is exactly ["*"]: a wildcard mixed into a list of ARNs would make the ARNs
  # decoration.
  assert {
    condition = (
      sort([for statement in jsondecode(aws_iam_role_policy.ci_deploy.policy).Statement : statement.Sid if contains(statement.Resource, "*")]) == tolist([
        "DeregisterWhichTakesNoResource",
        "ListTasksInTheProductionCluster",
        "ReadTaskDefinitionsWhichTakeNoResource",
        "ReadTheCanaryMetric",
        "RegisterRevisionsCarryingThisNamespace",
        "SignInToTheRegistry",
      ])
      && alltrue([
        for statement in jsondecode(aws_iam_role_policy.ci_deploy.policy).Statement :
        statement.Resource == ["*"] if contains(statement.Resource, "*")
      ])
    )
    error_message = "Resource * appears on the sign-in, the task-definition read, the deregistration, the canary read, the conditioned registration and the conditioned task listing, on nothing else, and never beside a named ARN."
  }

  # Unconditioned *, read or sign-in only; the two writes carry a condition that names
  # this namespace or its cluster.
  assert {
    condition = (
      sort(flatten([
        for statement in jsondecode(aws_iam_role_policy.ci_deploy.policy).Statement :
        statement.Action if contains(statement.Resource, "*") && try(statement.Condition, null) == null
      ])) == tolist(["cloudwatch:GetMetricStatistics", "ecr:GetAuthorizationToken", "ecs:DeregisterTaskDefinition", "ecs:DescribeTaskDefinition"])
      && alltrue([
        for statement in jsondecode(aws_iam_role_policy.ci_deploy.policy).Statement :
        (statement.Sid == "RegisterRevisionsCarryingThisNamespace" ? statement.Condition == { StringEquals = { "aws:RequestTag/NamePrefix" = "fss-prod" } } : true)
        && (statement.Sid == "ListTasksInTheProductionCluster" ? statement.Condition == { ArnEquals = { "ecs:cluster" = "arn:aws:ecs:us-east-1:326255650484:cluster/fss-prod-cluster" } } : true)
      ])
    )
    error_message = "With no condition, Resource * carries only the sign-in and three reads, none of which takes a resource; registration is conditioned on this namespace's NamePrefix tag and task listing on the production cluster's ARN."
  }
}

run "every_named_resource_is_production_s_but_the_two_images_it_reads" {
  command = plan

  assert {
    condition = alltrue(flatten([
      for statement in jsondecode(aws_iam_role_policy.ci_deploy.policy).Statement : [
        for resource in statement.Resource :
        resource == "*" || strcontains(resource, "fss-prod") || (statement.Sid == "ReadTheRehearsalAndProductionImages" && contains(["arn:aws:ecr:us-east-1:326255650484:repository/fss-rh-api", "arn:aws:ecr:us-east-1:326255650484:repository/fss-rh-worker"], resource))
      ]
    ]))
    error_message = "Every resource the role names is in the fss-prod namespace, except fss-rh-api and fss-rh-worker, which only the read statement names."
  }

  # The copy writes into production alone, and PassRole is the two services' four
  # roles for ECS: never the migration or drill roles, never a deployment role.
  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_role_policy.ci_deploy.policy).Statement :
      (contains(statement.Action, "ecr:PutImage") ? statement.Resource == [
        "arn:aws:ecr:us-east-1:326255650484:repository/fss-prod-api",
        "arn:aws:ecr:us-east-1:326255650484:repository/fss-prod-worker",
      ] : true)
      && (contains(statement.Action, "iam:PassRole") ? statement.Resource == [
        "arn:aws:iam::326255650484:role/fss-prod-api-task",
        "arn:aws:iam::326255650484:role/fss-prod-api-exec",
        "arn:aws:iam::326255650484:role/fss-prod-worker-task",
        "arn:aws:iam::326255650484:role/fss-prod-worker-exec",
      ] && statement.Condition == { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } } : true)
    ])
    error_message = "The copy writes into the two production repositories and never a rehearsal one, and PassRole names the two services' task and execution roles, only for ECS."
  }

  # The migration and drill families, their roles and Terraform's own backend are not
  # CI's. The operations family is named once, by the release record's put.
  assert {
    condition = (
      !can(regex("migration|drill|fss-prod-deploy|tfstate|tflock|secret", aws_iam_role_policy.ci_deploy.policy))
      && [
        for statement in jsondecode(aws_iam_role_policy.ci_deploy.policy).Statement :
        statement.Sid if strcontains(jsonencode(statement), "operations")
      ] == ["RunTheOperationsTaskInTheProductionCluster"]
    )
    error_message = "The policy names no migration or drill family or role, not the Terraform deployment role, not the state bucket or lock table, no secret, and the operations family only in the release record's put."
  }

  # Each service may be pointed at its own family and nothing else, and only by a call
  # that names a task definition: ArnLike, never ArnLikeIfExists, alone in its
  # statement. DescribeServices has a statement of its own, so no condition there
  # weakens this one.
  assert {
    condition = (
      alltrue([
        for statement in jsondecode(aws_iam_role_policy.ci_deploy.policy).Statement :
        statement.Action == ["ecs:UpdateService"] && keys(statement.Condition) == ["ArnLike"] && keys(statement.Condition.ArnLike) == ["ecs:task-definition"]
        if contains(statement.Action, "ecs:UpdateService")
      ])
      && [
        for statement in jsondecode(aws_iam_role_policy.ci_deploy.policy).Statement :
        [statement.Resource, statement.Condition.ArnLike["ecs:task-definition"]] if contains(statement.Action, "ecs:UpdateService")
        ] == [
        [["arn:aws:ecs:us-east-1:326255650484:service/fss-prod-cluster/fss-prod-api"], "arn:aws:ecs:us-east-1:326255650484:task-definition/fss-prod-api:*"],
        [["arn:aws:ecs:us-east-1:326255650484:service/fss-prod-cluster/fss-prod-worker"], "arn:aws:ecs:us-east-1:326255650484:task-definition/fss-prod-worker:*"],
      ]
      && [
        for statement in jsondecode(aws_iam_role_policy.ci_deploy.policy).Statement :
        statement.Resource if contains(statement.Action, "ecs:DescribeServices")
        ] == [[
          "arn:aws:ecs:us-east-1:326255650484:service/fss-prod-cluster/fss-prod-api",
          "arn:aws:ecs:us-east-1:326255650484:service/fss-prod-cluster/fss-prod-worker",
      ]]
    )
    error_message = "UpdateService is granted once per service, alone in its statement under a plain ArnLike on that service's own family — IfExists would admit a call with no task definition, such as a bare desired count of zero — and DescribeServices stands apart on the two services."
  }

  # The names the policy builds are the names the stack creates.
  assert {
    condition = alltrue([
      for name in ["fss-prod-cluster", "fss-prod-api", "fss-prod-worker", "fss-prod-api-task", "fss-prod-worker-task", "/fss/fss-prod/api", "/fss/fss-prod/worker"] :
      contains(output.resource_names, name)
    ])
    error_message = "The cluster, services, task roles, repositories and log groups the policy names are all names the stack claims."
  }
}

run "the_release_record_put_runs_the_operations_task_in_the_production_cluster_and_nothing_else" {
  command = plan

  assert {
    condition = [
      for statement in jsondecode(aws_iam_role_policy.ci_deploy.policy).Statement :
      [statement.Sid, statement.Action, statement.Resource, statement.Condition] if contains(statement.Action, "ecs:RunTask")
      ] == [[
        "RunTheOperationsTaskInTheProductionCluster",
        ["ecs:RunTask"],
        ["arn:aws:ecs:us-east-1:326255650484:task-definition/fss-prod-operations:*"],
        { ArnEquals = { "ecs:cluster" = "arn:aws:ecs:us-east-1:326255650484:cluster/fss-prod-cluster" } },
    ]]
    error_message = "RunTask stands alone in one statement: the operations family's revisions, under ArnEquals on the production cluster. Never a service family, never another cluster, never IfExists."
  }

  assert {
    condition = [
      for statement in jsondecode(aws_iam_role_policy.ci_deploy.policy).Statement :
      [statement.Resource, statement.Condition] if contains(statement.Action, "ecs:TagResource")
      ] == [
      [
        ["arn:aws:ecs:us-east-1:326255650484:task-definition/fss-prod-api:*", "arn:aws:ecs:us-east-1:326255650484:task-definition/fss-prod-worker:*"],
        { StringEquals = { "ecs:CreateAction" = "RegisterTaskDefinition" } },
      ],
      [
        ["arn:aws:ecs:us-east-1:326255650484:task/fss-prod-cluster/*"],
        { StringEquals = { "ecs:CreateAction" = "RunTask" } },
      ],
    ]
    error_message = "TagResource is granted only as part of a create: the two service revisions it registers, and the tasks it runs in the production cluster. Never a tag on anything that already exists."
  }

  # The put's task is read back, and its answer is read out of the worker's log group,
  # with the DescribeTasks and the log read the role already had. The cluster and the
  # family are root outputs, for the repository variables the workflow launches with.
  assert {
    condition = (
      [
        for statement in jsondecode(aws_iam_role_policy.ci_deploy.policy).Statement :
        statement.Resource if contains(statement.Action, "ecs:DescribeTasks")
      ] == [["arn:aws:ecs:us-east-1:326255650484:task/fss-prod-cluster/*"]]
      && alltrue([
        for statement in jsondecode(aws_iam_role_policy.ci_deploy.policy).Statement :
        contains(statement.Resource, "arn:aws:logs:us-east-1:326255650484:log-group:/fss/fss-prod/worker:*")
        if contains(statement.Action, "logs:GetLogEvents")
      ])
      && output.ci_deploy_cluster_name == "fss-prod-cluster"
      && output.ci_deploy_operations_task_family == "fss-prod-operations"
    )
    error_message = "The put reads its task back on the production cluster's tasks and its answer from the worker log group's streams, and the cluster and operations family are root outputs for FSS_PRODUCTION_CLUSTER_NAME and FSS_PRODUCTION_OPERATIONS_TASK_FAMILY."
  }
}
