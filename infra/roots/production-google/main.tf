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
#   gmail_push_audience        -> derived there from its api_hostname and gmail_push_path,
#                                 equal to local.push_endpoint below
#
# Nothing here is destroyable by intent. There is no `terraform destroy` in any
# procedure for this root: the publisher grant needed a project-level exception
# to the organisation's domain-restricted sharing policy when it was first made
# (`docs/greenfield/release.md` 8.0n), so a recreated grant may be refused, and a
# deleted topic stops the Gmail watch until the next renewal names a new one.
# `docs/archive/decisions/g85-the-google-provider-has-its-own-root.md`.

locals {
  # The production namespace: `fss-prod-gmail-push` is the topic, the
  # subscription and the service account id. There is one production and no
  # rehearsal Google Cloud project to name
  # (`docs/archive/decisions/g12j-the-rehearsal-has-no-google-provider.md`).
  name_prefix = "fss-prod"

  # The project the four objects were created in on 23 September 2026
  # (`docs/greenfield/release.md` 4 and 8.0n). Pub/Sub topics are global; the
  # region only sets the provider's default.
  gcp_project_id = "callie-fss"
  gcp_region     = "us-east1"

  # The subscription pushes to, and mints its token for exactly, the production
  # API's Gmail route. `infra/roots/production` derives FSS_GMAIL_PUSH_AUDIENCE
  # from its own `api_hostname` literal and `gmail_push_path` with the same
  # expression, so the two roots agree.
  push_endpoint = "https://api.usecallie.com/integrations/gmail/push"
}

module "pubsub" {
  source = "../../modules/pubsub"

  gcp_project_id = local.gcp_project_id
  name_prefix    = local.name_prefix
  push_endpoint  = local.push_endpoint
}
