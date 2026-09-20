output "topic_id" {
  description = "Fully qualified topic id. Gmail watch requests name this topic."
  value       = google_pubsub_topic.gmail.id
}

output "topic_name" {
  description = "Topic short name."
  value       = google_pubsub_topic.gmail.name
}

output "subscription_name" {
  description = "Push subscription short name."
  value       = google_pubsub_subscription.gmail_push.name
}

output "push_service_account_email" {
  description = "Service account the OIDC token is issued for. The webhook checks this exact address."
  value       = google_service_account.push.email
}

output "push_audience" {
  description = "Exact audience the webhook must require."
  value       = var.push_audience
}
