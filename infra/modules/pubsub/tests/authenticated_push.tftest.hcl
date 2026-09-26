mock_provider "google" {
  override_during = apply

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
  gcp_project_id = "fss-test-project"
  name_prefix    = "fss-test"
  push_endpoint  = "https://api.example.invalid/gmail/push"
}

run "push_has_an_exact_audience_and_only_gmail_may_publish" {
  command = plan

  assert {
    condition     = google_pubsub_subscription.gmail_push.push_config[0].oidc_token[0].audience == var.push_endpoint
    error_message = "Pub/Sub must present a token minted for exactly the endpoint the webhook requires as its audience."
  }

  assert {
    condition = (google_pubsub_topic_iam_member.gmail_publisher.member == "serviceAccount:gmail-api-push@system.gserviceaccount.com"
    && google_pubsub_topic_iam_member.gmail_publisher.role == "roles/pubsub.publisher")
    error_message = "The one grant is publish, to Google's Gmail push identity and nothing else."
  }
}

run "a_plaintext_push_endpoint_is_refused" {
  command = plan

  variables {
    push_endpoint = "http://api.example.invalid/gmail/push"
  }

  expect_failures = [var.push_endpoint]
}

# The service account's email is computed, so this is asserted in a mocked apply,
# which makes no Google call and needs no credential
# (docs/archive/decisions/g12j-mock-providers-keep-computed-values-unknown.md).
run "the_token_is_minted_for_the_dedicated_push_service_account" {
  command = apply

  assert {
    condition     = google_pubsub_subscription.gmail_push.push_config[0].oidc_token[0].service_account_email == google_service_account.push.email
    error_message = "The token must be minted for the dedicated push service account."
  }
}
