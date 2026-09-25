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
# values instead. `docs/decisions/g85-the-google-provider-has-its-own-root.md`,
# and before it `docs/decisions/g12j-the-rehearsal-has-no-google-provider.md`.

locals {
  # The audience the webhook requires in a push token. A property of this
  # environment's own hostname and route, not of Google, so it is derived here
  # rather than read from the Google root; `infra/roots/production-google`
  # builds the subscription's push endpoint and token audience with this same
  # expression, and `test/release/googleRoot.check.ts` compares the two.
  push_audience = "https://${var.api_hostname}${var.gmail_push_path}"

  # The role this apply acts as: the same expression the provider's
  # `assume_role` block builds, and the same ARN `aws:PrincipalArn` carries for
  # an assumed-role session of it, which is why the journal's listing exemption
  # can be an exact `ArnNotEquals` rather than a pattern.
  deployment_role_arn = "arn:aws:iam::${var.aws_account_id}:role/${var.deployment_role_name}"
}

# The four Google objects this root created on 23 September 2026 as
# `module.pubsub[0]`, forgotten and never destroyed.
#
# The migration (`docs/greenfield/google-root-migration-runbook.md`) imports them
# into `infra/roots/production-google` and then removes them from this root's
# state with `terraform state rm`, which needs no Google credential. This block is
# the net under that procedure: a plan of this root taken before the state
# removal, which still needs application-default credentials because the state
# still names Google objects, shows them as "will no longer be managed by
# Terraform" instead of as four deletions. A deleted topic stops the Gmail watch,
# and the publisher grant needed an organisation-policy exception to be made at
# all (`docs/greenfield/release.md` 8.0n). Once the state holds no `module.pubsub`
# address the block matches nothing and does nothing.
removed {
  from = module.pubsub

  lifecycle {
    destroy = false
  }
}

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
  bootstrap              = var.bootstrap
  container_insights     = var.container_insights
  enable_execute_command = false

  dependencies_mode  = var.dependencies_mode
  research_providers = var.research_providers
  sending_enabled    = var.sending_enabled
  extra_environment  = var.extra_environment

  expected_system_generation = var.expected_system_generation

  certificate_arn = var.certificate_arn
  api_hostname    = var.api_hostname
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
  # `docs/decisions/g37-the-deployer-may-list-the-journal-but-never-read-it.md`.
  journal_listing_principal_arns = [local.deployment_role_arn]

  alert_emails         = var.alert_emails
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
