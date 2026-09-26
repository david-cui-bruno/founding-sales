# The public identifiers of the four objects. `infra/roots/production` carries the
# topic id and the service account as committed variable defaults and derives the
# audience itself; the migration runbook compares all three with the production
# root's outputs of the same names.

output "gcp_project_id" {
  description = "The Google Cloud project the push objects live in."
  value       = local.gcp_project_id
}

output "gmail_push_topic_id" {
  description = "Fully qualified topic id Gmail watch requests name. Equal to infra/roots/production's gmail_push_topic default."
  value       = module.pubsub.topic_id
}

output "gmail_push_topic_name" {
  description = "Topic short name."
  value       = module.pubsub.topic_name
}

output "gmail_push_subscription_name" {
  description = "Push subscription short name."
  value       = module.pubsub.subscription_name
}

output "gmail_push_service_account" {
  description = "Service account the push token is minted for. Equal to infra/roots/production's gmail_push_service_account default; the webhook accepts this address and no other."
  value       = module.pubsub.push_service_account_email
}

output "gmail_push_audience" {
  description = "Audience the subscription mints its token for. infra/roots/production derives the same string from its own api_hostname."
  value       = module.pubsub.push_audience
}
