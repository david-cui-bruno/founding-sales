# The production FSS environment.
#
# environment and destroyable are literals here, not variables. There is no
# value a caller can pass that makes this root destroyable or renames it into
# the rehearsal namespace.

module "stack" {
  source = "../../modules/stack"

  environment = "production"
  destroyable = false

  name_prefix    = var.name_prefix
  aws_region     = var.aws_region
  aws_account_id = var.aws_account_id

  availability_zones = var.availability_zones

  database_instance_class               = var.database_instance_class
  database_multi_az                     = true
  database_allocated_storage            = var.database_allocated_storage
  database_max_allocated_storage        = var.database_max_allocated_storage
  database_backup_retention_days        = 35
  database_performance_insights_enabled = var.database_performance_insights_enabled
  database_apply_immediately            = false

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
  container_insights     = var.container_insights
  enable_execute_command = false

  certificate_arn = var.certificate_arn
  api_hostname    = var.api_hostname
  elb_account_id  = var.elb_account_id
  enable_waf      = var.enable_waf

  journal_object_lock_mode           = var.journal_object_lock_mode
  journal_object_lock_retention_days = var.journal_object_lock_retention_days

  alert_emails         = var.alert_emails
  log_retention_days   = 90
  business_time_zone   = var.business_time_zone
  google_hosted_domain = var.google_hosted_domain

  enable_gmail_push = var.enable_gmail_push
  gcp_project_id    = var.gcp_project_id
}
