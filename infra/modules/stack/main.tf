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

  tags = {
    Project     = "callie-fss"
    Environment = var.environment
    NamePrefix  = var.name_prefix
    ManagedBy   = "terraform"
  }

  # What both environments share. The region is the one FSS runs in (the account
  # stays a root input: offline-gate.sh refuses an account id in a module). The
  # task subnets are the first two /20s of the VPC range and the database subnets
  # the ninth and tenth, one of each per availability zone. 8080 is the one port
  # the API container listens on, the load balancer forwards to and the network
  # admits. The Workspace domain is Callie's; an empty one would admit every
  # Google account (5.1, 12.1).
  aws_region           = "us-east-1"
  availability_zones   = ["us-east-1a", "us-east-1b"]
  public_subnet_cidrs  = [cidrsubnet(var.vpc_cidr, 4, 0), cidrsubnet(var.vpc_cidr, 4, 1)]
  private_subnet_cidrs = [cidrsubnet(var.vpc_cidr, 4, 8), cidrsubnet(var.vpc_cidr, 4, 9)]
  container_port       = 8080
  business_time_zone   = "America/New_York"
  google_hosted_domain = "usecallie.com"

  # Role names are derived from the prefix rather than read back from the
  # cluster module, so the journal can name its one permitted writer without
  # depending on the module that depends on the journal.
  api_task_role_name    = "${var.name_prefix}-api-task"
  worker_task_role_name = "${var.name_prefix}-worker-task"

  # One CloudWatch namespace per environment, derived here and nowhere else: the
  # metric filters (observability), the worker's FSS_METRIC_NAMESPACE and the task
  # roles' `cloudwatch:namespace` conditions (cluster), and every alarm (alerts)
  # read this one value. It used to be the bare FSS in all of them, and because
  # the rehearsal and production share an account, a rehearsal worker published
  # into production's metric streams: the tenth full run's smoke read production's
  # canary age (release.md 8.0s), and production's alarms saw rehearsal data.
  # The prefix is already disjoint by construction (the guard below), so the
  # namespace is too. `docs/archive/decisions/g55-one-metric-namespace-per-environment.md`.
  metric_namespace = "FSS/${var.name_prefix}"

  # The host every task definition connects to (FSS_DATABASE_HOST): the managed
  # instance, unless the restore runbook (docs/greenfield/runbooks/restore.md) has
  # pointed the environment at a point-in-time copy while the instance is replaced.
  # `task_network_configuration` publishes this same value, because the release
  # scripts compare it with the FSS_DATABASE_HOST a registered definition carries.
  database_host = var.active_database_host == null ? module.database.address : var.active_database_host
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
  }
}

module "network" {
  source = "../network"

  name_prefix          = var.name_prefix
  vpc_cidr             = var.vpc_cidr
  availability_zones   = local.availability_zones
  public_subnet_cidrs  = local.public_subnet_cidrs
  private_subnet_cidrs = local.private_subnet_cidrs
  api_container_port   = local.container_port
  tags                 = local.tags
}

module "observability" {
  source = "../observability"

  name_prefix    = var.name_prefix
  aws_region     = local.aws_region
  aws_account_id = var.aws_account_id
  retention_days = var.log_retention_days
  # The metric filters publish into this environment's namespace, never bare FSS.
  metric_namespace = local.metric_namespace
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

  name_prefix = var.name_prefix
  tags        = local.tags
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
  recovery_window_days = var.destroyable ? 0 : 30
  tags                 = local.tags
}

module "journal" {
  source = "../journal"

  name_prefix                = var.name_prefix
  aws_account_id             = var.aws_account_id
  writer_role_names          = [local.api_task_role_name, local.worker_task_role_name]
  reader_role_names          = [local.worker_task_role_name]
  object_lock_mode           = "GOVERNANCE"
  object_lock_retention_days = var.journal_object_lock_retention_days
  force_destroy              = var.destroyable

  # Passed through rather than derived from `destroyable`, because "this stack
  # can be destroyed" and "this principal may weaken the suppression journal"
  # are different decisions and only a root gets to make the second one.
  administrative_principal_arns = var.journal_administrative_principal_arns

  # And, in both environments, the principal that created the bucket may see
  # that it exists: `HeadBucket` is `s3:ListBucket`, and a provider refused it
  # concludes the bucket is gone.
  bucket_listing_principal_arns = var.journal_listing_principal_arns

  tags = local.tags
}

module "database" {
  source = "../database"

  name_prefix            = var.name_prefix
  subnet_ids             = module.network.private_subnet_ids
  vpc_security_group_ids = [module.network.security_group_ids["database"]]

  instance_class             = "db.t4g.small"
  multi_az                   = var.database_multi_az
  allocated_storage          = var.database_allocated_storage
  max_allocated_storage      = var.database_max_allocated_storage
  backup_retention_days      = var.database_backup_retention_days
  delete_automated_backups   = var.database_delete_automated_backups
  log_min_duration_statement = 1000
  apply_immediately          = var.database_apply_immediately

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
  container_port     = local.container_port

  enable_deletion_protection = !var.destroyable
  force_destroy_logs         = var.destroyable

  tags = local.tags
}

module "cluster" {
  source = "../cluster"

  name_prefix = var.name_prefix
  aws_region  = local.aws_region

  subnet_ids                = module.network.public_subnet_ids
  api_security_group_ids    = [module.network.security_group_ids["api_task"]]
  worker_security_group_ids = [module.network.security_group_ids["worker_task"]]

  api_image           = var.api_image
  worker_image        = var.worker_image
  api_schema_range    = var.api_schema_range
  worker_schema_range = var.worker_schema_range

  container_port    = local.container_port
  api_desired_count = var.api_desired_count
  bootstrap         = var.bootstrap

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

  # Lane g81: the reply classifier's key reaches the worker in production only. A
  # rehearsal's entry holds a fixture and the classifier has no recorded seam, so a
  # rehearsal worker holding it would call the provider with a key that cannot work.
  worker_reads_classifier_key = local.is_production

  metric_namespace = local.metric_namespace

  # The upgrade notice's address is the API's alone (lane g86), and absent rather
  # than empty when unset, so the API's own rule decides what an unset one means.
  api_environment = var.desktop_upgrade_url == null ? {} : {
    FSS_DESKTOP_UPGRADE_URL = var.desktop_upgrade_url
  }

  environment = {
    FSS_ENVIRONMENT = var.environment
    # The deployment flags of 16.2. Each is refused, not defaulted, by the process
    # that reads it. `live` builds every real adapter, in both environments; no
    # root selects the recorded fakes any more.
    FSS_DEPENDENCIES       = "live"
    FSS_SENDING_ENABLED    = tostring(var.sending_enabled)
    FSS_BUSINESS_TIME_ZONE = local.business_time_zone
    FSS_DATABASE_HOST      = local.database_host
    FSS_DATABASE_PORT      = tostring(module.database.port)
    FSS_DATABASE_NAME      = module.database.database_name
    FSS_JOURNAL_BUCKET     = module.journal.bucket_name
    FSS_ENVELOPE_KEY_ID    = module.secrets.envelope_kms_key_id
    FSS_PUBLIC_ORIGIN      = "https://${var.api_hostname}"
    # The three Gmail push identifiers are inputs, not resources this module
    # creates. The Pub/Sub topic and its push subscription live in
    # `infra/roots/production-google` (lane g85), the only root with a Google
    # provider, so this module requires none and neither a rehearsal plan nor a
    # production plan needs a Google credential
    # (`docs/archive/decisions/g12j-the-rehearsal-has-no-google-provider.md`).
    #
    # All three are public identifiers, and all three are read by
    # `required()` in both bootstraps: an empty one is a task that refuses to
    # start, not a task with push switched off.
    FSS_GMAIL_PUSH_AUDIENCE        = var.gmail_push_audience
    FSS_GMAIL_PUSH_SERVICE_ACCOUNT = var.gmail_push_service_account
    FSS_GMAIL_PUSH_TOPIC           = var.gmail_push_topic
    FSS_GOOGLE_HOSTED_DOMAIN       = local.google_hosted_domain
  }

  tags = local.tags
}

module "alerts" {
  source = "../alerts"

  name_prefix      = var.name_prefix
  aws_account_id   = var.aws_account_id
  alert_emails     = var.alert_emails
  metric_namespace = local.metric_namespace

  # Logs and alerts share one key (David, 20 September 2026), and the literal
  # false is how the alerts module learns that at plan time. The ARN beside it
  # belongs to a key this same apply creates, so its value, and even its
  # nullness, is unknown while Terraform plans; a `count` that read it was the
  # second error of the third credentialed rehearsal.
  create_kms_key = false
  kms_key_arn    = module.observability.kms_key_arn

  tags = local.tags
}

# The desktop update channel: production only (wave 2, 26 September 2026). A
# rehearsal publishes no Electron package, and its CloudFront distribution was
# the slowest thing every run created, disabled and deleted.
module "updates" {
  source = "../updates"
  count  = local.is_production ? 1 : 0

  name_prefix    = var.name_prefix
  aws_account_id = var.aws_account_id
  tags           = local.tags
}

# Production state holds the module at its un-counted address. The move is a
# state operation inside the plan: every updates resource shows as moved to
# `module.updates[0]`, and nothing is created, changed or destroyed.
moved {
  from = module.updates
  to   = module.updates[0]
}

# There is no `module "pubsub"` here any more.
#
# It was the only Google resource in the stack, and `count = 0` did not make it
# free: Terraform configures every provider a module *requires* during the plan,
# so a rehearsal plan in CI asked for Google application-default credentials and
# was refused before it reached AWS (David's third credentialed rehearsal, 21
# September 2026). Only production has a Google Cloud project, and since lane g85 only
# `infra/roots/production-google` calls the module; `infra/roots/production` passes
# the topic id, the push service account and the audience into this module as three
# strings. `docs/archive/decisions/g12j-the-rehearsal-has-no-google-provider.md` and
# `docs/archive/decisions/g85-the-google-provider-has-its-own-root.md`.
