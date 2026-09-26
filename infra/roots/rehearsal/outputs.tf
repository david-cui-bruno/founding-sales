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

output "metric_namespace" {
  description = "The CloudWatch namespace this run publishes to and alarms on, FSS/<prefix>. The smoke step reads the canary age from here, so it can only ever read this run's metric."
  value       = module.stack.metric_namespace
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
    `docs/archive/decisions/g12c-the-rehearsal-database-url-is-derived.md`.
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

# ---------------------------------------------------------------------------
# What the shared deploy script and the run-task wrapper read (G12h).
#
# Every one of these is a public identifier, and every one is read from the
# plan rather than typed into a shell file, so the guards in
# `infra/scripts/release-common.sh` compare a launch against what Terraform
# actually created rather than against a literal somebody kept up to date.
# ---------------------------------------------------------------------------

output "cluster_arn" {
  description = "Rehearsal ECS cluster ARN. One-off tasks are launched against the ARN, never the name."
  value       = module.stack.cluster_arn
}

output "worker_log_group_name" {
  description = "Log group the worker, migration and operations tasks all write to, so one release reads as one correlated log."
  value       = module.stack.log_group_names["worker"]
}

output "deployment_plan" {
  description = "The two one-off task definitions, the declared and planned desired counts, and whether this apply was a bootstrap."
  value       = module.stack.deployment_plan
}

output "migration_task_definition_arn" {
  description = "Task definition for `fss migrate` and `fss admin database-users ensure`."
  value       = module.stack.migration_task_definition_arn
}

output "operations_task_definition_arn" {
  description = "Task definition for `fss verify`, under the worker task role."
  value       = module.stack.operations_task_definition_arn
}

output "migration_database_secret_arn" {
  description = "Entry the migration credential lives in. The release workflow fills it from the RDS-managed master secret; production's operator fills it from stdin."
  value       = module.stack.migration_database_secret_arn
}

output "app_runtime_database_secret_arn" {
  description = "Entry the services' app_runtime credential lives in."
  value       = module.stack.app_runtime_database_secret_arn
}

output "task_network_configuration" {
  description = "Subnets, security group and public-address setting a one-off task must be launched with."
  value       = module.stack.task_network_configuration
}
