output "repository_urls" {
  description = "Repository URLs keyed by short name."
  value       = { for name, repository in aws_ecr_repository.this : name => repository.repository_url }
}

output "repository_names" {
  description = "Full repository names keyed by short name."
  value       = { for name, repository in aws_ecr_repository.this : name => repository.name }
}
