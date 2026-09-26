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

  # The role this run's apply acts as, scoped to fss-rh-*.
  deployment_role_name = "fss-rh-deploy"

  # The audience a push token would have to carry to be accepted by *this*
  # environment's webhook. Derived from the rehearsal hostname, exactly as
  # production derives its own: a property of the API's route, not of Google.
  push_audience = "https://${var.api_hostname}/integrations/gmail/push"

  # The role this run's apply, and therefore its teardown, acts as. The same
  # expression the provider's `assume_role` block builds, and the same ARN
  # `aws:PrincipalArn` carries for an assumed-role session of it: that key is
  # the role's ARN, never the session's, which is why the journal's exemption
  # can be an exact `ArnNotEquals` rather than a pattern.
  deployment_role_arn = "arn:aws:iam::${local.aws_account_id}:role/${local.deployment_role_name}"
}

module "stack" {
  source = "../../modules/stack"

  environment = "rehearsal"
  destroyable = true

  name_prefix    = var.name_prefix
  aws_account_id = local.aws_account_id

  # A range of its own, apart from production's 10.60.0.0/16.
  vpc_cidr = "10.70.0.0/16"

  # Single-AZ (a rehearsal needs a database, not a standby),
  # 20 GiB without autoscaling, and one day of backups.
  database_multi_az              = false
  database_allocated_storage     = 20
  database_max_allocated_storage = 0
  database_backup_retention_days = 1
  database_apply_immediately     = true

  # The teardown deletes the database, and nothing of it may outlive the run: a
  # retained automated backup (20 GB each, nine by 26 September 2026) is what
  # the prefix guard of run 36209569741 found left behind.
  database_delete_automated_backups = true

  api_image           = var.api_image
  worker_image        = var.worker_image
  api_schema_range    = var.api_schema_range
  worker_schema_range = var.worker_schema_range

  # One API task; production runs two. Sizes and architecture are production's.
  api_desired_count = 1
  bootstrap         = var.bootstrap

  # A run deploys from the stable rehearsal repositories, which exist before it
  # does and outlive it. infra/roots/rehearsal-registry owns them.
  create_registry = false

  # Sending is off in a rehearsal.
  sending_enabled = false

  certificate_arn = var.certificate_arn
  api_hostname    = var.api_hostname

  journal_object_lock_retention_days = 1

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

  # No alert subscription, and logs for a week: the run is short.
  alert_emails       = []
  log_retention_days = 7

  # Both bootstraps call `required()` on all three of these, so an empty value
  # is a rehearsal whose tasks refuse to start, not a rehearsal with push
  # switched off. The audience is real for this hostname; the topic and the push
  # identity name a Google project that does not exist, because no rehearsal
  # registers a Gmail watch: its Gmail is the recorded fake and the webhook is
  # exercised offline with locally signed tokens.
  gmail_push_audience = local.push_audience
  # Public placeholders naming a Google Cloud project that does not exist: there
  # is no rehearsal project, and an empty value is a task that refuses to start.
  # `docs/archive/decisions/g12j-the-rehearsal-has-no-google-provider.md`.
  gmail_push_topic           = "projects/fss-rehearsal-no-push/topics/fss-rehearsal-no-push"
  gmail_push_service_account = "gmail-push@fss-rehearsal-no-push.invalid"
}
