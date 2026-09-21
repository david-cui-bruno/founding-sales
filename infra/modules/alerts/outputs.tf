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

output "critical_composite_alarm_name" {
  description = "Composite alarm over every immediately critical condition."
  value       = aws_cloudwatch_composite_alarm.critical.alarm_name
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
  description = "Configured alert recipients, for offline assertions."
  value       = sort(var.alert_emails)
}
