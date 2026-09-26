output "topic_arn" {
  description = "Alert topic ARN."
  value       = aws_sns_topic.alerts.arn
}

output "topic_name" {
  description = "Alert topic name."
  value       = aws_sns_topic.alerts.name
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

output "warning_composite_alarm_name" {
  description = "Composite alarm over every warning condition."
  value       = aws_cloudwatch_composite_alarm.warning.alarm_name
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
