mock_provider "google" {
  override_during = plan

  mock_resource "google_service_account" {
    defaults = {
      email = "fss-test-gmail-push@fss-test-project.iam.gserviceaccount.com"
    }
  }

  mock_resource "google_pubsub_topic" {
    defaults = {
      id = "projects/fss-test-project/topics/fss-test-gmail-push"
    }
  }
}

variables {
  gcp_project_id          = "fss-test-project"
  name_prefix             = "fss-test"
  push_service_account_id = "fss-test-gmail-push"
  push_endpoint           = "https://api.example.invalid/gmail/push"
  push_audience           = "https://api.example.invalid/gmail/push"
}

run "push_is_authenticated_with_an_exact_audience" {
  command = plan

  assert {
    condition     = google_pubsub_subscription.gmail_push.push_config[0].oidc_token[0].audience == var.push_audience
    error_message = "Pub/Sub must present a token minted for the exact audience the webhook requires."
  }

  assert {
    condition     = google_pubsub_subscription.gmail_push.push_config[0].oidc_token[0].service_account_email == google_service_account.push.email
    error_message = "The token must be minted for the dedicated push service account."
  }

  assert {
    condition     = startswith(google_pubsub_subscription.gmail_push.push_config[0].push_endpoint, "https://")
    error_message = "A notification carries a mailbox address and must never travel in the clear."
  }

  assert {
    condition     = google_pubsub_subscription.gmail_push.expiration_policy[0].ttl == ""
    error_message = "The subscription must never expire on its own."
  }
}

run "only_gmail_may_publish" {
  command = plan

  assert {
    condition     = google_pubsub_topic_iam_member.gmail_publisher.member == "serviceAccount:gmail-api-push@system.gserviceaccount.com"
    error_message = "The publisher grant goes to Google's Gmail push identity and nothing else."
  }

  assert {
    condition     = google_pubsub_topic_iam_member.gmail_publisher.role == "roles/pubsub.publisher"
    error_message = "Gmail gets publish, never subscribe or admin."
  }
}

run "a_plaintext_push_endpoint_is_refused" {
  command = plan

  variables {
    push_endpoint = "http://api.example.invalid/gmail/push"
  }

  expect_failures = [var.push_endpoint]
}

run "an_empty_audience_is_refused" {
  command = plan

  variables {
    push_audience = ""
  }

  expect_failures = [var.push_audience]
}
