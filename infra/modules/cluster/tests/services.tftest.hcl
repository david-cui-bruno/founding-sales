mock_provider "aws" {
  override_during = plan

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

  database_master_secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!db-mock"
  journal_bucket_arn         = "arn:aws:s3:::fss-test-suppression-journal-123456789012"
  journal_kms_key_arn        = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555551"
  envelope_kms_key_arn       = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555552"
  secrets_kms_key_arn        = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555553"
  database_kms_key_arn       = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555554"
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

run "only_the_api_task_role_may_append_to_the_journal" {
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
    ]) == 0
    error_message = "The worker must never be able to write the suppression journal."
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_role_policy.worker_task.policy).Statement :
      statement.Condition.StringEquals["cloudwatch:namespace"] == "FSS"
      if contains(statement.Action, "cloudwatch:PutMetricData")
    ])
    error_message = "Metric publication is scoped to the FSS namespace."
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

  assert {
    condition     = aws_ecs_service.api.enable_execute_command == false && aws_ecs_service.worker.enable_execute_command == false
    error_message = "ECS Exec is off by default."
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
