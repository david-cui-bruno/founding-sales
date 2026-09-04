# ---------------------------------------------------------------------------
# Observability: alarms on pipeline failure.
#
# Alarm -> SNS topic -> email (budget_notification_email). ntfy hot pushes are
# for leads; alarms are for the operator.
# ---------------------------------------------------------------------------

resource "aws_sns_topic" "alerts" {
  name = "${var.name_prefix}-ops-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.budget_notification_email
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

# Any suppression-sync error is a compliance incident: uploads or historical
# replay may not have reached the fail-closed suppression membership table.
resource "aws_cloudwatch_metric_alarm" "suppression_sync_errors" {
  alarm_name          = "${var.name_prefix}-suppression-sync-errors"
  alarm_description   = "Suppression sync or replay failed; outbound enrichment must remain paused."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.adapters["suppression-sync"].function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# Adapter/scorer errors: batch tier, daily cadence, so a single failure matters.
resource "aws_cloudwatch_metric_alarm" "adapter_errors" {
  for_each = local.adapter_functions

  alarm_name          = "${var.name_prefix}-${each.key}-errors"
  alarm_description   = "Sourcing ${each.key} Lambda failed."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.adapters[each.key].function_name }
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
