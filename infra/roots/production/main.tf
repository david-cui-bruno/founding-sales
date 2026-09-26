# The production FSS environment.
#
# environment and destroyable are literals here, not variables. There is no
# value a caller can pass that makes this root destroyable or renames it into
# the rehearsal namespace.
#
# It declares no Google provider and creates nothing in Google Cloud, like the
# rehearsal root. The Gmail push topic, its subscription, the push service account
# and Gmail's publisher grant belong to `infra/roots/production-google`, a root of
# their own with a state key of its own, because Terraform configures every
# provider a configuration requires before it plans anything: while they were
# `module.pubsub[0]` here, every production plan, an image-only release included,
# needed a Google login that lapses about every 17 hours, and an expired one held
# a worker fix back (audit O01). This root carries their public identifiers as
# values instead. `docs/archive/decisions/g85-the-google-provider-has-its-own-root.md`,
# and before it `docs/archive/decisions/g12j-the-rehearsal-has-no-google-provider.md`.

locals {
  # The one AWS account and region FSS runs in. Literals: nothing deploys this
  # root anywhere else, and the provider refuses a credential of any other account.
  aws_account_id = "326255650484"
  aws_region     = "us-east-1"

  # What production runs, committed rather than passed as `-var` (26 September 2026):
  # a plan that forgot one used to revert it silently, to no alert subscription, to
  # sending off, or to no plan at all for the two required ones. Changing one is a pull
  # request and a read plan of this root. The API toggle stays the immediate switch for
  # sending. `infra/scripts/release-rollback.sh` refuses a rollback whose checkout
  # commits a value other than the one production runs.
  certificate_arn = "arn:aws:acm:us-east-1:326255650484:certificate/3ed7bb99-733e-4f18-a46a-3b17c943ed42"
  api_hostname    = "api.usecallie.com"
  alert_emails    = ["callie@usecallie.com"]
  sending_enabled = true

  # The audience the webhook requires in a push token. A property of this
  # environment's own hostname and route, not of Google, so it is derived here
  # rather than read from the Google root; `infra/roots/production-google`
  # builds the subscription's push endpoint and token audience with this same
  # expression, and `test/release/googleRoot.check.ts` compares the two.
  push_audience = "https://${local.api_hostname}${var.gmail_push_path}"

  # The role this apply acts as: the same expression the provider's
  # `assume_role` block builds, and the same ARN `aws:PrincipalArn` carries for
  # an assumed-role session of it, which is why the journal's listing exemption
  # can be an exact `ArnNotEquals` rather than a pattern.
  deployment_role_arn = "arn:aws:iam::${local.aws_account_id}:role/${var.deployment_role_name}"
}

module "stack" {
  source = "../../modules/stack"

  environment = "production"
  destroyable = false

  name_prefix    = var.name_prefix
  aws_region     = local.aws_region
  aws_account_id = local.aws_account_id

  availability_zones = var.availability_zones

  database_instance_class               = var.database_instance_class
  database_multi_az                     = true
  database_allocated_storage            = var.database_allocated_storage
  database_max_allocated_storage        = var.database_max_allocated_storage
  database_backup_retention_days        = 35
  database_performance_insights_enabled = var.database_performance_insights_enabled
  database_apply_immediately            = false

  # A deleted production database keeps its automated backups for their 35 days.
  database_delete_automated_backups = false

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
  container_insights     = var.container_insights
  enable_execute_command = false

  dependencies_mode  = var.dependencies_mode
  research_providers = var.research_providers
  sending_enabled    = local.sending_enabled
  extra_environment  = var.extra_environment

  expected_system_generation = var.expected_system_generation

  # Lane g86: the address `/auth/client-version` publishes, on the API alone.
  desktop_upgrade_url = var.desktop_upgrade_url

  certificate_arn = local.certificate_arn
  api_hostname    = local.api_hostname
  elb_account_id  = var.elb_account_id
  enable_waf      = var.enable_waf

  journal_object_lock_mode           = var.journal_object_lock_mode
  journal_object_lock_retention_days = var.journal_object_lock_retention_days

  # Nobody, by default. David's decision 4 of 21 September 2026: GOVERNANCE,
  # ten years, and tearing the production suppression journal down stays an act
  # of the account root unless he opts in by setting the variable. The rehearsal
  # root passes its deployment role here and this one passes his list.
  journal_administrative_principal_arns = var.journal_administrative_principal_arns

  # Not the same decision, and not an opt-in. The deployer may *see* the bucket
  # it created: `HeadBucket` is `s3:ListBucket`, the AWS provider reads the 403
  # the deny returned as "the bucket is gone", and the first production apply
  # (23 September 2026) therefore dropped the bucket from state, planned to
  # create it again, and deleted its encryption configuration and ownership
  # controls before the policy and the object lock refused to go. Listing is not
  # reading: `s3:GetObject*` stays denied to this role by the bucket policy and
  # by `infra/policies/deployment-role-policy.json.tftpl` both.
  # `docs/archive/decisions/g37-the-deployer-may-list-the-journal-but-never-read-it.md`.
  journal_listing_principal_arns = [local.deployment_role_arn]

  alert_emails         = local.alert_emails
  log_retention_days   = 90
  business_time_zone   = var.business_time_zone
  google_hosted_domain = var.google_hosted_domain

  # All three are always supplied, and never empty: both binaries call
  # `required()` on each at start-up, so an empty one is a task that refuses to
  # start rather than a task with push switched off. The audience is derived
  # above. The topic and the push identity are public identifiers of objects
  # `infra/roots/production-google` owns, committed as variable defaults, so no
  # value here is computed by a Google API and no plan of this root asks Google
  # for anything.
  gmail_push_audience        = local.push_audience
  gmail_push_topic           = var.gmail_push_topic
  gmail_push_service_account = var.gmail_push_service_account
}
