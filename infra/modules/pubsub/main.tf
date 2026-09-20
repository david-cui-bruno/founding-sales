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

resource "google_service_account" "push" {
  project      = var.gcp_project_id
  account_id   = var.push_service_account_id
  display_name = "${var.name_prefix} Gmail push identity"
  description  = "Mints the OIDC token Pub/Sub presents to the FSS Gmail webhook."
}

resource "google_pubsub_topic" "gmail" {
  project = var.gcp_project_id
  name    = "${var.name_prefix}-gmail-push"
  labels  = var.labels

  message_retention_duration = var.message_retention_duration
}

# Gmail can only publish to the topic if this grant exists. It is the one
# cross-project grant in the design and it is scoped to publish only.
resource "google_pubsub_topic_iam_member" "gmail_publisher" {
  project = var.gcp_project_id
  topic   = google_pubsub_topic.gmail.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${var.gmail_publisher_service_account}"
}

resource "google_pubsub_subscription" "gmail_push" {
  project = var.gcp_project_id
  name    = "${var.name_prefix}-gmail-push"
  topic   = google_pubsub_topic.gmail.id
  labels  = var.labels

  ack_deadline_seconds       = var.ack_deadline_seconds
  message_retention_duration = var.message_retention_duration
  retain_acked_messages      = false
  enable_message_ordering    = false

  push_config {
    push_endpoint = var.push_endpoint

    oidc_token {
      service_account_email = google_service_account.push.email
      audience              = var.push_audience
    }
  }

  retry_policy {
    minimum_backoff = var.minimum_backoff
    maximum_backoff = var.maximum_backoff
  }

  # Never expire. A subscription that quietly disappears would stop push
  # without stopping the product, and only reconciliation would notice.
  expiration_policy {
    ttl = ""
  }
}
