output "log_group_names" {
  description = "Log group names keyed by service short name."
  value       = { for service, group in aws_cloudwatch_log_group.service : service => group.name }
}

output "kms_key_arn" {
  description = "Customer key protecting the log groups."
  value       = aws_kms_key.logs.arn
}
