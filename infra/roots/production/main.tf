# The production FSS environment.
#
# environment and destroyable are literals here, not variables. There is no
# value a caller can pass that makes this root destroyable or renames it into
# the rehearsal namespace.
#
# This is also the only root with a Google Cloud project, and therefore the only
# one that declares the Google provider or creates a Pub/Sub resource. The topic
# module used to sit inside `infra/modules/stack`, where `count = 0` was not
# enough to keep it out of a rehearsal plan: Terraform configures every provider
# a module requires, so CI was asked for a Google credential it does not have
# and never should. `docs/decisions/g12j-the-rehearsal-has-no-google-provider.md`.

locals {
  # Google caps a service account id at 30 characters.
  service_account_stem = trimsuffix(
    length(var.name_prefix) > 18 ? substr(var.name_prefix, 0, 18) : var.name_prefix,
    "-",
  )
  push_service_account_id = "${local.service_account_stem}-gmail-push"

  # The API route Pub/Sub delivers to, and the audience the webhook requires in
  # the token it delivers with. Both are properties of this environment's own
  # hostname: no Google resource is involved in deriving them, which is why the
  # audience is passed to the stack whether or not the topic is created.
  push_endpoint = "https://${var.api_hostname}${var.gmail_push_path}"
  push_audience = "https://${var.api_hostname}${var.gmail_push_path}"

  # The role this apply acts as: the same expression the provider's
  # `assume_role` block builds, and the same ARN `aws:PrincipalArn` carries for
  # an assumed-role session of it, which is why the journal's listing exemption
  # can be an exact `ArnNotEquals` rather than a pattern.
  deployment_role_arn = "arn:aws:iam::${var.aws_account_id}:role/${var.deployment_role_name}"
}

module "pubsub" {
  source = "../../modules/pubsub"
  count  = var.enable_gmail_push ? 1 : 0

  gcp_project_id          = var.gcp_project_id
  name_prefix             = var.name_prefix
  push_service_account_id = local.push_service_account_id
  push_endpoint           = local.push_endpoint
  push_audience           = local.push_audience

  labels = {
    environment = "production"
    managed_by  = "terraform"
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

  # The audience is always supplied: it is this environment's own webhook URL,
  # and both binaries call `required()` on it at start-up, so an empty one is a
  # task that refuses to start rather than a task with push switched off. The
  # topic and the push identity exist only when the module above created them.
  gmail_push_audience        = local.push_audience
  gmail_push_topic           = var.enable_gmail_push ? one(module.pubsub[*].topic_id) : ""
  gmail_push_service_account = var.enable_gmail_push ? one(module.pubsub[*].push_service_account_email) : ""
}
