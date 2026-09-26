# The production Gmail push objects in Google Cloud, and nothing else.
#
# Four objects: the push service account, the topic Gmail publishes to, Gmail's
# publisher grant on it, and the push subscription that delivers to the API.
# Until lane g85 they were `module.pubsub[0]` in `infra/roots/production`, and
# that made every production plan configure the Google provider, so every image
# release needed a Google login that lapses about every 17 hours (audit O01).
# They change almost never; the production root changes at every release. So
# they have a root, a state object and a credential of their own, and the
# production root takes their three public identifiers as values.
#
# What the production root needs from here, and where it gets it:
#
#   gmail_push_topic_id        -> var.gmail_push_topic, a committed default
#   gmail_push_service_account -> var.gmail_push_service_account, a committed default
#   gmail_push_audience        -> derived there from its own api_hostname, the same expression as below
#
# `test/release/googleRoot.check.ts` computes the first two from this root's
# names and fails when the production defaults disagree with them.
#
# Nothing here is destroyable by intent. There is no `terraform destroy` in any
# procedure for this root: the publisher grant needed a project-level exception
# to the organisation's domain-restricted sharing policy when it was first made
# (`docs/greenfield/release.md` 8.0n), so a recreated grant may be refused, and a
# deleted topic stops the Gmail watch until the next renewal names a new one.
# `docs/archive/decisions/g85-the-google-provider-has-its-own-root.md`.

locals {
  # Exactly the expressions `infra/roots/production` used, so that the module
  # below receives exactly the inputs the objects were created from and a plan
  # after the migration shows no change to any of them.

  # Google caps a service account id at 30 characters.
  service_account_stem = trimsuffix(
    length(var.name_prefix) > 18 ? substr(var.name_prefix, 0, 18) : var.name_prefix,
    "-",
  )
  push_service_account_id = "${local.service_account_stem}-gmail-push"

  push_endpoint = "https://${var.api_hostname}${var.gmail_push_path}"
  push_audience = "https://${var.api_hostname}${var.gmail_push_path}"
}

module "pubsub" {
  source = "../../modules/pubsub"

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
