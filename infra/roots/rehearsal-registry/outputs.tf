output "name_prefix" {
  description = "Always fss-rh. Not a variable."
  value       = local.name_prefix
}

output "deployment_role_name" {
  description = "IAM role this root assumes. Scoped to fss-rh-*."
  value       = local.deployment_role_name
}

output "repository_names" {
  description = "The two stable repository names: fss-rh-api and fss-rh-worker."
  value       = module.registry.repository_names
}

output "repository_urls" {
  description = <<-EOT
    The two repository URLs, which are the values of the release workflow's
    `FSS_REHEARSAL_API_REPOSITORY` and `FSS_REHEARSAL_WORKER_REPOSITORY`
    environment secrets. Read them from here after the one apply rather than
    assembling them by hand.
  EOT
  value       = module.registry.repository_urls
}

output "resource_names" {
  description = "Every name this root claims in the shared account, so a test can assert all of them are rehearsal names."
  value       = values(module.registry.repository_names)
}
