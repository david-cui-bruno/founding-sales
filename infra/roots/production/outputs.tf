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

output "metric_namespace" {
  description = "The CloudWatch namespace production publishes to and alarms on: FSS/fss-prod. Every by-hand get-metric-statistics in the runbooks names this, never the bare FSS."
  value       = module.stack.metric_namespace
}

output "deployment_role_name" {
  description = "IAM role this root assumes."
  value       = var.deployment_role_name
}

output "resource_names" {
  description = "Every name this root claims in the shared account: the stack's, and the CI deploy role this root adds (lane g91)."
  value       = concat(module.stack.resource_names, [aws_iam_role.ci_deploy.name])
}

output "ci_deploy_role_name" {
  description = "The role .github/workflows/greenfield-deploy.yml assumes through the production-deploy environment. Never the role Terraform assumes."
  value       = aws_iam_role.ci_deploy.name
}

output "ci_deploy_role_arn" {
  description = "Public ARN for the production-deploy environment secret FSS_PRODUCTION_CI_ROLE_ARN."
  value       = aws_iam_role.ci_deploy.arn
}

# The four public identifiers the CI deploy launches the release record's put with
# (lane g100). The workflow takes them from repository variables, never from state:
# `gh variable set <NAME> --body "$(terraform output -raw <output>)"`, release.md 4.0.

output "ci_deploy_cluster_name" {
  description = "Repository variable FSS_PRODUCTION_CLUSTER_NAME: the cluster the release record's put runs in."
  value       = module.stack.cluster_name
}

output "ci_deploy_operations_task_family" {
  description = "Repository variable FSS_PRODUCTION_OPERATIONS_TASK_FAMILY: the task definition family the put runs."
  value       = module.stack.operations_task_definition_family
}

output "ci_deploy_task_subnet_ids" {
  description = "Repository variable FSS_PRODUCTION_TASK_SUBNET_IDS: the one-off task subnets, comma-separated, as task_network_configuration names them."
  value       = join(",", module.stack.task_network_configuration.subnet_ids)
}

output "ci_deploy_task_security_group_id" {
  description = "Repository variable FSS_PRODUCTION_TASK_SECURITY_GROUP_ID: the worker security group a one-off task runs under, which admits nothing inbound."
  value       = module.stack.task_network_configuration.security_group_id
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
  description = "Pub/Sub topic id for Gmail watch requests, as both task definitions carry it. infra/roots/production-google owns the topic; this is var.gmail_push_topic."
  value       = var.gmail_push_topic
}

output "gmail_push_audience" {
  description = "Exact audience the API requires on a push token, derived from the API hostname."
  value       = local.push_audience
}

output "gmail_push_service_account" {
  description = "Service account the push token is issued for. The webhook accepts this address and no other. infra/roots/production-google owns it; this is var.gmail_push_service_account."
  value       = var.gmail_push_service_account
}

# ---------------------------------------------------------------------------
# What the shared deploy script and the run-task wrapper read (G12h).
#
# The same outputs the rehearsal root publishes, because David runs the same
# script locally that CI runs against a rehearsal: one code path, two sets of
# credentials. `docs/greenfield/infra-apply-runbook.md` 3.2.
# ---------------------------------------------------------------------------

output "cluster_arn" {
  description = "Production ECS cluster ARN. One-off tasks are launched against the ARN, never the name."
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
  description = "Task definition for `fss verify`, under the worker task role. A release gate after every deploy."
  value       = module.stack.operations_task_definition_arn
}

output "drill_task_definition_arn" {
  description = <<-EOT
    Task definition for `fss drill`. It exists in production and is never
    launched by a release: the drill belongs to the rehearsal, and in
    production `docs/greenfield/restore-drill.md` is followed step by step
    under the post-restore protocol. It is here so that the two environments
    are the same shape, which is what makes the rehearsal worth running.
  EOT
  value       = module.stack.drill_task_definition_arn
}

output "migration_database_secret_arn" {
  description = "Entry the migration credential lives in. Filled once, by hand, from stdin (release.md 5.1)."
  value       = module.stack.migration_database_secret_arn
}

output "app_runtime_database_secret_arn" {
  description = "Entry the services' app_runtime credential lives in. Filled by hand before `fss admin database-users ensure` runs."
  value       = module.stack.app_runtime_database_secret_arn
}

output "task_network_configuration" {
  description = "Subnets, security group and public-address setting a one-off task must be launched with."
  value       = module.stack.task_network_configuration
}
