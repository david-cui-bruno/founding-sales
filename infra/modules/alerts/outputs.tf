output "topic_arn" {
  description = "Alert topic ARN."
  value       = aws_sns_topic.alerts.arn
}

output "topic_name" {
  description = "Alert topic name."
  value       = aws_sns_topic.alerts.name
}

output "kms_key_arn" {
  description = "Customer key protecting the alert topic."
  value       = local.topic_key_arn
}

output "created_own_kms_key" {
  description = <<-EOT
    Whether this module created the topic key, or was given one.

    A boolean the plan always knows, so a caller can assert the decision even
    when the key it passed is created in the same apply and its ARN is unknown.
  EOT
  value       = length(aws_kms_key.alerts) == 1
}

output "alarm_names" {
  description = "Every metric alarm name."
  value       = sort(concat([for alarm in aws_cloudwatch_metric_alarm.this : alarm.alarm_name], [aws_cloudwatch_metric_alarm.all_sequences_held.alarm_name]))
}

output "alarm_metric_namespaces" {
  description = "Every CloudWatch namespace any metric alarm reads, read back from the alarm resources, the metric-math alarm's two queries included. One environment reads exactly one: [var.metric_namespace]."
  value = sort(distinct(concat(
    [for alarm in aws_cloudwatch_metric_alarm.this : alarm.namespace],
    flatten([
      for query in aws_cloudwatch_metric_alarm.all_sequences_held.metric_query :
      [for metric in query.metric : metric.namespace]
    ]),
  )))
}

output "critical_composite_alarm_name" {
  description = "Composite alarm over every immediately critical condition."
  value       = aws_cloudwatch_composite_alarm.critical.alarm_name
}

output "critical_condition_alarm_names" {
  description = "The composite alarm of each immediately critical condition, keyed by the condition. Each trips when its condition does, even while another is open (lane g81); none e-mails (lane g99)."
  value       = { for name, alarm in aws_cloudwatch_composite_alarm.critical_condition : name => alarm.alarm_name }
}

output "warning_composite_alarm_name" {
  description = "Composite alarm over every warning condition."
  value       = aws_cloudwatch_composite_alarm.warning.alarm_name
}

output "alarm_inventory" {
  description = "The declared alarm inventory. Every metric alarm resource is generated from it."
  value       = local.alarms
}

output "subscription_endpoints" {
  description = "Configured recipients of the daily alarm digest, for offline assertions."
  value       = sort(var.alert_emails)
}

output "digest_function_name" {
  description = "The Lambda function that publishes the daily alarm digest (lane g99)."
  value       = aws_lambda_function.digest.function_name
}

output "digest_schedule" {
  description = "When the digest runs: the Scheduler expression and the zone it is evaluated in."
  value = {
    name       = aws_scheduler_schedule.digest.name
    expression = aws_scheduler_schedule.digest.schedule_expression
    time_zone  = aws_scheduler_schedule.digest.schedule_expression_timezone
  }
}

output "digest_resource_names" {
  description = "Every name the digest claims: its function, its log group, its two roles and its schedule. Known at plan time, for the roots' namespace assertions."
  value = [
    local.digest_name,
    local.digest_log_group_name,
    aws_iam_role.digest.name,
    aws_iam_role.digest_schedule.name,
    aws_scheduler_schedule.digest.name,
  ]
}
