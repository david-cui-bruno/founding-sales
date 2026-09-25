# Adopting the four objects that already exist.
#
# They were created on 23 September 2026 by `infra/roots/production` as
# `module.pubsub[0]`. These blocks bring each into this root's state at its new
# address, and a plan shows every one of them as "will be imported" before
# anything is written: the first apply of this root writes state and nothing
# else, and its plan is where the operator reads that nothing will be created,
# replaced or destroyed (`docs/greenfield/google-root-migration-runbook.md`).
#
# Once an object is in this root's state its block is a no-op: Terraform imports
# a given address once, and re-planning an imported address is harmless. So the
# blocks stay, and a later plan, which reads the same file, cannot be the one that
# creates a second topic.
#
# They also refuse the wrong project. An `import` of an object that does not exist
# fails the plan rather than creating it, so pointing this root at another
# `gcp_project_id` is a refusal and not a new, empty set of push objects. A brand
# new project would delete this file in the same change that names it.
#
# The ids are the Google provider's documented import formats, built from the
# same names `infra/modules/pubsub` gives the objects.

locals {
  # Names `infra/modules/pubsub` derives from `name_prefix`: the topic and the
  # subscription are both `<name_prefix>-gmail-push`, and a service account's
  # email is `<account_id>@<project>.iam.gserviceaccount.com`.
  topic_name                 = "${var.name_prefix}-gmail-push"
  subscription_name          = "${var.name_prefix}-gmail-push"
  push_service_account_email = "${local.push_service_account_id}@${var.gcp_project_id}.iam.gserviceaccount.com"

  # The module's `gmail_publisher_service_account` default: Google's own Gmail
  # push identity, a fixed public identifier.
  gmail_publisher_member = "serviceAccount:gmail-api-push@system.gserviceaccount.com"
}

import {
  to = module.pubsub.google_service_account.push
  id = "projects/${var.gcp_project_id}/serviceAccounts/${local.push_service_account_email}"
}

import {
  to = module.pubsub.google_pubsub_topic.gmail
  id = "projects/${var.gcp_project_id}/topics/${local.topic_name}"
}

# An IAM member's import id is three space-separated fields: the topic, the
# role and the member.
import {
  to = module.pubsub.google_pubsub_topic_iam_member.gmail_publisher
  id = "projects/${var.gcp_project_id}/topics/${local.topic_name} roles/pubsub.publisher ${local.gmail_publisher_member}"
}

import {
  to = module.pubsub.google_pubsub_subscription.gmail_push
  id = "projects/${var.gcp_project_id}/subscriptions/${local.subscription_name}"
}
