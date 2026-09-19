# Disabled-by-default isolated worker. The optional dedicated five-minute rule
# never changes existing sourcing/watchdog schedules or their master switch.
# Enabling a schedule is not a grant, campaign approval or permission to send.
#
# Review envelope before activation: one low-volume workspace, <10k API calls/mo,
# <=1 GiB table, 7-day bounded logs, 256 MiB/60s Lambda with concurrency 2, one KMS
# key, two Google SecureStrings and optional separate research and Places
# SecureStrings. Five-minute scheduling is up to 8,928 ticks per 31-day month,
# even while the Mac sleeps. Incremental non-AI target <=$20/mo is NOT a quote or
# hard billing cap. Review regional Lambda/DynamoDB/log/KMS/EventBridge costs and
# abuse exposure. Provider/model/research/Places costs and cold-mail transport
# require separate review; each Places text-search call is reserved at the
# reviewed Enterprise SKU cost against the approved discovery ceiling.
#
# SecureString values must be provisioned separately after approval using this
# KMS key: google-client-secret, token-encryption-key (32 random bytes/base64),
# only if research is enabled, research-model-credentials (strict JSON with
# apiKey/model), and only if Places is enabled, places-api-credentials (strict
# JSON with apiKey). Terraform never reads/writes values. Review rotation/recovery.
locals {
  delegated_name               = "${var.name_prefix}-delegated-worker"
  delegated_parameter_path     = "/delegated-worker/${var.delegated_workspace_id}"
  delegated_secret_parameter   = "${local.delegated_parameter_path}/google-client-secret"
  delegated_key_parameter      = "${local.delegated_parameter_path}/token-encryption-key"
  delegated_research_parameter = "${local.delegated_parameter_path}/research-model-credentials"
  delegated_places_parameter   = "${local.delegated_parameter_path}/places-api-credentials"
  delegated_schedule_enabled   = var.delegated_worker_enabled && var.delegated_worker_schedule_enabled
  delegated_parameter_arns = concat([
    "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${local.delegated_secret_parameter}",
    "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${local.delegated_key_parameter}"
    ], var.delegated_research_enabled ? [
    "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${local.delegated_research_parameter}"
    ] : [], var.delegated_places_enabled ? [
    "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${local.delegated_places_parameter}"
  ] : [])
  delegated_routes = toset([
    "POST /pairing/redeem", "POST /pairing/revoke", "POST /commands", "POST /commands/reconcile", "POST /emergency",
    "POST /readiness", "POST /research/configure", "POST /policies/configure", "POST /requested-followup/context", "POST /requested-followup/draft",
    "POST /research/setup/status", "POST /research/setup", "POST /accounts/preparation", "POST /reply/draft",
    "GET /events", "POST /google/begin", "GET /google/status", "GET /google/disclosure",
    "POST /google/revoke", "GET /oauth/callback",
    # The rebuilt core's routes (S0, S1, S2), served by the same Lambda from src/v1/router.ts.
    "POST /v1/pair/redeem", "GET /v1/diagnostics", "POST /v1/commands",
    "GET /v1/today", "GET /v1/settings",
    "GET /v1/firms",
    # The Week view (S5): the last seven Eastern days from the permanent records.
    "GET /v1/week"
  ])
}

resource "aws_kms_key" "delegated_worker" {
  count                   = var.delegated_worker_enabled ? 1 : 0
  description             = "Dedicated delegated-worker SecureString protection"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  tags                    = { Component = "delegated-worker" }
}

resource "aws_dynamodb_table" "delegated_worker" {
  count                       = var.delegated_worker_enabled ? 1 : 0
  name                        = local.delegated_name
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "pk"
  range_key                   = "sk"
  deletion_protection_enabled = true
  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  server_side_encryption { enabled = true }
  point_in_time_recovery { enabled = true }
  # Only short-lived rate counters have ttl. No TTL on revocation, consumed
  # state, command receipts, suppression or unknown-send evidence.
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
  tags = { Component = "delegated-worker" }
  lifecycle {
    precondition {
      condition     = var.delegated_worker_activation_reviewed && var.delegated_workspace_id != ""
      error_message = "Worker activation requires explicit review and a selected workspace."
    }
  }
}

resource "aws_cloudwatch_log_group" "delegated_worker" {
  count             = var.delegated_worker_enabled ? 1 : 0
  name              = "/aws/lambda/${local.delegated_name}"
  retention_in_days = 7
}

resource "aws_cloudwatch_log_group" "delegated_worker_api" {
  count             = var.delegated_worker_enabled ? 1 : 0
  name              = "/aws/apigateway/${local.delegated_name}"
  retention_in_days = 7
}

resource "aws_iam_role" "delegated_worker" {
  count = var.delegated_worker_enabled ? 1 : 0
  name  = local.delegated_name
  path  = var.iam_path
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole"
  }] })
}

resource "aws_iam_role_policy" "delegated_worker" {
  count = var.delegated_worker_enabled ? 1 : 0
  name  = "dedicated-table-and-google-parameters"
  role  = aws_iam_role.delegated_worker[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect    = "Allow", Action = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:ConditionCheckItem"],
      Resource  = aws_dynamodb_table.delegated_worker[0].arn,
      Condition = { "ForAllValues:StringEquals" = { "dynamodb:LeadingKeys" = ["WORKSPACE#${var.delegated_workspace_id}"] } }
    },
    { Effect = "Allow", Action = ["ssm:GetParameter"], Resource = local.delegated_parameter_arns },
    { Effect = "Allow", Action = ["kms:Decrypt"], Resource = aws_kms_key.delegated_worker[0].arn,
      Condition = {
        StringEquals               = { "kms:ViaService" = "ssm.${var.aws_region}.amazonaws.com" },
        "ForAnyValue:StringEquals" = { "kms:EncryptionContext:PARAMETER_ARN" = local.delegated_parameter_arns }
      }
    },
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.delegated_worker[0].arn}:*" }
  ] })
}

data "archive_file" "delegated_worker" {
  count       = var.delegated_worker_enabled ? 1 : 0
  type        = "zip"
  source_dir  = var.worker_source_dir
  output_path = var.worker_output_path
}

resource "aws_lambda_function" "delegated_worker" {
  count            = var.delegated_worker_enabled ? 1 : 0
  function_name    = local.delegated_name
  role             = aws_iam_role.delegated_worker[0].arn
  filename         = data.archive_file.delegated_worker[0].output_path
  source_code_hash = data.archive_file.delegated_worker[0].output_base64sha256
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  architectures    = ["arm64"]
  memory_size      = 256
  # Source ticks abort after 45s; leave time for setup and durable settlement.
  timeout = 60
  # The scheduled tick holds one execution for up to 30 s; Settings fires up to four reads at once beside it and a sync.
  reserved_concurrent_executions = 5
  environment {
    variables = {
      DELEGATED_WORKER_RESEARCH_ONCE_ENABLED  = var.delegated_worker_research_once_enabled ? "true" : "false"
      DELEGATED_WORKER_ENABLED                = "true"
      DELEGATED_WORKER_TABLE                  = aws_dynamodb_table.delegated_worker[0].name
      DELEGATED_WORKSPACE_ID                  = var.delegated_workspace_id
      DELEGATED_RESEARCH_CREDENTIAL_PARAMETER = var.delegated_research_enabled ? local.delegated_research_parameter : ""
      DELEGATED_PLACES_CREDENTIAL_PARAMETER   = var.delegated_places_enabled ? local.delegated_places_parameter : ""
      DELEGATED_RESEARCH_REVIEWED_CAPABILITY  = var.delegated_research_reviewed_capability
      DELEGATED_WORKER_SCHEDULE_ARN           = local.delegated_schedule_enabled ? aws_cloudwatch_event_rule.delegated_worker[0].arn : ""
      DELEGATED_WORKER_HOST                   = replace(aws_apigatewayv2_api.delegated_worker[0].api_endpoint, "https://", "")
      DELEGATED_GOOGLE_CLIENT_ID              = var.delegated_google_client_id
      DELEGATED_GOOGLE_SECRET_PARAMETER       = var.delegated_google_client_id == "" ? "" : local.delegated_secret_parameter
      DELEGATED_GOOGLE_KEY_PARAMETER          = var.delegated_google_client_id == "" ? "" : local.delegated_key_parameter
      # The S3 switch. False makes the old tick skip the sequence email walk, the per-firm mail scopes and the
      # mailbox poll; the old research phases keep running until S4. It enables nothing on its own.
      DELEGATED_WORKER_LEGACY_EMAIL_ENABLED = var.delegated_worker_legacy_email_enabled ? "true" : "false"
      # The S4 switch. False makes the old tick skip its research, configurations and territory backfill phases;
      # the tick itself and S1's list build keep running. It enables nothing on its own.
      DELEGATED_WORKER_LEGACY_RESEARCH_ENABLED = var.delegated_worker_legacy_research_enabled ? "true" : "false"
      # The S6 switch. False stops the old tick entirely; the function keeps answering every route it served
      # before, and the morning list is built by the scheduler's day job. It enables nothing on its own.
      DELEGATED_WORKER_LEGACY_TICK_ENABLED = var.delegated_worker_legacy_tick_enabled ? "true" : "false"
    }
  }
  lifecycle {
    precondition {
      condition     = !(var.delegated_worker_research_once_enabled && var.delegated_worker_schedule_enabled)
      error_message = "Research-only invocation requires continuous scheduling to remain disabled."
    }
  }
  depends_on = [aws_iam_role_policy.delegated_worker, aws_cloudwatch_log_group.delegated_worker]
}

resource "aws_apigatewayv2_api" "delegated_worker" {
  count         = var.delegated_worker_enabled ? 1 : 0
  name          = local.delegated_name
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "delegated_worker" {
  count                  = var.delegated_worker_enabled ? 1 : 0
  api_id                 = aws_apigatewayv2_api.delegated_worker[0].id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.delegated_worker[0].invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 30000
}

resource "aws_apigatewayv2_route" "delegated_worker" {
  for_each  = var.delegated_worker_enabled ? local.delegated_routes : toset([])
  api_id    = aws_apigatewayv2_api.delegated_worker[0].id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.delegated_worker[0].id}"
}

resource "aws_apigatewayv2_stage" "delegated_worker" {
  count       = var.delegated_worker_enabled ? 1 : 0
  api_id      = aws_apigatewayv2_api.delegated_worker[0].id
  name        = "$default"
  auto_deploy = true
  # The per-route settings below name a route key, so the routes must exist before the stage is written.
  depends_on = [aws_apigatewayv2_route.delegated_worker]
  # A thin client polls every 60 s, and a Today, Settings, Diagnostics walk plus one command lands in one burst.
  default_route_settings {
    throttling_burst_limit = 20
    throttling_rate_limit  = 5
  }
  # A pairing code is redeemed once; the redeem route is throttled far below the default because guessing is what the limit is for.
  route_settings {
    route_key              = "POST /v1/pair/redeem"
    throttling_burst_limit = 2
    throttling_rate_limit  = 0.2
  }
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.delegated_worker_api[0].arn
    # No request URL/query, source IP, identity, header, payload or error text.
    format = jsonencode({ requestId = "$context.requestId", status = "$context.status", responseLength = "$context.responseLength" })
  }
}

resource "aws_lambda_permission" "delegated_worker_api" {
  count         = var.delegated_worker_enabled ? 1 : 0
  statement_id  = "DedicatedApiOnly"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.delegated_worker[0].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.delegated_worker[0].execution_arn}/*/*"
}

output "delegated_worker_endpoint" {
  description = "HTTPS base only, never a bearer or unauthenticated stop URL."
  value       = var.delegated_worker_enabled ? aws_apigatewayv2_api.delegated_worker[0].api_endpoint : null
}

# No rule, target or invocation permission exists unless explicitly opted in.
# Preserve the standard EventBridge event: handler checks its exact resources ARN.
resource "aws_cloudwatch_event_rule" "delegated_worker" {
  count               = local.delegated_schedule_enabled ? 1 : 0
  name                = "${local.delegated_name}-schedule"
  description         = "Approved delegated workspace source tick every five minutes"
  schedule_expression = "rate(5 minutes)"
  state               = "ENABLED"
  tags                = { Component = "delegated-worker" }
  lifecycle {
    precondition {
      condition     = var.delegated_worker_activation_reviewed
      error_message = "Scheduled worker execution requires the existing explicit activation review."
    }
  }
}

resource "aws_cloudwatch_event_target" "delegated_worker" {
  count     = local.delegated_schedule_enabled ? 1 : 0
  rule      = aws_cloudwatch_event_rule.delegated_worker[0].name
  target_id = "delegated-source-tick"
  arn       = aws_lambda_function.delegated_worker[0].arn
  # Disable stale EventBridge delivery retries; next tick reconciles durable work.
  # Lambda asynchronous retries remain separate and require idempotent consumers.
  retry_policy {
    maximum_event_age_in_seconds = 60
    maximum_retry_attempts       = 0
  }
  depends_on = [aws_lambda_permission.delegated_worker_schedule]
}

resource "aws_lambda_permission" "delegated_worker_schedule" {
  count          = local.delegated_schedule_enabled ? 1 : 0
  statement_id   = "DedicatedScheduleOnly"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.delegated_worker[0].function_name
  principal      = "events.amazonaws.com"
  source_arn     = aws_cloudwatch_event_rule.delegated_worker[0].arn
  source_account = var.aws_account_id
}

# Operations David can see (Batch 7, D10). One SNS topic receives every alarm; the
# email subscription exists only when alarm_email is set (the address confirms it
# by mail, Terraform never confirms it). Alarms: Lambda Errors, Lambda Throttles,
# a silent schedule (fewer than 10 invocations in an hour while the five-minute
# rule is on), and any scheduled tick whose SCHEDULED_RUN_COMPLETED record held
# work or was denied a Places page. The AWS Budget is account-wide monthly cost
# with actual-spend notifications at 100% and 200% of monthly_budget_usd (USD 25
# and USD 50 by default) plus a forecast at 100%. Nothing here reads a secret,
# grants a permission or changes how the worker runs.
locals {
  delegated_alarm_topic_arn = var.delegated_worker_enabled ? aws_sns_topic.delegated_worker_alarms[0].arn : ""
}

resource "aws_sns_topic" "delegated_worker_alarms" {
  count = var.delegated_worker_enabled ? 1 : 0
  name  = "${local.delegated_name}-alarms"
  tags  = { Component = "delegated-worker" }
}

resource "aws_sns_topic_policy" "delegated_worker_alarms" {
  count = var.delegated_worker_enabled ? 1 : 0
  arn   = aws_sns_topic.delegated_worker_alarms[0].arn
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Sid       = "AlarmsAndBudgetsPublish", Effect = "Allow", Principal = { Service = ["cloudwatch.amazonaws.com", "budgets.amazonaws.com"] },
      Action    = "sns:Publish", Resource = aws_sns_topic.delegated_worker_alarms[0].arn,
      Condition = { StringEquals = { "aws:SourceAccount" = var.aws_account_id } }
    }
  ] })
}

resource "aws_sns_topic_subscription" "delegated_worker_alarm_email" {
  count     = var.delegated_worker_enabled && var.alarm_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.delegated_worker_alarms[0].arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

resource "aws_cloudwatch_metric_alarm" "delegated_worker_errors" {
  count               = var.delegated_worker_enabled ? 1 : 0
  alarm_name          = "${local.delegated_name}-errors"
  alarm_description   = "The delegated worker Lambda reported a function error."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.delegated_worker[0].function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.delegated_worker_alarms[0].arn]
  ok_actions          = [aws_sns_topic.delegated_worker_alarms[0].arn]
  tags                = { Component = "delegated-worker" }
}

resource "aws_cloudwatch_metric_alarm" "delegated_worker_throttles" {
  count               = var.delegated_worker_enabled ? 1 : 0
  alarm_name          = "${local.delegated_name}-throttles"
  alarm_description   = "The delegated worker Lambda was throttled (reserved concurrency is 2)."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = { FunctionName = aws_lambda_function.delegated_worker[0].function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.delegated_worker_alarms[0].arn]
  ok_actions          = [aws_sns_topic.delegated_worker_alarms[0].arn]
  tags                = { Component = "delegated-worker" }
}

# Twelve ticks an hour are expected; fewer than ten means the schedule stopped firing or the
# function stopped being invoked. Missing data is the silence itself, so it breaches.
resource "aws_cloudwatch_metric_alarm" "delegated_worker_silent_schedule" {
  count               = local.delegated_schedule_enabled ? 1 : 0
  alarm_name          = "${local.delegated_name}-silent-schedule"
  alarm_description   = "The delegated worker was invoked fewer than 10 times in an hour while its five-minute schedule is on."
  namespace           = "AWS/Lambda"
  metric_name         = "Invocations"
  dimensions          = { FunctionName = aws_lambda_function.delegated_worker[0].function_name }
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.delegated_worker_alarms[0].arn]
  ok_actions          = [aws_sns_topic.delegated_worker_alarms[0].arn]
  tags                = { Component = "delegated-worker" }
}

# The tick record is the only application log line of the scheduled path; its fields are counts and enums.
resource "aws_cloudwatch_log_metric_filter" "delegated_worker_held_ticks" {
  count          = var.delegated_worker_enabled ? 1 : 0
  name           = "${local.delegated_name}-held-ticks"
  log_group_name = aws_cloudwatch_log_group.delegated_worker[0].name
  pattern        = "{ ($.event = \"SCHEDULED_RUN_COMPLETED\") && (($.held > 0) || ($.places.outcome = \"denied\")) }"
  metric_transformation {
    name          = "HeldTicks"
    namespace     = "Callie/DelegatedWorker"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "delegated_worker_held_ticks" {
  count               = var.delegated_worker_enabled ? 1 : 0
  alarm_name          = "${local.delegated_name}-held-ticks"
  alarm_description   = "A scheduled tick held work or was denied a Places page (see the SCHEDULED_RUN_COMPLETED record)."
  namespace           = "Callie/DelegatedWorker"
  metric_name         = "HeldTicks"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.delegated_worker_alarms[0].arn]
  ok_actions          = [aws_sns_topic.delegated_worker_alarms[0].arn]
  tags                = { Component = "delegated-worker" }
  depends_on          = [aws_cloudwatch_log_metric_filter.delegated_worker_held_ticks]
}

# The morning list (S1, design section 4). day.build logs one LIST_BUILT line, counts only, when it writes
# DAY#<date> at the first tick at or after 05:00 America/New_York. The filter counts a line whose count is at
# least 10; the alarm fires when no such line arrives inside the 05:00 to 05:30 Eastern window. CloudWatch cannot
# read a wall clock, so the window is the UTC band 09:00 to 10:30 that covers 05:00 to 05:30 under both offsets
# (09:00 to 09:30 EDT, 10:00 to 10:30 EST), checked as three consecutive 30-minute periods through metric math
# HOUR() and MINUTE(); every other period evaluates to 1 and never breaches. It evaluates at 10:30 UTC (05:30 EST,
# 06:30 EDT) and returns to OK on its own at 11:00 UTC, so it carries no ok_actions.
resource "aws_cloudwatch_log_metric_filter" "delegated_worker_list_built" {
  count          = var.delegated_worker_enabled ? 1 : 0
  name           = "${local.delegated_name}-list-built"
  log_group_name = aws_cloudwatch_log_group.delegated_worker[0].name
  pattern        = "{ ($.event = \"LIST_BUILT\") && ($.count >= 10) }"
  metric_transformation {
    name          = "ListBuilt"
    namespace     = "Callie/DelegatedWorker"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "delegated_worker_list_short" {
  count               = local.delegated_schedule_enabled ? 1 : 0
  alarm_name          = "${local.delegated_name}-list-short"
  alarm_description   = "No LIST_BUILT line with count >= 10 between 05:00 and 05:30 Eastern: the morning list is missing or short."
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.delegated_worker_alarms[0].arn]
  tags                = { Component = "delegated-worker" }
  metric_query {
    id          = "built"
    return_data = false
    metric {
      namespace   = "Callie/DelegatedWorker"
      metric_name = "ListBuilt"
      period      = 1800
      stat        = "Sum"
    }
  }
  metric_query {
    id          = "filled"
    expression  = "FILL(built, 0)"
    return_data = false
  }
  metric_query {
    id          = "window"
    label       = "LIST_BUILT with count >= 10 inside 09:00-10:30 UTC"
    expression  = "IF(HOUR(filled) == 9 OR (HOUR(filled) == 10 AND MINUTE(filled) == 0), filled, 1)"
    return_data = true
  }
  depends_on = [aws_cloudwatch_log_metric_filter.delegated_worker_list_built]
}

# Account-wide monthly cost: after the legacy sourcing stack was destroyed (17 September 2026)
# the worker is the only stack in the account. Not a hard cap; Budgets notify, they never stop spend.
resource "aws_budgets_budget" "delegated_worker_monthly" {
  count        = var.delegated_worker_enabled ? 1 : 0
  name         = "${local.delegated_name}-monthly-usd"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_sns_topic_arns  = [aws_sns_topic.delegated_worker_alarms[0].arn]
    subscriber_email_addresses = var.alarm_email != "" ? [var.alarm_email] : null
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 200
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_sns_topic_arns  = [aws_sns_topic.delegated_worker_alarms[0].arn]
    subscriber_email_addresses = var.alarm_email != "" ? [var.alarm_email] : null
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_sns_topic_arns  = [aws_sns_topic.delegated_worker_alarms[0].arn]
    subscriber_email_addresses = var.alarm_email != "" ? [var.alarm_email] : null
  }
  depends_on = [aws_sns_topic_policy.delegated_worker_alarms]
}

# The job queue of the rebuilt core (FSS target design sections 1 and 4; slice S3). One FIFO queue with three
# message groups (mail, research, day), one dead-letter queue behind three attempts, and two more functions built
# from the same artifact as the API: the scheduler decides what is due every five minutes and finishes in seconds,
# the runner consumes one message at a time with a five-minute budget inside a six-minute timeout inside a
# thirty-six-minute visibility timeout. Deduplication ids are supplied by the worker (the sha256 of the job id),
# never derived from the message body, so the queue never has to look at what a job carries.
#
# Three roles, not one: the scheduler reaches the table and the queue and nothing else; the runner reaches the
# table, the queue and the two Google SecureStrings (which is the only reason it holds a KMS grant through SSM);
# the API role is exactly what it was. Only the API function carries the Google client id for the consent flow.
# Creating a queue is not permission to send anything.
resource "aws_sqs_queue" "delegated_worker_jobs_dlq" {
  count                     = var.delegated_worker_enabled ? 1 : 0
  name                      = "${local.delegated_name}-jobs-dlq.fifo"
  fifo_queue                = true
  sqs_managed_sse_enabled   = true
  message_retention_seconds = 1209600
  tags                      = { Component = "delegated-worker" }
}

resource "aws_sqs_queue" "delegated_worker_jobs" {
  count      = var.delegated_worker_enabled ? 1 : 0
  name       = "${local.delegated_name}-jobs.fifo"
  fifo_queue = true
  # The worker supplies the deduplication id; nothing is ever deduplicated by looking at a message body.
  content_based_deduplication = false
  sqs_managed_sse_enabled     = true
  # Longer than the runner's six-minute timeout, so a message is never redelivered while its job is still running.
  visibility_timeout_seconds = 2160
  message_retention_seconds  = 345600
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.delegated_worker_jobs_dlq[0].arn
    maxReceiveCount     = 3
  })
  tags = { Component = "delegated-worker" }
}

resource "aws_cloudwatch_log_group" "delegated_worker_scheduler" {
  count             = var.delegated_worker_enabled ? 1 : 0
  name              = "/aws/lambda/${local.delegated_name}-scheduler"
  retention_in_days = 7
}

resource "aws_cloudwatch_log_group" "delegated_worker_runner" {
  count             = var.delegated_worker_enabled ? 1 : 0
  name              = "/aws/lambda/${local.delegated_name}-runner"
  retention_in_days = 7
}

resource "aws_iam_role" "delegated_worker_scheduler" {
  count = var.delegated_worker_enabled ? 1 : 0
  name  = "${local.delegated_name}-scheduler"
  path  = var.iam_path
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole"
  }] })
}

# The table and the queue only. No SSM parameter, no KMS key, no mailbox: the scheduler cannot send anything.
resource "aws_iam_role_policy" "delegated_worker_scheduler" {
  count = var.delegated_worker_enabled ? 1 : 0
  name  = "table-and-queue-send"
  role  = aws_iam_role.delegated_worker_scheduler[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect    = "Allow", Action = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:ConditionCheckItem"],
      Resource  = aws_dynamodb_table.delegated_worker[0].arn,
      Condition = { "ForAllValues:StringEquals" = { "dynamodb:LeadingKeys" = ["WORKSPACE#${var.delegated_workspace_id}"] } }
    },
    { Effect = "Allow", Action = ["sqs:SendMessage", "sqs:GetQueueAttributes"], Resource = aws_sqs_queue.delegated_worker_jobs[0].arn },
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.delegated_worker_scheduler[0].arn}:*" }
  ] })
}

resource "aws_iam_role" "delegated_worker_runner" {
  count = var.delegated_worker_enabled ? 1 : 0
  name  = "${local.delegated_name}-runner"
  path  = var.iam_path
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole"
  }] })
}

# The table, the queue it consumes, and the Google SecureStrings it needs to refresh the mailbox token. The KMS
# grant is conditioned on SSM exactly as the API role's is; nothing here may read a parameter by any other path.
resource "aws_iam_role_policy" "delegated_worker_runner" {
  count = var.delegated_worker_enabled ? 1 : 0
  name  = "table-queue-and-google-parameters"
  role  = aws_iam_role.delegated_worker_runner[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect    = "Allow", Action = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:ConditionCheckItem"],
      Resource  = aws_dynamodb_table.delegated_worker[0].arn,
      Condition = { "ForAllValues:StringEquals" = { "dynamodb:LeadingKeys" = ["WORKSPACE#${var.delegated_workspace_id}"] } }
    },
    { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource = aws_sqs_queue.delegated_worker_jobs[0].arn },
    { Effect = "Allow", Action = ["ssm:GetParameter"], Resource = local.delegated_parameter_arns },
    { Effect = "Allow", Action = ["kms:Decrypt"], Resource = aws_kms_key.delegated_worker[0].arn,
      Condition = {
        StringEquals               = { "kms:ViaService" = "ssm.${var.aws_region}.amazonaws.com" },
        "ForAnyValue:StringEquals" = { "kms:EncryptionContext:PARAMETER_ARN" = local.delegated_parameter_arns }
      }
    },
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.delegated_worker_runner[0].arn}:*" }
  ] })
}

resource "aws_lambda_function" "delegated_worker_scheduler" {
  count            = var.delegated_worker_enabled ? 1 : 0
  function_name    = "${local.delegated_name}-scheduler"
  role             = aws_iam_role.delegated_worker_scheduler[0].arn
  filename         = data.archive_file.delegated_worker[0].output_path
  source_code_hash = data.archive_file.delegated_worker[0].output_base64sha256
  runtime          = "nodejs22.x"
  handler          = "scheduler.handler"
  architectures    = ["arm64"]
  memory_size      = 256
  # It reads the due index and the counters and enqueues; it finishes in seconds and does no work of its own.
  timeout = 60
  # One tick at a time: two schedulers would enqueue the same deterministic ids, but never usefully.
  reserved_concurrent_executions = 1
  environment {
    variables = {
      DELEGATED_WORKER_ENABLED      = "true"
      DELEGATED_WORKER_TABLE        = aws_dynamodb_table.delegated_worker[0].name
      DELEGATED_WORKSPACE_ID        = var.delegated_workspace_id
      DELEGATED_WORKER_QUEUE_URL    = aws_sqs_queue.delegated_worker_jobs[0].url
      DELEGATED_WORKER_SCHEDULE_ARN = local.delegated_schedule_enabled ? aws_cloudwatch_event_rule.delegated_worker[0].arn : ""
    }
  }
  depends_on = [aws_iam_role_policy.delegated_worker_scheduler, aws_cloudwatch_log_group.delegated_worker_scheduler]
}

resource "aws_lambda_function" "delegated_worker_runner" {
  count            = var.delegated_worker_enabled ? 1 : 0
  function_name    = "${local.delegated_name}-runner"
  role             = aws_iam_role.delegated_worker_runner[0].arn
  filename         = data.archive_file.delegated_worker[0].output_path
  source_code_hash = data.archive_file.delegated_worker[0].output_base64sha256
  runtime          = "nodejs22.x"
  handler          = "runner.handler"
  architectures    = ["arm64"]
  memory_size      = 512
  # Five minutes of job budget inside this timeout, inside the queue's thirty-six-minute visibility timeout.
  timeout = 360
  # One execution per message group: mail, research, day.
  reserved_concurrent_executions = 3
  environment {
    variables = {
      DELEGATED_WORKER_ENABLED          = "true"
      DELEGATED_WORKER_TABLE            = aws_dynamodb_table.delegated_worker[0].name
      DELEGATED_WORKSPACE_ID            = var.delegated_workspace_id
      DELEGATED_WORKER_QUEUE_URL        = aws_sqs_queue.delegated_worker_jobs[0].url
      DELEGATED_WORKER_HOST             = replace(aws_apigatewayv2_api.delegated_worker[0].api_endpoint, "https://", "")
      DELEGATED_GOOGLE_CLIENT_ID        = var.delegated_google_client_id
      DELEGATED_GOOGLE_SECRET_PARAMETER = var.delegated_google_client_id == "" ? "" : local.delegated_secret_parameter
      DELEGATED_GOOGLE_KEY_PARAMETER    = var.delegated_google_client_id == "" ? "" : local.delegated_key_parameter
    }
  }
  depends_on = [aws_iam_role_policy.delegated_worker_runner, aws_cloudwatch_log_group.delegated_worker_runner]
}

# One job per invocation. No batching, no partial-batch responses: a job either settles or is redelivered whole.
resource "aws_lambda_event_source_mapping" "delegated_worker_runner" {
  count                              = var.delegated_worker_enabled ? 1 : 0
  event_source_arn                   = aws_sqs_queue.delegated_worker_jobs[0].arn
  function_name                      = aws_lambda_function.delegated_worker_runner[0].arn
  batch_size                         = 1
  maximum_batching_window_in_seconds = 0
  enabled                            = true
}

# The scheduler shares the existing five-minute rule as a second target, so there is exactly one schedule to switch
# off from the AWS console in the phone-only stop. Disabling the rule stops the scheduler and the old tick together.
resource "aws_cloudwatch_event_target" "delegated_worker_scheduler" {
  count     = local.delegated_schedule_enabled ? 1 : 0
  rule      = aws_cloudwatch_event_rule.delegated_worker[0].name
  target_id = "delegated-scheduler-tick"
  arn       = aws_lambda_function.delegated_worker_scheduler[0].arn
  retry_policy {
    maximum_event_age_in_seconds = 60
    maximum_retry_attempts       = 0
  }
  depends_on = [aws_lambda_permission.delegated_worker_scheduler]
}

resource "aws_lambda_permission" "delegated_worker_scheduler" {
  count          = local.delegated_schedule_enabled ? 1 : 0
  statement_id   = "DedicatedSchedulerScheduleOnly"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.delegated_worker_scheduler[0].function_name
  principal      = "events.amazonaws.com"
  source_arn     = aws_cloudwatch_event_rule.delegated_worker[0].arn
  source_account = var.aws_account_id
}

# A job that failed three times is on the dead-letter queue and nobody is looking at it: that is what this says.
resource "aws_cloudwatch_metric_alarm" "delegated_worker_dlq_depth" {
  count               = var.delegated_worker_enabled ? 1 : 0
  alarm_name          = "${local.delegated_name}-dlq-depth"
  alarm_description   = "A job reached the delegated worker's dead-letter queue after three attempts."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.delegated_worker_jobs_dlq[0].name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.delegated_worker_alarms[0].arn]
  ok_actions          = [aws_sns_topic.delegated_worker_alarms[0].arn]
  tags                = { Component = "delegated-worker" }
}

# The runner's heartbeat is the age of the oldest message nobody has taken. An empty queue reports nothing, so a
# quiet hour never fires; half an hour of unread work means the runner is not alive or not keeping up.
resource "aws_cloudwatch_metric_alarm" "delegated_worker_runner_heartbeat" {
  count               = var.delegated_worker_enabled ? 1 : 0
  alarm_name          = "${local.delegated_name}-runner-heartbeat"
  alarm_description   = "The delegated worker's job queue held an unread message for more than 30 minutes: the runner is not draining it."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = aws_sqs_queue.delegated_worker_jobs[0].name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 1800
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.delegated_worker_alarms[0].arn]
  ok_actions          = [aws_sns_topic.delegated_worker_alarms[0].arn]
  tags                = { Component = "delegated-worker" }
}
