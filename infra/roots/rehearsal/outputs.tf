output "environment" {
  description = "Always rehearsal."
  value       = module.stack.environment
}

output "name_prefix" {
  description = "The fss-rh- namespace this run owns."
  value       = module.stack.name_prefix
}

output "destroyable" {
  description = "Always true."
  value       = module.stack.destroyable
}

output "deployment_role_name" {
  description = "IAM role this root assumes. Scoped to fss-rh-*."
  value       = var.deployment_role_name
}

output "resource_names" {
  description = "Every name this run claims in the shared account."
  value       = module.stack.resource_names
}

output "load_balancer_dns_name" {
  description = "Rehearsal load balancer hostname."
  value       = module.stack.load_balancer_dns_name
}

output "database_endpoint" {
  description = "Host and port for the rehearsal database."
  value       = module.stack.database_endpoint
}

output "database_master_secret_arn" {
  description = <<-EOT
    RDS-managed master user secret ARN. The release workflow reads this secret
    with the rehearsal role and assembles `FSS_TEST_POSTGRES_URL` in the job, so
    no static rehearsal database URL exists as a repository secret. See
    `docs/decisions/g12c-the-rehearsal-database-url-is-derived.md`.
  EOT
  value       = module.stack.database_master_secret_arn
}

output "database_name" {
  description = "Application database name. The third part of the derived rehearsal database URL."
  value       = module.stack.database_name
}

output "task_runtime_platform" {
  description = "Operating system family and CPU architecture on each task definition."
  value       = module.stack.task_runtime_platform
}

output "journal_bucket_name" {
  description = "Rehearsal suppression journal bucket."
  value       = module.stack.journal_bucket_name
}

output "journal_object_lock" {
  description = "Object lock mode and retention in force on the rehearsal journal."
  value       = module.stack.journal_object_lock
}

output "cluster_name" {
  description = "Rehearsal ECS cluster name."
  value       = module.stack.cluster_name
}

output "alert_topic_arn" {
  description = "Rehearsal alert topic ARN."
  value       = module.stack.alert_topic_arn
}

output "log_group_names" {
  description = "Rehearsal log group names."
  value       = module.stack.log_group_names
}

output "secret_names" {
  description = "Rehearsal Secrets Manager entry names. Created empty."
  value       = module.stack.secret_names
}
