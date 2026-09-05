# ---------------------------------------------------------------------------
# Quality dashboard: one CloudWatch dashboard for the whole pipeline.
# Cost: $3/mo (first 3 dashboards free tier permitting).
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_dashboard" "pipeline" {
  dashboard_name = "${var.name_prefix}-pipeline"

  dashboard_body = jsonencode({
    widgets = [
      {
        type       = "text", x = 0, y = 0, width = 24, height = 1,
        properties = { markdown = "## Callie sourcing pipeline — invocations, errors, throttles, duration, successful completions, and persistent work. Source ROI and precision live in the app (outcome labels)." }
      },
      {
        type = "metric", x = 0, y = 1, width = 12, height = 6,
        properties = {
          title  = "Invocations"
          region = var.aws_region
          stat   = "Sum"
          period = 3600
          metrics = concat(
            [["AWS/Lambda", "Invocations", "FunctionName", aws_lambda_function.mail_parse.function_name]],
            [for k in keys(local.adapter_functions) :
              ["AWS/Lambda", "Invocations", "FunctionName", aws_lambda_function.adapters[k].function_name]
            ],
            [["AWS/Lambda", "Invocations", "FunctionName", aws_lambda_function.schedule_watchdog.function_name]]
          )
        }
      },
      {
        type = "metric", x = 12, y = 1, width = 12, height = 6,
        properties = {
          title  = "Errors"
          region = var.aws_region
          stat   = "Sum"
          period = 3600
          metrics = concat(
            [["AWS/Lambda", "Errors", "FunctionName", aws_lambda_function.mail_parse.function_name]],
            [for k in keys(local.adapter_functions) :
              ["AWS/Lambda", "Errors", "FunctionName", aws_lambda_function.adapters[k].function_name]
            ],
            [["AWS/Lambda", "Errors", "FunctionName", aws_lambda_function.schedule_watchdog.function_name]]
          )
        }
      },
      {
        type = "metric", x = 0, y = 7, width = 12, height = 6,
        properties = {
          title  = "Duration p95 (ms)"
          region = var.aws_region
          stat   = "p95"
          period = 3600
          metrics = concat(
            [["AWS/Lambda", "Duration", "FunctionName", aws_lambda_function.mail_parse.function_name]],
            [for k in keys(local.adapter_functions) :
              ["AWS/Lambda", "Duration", "FunctionName", aws_lambda_function.adapters[k].function_name]
            ],
            [["AWS/Lambda", "Duration", "FunctionName", aws_lambda_function.schedule_watchdog.function_name]]
          )
        }
      },
      {
        type = "metric", x = 12, y = 7, width = 12, height = 6,
        properties = {
          title  = "Throttles"
          region = var.aws_region
          stat   = "Sum"
          period = 3600
          metrics = concat(
            [for k in keys(local.adapter_functions) :
              ["AWS/Lambda", "Throttles", "FunctionName", aws_lambda_function.adapters[k].function_name]
            ],
            [["AWS/Lambda", "Throttles", "FunctionName", aws_lambda_function.schedule_watchdog.function_name]]
          )
        }
      },
      {
        type = "metric", x = 0, y = 13, width = 12, height = 6,
        properties = {
          title  = "Scheduled run successes"
          region = var.aws_region
          stat   = "Sum"
          period = 3600
          metrics = concat(
            [for key in keys(local.adapter_functions) :
              ["Callie/Sourcing", "ScheduledRunSuccess", "Component", key]
            ],
            [["Callie/Sourcing", "ScheduledRunSuccess", "Component", "schedule-watchdog"]]
          )
        }
      },
      {
        type = "metric", x = 12, y = 13, width = 12, height = 6,
        properties = {
          title  = "Unprocessed scheduled work"
          region = var.aws_region
          stat   = "Minimum"
          period = 3600
          metrics = [for key, source in local.adapter_functions :
            ["Callie/Sourcing", "ScheduledRunUnprocessed", "Component", key]
            if source.has_unprocessed_metric
          ]
        }
      },
      {
        type = "metric", x = 0, y = 19, width = 12, height = 6,
        properties = {
          title  = "Monthly missing success"
          region = var.aws_region
          stat   = "Maximum"
          period = 86400
          metrics = [for component in local.monthly_health_targets :
            ["Callie/Sourcing", "MonthlyMissingSuccess", "Component", component]
          ]
        }
      },
      {
        type = "metric", x = 12, y = 19, width = 12, height = 6,
        properties = {
          title  = "Monthly persistent unprocessed"
          region = var.aws_region
          stat   = "Maximum"
          period = 86400
          metrics = [for component in local.monthly_health_targets :
            ["Callie/Sourcing", "MonthlyPersistentUnprocessed", "Component", component]
          ]
        }
      },
      {
        type = "metric", x = 0, y = 25, width = 12, height = 6,
        properties = {
          title  = "Inbox bucket size / object count"
          region = var.aws_region
          period = 86400
          metrics = [
            ["AWS/S3", "NumberOfObjects", "BucketName", aws_s3_bucket.inbox.bucket, "StorageType", "AllStorageTypes", { stat = "Average" }],
            ["AWS/S3", "BucketSizeBytes", "BucketName", aws_s3_bucket.inbox.bucket, "StorageType", "StandardStorage", { stat = "Average", yAxis = "right" }],
          ]
        }
      },
    ]
  })
}
