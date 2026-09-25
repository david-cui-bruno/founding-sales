# The production Google root, planned offline.
#
# No backend, no credential, no Google call. Every run is a plan against a mocked
# Google provider, and the four `import` blocks are satisfied by the
# `override_resource` blocks below: a mock provider cannot import, and an override
# that targets the imported address is what supplies the object instead, with its
# values known at plan time.
#
# The project id and the hostname are the real production ones because they are
# public identifiers and the whole point of this file is that the names this root
# computes are the names `infra/roots/production` carries. The email and the topic
# id below are what Google would report for those names; they are asserted against
# the root's outputs so that a module output wired to the wrong root output fails
# here.

mock_provider "google" {
  override_during = plan
}

override_resource {
  target = module.pubsub.google_service_account.push
  values = {
    email = "fss-prod-gmail-push@callie-fss.iam.gserviceaccount.com"
  }
}

override_resource {
  target = module.pubsub.google_pubsub_topic.gmail
  values = {
    id = "projects/callie-fss/topics/fss-prod-gmail-push"
  }
}

override_resource {
  target = module.pubsub.google_pubsub_topic_iam_member.gmail_publisher
  values = {
    etag = "BwYexample="
  }
}

override_resource {
  target = module.pubsub.google_pubsub_subscription.gmail_push
  values = {
    id = "projects/callie-fss/subscriptions/fss-prod-gmail-push"
  }
}

variables {
  api_hostname = "api.usecallie.com"
}

run "the_root_adopts_the_production_push_objects_by_their_production_names" {
  command = plan

  assert {
    condition     = output.gcp_project_id == "callie-fss"
    error_message = "The default project is the one the four objects were created in; a plan with no -var must name them."
  }

  assert {
    condition     = output.gmail_push_topic_name == "fss-prod-gmail-push"
    error_message = "The topic keeps the name it was created with. A new name is a new topic, and the Gmail watch names the old one."
  }

  assert {
    condition     = output.gmail_push_subscription_name == "fss-prod-gmail-push"
    error_message = "The subscription keeps the name it was created with; a renamed subscription is a destroyed and recreated one."
  }

  assert {
    condition     = output.gmail_push_topic_id == "projects/callie-fss/topics/fss-prod-gmail-push"
    error_message = "The root publishes the topic id the production root carries as var.gmail_push_topic."
  }

  assert {
    condition     = output.gmail_push_service_account == "fss-prod-gmail-push@callie-fss.iam.gserviceaccount.com"
    error_message = "The root publishes the service account the production root carries as var.gmail_push_service_account."
  }

  assert {
    condition     = output.gmail_push_audience == "https://api.usecallie.com/integrations/gmail/push"
    error_message = "The audience is built from the hostname and the push path exactly as infra/roots/production builds FSS_GMAIL_PUSH_AUDIENCE."
  }
}

run "a_rehearsal_prefix_is_refused" {
  command = plan

  variables {
    name_prefix = "fss-rh-202609250000"
  }

  expect_failures = [var.name_prefix]
}

run "a_hostname_with_a_scheme_is_refused" {
  command = plan

  variables {
    api_hostname = "https://api.usecallie.com"
  }

  expect_failures = [var.api_hostname]
}

run "a_push_path_that_is_not_a_path_is_refused" {
  command = plan

  variables {
    gmail_push_path = "integrations/gmail/push"
  }

  expect_failures = [var.gmail_push_path]
}
