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

output "metric_namespace" {
  description = "The CloudWatch namespace this environment's metrics, metric filters and alarms use: FSS/<name_prefix>. Anything that reads a metric by hand reads it here, never in the bare FSS namespace."
  value       = local.metric_namespace
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
    `docs/archive/decisions/g12c-the-rehearsal-database-url-is-derived.md`.
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
  description = "Instance class, Multi-AZ, storage, retention and what a deletion keeps."
  value       = module.database.instance_shape
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

output "cluster_arn" {
  description = "ECS cluster ARN. A one-off task is launched against the ARN, never the name: a bare name resolves against whichever account and region the shell holds."
  value       = module.cluster.cluster_arn
}

output "migration_task_role_name" {
  description = "Migration task role name. The identity `fss migrate` runs as, and nothing else in the stack shares it."
  value       = module.cluster.migration_task_role_name
}

output "migration_task_definition_arn" {
  description = "Task definition for `fss migrate` and `fss admin database-users ensure`. A one-off task; there is no service."
  value       = module.cluster.migration_task_definition_arn
}

output "operations_task_definition_arn" {
  description = "Task definition for `fss verify`, under the worker task role."
  value       = module.cluster.operations_task_definition_arn
}

output "drill_task_definition_arn" {
  description = "Task definition for `fss drill`, under its own role: the only identity holding both the journal and the migration credential."
  value       = module.cluster.drill_task_definition_arn
}

output "drill_task_role_name" {
  description = "Drill task role name."
  value       = module.cluster.drill_task_role_name
}

output "migration_database_secret_arn" {
  description = "Entry the migration credential lives in. Created empty; the operator fills it. Readable by the migration execution role alone."
  value       = module.secrets.migration_database_secret_arn
}

output "app_runtime_database_secret_arn" {
  description = "Entry the services' `app_runtime` credential lives in. Created empty; `fss admin database-users ensure` creates the login user it names."
  value       = module.secrets.app_runtime_database_secret_arn
}

output "deployment_plan" {
  description = <<-EOT
    Everything `infra/scripts/release-deploy.sh` reads before it launches
    anything: the two one-off task definitions, the declared and planned
    desired counts, and whether this apply was a bootstrap.
  EOT
  value       = module.cluster.deployment_plan
}

output "task_network_configuration" {
  description = <<-EOT
    The network a one-off task must be launched into, so the wrapper asserts
    the run-task arguments against the plan rather than against a literal.

    Public subnets with `assignPublicIp=ENABLED` under the worker security
    group: there is no NAT gateway and no interface endpoint, so a task with no
    public address cannot pull its image, and the worker group is the one the
    database security group already admits on 5432. The group admits nothing
    inbound, which is why giving a one-off task a public address costs nothing.
  EOT
  value = {
    subnet_ids         = module.network.public_subnet_ids
    security_group_id  = module.network.security_group_ids["worker_task"]
    assign_public_ip   = "ENABLED"
    database_port      = 5432
    database_host      = module.database.address
    inbound_rule_count = length([for name, rule in module.network.ingress_rules : name if rule.group == "worker_task"])
  }
}

output "repository_urls" {
  description = "ECR repository URLs keyed by service short name. Empty when this stack creates no registry."
  value       = var.create_registry ? one(module.registry[*].repository_urls) : {}
}

output "repository_names" {
  description = "ECR repository names keyed by service short name. Empty when this stack creates no registry."
  value       = var.create_registry ? one(module.registry[*].repository_names) : {}
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

output "journal_policy_json" {
  description = <<-EOT
    The rendered suppression-journal bucket policy, so a root's tftest can read
    every statement rather than trust that the module was called correctly. It
    is what says whether this environment's deployer can tear its own journal
    down, which is the question the fourth credentialed rehearsal answered the
    hard way (`infra/roots/*/tests/journal_teardown.tftest.hcl`).

    A bucket policy is public information: it names roles and actions and holds
    no value. Every statement references the bucket ARN, which is computed, so
    this output is unknown until apply — in a real plan as in a mocked one.
  EOT
  value       = module.journal.policy_json
}

output "alert_topic_arn" {
  description = "Alert topic ARN."
  value       = module.alerts.topic_arn
}

output "alarm_names" {
  description = "Every metric alarm name in this environment."
  value       = module.alerts.alarm_names
}

output "alarm_metric_namespaces" {
  description = "Every CloudWatch namespace this environment's alarms read. Exactly [metric_namespace], so a root test can assert that no alarm here reads another environment's metrics."
  value       = module.alerts.alarm_metric_namespaces
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

# The two Gmail push outputs are gone from this module: it no longer creates the
# topic, so echoing back what it was told would only be a second place for the
# same string to drift. `infra/roots/production-google` creates them and publishes
# them (lane g85), `infra/roots/production` passes them in as validated variables and
# echoes those, and both are visible in `api_environment` below either way.

output "api_environment" {
  description = "Non-secret API container environment, for offline assertions."
  value       = module.cluster.api_environment
}

output "worker_environment" {
  description = "Non-secret worker container environment, for offline assertions."
  value       = module.cluster.worker_environment
}

output "task_secret_names" {
  description = "Per task definition, the environment variable names it resolves from Secrets Manager (lane g81). Names only, for offline assertions."
  value       = module.cluster.task_secret_names
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
      module.cluster.migration_task_role_name,
      module.cluster.drill_task_role_name,
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
    var.create_registry ? values(one(module.registry[*].repository_names)) : [],
    values(module.secrets.secret_names),
    values(module.observability.log_group_names),
    module.alerts.alarm_names,
    module.alerts.digest_resource_names,
    module.cluster.one_off_task_families,
  )
}

output "operations_task_definition_family" {
  description = "Family of the operations task definition, which the production CI deploy runs the release record's put on (lane g100)."
  value       = module.cluster.operations_task_definition_family
}

output "one_off_task_families" {
  description = "The three one-off task definition families: migration, operations, drill. Names, so a root test can assert them at plan time."
  value       = module.cluster.one_off_task_families
}
