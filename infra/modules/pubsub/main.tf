# Gmail push over Google Cloud Pub/Sub.
#
# This is the only Google Cloud resource FSS owns. A notification carries an
# email address and a history id and never business state; the API treats it as
# a hint to enqueue a coalescing mail.sync, and one-minute reconciliation
# repairs anything Pub/Sub delays or drops.
#
# The subscription pushes with an OIDC token minted for a dedicated service
# account and an exact audience. The webhook refuses a token with a valid
# Google signature but the wrong audience or the wrong service-account email.
#
# A notification is a hint, so it is kept an hour at most (one-minute
# reconciliation is the real safety net), the webhook acknowledges within 30 s
# only after durable recording or enqueueing, and a failed delivery backs off
# from 10 s to 10 min.

locals {
  # "<prefix>-gmail-push" is the topic, the subscription and the service account
  # id; Google caps a service account id at 30 characters.
  name = "${var.name_prefix}-gmail-push"

  labels = {
    environment = "production"
    managed_by  = "terraform"
  }
}

resource "google_service_account" "push" {
  project      = var.gcp_project_id
  account_id   = local.name
  display_name = "${var.name_prefix} Gmail push identity"
  description  = "Mints the OIDC token Pub/Sub presents to the FSS Gmail webhook."
}

resource "google_pubsub_topic" "gmail" {
  project = var.gcp_project_id
  name    = local.name
  labels  = local.labels

  message_retention_duration = "3600s"
}

# Gmail can only publish to the topic if this grant exists. It is the one
# cross-project grant in the design and it is scoped to publish only.
resource "google_pubsub_topic_iam_member" "gmail_publisher" {
  project = var.gcp_project_id
  topic   = google_pubsub_topic.gmail.name
  role    = "roles/pubsub.publisher"
  # Google's own Gmail push identity, a fixed public identifier.
  member = "serviceAccount:gmail-api-push@system.gserviceaccount.com"
}

resource "google_pubsub_subscription" "gmail_push" {
  project = var.gcp_project_id
  name    = local.name
  topic   = google_pubsub_topic.gmail.id
  labels  = local.labels

  ack_deadline_seconds       = 30
  message_retention_duration = "3600s"
  retain_acked_messages      = false
  enable_message_ordering    = false

  push_config {
    push_endpoint = var.push_endpoint

    oidc_token {
      service_account_email = google_service_account.push.email
      audience              = var.push_endpoint
    }
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  # Never expire. A subscription that quietly disappears would stop push
  # without stopping the product, and only reconciliation would notice.
  expiration_policy {
    ttl = ""
  }
}
