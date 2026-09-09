# Disabled-by-default isolated worker. No EventBridge/schedule resource is created
# here and no existing polling rule is changed. C2 has no mail dispatch route.
#
# Review envelope before activation: one low-volume workspace, <10k API calls/mo,
# <=1 GiB table, 7-day bounded logs, 256 MiB/30s Lambda with concurrency 2, one KMS
# key and two standard SecureStrings. Target incremental non-AI spend <=$20/mo.
# This is a planning envelope, not a quote or hard billing cap. Validate regional
# prices, existing spend and abuse exposure. Polling, models, research, cold-mail
# transport and high-volume workloads are NOT included or silently activated.
#
# SecureString values must be provisioned separately after approval, using this
# KMS key: google-client-secret and token-encryption-key (32 random bytes/base64).
# Terraform never reads/writes their values. Review rotation/recovery before use.
locals {
  delegated_name             = "${var.name_prefix}-delegated-worker"
  delegated_parameter_path   = "/delegated-worker/${var.delegated_workspace_id}"
  delegated_secret_parameter = "${local.delegated_parameter_path}/google-client-secret"
  delegated_key_parameter    = "${local.delegated_parameter_path}/token-encryption-key"
  delegated_parameter_arns = [
    "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${local.delegated_secret_parameter}",
    "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter${local.delegated_key_parameter}"
  ]
  delegated_routes = toset([
    "POST /pairing/redeem", "POST /pairing/revoke", "POST /commands", "POST /emergency",
    "GET /events", "POST /google/begin", "GET /google/status", "GET /google/disclosure",
    "POST /google/revoke", "GET /oauth/callback"
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
  source_dir  = "${path.module}/../lambdas/delegated-worker/dist"
  output_path = "${path.module}/.build/delegated-worker.zip"
}

resource "aws_lambda_function" "delegated_worker" {
  count                          = var.delegated_worker_enabled ? 1 : 0
  function_name                  = local.delegated_name
  role                           = aws_iam_role.delegated_worker[0].arn
  filename                       = data.archive_file.delegated_worker[0].output_path
  source_code_hash               = data.archive_file.delegated_worker[0].output_base64sha256
  runtime                        = "nodejs22.x"
  handler                        = "index.handler"
  architectures                  = ["arm64"]
  memory_size                    = 256
  timeout                        = 30
  reserved_concurrent_executions = 2
  environment {
    variables = {
      DELEGATED_WORKER_ENABLED          = "true"
      DELEGATED_WORKER_TABLE            = aws_dynamodb_table.delegated_worker[0].name
      DELEGATED_WORKSPACE_ID            = var.delegated_workspace_id
      DELEGATED_WORKER_HOST             = replace(aws_apigatewayv2_api.delegated_worker[0].api_endpoint, "https://", "")
      DELEGATED_GOOGLE_CLIENT_ID        = var.delegated_google_client_id
      DELEGATED_GOOGLE_SECRET_PARAMETER = var.delegated_google_client_id == "" ? "" : local.delegated_secret_parameter
      DELEGATED_GOOGLE_KEY_PARAMETER    = var.delegated_google_client_id == "" ? "" : local.delegated_key_parameter
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
  default_route_settings {
    throttling_burst_limit = 5
    throttling_rate_limit  = 2
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
