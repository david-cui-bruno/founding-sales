# ---------------------------------------------------------------------------
# Observability: alarms on pipeline failure.
#
# Alarm -> SNS topic -> email (budget_notification_email). ntfy hot pushes are
# for leads; alarms are for the operator.
# ---------------------------------------------------------------------------

locals {
  scheduled_health_alarm_actions = var.schedules_enabled && var.scheduled_health_alerts_enabled ? [aws_sns_topic.alerts.arn] : []

  missing_success_cadences = {
    quarter_hour = { period = 300, evaluation_periods = 6, datapoints_to_alarm = 6 }
    hourly       = { period = 600, evaluation_periods = 12, datapoints_to_alarm = 12 }
    daily        = { period = 3600, evaluation_periods = 48, datapoints_to_alarm = 48 }
  }

  persistent_unprocessed_cadences = {
    quarter_hour = { period = 900 }
    hourly       = { period = 3600 }
    daily        = { period = 86400 }
  }

  non_monthly_sources = {
    for key, source in local.adapter_functions : key => merge(
      source,
      lookup(local.missing_success_cadences, source.cadence, {}),
    )
    if source.cadence != "monthly"
  }

  non_monthly_unprocessed_sources = {
    for key, source in local.adapter_functions : key => merge(
      source,
      lookup(local.persistent_unprocessed_cadences, source.cadence, {}),
    )
    if source.cadence != "monthly" && source.has_unprocessed_metric
  }
}

resource "aws_sns_topic" "alerts" {
  name = "${var.name_prefix}-ops-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.budget_notification_email
}

resource "aws_cloudwatch_log_metric_filter" "scheduled_run_success" {
  for_each = local.adapter_functions

  name           = "${var.name_prefix}-${each.key}-scheduled-run-success"
  log_group_name = aws_cloudwatch_log_group.adapters[each.key].name
  pattern        = "{ $.eventCode = \"SCHEDULED_RUN_COMPLETED\" && $.status = \"success\" }"

  metric_transformation {
    name       = "ScheduledRunSuccess"
    namespace  = "Callie/Sourcing"
    value      = "1"
    unit       = "Count"
    dimensions = { Component = "$.component" }
  }
}

resource "aws_cloudwatch_log_metric_filter" "scheduled_run_unprocessed" {
  for_each = local.adapter_functions

  name           = "${var.name_prefix}-${each.key}-scheduled-run-unprocessed"
  log_group_name = aws_cloudwatch_log_group.adapters[each.key].name
  pattern        = "{ $.eventCode = \"SCHEDULED_RUN_COMPLETED\" && $.status = \"success\" && $.unprocessedCount = * }"

  metric_transformation {
    name       = "ScheduledRunUnprocessed"
    namespace  = "Callie/Sourcing"
    value      = "$.unprocessedCount"
    unit       = "Count"
    dimensions = { Component = "$.component" }
  }
}

# Any error in the mail-parse Lambda: the hot path must never silently break.
resource "aws_cloudwatch_metric_alarm" "mail_parse_errors" {
  alarm_name          = "${var.name_prefix}-mail-parse-errors"
  alarm_description   = "Inbound mail parsing failed; hot leads may be stuck in raw-mail."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.mail_parse.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "adapter_errors" {
  for_each = local.adapter_functions

  alarm_name          = "${var.name_prefix}-${each.key}-errors"
  alarm_description   = each.value.error_description
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.adapters[each.key].function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "adapter_throttles" {
  for_each = local.adapter_functions

  alarm_name          = "${var.name_prefix}-${each.key}-throttles"
  alarm_description   = "Sourcing ${each.key} Lambda was throttled."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = { FunctionName = aws_lambda_function.adapters[each.key].function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "adapter_near_timeout" {
  for_each = local.adapter_functions

  alarm_name                            = "${var.name_prefix}-${each.key}-near-timeout"
  alarm_description                     = "Sourcing ${each.key} p95 duration reached 90 percent of its Lambda timeout."
  namespace                             = "AWS/Lambda"
  metric_name                           = "Duration"
  dimensions                            = { FunctionName = aws_lambda_function.adapters[each.key].function_name }
  extended_statistic                    = "p95"
  period                                = 300
  evaluation_periods                    = 1
  threshold                             = each.value.timeout * 1000 * 0.90
  comparison_operator                   = "GreaterThanOrEqualToThreshold"
  treat_missing_data                    = "notBreaching"
  evaluate_low_sample_count_percentiles = "evaluate"
  alarm_actions                         = [aws_sns_topic.alerts.arn]
  ok_actions                            = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "scheduled_missing_success" {
  for_each = local.non_monthly_sources

  alarm_name          = "${var.name_prefix}-${each.key}-missing-success"
  alarm_description   = "No successful ${each.key} completion was observed within twice its expected cadence."
  namespace           = "Callie/Sourcing"
  metric_name         = "ScheduledRunSuccess"
  dimensions          = { Component = each.key }
  statistic           = "Sum"
  period              = each.value.period
  evaluation_periods  = each.value.evaluation_periods
  datapoints_to_alarm = each.value.datapoints_to_alarm
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.scheduled_health_alarm_actions
  ok_actions          = local.scheduled_health_alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "scheduled_persistent_unprocessed" {
  for_each = local.non_monthly_unprocessed_sources

  alarm_name          = "${var.name_prefix}-${each.key}-persistent-unprocessed"
  alarm_description   = "${each.key} reported positive unprocessed work in two consecutive expected periods."
  namespace           = "Callie/Sourcing"
  metric_name         = "ScheduledRunUnprocessed"
  dimensions          = { Component = each.key }
  statistic           = "Minimum"
  period              = each.value.period
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.scheduled_health_alarm_actions
  ok_actions          = local.scheduled_health_alarm_actions
}
