output "environment" {
  description = "production or rehearsal."
  value       = var.environment
}

output "name_prefix" {
  description = "The namespace every resource name in this stack carries."
  value       = var.name_prefix
}

output "destroyable" {
  description = "Whether deletion protection is off across the stack."
  value       = var.destroyable
}

output "vpc_id" {
  description = "VPC identifier."
  value       = module.network.vpc_id
}

output "security_group_ids" {
  description = "Security group identifiers keyed by role."
  value       = module.network.security_group_ids
}

output "ingress_rules" {
  description = "The declared ingress inventory from the network module."
  value       = module.network.ingress_rules
}

output "database_endpoint" {
  description = "Host and port for application connections."
  value       = module.database.endpoint
}

output "database_master_secret_arn" {
  description = "RDS-managed master user secret. Terraform never reads its value."
  value       = module.database.master_user_secret_arn
}

output "database_name" {
  description = <<-EOT
    The application database name. With `database_endpoint` and
    `database_master_secret_arn` it is everything a connection string needs, and
    it is why the rehearsal database URL is assembled inside the job from three
    outputs rather than stored as a static environment secret. See
    `docs/decisions/g12c-the-rehearsal-database-url-is-derived.md`.
  EOT
  value       = module.database.database_name
}

output "task_runtime_platform" {
  description = "Operating system family and CPU architecture each task definition declares."
  value       = module.cluster.task_runtime_platform
}

output "service_shape" {
  description = "Task size and desired count per service, read back from the plan."
  value       = module.cluster.service_shape
}

output "database_shape" {
  description = "Instance class, Multi-AZ, storage, retention and the two per-metric billed options."
  value       = module.database.instance_shape
}

output "container_insights" {
  description = "Container Insights setting on the cluster. Billed per metric; David's answer is off."
  value       = var.container_insights
}

output "waf_enabled" {
  description = "Whether a WAFv2 web ACL is attached to the load balancer. David's answer is off."
  value       = var.enable_waf
}

output "load_balancer_dns_name" {
  description = "Load balancer hostname. Point the API DNS record at this."
  value       = module.edge.load_balancer_dns_name
}

output "load_balancer_zone_id" {
  description = "Hosted zone id for the alias record."
  value       = module.edge.load_balancer_zone_id
}

output "cluster_name" {
  description = "ECS cluster name."
  value       = module.cluster.cluster_name
}

output "api_service_name" {
  description = "API service name."
  value       = module.cluster.api_service_name
}

output "worker_service_name" {
  description = "Worker service name."
  value       = module.cluster.worker_service_name
}

output "api_task_role_name" {
  description = "API task role name. The only principal permitted to append to the journal."
  value       = module.cluster.api_task_role_name
}

output "worker_task_role_name" {
  description = "Worker task role name."
  value       = module.cluster.worker_task_role_name
}

output "repository_urls" {
  description = "ECR repository URLs keyed by service short name."
  value       = module.registry.repository_urls
}

output "secret_names" {
  description = "Secrets Manager entry names keyed by logical name. Created empty; values entered by hand."
  value       = module.secrets.secret_names
}

output "journal_bucket_name" {
  description = "Suppression journal bucket."
  value       = module.journal.bucket_name
}

output "journal_object_lock" {
  description = "Object lock mode and retention in force on the journal."
  value = {
    mode           = module.journal.object_lock_mode
    retention_days = module.journal.object_lock_retention_days
  }
}

output "alert_topic_arn" {
  description = "Alert topic ARN."
  value       = module.alerts.topic_arn
}

output "alarm_names" {
  description = "Every metric alarm name in this environment."
  value       = module.alerts.alarm_names
}

output "critical_composite_alarm_name" {
  description = "The composite alarm over every immediately critical condition."
  value       = module.alerts.critical_composite_alarm_name
}

output "log_group_names" {
  description = "Log group names keyed by service short name."
  value       = module.observability.log_group_names
}

output "updates_distribution_domain_name" {
  description = "Hostname the Electron updater points at."
  value       = module.updates.distribution_domain_name
}

output "gmail_push_topic_id" {
  description = "Pub/Sub topic id for Gmail watch requests. Null when Gmail push is not created in this environment."
  value       = one(module.pubsub[*].topic_id)
}

output "gmail_push_audience" {
  description = "Exact audience the API must require on a push token. Null when Gmail push is not created."
  value       = one(module.pubsub[*].push_audience)
}

output "api_environment" {
  description = "Non-secret API container environment, for offline assertions."
  value       = module.cluster.api_environment
}

output "worker_environment" {
  description = "Non-secret worker container environment, for offline assertions."
  value       = module.cluster.worker_environment
}

output "resource_names" {
  description = <<-EOT
    Every name this stack claims in the shared account, so a root test can
    assert that all of them carry the environment namespace and therefore that
    a rehearsal apply can never address a production resource.
  EOT
  value = concat(
    [
      module.cluster.cluster_name,
      module.cluster.api_service_name,
      module.cluster.worker_service_name,
      module.cluster.api_task_role_name,
      module.cluster.worker_task_role_name,
      module.database.instance_identifier,
      module.database.subnet_group_name,
      module.database.parameter_group_name,
      module.journal.bucket_name,
      module.edge.access_log_bucket,
      module.updates.bucket_name,
      module.alerts.topic_name,
      module.alerts.critical_composite_alarm_name,
      module.alerts.warning_composite_alarm_name,
    ],
    values(module.registry.repository_names),
    values(module.secrets.secret_names),
    values(module.observability.log_group_names),
    module.alerts.alarm_names,
  )
}
