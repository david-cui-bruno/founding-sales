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

run "the_two_services_have_separate_task_and_execution_roles" {
  command = plan

  assert {
    condition = length(distinct([
      aws_iam_role.api_task.name,
      aws_iam_role.worker_task.name,
      aws_iam_role.api_execution.name,
      aws_iam_role.worker_execution.name,
    ])) == 4
    error_message = "API and worker must each have their own task role and their own execution role."
  }

  assert {
    condition     = aws_ecs_task_definition.api.task_role_arn != aws_ecs_task_definition.api.execution_role_arn || aws_iam_role.api_task.name != aws_iam_role.api_execution.name
    error_message = "The identity that pulls the image must not be the identity the application runs as."
  }
}

# Specification 10.2: "Each event and supersession ... is written to the
# object-locked S3 journal before acknowledgement." Both processes record
# suppressions — the API from its three write routes, the worker when mail sync
# imports a prospect opt-out — so both must be able to put. Neither may ever
# delete: an append-only journal that one of its writers can erase is not one.
run "both_task_roles_may_append_to_the_journal_and_neither_may_delete" {
  command = plan

  assert {
    condition = length([
      for statement in jsondecode(aws_iam_role_policy.api_task.policy).Statement :
      statement if contains(statement.Action, "s3:PutObject")
    ]) == 1
    error_message = "The API task role appends suppression events."
  }

  assert {
    condition = length([
      for statement in jsondecode(aws_iam_role_policy.worker_task.policy).Statement :
      statement if contains(statement.Action, "s3:PutObject")
    ]) == 1
    error_message = "The worker records prospect opt-outs during mail sync and must journal them before acknowledging."
  }

  # Scoped to the journal object prefix and nothing else. A put granted on "*"
  # would be a worker that can write any bucket in the account.
  assert {
    condition = alltrue(flatten([
      for policy in [aws_iam_role_policy.api_task.policy, aws_iam_role_policy.worker_task.policy] : [
        for statement in jsondecode(policy).Statement :
        statement.Resource == ["arn:aws:s3:::fss-test-suppression-journal-123456789012/*"]
        if contains(statement.Action, "s3:PutObject")
      ]
    ]))
    error_message = "A journal put is granted on the journal object prefix only."
  }

  # The bucket applies its own default retention on every put, so no writer sets
  # per-object retention and the bucket policy denies s3:PutObjectRetention to
  # everybody. Granting it here would be a permission with nothing behind it.
  assert {
    condition = alltrue(flatten([
      for policy in [aws_iam_role_policy.api_task.policy, aws_iam_role_policy.worker_task.policy] : [
        for statement in jsondecode(policy).Statement :
        !contains(statement.Action, "s3:PutObjectRetention")
        && !contains(statement.Action, "s3:PutObjectLegalHold")
        && !contains(statement.Action, "s3:BypassGovernanceRetention")
      ]
    ]))
    error_message = "Neither task role weakens an object lock; the bucket's default retention is the only one."
  }

  assert {
    condition = alltrue(flatten([
      for policy in [aws_iam_role_policy.api_task.policy, aws_iam_role_policy.worker_task.policy] : [
        for statement in jsondecode(policy).Statement :
        alltrue([for action in statement.Action : !startswith(action, "s3:Delete")])
      ]
    ]))
    error_message = "Neither task role may delete anything in the journal."
  }

  # Writing a KMS-encrypted object needs a data key. Reading one needs Decrypt.
  # Both roles do both, on the journal key only.
  assert {
    condition = alltrue(flatten([
      for policy in [aws_iam_role_policy.api_task.policy, aws_iam_role_policy.worker_task.policy] : [
        for statement in jsondecode(policy).Statement :
        contains(statement.Action, "kms:GenerateDataKey") && contains(statement.Action, "kms:Encrypt")
        if statement.Resource == ["arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555551"]
      ]
    ]))
    error_message = "Both task roles need GenerateDataKey and Encrypt on the journal key to write an encrypted object."
  }

  # Exactly one statement, and it names this environment's namespace. A bare
  # `alltrue` over the matching statements would pass a policy that had lost
  # PutMetricData altogether.
  assert {
    condition = [
      for statement in jsondecode(aws_iam_role_policy.worker_task.policy).Statement :
      statement.Condition.StringEquals["cloudwatch:namespace"]
      if contains(statement.Action, "cloudwatch:PutMetricData")
    ] == ["FSS/fss-test"]
    error_message = "The worker may publish metrics only into this environment's namespace, FSS/<name_prefix>."
  }
}

run "services_deploy_behind_a_circuit_breaker_with_rollback" {
  command = plan

  assert {
    condition     = aws_ecs_service.api.deployment_circuit_breaker[0].enable && aws_ecs_service.api.deployment_circuit_breaker[0].rollback
    error_message = "A failing API deployment must roll back rather than drain the healthy one."
  }

  assert {
    condition     = aws_ecs_service.worker.deployment_circuit_breaker[0].enable && aws_ecs_service.worker.deployment_circuit_breaker[0].rollback
    error_message = "A failing worker deployment must roll back."
  }

  assert {
    condition     = aws_ecs_service.api.network_configuration[0].assign_public_ip && aws_ecs_service.worker.network_configuration[0].assign_public_ip
    error_message = "Tasks need public addresses because the design has no NAT gateway."
  }

  assert {
    condition     = length(aws_ecs_service.worker.load_balancer) == 0
    error_message = "The worker is never behind the load balancer."
  }
}

run "schema_ranges_reach_the_containers" {
  command = plan

  assert {
    condition     = output.api_environment["FSS_SCHEMA_MIN"] == "1" && output.api_environment["FSS_SCHEMA_MAX"] == "4"
    error_message = "The API declares the schema range it accepts."
  }

  assert {
    condition     = output.worker_environment["FSS_SCHEMA_MIN"] == "2" && output.worker_environment["FSS_SCHEMA_MAX"] == "4"
    error_message = "The worker declares the schema range it accepts."
  }

  assert {
    condition     = contains(output.secret_environment_names, "DATABASE_SECRET_ARN")
    error_message = "Database credentials arrive as a Secrets Manager reference, never as an environment value."
  }

  assert {
    condition = length([
      for name, value in output.api_environment : name
      if can(regex("(?i)(password|secret|token|credential|private_key)", name))
    ]) == 0
    error_message = "No environment name may look like a credential; secrets arrive only by reference."
  }
}

# g42, lane g55: one namespace per environment, and every task and every task
# role in this cluster names the same one. A rehearsal and production share an
# account, so a task that published into another environment's namespace would
# feed that environment's alarms; the IAM condition is what makes that
# impossible rather than merely unlikely.
run "every_task_publishes_into_this_environment_s_namespace_and_nowhere_else" {
  command = plan

  assert {
    condition = (output.api_environment["FSS_METRIC_NAMESPACE"] == "FSS/fss-test"
    && output.worker_environment["FSS_METRIC_NAMESPACE"] == "FSS/fss-test")
    error_message = "Both services are told the environment's namespace, FSS/<name_prefix>."
  }

  assert {
    condition = alltrue([
      for definition in [
        aws_ecs_task_definition.api,
        aws_ecs_task_definition.worker,
        aws_ecs_task_definition.migration,
        aws_ecs_task_definition.operations,
        ] : [
        for variable in jsondecode(definition.container_definitions)[0].environment :
        variable.value if variable.name == "FSS_METRIC_NAMESPACE"
      ] == ["FSS/fss-test"]
    ])
    error_message = "All four task definitions carry FSS_METRIC_NAMESPACE, exactly once, set to this environment's namespace."
  }

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
