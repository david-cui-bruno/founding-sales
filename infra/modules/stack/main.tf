# The whole FSS environment, composed once.
#
# Both roots call this module. They differ only in the values they pass, and
# the guard below is what makes the difference structural rather than a
# convention: production is exactly "fss-prod" and can never be destroyable;
# rehearsal is always "fss-rh-<run>" and therefore shares no resource name,
# no ARN, no IAM role name, no secret name and no bucket with production.

locals {
  production_name_prefix = "fss-prod"
  rehearsal_name_pattern = "^fss-rh-[a-z0-9][a-z0-9-]{1,16}[a-z0-9]$"

  is_production = var.environment == "production"

  tags = merge(var.extra_tags, {
    Project     = "callie-fss"
    Environment = var.environment
    NamePrefix  = var.name_prefix
    ManagedBy   = "terraform"
  })

  # Role names are derived from the prefix rather than read back from the
  # cluster module, so the journal can name its one permitted writer without
  # depending on the module that depends on the journal.
  api_task_role_name    = "${var.name_prefix}-api-task"
  worker_task_role_name = "${var.name_prefix}-worker-task"

  # Google service account ids are capped at 30 characters.
  service_account_stem = trimsuffix(
    length(var.name_prefix) > 18 ? substr(var.name_prefix, 0, 18) : var.name_prefix,
    "-",
  )
  push_service_account_id = "${local.service_account_stem}-gmail-push"

  push_endpoint = "https://${var.api_hostname}${var.gmail_push_path}"
  push_audience = "https://${var.api_hostname}${var.gmail_push_path}"
}

# The structural isolation guard. Everything downstream inherits name_prefix,
# so if this holds, no rehearsal resource name or ARN can equal a production
# one and no production root can be torn down by a rehearsal teardown.
resource "terraform_data" "environment_guard" {
  input = {
    environment = var.environment
    name_prefix = var.name_prefix
    destroyable = var.destroyable
  }

  lifecycle {
    precondition {
      condition = (
        local.is_production
        ? var.name_prefix == local.production_name_prefix
        : can(regex(local.rehearsal_name_pattern, var.name_prefix))
      )
      error_message = "A production stack must be named exactly fss-prod and a rehearsal stack must be named fss-rh-<run>. The two namespaces are disjoint by construction."
    }

    precondition {
      condition     = !local.is_production || var.destroyable == false
      error_message = "A production stack can never be destroyable."
    }

    precondition {
      condition     = !local.is_production || var.database_multi_az
      error_message = "A production database is always Multi-AZ."
    }

    precondition {
      condition     = !local.is_production || var.database_backup_retention_days == 35
      error_message = "A production database keeps the full 35-day point-in-time recovery window."
    }

    precondition {
      condition     = !local.is_production || var.enable_execute_command == false
      error_message = "ECS Exec into a production task is not a deployment-time option."
    }

    precondition {
      condition     = !var.enable_gmail_push || var.gcp_project_id != ""
      error_message = "Gmail push needs its own Google Cloud project id. Rehearsal must never publish into the production project."
    }
  }
}

module "network" {
  source = "../network"

  name_prefix          = var.name_prefix
  vpc_cidr             = var.vpc_cidr
  availability_zones   = var.availability_zones
  public_subnet_cidrs  = var.public_subnet_cidrs
  private_subnet_cidrs = var.private_subnet_cidrs
  api_container_port   = var.container_port
  tags                 = local.tags
}

module "observability" {
  source = "../observability"

  name_prefix    = var.name_prefix
  aws_region     = var.aws_region
  aws_account_id = var.aws_account_id
  retention_days = var.log_retention_days
  # David's decision of 20 Sep 2026: logs and alerts share one key (five keys, not six).
  shared_with_alerts = true
  tags               = local.tags
}

# The registry is the one part of the stack that outlives the stack.
#
# Production creates its own (`fss-prod-api`, `fss-prod-worker`) and keeps it.
# A rehearsal *run* must not: the images are pushed before the run exists, the
# release workflow's environment secrets name the stable `fss-rh-api` and
# `fss-rh-worker`, and a repository created per run would be deleted with the
# run. `infra/roots/rehearsal-registry` owns those two and is applied once.
module "registry" {
  source = "../registry"
  count  = var.create_registry ? 1 : 0

  name_prefix  = var.name_prefix
  force_delete = var.destroyable
  tags         = local.tags
}

# Production state already holds this module at its un-counted address.
#
# David ran `terraform apply -target=module.stack.module.registry` in
# infra/roots/production at 71d84e00 to bootstrap `fss-prod-api` and
# `fss-prod-worker` before the first image push (infra-apply-runbook.md 2.2).
# Adding `count` above renames the address to `module.registry[0]`, and without
# this block the next production plan would read that as one module destroyed
# and another created — which, for an ECR repository, means deleting the images
# every release is identified by.
#
# The move is a state operation Terraform performs inside the plan. It is not a
# change to any resource: the plan should show the two repositories as *moved*
# and then report no changes to them.
moved {
  from = module.registry
  to   = module.registry[0]
}

module "secrets" {
  source = "../secrets"

  name_prefix          = var.name_prefix
  secret_names         = var.secret_names
  recovery_window_days = var.destroyable ? 0 : 30
  tags                 = local.tags
}

module "journal" {
  source = "../journal"

  name_prefix                = var.name_prefix
  aws_account_id             = var.aws_account_id
  writer_role_names          = [local.api_task_role_name, local.worker_task_role_name]
  reader_role_names          = [local.worker_task_role_name]
  object_lock_mode           = var.journal_object_lock_mode
  object_lock_retention_days = var.journal_object_lock_retention_days
  force_destroy              = var.destroyable
  tags                       = local.tags
}

module "database" {
  source = "../database"

  name_prefix            = var.name_prefix
  subnet_ids             = module.network.private_subnet_ids
  vpc_security_group_ids = [module.network.security_group_ids["database"]]

  instance_class               = var.database_instance_class
  multi_az                     = var.database_multi_az
  allocated_storage            = var.database_allocated_storage
  max_allocated_storage        = var.database_max_allocated_storage
  backup_retention_days        = var.database_backup_retention_days
  performance_insights_enabled = var.database_performance_insights_enabled
  log_min_duration_statement   = var.database_log_min_duration_statement
  apply_immediately            = var.database_apply_immediately

  deletion_protection = !var.destroyable
  skip_final_snapshot = var.destroyable
  port                = 5432

  tags = local.tags
}

module "edge" {
  source = "../edge"

  name_prefix        = var.name_prefix
  aws_account_id     = var.aws_account_id
  vpc_id             = module.network.vpc_id
  subnet_ids         = module.network.public_subnet_ids
  security_group_ids = [module.network.security_group_ids["alb"]]
  certificate_arn    = var.certificate_arn
  container_port     = var.container_port
  elb_account_id     = var.elb_account_id

  enable_deletion_protection = !var.destroyable
  force_destroy_logs         = var.destroyable
  enable_waf                 = var.enable_waf

  tags = local.tags
}

module "cluster" {
  source = "../cluster"

  name_prefix = var.name_prefix
  aws_region  = var.aws_region

  subnet_ids                = module.network.public_subnet_ids
  api_security_group_ids    = [module.network.security_group_ids["api_task"]]
  worker_security_group_ids = [module.network.security_group_ids["worker_task"]]

  api_image           = var.api_image
  worker_image        = var.worker_image
  api_schema_range    = var.api_schema_range
  worker_schema_range = var.worker_schema_range

  container_port       = var.container_port
  api_cpu              = var.api_cpu
  api_memory           = var.api_memory
  worker_cpu           = var.worker_cpu
  worker_memory        = var.worker_memory
  cpu_architecture     = var.cpu_architecture
  api_desired_count    = var.api_desired_count
  worker_desired_count = var.worker_desired_count
  bootstrap            = var.bootstrap

  target_group_arn      = module.edge.target_group_arn
  api_log_group_name    = module.observability.log_group_names["api"]
  worker_log_group_name = module.observability.log_group_names["worker"]

  # The application secrets only. The two database entries arrive through their
  # own named inputs below, so each reaches exactly one execution role and the
  # cluster's boundary cannot be undone by a key appearing twice.
  secret_arns                     = module.secrets.application_secret_arns
  app_runtime_database_secret_arn = module.secrets.app_runtime_database_secret_arn
  migration_database_secret_arn   = module.secrets.migration_database_secret_arn

  journal_bucket_arn   = module.journal.bucket_arn
  journal_kms_key_arn  = module.journal.kms_key_arn
  envelope_kms_key_arn = module.secrets.envelope_kms_key_arn
  secrets_kms_key_arn  = module.secrets.secrets_kms_key_arn

  metric_namespace       = module.observability.metric_namespace
  container_insights     = var.container_insights
  enable_execute_command = var.enable_execute_command

  # FSS_RESEARCH_PROVIDERS is the worker's alone: the API has no research
  # adapter, and a variable a process never reads is a variable that drifts.
  worker_environment = {
    FSS_RESEARCH_PROVIDERS = var.research_providers
  }

  environment = merge(var.extra_environment, {
    FSS_ENVIRONMENT = var.environment
    # The three deployment flags of 16.2 and G12's bootstrap. They are first-class
    # inputs rather than entries in extra_environment because each is refused,
    # not defaulted, by the process that reads it.
    FSS_DEPENDENCIES               = var.dependencies_mode
    FSS_SENDING_ENABLED            = tostring(var.sending_enabled)
    FSS_BUSINESS_TIME_ZONE         = var.business_time_zone
    FSS_DATABASE_HOST              = module.database.address
    FSS_DATABASE_PORT              = tostring(module.database.port)
    FSS_DATABASE_NAME              = module.database.database_name
    FSS_JOURNAL_BUCKET             = module.journal.bucket_name
    FSS_ENVELOPE_KEY_ID            = module.secrets.envelope_kms_key_id
    FSS_PUBLIC_ORIGIN              = "https://${var.api_hostname}"
    FSS_GMAIL_PUSH_AUDIENCE        = var.enable_gmail_push ? local.push_audience : ""
    FSS_GMAIL_PUSH_SERVICE_ACCOUNT = var.enable_gmail_push ? one(module.pubsub[*].push_service_account_email) : ""
    # Two public identifiers that used to travel inside the operator-written
    # Google client secret because nothing carried them (G12's stand-down note).
    # Empty rather than absent when push is off, so a bootstrap reading the
    # name learns "not configured" instead of nothing at all.
    FSS_GMAIL_PUSH_TOPIC     = var.enable_gmail_push ? one(module.pubsub[*].topic_id) : ""
    FSS_GOOGLE_HOSTED_DOMAIN = var.google_hosted_domain
  })

  tags = local.tags
}

module "alerts" {
  source = "../alerts"

  name_prefix      = var.name_prefix
  aws_account_id   = var.aws_account_id
  alert_emails     = var.alert_emails
  metric_namespace = module.observability.metric_namespace

  # Logs and alerts share one key (David, 20 September 2026), and the literal
  # false is how the alerts module learns that at plan time. The ARN beside it
  # belongs to a key this same apply creates, so its value, and even its
  # nullness, is unknown while Terraform plans; a `count` that read it was the
  # second error of the third credentialed rehearsal.
  create_kms_key = false
  kms_key_arn    = module.observability.kms_key_arn

  tags = local.tags
}

module "updates" {
  source = "../updates"

  name_prefix    = var.name_prefix
  aws_account_id = var.aws_account_id
  price_class    = var.updates_price_class
  force_destroy  = var.destroyable
  tags           = local.tags
}

module "pubsub" {
  source = "../pubsub"
  count  = var.enable_gmail_push ? 1 : 0

  gcp_project_id          = var.gcp_project_id
  name_prefix             = var.name_prefix
  push_service_account_id = local.push_service_account_id
  push_endpoint           = local.push_endpoint
  push_audience           = local.push_audience

  labels = {
    environment = var.environment
    managed_by  = "terraform"
  }
}
