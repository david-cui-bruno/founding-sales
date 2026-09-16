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
    condition     = var.delegated_research_reviewed_capability == ""
    error_message = "Reviewed metadata must be absent by default, never invented model or pricing settings."
  }
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
      length(aws_apigatewayv2_route.delegated_worker) == 18,
      length(aws_apigatewayv2_stage.delegated_worker) == 1,
      length(aws_lambda_permission.delegated_worker_api) == 1,
      length(aws_cloudwatch_event_rule.delegated_worker) == 0,
      length(aws_cloudwatch_event_target.delegated_worker) == 0,
      length(aws_lambda_permission.delegated_worker_schedule) == 0
    ])
    error_message = "Enabled unscheduled worker must have exactly 29 managed resources and one mocked archive read."
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
      aws_lambda_function.delegated_worker[0].environment[0].variables.DELEGATED_WORKER_RESEARCH_ONCE_ENABLED == "false" &&
      aws_lambda_function.delegated_worker[0].environment[0].variables.DELEGATED_WORKER_SCHEDULE_ARN == "" &&
      aws_lambda_function.delegated_worker[0].environment[0].variables.DELEGATED_GOOGLE_CLIENT_ID == "" &&
      aws_lambda_function.delegated_worker[0].environment[0].variables.DELEGATED_GOOGLE_SECRET_PARAMETER == "" &&
      aws_lambda_function.delegated_worker[0].environment[0].variables.DELEGATED_GOOGLE_KEY_PARAMETER == "" &&
      aws_lambda_function.delegated_worker[0].environment[0].variables.DELEGATED_RESEARCH_CREDENTIAL_PARAMETER == "" &&
      aws_lambda_function.delegated_worker[0].environment[0].variables.DELEGATED_RESEARCH_REVIEWED_CAPABILITY == "" &&
      length(jsondecode(aws_iam_role_policy.delegated_worker[0].policy).Statement[1].Resource) == 2 &&
      !strcontains(aws_iam_role_policy.delegated_worker[0].policy, "research-model-credentials")
    )
    error_message = "Schedule, Google configuration, research credentials and reviewed metadata must remain off without separate opt-ins."
  }
  assert {
    condition = toset(keys(aws_apigatewayv2_route.delegated_worker)) == toset([
      "POST /pairing/redeem", "POST /pairing/revoke", "POST /commands", "POST /commands/reconcile", "POST /emergency",
      "POST /readiness", "POST /research/configure", "POST /policies/configure", "POST /requested-followup/context", "POST /requested-followup/draft",
      "POST /research/setup/status", "POST /research/setup", "POST /accounts/preparation", "POST /reply/draft",
      "GET /events", "POST /google/begin", "GET /google/status", "GET /google/disclosure", "POST /google/revoke", "GET /oauth/callback"
    ])
    error_message = "Preserve existing worker routes and expose the explicit POST account preparation read and ordinary reply draft routes."
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

# Fictional transport fixtures only, not runtime-valid capability or pricing proof.
run "reviewed_metadata_passes_through_without_enabling_credentials_or_schedule" {
  command = plan
  module {
    source = "../terraform/modules/delegated-worker"
  }
  variables {
    worker_source_dir                      = "./nonexistent-mocked-dist"
    worker_output_path                     = "./nonexistent-mocked-worker.zip"
    delegated_worker_enabled               = true
    delegated_worker_activation_reviewed   = true
    delegated_workspace_id                 = "mock-workspace"
    aws_account_id                         = "123456789012"
    name_prefix                            = "mock"
    delegated_research_reviewed_capability = "{ \"provenance\": \"fictional operator review, transport test only\", \"units\": \"USD\" }"
  }
  assert {
    condition     = aws_lambda_function.delegated_worker[0].environment[0].variables.DELEGATED_RESEARCH_REVIEWED_CAPABILITY == var.delegated_research_reviewed_capability
    error_message = "Non-secret reviewed metadata must pass through byte-for-byte without injected defaults."
  }
  assert {
    condition = (
      aws_lambda_function.delegated_worker[0].environment[0].variables.DELEGATED_RESEARCH_CREDENTIAL_PARAMETER == "" &&
      aws_lambda_function.delegated_worker[0].environment[0].variables.DELEGATED_WORKER_SCHEDULE_ARN == "" &&
      length(jsondecode(aws_iam_role_policy.delegated_worker[0].policy).Statement[1].Resource) == 2 &&
      !strcontains(aws_iam_role_policy.delegated_worker[0].policy, "research-model-credentials") &&
      length(aws_apigatewayv2_route.delegated_worker) == 18 &&
      length(aws_cloudwatch_event_rule.delegated_worker) == 0 &&
      length(aws_cloudwatch_event_target.delegated_worker) == 0 &&
      length(aws_lambda_permission.delegated_worker_schedule) == 0
    )
    error_message = "Reviewed metadata is not a credential grant or schedule activation."
  }
}

run "isolated_root_reviewed_metadata_accepts_boundary_json" {
  command = plan
  variables {
    # JSON string with exactly 3000 characters including its two quote characters.
    delegated_research_reviewed_capability = jsonencode(format("%sx", join("", [for i in range(3) : join("", [for j in range(999) : "x"])])))
  }
  assert {
    condition     = length(var.delegated_research_reviewed_capability) == 3000 && output.delegated_worker_endpoint == null
    error_message = "The inclusive JSON size boundary must be accepted without activating a worker."
  }
}

run "isolated_root_reviewed_metadata_invalid_json_rejected" {
  command = plan
  variables {
    delegated_research_reviewed_capability = "{not-json}"
  }
  expect_failures = [var.delegated_research_reviewed_capability]
}

run "isolated_root_reviewed_metadata_oversize_rejected" {
  command = plan
  variables {
    delegated_research_reviewed_capability = jsonencode(join("", [for i in range(3) : join("", [for j in range(1000) : "x"])]))
  }
  expect_failures = [var.delegated_research_reviewed_capability]
}

run "module_reviewed_metadata_invalid_json_rejected" {
  command = plan
  module {
    source = "../terraform/modules/delegated-worker"
  }
  variables {
    worker_source_dir                      = "./nonexistent-mocked-dist"
    worker_output_path                     = "./nonexistent-mocked-worker.zip"
    delegated_research_reviewed_capability = "{not-json}"
  }
  expect_failures = [var.delegated_research_reviewed_capability]
}

run "module_reviewed_metadata_oversize_rejected" {
  command = plan
  module {
    source = "../terraform/modules/delegated-worker"
  }
  variables {
    worker_source_dir                      = "./nonexistent-mocked-dist"
    worker_output_path                     = "./nonexistent-mocked-worker.zip"
    delegated_research_reviewed_capability = jsonencode(join("", [for i in range(3) : join("", [for j in range(1000) : "x"])]))
  }
  expect_failures = [var.delegated_research_reviewed_capability]
}

run "research_once_explicit_without_schedule_or_new_authority" {
  command = plan
  module { source = "../terraform/modules/delegated-worker" }
  variables {
    worker_source_dir                      = "./nonexistent-mocked-dist"
    worker_output_path                     = "./nonexistent-mocked-worker.zip"
    delegated_worker_enabled               = true
    delegated_worker_activation_reviewed   = true
    delegated_workspace_id                 = "mock-workspace"
    delegated_worker_research_once_enabled = true
    aws_account_id                         = "123456789012"
    name_prefix                            = "mock"
  }
  assert {
    condition = (
      aws_lambda_function.delegated_worker[0].environment[0].variables.DELEGATED_WORKER_RESEARCH_ONCE_ENABLED == "true" &&
      aws_lambda_function.delegated_worker[0].environment[0].variables.DELEGATED_WORKER_SCHEDULE_ARN == "" &&
      aws_lambda_function.delegated_worker[0].environment[0].variables.DELEGATED_RESEARCH_CREDENTIAL_PARAMETER == "" &&
      aws_lambda_function.delegated_worker[0].environment[0].variables.DELEGATED_GOOGLE_CLIENT_ID == "" &&
      length(aws_cloudwatch_event_rule.delegated_worker) == 0 &&
      length(aws_cloudwatch_event_target.delegated_worker) == 0 &&
      length(aws_lambda_permission.delegated_worker_schedule) == 0 &&
      length(aws_apigatewayv2_route.delegated_worker) == 18
    )
    error_message = "One-shot opt-in creates no schedule, route, credential or grant."
  }
}

run "research_once_and_schedule_are_incompatible" {
  command = plan
  module { source = "../terraform/modules/delegated-worker" }
  variables {
    worker_source_dir                      = "./nonexistent-mocked-dist"
    worker_output_path                     = "./nonexistent-mocked-worker.zip"
    delegated_worker_enabled               = true
    delegated_worker_activation_reviewed   = true
    delegated_workspace_id                 = "mock-workspace"
    delegated_worker_research_once_enabled = true
    delegated_worker_schedule_enabled      = true
    aws_account_id                         = "123456789012"
    name_prefix                            = "mock"
  }
  expect_failures = [aws_lambda_function.delegated_worker]
}
