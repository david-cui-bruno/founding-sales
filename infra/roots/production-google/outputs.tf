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

# The two public identifiers `.github/workflows/greenfield-google.yml` names as literals
# (lane G-WIF). They are outputs so a bootstrap can read back exactly what it created;
# the workflow carries them written out, because a workflow cannot read this state.

output "ci_service_account_email" {
  description = "The service account greenfield-google.yml impersonates. Equal to the workflow's service_account input."
  value       = google_service_account.ci.email
}

output "workload_identity_provider" {
  description = "Full provider resource name greenfield-google.yml exchanges its GitHub OIDC token at. Equal to the workflow's workload_identity_provider input."
  value       = "projects/${local.gcp_project_number}/locations/global/workloadIdentityPools/${google_iam_workload_identity_pool.github.workload_identity_pool_id}/providers/${google_iam_workload_identity_pool_provider.github.workload_identity_pool_provider_id}"
}
