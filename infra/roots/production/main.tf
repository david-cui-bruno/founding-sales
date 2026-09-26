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

  # The production namespace, exactly: rehearsal is "fss-rh-<run>", so the two
  # name spaces are disjoint and no rehearsal apply can address a production
  # resource. Its deployment role is its own.
  name_prefix          = "fss-prod"
  deployment_role_name = "fss-prod-deploy"

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

  # Lane g86: `FSS_DESKTOP_UPGRADE_URL` on the API task definition alone, the
  # `upgradeUrl` /auth/client-version publishes to a Mac below the minimum client
  # version. Machine-facing: the signed manifest on this stack's updates
  # distribution, which the desktop reads and installs from by itself; its upgrade
  # screen shows a sentence and never this address. The API refuses to start in
  # production without it or with the callie.example placeholder, and
  # test/ops/terraformCrossChecks.check.ts holds this line to the channel path.
  # `docs/archive/decisions/g86-the-upgrade-notice-names-the-update-channel.md`.
  desktop_upgrade_url = "https://dlcmdaeskewt5.cloudfront.net/releases/darwin-arm64/latest.json"

  # The audience the webhook requires in a push token. A property of this
  # environment's own hostname and route, not of Google, so it is derived here
  # rather than read from the Google root; `infra/roots/production-google`
  # pushes to, and mints its token for, the same address.
  push_audience = "https://${local.api_hostname}/integrations/gmail/push"

  # Public identifiers of the objects `infra/roots/production-google` owns: its
  # `gmail_push_topic_id` and `gmail_push_service_account` outputs, created on
  # 23 September 2026. They change only when that root's objects do, in the same
  # pull request.
  gmail_push_topic           = "projects/callie-fss/topics/fss-prod-gmail-push"
  gmail_push_service_account = "fss-prod-gmail-push@callie-fss.iam.gserviceaccount.com"

  # The role this apply acts as: the same expression the provider's
  # `assume_role` block builds, and the same ARN `aws:PrincipalArn` carries for
  # an assumed-role session of it, which is why the journal's listing exemption
  # can be an exact `ArnNotEquals` rather than a pattern.
  deployment_role_arn = "arn:aws:iam::${local.aws_account_id}:role/${local.deployment_role_name}"
}

module "stack" {
  source = "../../modules/stack"

  environment = "production"
  destroyable = false

  name_prefix    = local.name_prefix
  aws_account_id = local.aws_account_id

  vpc_cidr = "10.60.0.0/16"

  database_multi_az              = true
  database_allocated_storage     = 50
  database_max_allocated_storage = 200
  database_backup_retention_days = 35
  database_apply_immediately     = false

  # A deleted production database keeps its automated backups for their 35 days.
  database_delete_automated_backups = false

  api_image           = var.api_image
  worker_image        = var.worker_image
  api_schema_range    = var.api_schema_range
  worker_schema_range = var.worker_schema_range

  # Two API tasks (the worker is one, in the cluster module).
  api_desired_count = 2
  bootstrap         = var.bootstrap

  sending_enabled = local.sending_enabled

  # Null in code: the managed instance. Set only while the restore runbook
  # (docs/greenfield/runbooks/restore.md) has production on a point-in-time copy.
  active_database_host = var.active_database_host

  desktop_upgrade_url = local.desktop_upgrade_url

  certificate_arn = local.certificate_arn
  api_hostname    = local.api_hostname

  # GOVERNANCE (the stack's), ten years.
  journal_object_lock_retention_days = 3650

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

  alert_emails       = local.alert_emails
  log_retention_days = 90

  # All three are always supplied, and never empty: both binaries call
  # `required()` on each at start-up, so an empty one is a task that refuses to
  # start rather than a task with push switched off. All three are committed
  # above, so no value here is computed by a Google API and no plan of this root
  # asks Google for anything.
  gmail_push_audience        = local.push_audience
  gmail_push_topic           = local.gmail_push_topic
  gmail_push_service_account = local.gmail_push_service_account
}
