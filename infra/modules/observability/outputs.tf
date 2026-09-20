output "log_group_names" {
  description = "Log group names keyed by service short name."
  value       = { for service, group in aws_cloudwatch_log_group.service : service => group.name }
}

output "log_group_arns" {
  description = "Log group ARNs keyed by service short name."
  value       = { for service, group in aws_cloudwatch_log_group.service : service => group.arn }
}

output "kms_key_arn" {
  description = "Customer key protecting the log groups."
  value       = aws_kms_key.logs.arn
}

output "metric_namespace" {
  description = "Namespace the metric filters publish to."
  value       = var.metric_namespace
}

output "metric_names" {
  description = "Metric names produced by the log metric filters, for offline assertions."
  value       = sort(distinct([for name, filter in local.metric_filters : filter.metric_name]))
}

output "retention_days" {
  description = "Operational log retention in days."
  value       = var.retention_days
}
