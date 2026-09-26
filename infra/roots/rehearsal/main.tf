# One isolated, temporary rehearsal environment.
#
# environment and destroyable are literals. This root is always destroyable
# and always in the fss-rh- namespace; there is no value a caller can pass
# that renames it into production or makes it permanent.
#
# Appendix G's destructive scenarios run here, on the exact image digests
# proposed for production, and never against production.
#
# This root declares no Google provider and creates nothing in Google Cloud.
# There is no rehearsal Google Cloud project and there will not be one, so
# `terraform plan` here needs no Google credential; the third credentialed
# rehearsal was refused application-default credentials before it reached AWS
# because `infra/modules/stack` required the provider for a `module "pubsub"`
# it never instantiated. The three Gmail push identifiers the task definitions
# carry are values, below.
# `docs/archive/decisions/g12j-the-rehearsal-has-no-google-provider.md`.

locals {
  # The one AWS account and region FSS runs in. Literals: nothing deploys this
  # root anywhere else, and the provider refuses a credential of any other account.
  aws_account_id = "326255650484"
  aws_region     = "us-east-1"

  # The audience a push token would have to carry to be accepted by *this*
  # environment's webhook. Derived from the rehearsal hostname, exactly as
  # production derives its own: a property of the API's route, not of Google.
  push_audience = "https://${var.api_hostname}${var.gmail_push_path}"

  # The role this run's apply, and therefore its teardown, acts as. The same
  # expression the provider's `assume_role` block builds, and the same ARN
  # `aws:PrincipalArn` carries for an assumed-role session of it: that key is
  # the role's ARN, never the session's, which is why the journal's exemption
  # can be an exact `ArnNotEquals` rather than a pattern.
  deployment_role_arn = "arn:aws:iam::${local.aws_account_id}:role/${var.deployment_role_name}"
}

module "stack" {
  source = "../../modules/stack"

  environment = "rehearsal"
  destroyable = true

  name_prefix    = var.name_prefix
  aws_region     = local.aws_region
  aws_account_id = local.aws_account_id

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

  # The teardown deletes the database, and nothing of it may outlive the run: a
  # retained automated backup (20 GB each, nine by 26 September 2026) is what
  # the prefix guard of run 36209569741 found left behind.
  database_delete_automated_backups = true

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

  expected_system_generation = var.expected_system_generation

  certificate_arn = var.certificate_arn
  api_hostname    = var.api_hostname
  elb_account_id  = var.elb_account_id
  enable_waf      = var.enable_waf

  journal_object_lock_mode           = "GOVERNANCE"
  journal_object_lock_retention_days = var.journal_object_lock_retention_days

  # The run's own deployer is exempted from every journal deny but the transport
  # one, because a rehearsal environment has to be able to disappear and on 21
  # September it could not: the fourth credentialed run (Actions 35628963637)
  # was refused `s3:DeleteBucketPolicy` and
  # `s3:PutBucketObjectLockConfiguration` by the bucket's own policy, and its
  # `--bypass-governance-retention` emptying step could never have worked
  # either. Not a variable: there is no value a caller can pass that makes a
  # rehearsal journal un-removable or that exempts anybody else.
  # `docs/archive/decisions/g16-the-journal-deny-exempts-its-deployer.md`.
  journal_administrative_principal_arns = [local.deployment_role_arn]

  # And the same role may see the bucket, which is a separate thing from being
  # exempt from every deny: `HeadBucket` is `s3:ListBucket`, and the provider
  # reads a refusal there as "the bucket is gone". The rehearsal bucket
  # `fss-rh-202609211659-suppression-journal-326255650484` was left behind for
  # the deny above; the production apply of 23 September proved the same deny
  # also makes a deployer recreate the bucket it already has.
  # `docs/archive/decisions/g37-the-deployer-may-list-the-journal-but-never-read-it.md`.
  journal_listing_principal_arns = [local.deployment_role_arn]

  alert_emails         = var.alert_emails
  log_retention_days   = var.log_retention_days
  business_time_zone   = var.business_time_zone
  google_hosted_domain = var.google_hosted_domain

  updates_price_class = "PriceClass_100"

  # Both bootstraps call `required()` on all three of these, so an empty value
  # is a rehearsal whose tasks refuse to start, not a rehearsal with push
  # switched off. The audience is real for this hostname; the topic and the push
  # identity name a Google project that does not exist, because no rehearsal
  # registers a Gmail watch: its Gmail is the recorded fake and the webhook is
  # exercised offline with locally signed tokens.
  gmail_push_audience        = local.push_audience
  gmail_push_topic           = var.gmail_push_topic
  gmail_push_service_account = var.gmail_push_service_account
}
