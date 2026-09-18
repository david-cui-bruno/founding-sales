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
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:us-east-1:123456789012:mock-delegated-worker-alarms" }
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
      length(aws_lambda_permission.delegated_worker_schedule),
      length(aws_sns_topic.delegated_worker_alarms),
      length(aws_sns_topic_policy.delegated_worker_alarms),
      length(aws_sns_topic_subscription.delegated_worker_alarm_email),
      length(aws_cloudwatch_metric_alarm.delegated_worker_errors),
      length(aws_cloudwatch_metric_alarm.delegated_worker_throttles),
      length(aws_cloudwatch_metric_alarm.delegated_worker_silent_schedule),
      length(aws_cloudwatch_log_metric_filter.delegated_worker_held_ticks),
      length(aws_cloudwatch_metric_alarm.delegated_worker_held_ticks),
      length(aws_budgets_budget.delegated_worker_monthly)
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
      length(aws_apigatewayv2_route.delegated_worker) == 20,
      length(aws_apigatewayv2_stage.delegated_worker) == 1,
      length(aws_lambda_permission.delegated_worker_api) == 1,
      length(aws_cloudwatch_event_rule.delegated_worker) == 0,
      length(aws_cloudwatch_event_target.delegated_worker) == 0,
      length(aws_lambda_permission.delegated_worker_schedule) == 0,
      length(aws_sns_topic.delegated_worker_alarms) == 1,
      length(aws_sns_topic_policy.delegated_worker_alarms) == 1,
      length(aws_sns_topic_subscription.delegated_worker_alarm_email) == 0,
      length(aws_cloudwatch_metric_alarm.delegated_worker_errors) == 1,
      length(aws_cloudwatch_metric_alarm.delegated_worker_throttles) == 1,
      length(aws_cloudwatch_metric_alarm.delegated_worker_silent_schedule) == 0,
      length(aws_cloudwatch_log_metric_filter.delegated_worker_held_ticks) == 1,
      length(aws_cloudwatch_metric_alarm.delegated_worker_held_ticks) == 1,
      length(aws_budgets_budget.delegated_worker_monthly) == 1
    ])
    error_message = "Enabled unscheduled worker must have exactly 38 managed resources (11 plus 20 routes, plus the alarm topic, its policy, two alarms, the held-tick filter and alarm, and the budget) and one mocked archive read; no email subscription and no silent-schedule alarm without their opt-ins."
  }
  assert {
    condition = (
      aws_sns_topic.delegated_worker_alarms[0].name == "mock-delegated-worker-alarms" &&
      aws_cloudwatch_metric_alarm.delegated_worker_errors[0].alarm_name == "mock-delegated-worker-errors" &&
      aws_cloudwatch_metric_alarm.delegated_worker_errors[0].metric_name == "Errors" &&
      aws_cloudwatch_metric_alarm.delegated_worker_throttles[0].alarm_name == "mock-delegated-worker-throttles" &&
      aws_cloudwatch_metric_alarm.delegated_worker_throttles[0].metric_name == "Throttles" &&
      aws_cloudwatch_metric_alarm.delegated_worker_held_ticks[0].alarm_name == "mock-delegated-worker-held-ticks" &&
      aws_cloudwatch_metric_alarm.delegated_worker_held_ticks[0].namespace == "Callie/DelegatedWorker" &&
      aws_cloudwatch_log_metric_filter.delegated_worker_held_ticks[0].log_group_name == "/aws/lambda/mock-delegated-worker" &&
      strcontains(aws_cloudwatch_log_metric_filter.delegated_worker_held_ticks[0].pattern, "SCHEDULED_RUN_COMPLETED") &&
      aws_budgets_budget.delegated_worker_monthly[0].name == "mock-delegated-worker-monthly-usd" &&
      aws_budgets_budget.delegated_worker_monthly[0].limit_amount == "25" &&
      aws_budgets_budget.delegated_worker_monthly[0].limit_unit == "USD" &&
      aws_budgets_budget.delegated_worker_monthly[0].time_unit == "MONTHLY" &&
      toset([for n in aws_budgets_budget.delegated_worker_monthly[0].notification : "${n.threshold}:${n.notification_type}"]) == toset(["100:ACTUAL", "200:ACTUAL", "100:FORECASTED"])
    )
    error_message = "Alarms, the held-tick filter and the USD 25 / USD 50 budget must carry the worker prefix and the reviewed thresholds."
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
  assert {
    condition = (
      length(aws_cloudwatch_metric_alarm.delegated_worker_silent_schedule) == 1 &&
      aws_cloudwatch_metric_alarm.delegated_worker_silent_schedule[0].alarm_name == "mock-delegated-worker-silent-schedule" &&
      aws_cloudwatch_metric_alarm.delegated_worker_silent_schedule[0].metric_name == "Invocations" &&
      aws_cloudwatch_metric_alarm.delegated_worker_silent_schedule[0].threshold == 10 &&
      aws_cloudwatch_metric_alarm.delegated_worker_silent_schedule[0].period == 3600 &&
      aws_cloudwatch_metric_alarm.delegated_worker_silent_schedule[0].comparison_operator == "LessThanThreshold" &&
      aws_cloudwatch_metric_alarm.delegated_worker_silent_schedule[0].treat_missing_data == "breaching"
    )
    error_message = "The schedule opt-in also adds the silent-schedule alarm: fewer than 10 invocations in an hour, with missing data breaching."
  }
}

run "alarm_email_subscribes_topic_and_budget" {
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
    alarm_email                          = "alarms@example.test"
    monthly_budget_usd                   = 40
  }
  assert {
    condition = (
      length(aws_sns_topic_subscription.delegated_worker_alarm_email) == 1 &&
      aws_sns_topic_subscription.delegated_worker_alarm_email[0].protocol == "email" &&
      aws_sns_topic_subscription.delegated_worker_alarm_email[0].endpoint == "alarms@example.test" &&
      aws_budgets_budget.delegated_worker_monthly[0].limit_amount == "40" &&
      alltrue([for n in aws_budgets_budget.delegated_worker_monthly[0].notification : contains(n.subscriber_email_addresses, "alarms@example.test")])
    )
    error_message = "A set alarm_email must subscribe the topic and every budget notification; the budget amount must follow monthly_budget_usd."
  }
}

run "alarm_email_format_rejected" {
  command = plan
  variables {
    alarm_email = "not an address"
  }
  expect_failures = [var.alarm_email]
}

run "monthly_budget_out_of_range_rejected" {
  command = plan
  variables {
    monthly_budget_usd = 0
  }
  expect_failures = [var.monthly_budget_usd]
}

# Provenance is bounded at 500 characters in the worker's shared schema; Terraform rejects what the worker would reject.
run "isolated_root_reviewed_metadata_provenance_boundary_accepted" {
  command = plan
  variables {
    delegated_research_reviewed_capability = jsonencode({ provenance = join("", [for i in range(500) : "p"]), units = "USD" })
  }
  assert {
    condition     = length(jsondecode(var.delegated_research_reviewed_capability).provenance) == 500 && output.delegated_worker_endpoint == null
    error_message = "A 500-character provenance is the inclusive boundary and must be accepted without activating a worker."
  }
}

run "isolated_root_reviewed_metadata_provenance_too_long_rejected" {
  command = plan
  variables {
    delegated_research_reviewed_capability = jsonencode({ provenance = join("", [for i in range(501) : "p"]), units = "USD" })
  }
  expect_failures = [var.delegated_research_reviewed_capability]
}

run "module_reviewed_metadata_provenance_too_long_rejected" {
  command = plan
  module {
    source = "../terraform/modules/delegated-worker"
  }
  variables {
    worker_source_dir                      = "./nonexistent-mocked-dist"
    worker_output_path                     = "./nonexistent-mocked-worker.zip"
    delegated_research_reviewed_capability = jsonencode({ provenance = join("", [for i in range(501) : "p"]), units = "USD" })
  }
  expect_failures = [var.delegated_research_reviewed_capability]
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
      length(aws_apigatewayv2_route.delegated_worker) == 20 &&
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
      length(aws_apigatewayv2_route.delegated_worker) == 20
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
