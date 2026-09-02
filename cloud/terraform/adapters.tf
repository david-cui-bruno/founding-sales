# ---------------------------------------------------------------------------
# Adapter + scorer Lambdas and their DISABLED EventBridge schedules.
#
# These were first created via CLI during live verification and are absorbed
# here via `tofu import` (see cloud/README.md). Build the bundles BEFORE
# plan/apply:
#   for d in adapter-pvd-taxroll adapter-boston-rentsmart scorer resolver enricher; do
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
      # Monthly (1st, 09:00 UTC): the Providence roll is published annually
      # per tax year; a monthly idempotent re-pull catches mid-year corrections
      # without the cosmetic waste of a weekly run (review finding F11).
      schedule = "cron(0 9 1 * ? *)"
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
    # Enrichment gate: app-requested Tracerfy skip traces only (no bulk
    # enrichment, ever — docs/superpowers/plans/2026-09-01-enrichment-gate.md).
    # Suppression-checks every returned contact, flags DNC/TCPA in the payload
    # and enforces a monthly vendor credit cap with an SNS alarm.
    "enricher" = {
      source_dir  = "${path.module}/../lambdas/enricher/dist"
      memory_size = 512
      timeout     = 300
      environment = {
        INBOX_BUCKET      = aws_s3_bucket.inbox.bucket
        IDEMPOTENCY_TABLE = aws_dynamodb_table.idempotency.name
        SNAPSHOTS_TABLE   = aws_dynamodb_table.snapshots.name
        SUPPRESSION_TABLE = aws_dynamodb_table.suppression.name
        SNS_TOPIC_ARN     = aws_sns_topic.alerts.arn
        # GO-LIVE SWITCH: flip TRACERFY_BASE_URL to https://tracerfy.com when
        # the funded Tracerfy account exists (and put the real token in
        # terraform.tfvars). The sandbox mirrors the exact API, accepts any
        # non-empty token, and bills nothing — never point prod traffic at it.
        TRACERFY_BASE_URL         = "https://mock.tracerfy.com"
        TRACERFY_API_KEY          = var.tracerfy_api_key
        ENRICH_MONTHLY_CREDIT_CAP = "1000" # 1000 credits ≈ $20 at 5 credits/$0.10
      }
      schedule = "rate(15 minutes)"
    }
    # Compliance: app opt-out HMAC uploads -> suppression table (the internal
    # do-not-call list the enricher checks before any contact-bearing event
    # reaches the inbox). Same cadence as the enricher it protects.
    "suppression-sync" = {
      source_dir  = "${path.module}/../lambdas/suppression-sync/dist"
      memory_size = 256
      timeout     = 60
      # Own role: the ONLY writer of the suppression table. The shared
      # adapters role stays read-only on it by design (enricher checks,
      # never writes).
      role_arn = aws_iam_role.lambda_suppression_sync.arn
      environment = {
        INBOX_BUCKET      = aws_s3_bucket.inbox.bucket
        SNAPSHOTS_TABLE   = aws_dynamodb_table.snapshots.name
        SUPPRESSION_TABLE = aws_dynamodb_table.suppression.name
      }
      schedule = "rate(15 minutes)"
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
  role          = lookup(each.value, "role_arn", aws_iam_role.lambda_adapters.arn)

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
# Schedules: gated by var.schedules_enabled. Created DISABLED; enabled
# 2026-09-02 after the quality pass (founder delegated the review; top-25
# verified against city records at 88% pass, scores v2). Flip the variable
# to false to pause the whole pipeline.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "adapters" {
  for_each = local.adapter_functions

  name                = "${var.name_prefix}-${each.key}-schedule"
  schedule_expression = each.value.schedule
  state               = var.schedules_enabled ? "ENABLED" : "DISABLED"
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
