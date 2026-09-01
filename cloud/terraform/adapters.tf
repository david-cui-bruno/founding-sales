# ---------------------------------------------------------------------------
# Adapter + scorer Lambdas and their DISABLED EventBridge schedules.
#
# These were first created via CLI during live verification and are absorbed
# here via `tofu import` (see cloud/README.md). Build the bundles BEFORE
# plan/apply:
#   for d in adapter-pvd-taxroll adapter-boston-rentsmart scorer; do
#     (cd cloud/lambdas/$d && PATH="/opt/homebrew/opt/node@24/bin:$PATH" npm install && npm run build)
#   done
# ---------------------------------------------------------------------------

locals {
  adapter_functions = {
    "adapter-pvd-taxroll" = {
      source_dir  = "${path.module}/../lambdas/adapter-pvd-taxroll/dist"
      memory_size = 512
      timeout     = 900
      environment = {
        INBOX_BUCKET      = aws_s3_bucket.inbox.bucket
        IDEMPOTENCY_TABLE = aws_dynamodb_table.idempotency.name
        SNAPSHOTS_TABLE   = aws_dynamodb_table.snapshots.name
        MAX_RUNTIME_MS    = "840000"
      }
      # Weekly: Sundays 09:00 UTC.
      schedule = "cron(0 9 ? * SUN *)"
    }
    "adapter-boston-rentsmart" = {
      source_dir  = "${path.module}/../lambdas/adapter-boston-rentsmart/dist"
      memory_size = 512
      timeout     = 900
      environment = {
        INBOX_BUCKET      = aws_s3_bucket.inbox.bucket
        IDEMPOTENCY_TABLE = aws_dynamodb_table.idempotency.name
        SNAPSHOTS_TABLE   = aws_dynamodb_table.snapshots.name
        MAX_RUNTIME_MS    = "840000"
      }
      # Daily 10:00 UTC.
      schedule = "cron(0 10 * * ? *)"
    }
    "scorer" = {
      source_dir  = "${path.module}/../lambdas/scorer/dist"
      memory_size = 256
      timeout     = 60
      environment = {
        INBOX_BUCKET    = aws_s3_bucket.inbox.bucket
        SNAPSHOTS_TABLE = aws_dynamodb_table.snapshots.name
        ENTITIES_TABLE  = aws_dynamodb_table.entities.name
      }
      schedule = "rate(15 minutes)"
    }
    "resolver" = {
      source_dir  = "${path.module}/../lambdas/resolver/dist"
      memory_size = 512
      timeout     = 300
      environment = {
        INBOX_BUCKET   = aws_s3_bucket.inbox.bucket
        ENTITIES_TABLE = aws_dynamodb_table.entities.name
      }
      schedule = "rate(1 hour)"
    }
  }
}

data "archive_file" "adapters" {
  for_each = local.adapter_functions

  type        = "zip"
  source_dir  = each.value.source_dir
  output_path = "${path.module}/.build/${each.key}.zip"
}

resource "aws_lambda_function" "adapters" {
  for_each = local.adapter_functions

  function_name = "${var.name_prefix}-${each.key}"
  role          = aws_iam_role.lambda_adapters.arn

  filename         = data.archive_file.adapters[each.key].output_path
  source_code_hash = data.archive_file.adapters[each.key].output_base64sha256

  runtime       = "nodejs22.x"
  handler       = "handler.handler"
  architectures = ["arm64"]

  memory_size = each.value.memory_size
  timeout     = each.value.timeout

  environment {
    variables = each.value.environment
  }
}

resource "aws_cloudwatch_log_group" "adapters" {
  for_each = local.adapter_functions

  name              = "/aws/lambda/${aws_lambda_function.adapters[each.key].function_name}"
  retention_in_days = 30
}

# ---------------------------------------------------------------------------
# Schedules: created DISABLED on purpose. Enable per source once the founder
# has reviewed the first batches (state change is a deliberate manual step or
# a later tfvars flip).
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "adapters" {
  for_each = local.adapter_functions

  name                = "${var.name_prefix}-${each.key}-schedule"
  schedule_expression = each.value.schedule
  state               = "DISABLED"
}

resource "aws_cloudwatch_event_target" "adapters" {
  for_each = local.adapter_functions

  rule = aws_cloudwatch_event_rule.adapters[each.key].name
  arn  = aws_lambda_function.adapters[each.key].arn
}

resource "aws_lambda_permission" "adapters_events" {
  for_each = local.adapter_functions

  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.adapters[each.key].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.adapters[each.key].arn
}
