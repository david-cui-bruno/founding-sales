mock_provider "aws" {
  override_during = apply

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/mock"
      id  = "mock"
    }
  }
}

variables {
  name_prefix               = "fss-test"
  aws_region                = "us-east-1"
  subnet_ids                = ["subnet-1111111111111111a", "subnet-1111111111111111b"]
  api_security_group_ids    = ["sg-1111111111111111a"]
  worker_security_group_ids = ["sg-1111111111111111b"]
  api_image                 = "123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-test-api@sha256:0000000000000000000000000000000000000000000000000000000000000001"
  worker_image              = "123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-test-worker@sha256:0000000000000000000000000000000000000000000000000000000000000002"
  api_schema_range          = { min = 1, max = 4 }
  worker_schema_range       = { min = 2, max = 4 }
  target_group_arn          = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/fss-test-api/1111111111111111"
  api_log_group_name        = "/fss/fss-test/api"
  worker_log_group_name     = "/fss/fss-test/worker"
  metric_namespace          = "FSS/fss-test"

  app_runtime_database_secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:fss-test/app-runtime-database-cccccc"
  migration_database_secret_arn   = "arn:aws:secretsmanager:us-east-1:123456789012:secret:fss-test/migration-database-bbbbbb"
  journal_bucket_arn              = "arn:aws:s3:::fss-test-suppression-journal-123456789012"
  journal_kms_key_arn             = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555551"
  envelope_kms_key_arn            = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555552"
  secrets_kms_key_arn             = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555553"
}

run "separate_roles_an_append_only_journal_and_one_metric_namespace" {
  command = plan

  assert {
    condition = length(distinct([
      aws_iam_role.api_task.name,
      aws_iam_role.worker_task.name,
      aws_iam_role.api_execution.name,
      aws_iam_role.worker_execution.name,
    ])) == 4
    error_message = "API and worker each have their own task role and their own execution role."
  }

  # Specification 10.2: both processes journal suppressions before acknowledging
  # (the API from its write routes, the worker from mail sync), on the journal
  # object prefix only. A put granted on "*" would be a task that can write any
  # bucket in the account.
  assert {
    condition = alltrue([
      for policy in [aws_iam_role_policy.api_task.policy, aws_iam_role_policy.worker_task.policy] :
      [
        for statement in jsondecode(policy).Statement : statement.Resource
        if contains(statement.Action, "s3:PutObject")
      ] == [["arn:aws:s3:::fss-test-suppression-journal-123456789012/*"]]
    ])
    error_message = "Both task roles append to the journal, and only on its object prefix."
  }

  # An append-only journal one of its writers can erase or unlock is not one.
  assert {
    condition = alltrue(flatten([
      for policy in [aws_iam_role_policy.api_task.policy, aws_iam_role_policy.worker_task.policy] : [
        for statement in jsondecode(policy).Statement : [
          for action in statement.Action :
          !startswith(action, "s3:Delete") && !contains(["s3:PutObjectRetention", "s3:PutObjectLegalHold", "s3:BypassGovernanceRetention"], action)
        ]
      ]
    ]))
    error_message = "Neither task role may delete from the journal or weaken an object lock."
  }

  # g42, lane g55: a rehearsal and production share an account, so a task that
  # could publish into another environment's namespace would feed its alarms.
  assert {
    condition = alltrue([
      for policy in [
        aws_iam_role_policy.api_task.policy,
        aws_iam_role_policy.worker_task.policy,
        aws_iam_role_policy.migration_task.policy,
        ] : [
        for statement in jsondecode(policy).Statement :
        statement.Condition.StringEquals["cloudwatch:namespace"]
        if contains(statement.Action, "cloudwatch:PutMetricData")
      ] == ["FSS/fss-test"]
    ])
    error_message = "Every task role that may publish metrics may publish only into this environment's namespace."
  }
}

run "the_containers_get_their_ranges_arm64_and_no_secret_by_value" {
  command = plan

  assert {
    condition = (output.api_environment["FSS_SCHEMA_MIN"] == "1" && output.api_environment["FSS_SCHEMA_MAX"] == "4"
    && output.worker_environment["FSS_SCHEMA_MIN"] == "2" && output.worker_environment["FSS_SCHEMA_MAX"] == "4")
    error_message = "Each binary is told the schema range it declares."
  }

  assert {
    condition = (contains(output.task_secret_names.api, "DATABASE_SECRET_ARN")
      && length([
        for name, value in output.api_environment : name
        if can(regex("(?i)(password|secret|token|credential|private_key)", name))
    ]) == 0)
    error_message = "Database credentials arrive as a Secrets Manager reference, and no environment name looks like a credential."
  }

  # The images are linux/arm64 only; see the note at the top of main.tf.
  assert {
    condition = alltrue([
      for definition in [
        aws_ecs_task_definition.api,
        aws_ecs_task_definition.worker,
        aws_ecs_task_definition.migration,
        aws_ecs_task_definition.operations,
      ] : definition.runtime_platform[0].cpu_architecture == "ARM64" && definition.runtime_platform[0].operating_system_family == "LINUX"
    ])
    error_message = "Every task definition asks Fargate for ARM64 Linux, the only platform the images are built for."
  }
}

run "the_bare_fss_namespace_is_refused" {
  command = plan

  variables {
    metric_namespace = "FSS"
  }

  expect_failures = [var.metric_namespace]
}

run "a_mutable_image_tag_is_refused" {
  command = plan

  variables {
    api_image = "123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-test-api:latest"
  }

  expect_failures = [var.api_image]
}

run "an_inverted_schema_range_is_refused" {
  command = plan

  variables {
    worker_schema_range = { min = 5, max = 4 }
  }

  expect_failures = [var.worker_schema_range]
}
