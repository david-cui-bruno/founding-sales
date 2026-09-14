# Offline contract tests. Every run is a plan and both providers are mocked.
# Execute only from a scratch copy initialized with `init -backend=false`.
# Plan-time defaults are syntactically valid but fictitious, never cloud state.
mock_provider "aws" {
  override_during = plan

  mock_resource "aws_kms_key" {
    defaults = {
      arn    = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555555"
      key_id = "11111111-2222-4333-8444-555555555555"
    }
  }
  mock_resource "aws_dynamodb_table" {
    defaults = { arn = "arn:aws:dynamodb:us-east-1:123456789012:table/mock-delegated-worker" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:123456789012:log-group:mock-delegated-worker" }
  }
  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/mock-delegated-worker"
      id  = "mock-delegated-worker"
    }
  }
  mock_resource "aws_lambda_function" {
    defaults = {
      arn        = "arn:aws:lambda:us-east-1:123456789012:function:mock-delegated-worker"
      invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:mock-delegated-worker/invocations"
    }
  }
  mock_resource "aws_apigatewayv2_api" {
    defaults = {
      id            = "mockapi123"
      api_endpoint  = "https://mockapi123.execute-api.us-east-1.amazonaws.com"
      execution_arn = "arn:aws:execute-api:us-east-1:123456789012:mockapi123"
    }
  }
  mock_resource "aws_apigatewayv2_integration" {
    defaults = { id = "mockintegration" }
  }
  mock_resource "aws_cloudwatch_event_rule" {
    defaults = { arn = "arn:aws:events:us-east-1:123456789012:rule/mock-delegated-worker-schedule" }
  }
}

mock_provider "archive" {
  override_during = plan
  mock_data "archive_file" {
    defaults = { output_base64sha256 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }
  }
}

run "isolated_root_disabled_by_default" {
  command = plan
  assert {
    condition     = output.delegated_worker_endpoint == null
    error_message = "The isolated root must expose no endpoint by default."
  }
}

run "isolated_root_enabled" {
  command = plan
  variables {
    delegated_worker_enabled             = true
    delegated_worker_activation_reviewed = true
    delegated_workspace_id               = "mock-workspace"
    aws_account_id                       = "123456789012"
    name_prefix                          = "mock"
  }
  assert {
    condition     = output.delegated_worker_endpoint == "https://mockapi123.execute-api.us-east-1.amazonaws.com"
    error_message = "Root wiring must return the worker HTTPS endpoint only."
  }
}

run "module_disabled_zero_instances" {
  command = plan
  module {
    source = "../terraform/modules/delegated-worker"
  }
  variables {
    worker_source_dir  = "./nonexistent-mocked-dist"
    worker_output_path = "./nonexistent-mocked-worker.zip"
  }
  assert {
    condition = sum([
      length(aws_kms_key.delegated_worker),
      length(aws_dynamodb_table.delegated_worker),
      length(aws_cloudwatch_log_group.delegated_worker),
      length(aws_cloudwatch_log_group.delegated_worker_api),
      length(aws_iam_role.delegated_worker),
      length(aws_iam_role_policy.delegated_worker),
      length(data.archive_file.delegated_worker),
      length(aws_lambda_function.delegated_worker),
      length(aws_apigatewayv2_api.delegated_worker),
      length(aws_apigatewayv2_integration.delegated_worker),
      length(aws_apigatewayv2_route.delegated_worker),
      length(aws_apigatewayv2_stage.delegated_worker),
      length(aws_lambda_permission.delegated_worker_api),
      length(aws_cloudwatch_event_rule.delegated_worker),
      length(aws_cloudwatch_event_target.delegated_worker),
      length(aws_lambda_permission.delegated_worker_schedule)
    ]) == 0
    error_message = "Disabled defaults must produce zero managed resources and zero archive reads."
  }
  assert {
    condition     = output.delegated_worker_endpoint == null
    error_message = "Disabled module endpoint must be null."
  }
}

run "enabled_bounded_schedule_google_research_off" {
  command = plan
  module {
    source = "../terraform/modules/delegated-worker"
  }
  variables {
    worker_source_dir                    = "./nonexistent-mocked-dist"
    worker_output_path                   = "./nonexistent-mocked-worker.zip"
    delegated_worker_enabled             = true
    delegated_worker_activation_reviewed = true
    delegated_workspace_id               = "mock-workspace"
    aws_account_id                       = "123456789012"
    name_prefix                          = "mock"
  }
  assert {
    condition = alltrue([
      length(aws_kms_key.delegated_worker) == 1,
      length(aws_dynamodb_table.delegated_worker) == 1,
      length(aws_cloudwatch_log_group.delegated_worker) == 1,
      length(aws_cloudwatch_log_group.delegated_worker_api) == 1,
      length(aws_iam_role.delegated_worker) == 1,
      length(aws_iam_role_policy.delegated_worker) == 1,
      length(data.archive_file.delegated_worker) == 1,
      length(aws_lambda_function.delegated_worker) == 1,
      length(aws_apigatewayv2_api.delegated_worker) == 1,
      length(aws_apigatewayv2_integration.delegated_worker) == 1,
      length(aws_apigatewayv2_route.delegated_worker) == 16,
      length(aws_apigatewayv2_stage.delegated_worker) == 1,
      length(aws_lambda_permission.delegated_worker_api) == 1,
      length(aws_cloudwatch_event_rule.delegated_worker) == 0,
      length(aws_cloudwatch_event_target.delegated_worker) == 0,
      length(aws_lambda_permission.delegated_worker_schedule) == 0
    ])
    error_message = "Enabled unscheduled worker must have exactly 27 managed resources and one mocked archive read."
  }
  assert {
    condition = (
      aws_lambda_function.delegated_worker[0].memory_size == 256 &&
      aws_lambda_function.delegated_worker[0].timeout == 60 &&
      aws_lambda_function.delegated_worker[0].reserved_concurrent_executions == 2 &&
      aws_lambda_function.delegated_worker[0].runtime == "nodejs22.x" &&
      toset(aws_lambda_function.delegated_worker[0].architectures) == toset(["arm64"]) &&
      aws_cloudwatch_log_group.delegated_worker[0].retention_in_days == 7 &&
      aws_cloudwatch_log_group.delegated_worker_api[0].retention_in_days == 7 &&
      aws_apigatewayv2_stage.delegated_worker[0].default_route_settings[0].throttling_burst_limit == 5 &&
      aws_apigatewayv2_stage.delegated_worker[0].default_route_settings[0].throttling_rate_limit == 2
    )
    error_message = "Compute, logging and API rate limits must retain the reviewed low-volume envelope."
  }
  assert {
    condition = (
      aws_lambda_function.delegated_worker[0].environment[0].variables.DELEGATED_WORKER_SCHEDULE_ARN == "" &&
      aws_lambda_function.delegated_worker[0].environment[0].variables.DELEGATED_GOOGLE_CLIENT_ID == "" &&
      aws_lambda_function.delegated_worker[0].environment[0].variables.DELEGATED_GOOGLE_SECRET_PARAMETER == "" &&
      aws_lambda_function.delegated_worker[0].environment[0].variables.DELEGATED_GOOGLE_KEY_PARAMETER == "" &&
      aws_lambda_function.delegated_worker[0].environment[0].variables.DELEGATED_RESEARCH_CREDENTIAL_PARAMETER == "" &&
      length(jsondecode(aws_iam_role_policy.delegated_worker[0].policy).Statement[1].Resource) == 2 &&
      !strcontains(aws_iam_role_policy.delegated_worker[0].policy, "research-model-credentials")
    )
    error_message = "Schedule, Google configuration and research credentials must remain off without separate opt-ins."
  }
  assert {
    condition = (
      aws_dynamodb_table.delegated_worker[0].billing_mode == "PAY_PER_REQUEST" &&
      aws_dynamodb_table.delegated_worker[0].deletion_protection_enabled &&
      aws_dynamodb_table.delegated_worker[0].server_side_encryption[0].enabled &&
      aws_dynamodb_table.delegated_worker[0].point_in_time_recovery[0].enabled &&
      aws_dynamodb_table.delegated_worker[0].ttl[0].attribute_name == "ttl" &&
      aws_dynamodb_table.delegated_worker[0].ttl[0].enabled &&
      aws_kms_key.delegated_worker[0].enable_key_rotation &&
      aws_kms_key.delegated_worker[0].deletion_window_in_days == 30
    )
    error_message = "Storage protection, bounded counter TTL and KMS safeguards must remain configured."
  }
  assert {
    condition = (
      jsondecode(aws_iam_role_policy.delegated_worker[0].policy).Statement[0].Condition["ForAllValues:StringEquals"]["dynamodb:LeadingKeys"][0] == "WORKSPACE#mock-workspace" &&
      toset(keys(jsondecode(aws_apigatewayv2_stage.delegated_worker[0].access_log_settings[0].format))) == toset(["requestId", "status", "responseLength"])
    )
    error_message = "IAM must be workspace-scoped and API logs must exclude request contents and identity."
  }
}

run "schedule_enabled_exactly_three_additional_resources" {
  command = plan
  module {
    source = "../terraform/modules/delegated-worker"
  }
  variables {
    worker_source_dir                    = "./nonexistent-mocked-dist"
    worker_output_path                   = "./nonexistent-mocked-worker.zip"
    delegated_worker_enabled             = true
    delegated_worker_activation_reviewed = true
    delegated_workspace_id               = "mock-workspace"
    delegated_worker_schedule_enabled    = true
    aws_account_id                       = "123456789012"
    name_prefix                          = "mock"
  }
  assert {
    condition = (
      length(aws_cloudwatch_event_rule.delegated_worker) == 1 &&
      length(aws_cloudwatch_event_target.delegated_worker) == 1 &&
      length(aws_lambda_permission.delegated_worker_schedule) == 1 &&
      aws_cloudwatch_event_rule.delegated_worker[0].schedule_expression == "rate(5 minutes)" &&
      aws_cloudwatch_event_rule.delegated_worker[0].state == "ENABLED" &&
      aws_cloudwatch_event_target.delegated_worker[0].retry_policy[0].maximum_retry_attempts == 0 &&
      aws_cloudwatch_event_target.delegated_worker[0].retry_policy[0].maximum_event_age_in_seconds == 60 &&
      aws_lambda_permission.delegated_worker_schedule[0].source_account == "123456789012" &&
      aws_lambda_permission.delegated_worker_schedule[0].source_arn == aws_cloudwatch_event_rule.delegated_worker[0].arn &&
      aws_lambda_function.delegated_worker[0].environment[0].variables.DELEGATED_WORKER_SCHEDULE_ARN == aws_cloudwatch_event_rule.delegated_worker[0].arn
    )
    error_message = "The explicit schedule opt-in must create one bounded rule/target/permission with exact ARN binding."
  }
}

run "schedule_cannot_enable_disabled_worker" {
  command = plan
  module {
    source = "../terraform/modules/delegated-worker"
  }
  variables {
    worker_source_dir                 = "./nonexistent-mocked-dist"
    worker_output_path                = "./nonexistent-mocked-worker.zip"
    delegated_worker_schedule_enabled = true
  }
  assert {
    condition = (
      length(aws_cloudwatch_event_rule.delegated_worker) == 0 &&
      length(aws_cloudwatch_event_target.delegated_worker) == 0 &&
      length(aws_lambda_permission.delegated_worker_schedule) == 0 &&
      length(aws_lambda_function.delegated_worker) == 0 &&
      output.delegated_worker_endpoint == null
    )
    error_message = "Scheduling alone cannot activate a worker."
  }
}

run "activation_review_required" {
  command = plan
  module {
    source = "../terraform/modules/delegated-worker"
  }
  variables {
    worker_source_dir        = "./nonexistent-mocked-dist"
    worker_output_path       = "./nonexistent-mocked-worker.zip"
    delegated_worker_enabled = true
    delegated_workspace_id   = "mock-workspace"
  }
  expect_failures = [aws_dynamodb_table.delegated_worker]
}

run "workspace_selection_required" {
  command = plan
  module {
    source = "../terraform/modules/delegated-worker"
  }
  variables {
    worker_source_dir                    = "./nonexistent-mocked-dist"
    worker_output_path                   = "./nonexistent-mocked-worker.zip"
    delegated_worker_enabled             = true
    delegated_worker_activation_reviewed = true
  }
  expect_failures = [aws_dynamodb_table.delegated_worker]
}

run "workspace_format_rejected" {
  command = plan
  module {
    source = "../terraform/modules/delegated-worker"
  }
  variables {
    worker_source_dir      = "./nonexistent-mocked-dist"
    worker_output_path     = "./nonexistent-mocked-worker.zip"
    delegated_workspace_id = "../invalid workspace"
  }
  expect_failures = [var.delegated_workspace_id]
}
