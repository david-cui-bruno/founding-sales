# One isolated, temporary rehearsal environment.
#
# environment and destroyable are literals. This root is always destroyable
# and always in the fss-rh- namespace; there is no value a caller can pass
# that renames it into production or makes it permanent.
#
# Appendix G's destructive scenarios run here, on the exact image digests
# proposed for production, and never against production.

module "stack" {
  source = "../../modules/stack"

  environment = "rehearsal"
  destroyable = true

  name_prefix    = var.name_prefix
  aws_region     = var.aws_region
  aws_account_id = var.aws_account_id

  vpc_cidr             = var.vpc_cidr
  availability_zones   = var.availability_zones
  public_subnet_cidrs  = var.public_subnet_cidrs
  private_subnet_cidrs = var.private_subnet_cidrs

  database_instance_class               = var.database_instance_class
  database_multi_az                     = var.database_multi_az
  database_allocated_storage            = var.database_allocated_storage
  database_max_allocated_storage        = 0
  database_backup_retention_days        = var.database_backup_retention_days
  database_performance_insights_enabled = false
  database_apply_immediately            = true

  api_image           = var.api_image
  worker_image        = var.worker_image
  api_schema_range    = var.api_schema_range
  worker_schema_range = var.worker_schema_range

  api_cpu                = var.api_cpu
  api_memory             = var.api_memory
  worker_cpu             = var.worker_cpu
  worker_memory          = var.worker_memory
  cpu_architecture       = var.cpu_architecture
  api_desired_count      = var.api_desired_count
  worker_desired_count   = var.worker_desired_count
  bootstrap              = var.bootstrap
  container_insights     = "disabled"
  enable_execute_command = var.enable_execute_command

  # A run deploys from the stable rehearsal repositories, which exist before it
  # does and outlive it. infra/roots/rehearsal-registry owns them.
  create_registry = false

  dependencies_mode  = var.dependencies_mode
  research_providers = var.research_providers
  sending_enabled    = var.sending_enabled
  extra_environment  = var.extra_environment

  certificate_arn = var.certificate_arn
  api_hostname    = var.api_hostname
  elb_account_id  = var.elb_account_id
  enable_waf      = var.enable_waf

  journal_object_lock_mode           = "GOVERNANCE"
  journal_object_lock_retention_days = var.journal_object_lock_retention_days

  alert_emails         = var.alert_emails
  log_retention_days   = var.log_retention_days
  business_time_zone   = var.business_time_zone
  google_hosted_domain = var.google_hosted_domain

  updates_price_class = "PriceClass_100"

  enable_gmail_push = var.enable_gmail_push
  gcp_project_id    = var.gcp_project_id
}
