output "environment" {
  description = "Always production."
  value       = module.stack.environment
}

output "name_prefix" {
  description = "Always fss-prod."
  value       = module.stack.name_prefix
}

output "destroyable" {
  description = "Always false."
  value       = module.stack.destroyable
}

output "deployment_role_name" {
  description = "IAM role this root assumes."
  value       = var.deployment_role_name
}

output "resource_names" {
  description = "Every name this root claims in the shared account."
  value       = module.stack.resource_names
}

output "load_balancer_dns_name" {
  description = "Point the API DNS record at this."
  value       = module.stack.load_balancer_dns_name
}

output "load_balancer_zone_id" {
  description = "Hosted zone id for the alias record."
  value       = module.stack.load_balancer_zone_id
}

output "database_endpoint" {
  description = "Host and port for application connections."
  value       = module.stack.database_endpoint
}

output "database_master_secret_arn" {
  description = "RDS-managed master user secret ARN."
  value       = module.stack.database_master_secret_arn
}

output "database_name" {
  description = "Application database name."
  value       = module.stack.database_name
}

output "task_runtime_platform" {
  description = "Operating system family and CPU architecture on each task definition."
  value       = module.stack.task_runtime_platform
}

output "repository_urls" {
  description = "ECR repository URLs keyed by service short name."
  value       = module.stack.repository_urls
}

output "secret_names" {
  description = "Secrets Manager entry names. Created empty; values entered by hand."
  value       = module.stack.secret_names
}

output "journal_bucket_name" {
  description = "Suppression journal bucket."
  value       = module.stack.journal_bucket_name
}

output "alert_topic_arn" {
  description = "Alert topic ARN."
  value       = module.stack.alert_topic_arn
}

output "alarm_names" {
  description = "Every alarm name in production."
  value       = module.stack.alarm_names
}

output "log_group_names" {
  description = "Log group names keyed by service short name."
  value       = module.stack.log_group_names
}

output "updates_distribution_domain_name" {
  description = "Hostname the Electron updater points at."
  value       = module.stack.updates_distribution_domain_name
}

output "gmail_push_topic_id" {
  description = "Pub/Sub topic id for Gmail watch requests."
  value       = module.stack.gmail_push_topic_id
}

output "gmail_push_audience" {
  description = "Exact audience the API requires on a push token."
  value       = module.stack.gmail_push_audience
}
